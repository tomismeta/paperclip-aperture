import type { ReactNode } from "react";
import {
  type AttentionSnapshot,
  type StoredAttentionFrame,
} from "../aperture/types.js";
import {
  frameUpdatedAt,
  isBudgetOverride,
  type FrameLane,
} from "../aperture/frame-model.js";
import { readFocusMetadata } from "../aperture/contracts.js";
import { ATTENTION_CONTEXT_IDS } from "../aperture/attention-context.js";
import { GENERIC_QUEUED_JUDGMENT, genericJudgmentLine } from "../aperture/attention-language.js";
import { issueBlocksTargetLine, issueNeedsActionFromLine } from "../aperture/issue-intelligence.js";
import { parseTaskId, taskEntityId, taskKind } from "../aperture/task-ref.js";
import {
  ACCENT_BG,
  ACCENT_BORDER,
  ACCENT_COLOR,
  Accent,
} from "./chrome.js";
import { sourceLabel } from "./focus-model.js";

function contextValue(frame: StoredAttentionFrame, id: string): string | undefined {
  const item = frame.context?.items?.find((entry) => entry.id === id);
  return typeof item?.value === "string" && item.value.trim().length > 0 ? item.value : undefined;
}

export function requestedAmount(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.requestedAmount);
}

export function budgetReason(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.budgetReason);
}

export function recommendedMoveValue(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.recommendedMove);
}

export function actionOwnerValue(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.needsActionFrom);
}

export function blockingTargetValue(frame: StoredAttentionFrame): string | undefined {
  return contextValue(frame, ATTENTION_CONTEXT_IDS.blocksTarget);
}

export function impactLabel(frame: StoredAttentionFrame): string {
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

export function driverLabel(frame: StoredAttentionFrame): string | null {
  if (isBudgetOverride(frame)) return "budget stop";

  const metadata = readFocusMetadata(frame);
  const issueStatus = metadata.issueStatus;
  if (typeof issueStatus === "string" && issueStatus.trim().length > 0) {
    return operatorDriverLabel(issueStatus);
  }

  const pauseReason = metadata.pauseReason;
  if (typeof pauseReason === "string" && pauseReason.trim().length > 0) {
    return operatorDriverLabel(pauseReason);
  }

  const agentStatus = metadata.agentStatus;
  if (typeof agentStatus === "string" && agentStatus.trim().length > 0) {
    return operatorDriverLabel(agentStatus);
  }

  return null;
}

export function driverBadgeStyle() {
  return {
    className: "border-transparent",
    style: { color: ACCENT_COLOR, backgroundColor: ACCENT_BG, borderColor: ACCENT_BORDER },
  };
}

export function requestDescriptor(frame: StoredAttentionFrame): string {
  const driver = driverLabel(frame);
  return driver ? `${sourceLabel(frame)} · ${driver}` : sourceLabel(frame);
}

export function judgmentLine(frame: StoredAttentionFrame, lane: FrameLane): string {
  if (frame.provenance?.whyNow) return frame.provenance.whyNow;
  return genericJudgmentLine(frame, lane);
}

export function nextPrimaryText(frame: StoredAttentionFrame): string | null {
  const recommendedMove = recommendedMoveValue(frame);
  if (recommendedMove) return recommendedMove;

  const summary = frame.summary?.trim();
  if (summary) return summary;

  const fallback = judgmentLine(frame, "next");
  return fallback === GENERIC_QUEUED_JUDGMENT ? null : fallback;
}

export function supportingLine(frame: StoredAttentionFrame, lane: FrameLane): string | null {
  const owner = actionOwnerValue(frame);
  const target = blockingTargetValue(frame);
  if (target && lane === "now" && entityTypeFromFrame(frame) === "issue" && driverLabel(frame) === "review required") {
    return issueBlocksTargetLine(target);
  }
  if (owner && lane === "now" && entityTypeFromFrame(frame) === "issue") {
    return issueNeedsActionFromLine(owner);
  }

  if (lane === "now") {
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

export function approvalIdForFrame(frame: StoredAttentionFrame): string | null {
  const taskRef = parseTaskId(frame.taskId);
  return taskRef?.kind === "approval" ? taskRef.id : null;
}

export function entityIdFromFrame(frame: StoredAttentionFrame): string | null {
  return taskEntityId(frame.taskId);
}

export function entityTypeFromFrame(frame: StoredAttentionFrame): string | null {
  return taskKind(frame.taskId);
}

export function itemHref(frame: StoredAttentionFrame, companyPrefix: string | null | undefined): string | null {
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

export function costsHref(companyPrefix: string | null | undefined): string | null {
  return companyPrefix ? `/${companyPrefix}/costs` : null;
}

export function activityHref(frame: StoredAttentionFrame, companyPrefix: string | null | undefined): string | null {
  if (!companyPrefix) return null;
  const metadata = readFocusMetadata(frame);
  return metadata.activityPath ? `/${companyPrefix}/${metadata.activityPath}` : null;
}

export function primaryLinkLabel(frame: StoredAttentionFrame): string {
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

export function responseKind(frame: StoredAttentionFrame, lane: FrameLane): "approval" | "acknowledge" | "none" {
  if (approvalIdForFrame(frame) && (frame.responseSpec?.kind === "approval" || frame.mode === "approval")) {
    return "approval";
  }

  if (lane !== "ambient" && (frame.responseSpec?.kind === "acknowledge" || frame.mode === "status")) {
    return "acknowledge";
  }

  return "none";
}

export function isFrameUnreadInSnapshot(frame: StoredAttentionFrame, snapshot: AttentionSnapshot): boolean {
  const seenAt = snapshot.review?.lastSeenAt;
  if (!seenAt) return true;
  return frameUpdatedAt(frame, snapshot.updatedAt).localeCompare(seenAt) > 0;
}

export function compactTitle(frame: StoredAttentionFrame): string {
  return frame.title.trim().length > 0 ? frame.title : "Untitled frame";
}

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

export function renderTitle(frame: StoredAttentionFrame): ReactNode {
  return <HighlightedTitle text={compactTitle(frame)} />;
}

export function visibleContextItems(frame: StoredAttentionFrame) {
  return (frame.context?.items ?? []).filter((item) => item.id !== ATTENTION_CONTEXT_IDS.recommendedMove);
}

export function isIssueFrame(frame: StoredAttentionFrame): boolean {
  return entityTypeFromFrame(frame) === "issue";
}
