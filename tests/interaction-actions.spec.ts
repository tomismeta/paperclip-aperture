import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { IssueThreadInteraction } from "@paperclipai/plugin-sdk/types";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import type { AttentionExport, AttentionReviewState, AttentionSnapshot } from "../src/aperture/types.js";
import { ATTENTION_STATE_KEY } from "../src/handlers/shared.js";
import { confirmation, interactionCompanyId as companyId, interactionIssue } from "./fixtures/native-interactions.js";

const human = { companyId, actor: { type: "user" as const, userId: "operator", companyId } };
const params = { companyId, taskId: "interaction:decision-1", interactionId: "interaction:decision-1:decision", issueId: "issue-1", decision: "accept" };

async function setup(interactions: IssueThreadInteraction[] = [confirmation()], role = "owner") {
  const harness = createTestHarness({ manifest });
  harness.seed({ issues: [interactionIssue()], issueInteractions: interactions, accessMembers: [{
    id: "member", companyId, principalType: "user", principalId: "operator", status: "active",
    membershipRole: role, grants: [], createdAt: new Date(), updatedAt: new Date(),
  }] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("host-authoritative native decisions", () => {
  it("cannot acknowledge a pending native interaction outside Core", async () => {
    const harness = await setup();
    const before = await harness.getData<AttentionExport>("attention-export", { companyId });
    const frame = before.displaySnapshot.now!;
    expect(frame.taskId).toBe(params.taskId);
    expect(before.snapshot.now).toBeNull();
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId });

    await expect(harness.performAction("acknowledge-frame", {
      companyId, taskId: frame.taskId, interactionId: frame.interactionId,
    }, human)).rejects.toThrow();

    const after = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(after.ledger).toEqual(before.ledger);
    expect(after.displaySnapshot.now?.taskId).toBe(frame.taskId);
    expect(await harness.getData<AttentionReviewState>("attention-review", { companyId })).toEqual(review);
    expect((await harness.ctx.issues.listInteractions("issue-1", companyId))[0]?.status).toBe("pending");
  });

  it.each(["accept", "reject"] as const)("attributes %s and appends one display audit without answering the sibling or issue", async (decision) => {
    const harness = await setup([confirmation(), confirmation({ id: "decision-2" })]);
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    const input = { ...params, decision, reason: "  Please revise the scope.  ", actorUserId: "forged" };
    expect(await harness.performAction("respond-to-interaction", input, human)).toMatchObject({ ok: true, applied: true });
    expect(respond).toHaveBeenCalledWith("issue-1", "decision-1", {
      action: decision, actorUserId: "operator", ...(decision === "reject" ? { reason: "Please revise the scope." } : {}),
    }, companyId);
    const interactions = await harness.ctx.issues.listInteractions("issue-1", companyId);
    expect(interactions.find((entry) => entry.id === "decision-1")?.status).toBe(decision === "accept" ? "accepted" : "rejected");
    expect(interactions.find((entry) => entry.id === "decision-2")?.status).toBe("pending");
    expect((await harness.ctx.issues.get("issue-1", companyId))?.status).toBe("in_progress");
    const before = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(before.overlayResponseEntries).toHaveLength(1);
    expect(before.overlayResponseEntries[0]).toMatchObject({
      kind: "overlay-response", overlay: { kind: "display_overlay" },
      apertureResponse: { taskId: params.taskId, interactionId: params.interactionId, response: { kind: decision === "accept" ? "approved" : "rejected" } },
    });
    expect(before.responseEntries).toHaveLength(0);
    expect(await harness.performAction("respond-to-interaction", input, human)).toEqual({ ok: true, applied: false });
    expect(respond).toHaveBeenCalledTimes(1);
    expect((await harness.getData<AttentionExport>("attention-export", { companyId })).overlayResponseEntries).toEqual(before.overlayResponseEntries);
    const display = await harness.getData<{ snapshot: AttentionSnapshot }>("attention-display", { companyId });
    const tasks = [display.snapshot.now, ...display.snapshot.next, ...display.snapshot.ambient].map((frame) => frame?.taskId);
    expect(tasks).toContain("interaction:decision-2");
    expect(tasks).not.toContain(params.taskId);
  });

  it("requires a trimmed reason only for rejection and preserves host preparing semantics", async () => {
    const harness = await setup([confirmation({ acceptanceBlocker: "workspace_sync_pending", payload: { version: 1, prompt: "Proceed?", rejectRequiresReason: true } })]);
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    await expect(harness.performAction("respond-to-interaction", params, human)).rejects.toThrow("Paperclip is still preparing this approval.");
    await expect(harness.performAction("respond-to-interaction", { ...params, decision: "reject", reason: " " }, human)).rejects.toThrow("A reason is required to decline this decision.");
    expect(respond).not.toHaveBeenCalled();
    expect(await harness.performAction("respond-to-interaction", { ...params, decision: "reject", reason: "  Needs changes  " }, human)).toMatchObject({ applied: true });
    expect(respond).toHaveBeenCalledWith("issue-1", "decision-1", { action: "reject", actorUserId: "operator", reason: "Needs changes" }, companyId);
  });

  it("does not forward an unsupported optional decline reason", async () => {
    const harness = await setup([confirmation({ payload: { version: 1, prompt: "Proceed?", allowDeclineReason: false } })]);
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    await harness.performAction("respond-to-interaction", { ...params, decision: "reject", reason: "ignored" }, human);
    expect(respond).toHaveBeenCalledWith("issue-1", "decision-1", { action: "reject", actorUserId: "operator" }, companyId);
  });

  it.each([
    { addresseeUserId: "someone-else" },
    { effectiveResolverPolicy: "not_creator" as const, createdByUserId: "operator" },
    { addresseeAgentId: "agent-1" },
    { payload: { version: 1 as const, prompt: "Proceed?", target: { type: "issue_document" } } },
  ])("rejects a fresh eligibility change without a write or local suppression: %j", async (overrides) => {
    const harness = await setup();
    await harness.getData("attention-display", { companyId });
    vi.spyOn(harness.ctx.issues, "listInteractions").mockResolvedValue([{ ...confirmation(), ...overrides } as IssueThreadInteraction]);
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    await expect(harness.performAction("respond-to-interaction", params, human)).rejects.toThrow();
    expect(respond).not.toHaveBeenCalled();
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId });
    expect(review.frames[params.taskId]?.suppressedAt).toBeUndefined();
    expect((await harness.getData<AttentionExport>("attention-export", { companyId })).overlayResponseEntries).toHaveLength(0);
  });

  it.each(["system", "agent", "viewer", "wrong-task", "wrong-interaction", "wrong-issue", "foreign-issue", "foreign-interaction", "host-denial"])("rejects %s before local mutation", async (kind) => {
    const harness = await setup(undefined, kind === "viewer" ? "viewer" : "owner");
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    if (kind === "host-denial") respond.mockRejectedValue(new Error("host denied stale decision"));
    if (kind === "foreign-issue") vi.spyOn(harness.ctx.issues, "get").mockResolvedValue(interactionIssue({ companyId: "foreign" }));
    if (kind === "foreign-interaction") vi.spyOn(harness.ctx.issues, "listInteractions").mockResolvedValue([confirmation({ companyId: "foreign" })]);
    const actor = kind === "system" || kind === "agent" ? { ...human.actor, type: kind as "system" | "agent" } : human.actor;
    const input = { ...params,
      ...(kind === "wrong-task" ? { taskId: "issue:issue-1" } : {}),
      ...(kind === "wrong-interaction" ? { interactionId: "interaction:decision-2:decision" } : {}),
      ...(kind === "wrong-issue" ? { issueId: "missing" } : {}),
    };
    await expect(harness.performAction("respond-to-interaction", input, { companyId, actor })).rejects.toThrow();
    const after = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(after.overlayResponseEntries).toHaveLength(0);
    expect(after.responseEntries).toHaveLength(0);
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId });
    expect(review.frames[params.taskId]?.suppressedAt).toBeUndefined();
  });

  it("converges when host wins the race without recording the requested decision", async () => {
    const harness = await setup();
    const list = vi.spyOn(harness.ctx.issues, "listInteractions");
    vi.spyOn(harness.ctx.issues, "respondInteraction").mockResolvedValue({ interaction: confirmation({ status: "rejected" }), applied: false });
    expect(await harness.performAction("respond-to-interaction", params, human)).toEqual({ ok: true, applied: false });
    expect(list).toHaveBeenCalledTimes(2);
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(exported.overlayResponseEntries).toHaveLength(0);
    expect(exported.responseEntries).toHaveLength(0);
  });

  it.each(["accepted", "rejected", "answered", "cancelled", "expired", "failed"] as const)("converges from freshly read %s truth without another write", async (status) => {
    const harness = await setup([confirmation({ status })]);
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    expect(await harness.performAction("respond-to-interaction", params, human)).toEqual({ ok: true, applied: false });
    expect(respond).not.toHaveBeenCalled();
    expect((await harness.getData<AttentionExport>("attention-export", { companyId })).overlayResponseEntries).toHaveLength(0);
  });

  it.each([
    { interaction: confirmation({ status: "pending" }), applied: false },
    { interaction: confirmation({ status: "accepted", companyId: "foreign" }), applied: true },
    { interaction: confirmation({ status: "rejected" }), applied: true },
  ])("does not fabricate success from an inconsistent host result", async (result) => {
    const harness = await setup();
    vi.spyOn(harness.ctx.issues, "respondInteraction").mockResolvedValue(result);
    await expect(harness.performAction("respond-to-interaction", params, human)).rejects.toThrow("Paperclip did not confirm the requested interaction decision.");
    expect((await harness.getData<AttentionExport>("attention-export", { companyId })).overlayResponseEntries).toHaveLength(0);
  });

  it("rolls back failed persistence and retries from resolved host truth without another decision", async () => {
    const harness = await setup();
    await harness.getData("attention-display", { companyId });
    const before = harness.getState({ scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_STATE_KEY });
    const respond = vi.spyOn(harness.ctx.issues, "respondInteraction");
    vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("state persistence unavailable"));
    await expect(harness.performAction("respond-to-interaction", params, human)).rejects.toThrow("state persistence unavailable");
    expect(harness.getState({ scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_STATE_KEY })).toEqual(before);
    expect((await harness.ctx.issues.listInteractions("issue-1", companyId))[0]?.status).toBe("accepted");
    expect(await harness.performAction("respond-to-interaction", params, human)).toEqual({ ok: true, applied: false });
    expect(respond).toHaveBeenCalledTimes(1);
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(exported.overlayResponseEntries).toHaveLength(0);
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId });
    expect(review.frames[params.taskId]?.suppressedAt).toBeUndefined();
  });
});
