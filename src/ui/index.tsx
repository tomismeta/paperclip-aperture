import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type AttentionDisplayPayload,
  type AttentionReviewState,
  type AttentionSnapshot,
  type StoredAttentionFrame,
} from "../aperture/types.js";
import {
  frameUpdatedAt,
  isBudgetOverride,
  type FrameLane,
} from "../aperture/frame-model.js";
import { explainFrame, signalStrengthLabel } from "../aperture/explainability.js";
import {
  mergeSnapshotWithApprovals,
  type ApprovalRecord,
} from "../aperture/approval-frames.js";
import { ATTENTION_CONTEXT_IDS } from "../aperture/attention-context.js";
import { GENERIC_QUEUED_JUDGMENT, genericJudgmentLine } from "../aperture/attention-language.js";
import { issueBlocksTargetLine, issueNeedsActionFromLine } from "../aperture/issue-intelligence.js";
import {
  acknowledgeFailureMessage,
  acknowledgeSuccessMessage,
  approvalDecisionFailureMessage,
  approvalDecisionSuccessMessage,
  approvalFrameUnsupportedMessage,
  approvalRevisionFailureMessage,
  approvalRevisionSuccessMessage,
  commentFailureMessage,
  commentSuccessMessage,
  issueFrameUnsupportedMessage,
} from "./interaction-copy.js";

type DisplayFrame = {
  frame: StoredAttentionFrame;
  lane: FrameLane;
};
type Posture = {
  glyph: "\u25CB" | "\u25D0" | "\u25CF";
  label: "calm" | "elevated" | "busy";
};
type ApprovalQueryResult = {
  data: ApprovalRecord[] | null;
  loading: boolean;
  error: { message: string } | null;
  refresh: () => void;
};
type SurfaceLabel = "focus";
type SurfaceBrand = {
  key: SurfaceLabel;
  wordmark: string;
  headingEmptyState: string;
  loadingLabel: string;
};

// Aperture brand accent
// Uses inline styles because the host Tailwind JIT won't scan plugin bundles
// for arbitrary values.
const ACCENT_COLOR = "#007ACC";
const ACCENT_BG = `${ACCENT_COLOR}14`;
const ACCENT_BORDER = `${ACCENT_COLOR}33`;
const ACCENT_BG_STYLE: React.CSSProperties = { backgroundColor: ACCENT_COLOR };

function currentSurfaceBrand(): SurfaceBrand {
  return {
    key: "focus",
    wordmark: "Focus",
    headingEmptyState: "No focus state yet.",
    loadingLabel: "Loading Focus…",
  };
}

/**
 * Forces accent color with !important to override any host Tailwind rules.
 */
function useAccentColor<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.style.setProperty("color", ACCENT_COLOR, "important");
  });
  return ref;
}

function Accent({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useAccentColor<HTMLSpanElement>();
  return <span ref={ref} className={className}>{children}</span>;
}

function QuietMark({ size = "sm" }: { size?: "sm" | "md" }) {
  const dimension = size === "md" ? 10 : 8;
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full border"
      style={{ width: dimension, height: dimension, borderColor: ACCENT_BORDER }}
    />
  );
}

function useWideLayout(minWidth = 1024) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia(`(min-width: ${minWidth}px)`);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [minWidth]);

  return matches;
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function pluginPagePath(companyPrefix: string | null | undefined): string {
  return companyPrefix ? `/${companyPrefix}/aperture` : "/aperture";
}

function formatRelativeTime(value: string): string {
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

function sourceLabel(frame: StoredAttentionFrame): string {
  return frame.source?.label ?? "Paperclip";
}

function contextValue(frame: StoredAttentionFrame, id: string): string | undefined {
  const item = frame.context?.items?.find((entry) => entry.id === id);
  return typeof item?.value === "string" && item.value.trim().length > 0 ? item.value : undefined;
}

function requestedAmount(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.requestedAmount);
}

function budgetReason(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.budgetReason);
}

function recommendedMoveValue(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.recommendedMove);
}

function actionOwnerValue(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.needsActionFrom);
}

function blockingTargetValue(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.blocksTarget);
}

function impactLabel(frame: StoredAttentionFrame): string {
  return `${frame.consequence} impact`;
}

function operatorDriverLabel(value: string): string {
  switch (value) {
    case "in_review":
      return "review required";
    case "pending_approval":
      return "approval required";
    default:
      return value.replace(/_/g, " ");
  }
}

function driverLabel(frame: StoredAttentionFrame): string | null {
  if (isBudgetOverride(frame)) return "budget stop";

  const issueStatus = frame.metadata?.issueStatus;
  if (typeof issueStatus === "string" && issueStatus.trim().length > 0) {
    return operatorDriverLabel(issueStatus);
  }

  const pauseReason = frame.metadata?.pauseReason;
  if (typeof pauseReason === "string" && pauseReason.trim().length > 0) {
    return operatorDriverLabel(pauseReason);
  }

  const agentStatus = frame.metadata?.agentStatus;
  if (typeof agentStatus === "string" && agentStatus.trim().length > 0) {
    return operatorDriverLabel(agentStatus);
  }

  return null;
}

function driverBadgeStyle(): { className: string; style: React.CSSProperties } {
  return {
    className: "border-transparent",
    style: { color: ACCENT_COLOR, backgroundColor: ACCENT_BG, borderColor: ACCENT_BORDER },
  };
}

function requestDescriptor(frame: StoredAttentionFrame): string {
  const driver = driverLabel(frame);
  return driver ? `${sourceLabel(frame)} \u00b7 ${driver}` : sourceLabel(frame);
}

function postureForSnapshot(snapshot: AttentionSnapshot): Posture {
  const current = snapshot.active;

  if (
    current?.tone === "critical"
    || current?.consequence === "high"
    || snapshot.counts.active + snapshot.counts.queued >= 3
  ) {
    return { glyph: "\u25CF", label: "busy" };
  }

  if (snapshot.counts.active > 0 || snapshot.counts.queued > 0 || snapshot.counts.ambient > 0) {
    return { glyph: "\u25D0", label: "elevated" };
  }

  return { glyph: "\u25CB", label: "calm" };
}

function actionableCount(snapshot: AttentionSnapshot): number {
  return (snapshot.active ? 1 : 0) + snapshot.queued.length;
}

function judgmentLine(frame: StoredAttentionFrame, lane: FrameLane): string {
  if (frame.provenance?.whyNow) return frame.provenance.whyNow;
  return genericJudgmentLine(frame, lane);
}

function nextPrimaryText(frame: StoredAttentionFrame): string | null {
  const recommendedMove = recommendedMoveValue(frame);
  if (recommendedMove) return recommendedMove;

  const summary = frame.summary?.trim();
  if (summary) return summary;

  const fallback = judgmentLine(frame, "queued");
  return fallback === GENERIC_QUEUED_JUDGMENT ? null : fallback;
}

function supportingLine(frame: StoredAttentionFrame, lane: FrameLane): string | null {
  const owner = actionOwnerValue(frame);
  const target = blockingTargetValue(frame);
  if (target && lane === "active" && entityTypeFromFrame(frame) === "issue" && driverLabel(frame) === "review required") {
    return issueBlocksTargetLine(target);
  }
  if (owner && lane === "active" && entityTypeFromFrame(frame) === "issue") {
    return issueNeedsActionFromLine(owner);
  }

  if (lane === "active") {
    const recommendedMove = recommendedMoveValue(frame)?.trim();
    const summary = frame.summary?.trim();
    const judgment = judgmentLine(frame, lane).trim();

    if (recommendedMove && summary && summary !== recommendedMove && summary !== judgment) {
      return summary;
    }

    return null;
  }

  const judgment = judgmentLine(frame, lane);
  return judgment.trim().length > 0 ? judgment : null;
}

function approvalIdForFrame(frame: StoredAttentionFrame): string | null {
  const [kind, id] = frame.taskId.split(":");
  return kind === "approval" && id ? id : null;
}

function entityIdFromFrame(frame: StoredAttentionFrame): string | null {
  const parts = frame.taskId.split(":");
  return parts.length >= 2 ? parts.slice(1).join(":") : null;
}

function entityTypeFromFrame(frame: StoredAttentionFrame): string | null {
  const parts = frame.taskId.split(":");
  return parts.length >= 2 ? parts[0] : null;
}

function itemHref(frame: StoredAttentionFrame, companyPrefix: string | null | undefined): string | null {
  const entityType = entityTypeFromFrame(frame);
  const entityId = entityIdFromFrame(frame);
  if (!entityType || !entityId || !companyPrefix) return null;

  const pluralType = entityType === "run" ? "runs"
    : entityType === "approval" ? "approvals"
    : entityType === "issue" ? "issues"
    : entityType === "agent" ? "agents"
    : null;

  if (!pluralType) return null;
  return `/${companyPrefix}/${pluralType}/${entityId}`;
}

function costsHref(companyPrefix: string | null | undefined): string | null {
  return companyPrefix ? `/${companyPrefix}/costs` : null;
}

function activityHref(frame: StoredAttentionFrame, companyPrefix: string | null | undefined): string | null {
  if (!companyPrefix) return null;
  return frame.metadata?.activityPath ? `/${companyPrefix}/${frame.metadata.activityPath}` : null;
}

function primaryLinkLabel(frame: StoredAttentionFrame): string {
  const entityType = entityTypeFromFrame(frame);
  switch (entityType) {
    case "approval":
      return "Open approval";
    case "issue":
      return "Open issue";
    case "run":
      return "Open run";
    case "agent":
      return "Open agent";
    default:
      return "Open in Paperclip";
  }
}

function responseKind(frame: StoredAttentionFrame, lane: FrameLane): "approval" | "acknowledge" | "none" {
  if (approvalIdForFrame(frame) && (frame.responseSpec?.kind === "approval" || frame.mode === "approval")) {
    return "approval";
  }

  if (lane !== "ambient" && (frame.responseSpec?.kind === "acknowledge" || frame.mode === "status")) {
    return "acknowledge";
  }

  return "none";
}

function unreadCount(snapshot: AttentionSnapshot | null | undefined): number {
  return snapshot?.review?.unread.total ?? 0;
}

function applyLocalSuppressions(
  snapshot: AttentionSnapshot | null,
  suppressedAtByTaskId: Record<string, string>,
): AttentionSnapshot | null {
  if (!snapshot || Object.keys(suppressedAtByTaskId).length === 0) return snapshot;

  const keepFrame = (frame: StoredAttentionFrame) => {
    const suppressedAt = suppressedAtByTaskId[frame.taskId];
    if (!suppressedAt) return true;
    return frameUpdatedAt(frame, snapshot.updatedAt).localeCompare(suppressedAt) > 0;
  };

  const queued = snapshot.queued.filter(keepFrame);
  const ambient = snapshot.ambient.filter(keepFrame);
  const activeCandidate = snapshot.active && keepFrame(snapshot.active) ? snapshot.active : null;
  const active = activeCandidate ?? queued[0] ?? null;
  const nextQueued = activeCandidate ? queued : queued.slice(1);

  return {
    ...snapshot,
    active,
    queued: nextQueued,
    ambient,
    counts: {
      active: active ? 1 : 0,
      queued: nextQueued.length,
      ambient: ambient.length,
      total: (active ? 1 : 0) + nextQueued.length + ambient.length,
    },
  };
}

function suppressionMapFromReview(review: AttentionReviewState | null | undefined): Record<string, string> {
  if (!review) return {};

  return Object.fromEntries(
    Object.entries(review.frames)
      .filter(([, state]) => typeof state?.suppressedAt === "string" && state.suppressedAt.length > 0)
      .map(([taskId, state]) => [taskId, state.suppressedAt as string]),
  );
}

function isFrameUnreadInSnapshot(frame: StoredAttentionFrame, snapshot: AttentionSnapshot): boolean {
  const seenAt = snapshot.review?.lastSeenAt;
  if (!seenAt) return true;
  return frameUpdatedAt(frame, snapshot.updatedAt).localeCompare(seenAt) > 0;
}

function UnreadDot(props: { visible: boolean; tone?: "default" | "muted"; reserveSpace?: boolean }) {
  const tone = props.tone ?? "default";
  if (!props.visible && !props.reserveSpace) return null;

  const style = props.visible
    ? tone === "muted"
      ? { backgroundColor: ACCENT_BORDER }
      : ACCENT_BG_STYLE
    : { backgroundColor: "transparent" };

  return <span className="inline-block h-2 w-2 rounded-full shrink-0" style={style} aria-label={props.visible ? "Unread attention item" : undefined} />;
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
      <path d="M8.5 1.5h6v6" />
      <path d="M14.5 1.5l-7 7" />
    </svg>
  );
}

function SkeletonLine(props: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-secondary/80", props.className)} aria-hidden="true" />;
}

function MessageCard(props: {
  title: string;
  body: string;
  accent?: boolean;
}) {
  return (
    <div className="border border-border bg-card p-4 shadow-sm">
      <div className={cn("text-sm font-medium", props.accent && "text-foreground")}>
        {props.title}
      </div>
      <div className="mt-1 text-sm text-muted-foreground">{props.body}</div>
    </div>
  );
}

function WidgetLoadingState({ label }: { label: string }) {
  return (
    <div className="border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <SkeletonLine className="mt-0.5 h-3 w-3 rounded-full" />
        <div className="flex-1 space-y-2">
          <SkeletonLine className="h-3 w-20" />
          <SkeletonLine className="h-4 w-48" />
        </div>
        <SkeletonLine className="h-3 w-24" />
      </div>
      <div className="sr-only">{label}</div>
    </div>
  );
}

function PageLoadingState({ label }: { label: string }) {
  return (
    <div className="space-y-5" aria-label={label}>
      <div className="border border-border bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <SkeletonLine className="h-4 w-44" />
          <SkeletonLine className="h-8 w-28" />
        </div>
      </div>
      <div className="border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <SkeletonLine className="h-4 w-36" />
        </div>
        <div className="space-y-4 px-4 py-5 sm:px-6">
          <SkeletonLine className="h-3 w-16" />
          <SkeletonLine className="h-7 w-2/3" />
          <div className="flex gap-2">
            <SkeletonLine className="h-6 w-24" />
            <SkeletonLine className="h-6 w-20" />
            <SkeletonLine className="h-6 w-16" />
          </div>
          <SkeletonLine className="h-10 w-56" />
        </div>
      </div>
      <div className="border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <SkeletonLine className="h-3 w-12" />
        </div>
        <div className="space-y-3 px-4 py-4 sm:px-6">
          <SkeletonLine className="h-4 w-full" />
          <SkeletonLine className="h-4 w-5/6" />
          <SkeletonLine className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

function StatusToast({ message }: { message: string | null }) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 transition-all duration-200",
        message ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
      aria-live="polite"
      aria-atomic="true"
    >
      {message ? (
        <div className="min-w-72 max-w-md rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg">
          {message}
        </div>
      ) : null}
    </div>
  );
}

function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  return token && token.trim().length > 0 ? token : null;
}

// Temporary host API bridge until the plugin SDK exposes approval reads/writes.
async function paperclipApiFetch<TResponse = unknown>(
  path: string,
  options: RequestInit & { retries?: number; expectJson?: boolean } = {},
): Promise<TResponse> {
  const csrfToken = readCsrfToken();
  const {
    retries = 0,
    expectJson = true,
    headers,
    ...init
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await window.fetch(path, {
        credentials: "same-origin",
        ...init,
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
          ...(headers ?? {}),
        },
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        const detail = responseBody.trim().length > 0 ? `: ${responseBody.trim()}` : "";
        throw new Error(`Request failed (${response.status})${detail}`);
      }

      if (!expectJson) return undefined as TResponse;
      return await response.json() as TResponse;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retries) break;
      await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError ?? new Error("Request failed.");
}

function compactTitle(frame: StoredAttentionFrame): string {
  return frame.title.trim().length > 0 ? frame.title : "Untitled frame";
}

function usePendingApprovals(companyId: string | null | undefined): ApprovalQueryResult {
  const [data, setData] = useState<ApprovalRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (!companyId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadApprovals() {
      try {
        setError(null);
        const approvals = await paperclipApiFetch<ApprovalRecord[]>(`/api/companies/${companyId}/approvals?status=pending`, {
          method: "GET",
          retries: 1,
        });
        if (!cancelled) {
          setData(approvals);
          setLoading(false);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError({ message: fetchError instanceof Error ? fetchError.message : String(fetchError) });
          setLoading(false);
        }
      }
    }

    setLoading(true);
    void loadApprovals();

    return () => {
      cancelled = true;
    };
  }, [companyId, refreshVersion]);

  return {
    data,
    loading,
    error,
    refresh: () => {
      setRefreshVersion((value) => value + 1);
    },
  };
}

// Highlight entity-like tokens in the title (agent names, identifiers like CAM-9)
// Matches: uppercase identifiers with hyphens/numbers (CAM-9, AGENT-3), quoted names
const ENTITY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b|"([^"]+)"/g;

function HighlightedTitle({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(ENTITY_PATTERN.source, "g");

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[1] ?? match[2] ?? match[0];
    parts.push(
      <Accent key={match.index}>{match[1] ? token : `"${token}"`}</Accent>,
    );
    lastIndex = re.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

function renderTitle(frame: StoredAttentionFrame): ReactNode {
  return <HighlightedTitle text={compactTitle(frame)} />;
}

function useAttentionPolling(
  companyId: string | null | undefined,
  refreshers: Array<() => void>,
  intervalMs = 5000,
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

type QueueMovement = "up" | "down";

function useQueueMovement(frames: StoredAttentionFrame[], ttlMs = 3500): Record<string, QueueMovement> {
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

function useAttentionModel(companyId: string | null | undefined) {
  const displayQuery = usePluginData<AttentionDisplayPayload>("attention-display", companyId ? { companyId } : undefined);
  const approvalsQuery = usePendingApprovals(companyId);

  useAttentionPolling(companyId, [displayQuery.refresh, approvalsQuery.refresh]);

  const snapshot = useMemo(
    () => (
      companyId
        ? mergeSnapshotWithApprovals(displayQuery.data?.snapshot ?? null, companyId, approvalsQuery.data, displayQuery.data?.reviewState ?? null)
        : null
    ),
    [displayQuery.data, approvalsQuery.data, companyId],
  );

  return {
    snapshot,
    review: displayQuery.data?.reviewState ?? null,
    loading: displayQuery.loading || approvalsQuery.loading,
    error: displayQuery.error ?? approvalsQuery.error,
    refresh() {
      displayQuery.refresh();
      approvalsQuery.refresh();
    },
  };
}

// ---------------------------------------------------------------------------
// Primitives — aligned to Paperclip's design system
// ---------------------------------------------------------------------------

function Badge(props: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        props.className,
      )}
      style={props.style}
    >
      {props.children}
    </span>
  );
}

function ActionButton(props: {
  label: string;
  tone: "primary" | "danger" | "secondary" | "accent";
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const toneClass =
    props.tone === "primary"
      ? "bg-green-700 text-white hover:bg-green-600"
      : props.tone === "accent"
        ? "text-white"
      : props.tone === "danger"
        ? "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
        : "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50";

  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      disabled={props.disabled}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium",
        "transition-[color,background-color,border-color,box-shadow,opacity,filter]",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:pointer-events-none disabled:opacity-50",
        props.disabled && /…|\.\.\./.test(props.label) && "animate-pulse",
        toneClass,
        props.className,
      )}
      style={props.tone === "accent" ? { ...ACCENT_BG_STYLE, filter: hovered && !props.disabled ? "brightness(1.08)" : undefined } : undefined}
    >
      {props.label}
    </button>
  );
}

function QueueMovementBadge({ movement }: { movement?: QueueMovement }) {
  if (!movement) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: ACCENT_COLOR,
        backgroundColor: ACCENT_BG,
        borderColor: ACCENT_BORDER,
      }}
    >
      <span aria-hidden="true">{movement === "up" ? "\u2191" : "\u2193"}</span>
      {movement === "up" ? "moved up" : "moved down"}
    </span>
  );
}

function FrameActions(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  compact?: boolean;
}) {
  const actionMode = responseKind(props.frame, props.lane);
  const isPending = props.pendingId === props.frame.id;

  if (actionMode === "none") return null;

  return (
    <div className={cn("flex items-center gap-2", props.compact && "justify-end")}>
      {actionMode === "approval" ? (
        <>
          {isBudgetOverride(props.frame) ? (
            <ActionButton
              label="Request revision"
              tone="secondary"
              disabled={isPending}
              onClick={() => void props.onRequestRevision(props.frame)}
            />
          ) : null}
          <ActionButton
            label={isPending ? "Submitting\u2026" : "Approve"}
            tone="primary"
            disabled={isPending}
            onClick={() => void props.onApprove(props.frame)}
          />
          <ActionButton
            label="Reject"
            tone="danger"
            disabled={isPending}
            onClick={() => void props.onReject(props.frame)}
          />
        </>
      ) : (
        <ActionButton
          label={isPending ? "Saving\u2026" : "Acknowledge"}
          tone="accent"
          disabled={isPending}
          onClick={() => void props.onAcknowledge(props.frame)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Now pane — stable focal placement with progressive disclosure
// ---------------------------------------------------------------------------

function visibleContextItems(frame: StoredAttentionFrame) {
  return (frame.context?.items ?? []).filter((item) => item.id !== ATTENTION_CONTEXT_IDS.recommendedMove);
}

function ContextItems({ frame }: { frame: StoredAttentionFrame }) {
  const items = visibleContextItems(frame);
  if (items.length === 0) return null;

  return (
    <div className="grid gap-2 md:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "border border-border bg-secondary/50 px-3 py-2",
            item.id === ATTENTION_CONTEXT_IDS.latestComment && "md:col-span-2",
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-sm text-foreground">{item.value ?? "Available"}</div>
        </div>
      ))}
    </div>
  );
}

function ExplainabilityBadges(props: { values: string[]; accent?: boolean }) {
  if (props.values.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.values.map((value) => (
        <Badge
          key={value}
          className={props.accent ? "border-transparent" : "border-border bg-background/70 text-foreground/80"}
          style={props.accent ? { color: ACCENT_COLOR, backgroundColor: ACCENT_BG, borderColor: ACCENT_BORDER } : undefined}
        >
          {value}
        </Badge>
      ))}
    </div>
  );
}

function InlineExplainability(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
  preferLaneReason?: boolean;
}) {
  const explanation = explainFrame(props.frame, props.lane);
  const chips = [
    ...(explanation.signalStrength ? [signalStrengthLabel(explanation.signalStrength)] : []),
    ...explanation.signals.slice(0, 2),
    ...explanation.relationLabels.slice(0, 1),
  ];
  const label = props.lane === "queued" ? "Why next" : props.lane === "ambient" ? "Why ambient" : "Why now";
  const whyNow = explanation.whyNow ?? judgmentLine(props.frame, props.lane);
  const primaryLine = props.lane === "active"
    ? (props.preferLaneReason ? explanation.laneReason : whyNow)
    : whyNow;
  const secondaryLine = props.lane === "active"
    ? (!props.preferLaneReason && whyNow !== explanation.laneReason ? explanation.laneReason : null)
    : explanation.laneReason;

  return (
    <div className="space-y-2 border-l-2 pl-4" style={{ borderColor: ACCENT_COLOR }}>
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-foreground/90">
        {primaryLine}
      </p>
      {secondaryLine ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {secondaryLine}
        </p>
      ) : null}
      {chips.length > 0 ? <ExplainabilityBadges values={chips} accent /> : null}
    </div>
  );
}

function ExplainabilityPanel(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
  detailOnly?: boolean;
}) {
  const explanation = explainFrame(props.frame, props.lane);
  const strength = !props.detailOnly && explanation.signalStrength ? signalStrengthLabel(explanation.signalStrength) : null;
  const signalValues = props.detailOnly ? explanation.signals.slice(2) : explanation.signals;
  const relationValues = props.detailOnly ? explanation.relationLabels.slice(1) : explanation.relationLabels;
  const reasoningLabel = props.lane === "active" ? "Reasoning" : props.lane === "queued" ? "Why it sits here" : "Why it stays quiet";

  if (props.detailOnly && signalValues.length === 0 && relationValues.length === 0 && !explanation.continuity) {
    return null;
  }

  return (
    <div className="space-y-4">
      {!props.detailOnly ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {reasoningLabel}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {explanation.laneReason}
            </p>
          </div>
          {strength ? (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Confidence
              </div>
              <p className="mt-1 text-sm text-foreground/90">{strength}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {signalValues.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {props.detailOnly ? "More signals" : "Signals"}
          </div>
          <ExplainabilityBadges values={signalValues} />
        </div>
      ) : null}
      {relationValues.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {props.detailOnly ? "More thread context" : "Thread context"}
          </div>
          <ExplainabilityBadges values={relationValues} accent />
        </div>
      ) : null}
      {explanation.continuity ? (
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Related activity
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{explanation.continuity}</p>
        </div>
      ) : null}
    </div>
  );
}

function ExplainabilityStrip(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
}) {
  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <InlineExplainability frame={props.frame} lane={props.lane} />
    </div>
  );
}

function isIssueFrame(frame: StoredAttentionFrame): boolean {
  return entityTypeFromFrame(frame) === "issue";
}

function IssueCommentComposer(props: {
  frame: StoredAttentionFrame;
  pendingId: string | null;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
  triggerTone?: "link" | "secondary" | "primary" | "accent";
  triggerLabel?: string;
  triggerFullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const issueFrame = isIssueFrame(props.frame);

  const isPending = props.pendingId === props.frame.id;

  useEffect(() => {
    setOpen(false);
    setBody("");
  }, [props.frame.id]);

  useEffect(() => {
    if (open && issueFrame) textareaRef.current?.focus();
  }, [open, issueFrame]);

  if (!issueFrame) return null;

  async function submit() {
    const nextBody = body.trim();
    if (!nextBody) return;
    await props.onComment(props.frame, nextBody);
    setBody("");
    setOpen(false);
  }

  if (!open) {
    const label = props.triggerLabel ?? "Leave comment";
    const triggerTone = props.triggerTone ?? "link";

    if (triggerTone === "link") {
      return (
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          {label}
        </button>
      );
    }

    return (
      <ActionButton
        label={label}
        tone={triggerTone}
        className={props.triggerFullWidth ? "w-full" : undefined}
        disabled={isPending}
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="w-full space-y-2 rounded-md border border-border bg-secondary/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Posts to the issue thread without leaving Focus.
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setBody("");
          }
        }}
        rows={3}
        placeholder="Add a short operator note back to the issue…"
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <div className="flex items-center justify-end gap-2">
        <ActionButton
          label="Cancel"
          tone="secondary"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setBody("");
          }}
        />
        <ActionButton
          label={isPending ? "Posting…" : "Post comment"}
          tone="accent"
          disabled={isPending || body.trim().length === 0}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}

function NowDetails(props: {
  frame: StoredAttentionFrame;
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
}) {
  const { frame, snapshotUpdatedAt } = props;
  const href = itemHref(frame, props.companyPrefix);
  const budgetHref = isBudgetOverride(frame) ? costsHref(props.companyPrefix) : null;
  const activityLink = activityHref(frame, props.companyPrefix);
  const hasContext = visibleContextItems(frame).length > 0;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <ExplainabilityPanel frame={frame} lane="active" detailOnly />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{requestDescriptor(frame)}</span>
        <span>{impactLabel(frame)}</span>
        <span>{formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}</span>
        {requestedAmount(frame) ? <span>Amount requested: {requestedAmount(frame)}</span> : null}
        {budgetReason(frame) ? <span>{budgetReason(frame)}</span> : null}
      </div>

      {hasContext ? (
        <>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Context
          </div>
          <ContextItems frame={frame} />
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {primaryLinkLabel(frame)}
            <ExternalLinkIcon />
          </a>
        ) : null}

        {activityLink ? (
          <a
            href={activityLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Open activity
            <ExternalLinkIcon />
          </a>
        ) : null}

        {budgetHref ? (
          <Accent><a
            href={budgetHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 hover:opacity-80"
            style={{ color: "inherit" }}
          >
            Review in Costs
            <ExternalLinkIcon />
          </a></Accent>
        ) : null}
      </div>
    </div>
  );
}

function QuietNow() {
  return (
    <div className="flex min-h-20 items-center gap-3">
      <QuietMark size="md" />
      <div className="text-sm text-muted-foreground">Nothing active right now.</div>
    </div>
  );
}

function NowActionRail(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
  wide?: boolean;
  pendingId: string | null;
  itemLink: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
}) {
  const actionMode = responseKind(props.frame, props.lane);
  const isPending = props.pendingId === props.frame.id;
  const commentEnabled = actionMode === "acknowledge" && isIssueFrame(props.frame);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setCommentOpen(false);
    setCommentBody("");
  }, [props.frame.id]);

  useEffect(() => {
    if (commentOpen) textareaRef.current?.focus();
  }, [commentOpen]);

  async function submitComment() {
    const nextBody = commentBody.trim();
    if (!nextBody) return;
    await props.onComment(props.frame, nextBody);
    setCommentBody("");
    setCommentOpen(false);
  }

  return (
    <div
      className="space-y-3 rounded-md border border-border/60 bg-secondary/20 px-3 py-3"
      style={props.wide ? { width: 320, flexShrink: 0, position: "sticky", top: 16, alignSelf: "flex-start" } : undefined}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Actions
      </div>
      {actionMode === "approval" ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <ActionButton
              label={isPending ? "Submitting…" : "Approve"}
              tone="primary"
              disabled={isPending}
              className="w-full"
              onClick={() => void props.onApprove(props.frame)}
            />
            <ActionButton
              label="Reject"
              tone="danger"
              disabled={isPending}
              className="w-full"
              onClick={() => void props.onReject(props.frame)}
            />
          </div>
          {isBudgetOverride(props.frame) ? (
            <ActionButton
              label="Request revision"
              tone="secondary"
              disabled={isPending}
              className="w-full"
              onClick={() => void props.onRequestRevision(props.frame)}
            />
          ) : null}
        </div>
      ) : actionMode === "acknowledge" ? (
        <div className="flex flex-wrap items-center gap-2">
          {commentEnabled ? (
            <ActionButton
              label="Comment"
              tone="accent"
              disabled={isPending}
              onClick={() => setCommentOpen(true)}
            />
          ) : null}
          <ActionButton
            label={isPending ? "Saving…" : "Acknowledge"}
            tone="accent"
            disabled={isPending}
            onClick={() => void props.onAcknowledge(props.frame)}
          />
        </div>
      ) : null}
      {props.itemLink ? (
        <a
          href={props.itemLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {primaryLinkLabel(props.frame)}
          <ExternalLinkIcon />
        </a>
      ) : null}
      {commentOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-background/80 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Commenting on {compactTitle(props.frame)}
          </div>
          <div className="text-xs text-muted-foreground">
            Posts to the issue thread without leaving Focus.
          </div>
          <textarea
            ref={textareaRef}
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submitComment();
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setCommentOpen(false);
                setCommentBody("");
              }
            }}
            rows={4}
            placeholder="Add a short operator note back to the issue…"
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
          <div className="flex items-center justify-end gap-2">
            <ActionButton
              label="Cancel"
              tone="secondary"
              disabled={isPending}
              onClick={() => {
                setCommentOpen(false);
                setCommentBody("");
              }}
            />
            <ActionButton
              label={isPending ? "Posting…" : "Post comment"}
              tone="accent"
              disabled={isPending || commentBody.trim().length === 0}
              onClick={() => void submitComment()}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NowPane(props: {
  snapshot: AttentionSnapshot;
  posture: Posture;
  brand: SurfaceBrand;
  companyPrefix: string | null | undefined;
  counts: AttentionSnapshot["counts"];
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
}) {
  const frame = props.snapshot.active;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const wideLayout = useWideLayout(1120);
  const activeFrameId = frame?.id ?? null;
  const activeUnread = !!frame && (props.snapshot.review?.unread.active ?? 0) > 0;
  const itemLink = frame ? itemHref(frame, props.companyPrefix) : null;
  const recommendedMove = frame ? recommendedMoveValue(frame) : null;
  const helperLine = frame ? supportingLine(frame, "active") : null;
  const driverBadge = driverBadgeStyle();

  // Reset disclosure only when the *active frame* actually changes identity
  useEffect(() => {
    setDetailsOpen(false);
  }, [activeFrameId]);

  return (
    <section
      className="border border-border bg-card shadow-sm"
      style={frame ? { borderLeftWidth: 3, borderLeftColor: ACCENT_COLOR } : undefined}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-accent px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Accent className="text-sm leading-none">{props.posture.glyph}</Accent>
          <div className="flex items-end gap-2">
            <Accent className="text-base leading-none font-semibold tracking-[0.04em]">{props.brand.wordmark}</Accent>
            <span className="text-[11px] leading-none text-muted-foreground">{props.posture.label}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
          <span className={props.counts.active > 0 ? "font-semibold" : ""}>
            now {props.counts.active > 0 ? <Accent>{props.counts.active}</Accent> : props.counts.active}
          </span>
          <span className={props.counts.queued > 0 ? "font-semibold" : ""}>
            next {props.counts.queued > 0 ? <Accent>{props.counts.queued}</Accent> : props.counts.queued}
          </span>
          <span className={props.counts.ambient > 0 ? "font-semibold" : ""}>
            ambient {props.counts.ambient > 0 ? <Accent>{props.counts.ambient}</Accent> : props.counts.ambient}
          </span>
        </div>
      </div>
      <div className="px-5 py-5 sm:px-6">
        {!frame ? (
          <QuietNow />
        ) : (
          <div className="space-y-5">
            <div
              className={wideLayout ? "flex items-start gap-6" : "space-y-4"}
            >
              <div className="space-y-4" style={wideLayout ? { minWidth: 0, flex: 1 } : undefined}>
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  <span>Now</span>
                  <span className="normal-case tracking-normal text-muted-foreground/70">{sourceLabel(frame)}</span>
                </div>

                {recommendedMove ? (
                  <div className="max-w-4xl text-3xl font-semibold leading-tight text-foreground">
                    {recommendedMove}
                  </div>
                ) : frame.summary ? (
                  <div className="max-w-4xl text-3xl font-semibold leading-tight text-foreground">
                    {frame.summary}
                  </div>
                ) : null}

                <div className="flex items-start gap-2 text-xl font-medium leading-snug text-foreground/80">
                  <UnreadDot visible={activeUnread} />
                  <span>{renderTitle(frame)}</span>
                </div>

                {helperLine ? (
                  <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                    {helperLine}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border-border bg-secondary text-foreground/80">{impactLabel(frame)}</Badge>
                  {driverLabel(frame) ? (
                    <Badge className={driverBadge.className} style={driverBadge.style}>{driverLabel(frame)}</Badge>
                  ) : null}
                </div>

                <InlineExplainability frame={frame} lane="active" preferLaneReason={!!helperLine} />

                <div className="flex items-center gap-4">
                  <Accent><button
                    type="button"
                    onClick={() => setDetailsOpen(!detailsOpen)}
                    aria-expanded={detailsOpen}
                    className="flex items-center gap-1.5 text-xs font-medium transition-opacity hover:opacity-100"
                    style={{ color: "inherit" }}
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-90")}
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
                    </svg>
                    {detailsOpen ? "Hide context" : "Show context"}
                  </button></Accent>
                </div>
              </div>

              <NowActionRail
                frame={frame}
                lane="active"
                wide={wideLayout}
                pendingId={props.pendingId}
                itemLink={itemLink}
                onApprove={props.onApprove}
                onReject={props.onReject}
                onRequestRevision={props.onRequestRevision}
                onAcknowledge={props.onAcknowledge}
                onComment={props.onComment}
              />
            </div>

            {detailsOpen ? (
              <NowDetails
                frame={frame}
                snapshotUpdatedAt={props.snapshot.updatedAt}
                companyPrefix={props.companyPrefix}
              />
            ) : null}
          </div>
        )}
      </div>

    </section>
  );
}

// ---------------------------------------------------------------------------
// Next lane — compact ranked rows
// ---------------------------------------------------------------------------

function NextRow(props: {
  rank: number;
  frame: StoredAttentionFrame;
  movement?: QueueMovement;
  snapshot: AttentionSnapshot;
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
}) {
  const { frame } = props;
  const [expanded, setExpanded] = useState(false);
  const unread = isFrameUnreadInSnapshot(frame, props.snapshot);
  const activityLink = activityHref(frame, props.companyPrefix);
  const itemLink = itemHref(frame, props.companyPrefix);
  const secondaryText = nextPrimaryText(frame);
  const driver = driverLabel(frame);
  const driverBadge = driverBadgeStyle();
  const detailText = judgmentLine(frame, "queued");
  const showDetailText = detailText.trim().length > 0 && detailText !== secondaryText && detailText !== GENERIC_QUEUED_JUDGMENT;
  const rankOpacity = Math.max(0.4, 1 - (props.rank - 1) * 0.14);

  return (
    <div className="border-b border-border/80 last:border-b-0" style={expanded ? { borderLeftWidth: 2, borderLeftColor: ACCENT_COLOR } : undefined}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 sm:px-6"
      >
        <UnreadDot visible={unread} />
        <span className="w-5 shrink-0" style={{ opacity: rankOpacity }}>
          <Accent className="text-xs font-medium tabular-nums">
            {String(props.rank).padStart(2, "0")}
          </Accent>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-5 text-foreground">{renderTitle(frame)}</div>
          {secondaryText ? (
            <div className="mt-0.5 max-w-3xl text-xs leading-5 text-muted-foreground">{secondaryText}</div>
          ) : null}
        </div>
        <QueueMovementBadge movement={props.movement} />
        {driver ? (
          <Badge className={cn("shrink-0", driverBadge.className)} style={driverBadge.style}>{driver}</Badge>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground" style={{ opacity: 0.7 }}>
          {formatRelativeTime(frameUpdatedAt(frame, props.snapshotUpdatedAt))}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>

      {expanded ? (
        <div className="space-y-3 px-4 pb-4 pl-12 sm:px-6 sm:pl-14">
          {showDetailText ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {detailText}
            </p>
          ) : null}
          <ExplainabilityStrip frame={frame} lane="queued" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{impactLabel(frame)}</span>
            {driver ? <Accent>{driver}</Accent> : null}
            {props.movement ? <Accent>{props.movement === "up" ? "rising in queue" : "falling in queue"}</Accent> : null}
            <span>updated {formatRelativeTime(frameUpdatedAt(frame, props.snapshotUpdatedAt))}</span>
            {itemLink ? (
              <a
                href={itemLink}
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                {primaryLinkLabel(frame)}
              </a>
            ) : null}
            {activityLink ? (
              <a
                href={activityLink}
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                Open activity
              </a>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <IssueCommentComposer frame={frame} pendingId={props.pendingId} onComment={props.onComment} />
            <FrameActions
              frame={frame}
              lane="queued"
              pendingId={props.pendingId}
              onApprove={props.onApprove}
              onReject={props.onReject}
              onRequestRevision={props.onRequestRevision}
              onAcknowledge={props.onAcknowledge}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NextLane(props: {
  snapshot: AttentionSnapshot;
  rows: DisplayFrame[];
  movement: Record<string, QueueMovement>;
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
}) {
  return (
    <section className="border border-border/80 bg-card">
      <div className="border-b border-border/80 px-4 py-2.5 sm:px-6">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Next</h2>
      </div>

      {props.rows.length === 0 ? (
        <div className="px-4 py-4 text-sm text-muted-foreground sm:px-6" style={{ opacity: 0.7 }}>
          Nothing is staged behind the current focus.
        </div>
      ) : (
        props.rows.map((row, i) => (
          <NextRow
            key={row.frame.id}
            rank={i + 1}
            frame={row.frame}
            movement={props.movement[row.frame.interactionId]}
            snapshot={props.snapshot}
            snapshotUpdatedAt={props.snapshotUpdatedAt}
            companyPrefix={props.companyPrefix}
            pendingId={props.pendingId}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onRequestRevision={props.onRequestRevision}
            onAcknowledge={props.onAcknowledge}
            onComment={props.onComment}
          />
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ambient lane — very quiet, anchored with a top rule
// ---------------------------------------------------------------------------

function AmbientRow(props: {
  frame: StoredAttentionFrame;
  snapshot: AttentionSnapshot;
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
}) {
  const { frame, snapshotUpdatedAt } = props;
  const href = itemHref(frame, props.companyPrefix);
  const unread = isFrameUnreadInSnapshot(frame, props.snapshot);
  const content = (
    <div className="flex items-center gap-3 px-4 py-2.5 sm:px-6">
      <UnreadDot visible={unread} tone="muted" reserveSpace />
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        {renderTitle(frame)}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground/80">{sourceLabel(frame)}</span>
      <span className="shrink-0 text-xs text-muted-foreground/70">
        {formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}
      </span>
    </div>
  );

  return (
    <div style={{ borderBottomWidth: 1, borderBottomColor: "var(--border)" }} className="last:border-b-0">
      {href ? (
        <a href={href} className="block transition-colors hover:bg-accent/40">
          {content}
        </a>
      ) : (
        content
      )}
    </div>
  );
}

function AmbientLane(props: {
  snapshot: AttentionSnapshot;
  rows: DisplayFrame[];
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
}) {
  return (
    <section style={{ borderWidth: 1, borderColor: "var(--border)" }} className="mt-2 bg-card" aria-label="Ambient attention">
      <div style={{ borderBottomWidth: 1, borderBottomColor: "var(--border)" }} className="px-4 py-2.5 sm:px-6">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/80">Ambient</h2>
      </div>

      {props.rows.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-4 text-sm text-muted-foreground sm:px-6">
          <QuietMark />
          <span>Nothing in peripheral view.</span>
        </div>
      ) : (
        props.rows.map((row) => (
          <AmbientRow
            key={row.frame.id}
            frame={row.frame}
            snapshot={props.snapshot}
            snapshotUpdatedAt={props.snapshotUpdatedAt}
            companyPrefix={props.companyPrefix}
          />
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget — dense, TUI-like
// ---------------------------------------------------------------------------

export function DashboardWidget(props: PluginWidgetProps) {
  const companyId = props.context.companyId;
  const brand = currentSurfaceBrand();
  const href = pluginPagePath(props.context.companyPrefix);
  const model = useAttentionModel(companyId);
  const data = model.snapshot;
  const loading = model.loading;
  const error = model.error;

  if (!companyId) return <MessageCard title={`Open ${brand.wordmark}`} body={`Open a company to see ${brand.wordmark}.`} />;
  if (loading) return <WidgetLoadingState label={brand.loadingLabel} />;
  if (error) return <MessageCard title="Plugin error" body={error.message} />;
  if (!data) return <MessageCard title={brand.wordmark} body={brand.headingEmptyState} />;

  const posture = postureForSnapshot(data);
  const leadingText = data.active ? (recommendedMoveValue(data.active) ?? data.active.title) : null;
  const borderStyle =
    posture.label === "busy"
      ? { borderLeftWidth: 2, borderLeftColor: ACCENT_COLOR }
      : posture.label === "elevated"
        ? { borderLeftWidth: 2, borderLeftColor: ACCENT_BORDER }
        : undefined;

  return (
    <a href={href} className="block border border-border bg-card px-4 py-3 shadow-sm transition-colors hover:bg-accent/40" style={borderStyle}>
      <div className="flex items-start gap-2 text-xs">
        <Accent className="pt-0.5 text-sm">{posture.glyph}</Accent>
        <div className="min-w-0">
          <div className="flex items-end gap-2">
            <Accent className="font-semibold tracking-[0.04em]">{brand.wordmark}</Accent>
            <Accent className="text-[11px]">{posture.label}</Accent>
            {unreadCount(data) > 0 ? <Accent className="text-[11px]">new {unreadCount(data)}</Accent> : null}
          </div>
        </div>
        <span className="ml-auto tabular-nums text-muted-foreground">
          now {data.counts.active} · next {data.counts.queued} · ambient {data.counts.ambient}
        </span>
      </div>
      {leadingText ? (
        <div
          className="mt-2 text-sm font-medium leading-5 text-foreground"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {leadingText}
        </div>
      ) : (
        <div className="mt-2 text-sm text-muted-foreground">No active interruption right now.</div>
      )}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Sidebar link — already Paperclip-native
// ---------------------------------------------------------------------------

export function AttentionSidebarLink({ context }: PluginSidebarProps) {
  const companyId = context.companyId;
  const brand = currentSurfaceBrand();
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  const model = useAttentionModel(companyId);
  const merged = model.snapshot;
  const actionable = merged ? actionableCount(merged) : 0;
  const unread = unreadCount(merged);

  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <span className="relative shrink-0" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="m14.3 8 5.2 9" />
          <path d="M9.7 8h10.4" />
          <path d="m7.4 12 5.2-9" />
          <path d="m9.7 16-5.2-9" />
          <path d="M14.3 16H3.9" />
          <path d="m16.6 12-5.2 9" />
        </svg>
      </span>
      <span className="flex-1 truncate">{brand.wordmark}</span>
      {(unread > 0 || actionable > 0) ? (
        unread > 0 ? (
          <span className="inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs leading-none font-medium text-white" style={ACCENT_BG_STYLE}>
            {unread}
          </span>
        ) : (
          <span
            className="inline-flex items-center justify-center rounded-full border px-1.5 py-0.5 text-xs leading-none font-medium"
            style={{ color: ACCENT_COLOR, borderColor: ACCENT_BORDER, backgroundColor: "transparent" }}
          >
            {actionable}
          </span>
        )
      ) : null}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Attention page — single-column, calm operator surface
// ---------------------------------------------------------------------------

export function AttentionPage(props: PluginPageProps) {
  const companyId = props.context.companyId;
  const brand = currentSurfaceBrand();
  const model = useAttentionModel(companyId);
  const snapshot = model.snapshot;
  const loading = model.loading;
  const error = model.error;
  const acknowledge = usePluginAction("acknowledge-frame");
  const commentOnIssue = usePluginAction("comment-on-issue");
  const recordApprovalResponse = usePluginAction("record-approval-response");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const [localSuppressions, setLocalSuppressions] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!statusOverride) return;

    const timer = window.setTimeout(() => {
      setStatusOverride(null);
    }, 4000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [statusOverride]);

  const persistedSuppressions = useMemo(
    () => suppressionMapFromReview(model.review),
    [model.review],
  );
  const effectiveSuppressions = useMemo(
    () => ({ ...persistedSuppressions, ...localSuppressions }),
    [persistedSuppressions, localSuppressions],
  );
  const displaySnapshot = useMemo(
    () => applyLocalSuppressions(snapshot, effectiveSuppressions),
    [snapshot, effectiveSuppressions],
  );
  const backgroundErrorMessage = displaySnapshot && error ? `Sync issue: ${error.message}` : null;
  const posture = useMemo(() => (displaySnapshot ? postureForSnapshot(displaySnapshot) : null), [displaySnapshot]);
  const nextRows = useMemo(
    () => (displaySnapshot ? displaySnapshot.queued.map((frame) => ({ frame, lane: "queued" as const })) : []),
    [displaySnapshot],
  );
  const ambientRows = useMemo(
    () => (displaySnapshot ? displaySnapshot.ambient.map((frame) => ({ frame, lane: "ambient" as const })) : []),
    [displaySnapshot],
  );
  const nextMovement = useQueueMovement(nextRows.map((row) => row.frame));

  useEffect(() => {
    if (!snapshot) return;

    setLocalSuppressions((current) => {
      const nextEntries = Object.entries(current).filter(([taskId, suppressedAt]) => {
        const frames = [
          ...(snapshot.active ? [snapshot.active] : []),
          ...snapshot.queued,
          ...snapshot.ambient,
        ];
        const matching = frames.filter((frame) => frame.taskId === taskId);
        if (matching.length === 0 && persistedSuppressions[taskId]) return false;
        if (matching.length === 0) return false;
        return matching.some((frame) => frameUpdatedAt(frame, snapshot.updatedAt).localeCompare(suppressedAt) <= 0);
      });

      if (nextEntries.length === Object.keys(current).length) return current;
      return Object.fromEntries(nextEntries);
    });
  }, [snapshot, persistedSuppressions]);

  function nudgeRefresh() {
    model.refresh();
    window.setTimeout(() => model.refresh(), 500);
  }

  async function acknowledgeFrame(frame: StoredAttentionFrame) {
    setPendingId(frame.id);
    const suppressedAt = new Date().toISOString();
    setLocalSuppressions((current) => ({ ...current, [frame.taskId]: suppressedAt }));
    try {
      await acknowledge({ companyId, taskId: frame.taskId, interactionId: frame.interactionId });
      setStatusOverride(acknowledgeSuccessMessage(compactTitle(frame)));
      nudgeRefresh();
    } catch (actionError) {
      setLocalSuppressions((current) => {
        const next = { ...current };
        delete next[frame.taskId];
        return next;
      });
      setStatusOverride(acknowledgeFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function commentOnIssueFrame(frame: StoredAttentionFrame, body: string) {
    const issueId = entityIdFromFrame(frame);
    if (!companyId || !issueId || entityTypeFromFrame(frame) !== "issue") {
      setStatusOverride(issueFrameUnsupportedMessage());
      return;
    }

    setPendingId(frame.id);
    try {
      await commentOnIssue({ companyId, taskId: frame.taskId, issueId, body });
      setStatusOverride(commentSuccessMessage(compactTitle(frame)));
      nudgeRefresh();
    } catch (actionError) {
      setStatusOverride(commentFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function submitApprovalDecision(frame: StoredAttentionFrame, decision: "approve" | "reject") {
    const approvalId = approvalIdForFrame(frame);
    if (!approvalId) {
      setStatusOverride(approvalFrameUnsupportedMessage());
      return;
    }

    setPendingId(frame.id);
    const suppressedAt = new Date().toISOString();
    setLocalSuppressions((current) => ({ ...current, [frame.taskId]: suppressedAt }));
    try {
      const actionPath = decision === "approve" ? "approve" : "reject";
      await paperclipApiFetch(`/api/approvals/${approvalId}/${actionPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        expectJson: false,
      });
      await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision,
      });

      setStatusOverride(approvalDecisionSuccessMessage(compactTitle(frame), decision));
      nudgeRefresh();
    } catch (actionError) {
      setLocalSuppressions((current) => {
        const next = { ...current };
        delete next[frame.taskId];
        return next;
      });
      setStatusOverride(approvalDecisionFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function requestApprovalRevision(frame: StoredAttentionFrame) {
    const approvalId = approvalIdForFrame(frame);
    if (!approvalId) {
      setStatusOverride(approvalFrameUnsupportedMessage());
      return;
    }

    setPendingId(frame.id);
    const suppressedAt = new Date().toISOString();
    setLocalSuppressions((current) => ({ ...current, [frame.taskId]: suppressedAt }));
    try {
      await paperclipApiFetch(`/api/approvals/${approvalId}/request-revision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        expectJson: false,
      });
      await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision: "request-revision",
      });

      setStatusOverride(approvalRevisionSuccessMessage(compactTitle(frame)));
      nudgeRefresh();
    } catch (actionError) {
      setLocalSuppressions((current) => {
        const next = { ...current };
        delete next[frame.taskId];
        return next;
      });
      setStatusOverride(approvalRevisionFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  if (!companyId) return <MessageCard title={`Open ${brand.wordmark}`} body={`Select a company to open ${brand.wordmark}.`} />;
  if (!displaySnapshot && loading) return <PageLoadingState label="Loading attention center" />;
  if (!displaySnapshot && error) return <MessageCard title="Plugin error" body={error.message} />;
  if (!displaySnapshot || !posture) {
    return (
      <MessageCard
        title={`No ${brand.wordmark} State Yet`}
        body={`No ${brand.key === "focus" ? "focus" : "attention"} state has been captured for this company yet.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      <NowPane
        snapshot={displaySnapshot}
        posture={posture}
        brand={brand}
        companyPrefix={props.context.companyPrefix}
        counts={displaySnapshot.counts}
        pendingId={pendingId}
        onApprove={(frame) => submitApprovalDecision(frame, "approve")}
        onReject={(frame) => submitApprovalDecision(frame, "reject")}
        onRequestRevision={requestApprovalRevision}
        onAcknowledge={acknowledgeFrame}
        onComment={commentOnIssueFrame}
      />

      <NextLane
        snapshot={displaySnapshot}
        rows={nextRows}
        movement={nextMovement}
        snapshotUpdatedAt={displaySnapshot.updatedAt}
        companyPrefix={props.context.companyPrefix}
        pendingId={pendingId}
        onApprove={(frame) => submitApprovalDecision(frame, "approve")}
        onReject={(frame) => submitApprovalDecision(frame, "reject")}
        onRequestRevision={requestApprovalRevision}
        onAcknowledge={acknowledgeFrame}
        onComment={commentOnIssueFrame}
      />

      <AmbientLane
        snapshot={displaySnapshot}
        rows={ambientRows}
        snapshotUpdatedAt={displaySnapshot.updatedAt}
        companyPrefix={props.context.companyPrefix}
      />

      <StatusToast message={statusOverride ?? backgroundErrorMessage} />
    </div>
  );
}
