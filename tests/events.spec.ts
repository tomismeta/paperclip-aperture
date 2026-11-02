import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { registerEventHandlers } from "../src/handlers/events.js";

type EventCallback = (event: PluginEvent) => Promise<void>;

function createEventHarness(config: Record<string, unknown> = {}) {
  const callbacks = new Map<string, EventCallback>();
  const configGet = vi.fn(async () => {
    throw new Error("config.get should not be called from event handlers");
  });
  const issueGet = vi.fn(async () => {
    throw new Error("issues.get should not be called from event handlers");
  });
  const stateGet = vi.fn(async () => {
    throw new Error("state.get should not be called from event handlers");
  });
  const stateSet = vi.fn(async () => {
    throw new Error("state.set should not be called from event handlers");
  });
  const streamOpen = vi.fn(() => {
    throw new Error("streams.open should not be called from event handlers");
  });
  const streamEmit = vi.fn(() => {
    throw new Error("streams.emit should not be called from event handlers");
  });

  const ctx = {
    config: { get: configGet },
    events: {
      on: vi.fn((eventName: string, callback: EventCallback) => {
        callbacks.set(eventName, callback);
      }),
    },
    issues: { get: issueGet },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    state: {
      get: stateGet,
      set: stateSet,
    },
    streams: {
      open: streamOpen,
      emit: streamEmit,
    },
  } as unknown as PluginContext;

  return {
    callbacks,
    config,
    configGet,
    ctx,
    issueGet,
    stateGet,
    stateSet,
    streamOpen,
    streamEmit,
  };
}

describe("event handlers", () => {
  it("captures issue events without scoped host RPCs", async () => {
    const harness = createEventHarness();
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store, () => harness.config);

    const callback = harness.callbacks.get("issue.updated");
    expect(callback).toBeTypeOf("function");
    await callback?.({
      eventId: "event-issue-updated",
      eventType: "issue.updated",
      companyId: "company-events",
      entityType: "issue",
      entityId: "issue-1",
      occurredAt: "2026-06-10T17:00:00.000Z",
      payload: {
        identifier: "PAP-1",
        title: "Stabilize gateway timeouts",
        status: "blocked",
        description: "Paperclip gateway notifications are timing out.",
      },
    } as PluginEvent);

    expect(harness.configGet).not.toHaveBeenCalled();
    expect(harness.issueGet).not.toHaveBeenCalled();
    expect(harness.stateGet).not.toHaveBeenCalled();
    expect(harness.stateSet).not.toHaveBeenCalled();
    expect(harness.streamOpen).not.toHaveBeenCalled();
    expect(harness.streamEmit).not.toHaveBeenCalled();
    expect(store.getLedger("company-events")).toHaveLength(1);
    expect(store.getSnapshot("company-events")?.counts.total).toBeGreaterThan(0);
    expect(store.hasPendingPersistence("company-events")).toBe(true);
  });

  it("resolves capture config for the event company", async () => {
    const harness = createEventHarness({ captureIssueLifecycle: false });
    const store = new ApertureCompanyStore();
    const getConfig = vi.fn((companyId: string) => (
      companyId === "company-disabled-events" ? harness.config : {}
    ));
    registerEventHandlers(harness.ctx, store, getConfig);

    const callback = harness.callbacks.get("issue.updated");
    await callback?.({
      eventId: "event-disabled-issue-updated",
      eventType: "issue.updated",
      companyId: "company-disabled-events",
      entityType: "issue",
      entityId: "issue-1",
      occurredAt: "2026-06-10T17:00:00.000Z",
      payload: {
        title: "Should not be captured",
        status: "blocked",
      },
    } as PluginEvent);

    expect(getConfig).toHaveBeenCalledWith("company-disabled-events");
    expect(harness.configGet).not.toHaveBeenCalled();
    expect(store.getLedger("company-disabled-events")).toHaveLength(0);
  });

  it("handles activity refresh events without stream RPCs", async () => {
    const harness = createEventHarness();
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store, () => harness.config);

    const callback = harness.callbacks.get("activity.logged");
    expect(callback).toBeTypeOf("function");
    await callback?.({
      eventId: "event-activity-document-updated",
      eventType: "activity.logged",
      companyId: "company-events",
      entityType: "issue",
      entityId: "issue-1",
      occurredAt: "2026-06-10T17:01:00.000Z",
      payload: {
        action: "issue.document_updated",
        entityType: "issue",
      },
    } as PluginEvent);

    expect(harness.configGet).not.toHaveBeenCalled();
    expect(harness.stateGet).not.toHaveBeenCalled();
    expect(harness.stateSet).not.toHaveBeenCalled();
    expect(harness.streamOpen).not.toHaveBeenCalled();
    expect(harness.streamEmit).not.toHaveBeenCalled();
  });

  it("subscribes to native Paperclip document and relation refresh events", () => {
    const harness = createEventHarness();
    registerEventHandlers(harness.ctx, new ApertureCompanyStore(), () => harness.config);

    expect(harness.callbacks.get("issue.document.created")).toBeTypeOf("function");
    expect(harness.callbacks.get("issue.document.updated")).toBeTypeOf("function");
    expect(harness.callbacks.get("issue.document.deleted")).toBeTypeOf("function");
    expect(harness.callbacks.get("issue.relations.updated")).toBeTypeOf("function");
  });

  it.each([
    ["done", false], ["cancelled", false], ["done", true], ["cancelled", true],
  ] as const)("retires linked failures on issue %s with issue capture %s", async (status, captureIssueLifecycle) => {
    const harness = createEventHarness({ captureIssueLifecycle });
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store, () => harness.config);
    await harness.callbacks.get("agent.run.failed")?.({
      eventId: "failure", eventType: "agent.run.failed", companyId: "company-events",
      entityType: "heartbeat_run", entityId: "run-1", occurredAt: "2026-10-22T10:00:00.000Z",
      payload: { runId: "run-1", agentId: "agent-1", issueId: "issue-1", error: "Execution failed" },
    });
    harness.config.captureRunFailures = false;
    await harness.callbacks.get("issue.updated")?.({
      eventId: "not-terminal", eventType: "issue.updated", companyId: "company-events",
      entityType: "issue", entityId: "issue-1", occurredAt: "2026-10-22T10:01:00.000Z",
      payload: { status: "in_progress" },
    });
    expect(store.getLedger("company-events")).toHaveLength(captureIssueLifecycle ? 2 : 1);
    await harness.callbacks.get("issue.updated")?.({
      eventId: "issue-closed", eventType: "issue.updated", companyId: "company-events",
      entityType: "issue", entityId: "issue-1", occurredAt: "2026-10-22T10:02:00.000Z",
      payload: { status },
    });
    const ledger = store.getLedger("company-events");
    expect(ledger).toHaveLength(captureIssueLifecycle ? 4 : 2);
    expect(ledger.at(-1)).toMatchObject({
      kind: "event", source: { eventType: "issue.updated" },
      sourceEvent: { taskId: "run:run-1", type: "task.cancelled", metadata: {
        paperclipRun: { status: "failed" }, paperclipRunRetirement: { reason: "issue-closed" },
      } },
    });
    expect(store.getSnapshot("company-events")?.counts.total).toBe(0);
    expect(store.hasPendingPersistence("company-events")).toBe(true);
    expect(harness.issueGet).not.toHaveBeenCalled();
    expect(harness.stateGet).not.toHaveBeenCalled();
    expect(harness.stateSet).not.toHaveBeenCalled();
    expect(harness.streamOpen).not.toHaveBeenCalled();
    expect(harness.streamEmit).not.toHaveBeenCalled();
  });

  it("logs and ignores run notifications without a real run identity", async () => {
    const harness = createEventHarness();
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store);
    await harness.callbacks.get("agent.run.failed")?.({
      eventId: "no-run", eventType: "agent.run.failed", companyId: "company-events",
      entityType: "agent", entityId: "agent-1", occurredAt: "2026-10-22T10:00:00.000Z",
      payload: { issueId: "issue-1", error: "Run identity absent" },
    });
    expect(harness.ctx.logger.warn).toHaveBeenCalledWith("Ignored Paperclip run event without a run ID.", expect.any(Object));
    expect(store.getLedger("company-events")).toEqual([]);
    expect(store.hasPendingPersistence("company-events")).toBe(false);
  });

  it("cleans up explicit agent errors even when new failure capture is disabled", async () => {
    const harness = createEventHarness();
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store, () => harness.config);
    for (const [runId, agentId] of [["run-1", "agent-1"], ["run-2", "agent-2"]]) {
      await harness.callbacks.get("agent.run.failed")?.({
        eventId: runId, eventType: "agent.run.failed", companyId: "company-events",
        entityType: "heartbeat_run", entityId: runId, occurredAt: "2026-10-22T10:00:00.000Z",
        payload: { runId, agentId },
      });
    }
    harness.config.captureRunFailures = false;
    await harness.callbacks.get("agent.error_cleared")?.({
      eventId: "agent-clear", eventType: "agent.error_cleared", companyId: "company-events",
      entityType: "agent", entityId: "agent-1", occurredAt: "2026-10-22T10:01:00.000Z", payload: {},
    } as PluginEvent);
    const snapshot = store.getSnapshot("company-events")!;
    expect([snapshot.now, ...snapshot.next, ...snapshot.ambient].filter(Boolean).map((frame) => frame!.taskId)).toEqual(["run:run-2"]);
    expect(store.getLedger("company-events")).toHaveLength(4);
    expect(harness.stateSet).not.toHaveBeenCalled();
  });
});
