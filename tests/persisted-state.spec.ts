import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { ApertureCore, type SourceEvent } from "@tomismeta/aperture-core";
import { normalizeSourceEvent } from "@tomismeta/aperture-core/semantic";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { FOCUS_SURFACE_CAPABILITIES } from "../src/aperture/core-capabilities.js";
import { mapPluginEventToSourceEvent } from "../src/aperture/event-mapper.js";
import { mergeStoredFrames } from "../src/aperture/frame-model.js";
import { createTaskId } from "../src/aperture/task-ref.js";
import {
  ATTENTION_STATE_SCHEMA_VERSION,
  createPersistedAttentionState,
  normalizePersistedAttentionState,
  deriveReviewStateFromLedger,
  normalizeSplitAttentionState,
  type PersistedAttentionState,
  type PersistedAttentionStateEnvelope,
} from "../src/aperture/persisted-state.js";
import {
  createAttentionSnapshot,
  createEmptyLedger,
  createEmptyReviewState,
  createEmptySnapshot,
  type AttentionExport,
  type AttentionLedger,
  type AttentionLedgerEventEntry,
  type AttentionLedgerResponseEntry,
  type AttentionReplayScenario,
  type AttentionSnapshot,
  type AttentionReviewState,
  type SnapshotSource,
} from "../src/aperture/types.js";
import { registerDataHandlers } from "../src/handlers/data.js";
import {
  ATTENTION_STATE_KEY,
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_REVIEW_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
} from "../src/handlers/shared.js";
import manifest from "../src/manifest.js";

const COMPANY = "company-history";
const EPOCH = Date.parse("2026-10-22T12:00:00.000Z");
const at = (seconds: number) => new Date(EPOCH + seconds * 1000).toISOString();

function historicalEvent(id: string, source: SnapshotSource, event: SourceEvent): AttentionLedgerEventEntry {
  return { kind: "event", id, occurredAt: event.timestamp, source, sourceEvent: event, apertureEvent: normalizeSourceEvent(event) };
}

function historicalFailure(
  id: string,
  seconds: number,
  options: { taskId?: string; source?: SnapshotSource; metadata?: Record<string, unknown> } = {},
): AttentionLedgerEventEntry {
  return historicalEvent(id, options.source ?? { eventType: "agent.run.failed", entityType: "heartbeat_run", entityId: id }, {
    id: `${id}:source`,
    type: "task.updated",
    taskId: options.taskId ?? "issue:work",
    timestamp: at(seconds),
    source: { id: "paperclip:heartbeat_run", kind: "paperclip", label: "Paperclip heartbeat run" },
    title: "Historical run failed",
    summary: "A deterministic failure requires acknowledgement.",
    status: "failed",
    activityClass: "tool_failure",
    metadata: { actorId: "human-auditor", actorType: "user", ...options.metadata },
  });
}

function historicalFixture(): { ledger: AttentionLedger; snapshot: AttentionSnapshot; review: AttentionReviewState } {
  const ledger: AttentionLedger = [
    historicalEvent("independent-review", { eventType: "issue.updated", entityType: "issue", entityId: "review" }, {
      id: "review:source", type: "human.input.requested", taskId: "issue:review", interactionId: "issue:review:approval",
      timestamp: at(0), title: "Independent review", summary: "Review the separate issue.",
      request: { kind: "approval" },
    }),
    historicalFailure("old-run", 1),
    {
      kind: "response", id: "ack:historical", occurredAt: at(2), source: { eventType: "acknowledge-frame" },
      apertureResponse: { taskId: "issue:work", interactionId: "interaction:issue:work:status", response: { kind: "acknowledged" } },
    },
    {
      kind: "signal", id: "signal:historical", occurredAt: at(3), source: { eventType: "viewed-frame" },
      apertureSignal: { kind: "viewed", taskId: "issue:work", interactionId: "interaction:issue:work:status", timestamp: at(3) },
    },
    {
      kind: "overlay-response", id: "overlay:historical", occurredAt: at(4), source: { eventType: "acknowledge-frame" },
      apertureResponse: { taskId: "issue:work", interactionId: "interaction:issue:work:status", response: { kind: "dismissed" } },
      overlay: { kind: "display_overlay", reason: "Historical display response." },
    },
    {
      kind: "overlay-response", id: "independent-response", occurredAt: at(5), source: { eventType: "record-approval-response" },
      apertureResponse: { taskId: "issue:work", interactionId: "issue:work:native-approval", response: { kind: "approved" } },
      overlay: { kind: "approval_overlay", reason: "Independent approval audit." },
    },
    historicalFailure("new-run", 6),
  ];
  return {
    ledger,
    snapshot: { ...createEmptySnapshot(COMPANY), updatedAt: at(6) },
    review: {
      companyId: COMPANY, updatedAt: at(4), lastSeenAt: at(4),
      frames: { "issue:work": { lastSeenAt: at(4), suppressedAt: at(4) } },
    },
  };
}

function historicalApprovalFixture(kind: "approval" | "agent" = "approval") {
  const source = kind === "approval"
    ? { eventType: "approval.created" as const, entityType: "approval", entityId: "launch" }
    : { eventType: "agent.status_changed" as const, entityType: "agent", entityId: "new-hire" };
  const request = mapPluginEventToSourceEvent({
    ...source, eventId: "historical-approval", companyId: COMPANY, occurredAt: at(1),
    actorType: "user", actorId: "original-operator",
    payload: kind === "approval"
      ? { type: "approve_ceo_strategy", title: "Approve launch", summary: "Launch awaits approval." }
      : { status: "pending_approval" },
  });
  if (request?.type !== "human.input.requested") throw new Error("Expected a mapped approval request.");
  const acknowledgement: AttentionLedgerResponseEntry = {
    kind: "response", id: "historical-approval-ack", occurredAt: at(2),
    source: { eventType: "plugin.local.acknowledge", entityId: request.taskId },
    apertureResponse: { taskId: request.taskId, interactionId: request.interactionId, response: { kind: "acknowledged" } },
  };
  const ledger: AttentionLedger = [
    historicalEvent("historical-approval", source, request),
    historicalEvent("remaining-work", { eventType: "issue.updated", entityType: "issue", entityId: "remaining" }, {
      id: "remaining-work:source", type: "human.input.requested", taskId: "issue:remaining",
      interactionId: "issue:remaining:review", timestamp: at(1),
      title: "Review independent work", summary: "A separate review remains actionable.",
      request: { kind: "approval" }, riskHint: "low",
    }),
    acknowledgement,
    { ...acknowledgement, id: "duplicate-historical-ack", occurredAt: at(3) },
  ];
  return { ledger, snapshot: createEmptySnapshot(COMPANY), review: createEmptyReviewState(COMPANY) };
}

const approvalVariants = [1, 2, 3, 4, "unversioned", "split"] as const;

const variants = [1, 2, 3, "unversioned", "split"] as const;
type HistoricalVariant = typeof variants[number];

function normalizeHistorical(variant: HistoricalVariant | 4, fixture = historicalFixture()): PersistedAttentionState {
  if (variant === "split") return normalizeSplitAttentionState(COMPANY, fixture);
  const payload = { companyId: COMPANY, ...fixture };
  const state = normalizePersistedAttentionState(COMPANY, variant === "unversioned" ? payload : { schemaVersion: variant, payload });
  if (!state) throw new Error("Historical fixture must normalize.");
  return state;
}

async function seedHistorical(variant: HistoricalVariant | 4, fixture = historicalFixture()) {
  const harness = createTestHarness({ manifest });
  const store = new ApertureCompanyStore();
  registerDataHandlers(harness.ctx, store);
  const writeState = (stateKey: string, value: unknown) => harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey }, value);
  if (variant === "split") {
    await writeState(ATTENTION_LEDGER_STATE_KEY, fixture.ledger);
    await writeState(ATTENTION_SNAPSHOT_STATE_KEY, fixture.snapshot);
    await writeState(ATTENTION_REVIEW_STATE_KEY, fixture.review);
  } else {
    const payload = { companyId: COMPANY, ...fixture };
    await writeState(ATTENTION_STATE_KEY, variant === "unversioned" ? payload : { schemaVersion: variant, payload });
  }
  return { harness, store };
}

describe("persisted attention state", () => {
  it("round-trips the versioned attention envelope", () => {
    const companyId = "company-state";
    const envelope = createPersistedAttentionState(companyId, {
      ledger: createEmptyLedger(),
      snapshot: createEmptySnapshot(companyId),
      review: createEmptyReviewState(companyId),
    });

    expect(normalizePersistedAttentionState(companyId, envelope)).toEqual(envelope.payload);
  });

  it("migrates the legacy v1 envelope into the current payload shape", () => {
    const companyId = "company-state";
    const snapshot = createEmptySnapshot(companyId);
    const review = createEmptyReviewState(companyId);

    expect(normalizePersistedAttentionState(companyId, {
      schemaVersion: 1,
      payload: {
        companyId,
        ledger: createEmptyLedger(),
        snapshot,
        review,
      },
    })).toEqual(expect.objectContaining({
      companyId,
      ledger: [],
      snapshot,
      review,
      meta: expect.objectContaining({
        ledgerEntries: 0,
        eventEntries: 0,
        responseEntries: 0,
      }),
    }));
  });

  it("rejects unknown future schema versions", () => {
    const companyId = "company-state";
    const envelope = createPersistedAttentionState(companyId, {
      ledger: createEmptyLedger(),
      snapshot: createEmptySnapshot(companyId),
      review: createEmptyReviewState(companyId),
    });

    expect(normalizePersistedAttentionState(companyId, {
      ...envelope,
      schemaVersion: ATTENTION_STATE_SCHEMA_VERSION + 1,
    })).toBeNull();
  });
});

describe("historical run lifecycle migration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(30));
  });
  afterEach(() => vi.useRealTimers());
  it("preserves valid approval decisions verbatim through historical normalization and current-envelope replay", () => {
    const ledger: AttentionLedger = [
      historicalEvent("approval-request", { eventType: "approval.created", entityType: "approval", entityId: "launch" }, {
        id: "approval-request:source", type: "human.input.requested",
        taskId: "approval:launch", interactionId: "approval:launch:approval",
        timestamp: at(1), title: "Approve launch", summary: "Launch is ready for review.", request: { kind: "approval" },
      }),
      {
        kind: "response", id: "approval-response", occurredAt: at(2),
        source: { eventType: "record-approval-response" },
        apertureResponse: {
          taskId: "approval:launch", interactionId: "approval:launch:approval",
          response: { kind: "approved" },
        },
      },
    ];
    const fixture = {
      ledger, snapshot: createEmptySnapshot(COMPANY), review: createEmptyReviewState(COMPANY),
    };
    for (const variant of variants) {
      const normalized = normalizeHistorical(variant, fixture);
      expect(normalized.ledger).toEqual(ledger);
      const store = new ApertureCompanyStore();
      const hydrated = store.hydrate(COMPANY, normalized);
      expect(hydrated.snapshot.now).toBeNull();
      expect(hydrated.snapshot.next).toEqual([]);
      expect(hydrated.snapshot.ambient).toEqual([]);
      expect(store.getLedger(COMPANY)).toEqual(ledger);

      const envelope = createPersistedAttentionState(COMPANY, store.getPersistableState(COMPANY)!);
      const current = normalizePersistedAttentionState(COMPANY, envelope)!;
      expect(current.ledger).toEqual(ledger);
      expect(current.needsMigrationPersistence).toBeUndefined();
      const restarted = new ApertureCompanyStore();
      const replayed = restarted.hydrate(COMPANY, current);
      expect(replayed.snapshot).toEqual(hydrated.snapshot);
      expect(replayed.review).toEqual(hydrated.review);
      expect(restarted.getLedger(COMPANY)).toEqual(ledger);
    }
  });


  it.each(variants)("rewrites the same complete history from %s without changing audit ownership", (variant) => {
    const fixture = historicalFixture();
    const untouched = structuredClone(fixture);
    const state = normalizeHistorical(variant, fixture);
    const canonical = normalizeHistorical(3);
    expect(state.ledger).toEqual(canonical.ledger);
    expect(state.review).toEqual(canonical.review);
    expect(state.snapshot).toEqual(canonical.snapshot);
    expect(fixture).toEqual(untouched);
    expect(state.needsMigrationPersistence).toBe(true);
    expect(state.ledger.map((entry) => entry.id)).toEqual([
      "independent-review", "old-run", "ack:historical",
      "run-retirement:ack%3Ahistorical:run%3Aold-run:legacy-replaced",
      "signal:historical", "overlay:historical", "independent-response", "new-run",
    ]);
    const oldRun = state.ledger.find((entry) => entry.id === "old-run") as AttentionLedgerEventEntry;
    expect(oldRun.apertureEvent.taskId).toBe("run:old-run");
    expect(oldRun.sourceEvent?.taskId).toBe("run:old-run");
    expect(oldRun.source).toEqual(fixture.ledger[1]?.source);
    expect(oldRun.sourceEvent?.metadata).toEqual(expect.objectContaining({
      actorId: "human-auditor", actorType: "user",
      paperclipRun: expect.objectContaining({ runId: "old-run", issueId: "work", status: "failed" }),
    }));
    expect(oldRun.apertureEvent.metadata?.paperclipRun).toEqual(oldRun.sourceEvent?.metadata?.paperclipRun);
    for (const entry of state.ledger.filter((entry) => ["ack:historical", "signal:historical", "overlay:historical"].includes(entry.id))) {
      const target = entry.kind === "signal" ? entry.apertureSignal : entry.kind === "response" || entry.kind === "overlay-response" ? entry.apertureResponse : null;
      expect(target).toEqual(expect.objectContaining({ taskId: "run:old-run", interactionId: "interaction:run:old-run:status" }));
    }
    expect(state.ledger.find((entry) => entry.id === "independent-response")).toEqual(fixture.ledger[5]);
    expect(state.review.frames["issue:work"]).toEqual({ lastSeenAt: at(5), suppressedAt: at(4) });
    expect(state.review.frames["run:old-run"]).toEqual({ lastSeenAt: at(4), suppressedAt: at(4) });
    expect(state.review.frames["run:new-run"]?.suppressedAt).toBeUndefined();
    expect(state.meta).toMatchObject({ ledgerEntries: 8, eventEntries: 4, responseEntries: 1, signalEntries: 1, overlayResponseEntries: 2 });

    const store = new ApertureCompanyStore();
    const rebuilt = store.hydrate(COMPANY, state);
    const display = mergeStoredFrames(rebuilt.snapshot, COMPANY, [], rebuilt.review, at(30));
    const tasks = [display.now, ...display.next, ...display.ambient].filter((frame) => frame !== null).map((frame) => frame.taskId);
    expect(tasks).not.toContain("run:old-run");
    expect(tasks).toContain("run:new-run");
    expect(tasks).toContain("issue:review");
    const comparison = new ApertureCompanyStore().hydrate(COMPANY, canonical);
    expect(rebuilt).toEqual(comparison);
  });

  it.each(variants)("persists %s on the next scoped read and exports identical materialized replay", async (variant) => {
    const { harness } = await seedHistorical(variant);
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId: COMPANY });
    const replay = await harness.getData<AttentionReplayScenario>("attention-replay-scenario", { companyId: COMPANY });
    const canonical = normalizeHistorical(3);
    expect(exported.ledger).toEqual(canonical.ledger);
    expect(exported.review).toEqual(canonical.review);
    expect(replay.steps).toHaveLength(canonical.ledger.length);
    for (const [index, entry] of canonical.ledger.entries()) {
      const step = replay.steps[index];
      if (entry.kind === "event") expect(step).toMatchObject({ kind: "publish", event: entry.apertureEvent });
      else if (entry.kind === "signal") expect(step).toMatchObject({ kind: "signal", signal: entry.apertureSignal });
      else expect(step).toMatchObject({ kind: entry.kind === "response" ? "submit" : "overlay-response", response: entry.apertureResponse });
    }
    const replayCore = new ApertureCore({ surfaceCapabilities: FOCUS_SURFACE_CAPABILITIES });
    for (const step of replay.steps) {
      if (step.kind === "publish") replayCore.publish(step.event);
      else if (step.kind === "submit") replayCore.submit(step.response);
      else if (step.kind === "signal") replayCore.recordSignal(step.signal);
    }
    const last = canonical.ledger.at(-1)!;
    expect(createAttentionSnapshot(COMPANY, replayCore.getAttentionView(), last.source, last.occurredAt)).toEqual(exported.snapshot);
    const persisted = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: ATTENTION_STATE_KEY }) as PersistedAttentionStateEnvelope;
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.payload.ledger).toEqual(canonical.ledger);
    expect(persisted.payload).not.toHaveProperty("needsMigrationPersistence");
    const current = normalizePersistedAttentionState(COMPANY, persisted);
    expect(current?.needsMigrationPersistence).toBeUndefined();
    expect(current?.ledger).toEqual(canonical.ledger);
    const restarted = new ApertureCompanyStore().hydrate(COMPANY, current!);
    expect(restarted.snapshot).toEqual(exported.snapshot);
    expect(restarted.review).toEqual(exported.review);
  });

  it.each([3, "split"] as const)("keeps failed %s migration persistence pending for the next scoped read", async (variant) => {
    const { harness, store } = await seedHistorical(variant);
    const write = vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("Temporary state failure"));
    await harness.getData("attention-review", { companyId: COMPANY });
    expect(store.hasPendingPersistence(COMPANY)).toBe(true);
    const migrated = store.getLedger(COMPANY);
    await harness.getData("attention-review", { companyId: COMPANY });
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.hasPendingPersistence(COMPANY)).toBe(false);
    expect(store.getLedger(COMPANY)).toEqual(migrated);
    const persisted = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: ATTENTION_STATE_KEY }) as PersistedAttentionStateEnvelope;
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.payload.ledger).toEqual(migrated);
  });

  it("does not regenerate retirement events when normalizing the current envelope", () => {
    const state = normalizeHistorical(3);
    const envelope = createPersistedAttentionState(COMPANY, state);
    const normalized = normalizePersistedAttentionState(COMPANY, envelope);
    expect(normalized?.ledger).toEqual(state.ledger);
    expect(normalized?.needsMigrationPersistence).toBeUndefined();
    expect(normalized?.review).toEqual(state.review);
    expect(envelope.payload).not.toHaveProperty("needsMigrationPersistence");
  });

  it.each(["task.started", "task.updated", "task.completed", "task.cancelled"] as const)("materializes historical replacement at the original %s event", (type) => {
    const trigger: SourceEvent = type === "task.started"
      ? { id: "replace", taskId: "issue:work", timestamp: at(2), type, title: "Issue resumed" }
      : type === "task.updated"
        ? { id: "replace", taskId: "issue:work", timestamp: at(2), type, status: "running", title: "Issue resumed" }
        : { id: "replace", taskId: "issue:work", timestamp: at(2), type };
    const replacement = historicalEvent("replacement-ledger-id", { eventType: "issue.updated", entityType: "issue", entityId: "work" }, trigger);
    const fixture = historicalFixture();
    fixture.ledger = [historicalFailure("old-run", 1), replacement, {
      kind: "signal", id: "new-owner-signal", occurredAt: at(3), source: { eventType: "viewed-frame" },
      apertureSignal: { kind: "viewed", taskId: "issue:work", interactionId: "interaction:issue:work:status", timestamp: at(3) },
    }];
    const state = normalizeHistorical(3, fixture);
    expect(state.ledger.map((entry) => entry.id)).toEqual([
      "old-run", "replacement-ledger-id", "run-retirement:replacement-ledger-id:run%3Aold-run:legacy-replaced", "new-owner-signal",
    ]);
    expect(state.ledger[1]).toEqual(replacement);
    expect(state.ledger[3]).toEqual(fixture.ledger[2]);
    expect(state.review.frames["run:old-run"]?.suppressedAt).toBeUndefined();
  });

  it("keeps lost identities explicitly legacy and retires them only with identifiable clearing facts", () => {
    const fixture = historicalFixture();
    fixture.ledger = [
      historicalFailure("lost-run", 1, {
        taskId: "agent:worker-a", source: { eventType: "agent.run.failed", entityType: "agent", entityId: "worker-a" },
      }),
      historicalEvent("later-success", { eventType: "agent.run.finished", entityType: "heartbeat_run", entityId: "later" }, {
        id: "success:source", taskId: "heartbeat_run:later", type: "task.completed", timestamp: at(3),
        metadata: { paperclipRun: { runId: "later", agentId: "worker-a", startedAt: at(2), status: "completed" } },
      }),
    ];
    let state = normalizeHistorical(3, fixture);
    const taskId = createTaskId("run", "legacy:lost-run");
    const failed = state.ledger[0] as AttentionLedgerEventEntry;
    expect(failed.apertureEvent.taskId).toBe(taskId);
    expect(failed.apertureEvent.metadata?.paperclipRun).toEqual(expect.objectContaining({ legacyIdentity: true, agentId: "worker-a", status: "failed" }));
    expect(failed.apertureEvent.metadata?.paperclipRun).not.toHaveProperty("runId");
    expect(state.ledger).toHaveLength(2);
    fixture.ledger.push(historicalEvent("clear", { eventType: "agent.error_cleared", entityType: "agent", entityId: "worker-a" }, {
      id: "clear:source", taskId: "agent:worker-a", type: "task.completed", timestamp: at(4),
    }));
    state = normalizeHistorical(3, fixture);
    expect(state.ledger.at(-1)).toMatchObject({
      kind: "event", apertureEvent: { taskId, type: "task.cancelled", metadata: { paperclipRun: { status: "failed" } } },
    });
  });

  it.each(["run", "heartbeat_run"])("recovers a real run from a historical %s source without inventing the agent", (entityType) => {
    const fixture = historicalFixture();
    fixture.ledger = [historicalFailure("failure", 1, {
      source: { eventType: "agent.run.failed", entityType, entityId: "actual-run" },
    })];
    const entry = normalizeHistorical(3, fixture).ledger[0] as AttentionLedgerEventEntry;
    expect(entry.apertureEvent.taskId).toBe("run:actual-run");
    expect(entry.apertureEvent.metadata?.paperclipRun).toMatchObject({ runId: "actual-run", issueId: "work", status: "failed" });
    expect(entry.apertureEvent.metadata?.paperclipRun).not.toHaveProperty("agentId");
  });

  it("rewrites a legacy failed-run acknowledgement and preserves its historical suppression", () => {
    const fixture = historicalFixture();
    fixture.ledger = [
      historicalFailure("lost", 1, { taskId: "agent:worker", source: { eventType: "agent.run.failed", entityType: "agent", entityId: "worker" } }),
      {
        kind: "overlay-response", id: "ack-lost", occurredAt: at(2), source: { eventType: "acknowledge-frame" },
        apertureResponse: { taskId: "agent:worker", interactionId: "interaction:agent:worker:status", response: { kind: "acknowledged" } },
        overlay: { kind: "display_overlay", reason: "Legacy attention acknowledged." },
      },
    ];
    fixture.review = { companyId: COMPANY, updatedAt: at(2), frames: { "agent:worker": { lastSeenAt: at(2), suppressedAt: at(2) } } };
    const state = normalizeHistorical(3, fixture);
    const taskId = createTaskId("run", "legacy:lost");
    expect(state.ledger[1]).toMatchObject({ apertureResponse: { taskId, interactionId: `interaction:${taskId}:status` } });
    expect(state.ledger[2]).toMatchObject({ kind: "event", apertureEvent: { taskId, type: "task.cancelled" } });
    expect(state.review.frames[taskId]).toEqual(fixture.review.frames["agent:worker"]);
  });

  it("retires a proven predecessor but not an uncorrelated or concurrent historical run", () => {
    const fixture = historicalFixture();
    fixture.ledger = [
      historicalFailure("older", 1),
      historicalFailure("different", 1, { taskId: "issue:other" }),
      historicalFailure("concurrent", 4),
      historicalEvent("success", { eventType: "agent.run.finished", entityType: "heartbeat_run", entityId: "success" }, {
        id: "success:source", taskId: "heartbeat_run:success", type: "task.completed", timestamp: at(5),
        metadata: { paperclipRun: { runId: "success", issueId: "work", status: "completed", startedAt: at(3) } },
      }),
    ];
    const state = normalizeHistorical(3, fixture);
    expect(state.ledger.filter((entry) => entry.id.startsWith("run-retirement:")).map((entry) => entry.id))
      .toEqual(["run-retirement:success:run%3Aolder:successor"]);
  });

  it.each([true, false])("preserves marker-only suppression with source-event presence %s", (withSourceEvent) => {
    const fixture = historicalFixture();
    const failed = historicalFailure("one", 1);
    if (!withSourceEvent) delete failed.sourceEvent;
    fixture.ledger = [failed];
    fixture.review = { companyId: COMPANY, updatedAt: at(2), frames: { "issue:work": { lastSeenAt: at(2), suppressedAt: at(2) } } };
    const state = normalizeHistorical(3, fixture);
    expect(state.review.frames["run:one"]).toEqual(fixture.review.frames["issue:work"]);
    expect(state.review.frames["issue:work"]).toEqual(fixture.review.frames["issue:work"]);
    const canonical = state.ledger[0] as AttentionLedgerEventEntry;
    const duplicate: AttentionLedgerEventEntry = {
      ...canonical, id: "duplicate", occurredAt: at(3),
      apertureEvent: { ...canonical.apertureEvent, id: "duplicate", timestamp: at(3) },
      ...(canonical.sourceEvent ? { sourceEvent: { ...canonical.sourceEvent, id: "duplicate", timestamp: at(3) } } : {}),
    };
    const store = new ApertureCompanyStore();
    const hydrated = store.hydrate(COMPANY, { ...state, ledger: [...state.ledger, duplicate] });
    const display = mergeStoredFrames(hydrated.snapshot, COMPANY, [], hydrated.review, at(30));
    expect(display.counts.total).toBe(0);
    expect(store.getLedger(COMPANY)).toHaveLength(2);
  });

  it("does not copy a start-time suppression marker onto a later failed run", () => {
    const fixture = historicalFixture();
    fixture.ledger = [
      historicalEvent("start", { eventType: "agent.run.started", entityType: "heartbeat_run", entityId: "one" }, {
        id: "start:source", taskId: "issue:work", type: "task.started", timestamp: at(1), title: "Run started",
      }),
      historicalFailure("failure", 3, { source: { eventType: "agent.run.failed", entityType: "heartbeat_run", entityId: "one" } }),
    ];
    fixture.review = { companyId: COMPANY, updatedAt: at(2), frames: { "issue:work": { lastSeenAt: at(2), suppressedAt: at(2) } } };
    const state = normalizeHistorical(3, fixture);
    expect(state.review.frames["run:one"]).toEqual({ lastSeenAt: at(2) });
    expect(state.review.frames["issue:work"]).toEqual(fixture.review.frames["issue:work"]);
  });

  it("does not copy suppression from an independently owned issue interaction onto a run", () => {
    const fixture = historicalFixture();
    fixture.ledger = [
      historicalFailure("one", 1),
      {
        kind: "overlay-response", id: "independent", occurredAt: at(2), source: { eventType: "acknowledge-frame" },
        apertureResponse: { taskId: "issue:work", interactionId: "issue:work:review", response: { kind: "acknowledged" } },
        overlay: { kind: "display_overlay", reason: "The issue review was acknowledged." },
      },
    ];
    fixture.review = { companyId: COMPANY, updatedAt: at(2), frames: { "issue:work": { lastSeenAt: at(2), suppressedAt: at(2) } } };
    const state = normalizeHistorical(3, fixture);
    expect(state.ledger).toHaveLength(2);
    expect(state.ledger[1]).toEqual(fixture.ledger[1]);
    expect(state.review.frames["run:one"]).toBeUndefined();
    expect(state.review.frames["issue:work"]).toEqual(fixture.review.frames["issue:work"]);
  });

  it("derives review suppression only from failed-run acknowledgements, including current-envelope hydration", () => {
    const taskId = "run:one";
    const ledger: AttentionLedger = [
      historicalEvent("start", { eventType: "agent.run.started" }, {
        id: "start", taskId, timestamp: at(1), type: "task.started", title: "Started",
        metadata: { paperclipRun: { runId: "one", status: "running" } },
      }),
      { kind: "response", id: "start-ack", occurredAt: at(2), source: { eventType: "acknowledge-frame" },
        apertureResponse: { taskId, interactionId: `interaction:${taskId}:status`, response: { kind: "acknowledged" } } },
      historicalFailure("failure", 3, { taskId, metadata: { paperclipRun: { runId: "one", status: "failed" } } }),
    ];
    expect(deriveReviewStateFromLedger(COMPANY, ledger, null).frames[taskId]).toEqual({ lastSeenAt: at(2) });
    const state = createPersistedAttentionState(COMPANY, { ledger, snapshot: createEmptySnapshot(COMPANY) });
    expect(normalizePersistedAttentionState(COMPANY, state)?.review.frames[taskId]?.suppressedAt).toBeUndefined();
    expect(new ApertureCompanyStore().hydrate(COMPANY, state.payload).review.frames[taskId]?.suppressedAt).toBeUndefined();
  });

  it("preserves snapshot-only suppression without fabricating history and defaults missing split snapshots to epoch", () => {
    const fixture = historicalFixture();
    const state = normalizeSplitAttentionState(COMPANY, { ledger: undefined, snapshot: fixture.snapshot, review: fixture.review });
    expect(state.ledger).toEqual([]);
    expect(state.review).toEqual(fixture.review);
    expect(state.snapshot).toEqual(fixture.snapshot);
    const missing = normalizeSplitAttentionState(COMPANY, { ledger: null, snapshot: null, review: null });
    expect(missing.snapshot.updatedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(missing.ledger).toEqual([]);
  });
});

describe("historical approval acknowledgement compatibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(30));
  });
  afterEach(() => vi.useRealTimers());

  it("retains approval ownership across a status update that leaves the Core request pending", () => {
    const fixture = historicalApprovalFixture("agent");
    fixture.ledger.splice(1, 0, historicalEvent("agent-running", {
      eventType: "agent.status_changed", entityType: "agent", entityId: "new-hire",
    }, {
      id: "agent-running:source", type: "task.updated", taskId: "agent:new-hire",
      timestamp: at(2), title: "Agent is running", status: "running",
    }));
    const unmigrated = new ApertureCompanyStore();
    expect(() => unmigrated.hydrate(COMPANY, fixture)).toThrow();

    const normalized = normalizeHistorical(4, fixture);
    expect(normalized.ledger.filter((entry) => entry.kind === "overlay-response")).toHaveLength(2);
    const store = new ApertureCompanyStore();
    const hydrated = store.hydrate(COMPANY, normalized);
    expect(hydrated.snapshot.now).toMatchObject({
      taskId: "agent:new-hire", responseSpec: { kind: "approval" },
    });
    expect(normalized.review.frames["agent:new-hire"]?.suppressedAt).toBe(at(3));
  });

  it.each(approvalVariants)("migrates %s to schema 5 without deciding the approval or losing its audit replay", async (variant) => {
    const fixture = historicalApprovalFixture();
    const original = structuredClone(fixture);
    const normalized = normalizeHistorical(variant, fixture);
    expect(fixture).toEqual(original);
    expect(normalized.needsMigrationPersistence).toBe(true);
    expect(normalized.ledger.map((entry) => entry.id)).toEqual(original.ledger.map((entry) => entry.id));
    expect(normalized.ledger.slice(0, 2)).toEqual(original.ledger.slice(0, 2));
    for (const index of [2, 3]) {
      expect(normalized.ledger[index]).toEqual({
        ...original.ledger[index],
        kind: "overlay-response",
        overlay: {
          kind: "display_overlay",
          compatibility: "core-0.9-approval-acknowledgement",
          reason: expect.any(String),
        },
      });
    }
    expect(normalized.review.frames["approval:launch"]).toEqual({ lastSeenAt: at(3), suppressedAt: at(3) });
    expect(normalized.meta).toMatchObject({
      ledgerEntries: 4, eventEntries: 2, responseEntries: 0, overlayResponseEntries: 2, signalEntries: 0,
    });

    const { harness } = await seedHistorical(variant, fixture);
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId: COMPANY });
    expect(exported.ledger).toEqual(normalized.ledger);
    expect(exported.responseEntries).toEqual([]);
    expect(exported.overlayResponseEntries).toEqual(normalized.ledger.slice(2));
    expect(exported.snapshot.now).toMatchObject({ taskId: "approval:launch", responseSpec: { kind: "approval" } });
    expect(exported.snapshot.next.map((frame) => frame.taskId)).toContain("issue:remaining");
    for (const snapshot of [exported.reconciledSnapshot, exported.displaySnapshot]) {
      expect(snapshot.now?.taskId).toBe("issue:remaining");
      expect(snapshot.counts.total).toBe(1);
    }
    expect(exported.review).toEqual(normalized.review);

    const replay = await harness.getData<AttentionReplayScenario>("attention-replay-scenario", { companyId: COMPANY });
    expect(replay.steps.map((step) => step.kind)).toEqual(["publish", "publish", "overlay-response", "overlay-response"]);
    for (const index of [2, 3]) {
      const entry = exported.overlayResponseEntries[index - 2]!;
      expect(replay.steps[index]).toMatchObject({
        kind: "overlay-response", response: entry.apertureResponse, overlay: entry.overlay,
      });
    }
    const replayCore = new ApertureCore({ surfaceCapabilities: FOCUS_SURFACE_CAPABILITIES });
    for (const step of replay.steps) {
      if (step.kind === "publish") replayCore.publish(step.event);
      else if (step.kind === "submit") replayCore.submit(step.response);
      else if (step.kind === "signal") replayCore.recordSignal(step.signal);
    }
    const last = exported.ledger.at(-1)!;
    expect(createAttentionSnapshot(COMPANY, replayCore.getAttentionView(), last.source, last.occurredAt)).toEqual(exported.snapshot);
    expect(replay.expectations?.finalNowInteractionId).toBe(exported.snapshot.now?.interactionId);

    const persisted = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: ATTENTION_STATE_KEY }) as PersistedAttentionStateEnvelope;
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.payload.ledger).toEqual(normalized.ledger);
    expect(persisted.payload).not.toHaveProperty("needsMigrationPersistence");
    const current = normalizePersistedAttentionState(COMPANY, persisted)!;
    expect(current.needsMigrationPersistence).toBeUndefined();
    expect(current.ledger).toEqual(normalized.ledger);
    expect(current.review).toEqual(normalized.review);
    const restarted = new ApertureCompanyStore().hydrate(COMPANY, current);
    expect(restarted.snapshot).toEqual(exported.snapshot);
    expect(restarted.review).toEqual(exported.review);
  });

  it.each([true, false])("recognizes mapped agent pending approval with SourceEvent presence %s", (withSourceEvent) => {
    const fixture = historicalApprovalFixture("agent");
    if (!withSourceEvent) {
      for (const entry of fixture.ledger) if (entry.kind === "event") delete entry.sourceEvent;
    }
    const state = normalizeHistorical(4, fixture);
    expect(state.ledger.slice(2)).toEqual(fixture.ledger.slice(2).map((entry) => ({
      ...entry, kind: "overlay-response",
      overlay: {
        kind: "display_overlay", compatibility: "core-0.9-approval-acknowledgement", reason: expect.any(String),
      },
    })));
    const hydrated = new ApertureCompanyStore().hydrate(COMPANY, state);
    expect([hydrated.snapshot.now, ...hydrated.snapshot.next].some((frame) => frame?.taskId === "agent:new-hire")).toBe(true);
    const display = mergeStoredFrames(hydrated.snapshot, COMPANY, [], hydrated.review, at(30));
    expect(display.now?.taskId).toBe("issue:remaining");
    expect(display.counts.total).toBe(1);
  });

  it("does not reinterpret unrelated, unproven, replaced, or current-schema responses", () => {
    const fixture = historicalApprovalFixture();
    const request = fixture.ledger[0] as AttentionLedgerEventEntry;
    const acknowledgement = fixture.ledger[2] as AttentionLedgerResponseEntry;
    const nonapproval: SourceEvent = {
      ...request.sourceEvent!, type: "human.input.requested", taskId: "approval:launch",
      interactionId: acknowledgement.apertureResponse.interactionId, title: "A later acknowledgement request",
      summary: "This interaction now asks for a choice.", timestamp: at(2),
      request: { kind: "choice", selectionMode: "single", options: [{ id: "wait", label: "Wait" }] },
    };
    const replacement = historicalEvent("replacement-request", request.source, nonapproval);
    const differentInteraction = {
      ...acknowledgement,
      apertureResponse: { ...acknowledgement.apertureResponse, interactionId: "approval:launch:unrelated" },
    };
    const issueRequest = historicalEvent("issue-request", { eventType: "issue.updated", entityType: "issue", entityId: "review" }, {
      ...request.sourceEvent!, type: "human.input.requested", taskId: "issue:review",
      interactionId: "issue:review:approval", title: "Issue review", summary: "Independent issue approval.",
      request: { kind: "approval" },
    });
    const issueAcknowledgement: AttentionLedgerResponseEntry = {
      ...acknowledgement, source: { eventType: "plugin.local.acknowledge", entityId: "issue:review" },
      apertureResponse: { taskId: "issue:review", interactionId: "issue:review:approval", response: { kind: "acknowledged" } },
    };
    const run = historicalFailure("unrelated-run", 1, {
      taskId: "run:unrelated-run", metadata: { paperclipRun: { runId: "unrelated-run", status: "failed" } },
    });
    const runAcknowledgement: AttentionLedgerResponseEntry = {
      ...acknowledgement, source: { eventType: "plugin.local.acknowledge", entityId: "run:unrelated-run" },
      apertureResponse: { taskId: "run:unrelated-run", interactionId: "interaction:run:unrelated-run:status", response: { kind: "acknowledged" } },
    };
    const cases: Array<[string, AttentionLedger]> = [
      ["orphan", [acknowledgement]],
      ["different source", [request, { ...acknowledgement, source: { ...acknowledgement.source, eventType: "acknowledge-frame" } }]],
      ["mismatched source task", [request, { ...acknowledgement, source: { ...acknowledgement.source, entityId: "approval:other" } }]],
      ["different interaction", [request, differentInteraction]],
      ["later nonapproval owner", [request, replacement, acknowledgement]],
      ["SourceEvent overrides stale approval representation", [{ ...request, sourceEvent: nonapproval }, acknowledgement]],
      ["issue-owned approval", [issueRequest, issueAcknowledgement]],
      ["failed run", [run, runAcknowledgement]],
      ["completed request", [request, historicalEvent("completed-request", request.source, {
        id: "completed-request:source", type: "task.completed", taskId: "approval:launch", timestamp: at(2),
      }), acknowledgement]],
      ...(["approved", "rejected", "dismissed"] as const).map((kind): [string, AttentionLedger] => [
        kind, [request, { ...acknowledgement, apertureResponse: { ...acknowledgement.apertureResponse, response: { kind } } }],
      ]),
      ["existing display audit", [request, {
        ...acknowledgement, kind: "overlay-response", overlay: { kind: "display_overlay", reason: "Existing local audit." },
      }]],
    ];
    for (const [label, ledger] of cases) {
      expect(normalizeHistorical(4, { ...fixture, ledger }).ledger, label).toEqual(ledger);
    }

    const current = normalizePersistedAttentionState(COMPANY, {
      schemaVersion: 5, payload: { companyId: COMPANY, ...fixture },
    })!;
    expect(current.ledger).toEqual(fixture.ledger);
    expect(current.needsMigrationPersistence).toBeUndefined();
    expect(() => new ApertureCompanyStore().hydrate(COMPANY, current)).toThrow();
  });

  it("upgrades schema 4 without rerunning run identity or retirement migration", () => {
    const fixture = historicalApprovalFixture();
    const retiredHistory = normalizeHistorical(3).ledger.filter((entry) =>
      entry.kind === "event" && entry.apertureEvent.taskId === "run:old-run");
    const run = historicalFailure("v4-run", 4, {
      taskId: "run:v4-run", metadata: { paperclipRun: { runId: "v4-run", status: "failed" } },
    });
    const acknowledgement: AttentionLedgerResponseEntry = {
      kind: "response", id: "v4-run-ack", occurredAt: at(5),
      source: { eventType: "plugin.local.acknowledge", entityId: "run:v4-run" },
      apertureResponse: { taskId: "run:v4-run", interactionId: "interaction:run:v4-run:status", response: { kind: "acknowledged" } },
    };
    const runHistory = [...retiredHistory, run, acknowledgement];
    fixture.ledger.push(...runHistory);
    const normalized = normalizeHistorical(4, fixture);
    expect(normalized.ledger.slice(4)).toEqual(runHistory);
    expect(normalized.ledger).toHaveLength(fixture.ledger.length);
    expect(normalized.ledger.filter((entry) => entry.id.startsWith("run-retirement:"))).toEqual(retiredHistory.slice(1));
  });

  it("retries failed migration persistence without losing usable state or duplicating acknowledgement audits", async () => {
    const { harness, store } = await seedHistorical(4, historicalApprovalFixture());
    const write = vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("Temporary migration write failure"));
    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId: COMPANY });
    expect(review.frames["approval:launch"]?.suppressedAt).toBe(at(3));
    expect(store.hasPendingPersistence(COMPANY)).toBe(true);
    const migrated = structuredClone(store.getLedger(COMPANY));
    const exported = await harness.getData<AttentionExport>("attention-export", { companyId: COMPANY });
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.hasPendingPersistence(COMPANY)).toBe(false);
    expect(exported.ledger).toEqual(migrated);
    expect(exported.overlayResponseEntries).toHaveLength(2);
    expect(exported.displaySnapshot.now?.taskId).toBe("issue:remaining");
    const persisted = harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: ATTENTION_STATE_KEY }) as PersistedAttentionStateEnvelope;
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.payload.ledger).toEqual(migrated);
  });
});
