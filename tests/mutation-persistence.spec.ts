import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { createPersistedAttentionState, normalizePersistedAttentionState } from "../src/aperture/persisted-state.js";
import { createEmptyLedger, createEmptyReviewState, createEmptySnapshot, type AttentionReviewState, type AttentionSnapshot } from "../src/aperture/types.js";
import { registerActionHandlers } from "../src/handlers/actions.js";
import { registerDataHandlers } from "../src/handlers/data.js";
import { registerEventHandlers } from "../src/handlers/events.js";
import { ATTENTION_STATE_KEY } from "../src/handlers/shared.js";
import { interactionIssue } from "./fixtures/native-interactions.js";

const companyId = "mutation-durability";
const descriptor = { scopeKind: "company" as const, scopeId: companyId, stateKey: ATTENTION_STATE_KEY };
const persistedState = (harness: TestHarness) => normalizePersistedAttentionState(companyId, harness.getState(descriptor));
function setup(hydrate = true, config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  const store = new ApertureCompanyStore();
  if (hydrate) store.hydrate(companyId, { ledger: createEmptyLedger(), snapshot: createEmptySnapshot(companyId), review: createEmptyReviewState(companyId) });
  registerActionHandlers(harness.ctx, store);
  registerDataHandlers(harness.ctx, store);
  registerEventHandlers(harness.ctx, store, () => config);
  return { ...harness, store };
}
async function failRun(harness: TestHarness, runId: string) {
  await harness.emit("agent.run.failed", {
    runId, agentId: "agent-1", issueId: `issue-${runId}`, status: "failed", error: `Failure ${runId}`,
    finishedAt: "2026-10-22T10:00:00.000Z",
  }, { companyId, entityType: "heartbeat_run", entityId: runId, occurredAt: "2026-10-22T10:00:00.000Z" });
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const seen = (harness: TestHarness, taskId = "issue:unrelated") => harness.performAction("mark-attention-seen", { companyId, taskIds: [taskId] });

async function persistedRun() {
  const harness = setup();
  await failRun(harness, "durable");
  await harness.getData("attention-summary", { companyId });
  return persistedState(harness)!;
}

describe("queued mutation durability", () => {
  it("retains pending source events when a local action cannot persist", async () => {
    const harness = setup();
    await harness.ctx.state.set(descriptor, createPersistedAttentionState(companyId, harness.store.getPersistableState(companyId)!));
    await failRun(harness, "pending");
    vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("Persistence unavailable"));
    await expect(seen(harness)).rejects.toThrow("Persistence unavailable");
    expect(harness.store.getLedger(companyId).filter(entry => entry.kind === "event").map(entry => entry.apertureEvent.taskId)).toEqual(["run:pending"]);
    await harness.getData("attention-summary", { companyId });
    expect(persistedState(harness)?.ledger.some(entry => entry.kind === "event" && entry.apertureEvent.taskId === "run:pending")).toBe(true);
  });

  it.each(["success", "failure"] as const)("retains events arriving during a %s persistence attempt", async outcome => {
    const harness = setup();
    const started = deferred();
    const finish = deferred();
    const original = harness.ctx.state.set.bind(harness.ctx.state);
    vi.spyOn(harness.ctx.state, "set").mockImplementationOnce(async (key, value) => {
      started.resolve();
      await finish.promise;
      return original(key, value);
    });
    const action = seen(harness);
    const result = action.then(() => "success", () => "failure");
    await started.promise;
    await failRun(harness, "arrived-during-write");
    if (outcome === "success") finish.resolve(); else finish.reject(new Error("Persistence unavailable"));
    expect(await result).toBe(outcome);
    expect(harness.store.getLedger(companyId).some(entry => entry.kind === "event" && entry.apertureEvent.taskId === "run:arrived-during-write")).toBe(true);
    expect(harness.store.hasPendingPersistence(companyId)).toBe(true);
    await harness.getData("attention-summary", { companyId });
    expect(persistedState(harness)?.ledger.some(entry => entry.kind === "event" && entry.apertureEvent.taskId === "run:arrived-during-write")).toBe(true);
  });

  it("preserves both review markers from concurrent acknowledgements", async () => {
    const harness = setup();
    harness.seed({ issues: ["first", "second"].map((id, index) => interactionIssue({
      id, companyId, identifier: `ACK-${index + 1}`, status: "blocked", title: `Operator decision ${id}`,
    })) });
    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId });
    const frames = [...(snapshot.now ? [snapshot.now] : []), ...snapshot.next];
    expect(frames.map(frame => frame.taskId).sort()).toEqual(["issue:first", "issue:second"]);
    await Promise.all(frames.map(frame => harness.performAction("acknowledge-frame", { companyId, taskId: frame.taskId, interactionId: frame.interactionId })));
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId });
    expect(review.frames["issue:first"]?.suppressedAt).toBeDefined();
    expect(review.frames["issue:second"]?.suppressedAt).toBeDefined();
    expect((await harness.getData<AttentionSnapshot>("attention-summary", { companyId })).counts.total).toBe(0);
  });

  it.each(["event-before-read", "action-before-read"] as const)("preserves durable history after restart with %s", async arrival => {
    const persisted = await persistedRun();
    const harness = setup(false);
    await harness.ctx.state.set(descriptor, persisted);
    if (arrival === "event-before-read") await failRun(harness, "new");
    else await seen(harness);
    await harness.getData("attention-summary", { companyId });
    const tasks = harness.store.getLedger(companyId).filter(entry => entry.kind === "event").map(entry => entry.apertureEvent.taskId);
    expect(tasks).toContain("run:durable");
    if (arrival === "event-before-read") expect(tasks).toContain("run:new");
  });

  it("applies closure received before hydration without creating a capture-disabled issue card", async () => {
    const persisted = await persistedRun();
    const harness = setup(false, { captureIssueLifecycle: false });
    await harness.ctx.state.set(descriptor, persisted);
    await harness.emit("issue.updated", { status: "done" }, {
      companyId, entityType: "issue", entityId: "issue-durable", occurredAt: "2026-10-22T11:00:00.000Z",
    });
    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId });
    expect(snapshot.counts.total).toBe(0);
    expect(harness.store.getLedger(companyId).some(entry => entry.kind === "event"
      && entry.apertureEvent.taskId === "run:durable" && entry.apertureEvent.type === "task.cancelled")).toBe(true);
  });
});
