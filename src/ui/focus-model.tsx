import { usePluginData, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttentionDisplayPayload, AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "../aperture/types.js";
import type { AttentionUpdateEvent } from "../handlers/shared.js";

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

type StreamSignal = "open" | "notification" | "rotate" | "disconnect";

function AttentionStreamSubscription(props: {
  companyId: string;
  epoch: number;
  onSignal: (epoch: number, signal: StreamSignal) => void;
}) {
  const stream = usePluginStream<AttentionUpdateEvent>("attention-updates", { companyId: props.companyId });
  const wasConnected = useRef(false);
  const everConnected = useRef(false);
  const disconnected = useRef(false);
  const rotated = useRef(false);
  const lastEvent = useRef<AttentionUpdateEvent | null>(null);

  useEffect(() => {
    if (stream.connected && !wasConnected.current) {
      everConnected.current = true;
      disconnected.current = false;
      props.onSignal(props.epoch, "open");
    }
    wasConnected.current = stream.connected;
    if (stream.lastEvent && stream.lastEvent !== lastEvent.current) {
      lastEvent.current = stream.lastEvent;
      if (stream.lastEvent.companyId === props.companyId) props.onSignal(props.epoch, "notification");
    }
    if (stream.events.length >= 128 && !rotated.current) {
      rotated.current = true;
      props.onSignal(props.epoch, "rotate");
    } else if (!disconnected.current && (stream.error || (everConnected.current && !stream.connecting && !stream.connected))) {
      disconnected.current = true;
      props.onSignal(props.epoch, "disconnect");
    }
  }, [stream.connected, stream.connecting, stream.error, stream.events.length, stream.lastEvent, props.companyId, props.epoch, props.onSignal]);

  return null;
}

export function AttentionLiveUpdates(props: {
  companyId: string | null | undefined;
  refresh: () => void;
}) {
  const [epoch, setEpoch] = useState(0);
  const currentEpoch = useRef(0);
  const active = useRef(true);
  const refresh = useRef(props.refresh);
  refresh.current = props.refresh;
  const dirty = useRef(false);
  const refreshTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const pendingReconnect = useRef(false);

  const queueRefresh = useCallback(() => {
    dirty.current = true;
    if (document.visibilityState === "hidden" || refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      if (!active.current || document.visibilityState === "hidden" || !dirty.current) return;
      dirty.current = false;
      refresh.current();
    }, 100);
  }, []);

  const reopen = useCallback(() => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
    pendingReconnect.current = false;
    currentEpoch.current += 1;
    setEpoch(currentEpoch.current);
  }, []);

  const onSignal = useCallback((sourceEpoch: number, signal: StreamSignal) => {
    if (!active.current || !props.companyId || sourceEpoch !== currentEpoch.current) return;
    if (signal === "open") {
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
      pendingReconnect.current = false;
      queueRefresh();
    } else if (signal === "notification") {
      queueRefresh();
    } else if (signal === "rotate") {
      queueRefresh();
      reopen();
    } else if (retryTimer.current === null && !pendingReconnect.current) {
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        if (!active.current) return;
        if (document.visibilityState === "hidden") {
          pendingReconnect.current = true;
        } else {
          reopen();
        }
      }, 15000);
    }
  }, [props.companyId, queueRefresh, reopen]);

  useEffect(() => {
    active.current = true;
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      // The polling hook owns the visibility refresh, including hidden notifications.
      dirty.current = false;
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      if (pendingReconnect.current) reopen();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      active.current = false;
      dirty.current = false;
      pendingReconnect.current = false;
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
      refreshTimer.current = null;
      retryTimer.current = null;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [reopen]);

  return props.companyId
    ? <AttentionStreamSubscription key={`${props.companyId}:${epoch}`} companyId={props.companyId} epoch={epoch} onSignal={onSignal} />
    : null;
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
  syncError: string | null;
  refresh: () => void;
} {
  const displayQuery = usePluginData<AttentionDisplayPayload>("attention-display", companyId ? { companyId } : undefined);

  useAttentionPolling(companyId, [displayQuery.refresh]);

  return useMemo(() => {
    // The host hook retains its previous payload while a new company loads.
    const payload = displayQuery.data?.snapshot.companyId === companyId ? displayQuery.data : null;
    const awaitingCompany = Boolean(displayQuery.data && !payload);
    return {
      snapshot: payload?.snapshot ?? null,
      review: payload?.reviewState ?? null,
      loading: displayQuery.loading || awaitingCompany,
      error: awaitingCompany ? null : displayQuery.error,
      syncError: payload?.reconciliationSyncError ?? payload?.approvalSyncError ?? null,
      refresh() {
        displayQuery.refresh();
      },
    };
  }, [displayQuery, companyId]);
}
