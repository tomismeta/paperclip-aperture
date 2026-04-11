import {
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AttentionSnapshot,
  type StoredAttentionFrame,
} from "../aperture/types.js";
import {
  frameUpdatedAt,
  isBudgetOverride,
  type FrameLane,
} from "../aperture/frame-model.js";
import {
  GENERIC_QUEUED_JUDGMENT,
} from "../aperture/attention-language.js";
import {
  ACCENT_BG_STYLE,
  ACCENT_BORDER,
  ACCENT_COLOR,
  Accent,
  ActionButton,
  Badge,
  ExternalLinkIcon,
  MessageCard,
  PageLoadingState,
  QueueMovementBadge,
  QuietMark,
  StatusToast,
  UnreadDot,
  WidgetLoadingState,
  cn,
  useWideLayout,
} from "./chrome.js";
import {
  actionableCount,
  actionableLabel,
  currentSurfaceBrand,
  formatRelativeTime,
  pluginPagePath,
  postureForSnapshot,
  sourceLabel,
  type Posture,
  type QueueMovement,
  type SurfaceBrand,
  unreadCount,
  useAttentionModel,
  useQueueMovement,
} from "./focus-model.js";
import {
  approvalIdForFrame,
  budgetReason,
  compactTitle,
  costsHref,
  driverBadgeStyle,
  driverLabel,
  entityIdFromFrame,
  entityTypeFromFrame,
  impactLabel,
  isFrameUnreadInSnapshot,
  isIssueFrame,
  itemHref,
  judgmentLine,
  nextPrimaryText,
  primaryLinkLabel,
  recommendedMoveValue,
  renderTitle,
  requestDescriptor,
  requestedAmount,
  responseKind,
  supportingLine,
  activityHref,
  visibleContextItems,
  actionOwnerValue,
  blockingTargetValue,
} from "./frame-helpers.js";
import {
  ContextItems,
  ExplainabilityPanel,
  ExplainabilityStrip,
  InlineExplainability,
} from "./frame-explainability.js";
import { IssueCommentComposer } from "./issue-comment-composer.js";
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

const FOCUS_HOLD_CONTEXT_MS = 20_000;
const FOCUS_HOLD_COMPOSE_MS = 45_000;

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
      <ExplainabilityPanel frame={frame} lane="now" detailOnly />

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
  onEngageFocus: (frame: StoredAttentionFrame, reason: string, durationMs: number) => void;
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
              onClick={() => {
                props.onEngageFocus(props.frame, "comment_compose", FOCUS_HOLD_COMPOSE_MS);
                setCommentOpen(true);
              }}
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
  onEngageFocus: (frame: StoredAttentionFrame, reason: string, durationMs: number) => void;
  onApprove: (frame: StoredAttentionFrame) => Promise<void>;
  onReject: (frame: StoredAttentionFrame) => Promise<void>;
  onRequestRevision: (frame: StoredAttentionFrame) => Promise<void>;
  onAcknowledge: (frame: StoredAttentionFrame) => Promise<void>;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
}) {
  const frame = props.snapshot.now;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const wideLayout = useWideLayout(1120);
  const activeFrameId = frame?.id ?? null;
  const activeUnread = !!frame && (props.snapshot.review?.unread.now ?? 0) > 0;
  const itemLink = frame ? itemHref(frame, props.companyPrefix) : null;
  const recommendedMove = frame ? recommendedMoveValue(frame) : null;
  const helperLine = frame ? supportingLine(frame, "now") : null;
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
          <span className={props.counts.now > 0 ? "font-semibold" : ""}>
            now {props.counts.now > 0 ? <Accent>{props.counts.now}</Accent> : props.counts.now}
          </span>
          <span className={props.counts.next > 0 ? "font-semibold" : ""}>
            next {props.counts.next > 0 ? <Accent>{props.counts.next}</Accent> : props.counts.next}
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

                <InlineExplainability frame={frame} lane="now" preferLaneReason={!!helperLine} />

                <div className="flex items-center gap-4">
                  <Accent><button
                    type="button"
                    onClick={() => {
                      if (!detailsOpen) {
                        props.onEngageFocus(frame, "show_context", FOCUS_HOLD_CONTEXT_MS);
                      }
                      setDetailsOpen(!detailsOpen);
                    }}
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
                lane="now"
                wide={wideLayout}
                pendingId={props.pendingId}
                itemLink={itemLink}
                onEngageFocus={props.onEngageFocus}
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
  const detailText = judgmentLine(frame, "next");
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
          <ExplainabilityStrip frame={frame} lane="next" />
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
              lane="next"
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
  const leadingText = data.now ? (recommendedMoveValue(data.now) ?? data.now.title) : null;
  const actionable = actionableLabel(data);
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
            {actionable ? <Accent className="text-[11px]">{actionable}</Accent> : null}
          </div>
        </div>
        <span className="ml-auto tabular-nums text-muted-foreground">
          now {data.counts.now} · next {data.counts.next} · ambient {data.counts.ambient}
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
        {unread > 0 ? (
          <span
            className="absolute -right-1 -top-1 h-2 w-2 rounded-full"
            style={{ backgroundColor: ACCENT_COLOR }}
          />
        ) : null}
      </span>
      <span className="flex-1 truncate">{brand.wordmark}</span>
      {actionable > 0 ? (
        <span className="inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs leading-none font-medium text-white" style={ACCENT_BG_STYLE}>
          {actionable}
        </span>
      ) : unread > 0 ? (
          <span
            className="inline-flex items-center justify-center rounded-full border px-1.5 py-0.5 text-xs leading-none font-medium"
            style={{ color: ACCENT_COLOR, borderColor: ACCENT_BORDER, backgroundColor: "transparent" }}
          >
            {unread}
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
  const engageFocus = usePluginAction("engage-focus");
  const recordApprovalResponse = usePluginAction("record-approval-response");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const focusReleaseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!statusOverride) return;

    const timer = window.setTimeout(() => {
      setStatusOverride(null);
    }, 4000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [statusOverride]);

  useEffect(() => {
    return () => {
      if (focusReleaseTimerRef.current) {
        window.clearTimeout(focusReleaseTimerRef.current);
      }
    };
  }, []);

  const displaySnapshot = snapshot;
  const backgroundErrorMessage = displaySnapshot && error ? `Sync issue: ${error.message}` : null;
  const posture = useMemo(() => (displaySnapshot ? postureForSnapshot(displaySnapshot) : null), [displaySnapshot]);
  const nextRows = useMemo(
    () => (displaySnapshot ? displaySnapshot.next.map((frame) => ({ frame, lane: "next" as const })) : []),
    [displaySnapshot],
  );
  const ambientRows = useMemo(
    () => (displaySnapshot ? displaySnapshot.ambient.map((frame) => ({ frame, lane: "ambient" as const })) : []),
    [displaySnapshot],
  );
  const nextMovement = useQueueMovement(nextRows.map((row) => row.frame));

  async function holdNowFrame(frame: StoredAttentionFrame, reason: string, durationMs: number) {
    if (!companyId) return;
    if (displaySnapshot?.now?.interactionId !== frame.interactionId) return;

    try {
      await engageFocus({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        reason,
        durationMs,
      });
      model.refresh();
      if (focusReleaseTimerRef.current) {
        window.clearTimeout(focusReleaseTimerRef.current);
      }
      focusReleaseTimerRef.current = window.setTimeout(() => {
        model.refresh();
        focusReleaseTimerRef.current = null;
      }, durationMs + 150);
    } catch {
      // Keep this silent; failed focus hold should not interrupt operator work.
    }
  }

  async function acknowledgeFrame(frame: StoredAttentionFrame) {
    setPendingId(frame.id);
    try {
      await acknowledge({ companyId, taskId: frame.taskId, interactionId: frame.interactionId });
      setStatusOverride(acknowledgeSuccessMessage(compactTitle(frame)));
      model.refresh();
    } catch (actionError) {
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
      model.refresh();
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
    try {
      await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision,
      });

      setStatusOverride(approvalDecisionSuccessMessage(compactTitle(frame), decision));
      model.refresh();
    } catch (actionError) {
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
    try {
      await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision: "request-revision",
      });

      setStatusOverride(approvalRevisionSuccessMessage(compactTitle(frame)));
      model.refresh();
    } catch (actionError) {
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
        onEngageFocus={holdNowFrame}
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
