import {
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AttentionSnapshot, StoredAttentionFrame } from "../aperture/types.js";

type FrameLane = "active" | "queued" | "ambient";
type DisplayFrame = {
  frame: StoredAttentionFrame;
  lane: FrameLane;
};
type Posture = {
  glyph: "\u25CB" | "\u25D0" | "\u25CF";
  label: "calm" | "elevated" | "busy";
};

// Aperture brand accent — matches the TUI's ANSI 74 (#5FAFAF)
// Uses inline styles because the host Tailwind JIT won't scan plugin bundles
// for arbitrary values like text-[#5FAFAF].
const ACCENT_COLOR = "#5FAFAF";
const ACCENT_STYLE: React.CSSProperties = { color: ACCENT_COLOR };
const ACCENT_DIM_STYLE: React.CSSProperties = { color: ACCENT_COLOR, opacity: 0.6 };
const ACCENT_BG_STYLE: React.CSSProperties = { backgroundColor: ACCENT_COLOR };

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
    if (frame.mode === "approval") return "A human decision is blocking work right now.";
    if (frame.tone === "critical") return "This surfaced because it can displace the operator now.";
    return "This is the clearest current operator focus.";
  }

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
  const items = frame.context?.items?.slice(0, 2) ?? [];
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

function NowDetails(props: { frame: StoredAttentionFrame; snapshotUpdatedAt: string }) {
  const { frame, snapshotUpdatedAt } = props;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="border border-border bg-secondary/50 px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Why now</div>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">{judgmentLine(frame, "active")}</p>
      </div>

      <ContextItems frame={frame} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{sourceLabel(frame)}</span>
        <span className="capitalize">{modeLabel(frame)}</span>
        <span>{riskLabel(frame)}</span>
        <span>updated {formatRelativeTime(frameUpdatedAt(frame, snapshotUpdatedAt))}</span>
      </div>
    </div>
  );
}

function QuietNow() {
  return (
    <div className="py-2">
      <div className="text-sm text-muted-foreground">Nothing active right now.</div>
    </div>
  );
}

function NowPane(props: {
  snapshot: AttentionSnapshot;
  posture: Posture;
  companyPrefix: string | null | undefined;
  counts: AttentionSnapshot["counts"];
  statusLine: string;
  pendingId: string | null;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onDismiss: (frame: StoredAttentionFrame) => Promise<void>;
}) {
  const frame = props.snapshot.active;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const prevFrameId = useRef(frame?.id);

  if (frame?.id !== prevFrameId.current) {
    prevFrameId.current = frame?.id;
    if (detailsOpen) setDetailsOpen(false);
  }

  return (
    <section className="border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="text-sm" style={ACCENT_STYLE}>{props.posture.glyph}</span>
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={ACCENT_STYLE}>Aperture</h2>
          <span className="text-xs" style={ACCENT_DIM_STYLE}>
            {props.posture.label}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
          <span style={props.counts.active > 0 ? ACCENT_STYLE : undefined}>now {props.counts.active}</span>
          <span style={props.counts.queued > 0 ? ACCENT_STYLE : undefined}>next {props.counts.queued}</span>
          <span>ambient {props.counts.ambient}</span>
        </div>
      </div>

      <div className="px-4 py-6 sm:px-6">
        {!frame ? (
          <QuietNow />
        ) : (
          <div className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Now</span>
                <span className="normal-case tracking-normal" style={{ opacity: 0.6 }}>{sourceLabel(frame)}</span>
              </div>
              <div className="text-lg font-semibold leading-snug text-foreground">{compactTitle(frame)}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge className={toneBadgeStyle(frame).className} style={toneBadgeStyle(frame).style}>{urgencyLabel(frame)}</Badge>
                <Badge className="border-border bg-secondary text-foreground/80">{riskLabel(frame)}</Badge>
                <Badge className="border-border bg-secondary text-muted-foreground">{modeLabel(frame)}</Badge>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {frame.summary ?? "Aperture surfaced this frame without additional summary text."}
              </p>
              {itemHref(frame, props.companyPrefix) ? (
                <a
                  href={itemHref(frame, props.companyPrefix)!}
                  className="inline-flex text-xs font-medium underline underline-offset-2 text-muted-foreground hover:text-foreground"
                >
                  View in Paperclip
                </a>
              ) : null}
            </div>

            <FrameActions
              frame={frame}
              lane="active"
              pendingId={props.pendingId}
              onApprove={props.onApprove}
              onReject={props.onReject}
              onAcknowledge={props.onAcknowledge}
              onDismiss={props.onDismiss}
            />

            <button
              type="button"
              onClick={() => setDetailsOpen(!detailsOpen)}
              className="flex items-center gap-1.5 text-xs font-medium transition-opacity hover:opacity-100"
              style={ACCENT_DIM_STYLE}
            >
              <svg
                viewBox="0 0 16 16"
                className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-90")}
                fill="currentColor"
              >
                <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
              {detailsOpen ? "Hide details" : "Show details"}
            </button>

            {detailsOpen ? (
              <NowDetails frame={frame} snapshotUpdatedAt={props.snapshot.updatedAt} />
            ) : null}
          </div>
        )}
      </div>

      {frame ? (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-6">
          {props.statusLine}
        </div>
      ) : null}
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
        <span className="w-5 shrink-0 text-xs font-medium tabular-nums" style={ACCENT_DIM_STYLE}>
          {String(props.rank).padStart(2, "0")}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {compactTitle(frame)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{sourceLabel(frame)}</span>
        <Badge className={cn("shrink-0", toneBadgeStyle(frame).className)} style={toneBadgeStyle(frame).style}>{urgencyLabel(frame)}</Badge>
        <span className="shrink-0 text-xs capitalize text-muted-foreground">{modeLabel(frame)}</span>
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
        <span className="text-xs text-muted-foreground" style={{ opacity: 0.5 }} aria-hidden="true">~</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{compactTitle(frame)}</span>
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
        <div className="flex items-center gap-3 px-4 pb-3 pl-10 sm:px-6 sm:pl-12">
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
  const summaryQuery = usePluginData<AttentionSnapshot>("attention-summary", { companyId });
  useAttentionPolling(companyId, [summaryQuery.refresh]);
  const { data, loading, error } = summaryQuery;

  if (!companyId) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Open a company to see Aperture attention.</div>;
  if (loading) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Loading Aperture{"\u2026"}</div>;
  if (error) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Plugin error: {error.message}</div>;
  if (!data) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">No attention state yet.</div>;

  const posture = postureForSnapshot(data);

  return (
    <div className="border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="text-sm" style={ACCENT_STYLE}>{posture.glyph}</span>
        <span className="font-semibold uppercase tracking-wider" style={ACCENT_STYLE}>Aperture</span>
        <span style={ACCENT_DIM_STYLE}>{posture.label}</span>
        <span className="ml-auto tabular-nums">
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
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  const summaryQuery = usePluginData<AttentionSnapshot>("attention-summary", { companyId });
  useAttentionPolling(companyId, [summaryQuery.refresh]);
  const actionable = summaryQuery.data ? actionableCount(summaryQuery.data) : 0;

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
          <path d="M5 12h6" />
          <path d="M9 8v8" />
          <circle cx="16.5" cy="8" r="3.5" />
          <path d="M14 16h5" />
          <path d="M14 19h4" />
        </svg>
      </span>
      <span className="flex-1 truncate">Aperture</span>
      {actionable > 0 ? (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold text-white" style={ACCENT_BG_STYLE}>
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
  const summaryQuery = usePluginData<AttentionSnapshot>("attention-summary", { companyId });
  useAttentionPolling(companyId, [summaryQuery.refresh]);
  const { data: snapshot, loading, error, refresh } = summaryQuery;
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
    window.setTimeout(() => refresh(), 500);
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
      const response = await window.fetch(`/api/approvals/${approvalId}/${decision}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error(`Approval ${decision} failed (${response.status}).`);
      }

      setStatusOverride(`${decision === "approve" ? "Approved" : "Rejected"} ${compactTitle(frame)}.`);
      nudgeRefresh();
    } catch (actionError) {
      setStatusOverride(actionError instanceof Error ? actionError.message : "Failed to submit approval decision.");
    } finally {
      setPendingId(null);
    }
  }

  const statusLine = useMemo(() => {
    if (statusOverride) return statusOverride;
    if (snapshot?.active) return `Focused on ${compactTitle(snapshot.active)}.`;
    if (nextRows[0]) return `Quiet now. ${compactTitle(nextRows[0].frame)} is next in line.`;
    if (ambientRows[0]) return "Quiet now. Ambient awareness remains available.";
    return "Quiet surface. Aperture is waiting for the next meaningful event.";
  }, [ambientRows, nextRows, snapshot?.active, statusOverride]);

  if (!companyId) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Select a company to open Aperture.</div>;
  if (loading) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Loading attention center{"\u2026"}</div>;
  if (error) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">Plugin error: {error.message}</div>;
  if (!snapshot || !posture) return <div className="border border-border bg-card p-4 shadow-sm text-sm text-muted-foreground">No attention state has been captured for this company yet.</div>;

  return (
    <div className="space-y-5">
      <NowPane
        snapshot={snapshot}
        posture={posture}
        companyPrefix={props.context.companyPrefix}
        counts={snapshot.counts}
        statusLine={statusLine}
        pendingId={pendingId}
        onApprove={(frame) => submitApprovalDecision(frame, "approve")}
        onReject={(frame) => submitApprovalDecision(frame, "reject")}
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
