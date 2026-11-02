import {
  approvalTypeItem,
  budgetReasonItem,
  decisionContextItem,
  humanizeToken,
  requestedAmountItem,
} from "./attention-context.js";
import { mergeStoredFrames } from "./frame-model.js";
import { approvalBlockingSummary, approvalBlockingWhyNow } from "./attention-language.js";
import { createInteractionId, createTaskId } from "./task-ref.js";
import { withFocusDecisionMetadata } from "./contracts.js";
import { createEmptySnapshot, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "./types.js";
export type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export function approvalTitle(record: ApprovalRecord): string {
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

export function isBudgetOverrideRecord(record: ApprovalRecord): boolean {
  return record.type === "budget_override_required";
}

export function actionableApprovalRecords(records: ApprovalRecord[] | null): ApprovalRecord[] {
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

export function approvalRecordToFrame(record: ApprovalRecord): StoredAttentionFrame {
  const taskId = createTaskId("approval", record.id);
  const payload = record.payload ?? {};
  const budgetOverride = isBudgetOverrideRecord(record);
  const requestedAmount = typeof payload.requestedAmount === "string" ? payload.requestedAmount : undefined;
  const reason = typeof payload.reason === "string" ? payload.reason : undefined;
  const decisionContext = typeof payload.decisionContext === "string" ? payload.decisionContext : undefined;
  const summary = typeof payload.summary === "string"
    ? payload.summary
    : approvalBlockingSummary(budgetOverride);
  const updatedAt = record.updatedAt ?? record.createdAt;
  const provenance = {
    whyNow: approvalBlockingWhyNow(budgetOverride),
    factors: budgetOverride
      ? ["budget stop", "approval", "operator decision"]
      : ["approval", "operator decision"],
  };

  return withFocusDecisionMetadata({
    id: `approval-bootstrap:${record.id}`,
    taskId,
    interactionId: createInteractionId(taskId, "approval"),
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
          ...approvalTypeItem(humanizeToken(record.type)),
        },
        ...(requestedAmount ? [requestedAmountItem(requestedAmount)] : []),
        ...(reason ? [budgetReasonItem(reason)] : []),
        ...(decisionContext ? [decisionContextItem(decisionContext)] : []),
      ],
    },
    responseSpec: {
      kind: "approval",
      actions: [
        { id: "approve", label: "Approve", kind: "approve", emphasis: "primary" },
        { id: "reject", label: "Reject", kind: "reject", emphasis: "danger" },
      ],
    },
    provenance,
    timing: {
      createdAt: record.createdAt,
      updatedAt,
    },
    metadata: {
      entityType: "approval",
      approvalStatus: record.status,
      approvalType: record.type,
      attention: {
        rationale: provenance.factors,
      },
      semantic: {
        confidence: "high",
      },
    },
  }, {
    owner: "approval_overlay",
    lane: "next",
    sourcePolicy: "pendingApprovals.displayOverlay",
    rationale: ["Pending approval fetched from Paperclip approvals adapter."],
  });
}

export function mergeSnapshotWithApprovals(
  snapshot: AttentionSnapshot | null,
  companyId: string,
  approvals: ApprovalRecord[] | null,
  review: AttentionReviewState | null,
): AttentionSnapshot {
  const base = snapshot ?? createEmptySnapshot(companyId);
  if (approvals === null) return mergeStoredFrames(base, companyId, [], review);

  const approvalFrames = actionableApprovalRecords(approvals).map(approvalRecordToFrame);
  const withoutApprovals = {
    ...base,
    now: base.now?.taskId.startsWith("approval:") ? null : base.now,
    next: base.next.filter((frame) => !frame.taskId.startsWith("approval:")),
    ambient: base.ambient.filter((frame) => !frame.taskId.startsWith("approval:")),
  };
  return mergeStoredFrames(withoutApprovals, companyId, approvalFrames.map((frame) => ({
    frame,
    lane: "next" as const,
  })), review);
}
