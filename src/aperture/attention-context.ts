export type AttentionContextItem = {
  id: string;
  label: string;
  value: string;
};

export const ATTENTION_CONTEXT_IDS = {
  approvalType: "approval-type",
  requestedAmount: "requested-amount",
  budgetReason: "budget-reason",
  decisionContext: "decision-context",
  linkedIssues: "linked-issues",
  needsActionFrom: "needs-action-from",
  blocksTarget: "blocks-target",
  recommendedMove: "recommended-move",
  issueStatus: "issue-status",
  issuePriority: "issue-priority",
  latestComment: "latest-comment",
  agentStatus: "agent-status",
  pauseReason: "pause-reason",
  agentTitle: "agent-title",
} as const;

function item(id: string, label: string, value: string): AttentionContextItem {
  return { id, label, value };
}

export function humanizeToken(value: string): string {
  return value
    .split(/[_\-.]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function approvalTypeItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.approvalType, "Type", value);
}

export function requestedAmountItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.requestedAmount, "Requested amount", value);
}

export function budgetReasonItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.budgetReason, "Reason", value);
}

export function decisionContextItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.decisionContext, "Decision context", value);
}

export function linkedIssuesItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.linkedIssues, "Linked issues", value);
}

export function needsActionFromItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.needsActionFrom, "Needs action from", value);
}

export function blocksTargetItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.blocksTarget, "Blocks", value);
}

export function recommendedMoveItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.recommendedMove, "Recommended move", value);
}

export function issueStatusItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.issueStatus, "Status", value);
}

export function issuePriorityItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.issuePriority, "Priority", value);
}

export function latestCommentItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.latestComment, "Latest comment", value);
}

export function agentStatusItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.agentStatus, "Status", value);
}

export function pauseReasonItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.pauseReason, "Pause reason", value);
}

export function agentTitleItem(value: string): AttentionContextItem {
  return item(ATTENTION_CONTEXT_IDS.agentTitle, "Role", value);
}
