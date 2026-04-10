import {
  approvalTypeItem,
  budgetReasonItem,
  decisionContextItem,
  humanizeToken,
  requestedAmountItem,
} from "./attention-context.js";
import { mergeStoredFrames } from "./frame-model.js";
import { approvalBlockingSummary, approvalBlockingWhyNow } from "./attention-language.js";
import { createEmptySnapshot, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "./types.js";
import type { ApprovalRecord } from "../host/paperclip-approvals.js";
export type { ApprovalRecord } from "../host/paperclip-approvals.js";

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
        ...(budgetOverride
          ? [{ id: "request-revision", label: "Request revision", kind: "cancel" as const, emphasis: "secondary" as const }]
          : []),
      ],
    },
    provenance,
    timing: {
      createdAt: record.createdAt,
      updatedAt,
    },
    metadata: {
      approvalStatus: record.status,
      approvalType: record.type,
      attention: {
        rationale: provenance.factors,
      },
      semantic: {
        confidence: "high",
      },
    },
  };
}

export function mergeSnapshotWithApprovals(
  snapshot: AttentionSnapshot | null,
  companyId: string,
  approvals: ApprovalRecord[] | null,
  review: AttentionReviewState | null,
): AttentionSnapshot {
  const approvalFrames = actionableApprovalRecords(approvals).map(approvalRecordToFrame);
  const base = snapshot ?? createEmptySnapshot(companyId);
  const merged = mergeStoredFrames(base, companyId, [
    ...approvalFrames.map((frame, index) => ({ frame, lane: index === 0 ? "now" as const : "next" as const })),
  ], review);
  return merged;
}
