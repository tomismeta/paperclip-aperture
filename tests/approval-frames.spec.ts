import { describe, expect, it } from "vitest";
import {
  actionableApprovalRecords,
  approvalRecordToFrame,
  mergeSnapshotWithApprovals,
  type ApprovalRecord,
} from "../src/aperture/approval-frames.js";
import { createEmptyReviewState, createEmptySnapshot, type StoredAttentionFrame } from "../src/aperture/types.js";

function createApprovalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "approve_ceo_strategy",
    status: "pending",
    payload: {
      title: "Approve launch window",
      summary: "A decision is needed before work can continue.",
    },
    createdAt: "2026-03-19T09:00:00.000Z",
    updatedAt: "2026-03-19T10:00:00.000Z",
    ...overrides,
  };
}

function createNonApprovalFrame(): StoredAttentionFrame {
  return {
    id: "issue:1:2026-03-19T09:30:00.000Z",
    taskId: "issue:1",
    interactionId: "issue:1:blocked",
    source: {
      id: "paperclip:issue",
      kind: "paperclip",
      label: "Paperclip issue",
    },
    version: 1,
    mode: "status",
    tone: "focused",
    consequence: "medium",
    title: "CAM-9 rollout blocked",
    summary: "Waiting on clarification.",
    timing: {
      createdAt: "2026-03-19T09:00:00.000Z",
      updatedAt: "2026-03-19T09:30:00.000Z",
    },
    metadata: {},
  };
}

describe("approval-frames", () => {
  it("keeps only actionable approvals and sorts budget overrides first", () => {
    const records = actionableApprovalRecords([
      createApprovalRecord({ id: "approval-ignored", status: "approved" }),
      createApprovalRecord({ id: "approval-revision", status: "revision_requested", updatedAt: "2026-03-19T10:01:00.000Z" }),
      createApprovalRecord({ id: "approval-budget", type: "budget_override_required", updatedAt: "2026-03-19T09:59:00.000Z" }),
    ]);

    expect(records.map((record) => record.id)).toEqual(["approval-budget", "approval-revision"]);
  });

  it("maps approval records into approval frames with response actions", () => {
    const frame = approvalRecordToFrame(createApprovalRecord({
      type: "budget_override_required",
      payload: {
        requestedAmount: "$500",
        reason: "Investigation budget exceeded the original estimate.",
      },
    }));

    expect(frame.mode).toBe("approval");
    expect(frame.responseSpec?.kind).toBe("approval");
    expect(frame.consequence).toBe("high");
    expect(frame.context?.items?.find((item) => item.id === "requested-amount")?.value).toBe("$500");
    expect(frame.metadata?.attention).toEqual({
      rationale: ["budget stop", "approval", "operator decision"],
    });
    expect(frame.metadata?.semantic).toEqual({
      confidence: "high",
    });
  });

  it("merges fetched approvals into the shared attention model without dropping non-approval frames", () => {
    const snapshot = {
      ...createEmptySnapshot("company-1"),
      updatedAt: "2026-03-19T10:00:00.000Z",
      active: createNonApprovalFrame(),
      counts: {
        active: 1,
        queued: 0,
        ambient: 0,
        total: 1,
      },
    };

    const merged = mergeSnapshotWithApprovals(
      snapshot,
      "company-1",
      [createApprovalRecord({ id: "approval-2", updatedAt: "2026-03-19T10:05:00.000Z" })],
      createEmptyReviewState("company-1"),
    );

    expect(merged.active?.taskId).toBe("approval:approval-2");
    expect(merged.queued.map((frame) => frame.taskId)).toContain("issue:1");
  });
});
