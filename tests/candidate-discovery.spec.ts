import type { Agent, Issue, IssueThreadInteraction } from "@paperclipai/plugin-sdk/types";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { loadReconciledCandidates } from "../src/aperture/reconciliation.js";
import {
  createEmptyLedger, createEmptyReviewState, createEmptySnapshot,
  type AttentionDisplayPayload, type AttentionExport, type AttentionOverlayDiagnostics, type AttentionSnapshot,
} from "../src/aperture/types.js";
import { registerDataHandlers } from "../src/handlers/data.js";
import { registerEventHandlers } from "../src/handlers/events.js";
import { registerActionHandlers } from "../src/handlers/actions.js";
import { ATTENTION_STATE_KEY } from "../src/handlers/shared.js";

const companyId = "company-discovery";
const timestamp = "2026-10-22T10:00:00.000Z";

function issue(id = "issue-1", overrides: Partial<Issue> = {}): Issue {
  return {
    id, companyId, projectId: null, projectWorkspaceId: null, goalId: null, parentId: null,
    title: `Work ${id}`, description: null, status: "in_progress", workMode: "standard",
    reviewPolicy: null, priority: "medium", assigneeAgentId: "agent-1", assigneeUserId: null,
    checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    createdByAgentId: null, createdByUserId: null, responsibleUserId: null,
    issueNumber: 1, identifier: null, requestDepth: 0, billingCode: null,
    assigneeAdapterOverrides: null, executionWorkspaceId: null, executionWorkspacePreference: null,
    executionWorkspaceSettings: null, startedAt: null, completedAt: null, cancelledAt: null,
    hiddenAt: null, createdAt: new Date(timestamp), updatedAt: new Date(timestamp), ...overrides,
  };
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, companyId, name: `Agent ${id}`, urlKey: id, role: "engineer", title: null, icon: null,
    status: "idle", reportsTo: null, capabilities: null, adapterType: "process", adapterConfig: {},
    runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, pauseReason: null, pausedAt: null,
    permissions: { canCreateAgents: false }, metadata: null, lastHeartbeatAt: null,
    createdAt: new Date(timestamp), updatedAt: new Date(timestamp), ...overrides,
  };
}

function confirmation(id = "decision-1", issueId = "issue-1"): IssueThreadInteraction {
  return {
    id, issueId, companyId, kind: "request_confirmation", status: "pending",
    payload: { version: 1, prompt: `Confirm ${id}?` }, continuationPolicy: "none",
    resolverPolicy: "anyone", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdAt: timestamp, updatedAt: timestamp,
  };
}

function recovery(): NonNullable<Issue["activeRecoveryAction"]> {
  return {
    id: "recovery-1", companyId, sourceIssueId: "issue-1", recoveryIssueId: null,
    kind: "missing_disposition", status: "active", ownerType: "board", ownerAgentId: null,
    ownerUserId: null, previousOwnerAgentId: null, returnOwnerAgentId: null,
    cause: "Run finished without a disposition.", fingerprint: "recovery", evidence: {},
    nextAction: "Decide how to resume.", wakePolicy: null, monitorPolicy: null,
    attemptCount: 1, maxAttempts: 3, timeoutAt: null, lastAttemptAt: null, outcome: null,
    resolutionNote: null, resolvedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
}

function watchdog(): NonNullable<Issue["watchdog"]> {
  return {
    id: "watchdog-1", companyId, issueId: "issue-1", watchdogAgentId: "agent-watchdog",
    instructions: "Review the recent run.", status: "active", watchdogIssueId: null,
    lastObservedFingerprint: "current", lastReviewedFingerprint: "prior",
    lastTriggeredAt: new Date(timestamp), lastCompletedAt: null, triggerCount: 1,
    createdAt: new Date(timestamp), updatedAt: new Date(timestamp),
  };
}

function blockedInbox(): NonNullable<Issue["blockedInboxAttention"]> {
  return {
    kind: "blocked", state: "awaiting_decision", reason: "pending_board_decision", severity: "high",
    stoppedSinceAt: timestamp, owner: { type: "board", agentId: null, userId: null, label: "Board" },
    action: { label: "Confirm the decision", detail: "A human decision is required." },
    sourceIssue: null, leafIssue: null, recoveryIssue: null, approvalId: null,
    interactionId: "decision-1", sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
  };
}

function scheduledRetry(): NonNullable<Issue["scheduledRetry"]> {
  return {
    runId: "retry-1", retryOfRunId: "failed-1", agentId: "agent-1", agentName: "Atlas",
    status: "scheduled_retry", scheduledRetryAt: "2026-10-22T10:02:00.000Z",
    scheduledRetryAttempt: 2, scheduledRetryReason: "Host scheduled another attempt.",
  };
}

function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config });
  const store = new ApertureCompanyStore();
  store.hydrate(companyId, {
    ledger: createEmptyLedger(), snapshot: createEmptySnapshot(companyId), review: createEmptyReviewState(companyId),
  });
  registerDataHandlers(harness.ctx, store);
  registerActionHandlers(harness.ctx, store);
  registerEventHandlers(harness.ctx, store, () => config);
  return {
    ...harness, store,
    display: () => harness.getData<AttentionDisplayPayload>("attention-display", { companyId }),
    candidates: (freshHostData = false) => loadReconciledCandidates(harness.ctx, store, companyId, config, { freshHostData }),
  };
}

function frames(snapshot: AttentionSnapshot) {
  return [...(snapshot.now ? [snapshot.now] : []), ...snapshot.next, ...snapshot.ambient];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function failRun(harness: TestHarness, runId = "failed-1") {
  await harness.emit("agent.run.failed", { runId, agentId: "agent-1", issueId: "issue-1", error: "Run failed." }, {
    companyId, entityType: "heartbeat_run", entityId: runId, occurredAt: timestamp,
  });
}

afterEach(() => vi.useRealTimers());

describe("complete Paperclip candidate discovery", () => {
  it("discovers 200 issues and agents, including late agents and sibling confirmations", async () => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({
      issues: Array.from({ length: 200 }, (_, index) => issue(`issue-${index}`)),
      agents: Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`, index === 150 ? { status: "error" } : {})),
      issueInteractions: [confirmation("first", "issue-150"), confirmation("second", "issue-150")],
    });
    const agentReads = vi.spyOn(harness.ctx.agents, "list");
    const comments = vi.spyOn(harness.ctx.issues, "listComments");
    const candidates = await harness.candidates();

    expect(agentReads.mock.calls.map(([params]) => params.offset)).toEqual([0, 100, 200]);
    expect(candidates.map(({ frame }) => frame.taskId)).toEqual(["agent:agent-150", "interaction:first", "interaction:second"]);
    expect(harness.store.getCachedHostValue<Issue[]>(companyId, "issues:all")).toHaveLength(200);
    expect(harness.store.getCachedHostValue<Agent[]>(companyId, "agents:all")).toHaveLength(200);
    expect(comments).not.toHaveBeenCalled();
    await harness.candidates();
    expect(agentReads).toHaveBeenCalledTimes(3);
  });

  it("retains idle agents beyond page one for explicit request-owner resolution", async () => {
    const harness = setup();
    harness.seed({
      issues: [issue("issue-1", { status: "blocked", description: "Needed from Founding Engineer: clarify the rollout." })],
      agents: Array.from({ length: 101 }, (_, index) => agent(`agent-${index}`, index === 100 ? { name: "Founding Engineer" } : {})),
    });
    const candidates = await harness.candidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].frame.metadata?.issueIntelligence).toMatchObject({ owner: "Founding Engineer", ownerKind: "agent" });
  });

  it("advances by raw page length and preserves first occurrence order across partial overlaps", async () => {
    const harness = setup();
    const agents = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
    const pages = [agents.slice(0, 100), [agent("agent-99", { name: "Overlapping newer value" }), ...agents.slice(100, 199)], agents.slice(199)];
    const reads = vi.spyOn(harness.ctx.agents, "list").mockImplementation(async ({ offset = 0 }) => pages[offset / 100] ?? []);
    await harness.candidates();
    expect(reads.mock.calls.map(([params]) => params.offset)).toEqual([0, 100, 200]);
    expect(harness.store.getCachedHostValue<Agent[]>(companyId, "agents:all")).toEqual(agents);
  });

  it("does not replace the previous complete cache when issue listing fails", async () => {
    const harness = setup();
    harness.seed({ issues: [issue()] });
    await harness.candidates();
    const previous = harness.store.getCachedHostValue(companyId, "issues:all");
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Issue listing unavailable"));
    await expect(harness.candidates(true)).rejects.toThrow("Issue listing unavailable");
    expect(harness.store.getCachedHostValue(companyId, "issues:all")).toEqual(previous);
  });

  it("also rejects repeated agent pages and preserves a complete agent cache after a later-page error", async () => {
    const harness = setup();
    harness.seed({ agents: [agent("original")] });
    await harness.candidates();
    const previous = harness.store.getCachedHostValue(companyId, "agents:all");
    const page = Array.from({ length: 100 }, (_, index) => agent(`agent-${index}`));
    const reads = vi.spyOn(harness.ctx.agents, "list").mockResolvedValue(page);
    await expect(harness.candidates(true)).rejects.toThrow("Paperclip pagination did not advance.");
    expect(harness.store.getCachedHostValue(companyId, "agents:all")).toEqual(previous);
    reads.mockImplementation(async ({ offset }) => {
      if (offset) throw new Error("Later agent page unavailable");
      return page;
    });
    await expect(harness.candidates(true)).rejects.toThrow("Later agent page unavailable");
    expect(harness.store.getCachedHostValue(companyId, "agents:all")).toEqual(previous);
  });

  it("scans only visible open issues, with at most six concurrent interaction reads", async () => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [
      ...Array.from({ length: 12 }, (_, index) => issue(`open-${index}`)),
      issue("hidden", { hiddenAt: new Date(timestamp) }),
      issue("archived", { archivedAt: new Date(timestamp) }),
      issue("done", { status: "done" }), issue("cancelled", { status: "cancelled" }),
      issue("other-company", { companyId: "other-company" }),
    ] });
    const release = deferred<IssueThreadInteraction[]>();
    const started = deferred<void>();
    let active = 0;
    let maximum = 0;
    const reads = vi.spyOn(harness.ctx.issues, "listInteractions").mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active === 6) started.resolve();
      const result = await release.promise;
      active -= 1;
      return result;
    });
    const load = harness.candidates();
    await started.promise;
    expect(reads).toHaveBeenCalledTimes(6);
    release.resolve([]);
    await load;
    expect(maximum).toBe(6);
    expect(reads.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 12 }, (_, index) => `open-${index}`));
  });

  it("expires interaction reads after fifteen seconds even without a host event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [issue()] });
    const reads = vi.spyOn(harness.ctx.issues, "listInteractions").mockResolvedValue([confirmation()]);
    expect(await harness.candidates()).toHaveLength(1);
    reads.mockResolvedValue([{ ...confirmation(), status: "expired" }]);
    vi.advanceTimersByTime(14_999);
    expect(await harness.candidates()).toHaveLength(1);
    expect(reads).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await harness.candidates()).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("surfaces existing recovery and watchdog policy on ordinary running issues without enriching unrelated work", async () => {
    const harness = setup();
    harness.seed({ issues: [
      issue("recovery", { activeRecoveryAction: recovery() }),
      issue("watchdog", { watchdog: watchdog() }),
      issue("blocked-inbox", { blockedInboxAttention: blockedInbox() }),
      issue("ordinary"),
    ] });
    const comments = vi.spyOn(harness.ctx.issues, "listComments");
    const candidates = await harness.candidates();
    expect(candidates.map(({ frame }) => frame.taskId)).toEqual(["issue:recovery", "issue:watchdog", "issue:blocked-inbox"]);
    expect(comments.mock.calls.map(([id]) => id)).toEqual(["recovery", "watchdog", "blocked-inbox"]);
  });

  it.each(["none", "recovery", "watchdog", "relation"] as const)("omits a duplicate aggregate only without independent %s pressure", async (independent) => {
    const harness = setup();
    harness.seed({ issues: [issue("issue-1", {
      blockedInboxAttention: blockedInbox(),
      ...(independent === "recovery" ? { activeRecoveryAction: recovery() } : {}),
      ...(independent === "watchdog" ? { watchdog: watchdog() } : {}),
    })], issueInteractions: [confirmation()] });
    if (independent === "relation") {
      vi.spyOn(harness.ctx.issues.relations, "get").mockResolvedValue({
        blockedBy: [{ id: "dependency", identifier: "DEP-1", title: "Dependency", status: "blocked", priority: "high", assigneeAgentId: null, assigneeUserId: null }],
        blocks: [],
      });
    }
    const candidates = await harness.candidates();
    expect(candidates.some(({ frame }) => frame.taskId === "interaction:decision-1")).toBe(true);
    expect(candidates.some(({ frame }) => frame.taskId === "issue:issue-1")).toBe(independent !== "none");
  });
});

describe("reconciled display truth and uncertainty", () => {
  it("keeps Core and native approvals with a warning on first-load failure, but fresh summary/export reject it", async () => {
    const harness = setup();
    await failRun(harness);
    harness.seed({ approvals: [{
      id: "approval-1", companyId, type: "approve_ceo_strategy", status: "pending", payload: { title: "Launch approval" },
      requestedByAgentId: null, requestedByUserId: null, decisionNote: null, decidedByUserId: null, decidedAt: null,
      createdAt: new Date(timestamp), updatedAt: new Date(timestamp),
    }] });
    const reads = vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Issue listing unavailable"));
    const display = await harness.display();
    expect(display.reconciliationSyncError).toBe("Issue listing unavailable");
    expect(frames(display.snapshot).map((frame) => frame.taskId)).toEqual(expect.arrayContaining(["run:failed-1", "approval:approval-1"]));
    await expect(harness.getData("attention-summary", { companyId })).rejects.toThrow("Issue listing unavailable");
    await expect(harness.getData("attention-export", { companyId })).rejects.toThrow("Issue listing unavailable");
    reads.mockResolvedValue([]);
    expect((await harness.display()).reconciliationSyncError).toBeUndefined();
    const summary = await harness.getData<AttentionSnapshot>("attention-summary", { companyId });
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(summary.companyId).toBe(companyId);
    expect(exported.reconciledSnapshot.companyId).toBe(companyId);
    expect(exported.displaySnapshot.companyId).toBe(companyId);
  });

  it.each(["issues", "approvals"] as const)("reports %s uncertainty in overlay diagnostics while retaining last-good decisions", async (domain) => {
    const harness = setup();
    harness.seed({ issues: [issue()], issueInteractions: [confirmation()] });
    await harness.display();
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    harness.store.invalidateApprovals(companyId);
    const reads = domain === "issues"
      ? vi.spyOn(harness.ctx.issues, "list")
      : vi.spyOn(harness.ctx.approvals, "list");
    reads.mockRejectedValue(new Error("Host synchronization unavailable"));
    const errorKey = domain === "issues" ? "reconciliationSyncError" : "approvalSyncError";
    const diagnostics = await harness.getData<AttentionOverlayDiagnostics>("attention-overlay-diagnostics", { companyId });
    expect(diagnostics[errorKey]).toBe("Host synchronization unavailable");
    expect(diagnostics.frames.some(frame => frame.taskId === "interaction:decision-1")).toBe(true);
    reads.mockRestore();
    const recovered = await harness.getData<AttentionOverlayDiagnostics>("attention-overlay-diagnostics", { companyId });
    expect(recovered[errorKey]).toBeUndefined();
    expect(recovered.frames.some(frame => frame.taskId === "interaction:decision-1")).toBe(true);
  });

  it("retains the complete last-good interaction set through listing failure and clears terminal cards only on success", async () => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [issue()], issueInteractions: [confirmation("first"), confirmation("second")] });
    const initial = await harness.display();
    expect(initial.snapshot.counts.total).toBe(2);
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all", "issue:"] });
    const reads = vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Issue listing unavailable"));
    const stale = await harness.display();
    expect(stale.reconciliationSyncError).toBe("Issue listing unavailable");
    expect(frames(stale.snapshot).map((frame) => frame.taskId)).toEqual(frames(initial.snapshot).map((frame) => frame.taskId));
    expect(stale.snapshot.counts.total).toBe(2);
    expect(stale.snapshot.review?.unread.total).toBe(2);
    await expect(harness.getData("attention-export", { companyId })).rejects.toThrow("Issue listing unavailable");
    reads.mockResolvedValue([issue()]);
    vi.spyOn(harness.ctx.issues, "listInteractions").mockResolvedValue([
      { ...confirmation("first"), status: "accepted" }, { ...confirmation("second"), status: "expired" },
    ]);
    const recovered = await harness.display();
    expect(recovered.reconciliationSyncError).toBeUndefined();
    expect(recovered.snapshot.counts.total).toBe(0);
    expect(harness.store.getLastGoodReconciledCandidates(companyId)).toEqual([]);
  });

  it("does not publish a partial interaction set when one issue read fails", async () => {
    const harness = setup();
    harness.seed({
      issues: [issue("issue-1"), issue("issue-2")],
      issueInteractions: [confirmation("first", "issue-1"), confirmation("second", "issue-2")],
    });
    await harness.display();
    harness.store.invalidateHostCache(companyId, { prefixes: ["issue:"] });
    vi.spyOn(harness.ctx.issues, "listInteractions").mockImplementation(async (id) => {
      if (id === "issue-2") throw new Error("Second issue interaction read failed");
      return [confirmation("replacement", "issue-1")];
    });
    const display = await harness.display();
    expect(display.reconciliationSyncError).toBe("Second issue interaction read failed");
    expect(frames(display.snapshot).map((frame) => frame.taskId)).toEqual(["interaction:first", "interaction:second"]);
    expect(harness.store.getLastGoodReconciledCandidates(companyId)?.map(({ frame }) => frame.taskId))
      .toEqual(["interaction:first", "interaction:second"]);
  });

  it("filters stale aggregate candidates when issue capture is disabled but keeps native decisions", async () => {
    const config: Record<string, unknown> = {};
    const harness = setup(config);
    harness.seed({ issues: [issue("issue-1", { status: "blocked" })], issueInteractions: [confirmation()] });
    expect((await harness.display()).snapshot.counts.total).toBe(2);
    config.captureIssueLifecycle = false;
    harness.setConfig(config);
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Temporarily unavailable"));
    const display = await harness.display();
    expect(frames(display.snapshot).map((frame) => frame.taskId)).toEqual(["interaction:decision-1"]);
  });

  it("never lets an invalidated candidate load overwrite newer last-good decisions", async () => {
    const harness = setup();
    harness.seed({ issues: [issue()], issueInteractions: [confirmation("original")] });
    await harness.display();
    const started = deferred<void>();
    const release = deferred<IssueThreadInteraction[]>();
    const interactions = vi.spyOn(harness.ctx.issues, "listInteractions").mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issue:"] });
    const staleLoad = harness.display();
    await started.promise;
    interactions.mockResolvedValue([confirmation("current")]);
    harness.store.invalidateHostCache(companyId, { prefixes: ["issue:"] });
    await harness.display();
    release.resolve([confirmation("obsolete")]);
    const staleDisplay = await staleLoad;
    expect(frames(staleDisplay.snapshot).map((frame) => frame.taskId)).toEqual(["interaction:current"]);
    expect(staleDisplay.reconciliationSyncError).toBeDefined();
    expect((await harness.display()).reconciliationSyncError).toBeUndefined();
    expect(harness.store.getLastGoodReconciledCandidates(companyId)?.map(({ frame }) => frame.taskId)).toEqual(["interaction:current"]);
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Offline"));
    expect(frames((await harness.display()).snapshot).map((frame) => frame.taskId)).toEqual(["interaction:current"]);
  });

  it("rejects an invalidated fresh export rather than claiming stale host truth", async () => {
    const harness = setup();
    harness.seed({ issues: [issue()], issueInteractions: [confirmation("current")] });
    const started = deferred<void>();
    const release = deferred<IssueThreadInteraction[]>();
    vi.spyOn(harness.ctx.issues, "listInteractions").mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    const rejected = expect(harness.getData("attention-export", { companyId }))
      .rejects.toThrow("Paperclip attention changed during synchronization.");
    await started.promise;
    harness.store.invalidateHostCache(companyId, { prefixes: ["issue:"] });
    release.resolve([confirmation("obsolete")]);
    await rejected;
    expect(frames((await harness.display()).snapshot).map(frame => frame.taskId)).toEqual(["interaction:current"]);
  });

  it("preserves the separate invocation-scope fallback without presenting a sync warning", async () => {
    const harness = setup();
    await failRun(harness);
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Read is not allowed to perform in this invocation scope"));
    const display = await harness.display();
    expect(display.reconciliationSyncError).toBeUndefined();
    expect(frames(display.snapshot).map((frame) => frame.taskId)).toEqual(["run:failed-1"]);
    expect((await harness.getData<AttentionSnapshot>("attention-summary", { companyId })).counts.total).toBe(1);
  });

  it.each(["cancelled", "exhausted", "disappeared"] as const)("restores canonical failed attention when retry is %s without changing execution history", async (state) => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [issue("issue-1", { scheduledRetry: scheduledRetry() })], agents: [agent("agent-error", { status: "error" })] });
    await failRun(harness);
    await failRun(harness, "older-failure");
    const canonical = harness.store.getSnapshot(companyId)!;
    const ledger = harness.store.getLedger(companyId);
    const downgraded = await harness.display();
    expect(downgraded.snapshot.ambient.map((frame) => frame.taskId)).toContain("run:failed-1");
    expect(downgraded.snapshot.ambient.some((frame) => frame.taskId === "run:older-failure")).toBe(false);
    expect(frames(downgraded.snapshot).some((frame) => frame.taskId === "agent:agent-error")).toBe(true);
    expect(harness.store.getSnapshot(companyId)).toEqual(canonical);
    expect(harness.store.getLedger(companyId)).toEqual(ledger);
    harness.seed({ issues: [issue("issue-1", { scheduledRetry: state === "disappeared" ? null : {
      ...scheduledRetry(), ...(state === "cancelled" ? { status: "cancelled" as const } : { retryExhaustedReason: "No more attempts" }),
    } })] });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    const restored = await harness.display();
    expect(restored.snapshot.ambient.some((frame) => frame.taskId === "run:failed-1")).toBe(false);
    expect(frames(restored.snapshot).some((frame) => frame.taskId === "run:failed-1")).toBe(true);
    expect(harness.store.getLedger(companyId)).toEqual(ledger);
  });

  it("does not downgrade a failed run from another company's returned issue or snapshot", async () => {
    const harness = setup({ captureIssueLifecycle: false });
    await failRun(harness);
    vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([issue("issue-1", { companyId: "other-company", scheduledRetry: scheduledRetry() })]);
    expect(await harness.candidates()).toEqual([]);
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    vi.mocked(harness.ctx.issues.list).mockResolvedValue([issue("issue-1", { scheduledRetry: scheduledRetry() })]);
    expect(await loadReconciledCandidates(harness.ctx, harness.store, companyId, {}, {
      snapshot: { ...harness.store.getSnapshot(companyId)!, companyId: "other-company" },
    })).toEqual([]);
  });

  it("never resurrects a durably retired run from last-good retry candidates after discovery fails", async () => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [issue("issue-1", { scheduledRetry: scheduledRetry() })], issueInteractions: [confirmation()] });
    await failRun(harness);
    const initial = await harness.display();
    expect(initial.snapshot.ambient.map((frame) => frame.taskId)).toContain("run:failed-1");
    await harness.emit("agent.run.finished", { runId: "failed-1", agentId: "agent-1", issueId: "issue-1" }, {
      companyId, entityType: "heartbeat_run", entityId: "failed-1", occurredAt: "2026-10-22T10:05:00.000Z",
    });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Host listing failed after retirement"));
    const display = await harness.display();
    expect(display.reconciliationSyncError).toBe("Host listing failed after retirement");
    expect(frames(display.snapshot).map((frame) => frame.taskId)).toEqual(["interaction:decision-1"]);
  });

  it("applies existing review suppression to last-good decisions and retry overlays", async () => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [issue("issue-1", { scheduledRetry: scheduledRetry() })], issueInteractions: [confirmation()] });
    await failRun(harness);
    await harness.display();
    harness.store.setReview(companyId, {
      ...createEmptyReviewState(companyId),
      frames: {
        "interaction:decision-1": { lastSeenAt: timestamp, suppressedAt: timestamp },
        "run:failed-1": { lastSeenAt: timestamp, suppressedAt: timestamp },
      },
    });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Offline after acknowledgement"));
    expect((await harness.display()).snapshot.counts.total).toBe(0);
  });

  it.each(["issue.updated", "activity.logged"] as const)("invalidates interaction discovery on %s without scoped RPCs or Core ingestion", async (eventType) => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({ issues: [issue()], issueInteractions: [confirmation()] });
    expect((await harness.display()).snapshot.counts.total).toBe(1);
    const interactions = vi.spyOn(harness.ctx.issues, "listInteractions").mockResolvedValue([{ ...confirmation(), status: "cancelled" }]);
    const issues = vi.spyOn(harness.ctx.issues, "list");
    const state = vi.spyOn(harness.ctx.state, "set");
    const streams = vi.spyOn(harness.ctx.streams, "emit");
    await harness.emit(eventType, eventType === "activity.logged"
      ? { entityType: "issue", entityId: "issue-1", action: "issue.thread_interaction_future_lifecycle" }
      : { status: "in_progress" }, {
      companyId, entityType: "issue", entityId: "issue-1", occurredAt: timestamp,
    });
    expect(interactions).not.toHaveBeenCalled();
    expect(issues).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(streams).not.toHaveBeenCalled();
    expect(harness.store.getLedger(companyId)).toEqual([]);
    expect((await harness.display()).snapshot.counts.total).toBe(0);
    expect(interactions).toHaveBeenCalledOnce();
    expect(issues).toHaveBeenCalledOnce();
  });
});

describe("worker-owned display focus engagement", () => {
  const start = Date.parse(timestamp);
  const blocked = (id = "held", overrides: Partial<Issue> = {}) => issue(id, {
    status: "blocked", title: `Blocked ${id}`, ...overrides,
  });
  const newer = () => blocked("newer", { updatedAt: new Date(start + 1_000) });
  const engage = (harness: TestHarness, frame: NonNullable<AttentionSnapshot["now"]>, durationMs = 45_000, scope = companyId) =>
    harness.performAction("engage-focus", {
      companyId: scope, taskId: frame.taskId, interactionId: frame.interactionId,
      durationMs, reason: durationMs === 20_000 ? "show_context" : "comment_compose",
    });
  const replaceIssues = (harness: TestHarness & { store: ApertureCompanyStore }, issues: Issue[]) => {
    harness.seed({ issues });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all", "issue:"] });
  };
  async function heldIssue(durationMs = 45_000) {
    const harness = setup();
    harness.seed({ issues: [blocked()] });
    const original = (await harness.display()).snapshot.now!;
    expect(original.taskId).toBe("issue:held");
    await engage(harness, original, durationMs);
    return { harness, original };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });

  it("holds the native medium issue through newer next candidates and the subsequent native approval merge", async () => {
    const { harness, original } = await heldIssue();
    vi.setSystemTime(start + 1_000);
    replaceIssues(harness, [blocked(), newer()]);
    harness.seed({ approvals: [{
      id: "queued-approval", companyId, type: "approve_ceo_strategy", status: "pending",
      requestedByAgentId: null, requestedByUserId: null, decisionNote: null,
      decidedByUserId: null, decidedAt: null,
      payload: { title: "Queued approval", summary: "A native decision" },
      createdAt: new Date(start + 2_000), updatedAt: new Date(start + 2_000),
    }] });
    harness.store.invalidateApprovals(companyId);
    const firstTab = await harness.display();
    const secondTab = await harness.display();
    expect(firstTab.snapshot.now?.taskId).toBe(original.taskId);
    expect(firstTab.snapshot.now?.interactionId).toBe(original.interactionId);
    expect(secondTab.snapshot).toEqual(firstTab.snapshot);
    expect(new Set(frames(firstTab.snapshot).map(frame => frame.taskId)))
      .toEqual(new Set(["issue:held", "approval:queued-approval", "issue:newer"]));
    expect(firstTab.snapshot.counts).toMatchObject({ now: 1, next: 2, ambient: 0, total: 3 });
    expect(firstTab.snapshot.review?.unread).toEqual({ now: 1, next: 2, ambient: 0, total: 3 });
    expect(harness.store.getLedger(companyId).every(entry => entry.kind === "signal")).toBe(true);
    expect(harness.store.getSnapshot(companyId)?.counts.total).toBe(0);
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId });
    expect(exported.displaySnapshot.now?.taskId).toBe(original.taskId);
    vi.setSystemTime(start + 45_000);
    const baseline = (await harness.display()).snapshot;
    expect(firstTab.snapshot.next.map(frame => frame.taskId))
      .toEqual(frames(baseline).filter(frame => frame.taskId !== original.taskId).map(frame => frame.taskId));
  });

  it.each([20_000, 45_000])("expires at exactly %i ms without renewal by repeated reads or host updates", async durationMs => {
    const { harness, original } = await heldIssue(durationMs);
    vi.setSystemTime(start + 1_000);
    replaceIssues(harness, [blocked(), newer()]);
    for (const elapsed of [1_000, 15_000, durationMs - 1]) {
      vi.setSystemTime(start + elapsed);
      expect((await harness.display()).snapshot.now?.taskId).toBe(original.taskId);
    }
    vi.setSystemTime(start + durationMs);
    const expired = await harness.display();
    expect(expired.snapshot.now?.taskId).toBe("issue:newer");
    expect(expired.snapshot.next.map(frame => frame.taskId)).toEqual(["issue:held"]);
    expect((await harness.display()).snapshot).toEqual(expired.snapshot);
  });

  it("uses the freshest frame for the held exact pair rather than a captured frame", async () => {
    const { harness, original } = await heldIssue();
    vi.setSystemTime(start + 2_000);
    replaceIssues(harness, [
      blocked("held", { title: "Updated operator request", updatedAt: new Date(start + 500) }),
      newer(),
    ]);
    const refreshed = (await harness.display()).snapshot.now!;
    expect(refreshed.taskId).toBe(original.taskId);
    expect(refreshed.interactionId).toBe(original.interactionId);
    expect(refreshed.id).not.toBe(original.id);
    expect(refreshed.title).toBe("Updated operator request");
    expect(frames((await harness.display()).snapshot).filter(frame => frame.taskId === original.taskId)).toHaveLength(1);
  });

  it.each(["wrong-interaction", "next", "missing"] as const)("rejects a %s engagement without recording signals or changing NOW", async target => {
    const harness = setup();
    harness.seed({ issues: [blocked(), newer()] });
    const initial = (await harness.display()).snapshot;
    const frame = target === "next" ? initial.next[0] : {
      ...initial.now!,
      ...(target === "wrong-interaction" ? { interactionId: "not-the-current-interaction" } : { taskId: "issue:missing" }),
    };
    const ledger = harness.store.getLedger(companyId);
    await expect(engage(harness, frame)).rejects.toThrow("Only the current Focus NOW interaction can be engaged.");
    expect(harness.store.getLedger(companyId)).toEqual(ledger);
    expect((await harness.display()).snapshot.now?.taskId).toBe("issue:newer");
  });

  it("does not share an accepted company hold with another company's display or action", async () => {
    const { harness, original } = await heldIssue();
    const otherCompany = "company-other-focus";
    harness.seed({ issues: [
      blocked(), newer(),
      blocked("other-held", { companyId: otherCompany }),
      blocked("other-newer", { companyId: otherCompany, updatedAt: new Date(start + 1_000) }),
    ] });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    const other = await harness.getData<AttentionDisplayPayload>("attention-display", { companyId: otherCompany });
    expect(other.snapshot.now?.taskId).toBe("issue:other-newer");
    await expect(engage(harness, original, 45_000, otherCompany))
      .rejects.toThrow("Only the current Focus NOW interaction can be engaged.");
    expect((await harness.display()).snapshot.now?.taskId).toBe(original.taskId);
  });

  it.each(["done", "cancelled", "hidden", "archived", "removed", "ambient", "replacement"] as const)(
    "invalidates the hold on successful %s truth and never transfers it to a returning pair",
    async change => {
      const { harness, original } = await heldIssue();
      const changed = blocked("held", {
        ...(change === "done" || change === "cancelled" ? { status: change } : {}),
        ...(change === "hidden" ? { hiddenAt: new Date(start + 1_000) } : {}),
        ...(change === "archived" ? { archivedAt: new Date(start + 1_000) } : {}),
        ...(change === "ambient" ? { workMode: "planning" } : {}),
        ...(change === "replacement" ? { status: "in_review" } : {}),
      });
      vi.setSystemTime(start + 1_000);
      // A complete list, including authoritative absence, rather than a partial failed page.
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue(change === "removed" ? [newer()] : [changed, newer()]);
      harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all", "issue:"] });
      const display = await harness.display();
      expect(display.snapshot.now?.taskId).toBe("issue:newer");
      if (change === "ambient") expect(display.snapshot.ambient.map(frame => frame.taskId)).toContain(original.taskId);
      else if (change !== "replacement") expect(frames(display.snapshot).map(frame => frame.taskId)).not.toContain(original.taskId);
      else expect(display.snapshot.next.find(frame => frame.taskId === original.taskId)?.interactionId).not.toBe(original.interactionId);
      vi.mocked(harness.ctx.issues.list).mockResolvedValue([blocked(), newer()]);
      harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all", "issue:"] });
      expect((await harness.display()).snapshot.now?.taskId).toBe("issue:newer");
    },
  );

  it("cannot resurrect an acknowledged held issue through last-good discovery fallback", async () => {
    const { harness, original } = await heldIssue();
    await harness.performAction("acknowledge-frame", { companyId, taskId: original.taskId, interactionId: original.interactionId });
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Offline after acknowledgement"));
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    const display = await harness.display();
    expect(display.reconciliationSyncError).toBe("Offline after acknowledgement");
    expect(frames(display.snapshot).map(frame => frame.taskId)).not.toContain(original.taskId);
  });

  it("retains the accepted pair during uncertain reads but respects newer terminal events", async () => {
    const { harness, original } = await heldIssue();
    replaceIssues(harness, [blocked(), newer()]);
    await harness.display();
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Host temporarily offline"));
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    const uncertain = await harness.display();
    expect(uncertain.reconciliationSyncError).toBe("Host temporarily offline");
    expect(uncertain.snapshot.now?.taskId).toBe(original.taskId);
    await harness.emit("issue.updated", { status: "done" }, {
      companyId, entityType: "issue", entityId: "held", occurredAt: new Date(start + 1_000).toISOString(),
    });
    const terminal = await harness.display();
    expect(terminal.reconciliationSyncError).toBe("Host temporarily offline");
    expect(terminal.snapshot.now?.taskId).toBe("issue:newer");
    expect(frames(terminal.snapshot).map(frame => frame.taskId)).not.toContain(original.taskId);
  });

  it("allows an explicitly NOW critical issue to interrupt without rescoring queued candidates", async () => {
    const { harness, original } = await heldIssue();
    replaceIssues(harness, [blocked(), newer(), blocked("urgent", { priority: "critical", updatedAt: new Date(start + 2_000) })]);
    const display = await harness.display();
    expect(display.snapshot.now?.taskId).toBe("issue:urgent");
    expect(display.snapshot.next.map(frame => frame.taskId)).toContain(original.taskId);
    expect(frames(display.snapshot)).toHaveLength(3);
  });

  it("never accepts a new hold when persistence fails", async () => {
    const harness = setup();
    harness.seed({ issues: [blocked()] });
    const original = (await harness.display()).snapshot.now!;
    const ledger = harness.store.getLedger(companyId);
    vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("Cannot persist engagement"));
    await expect(engage(harness, original)).rejects.toThrow("Cannot persist engagement");
    replaceIssues(harness, [blocked(), newer()]);
    expect((await harness.display()).snapshot.now?.taskId).toBe("issue:newer");
    expect(harness.store.getLedger(companyId)).toEqual(ledger);
  });

  it("preserves a previously accepted hold through an unrelated persistence rollback", async () => {
    const { harness, original } = await heldIssue();
    vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("Unrelated write failed"));
    await expect(harness.performAction("mark-attention-seen", { companyId, taskIds: ["issue:unrelated"] }))
      .rejects.toThrow("Unrelated write failed");
    replaceIssues(harness, [blocked(), newer()]);
    expect((await harness.display()).snapshot.now?.taskId).toBe(original.taskId);
    vi.setSystemTime(start + 45_000);
    expect((await harness.display()).snapshot.now?.taskId).toBe("issue:newer");
  });

  it("publishes a successful hold before releasing the company mutation queue", async () => {
    const harness = setup();
    harness.seed({ issues: [blocked()] });
    const original = (await harness.display()).snapshot.now!;
    const started = deferred<void>();
    const release = deferred<void>();
    const persist = harness.ctx.state.set.bind(harness.ctx.state);
    vi.spyOn(harness.ctx.state, "set").mockImplementationOnce(async (key, value) => {
      started.resolve();
      await release.promise;
      return persist(key, value);
    });
    const accepting = engage(harness, original);
    await started.promise;
    replaceIssues(harness, [blocked(), newer()]);
    const queued = harness.performAction("mark-attention-seen", { companyId, taskIds: ["issue:newer"] });
    release.resolve();
    await accepting;
    await queued;
    const display = await harness.display();
    expect(display.snapshot.now?.taskId).toBe(original.taskId);
    expect(display.snapshot.next.map(frame => frame.taskId)).toEqual(["issue:newer"]);
  });

  it("validates a queued engagement against the current NOW after an earlier mutation finishes", async () => {
    const harness = setup();
    harness.seed({ issues: [blocked()] });
    const original = (await harness.display()).snapshot.now!;
    const started = deferred<void>();
    const release = deferred<void>();
    const persist = harness.ctx.state.set.bind(harness.ctx.state);
    vi.spyOn(harness.ctx.state, "set").mockImplementationOnce(async (key, value) => {
      started.resolve();
      await release.promise;
      return persist(key, value);
    });
    const preceding = harness.performAction("mark-attention-seen", { companyId, taskIds: ["issue:unrelated"] });
    await started.promise;
    const late = expect(engage(harness, original)).rejects.toThrow("Only the current Focus NOW interaction can be engaged.");
    replaceIssues(harness, [blocked(), newer()]);
    release.resolve();
    await preceding;
    await late;
    expect((await harness.display()).snapshot.now?.taskId).toBe("issue:newer");
  });

  it("uses the current accepted hold when an older display read finishes", async () => {
    const harness = setup();
    harness.seed({ issues: [blocked()] });
    const original = (await harness.display()).snapshot.now!;
    const started = deferred<void>();
    const release = deferred<Issue[]>();
    const list = vi.spyOn(harness.ctx.issues, "list").mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    const oldRead = harness.display();
    await started.promise;
    list.mockResolvedValue([blocked()]);
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    await engage(harness, original);
    replaceIssues(harness, [blocked(), newer()]);
    list.mockResolvedValue([blocked(), newer()]);
    expect((await harness.display()).snapshot.now?.taskId).toBe(original.taskId);
    release.resolve([blocked(), newer()]);
    expect((await oldRead).snapshot.now?.taskId).toBe(original.taskId);
    vi.setSystemTime(start + 45_000);
    expect((await harness.display()).snapshot.now?.taskId).toBe("issue:newer");
  });

  it("honors genuine Core high-consequence preemption instead of restoring the previously engaged Core pair", async () => {
    const harness = setup();
    // Native approval discovery is unavailable, so existing Core approval truth remains visible.
    vi.spyOn(harness.ctx.approvals, "list").mockRejectedValue(new Error("Approval listing unavailable"));
    await harness.emit("approval.created", {
      type: "approve_ceo_strategy", title: "Strategy decision", summary: "Review strategy.",
    }, { companyId, entityType: "approval", entityId: "strategy", occurredAt: timestamp });
    const original = (await harness.display()).snapshot.now!;
    expect(original.taskId).toBe("approval:strategy");
    await engage(harness, original);
    vi.setSystemTime(start + 1_000);
    await harness.emit("approval.created", {
      type: "budget_override_required", title: "Budget stop", summary: "Execution needs a budget override.",
    }, { companyId, entityType: "approval", entityId: "budget", occurredAt: new Date().toISOString() });
    expect(harness.store.getSnapshot(companyId)?.now?.taskId).toBe("approval:budget");
    const display = await harness.display();
    expect(display.snapshot.now?.taskId).toBe("approval:budget");
    expect(display.snapshot.next.map(frame => frame.taskId)).toContain(original.taskId);
  });

  it.each(["approval", "interaction"] as const)("drops an engaged native %s after authoritative domain removal", async domain => {
    const harness = setup();
    if (domain === "interaction") {
      harness.seed({ issues: [issue()], issueInteractions: [confirmation()] });
    } else {
      harness.seed({ approvals: [{
        id: "decision-1", companyId, type: "approve_ceo_strategy", status: "pending",
        requestedByAgentId: null, requestedByUserId: null, decisionNote: null,
        decidedByUserId: null, decidedAt: null, payload: { title: "Native decision" },
        createdAt: new Date(start), updatedAt: new Date(start),
      }] });
    }
    const original = (await harness.display()).snapshot.now!;
    expect(original.taskId).toBe(`${domain}:decision-1`);
    await engage(harness, original);
    harness.seed({ issues: [newer()] });
    if (domain === "interaction") {
      vi.spyOn(harness.ctx.issues, "listInteractions").mockResolvedValue([]);
      harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all", "issue:"] });
    } else {
      vi.spyOn(harness.ctx.approvals, "list").mockResolvedValue([]);
      harness.store.invalidateApprovals(companyId);
      harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    }
    const display = await harness.display();
    expect(display.snapshot.now?.taskId).toBe("issue:newer");
    expect(frames(display.snapshot).map(frame => frame.taskId)).not.toContain(original.taskId);
  });

  it("does not revive an expired hold when a display read started before the deadline completes", async () => {
    const { harness } = await heldIssue();
    const started = deferred<void>();
    const release = deferred<Issue[]>();
    vi.spyOn(harness.ctx.issues, "list").mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    vi.setSystemTime(start + 44_999);
    const pending = harness.display();
    await started.promise;
    vi.setSystemTime(start + 45_000);
    release.resolve([blocked(), newer()]);
    expect((await pending).snapshot.now?.taskId).toBe("issue:newer");
  });

  it("does not reconstruct a display hold from persisted engagement signals after worker restart", async () => {
    const { harness, original } = await heldIssue();
    const descriptor = { scopeKind: "company" as const, scopeId: companyId, stateKey: ATTENTION_STATE_KEY };
    const persisted = harness.getState(descriptor);
    expect(persisted).toBeDefined();
    const restarted = createTestHarness({ manifest });
    await restarted.ctx.state.set(descriptor, persisted);
    restarted.seed({ issues: [blocked(), newer()] });
    registerDataHandlers(restarted.ctx, new ApertureCompanyStore());
    const display = await restarted.getData<AttentionDisplayPayload>("attention-display", { companyId });
    expect(display.snapshot.now?.taskId).toBe("issue:newer");
    expect(display.snapshot.next.map(frame => frame.taskId)).toContain(original.taskId);
  });

  it.each([
    ["accepted", "accepted"],
    ["rejected", "rejected"],
    ["withdrawn", "cancelled"],
  ] as const)("retires an engaged %s interaction from failed-read fallback without retiring its sibling", async (action, status) => {
    const harness = setup({ captureIssueLifecycle: false });
    harness.seed({
      issues: [issue()],
      issueInteractions: [
        confirmation("held-decision"),
        { ...confirmation("sibling-decision"), updatedAt: new Date(start - 1_000).toISOString() },
      ],
    });
    const original = (await harness.display()).snapshot.now!;
    expect(original.taskId).toBe("interaction:held-decision");
    await engage(harness, original);
    vi.spyOn(harness.ctx.issues, "list").mockRejectedValue(new Error("Host unavailable during decision resolution"));
    harness.store.invalidateHostCache(companyId, { prefixes: ["issues:all"] });
    expect((await harness.display()).snapshot.now?.taskId).toBe(original.taskId);
    await harness.emit("activity.logged", {
      action: `issue.thread_interaction_${action}`, entityType: "issue", entityId: "issue-1",
      details: { interactionId: "held-decision", interactionStatus: status },
    }, { companyId, entityType: "issue", entityId: "issue-1", occurredAt: new Date(start + 1_000).toISOString() });
    const display = await harness.display();
    expect(display.reconciliationSyncError).toBe("Host unavailable during decision resolution");
    expect(display.snapshot.now?.taskId).toBe("interaction:sibling-decision");
    expect(frames(display.snapshot).map(frame => frame.taskId)).toEqual(["interaction:sibling-decision"]);
    expect(display.snapshot.counts.total).toBe(1);
    expect(harness.store.getLedger(companyId).every(entry => entry.kind === "signal")).toBe(true);
  });
});
