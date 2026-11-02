import { describe, expect, it, vi } from "vitest";
import { ApertureCore, type ApertureEvent, type SourceEvent } from "@tomismeta/aperture-core";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { normalizeSourceEvent } from "@tomismeta/aperture-core/semantic";
import type { AttentionLedgerEventEntry, AttentionSnapshot } from "../src/aperture/types.js";

function runEntry(runId: string, status: "failed" | "completed" | "cancelled" | "running", time: string, startedAt?: string): AttentionLedgerEventEntry {
  const base = {
    id: `${runId}-${status}`, taskId: `run:${runId}`, timestamp: time,
    source: { id: "paperclip:run", kind: "paperclip", label: "Paperclip run" },
    metadata: { paperclipRun: { runId, agentId: "agent-1", issueId: "issue-1", status, startedAt } },
  };
  const sourceEvent: SourceEvent = status === "failed"
    ? { ...base, type: "task.updated", title: "Run failed", status: "failed", activityClass: "tool_failure" }
    : status === "running" ? { ...base, type: "task.started", title: "Run started" }
      : { ...base, type: status === "completed" ? "task.completed" : "task.cancelled" };
  return {
    kind: "event", id: `${base.id}:ledger`, occurredAt: time,
    source: { eventType: `agent.run.${status}`, entityType: "heartbeat_run", entityId: runId },
    sourceEvent, apertureEvent: normalizeSourceEvent(sourceEvent),
  };
}

function taskIds(snapshot: AttentionSnapshot) {
  return [snapshot.now, ...snapshot.next, ...snapshot.ambient].filter((frame) => frame !== null).map((frame) => frame.taskId).sort();
}

function approvalEvent(input: {
  id: string;
  taskId: string;
  interactionId: string;
  timestamp: string;
  title: string;
  consequence: "low" | "medium" | "high";
}): ApertureEvent {
  return {
    id: input.id,
    type: "human.input.requested",
    taskId: input.taskId,
    interactionId: input.interactionId,
    timestamp: input.timestamp,
    source: {
      id: "paperclip:approval",
      kind: "paperclip",
      label: "Paperclip approval",
    },
    title: input.title,
    summary: `${input.title} is ready for review.`,
    consequence: input.consequence,
    request: { kind: "approval" },
  };
}

describe("ApertureCompanyStore", () => {
  it("rejects acknowledgement of a pending approval without changing state, then accepts and replays approval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    try {
      const companyId = "company-approval-response";
      const store = new ApertureCompanyStore();
      const event = approvalEvent({
        id: "approval-request",
        taskId: "approval:decision",
        interactionId: "approval:decision:approval",
        timestamp: "2026-10-22T10:00:00.000Z",
        title: "Approve launch",
        consequence: "medium",
      });
      store.applyEvent(companyId, {
        kind: "event", id: "approval-request:ledger", occurredAt: event.timestamp,
        source: { eventType: "approval.created" }, apertureEvent: event,
      });
      store.setReview(companyId, {
        companyId, updatedAt: event.timestamp,
        frames: { [event.taskId]: { lastSeenAt: event.timestamp } },
      });
      const before = structuredClone(store.getPersistableState(companyId)!);
      expect(taskIds(before.snapshot)).toEqual([event.taskId]);

      expect(() => store.applyResponse(companyId, {
        kind: "response", id: "invalid-acknowledgement", occurredAt: event.timestamp,
        source: { eventType: "acknowledge-frame" },
        apertureResponse: {
          taskId: event.taskId, interactionId: "approval:decision:approval",
          response: { kind: "acknowledged" },
        },
      })).toThrow();
      expect(store.getPersistableState(companyId)).toEqual(before);

      const approved = store.applyResponse(companyId, {
        kind: "response", id: "valid-approval", occurredAt: event.timestamp,
        source: { eventType: "record-approval-response" },
        apertureResponse: {
          taskId: event.taskId, interactionId: "approval:decision:approval",
          response: { kind: "approved" },
        },
      });
      expect(taskIds(approved.snapshot)).toEqual([]);
      expect(approved.ledger.map((entry) => entry.id)).toEqual(["approval-request:ledger", "valid-approval"]);
      const state = store.getPersistableState(companyId)!;
      const restarted = new ApertureCompanyStore();
      const replayed = restarted.hydrate(companyId, state);
      expect(replayed.snapshot).toEqual(state.snapshot);
      expect(restarted.getLedger(companyId)).toEqual(state.ledger);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the engaged now item steady until the hold expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T10:00:00.000Z"));

    try {
      const store = new ApertureCompanyStore();
      const companyId = "company-hold";

      store.ingest(
        companyId,
        approvalEvent({
          id: "approval-1",
          taskId: "approval:approval-1",
          interactionId: "approval:approval-1:approval",
          timestamp: "2026-04-10T10:00:00.000Z",
          title: "Approve pricing memo",
          consequence: "low",
        }),
      );

      const firstSnapshot = store.getSnapshot(companyId);
      expect(firstSnapshot?.now?.title).toBe("Approve pricing memo");

      store.engage(
        companyId,
        firstSnapshot?.now?.taskId ?? "",
        firstSnapshot?.now?.interactionId ?? "",
        { durationMs: 1000 },
      );

      store.ingest(
        companyId,
        approvalEvent({
          id: "approval-2",
          taskId: "approval:approval-2",
          interactionId: "approval:approval-2:approval",
          timestamp: "2026-04-10T10:00:01.000Z",
          title: "Approve launch checklist",
          consequence: "medium",
        }),
      );

      const heldSnapshot = store.getSnapshot(companyId);
      expect(heldSnapshot?.now?.title).toBe("Approve pricing memo");
      expect(heldSnapshot?.next.map((frame) => frame.title)).toEqual(["Approve launch checklist"]);

      await vi.advanceTimersByTimeAsync(1005);

      const releasedSnapshot = store.getSnapshot(companyId);
      expect(releasedSnapshot?.now?.title).toBe("Approve launch checklist");
      expect(releasedSnapshot?.next.map((frame) => frame.title)).toEqual(["Approve pricing memo"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts idle company sessions after the TTL window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T10:00:00.000Z"));

    try {
      const store = new ApertureCompanyStore();
      store.ingest(
        "company-old",
        approvalEvent({
          id: "approval-old",
          taskId: "approval:approval-old",
          interactionId: "approval:approval-old:approval",
          timestamp: "2026-04-10T10:00:00.000Z",
          title: "Approve old company",
          consequence: "low",
        }),
      );

      expect(store.hasSession("company-old")).toBe(true);

      vi.advanceTimersByTime(31 * 60 * 1000);

      store.ingest(
        "company-new",
        approvalEvent({
          id: "approval-new",
          taskId: "approval:approval-new",
          interactionId: "approval:approval-new:approval",
          timestamp: "2026-04-10T10:31:00.000Z",
          title: "Approve new company",
          consequence: "low",
        }),
      );

      expect(store.hasSession("company-old")).toBe(false);
      expect(store.hasSession("company-new")).toBe(true);
      expect(store.getHealth()).toEqual(expect.objectContaining({
        trackedCompanies: 1,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes primary then sorted retirements and replays them verbatim", () => {
    const store = new ApertureCompanyStore();
    const company = "company-runs";
    store.applyEvent(company, runEntry("b", "failed", "2026-10-22T10:00:00.000Z"));
    store.applyEvent(company, runEntry("a", "failed", "2026-10-22T10:00:00.000Z"));
    const success = runEntry("success", "completed", "2026-10-22T10:02:00.000Z", "2026-10-22T10:01:00.000Z");
    const result = store.applyEvent(company, success);
    expect(result.ledger.slice(2).map((entry) => entry.kind === "event" && entry.apertureEvent.taskId)).toEqual(["run:success", "run:a", "run:b"]);
    expect(result.snapshot.lastEvent).toEqual(success.source);
    expect(taskIds(result.snapshot)).toEqual([]);
    expect(store.getCoreDiagnostics(company)?.eventCount).toBe(5);
    const restarted = new ApertureCompanyStore();
    const hydrated = restarted.hydrate(company, { ledger: result.ledger });
    expect(taskIds(hydrated.snapshot)).toEqual(taskIds(result.snapshot));
    expect(restarted.getLedger(company)).toEqual(result.ledger);
    expect(restarted.getCoreDiagnostics(company)?.eventCount).toBe(5);
    expect(store.applyEvent(company, success).ledger).toEqual(result.ledger);
  });

  it("deduplicates any primary ledger/source/normalized event identity", () => {
    const store = new ApertureCompanyStore();
    const first = runEntry("old", "failed", "2026-10-22T10:00:00.000Z");
    store.applyEvent("company", first);
    for (const duplicate of [
      { ...first, apertureEvent: { ...first.apertureEvent, id: "different-normalized" } },
      { ...first, id: "different-ledger" },
      { ...first, id: "different-ledger-2", sourceEvent: { ...first.sourceEvent!, id: "different-source" } },
      { ...first, id: "different-ledger-3", apertureEvent: { ...first.apertureEvent, id: "different-normalized-2" } },
    ]) {
      const result = store.applyEvent("company", duplicate);
      expect(result.frame).toBeNull();
      expect(result.ledger).toEqual([first]);
    }
    expect(store.getCoreDiagnostics("company")?.eventCount).toBe(1);
  });

  it("rebuilds Core and index after a failed retirement publication", () => {
    const store = new ApertureCompanyStore();
    const company = "company-rollback";
    const failed = runEntry("old", "failed", "2026-10-22T10:00:00.000Z");
    store.applyEvent(company, failed);
    store.setCachedHostValue(company, "preserved", "cached", 60_000);
    store.markPersistencePending(company);
    const before = store.getPersistableState(company)!;
    const success = runEntry("success", "completed", "2026-10-22T10:02:00.000Z", "2026-10-22T10:01:00.000Z");
    const publish = ApertureCore.prototype.publishSourceEvent;
    const spy = vi.spyOn(ApertureCore.prototype, "publishSourceEvent").mockImplementation(function (this: ApertureCore, event: SourceEvent) {
      const frame = publish.call(this, event);
      if (event.id.startsWith("run-retirement:")) throw new Error("publish failed after mutation");
      return frame;
    });
    try {
      expect(() => store.applyEvent(company, success)).toThrow("publish failed after mutation");
    } finally {
      spy.mockRestore();
    }
    expect(store.getLedger(company)).toEqual(before.ledger);
    expect(taskIds(store.getSnapshot(company)!)).toEqual(taskIds(before.snapshot));
    expect(store.getCoreDiagnostics(company)?.eventCount).toBe(1);
    expect(store.getCachedHostValue(company, "preserved")).toBe("cached");
    expect(store.hasPendingPersistence(company)).toBe(true);
    const retried = store.applyEvent(company, success);
    expect(retried.ledger).toHaveLength(3);
    expect(taskIds(retried.snapshot)).toEqual([]);
  });

  it("does not regenerate retirements while hydrating unmaterialized history", () => {
    const failure = runEntry("old", "failed", "2026-10-22T10:00:00.000Z");
    const success = runEntry("success", "completed", "2026-10-22T10:02:00.000Z", "2026-10-22T10:01:00.000Z");
    const store = new ApertureCompanyStore();
    const result = store.hydrate("company", { ledger: [failure, success] });
    expect(taskIds(result.snapshot)).toContain("run:old");
    expect(store.getLedger("company")).toEqual([failure, success]);
    const later = runEntry("later", "completed", "2026-10-22T10:04:00.000Z", "2026-10-22T10:03:00.000Z");
    expect(store.applyEvent("company", later).ledger).toHaveLength(4);
  });

  it.each(["completed", "cancelled"] as const)("same-run %s clears only its run and never another company", (status) => {
    const store = new ApertureCompanyStore();
    const failed = runEntry("old", "failed", "2026-10-22T10:00:00.000Z");
    store.applyEvent("company-a", failed);
    store.applyEvent("company-b", failed);
    store.applyEvent("company-a", runEntry("other", "failed", "2026-10-22T10:00:00.000Z"));
    const result = store.applyEvent("company-a", runEntry("old", status, "2026-10-22T10:02:00.000Z"));
    expect(taskIds(result.snapshot)).toEqual(["run:other"]);
    expect(taskIds(store.getSnapshot("company-b")!)).toEqual(["run:old"]);
    expect(result.ledger).toHaveLength(3);
  });

  it("keeps independent issue reviews and approvals when a successor retires run attention", () => {
    const store = new ApertureCompanyStore();
    for (const taskId of ["issue:issue-1", "approval:approval-1"]) {
      const event = approvalEvent({
        id: taskId, taskId, interactionId: `${taskId}:review`,
        timestamp: "2026-10-22T10:00:00.000Z", title: "Independent decision", consequence: "medium",
      });
      store.applyEvent("company", {
        kind: "event", id: `${taskId}:ledger`, occurredAt: event.timestamp,
        source: { eventType: "approval.created" }, apertureEvent: event,
      });
    }
    store.applyEvent("company", runEntry("old", "failed", "2026-10-22T10:00:00.000Z"));
    const result = store.applyEvent("company", runEntry("success", "completed", "2026-10-22T10:02:00.000Z", "2026-10-22T10:01:00.000Z"));
    expect(taskIds(result.snapshot)).toEqual(["approval:approval-1", "issue:issue-1"]);
  });

  it("keeps started-only runs ambient without a response requirement", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00.000Z"));
    try {
      const store = new ApertureCompanyStore();
      const result = store.applyEvent("company", runEntry("started", "running", "2026-10-22T10:00:00.000Z"));
      expect(result.snapshot.now).toBeNull();
      expect(result.snapshot.next).toEqual([]);
      expect(result.snapshot.ambient).toEqual([expect.objectContaining({
        taskId: "run:started", consequence: "low", responseSpec: { kind: "none" },
        metadata: expect.objectContaining({ paperclipRun: expect.objectContaining({ status: "running" }) }),
      })]);
    } finally {
      vi.useRealTimers();
    }
  });
});
