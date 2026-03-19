import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createEmptySnapshot,
  type AttentionSnapshot,
  type StoredAttentionFrame,
} from "../aperture/types.js";

type FrameLane = "active" | "queued" | "ambient";
type DisplayFrame = {
  frame: StoredAttentionFrame;
  lane: FrameLane;
};
type Posture = {
  glyph: "\u25CB" | "\u25D0" | "\u25CF";
  label: "calm" | "elevated" | "busy";
};
type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
type ApprovalQueryResult = {
  data: ApprovalRecord[] | null;
  loading: boolean;
  error: Error | null;
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
const ACCENT_COLOR = "#19A1FF";
const ACCENT_STYLE: React.CSSProperties = { color: ACCENT_COLOR };
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

function humanizeToken(value: string): string {
  return value
    .split(/[_\-.]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
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

function isBudgetOverride(frame: StoredAttentionFrame): boolean {
  return frame.provenance?.factors?.includes("budget stop") ?? false;
}

function requestedAmount(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, "requested-amount");
}

function budgetReason(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, "budget-reason");
}

function modeLabel(frame: StoredAttentionFrame): string {
  switch (frame.mode) {
    case "approval":
      return "approval";
    case "choice":
      return "choice";
    case "form":
      return "form";
    default:
      return "status";
  }
}

function urgencyLabel(frame: StoredAttentionFrame): string {
  switch (frame.tone) {
    case "critical":
      return "urgent";
    case "focused":
      return "needs attention";
    case "ambient":
      return "low urgency";
  }
}

function riskLabel(frame: StoredAttentionFrame): string {
  return `${frame.consequence} risk`;
}

function toneBadgeStyle(frame: StoredAttentionFrame): { className: string; style?: React.CSSProperties } {
  switch (frame.tone) {
    case "critical":
      return {
        className: "border-transparent",
        style: { color: ACCENT_COLOR, backgroundColor: `${ACCENT_COLOR}1a`, borderColor: `${ACCENT_COLOR}4d` },
      };
    case "focused":
      return {
        className: "border-transparent",
        style: { color: ACCENT_COLOR, opacity: 0.8, backgroundColor: `${ACCENT_COLOR}0d`, borderColor: `${ACCENT_COLOR}33` },
      };
    case "ambient":
      return { className: "border-border bg-secondary text-muted-foreground" };
  }
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

  if (lane === "active") {
    if (isBudgetOverride(frame)) return "Budget controls are blocking work until a board decision lands.";
    if (frame.mode === "approval") return "A human decision is blocking work right now.";
    if (frame.tone === "critical") return "This surfaced because it can displace the operator now.";
    return "This is the clearest current operator focus.";
  }

  if (isBudgetOverride(frame)) return "Budget review is staged behind the current focus.";
  if (lane === "queued") return "Important enough to keep visible, but not enough to displace now.";
  return "Useful for awareness, but not interrupting.";
}

function frameUpdatedAt(frame: StoredAttentionFrame, snapshotUpdatedAt: string): string {
  return frame.timing.updatedAt || snapshotUpdatedAt;
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

function responseKind(frame: StoredAttentionFrame, lane: FrameLane): "approval" | "acknowledge" | "none" {
  if (approvalIdForFrame(frame) && (frame.responseSpec?.kind === "approval" || frame.mode === "approval")) {
    return "approval";
  }

  if (lane !== "ambient" && (frame.responseSpec?.kind === "acknowledge" || frame.mode === "status")) {
    return "acknowledge";
  }

  return "none";
}

function compactTitle(frame: StoredAttentionFrame): string {
  return frame.title.trim().length > 0 ? frame.title : "Untitled frame";
}

function approvalTitle(record: ApprovalRecord): string {
  const payload = record.payload ?? {};
  const explicitTitle = typeof payload.title === "string"
    ? payload.title
    : typeof payload.plan === "string"
      ? payload.plan
      : typeof payload.name === "string"
        ? payload.name
        : null;

  if (explicitTitle) return explicitTitle;
  return `${humanizeToken(record.type)} approval`;
}

function isBudgetOverrideRecord(record: ApprovalRecord): boolean {
  return record.type === "budget_override_required";
}

function actionableApprovalRecords(records: ApprovalRecord[] | null): ApprovalRecord[] {
  if (!records) return [];
  return records
    .filter((record) => record.status === "pending" || record.status === "revision_requested")
    .sort((left, right) => {
      const leftScore = isBudgetOverrideRecord(left) ? 1 : 0;
      const rightScore = isBudgetOverrideRecord(right) ? 1 : 0;
      if (leftScore !== rightScore) return rightScore - leftScore;
      return (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt);
    });
}

function approvalRecordToFrame(record: ApprovalRecord): StoredAttentionFrame {
  const payload = record.payload ?? {};
  const budgetOverride = isBudgetOverrideRecord(record);
  const requestedAmount = typeof payload.requestedAmount === "string" ? payload.requestedAmount : undefined;
  const reason = typeof payload.reason === "string" ? payload.reason : undefined;
  const decisionContext = typeof payload.decisionContext === "string" ? payload.decisionContext : undefined;
  const summary = typeof payload.summary === "string"
    ? payload.summary
    : budgetOverride
      ? "Budget controls are blocking work until a board decision lands."
      : "A board decision is blocking work in Paperclip.";
  const updatedAt = record.updatedAt ?? record.createdAt;

  return {
    id: `approval-bootstrap:${record.id}`,
    taskId: `approval:${record.id}`,
    interactionId: `approval:${record.id}:approval`,
    source: {
      id: "paperclip:approval",
      kind: "paperclip",
      label: "Paperclip approval",
    },
    version: 1,
    mode: "approval",
    tone: "focused",
    consequence: budgetOverride ? "high" : "medium",
    title: approvalTitle(record),
    summary,
    context: {
      items: [
        {
          id: "approval-type",
          label: "Type",
          value: humanizeToken(record.type),
        },
        ...(requestedAmount ? [{
          id: "requested-amount",
          label: "Requested amount",
          value: requestedAmount,
        }] : []),
        ...(reason ? [{
          id: "budget-reason",
          label: "Reason",
          value: reason,
        }] : []),
        ...(decisionContext ? [{
          id: "decision-context",
          label: "Decision context",
          value: decisionContext,
        }] : []),
      ],
    },
    responseSpec: {
      kind: "approval",
      actions: [
        { id: "approve", label: "Approve", kind: "approve", emphasis: "primary" },
        { id: "reject", label: "Reject", kind: "reject", emphasis: "danger" },
        ...(budgetOverride
          ? [{ id: "request-revision", label: "Request revision", kind: "cancel" as const, emphasis: "secondary" as const }]
          : []),
      ],
    },
    provenance: {
      whyNow: budgetOverride
        ? "Budget controls are blocking work until a board decision lands."
        : "Paperclip is waiting on a human approval before work can continue.",
      factors: budgetOverride
        ? ["budget stop", "approval", "operator decision"]
        : ["approval", "operator decision"],
    },
    timing: {
      createdAt: record.createdAt,
      updatedAt,
    },
    metadata: {
      approvalStatus: record.status,
      approvalType: record.type,
    },
  };
}

function frameSortScore(frame: StoredAttentionFrame, lane: FrameLane): number {
  const toneWeight = frame.tone === "critical" ? 40 : frame.tone === "focused" ? 25 : 5;
  const consequenceWeight = frame.consequence === "high" ? 30 : frame.consequence === "medium" ? 15 : 0;
  const modeWeight = frame.mode === "approval" ? 12 : frame.mode === "choice" ? 8 : 0;
  const laneWeight = lane === "active" ? 20 : lane === "queued" ? 10 : 0;
  const budgetWeight = isBudgetOverride(frame) ? 10 : 0;
  return toneWeight + consequenceWeight + modeWeight + laneWeight + budgetWeight;
}

function mergeSnapshotWithApprovals(
  snapshot: AttentionSnapshot | null,
  companyId: string,
  approvals: ApprovalRecord[] | null,
): AttentionSnapshot {
  const base = snapshot ?? createEmptySnapshot(companyId);
  const approvalFrames = actionableApprovalRecords(approvals).map(approvalRecordToFrame);
  const baseNonApprovalActive = base.active && !approvalIdForFrame(base.active) ? base.active : null;
  const baseNonApprovalQueued = base.queued.filter((frame) => !approvalIdForFrame(frame));
  const baseAmbient = base.ambient.filter((frame) => !approvalIdForFrame(frame));

  if (approvalFrames.length === 0) {
    return {
      ...base,
      active: baseNonApprovalActive,
      queued: baseNonApprovalQueued,
      ambient: baseAmbient,
      counts: {
        active: baseNonApprovalActive ? 1 : 0,
        queued: baseNonApprovalQueued.length,
        ambient: baseAmbient.length,
        total: (baseNonApprovalActive ? 1 : 0) + baseNonApprovalQueued.length + baseAmbient.length,
      },
    };
  }

  const candidates: Array<{ frame: StoredAttentionFrame; lane: FrameLane }> = [
    ...(baseNonApprovalActive ? [{ frame: baseNonApprovalActive, lane: "active" as const }] : []),
    ...baseNonApprovalQueued.map((frame) => ({ frame, lane: "queued" as const })),
    ...approvalFrames.map((frame, index) => ({ frame, lane: index === 0 ? "active" as const : "queued" as const })),
  ].sort((left, right) => {
    const byScore = frameSortScore(right.frame, right.lane) - frameSortScore(left.frame, left.lane);
    if (byScore !== 0) return byScore;
    return frameUpdatedAt(right.frame, base.updatedAt).localeCompare(frameUpdatedAt(left.frame, base.updatedAt));
  });

  const active = candidates[0]?.frame ?? null;
  const queued = candidates.slice(1).map((entry) => entry.frame);

  return {
    ...base,
    active,
    queued,
    ambient: baseAmbient,
    counts: {
      active: active ? 1 : 0,
      queued: queued.length,
      ambient: baseAmbient.length,
      total: (active ? 1 : 0) + queued.length + baseAmbient.length,
    },
  };
}

function usePendingApprovals(companyId: string | null | undefined): ApprovalQueryResult {
  const [data, setData] = useState<ApprovalRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
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
        const response = await window.fetch(`/api/companies/${companyId}/approvals?status=pending`, {
          method: "GET",
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`Failed to load approvals (${response.status})`);
        }
        const approvals = await response.json() as ApprovalRecord[];
        if (!cancelled) {
          setData(approvals);
          setLoading(false);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError : new Error(String(fetchError)));
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

  return parts.length > 1 ? <>{parts}</> : null;
}

function renderTitle(frame: StoredAttentionFrame): ReactNode {
  const text = compactTitle(frame);
  const highlighted = HighlightedTitle({ text });
  return highlighted ?? text;
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

    const timer = window.setInterval(() => {
      for (const refresh of refreshersRef.current) refresh();
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [companyId, intervalMs]);
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
      )}
    >
      {props.label}
    </button>
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
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
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
        <>
          <ActionButton
            label={isPending ? "Saving\u2026" : "Acknowledge"}
            tone="primary"
            disabled={isPending}
            onClick={() => void props.onAcknowledge(props.frame)}
          />
          <ActionButton
            label="Dismiss"
            tone="secondary"
            disabled={isPending}
            onClick={() => void props.onDismiss(props.frame)}
          />
        </>
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
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.id} className="border border-border bg-secondary/50 px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">{item.label}</div>
          <div className="mt-1 text-sm text-foreground">{item.value ?? "Available"}</div>
        </div>
      ))}
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

  return (
    <div className="space-y-3 border-t border-border pt-4">
      {/* Summary — moved here from always-visible */}
      {frame.summary ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{frame.summary}</p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {/* Why now */}
        <div className="border border-border bg-secondary/50 px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">Judgment</div>
          <p className="mt-1 text-sm text-foreground/90">{judgmentLine(frame, "active")}</p>
        </div>

        {/* Request metadata */}
        <div className="border border-border bg-secondary/50 px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground">Request</div>
          <div className="mt-1 space-y-0.5 text-sm">
            <div className="text-foreground/90">{sourceLabel(frame)} &middot; {modeLabel(frame)}</div>
            <div className="text-muted-foreground">{riskLabel(frame)} &middot; {formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}</div>
            {requestedAmount(frame) ? (
              <div className="text-foreground/90">Amount requested: {requestedAmount(frame)}</div>
            ) : null}
            {budgetReason(frame) ? (
              <div className="text-muted-foreground">{budgetReason(frame)}</div>
            ) : null}
          </div>
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
            Open in Paperclip
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
              <path d="M8.5 1.5h6v6" />
              <path d="M14.5 1.5l-7 7" />
            </svg>
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
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
              <path d="M8.5 1.5h6v6" />
              <path d="M14.5 1.5l-7 7" />
            </svg>
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
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
}) {
  const frame = props.snapshot.active;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeFrameId = frame?.id ?? null;

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

      <div style={{ height: "1.25rem" }} aria-hidden="true" />
      <div className="px-4 pb-5 sm:px-6">
        {!frame ? (
          <QuietNow />
        ) : (
          <div className="space-y-4">
            {/* Row 1: NOW label */}
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Now</span>
              <span className="normal-case tracking-normal" style={{ opacity: 0.6 }}>{sourceLabel(frame)}</span>
            </div>

            {/* Row 2: Title */}
            <div className="text-lg font-semibold leading-snug text-foreground">{renderTitle(frame)}</div>

            {/* Row 3: Badges (left) + Actions (right) — same line */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={toneBadgeStyle(frame).className} style={toneBadgeStyle(frame).style}>{urgencyLabel(frame)}</Badge>
              <Badge className="border-border bg-secondary text-foreground/80">{riskLabel(frame)}</Badge>
              <Badge className="border-border bg-secondary text-muted-foreground">{modeLabel(frame)}</Badge>
              {isBudgetOverride(frame) ? (
                <Badge className="border-transparent text-white" style={ACCENT_BG_STYLE}>budget stop</Badge>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <FrameActions
                  frame={frame}
                  lane="active"
                  pendingId={props.pendingId}
                  onApprove={props.onApprove}
                  onReject={props.onReject}
                  onRequestRevision={props.onRequestRevision}
                  onAcknowledge={props.onAcknowledge}
                  onDismiss={props.onDismiss}
                />
              </div>
            </div>

            {/* Row 4: Show details (chevron toggle) + Open in Paperclip (external link) */}
            <div className="flex items-center gap-4 pb-1">
              <Accent><button
                type="button"
                onClick={() => setDetailsOpen(!detailsOpen)}
                className="flex items-center gap-1.5 text-xs font-medium transition-opacity hover:opacity-100"
                style={{ color: "inherit" }}
              >
                <svg
                  viewBox="0 0 16 16"
                  className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-90")}
                  fill="currentColor"
                >
                  <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
                </svg>
                {detailsOpen ? "Hide details" : "Show details"}
              </button></Accent>

              {itemHref(frame, props.companyPrefix) ? (
                <a
                  href={itemHref(frame, props.companyPrefix)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-opacity hover:text-foreground"
                >
                  Open in Paperclip
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
                    <path d="M8.5 1.5h6v6" />
                    <path d="M14.5 1.5l-7 7" />
                  </svg>
                </a>
              ) : null}
            </div>

            {detailsOpen ? (
              <NowDetails frame={frame} snapshotUpdatedAt={props.snapshot.updatedAt} companyPrefix={props.companyPrefix} />
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
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
}) {
  const { frame } = props;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/80 last:border-b-0" style={expanded ? { borderLeftWidth: 2, borderLeftColor: ACCENT_COLOR } : undefined}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 sm:px-6"
      >
        <Accent className="w-5 shrink-0 text-xs font-medium tabular-nums">
          {String(props.rank).padStart(2, "0")}
        </Accent>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {renderTitle(frame)}
        </span>
        {isBudgetOverride(frame) ? (
          <Badge className="border-transparent shrink-0 text-white" style={ACCENT_BG_STYLE}>budget</Badge>
        ) : null}
        <Badge className={cn("shrink-0", toneBadgeStyle(frame).className)} style={toneBadgeStyle(frame).style}>{urgencyLabel(frame)}</Badge>
        <span className="shrink-0 text-xs text-muted-foreground" style={{ opacity: 0.7 }}>
          {formatRelativeTime(frameUpdatedAt(frame, props.snapshotUpdatedAt))}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          fill="currentColor"
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>

      {expanded ? (
        <div className="space-y-3 px-4 pb-3 pl-12 sm:px-6 sm:pl-14">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {frame.summary ?? judgmentLine(frame, "queued")}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{riskLabel(frame)}</span>
            <span>updated {formatRelativeTime(frameUpdatedAt(frame, props.snapshotUpdatedAt))}</span>
            {itemHref(frame, props.companyPrefix) ? (
              <a
                href={itemHref(frame, props.companyPrefix)!}
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                View in Paperclip
              </a>
            ) : null}
          </div>
          <FrameActions
            frame={frame}
            lane="queued"
            pendingId={props.pendingId}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onRequestRevision={props.onRequestRevision}
            onAcknowledge={props.onAcknowledge}
            onDismiss={props.onDismiss}
          />
        </div>
      ) : null}
    </div>
  );
}

function NextLane(props: {
  rows: DisplayFrame[];
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
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
            snapshotUpdatedAt={props.snapshotUpdatedAt}
            companyPrefix={props.companyPrefix}
            pendingId={props.pendingId}
            onApprove={props.onApprove}
            onReject={props.onReject}
            onRequestRevision={props.onRequestRevision}
            onAcknowledge={props.onAcknowledge}
            onDismiss={props.onDismiss}
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
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
  pendingId: string | null;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
}) {
  const { frame, snapshotUpdatedAt } = props;
  const [expanded, setExpanded] = useState(false);
  const href = itemHref(frame, props.companyPrefix);

  return (
    <div style={{ borderBottomWidth: 1, borderBottomColor: "var(--border)", opacity: 0.7 }} className="last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/50 sm:px-6"
      >
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{renderTitle(frame)}</span>
        <span className="shrink-0 text-xs text-muted-foreground" style={{ opacity: 0.6 }}>{sourceLabel(frame)}</span>
        <span className="shrink-0 text-xs text-muted-foreground" style={{ opacity: 0.5 }}>
          {formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}
        </span>
        <svg
          viewBox="0 0 16 16"
          className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          fill="currentColor"
          style={{ opacity: 0.4 }}
        >
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
        </svg>
      </button>

      {expanded ? (
        <div className="flex items-center gap-3 px-4 pb-3 sm:px-6">
          {href ? (
            <a
              href={href}
              className="text-xs font-medium underline underline-offset-2 text-muted-foreground hover:text-foreground"
            >
              View in Paperclip
            </a>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <ActionButton
              label={props.pendingId === frame.id ? "Saving\u2026" : "Acknowledge"}
              tone="secondary"
              disabled={props.pendingId === frame.id}
              onClick={() => void props.onAcknowledge(frame)}
            />
            <ActionButton
              label="Dismiss"
              tone="secondary"
              disabled={props.pendingId === frame.id}
              onClick={() => void props.onDismiss(frame)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AmbientLane(props: {
  rows: DisplayFrame[];
  snapshotUpdatedAt: string;
  companyPrefix: string | null | undefined;
  pendingId: string | null;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
}) {
  return (
    <section style={{ borderWidth: 1, borderColor: "var(--border)", opacity: 0.85 }} className="bg-card">
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
            snapshotUpdatedAt={props.snapshotUpdatedAt}
            companyPrefix={props.companyPrefix}
            pendingId={props.pendingId}
            onAcknowledge={props.onAcknowledge}
            onDismiss={props.onDismiss}
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
  const summaryQuery = usePluginData<AttentionSnapshot>("attention-summary", { companyId });
  const approvalsQuery = usePendingApprovals(companyId);
  useAttentionPolling(companyId, [summaryQuery.refresh, approvalsQuery.refresh]);
  const merged = useMemo(
    () => companyId ? mergeSnapshotWithApprovals(summaryQuery.data, companyId, approvalsQuery.data) : null,
    [summaryQuery.data, approvalsQuery.data, companyId],
  );
  const loading = summaryQuery.loading || approvalsQuery.loading;
  const error = summaryQuery.error ?? approvalsQuery.error;
  const data = merged;

  if (!companyId) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Open a company to see {brand.wordmark}.</div>;
  if (loading) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">{brand.loadingLabel}</div>;
  if (error) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Plugin error: {error.message}</div>;
  if (!data) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">{brand.headingEmptyState}</div>;

  const posture = postureForSnapshot(data);

  return (
    <div className="border border-border bg-card px-4 py-2.5 shadow-sm">
      <div className="flex items-start gap-2 text-xs">
        <Accent className="pt-0.5 text-sm">{posture.glyph}</Accent>
        <div className="min-w-0">
          <div className="flex items-end gap-2">
            <Accent className="font-semibold tracking-[0.04em]">{brand.wordmark}</Accent>
            <Accent className="text-[11px]">{posture.label}</Accent>
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
  const summaryQuery = usePluginData<AttentionSnapshot>("attention-summary", { companyId });
  const approvalsQuery = usePendingApprovals(companyId);
  useAttentionPolling(companyId, [summaryQuery.refresh, approvalsQuery.refresh]);
  const merged = useMemo(
    () => companyId ? mergeSnapshotWithApprovals(summaryQuery.data, companyId, approvalsQuery.data) : null,
    [summaryQuery.data, approvalsQuery.data, companyId],
  );
  const actionable = merged ? actionableCount(merged) : 0;

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
      {actionable > 0 ? (
        <span className="inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs leading-none font-medium text-white" style={ACCENT_BG_STYLE}>
          {actionable}
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
  const summaryQuery = usePluginData<AttentionSnapshot>("attention-summary", { companyId });
  const approvalsQuery = usePendingApprovals(companyId);
  useAttentionPolling(companyId, [summaryQuery.refresh, approvalsQuery.refresh]);
  const snapshot = useMemo(
    () => companyId ? mergeSnapshotWithApprovals(summaryQuery.data, companyId, approvalsQuery.data) : null,
    [summaryQuery.data, approvalsQuery.data, companyId],
  );
  const loading = summaryQuery.loading || approvalsQuery.loading;
  const error = summaryQuery.error ?? approvalsQuery.error;
  const refresh = summaryQuery.refresh;
  const acknowledge = usePluginAction("acknowledge-frame");
  const dismiss = usePluginAction("dismiss-frame");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);

  useEffect(() => {
    if (!statusOverride) return;

    const timer = window.setTimeout(() => {
      setStatusOverride(null);
    }, 4000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [statusOverride]);

  const posture = useMemo(() => (snapshot ? postureForSnapshot(snapshot) : null), [snapshot]);
  const nextRows = useMemo(
    () => (snapshot ? snapshot.queued.map((frame) => ({ frame, lane: "queued" as const })) : []),
    [snapshot],
  );
  const ambientRows = useMemo(
    () => (snapshot ? snapshot.ambient.map((frame) => ({ frame, lane: "ambient" as const })) : []),
    [snapshot],
  );

  function nudgeRefresh() {
    refresh();
    approvalsQuery.refresh();
    window.setTimeout(() => refresh(), 500);
    window.setTimeout(() => approvalsQuery.refresh(), 500);
  }

  async function acknowledgeFrame(frame: StoredAttentionFrame) {
    setPendingId(frame.id);
    try {
      await acknowledge({ companyId, taskId: frame.taskId, interactionId: frame.interactionId });
      setStatusOverride(`Acknowledged ${compactTitle(frame)}.`);
      nudgeRefresh();
    } catch (actionError) {
      setStatusOverride(actionError instanceof Error ? actionError.message : "Failed to acknowledge frame.");
    } finally {
      setPendingId(null);
    }
  }

  async function dismissFrame(frame: StoredAttentionFrame) {
    setPendingId(frame.id);
    try {
      await dismiss({ companyId, taskId: frame.taskId, interactionId: frame.interactionId });
      setStatusOverride(`Dismissed ${compactTitle(frame)}.`);
      nudgeRefresh();
    } catch (actionError) {
      setStatusOverride(actionError instanceof Error ? actionError.message : "Failed to dismiss frame.");
    } finally {
      setPendingId(null);
    }
  }

  async function submitApprovalDecision(frame: StoredAttentionFrame, decision: "approve" | "reject") {
    const approvalId = approvalIdForFrame(frame);
    if (!approvalId) {
      setStatusOverride("This frame is not backed by a Paperclip approval.");
      return;
    }

    setPendingId(frame.id);
    try {
      const actionPath = decision === "approve" ? "approve" : "reject";
      const response = await window.fetch(`/api/approvals/${approvalId}/${actionPath}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(`Approval ${actionPath} failed (${response.status}).`);
      }

      setStatusOverride(`${decision === "approve" ? "Approved" : "Rejected"} ${compactTitle(frame)}.`);
      nudgeRefresh();
    } catch (actionError) {
      setStatusOverride(actionError instanceof Error ? actionError.message : "Failed to submit approval decision.");
    } finally {
      setPendingId(null);
    }
  }

  async function requestApprovalRevision(frame: StoredAttentionFrame) {
    const approvalId = approvalIdForFrame(frame);
    if (!approvalId) {
      setStatusOverride("This frame is not backed by a Paperclip approval.");
      return;
    }

    setPendingId(frame.id);
    try {
      const response = await window.fetch(`/api/approvals/${approvalId}/request-revision`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(`Approval request-revision failed (${response.status}).`);
      }

      setStatusOverride(`Requested revision for ${compactTitle(frame)}.`);
      nudgeRefresh();
    } catch (actionError) {
      setStatusOverride(actionError instanceof Error ? actionError.message : "Failed to request approval revision.");
    } finally {
      setPendingId(null);
    }
  }

  if (!companyId) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Select a company to open {brand.wordmark}.</div>;
  if (!snapshot && loading) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Loading attention center{"\u2026"}</div>;
  if (!snapshot && error) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Plugin error: {error.message}</div>;
  if (!snapshot || !posture) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">No {brand.key === "focus" ? "focus" : "attention"} state has been captured for this company yet.</div>;

  return (
    <div className="space-y-5">
      <NowPane
        snapshot={snapshot}
        posture={posture}
        brand={brand}
        companyPrefix={props.context.companyPrefix}
        counts={snapshot.counts}
        pendingId={pendingId}
        onApprove={(frame) => submitApprovalDecision(frame, "approve")}
        onReject={(frame) => submitApprovalDecision(frame, "reject")}
        onRequestRevision={requestApprovalRevision}
        onAcknowledge={acknowledgeFrame}
        onDismiss={dismissFrame}
      />

      <NextLane
        rows={nextRows}
        snapshotUpdatedAt={snapshot.updatedAt}
        companyPrefix={props.context.companyPrefix}
        pendingId={pendingId}
        onApprove={(frame) => submitApprovalDecision(frame, "approve")}
        onReject={(frame) => submitApprovalDecision(frame, "reject")}
        onRequestRevision={requestApprovalRevision}
        onAcknowledge={acknowledgeFrame}
        onDismiss={dismissFrame}
      />

      <AmbientLane
        rows={ambientRows}
        snapshotUpdatedAt={snapshot.updatedAt}
        companyPrefix={props.context.companyPrefix}
        pendingId={pendingId}
        onAcknowledge={acknowledgeFrame}
        onDismiss={dismissFrame}
      />
    </div>
  );
}
