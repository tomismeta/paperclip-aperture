import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { registerEventHandlers } from "../src/handlers/events.js";

type EventCallback = (event: PluginEvent) => Promise<void>;

function createEventHarness() {
  const callbacks = new Map<string, EventCallback>();
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
    config: { get: vi.fn(async () => ({})) },
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
    ctx,
    issueGet,
    stateGet,
    stateSet,
    streamOpen,
    streamEmit,
  };
}

describe("event handlers", () => {
  it("captures issue events without host-scoped RPCs", async () => {
    const harness = createEventHarness();
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store);

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
        description: "OpenClaw gateway notifications are timing out.",
      },
    } as PluginEvent);

    expect(harness.issueGet).not.toHaveBeenCalled();
    expect(harness.stateGet).not.toHaveBeenCalled();
    expect(harness.stateSet).not.toHaveBeenCalled();
    expect(harness.streamOpen).not.toHaveBeenCalled();
    expect(harness.streamEmit).not.toHaveBeenCalled();
    expect(store.getLedger("company-events")).toHaveLength(1);
    expect(store.getSnapshot("company-events")?.counts.total).toBeGreaterThan(0);
  });

  it("handles activity refresh events without stream RPCs", async () => {
    const harness = createEventHarness();
    const store = new ApertureCompanyStore();
    registerEventHandlers(harness.ctx, store);

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

    expect(harness.stateGet).not.toHaveBeenCalled();
    expect(harness.stateSet).not.toHaveBeenCalled();
    expect(harness.streamOpen).not.toHaveBeenCalled();
    expect(harness.streamEmit).not.toHaveBeenCalled();
  });
});
