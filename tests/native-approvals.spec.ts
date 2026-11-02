import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { requireHumanActionScope } from "../src/handlers/shared.js";
import type { AttentionExport, AttentionSnapshot, AttentionReviewState } from "../src/aperture/types.js";

type Approval = NonNullable<Awaited<ReturnType<PluginContext["approvals"]["get"]>>>;

const companyId = "native-approvals";
const human = { companyId, actor: { type: "user" as const, userId: "operator", companyId } };
const params = { companyId, taskId: "approval:approval-1", interactionId: "approval:approval-1:approval", decision: "approve" };

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1", companyId, type: "approve_ceo_strategy", status: "pending",
    requestedByAgentId: null, requestedByUserId: null, decisionNote: null,
    decidedByUserId: null, decidedAt: null,
    payload: { title: "Native approval", summary: "A redacted host decision" },
    createdAt: new Date("2026-10-01T10:00:00Z"), updatedAt: new Date("2026-10-01T10:01:00Z"),
    ...overrides,
  };
}

async function setup(records: Approval[] = [approval()], role = "owner") {
  const harness = createTestHarness({ manifest });
  harness.seed({ approvals: records, accessMembers: [{
    id: "member", companyId, principalType: "user", principalId: "operator", status: "active",
    membershipRole: role, grants: [], createdAt: new Date(), updatedAt: new Date(),
  }] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

type Display = { snapshot: AttentionSnapshot; approvalSyncError?: string };
const tasks = (snapshot: AttentionSnapshot) => [snapshot.now, ...snapshot.next, ...snapshot.ambient].filter(Boolean).map((frame) => frame?.taskId);

afterEach(() => vi.useRealTimers());

describe("native approval reads", () => {
  it("loads pending and revision-requested records without API configuration, isolated by company", async () => {
    const harness = await setup([approval(), approval({ id: "revision", status: "revision_requested" }), approval({ id: "foreign", companyId: "other" })]);
    const display = await harness.getData<Display>("attention-display", { companyId });
    expect(tasks(display.snapshot)).toEqual(expect.arrayContaining(["approval:approval-1", "approval:revision"]));
    expect(tasks(display.snapshot)).not.toContain("approval:foreign");
    expect(display.approvalSyncError).toBeUndefined();
    expect(display.snapshot.now?.timing?.createdAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("retains last-good cards on either list failure and clears uncertainty on retry", async () => {
    const harness = await setup();
    const initial = await harness.getData<Display>("attention-display", { companyId });
    const original = harness.ctx.approvals.list.bind(harness.ctx.approvals);
    const list = vi.spyOn(harness.ctx.approvals, "list").mockImplementation(async (input) => {
      if (input.status === "revision_requested") throw new Error("approval service unavailable");
      return [];
    });
    await harness.emit("approval.decided", {}, { companyId, entityType: "approval", entityId: "approval-1" });
    const failed = await harness.getData<Display>("attention-display", { companyId });
    expect(tasks(failed.snapshot)).toEqual(tasks(initial.snapshot));
    expect(failed.approvalSyncError).toContain("approval service unavailable");
    list.mockImplementation(original);
    const recovered = await harness.getData<Display>("attention-display", { companyId });
    expect(recovered.approvalSyncError).toBeUndefined();
    expect(tasks(recovered.snapshot)).toContain("approval:approval-1");
  });

  it("exposes first-load failure instead of silently caching successful emptiness", async () => {
    const harness = await setup();
    vi.spyOn(harness.ctx.approvals, "list").mockRejectedValueOnce(new Error("offline"));
    const failed = await harness.getData<Display>("attention-display", { companyId });
    expect(failed.approvalSyncError).toContain("offline");
    const recovered = await harness.getData<Display>("attention-display", { companyId });
    expect(tasks(recovered.snapshot)).toContain("approval:approval-1");
    expect(recovered.approvalSyncError).toBeUndefined();
  });

  it("expires approvals at fifteen seconds and treats empty native truth as authoritative", async () => {
    vi.useFakeTimers();
    const harness = await setup();
    await harness.getData<Display>("attention-display", { companyId });
    const list = vi.spyOn(harness.ctx.approvals, "list").mockResolvedValue([]);
    vi.setSystemTime(Date.now() + 14_999);
    expect(tasks((await harness.getData<Display>("attention-display", { companyId })).snapshot)).toContain("approval:approval-1");
    expect(list).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1);
    expect(tasks((await harness.getData<Display>("attention-display", { companyId })).snapshot)).not.toContain("approval:approval-1");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("prefers the later version when the two status reads overlap", async () => {
    const harness = await setup();
    vi.spyOn(harness.ctx.approvals, "list").mockImplementation(async ({ status }) => [approval({
      status: status === "pending" ? "pending" : "revision_requested",
      updatedAt: new Date(status === "pending" ? "2026-10-01T10:01:00Z" : "2026-10-01T11:00:00Z"),
      payload: { title: status === "pending" ? "Old title" : "Revised title" },
    })]);
    const display = await harness.getData<Display>("attention-display", { companyId });
    expect(tasks(display.snapshot)).toEqual(["approval:approval-1"]);
    expect(display.snapshot.now?.title).toBe("Revised title");
  });

  it("does not publish a paired read invalidated in flight, and retries the next read", async () => {
    const harness = await setup();
    await harness.getData<Display>("attention-display", { companyId });
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const list = vi.spyOn(harness.ctx.approvals, "list").mockImplementation(async () => {
      started();
      await pending;
      return [approval({ id: "stale" })];
    });
    await harness.emit("approval.decided", {}, { companyId, entityType: "approval", entityId: "approval-1" });
    const loading = harness.getData<Display>("attention-display", { companyId });
    await entered;
    await harness.emit("approval.decided", {}, { companyId, entityType: "approval", entityId: "approval-1" });
    release();
    const stale = await loading;
    expect(tasks(stale.snapshot)).toContain("approval:approval-1");
    expect(tasks(stale.snapshot)).not.toContain("approval:stale");
    expect(stale.approvalSyncError).toBeUndefined();
    list.mockResolvedValue([approval({ id: "fresh" })]);
    const fresh = await harness.getData<Display>("attention-display", { companyId });
    expect(tasks(fresh.snapshot)).toEqual(["approval:fresh"]);
  });

  it("shares one paired native load across concurrent display readers", async () => {
    const harness = await setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.spyOn(harness.ctx.approvals, "list").mockImplementation(async ({ status }) => {
      await pending;
      return status === "pending" ? [approval()] : [];
    });
    const first = harness.getData<Display>("attention-display", { companyId });
    const second = harness.getData<Display>("attention-display", { companyId });
    release();
    const displays = await Promise.all([first, second]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(displays.map((display) => tasks(display.snapshot))).toEqual([
      ["approval:approval-1"], ["approval:approval-1"],
    ]);
  });
});

describe("human approval decisions", () => {
  it("rejects a mismatched interaction without deciding or recording the approval", async () => {
    const harness = await setup();
    const before = await harness.getData<AttentionExport>("attention-export", { companyId });
    await expect(harness.performAction("record-approval-response", {
      ...params, interactionId: "approval:another-approval:approval",
    }, human)).rejects.toThrow("Approval target does not match the selected frame.");
    expect((await harness.ctx.approvals.get("approval-1", companyId))?.status).toBe("pending");
    const after = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(after.responseEntries).toEqual(before.responseEntries);
    expect(after.overlayResponseEntries).toEqual(before.overlayResponseEntries);
  });

  it.each(["approve", "reject"] as const)("attributes %s and converges without duplicate audit", async (decision) => {
    const harness = await setup();
    const input = { ...params, decision, actorUserId: "browser-forgery" };
    expect(await harness.performAction("record-approval-response", input, human)).toMatchObject({ ok: true, applied: true });
    const decided = await harness.ctx.approvals.get("approval-1", companyId);
    expect(decided?.decidedByUserId).toBe("operator");
    expect(decided?.status).toBe(decision === "approve" ? "approved" : "rejected");
    const before = await harness.getData<AttentionExport>("attention-export", { companyId });
    const telemetryCount = harness.telemetry.length;
    const activityCount = harness.activity.length;
    expect(await harness.performAction("record-approval-response", input, human)).toEqual({ ok: true, applied: false });
    const after = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(after.responseEntries).toEqual(before.responseEntries);
    expect(after.overlayResponseEntries).toEqual(before.overlayResponseEntries);
    expect(harness.telemetry).toHaveLength(telemetryCount);
    expect(harness.activity).toHaveLength(activityCount);
    expect(tasks((await harness.getData<Display>("attention-display", { companyId })).snapshot)).not.toContain(params.taskId);
  });

  it.each(["opposite", "conflict", "viewer", "network", "missing", "foreign", "malformed-get", "revision", "system"])("rejects %s without local audit or suppression", async (kind) => {
    const harness = await setup(kind === "opposite" ? [approval({ status: "rejected" })] : kind === "missing" ? [] : kind === "foreign" ? [approval({ companyId: "other" })] : [approval()], kind === "viewer" ? "viewer" : "owner");
    if (kind === "network") vi.spyOn(harness.ctx.approvals, "decide").mockRejectedValue(new Error("network unavailable"));
    if (kind === "conflict") vi.spyOn(harness.ctx.approvals, "decide").mockRejectedValue(Object.assign(new Error("Conflict"), { status: 409 }));
    if (kind === "malformed-get") vi.spyOn(harness.ctx.approvals, "get").mockResolvedValue(approval({ companyId: "other" }));
    const before = await harness.getData<AttentionExport>("attention-export", { companyId });
    const telemetryCount = harness.telemetry.length;
    const expected = kind === "opposite" || kind === "conflict" ? "This approval was already decided differently in Paperclip."
      : kind === "missing" || kind === "foreign" || kind === "malformed-get" ? "Approval not found in this company."
      : kind === "revision" ? "Approval decision must be approve or reject; request revisions in Paperclip."
      : kind === "system" ? "A signed-in human operator is required for this action."
      : kind === "network" ? "network unavailable" : undefined;
    const action = harness.performAction("record-approval-response", { ...params, decision: kind === "revision" ? "request-revision" : "approve" }, kind === "system" ? { companyId } : human);
    if (expected) await expect(action).rejects.toThrow(expected);
    else await expect(action).rejects.toThrow();
    const after = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(after.responseEntries).toEqual(before.responseEntries);
    expect(after.overlayResponseEntries).toEqual(before.overlayResponseEntries);
    expect(harness.telemetry).toHaveLength(telemetryCount);
    expect(harness.activity).toHaveLength(0);
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId });
    expect(review.frames[params.taskId]?.suppressedAt).toBeUndefined();
  });
});

describe("trusted human scope", () => {
  const context: PluginPerformActionContext = { companyId, actor: { type: "user", userId: "operator", companyId, agentId: null, runId: null } };
  it("ignores browser identity and accepts matching or unscoped human actor company", () => {
    expect(requireHumanActionScope({ companyId, actorUserId: "forged" }, context)).toEqual({ companyId, actorUserId: "operator" });
    expect(requireHumanActionScope({}, { ...context, actor: { ...context.actor, companyId: null } })).toEqual({ companyId, actorUserId: "operator" });
  });
  it("checks host scope, mismatches, then human identity in that order", () => {
    expect(() => requireHumanActionScope({}, { ...context, companyId: null })).toThrow("Host-authorized company scope is required.");
    expect(() => requireHumanActionScope({ companyId: "other" }, context)).toThrow("Company scope does not match the authenticated action.");
    expect(() => requireHumanActionScope({}, { ...context, actor: { ...context.actor, companyId: "other", type: "system" } })).toThrow("Company scope does not match the authenticated action.");
    for (const actor of [{ ...context.actor, type: "agent" as const }, { ...context.actor, type: "system" as const }, { ...context.actor, userId: "" }]) {
      expect(() => requireHumanActionScope({}, { ...context, actor })).toThrow("A signed-in human operator is required for this action.");
    }
  });
});
