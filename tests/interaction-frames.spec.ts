import { describe, expect, it } from "vitest";
import type { IssueThreadInteraction } from "@paperclipai/plugin-sdk/types";
import { interactionRecordToCandidate, isInlineConfirmation } from "../src/aperture/interaction-frames.js";
import { readFocusMetadata, readPaperclipRunRecoveryMetadata } from "../src/aperture/contracts.js";
import { confirmation, interactionIssue } from "./fixtures/native-interactions.js";

const issue = interactionIssue();

describe("native interaction candidates", () => {
  it("keeps two decisions independent with stable identities and no synthetic Core request", () => {
    const first = interactionRecordToCandidate(issue, confirmation())!;
    const second = interactionRecordToCandidate(issue, confirmation({ id: "decision-2" }))!;
    expect(first.lane).toBe("next");
    expect(first.frame).toMatchObject({
      id: "paperclip-interaction:decision-1", taskId: "interaction:decision-1",
      interactionId: "interaction:decision-1:decision", mode: "choice", version: 1,
      title: "Proceed with the plan?", summary: "Proceed with the plan?", responseSpec: { kind: "none" },
      consequence: "medium", tone: "focused",
    });
    expect(second.frame.taskId).not.toBe(first.frame.taskId);
    expect(interactionRecordToCandidate(issue, confirmation({ updatedAt: new Date() }))?.frame.id).toBe(first.frame.id);
    expect(readFocusMetadata(first.frame)).toMatchObject({
      issueId: issue.id, paperclipInteractionId: "decision-1", interactionKind: "request_confirmation",
      interactionDecision: { inline: true, acceptLabel: "Confirm", rejectLabel: "Decline", rejectReasonLabel: "Reason" },
      decision: { owner: "paperclip_reconciliation", sourcePolicy: "interaction.pending" },
    });
  });

  it("uses authoritative labels and prompt while surfacing preparation and addressee", () => {
    const candidate = interactionRecordToCandidate(issue, confirmation({
      title: "Approve deployment", summary: "Production rollout", addresseeUserId: "operator",
      acceptanceBlocker: "workspace_sync_pending",
      payload: { version: 1, prompt: "Proceed?", acceptLabel: "Ship", rejectLabel: "Revise", rejectRequiresReason: true, rejectReasonLabel: "Changes needed" },
    }))!;
    expect(candidate.frame.title).toBe("Approve deployment");
    expect(candidate.frame.summary).toBe("Production rollout");
    expect(readFocusMetadata(candidate.frame).interactionDecision).toMatchObject({
      inline: true, acceptLabel: "Ship", rejectLabel: "Revise", rejectRequiresReason: true,
      rejectReasonLabel: "Changes needed", preparing: true, addresseeUserId: "operator",
    });
    expect(candidate.frame.context?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "Preparing approval…" }), expect.objectContaining({ value: "operator" }),
    ]));
  });

  it.each(["accepted", "rejected", "answered", "cancelled", "expired", "failed"] as const)("omits %s decisions", (status) => {
    expect(interactionRecordToCandidate(issue, confirmation({ status }))).toBeNull();
  });

  it("omits agent requests and foreign or mismatched targets", () => {
    for (const overrides of [{ addresseeAgentId: "agent" }, { companyId: "foreign" }, { issueId: "different" }]) {
      expect(interactionRecordToCandidate(issue, confirmation(overrides))).toBeNull();
    }
  });

  it.each([
    { kind: "ask_user_questions" }, { kind: "request_checkbox_confirmation" }, { kind: "suggest_tasks" },
    { kind: "request_item_verdicts" }, { kind: "connection_intent" }, { kind: "future-kind" },
    { effectiveResolverPolicy: "future-policy" }, { payload: null }, { payload: [] },
    { payload: { version: 2, prompt: "Proceed?" } }, { payload: { version: 1, prompt: " " } },
    { payload: { version: 1, prompt: "Proceed?", rejectRequiresReason: "yes" } },
    { payload: { version: 1, prompt: "Proceed?", unknownStructuredInput: {} } },
    ...["toolAction", "secretProposal", "connectionAuthorization", "target"].map((key) => ({
      payload: { version: 1, prompt: "Proceed?", [key]: { arguments: "SECRET_ARGUMENT", secret: "SECRET_VALUE" }, acceptLabel: "Misleading approve" },
    })),
  ])("hands off unsupported shape without exposing specialized payload: %j", (override) => {
    const interaction = { ...confirmation(), ...override } as unknown as IssueThreadInteraction;
    expect(isInlineConfirmation(interaction)).toBe(false);
    const candidate = interactionRecordToCandidate(issue, interaction)!;
    expect(candidate.frame.responseSpec).toEqual({ kind: "none" });
    expect(readFocusMetadata(candidate.frame).interactionDecision?.inline).toBe(false);
    expect(JSON.stringify(candidate)).not.toContain("SECRET_");
    expect(JSON.stringify(candidate)).not.toContain("Misleading approve");
  });

  it("normalizes Date/string timestamps and falls back safely for malformed dates and labels", () => {
    const candidate = interactionRecordToCandidate(issue, confirmation({
      title: " ", summary: " ", createdAt: "invalid", updatedAt: "invalid",
      payload: { version: 1, prompt: " ", acceptLabel: " " },
    }))!;
    expect(candidate.frame.title).toBe("Paperclip decision");
    expect(candidate.frame.summary).toBe("Respond in Paperclip.");
    expect(candidate.frame.timing).toEqual({ createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
    expect(interactionRecordToCandidate(issue, confirmation({ createdAt: "2026-10-01T12:00:00+02:00" }))?.frame.timing?.createdAt)
      .toBe("2026-10-01T10:00:00.000Z");
  });

  it("validates Focus decision metadata and fails closed for unknown resolver or malformed flags", () => {
    const frame = interactionRecordToCandidate(issue, confirmation())!.frame;
    const valid = readFocusMetadata(frame).interactionDecision!;
    for (const invalid of [{ effectiveResolverPolicy: "future-policy" }, { rejectRequiresReason: "yes" }, { addresseeUserId: 42 }]) {
      expect(readFocusMetadata({ ...frame, metadata: { ...frame.metadata, interactionDecision: { ...valid, ...invalid } } }).interactionDecision?.inline).toBe(false);
    }
    expect(readFocusMetadata({ ...frame, metadata: { issueId: 123, paperclipInteractionId: " ", interactionKind: null } }))
      .toMatchObject({ issueId: undefined, paperclipInteractionId: undefined, interactionKind: undefined });
  });
});

describe("validated scheduled-retry metadata", () => {
  const frame = interactionRecordToCandidate(issue, confirmation())!.frame;
  const valid = { successorRunId: "retry", status: "queued", attempt: 2, scheduledRetryAt: "2026-10-01T12:00:00+02:00" };
  it("normalizes valid retry context", () => {
    expect(readPaperclipRunRecoveryMetadata({ ...frame, metadata: { paperclipRunRecovery: valid } }))
      .toEqual({ ...valid, scheduledRetryAt: "2026-10-01T10:00:00.000Z" });
  });
  it.each([{ successorRunId: " " }, { status: "cancelled" }, { attempt: -1 }, { attempt: 0.5 }, { attempt: "2" }, { scheduledRetryAt: "invalid" }])("rejects malformed metadata %j", (invalid) => {
    expect(readPaperclipRunRecoveryMetadata({ ...frame, metadata: { paperclipRunRecovery: { ...valid, ...invalid } } })).toBeNull();
  });
});
