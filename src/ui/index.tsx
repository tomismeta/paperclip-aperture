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
  supportCopy: string;
  headingEmptyState: string;
  loadingLabel: string;
};

// Aperture brand accent
// Uses inline styles because the host Tailwind JIT won't scan plugin bundles
// for arbitrary values.
const ACCENT_COLOR = "#007ACC";
const ACCENT_BG_STYLE: React.CSSProperties = { backgroundColor: ACCENT_COLOR };

function currentSurfaceBrand(): SurfaceBrand {
  return {
    key: "focus",
    wordmark: "Focus",
    supportCopy: "Powered by Aperture",
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
    style: { color: ACCENT_COLOR, backgroundColor: `${ACCENT_COLOR}14`, borderColor: `${ACCENT_COLOR}40` },
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

function UnreadDot({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return <span className="inline-block h-2 w-2 rounded-full shrink-0" style={ACCENT_BG_STYLE} aria-label="Unread attention item" />;
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
        "pointer-events-none fixed bottom-6 right-6 z-50 transition-all duration-200",
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
  tone: "primary" | "danger" | "secondary";
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  const toneClass =
    props.tone === "primary"
      ? "bg-green-700 text-white hover:bg-green-600"
      : props.tone === "danger"
        ? "bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
        : "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50";

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium",
        "transition-[color,background-color,border-color,box-shadow,opacity]",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:pointer-events-none disabled:opacity-50",
        toneClass,
        props.className,
      )}
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
        backgroundColor: `${ACCENT_COLOR}12`,
        borderColor: `${ACCENT_COLOR}33`,
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
          tone="primary"
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

function ContextItems({ frame }: { frame: StoredAttentionFrame }) {
  const items = frame.context?.items ?? [];
  if (items.length === 0) return null;

  return (
    <div className="grid gap-2 md:grid-cols-2">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "border border-border bg-secondary/50 px-3 py-2",
            (
              item.id === ATTENTION_CONTEXT_IDS.latestComment
              || item.id === ATTENTION_CONTEXT_IDS.recommendedMove
            ) && "md:col-span-2",
          )}
        >
          <div className="text-xs font-medium text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-sm text-foreground">{item.value ?? "Available"}</div>
        </div>
      ))}
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
  triggerTone?: "link" | "secondary" | "primary";
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");

  if (!isIssueFrame(props.frame)) return null;

  const isPending = props.pendingId === props.frame.id;

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
        className="w-full"
        disabled={isPending}
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="w-full space-y-2 border border-border bg-secondary/40 p-3">
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        placeholder="Add a short operator note back to the issue…"
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <div className="grid grid-cols-2 gap-2">
        <ActionButton
          label="Cancel"
          tone="secondary"
          className="w-full"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setBody("");
          }}
        />
        <ActionButton
          label={isPending ? "Posting…" : "Post comment"}
          tone="primary"
          className="w-full"
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

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="border border-border bg-secondary/50 px-3 py-2">
        <div className="text-xs font-medium text-muted-foreground">Judgment</div>
        <p className="mt-1 text-sm text-foreground/90">{judgmentLine(frame, "active")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{requestDescriptor(frame)}</span>
          <span>{impactLabel(frame)}</span>
          <span>{formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}</span>
          {requestedAmount(frame) ? <span>Amount requested: {requestedAmount(frame)}</span> : null}
          {budgetReason(frame) ? <span>{budgetReason(frame)}</span> : null}
        </div>
      </div>

      <ContextItems frame={frame} />

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
    <div className="flex min-h-16 items-center">
      <div className="text-sm text-muted-foreground">Nothing active right now.</div>
    </div>
  );
}

function NowActionRail(props: {
  frame: StoredAttentionFrame;
  lane: FrameLane;
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

  return (
    <aside
      className="space-y-4 border border-border bg-secondary/20 p-4"
      style={{ flex: "0 1 20rem", minWidth: "18rem" }}
    >
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Actions
      </div>

      <div className="space-y-2">
        {commentEnabled ? (
          <IssueCommentComposer
            frame={props.frame}
            pendingId={props.pendingId}
            onComment={props.onComment}
            triggerTone="primary"
            triggerLabel="Comment"
          />
        ) : null}

        {actionMode === "approval" ? (
          <>
            {isBudgetOverride(props.frame) ? (
              <ActionButton
                label="Request revision"
                tone="secondary"
                disabled={isPending}
                className="w-full"
                onClick={() => void props.onRequestRevision(props.frame)}
              />
            ) : null}
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
          </>
        ) : actionMode === "acknowledge" ? (
          <ActionButton
            label={isPending ? "Saving…" : "Acknowledge"}
            tone={commentEnabled ? "secondary" : "primary"}
            disabled={isPending}
            className="w-full"
            onClick={() => void props.onAcknowledge(props.frame)}
          />
        ) : null}
      </div>

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
    </aside>
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
    <section className="border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-accent px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-3">
          <Accent className="text-base leading-none">{props.posture.glyph}</Accent>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-end gap-2">
              <Accent className="text-[18px] leading-none font-bold tracking-[0.04em]">{props.brand.wordmark}</Accent>
              <Accent className="text-xs leading-none">{props.posture.label}</Accent>
            </div>
            <div className="text-[10px] leading-none text-muted-foreground/60">{props.brand.supportCopy}</div>
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

      <div style={{ height: "0.75rem" }} aria-hidden="true" />
      <div className="px-4 pb-4 sm:px-6">
        {!frame ? (
          <QuietNow />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-6">
              <div className="min-w-0 space-y-4" style={{ flex: "1 1 40rem" }}>
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <span>Now</span>
                  <span className="normal-case tracking-normal" style={{ opacity: 0.6 }}>{sourceLabel(frame)}</span>
                </div>

                {recommendedMove ? (
                  <div className="max-w-4xl text-[2rem] font-semibold leading-tight text-foreground">
                    {recommendedMove}
                  </div>
                ) : frame.summary ? (
                  <div className="max-w-4xl text-[2rem] font-semibold leading-tight text-foreground">
                    {frame.summary}
                  </div>
                ) : null}

                <div className="flex items-center gap-2 text-[1.75rem] font-medium leading-snug text-foreground/90">
                  <UnreadDot visible={activeUnread} />
                  <span>{renderTitle(frame)}</span>
                </div>

                {helperLine ? (
                  <p className="max-w-3xl text-[0.95rem] leading-relaxed text-muted-foreground">
                    {helperLine}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="border-border bg-secondary text-foreground/80">{impactLabel(frame)}</Badge>
                  {driverLabel(frame) ? (
                    <Badge className={driverBadge.className} style={driverBadge.style}>{driverLabel(frame)}</Badge>
                  ) : null}
                </div>

                <div className="flex items-center gap-4 pt-1">
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
                    {detailsOpen ? "Hide details" : "Show details"}
                  </button></Accent>
                </div>
              </div>

              <NowActionRail
                frame={frame}
                lane="active"
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

  return (
    <div className="border-b border-border/80 last:border-b-0" style={expanded ? { borderLeftWidth: 2, borderLeftColor: ACCENT_COLOR } : undefined}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 sm:px-6"
      >
        <Accent className="w-5 shrink-0 text-xs font-medium tabular-nums">
          {String(props.rank).padStart(2, "0")}
        </Accent>
        <UnreadDot visible={unread} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{renderTitle(frame)}</div>
          {secondaryText ? (
            <div className="truncate text-xs text-muted-foreground">{secondaryText}</div>
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
        <div className="space-y-3 px-4 pb-3 pl-12 sm:px-6 sm:pl-14">
          {showDetailText ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {detailText}
            </p>
          ) : null}
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
  const [expanded, setExpanded] = useState(false);
  const href = itemHref(frame, props.companyPrefix);
  const unread = isFrameUnreadInSnapshot(frame, props.snapshot);
  const activityLink = activityHref(frame, props.companyPrefix);

  return (
    <div style={{ borderBottomWidth: 1, borderBottomColor: "var(--border)" }} className="last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/50 sm:px-6"
      >
        <UnreadDot visible={unread} />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground/80">{renderTitle(frame)}</span>
        <span className="shrink-0 text-xs text-muted-foreground" style={{ opacity: 0.6 }}>{sourceLabel(frame)}</span>
        <span className="shrink-0 text-xs text-muted-foreground" style={{ opacity: 0.55 }}>
          {formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          fill="currentColor"
          style={{ opacity: 0.75 }}
          aria-hidden="true"
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>

      {expanded ? (
        <div className="space-y-3 px-4 pb-3 sm:px-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {frame.summary ?? judgmentLine(frame, "ambient")}
          </p>
          <div className="flex items-center gap-3">
            {href ? (
              <a
                href={href}
                className="text-xs font-medium underline underline-offset-2 text-muted-foreground hover:text-foreground"
              >
                {primaryLinkLabel(frame)}
              </a>
            ) : null}
            {activityLink ? (
              <a
                href={activityLink}
                className="text-xs font-medium underline underline-offset-2 text-muted-foreground hover:text-foreground"
              >
                Open activity
              </a>
            ) : null}
            <span className="ml-auto text-xs uppercase tracking-[0.16em] text-muted-foreground/60">
              Awareness only
            </span>
          </div>
        </div>
      ) : null}
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
    <section style={{ borderWidth: 1, borderColor: "var(--border)" }} className="bg-card" aria-label="Ambient attention">
      <div style={{ borderBottomWidth: 1, borderBottomColor: "var(--border)" }} className="px-4 py-2.5 sm:px-6">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground" style={{ opacity: 0.6 }}>Ambient</h2>
      </div>

      {props.rows.length === 0 ? (
        <div className="px-4 py-4 text-sm text-muted-foreground sm:px-6" style={{ opacity: 0.4 }}>
          Nothing in peripheral view.
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
  const model = useAttentionModel(companyId);
  const data = model.snapshot;
  const loading = model.loading;
  const error = model.error;

  if (!companyId) return <MessageCard title={`Open ${brand.wordmark}`} body={`Open a company to see ${brand.wordmark}.`} />;
  if (loading) return <WidgetLoadingState label={brand.loadingLabel} />;
  if (error) return <MessageCard title="Plugin error" body={error.message} />;
  if (!data) return <MessageCard title={brand.wordmark} body={brand.headingEmptyState} />;

  const posture = postureForSnapshot(data);

  return (
    <div className="border border-border bg-card px-4 py-2.5 shadow-sm">
      <div className="flex items-start gap-2 text-xs">
        <Accent className="pt-0.5 text-sm">{posture.glyph}</Accent>
        <div className="min-w-0">
          <div className="flex items-end gap-2">
            <Accent className="font-semibold tracking-[0.04em]">{brand.wordmark}</Accent>
            <Accent className="text-[11px]">{posture.label}</Accent>
            {unreadCount(data) > 0 ? <Accent className="text-[11px]">new {unreadCount(data)}</Accent> : null}
          </div>
          <div className="mt-0.5 text-[10px] leading-none text-muted-foreground/60">{brand.supportCopy}</div>
        </div>
        <span className="ml-auto tabular-nums text-muted-foreground">
          now {data.counts.active} · next {data.counts.queued} · ambient {data.counts.ambient}
        </span>
      </div>
      {data.active ? (
        <div className="mt-2 truncate text-sm font-medium text-foreground">{data.active.title}</div>
      ) : (
        <div className="mt-2 text-sm text-muted-foreground">No active interruption right now.</div>
      )}
    </div>
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
        <span className="inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs leading-none font-medium text-white" style={ACCENT_BG_STYLE}>
          {unread > 0 ? unread : actionable}
        </span>
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
    <div className="space-y-5">
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
