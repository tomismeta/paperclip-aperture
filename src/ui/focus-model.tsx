import { usePluginData, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AttentionDisplayPayload, AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "../aperture/types.js";

const ATTENTION_UPDATES_STREAM = "attention-updates";

export type QueueMovement = "up" | "down";

export type Posture = {
  glyph: "\u25CB" | "\u25D0" | "\u25CF";
  label: "calm" | "elevated" | "busy";
};

type SurfaceLabel = "focus";

export type SurfaceBrand = {
  key: SurfaceLabel;
  wordmark: string;
  headingEmptyState: string;
  loadingLabel: string;
};

export function currentSurfaceBrand(): SurfaceBrand {
  return {
    key: "focus",
    wordmark: "Focus",
    headingEmptyState: "No focus state yet.",
    loadingLabel: "Loading Focus…",
  };
}

export function pluginPagePath(companyPrefix: string | null | undefined): string {
  return companyPrefix ? `/${companyPrefix}/aperture` : "/aperture";
}

export function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "recently";

  const elapsedMs = timestamp - Date.now();
  const elapsedMinutes = Math.round(elapsedMs / 60000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, "minute");

  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, "hour");

  const elapsedDays = Math.round(elapsedHours / 24);
  return formatter.format(elapsedDays, "day");
}

export function sourceLabel(frame: StoredAttentionFrame): string {
  return frame.source?.label ?? "Paperclip";
}

export function postureForSnapshot(snapshot: AttentionSnapshot): Posture {
  const current = snapshot.now;

  if (
    current?.tone === "critical"
    || current?.consequence === "high"
    || snapshot.counts.now + snapshot.counts.next >= 3
  ) {
    return { glyph: "\u25CF", label: "busy" };
  }

  if (snapshot.counts.now > 0 || snapshot.counts.next > 0 || snapshot.counts.ambient > 0) {
    return { glyph: "\u25D0", label: "elevated" };
  }

  return { glyph: "\u25CB", label: "calm" };
}

export function actionableCount(snapshot: AttentionSnapshot): number {
  return (snapshot.now ? 1 : 0) + snapshot.next.length;
}

export function actionableLabel(snapshot: AttentionSnapshot): string | null {
  const actionable = actionableCount(snapshot);
  return actionable > 0 ? `${actionable} action${actionable === 1 ? "" : "s"}` : null;
}

export function unreadCount(snapshot: AttentionSnapshot | null | undefined): number {
  return snapshot?.review?.unread.total ?? 0;
}

function useAttentionPolling(
  companyId: string | null | undefined,
  refreshers: Array<() => void>,
  intervalMs = 15000,
): void {
  const refreshersRef = useRef(refreshers);
  refreshersRef.current = refreshers;

  useEffect(() => {
    if (!companyId) return;

    function refreshVisible() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const refresh of refreshersRef.current) refresh();
    }

    const timer = window.setInterval(() => {
      refreshVisible();
    }, intervalMs);

    function handleVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        for (const refresh of refreshersRef.current) refresh();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [companyId, intervalMs]);
}

export function useQueueMovement(frames: StoredAttentionFrame[], ttlMs = 3500): Record<string, QueueMovement> {
  const previousPositionsRef = useRef<Record<string, number>>({});
  const timersRef = useRef<Record<string, number>>({});
  const [movementById, setMovementById] = useState<Record<string, QueueMovement>>({});

  useEffect(() => {
    const nextPositions = Object.fromEntries(frames.map((frame, index) => [frame.interactionId, index]));

    setMovementById((current) => {
      const updates: Record<string, QueueMovement> = {};

      for (const frame of frames) {
        const previousIndex = previousPositionsRef.current[frame.interactionId];
        const nextIndex = nextPositions[frame.interactionId];
        if (typeof previousIndex !== "number" || previousIndex === nextIndex) continue;
        updates[frame.interactionId] = nextIndex < previousIndex ? "up" : "down";
      }

      if (Object.keys(updates).length === 0) return current;

      const merged = { ...current, ...updates };
      for (const [interactionId, movement] of Object.entries(updates)) {
        window.clearTimeout(timersRef.current[interactionId]);
        timersRef.current[interactionId] = window.setTimeout(() => {
          setMovementById((active) => {
            if (active[interactionId] !== movement) return active;
            const next = { ...active };
            delete next[interactionId];
            return next;
          });
          delete timersRef.current[interactionId];
        }, ttlMs);
      }

      return merged;
    });

    previousPositionsRef.current = nextPositions;

    return () => {
      for (const timer of Object.values(timersRef.current)) window.clearTimeout(timer);
    };
  }, [frames, ttlMs]);

  return movementById;
}

export function useAttentionModel(companyId: string | null | undefined): {
  snapshot: AttentionSnapshot | null;
  review: AttentionReviewState | null;
  loading: boolean;
  error: { message: string } | null;
  refresh: () => void;
} {
  const displayQuery = usePluginData<AttentionDisplayPayload>("attention-display", companyId ? { companyId } : undefined);
  const updates = usePluginStream<{ updatedAt: string; eventType: string }>(
    ATTENTION_UPDATES_STREAM,
    companyId ? { companyId } : undefined,
  );

  useAttentionPolling(companyId, [displayQuery.refresh]);

  useEffect(() => {
    if (!companyId || !updates.lastEvent) return;
    displayQuery.refresh();
  }, [companyId, updates.lastEvent?.updatedAt, updates.lastEvent?.eventType]);

  return useMemo(() => ({
    snapshot: displayQuery.data?.snapshot ?? null,
    review: displayQuery.data?.reviewState ?? null,
    loading: displayQuery.loading,
    error: displayQuery.error,
    refresh() {
      displayQuery.refresh();
    },
  }), [displayQuery]);
}
