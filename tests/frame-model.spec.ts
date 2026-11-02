import { describe, expect, it } from "vitest";
import {
  calculateUnreadCounts,
  isFrameSuppressed,
  mergeStoredFrames,
  type FrameLane,
} from "../src/aperture/frame-model.js";
import { createEmptyReviewState, createEmptySnapshot, type AttentionLedgerOverlayResponseEntry, type AttentionLedgerResponseEntry, type StoredAttentionFrame } from "../src/aperture/types.js";
import { deriveReviewStateFromLedger } from "../src/aperture/persisted-state.js";

function createFrame(
  taskId: string,
  updatedAt: string,
  overrides: Partial<StoredAttentionFrame> = {},
): StoredAttentionFrame {
  return {
    id: `${taskId}:${updatedAt}`,
    taskId,
    interactionId: `${taskId}:interaction`,
    source: {
      id: "paperclip:test",
      kind: "paperclip",
      label: "Paperclip test",
    },
    version: 1,
    mode: "status",
    tone: "focused",
    consequence: "medium",
    title: taskId,
    summary: `${taskId} summary`,
    timing: {
      createdAt: "2026-03-19T09:00:00.000Z",
      updatedAt,
    },
    metadata: {},
    ...overrides,
  };
}

function candidate(frame: StoredAttentionFrame, lane: FrameLane) {
  return { frame, lane };
}

function acknowledgement(taskId: string, interactionId: string, occurredAt: string): AttentionLedgerResponseEntry {
  return {
    kind: "response", id: `${interactionId}:${occurredAt}`, occurredAt,
    source: { eventType: "plugin.local.acknowledge", entityId: taskId },
    apertureResponse: { taskId, interactionId, response: { kind: "acknowledged" } },
  };
}

describe("frame-model", () => {
  it("expires malformed and legacy retry overlays but retains validated active retry awareness", () => {
    const metadata = {
      paperclipRun: { runId: "old", issueId: "issue-1", agentId: "agent-1", status: "failed" },
      paperclipRunRecovery: { successorRunId: "new", status: "running", attempt: 2 },
    };
    const active = createFrame("run:old", "2026-03-19T09:00:00.000Z", { metadata });
    const invalidRecoveries = [
      { successorRunId: "", status: "running", attempt: 2 },
      { successorRunId: "new", status: "cancelled", attempt: 2 },
      { successorRunId: "old", status: "running", attempt: 2 },
      { successorRunId: "new", status: "running", attempt: -1 },
      { successorRunId: "new", status: "running", attempt: 2, scheduledRetryAt: "invalid" },
    ];
    const expired = invalidRecoveries.map((recovery, index) => createFrame(
      `run:invalid-${index}`, "2026-03-19T09:00:00.000Z",
      { metadata: { ...metadata, paperclipRunRecovery: recovery } },
    ));
    expired.push(createFrame("run:legacy", "2026-03-19T09:00:00.000Z", {
      metadata: { ...metadata, paperclipRun: { status: "failed", legacyIdentity: true } },
    }));
    expired.push(createFrame("run:started", "2026-03-19T09:00:00.000Z", {
      metadata: { ...metadata, paperclipRun: { runId: "started", status: "running" } },
    }));
    const display = mergeStoredFrames(null, "company-1", [
      candidate(active, "ambient"), ...expired.map((frame) => candidate(frame, "ambient")),
    ], null, "2026-03-19T10:00:00.000Z");
    expect(display.ambient).toEqual([active]);
    expect(display.counts).toEqual({ now: 0, next: 0, ambient: 1, total: 1 });
  });

  it("calculates unread counts from global and per-frame review state", () => {
    const snapshot = {
      ...createEmptySnapshot("company-1"),
      updatedAt: "2026-03-19T10:00:00.000Z",
      now: createFrame("issue:1", "2026-03-19T10:00:00.000Z"),
      next: [createFrame("issue:2", "2026-03-19T09:59:00.000Z")],
      ambient: [createFrame("issue:3", "2026-03-19T09:58:00.000Z")],
      counts: {
        now: 1,
        next: 1,
        ambient: 1,
        total: 3,
      },
    };
    const review = {
      ...createEmptyReviewState("company-1"),
      lastSeenAt: "2026-03-19T09:58:30.000Z",
      frames: {
        "issue:2": {
          lastSeenAt: "2026-03-19T10:01:00.000Z",
        },
      },
    };

    expect(calculateUnreadCounts(snapshot, review)).toEqual({
      now: 1,
      next: 0,
      ambient: 0,
      total: 1,
    });
  });

  it("keeps suppressed frames hidden until their timestamp advances", () => {
    const review = {
      ...createEmptyReviewState("company-1"),
      frames: {
        "issue:1": {
          suppressedAt: "2026-03-19T10:00:00.000Z",
        },
      },
    };
    const stale = createFrame("issue:1", "2026-03-19T10:00:00.000Z");
    const fresh = createFrame("issue:1", "2026-03-19T10:05:00.000Z");

    expect(isFrameSuppressed(stale, "2026-03-19T10:00:00.000Z", review)).toBe(true);
    expect(isFrameSuppressed(fresh, "2026-03-19T10:05:00.000Z", review)).toBe(false);
  });

  it("keeps suppression ownership coupled to its timestamp across replay and persisted state", () => {
    const taskId = "agent:one";
    const early = "2026-03-19T10:00:00.000Z";
    const later = "2026-03-19T10:05:00.000Z";
    const error = createFrame(taskId, early, { interactionId: `${taskId}:error` });
    const paused = createFrame(taskId, early, { interactionId: `${taskId}:paused` });
    const oldAck = acknowledgement(taskId, error.interactionId, early);
    const newAck = acknowledgement(taskId, paused.interactionId, later);
    const replayed = deriveReviewStateFromLedger("company-1", [newAck, oldAck], null);
    expect(isFrameSuppressed(error, early, replayed)).toBe(false);
    expect(isFrameSuppressed(paused, early, replayed)).toBe(true);
    const restored = deriveReviewStateFromLedger("company-1", [oldAck], replayed);
    expect(isFrameSuppressed(error, early, restored)).toBe(false);
    expect(isFrameSuppressed(paused, early, restored)).toBe(true);
    expect(isFrameSuppressed(createFrame(taskId, "2026-03-19T10:06:00.000Z", {
      interactionId: paused.interactionId,
    }), later, restored)).toBe(false);

    const legacy = { ...createEmptyReviewState("company-1"), frames: { [taskId]: { suppressedAt: later } } };
    const recovered = deriveReviewStateFromLedger("company-1", [oldAck, newAck], legacy);
    expect(isFrameSuppressed(error, early, recovered)).toBe(false);
    expect(isFrameSuppressed(paused, early, recovered)).toBe(true);
    const unknown = deriveReviewStateFromLedger("company-1", [], legacy);
    expect(isFrameSuppressed(error, early, unknown)).toBe(true);
    expect(isFrameSuppressed(paused, early, unknown)).toBe(true);
  });

  it("uses ledger order for equal-time acknowledgements and removes ownership for winning legacy or dismiss suppression", () => {
    const taskId = "agent:one";
    const at = "2026-03-19T10:00:00.000Z";
    const error = createFrame(taskId, at, { interactionId: `${taskId}:error` });
    const paused = createFrame(taskId, at, { interactionId: `${taskId}:paused` });
    const errorAck = acknowledgement(taskId, error.interactionId, at);
    const pausedAck = acknowledgement(taskId, paused.interactionId, at);
    const forward = deriveReviewStateFromLedger("company-1", [errorAck, pausedAck], null);
    expect(isFrameSuppressed(error, at, forward)).toBe(false);
    expect(isFrameSuppressed(paused, at, forward)).toBe(true);
    const reverse = deriveReviewStateFromLedger("company-1", [pausedAck, errorAck], null);
    expect(isFrameSuppressed(error, at, reverse)).toBe(true);
    expect(isFrameSuppressed(paused, at, reverse)).toBe(false);

    const legacy: AttentionLedgerOverlayResponseEntry = {
      ...errorAck, kind: "overlay-response",
      overlay: { kind: "display_overlay", reason: "Historical local acknowledgement", compatibility: "core-0.9-approval-acknowledgement" },
    };
    const dismissed: AttentionLedgerOverlayResponseEntry = {
      ...errorAck, kind: "overlay-response",
      apertureResponse: { ...errorAck.apertureResponse, response: { kind: "dismissed" } },
      overlay: { kind: "display_overlay", reason: "Dismissed local overlay" },
    };
    expect(isFrameSuppressed(paused, at, deriveReviewStateFromLedger("company-1", [errorAck, legacy], null))).toBe(true);
    expect(isFrameSuppressed(paused, at, deriveReviewStateFromLedger("company-1", [errorAck, dismissed], null))).toBe(true);
    expect(isFrameSuppressed(paused, at, deriveReviewStateFromLedger("company-1", [legacy, errorAck], null))).toBe(false);

    const persisted = { ...createEmptyReviewState("company-1"), frames: {
      [taskId]: { suppressedAt: "2026-03-19T10:05:00.000Z" },
    } };
    const approved: AttentionLedgerResponseEntry = {
      ...pausedAck, apertureResponse: { ...pausedAck.apertureResponse, response: { kind: "approved" } },
    };
    const barriers = [
      legacy, dismissed, approved,
      { ...pausedAck, source: { eventType: "external.ack", entityId: taskId } },
      { ...pausedAck, source: { ...pausedAck.source, entityId: "agent:other" } },
      { ...pausedAck, apertureResponse: { ...pausedAck.apertureResponse, interactionId: " " } },
    ];
    for (const barrier of barriers) {
      const review = deriveReviewStateFromLedger("company-1", [errorAck, barrier], persisted);
      expect(isFrameSuppressed(error, at, review)).toBe(true);
      expect(isFrameSuppressed(paused, at, review)).toBe(true);
    }
    const laterOwner = deriveReviewStateFromLedger("company-1", [errorAck, legacy, pausedAck], persisted);
    expect(isFrameSuppressed(error, at, laterOwner)).toBe(false);
    expect(isFrameSuppressed(paused, at, laterOwner)).toBe(true);
  });

  it("keeps an acknowledged failed run suppressed across duplicate notifications without suppressing a new run or linked issue", () => {
    const review = {
      ...createEmptyReviewState("company-1"),
      frames: { "run:one": { suppressedAt: "2026-03-19T10:00:00.000Z" } },
    };
    const duplicate = createFrame("run:one", "2026-03-19T10:05:00.000Z", {
      metadata: { paperclipRun: { runId: "one", issueId: "1", status: "failed" } },
    });
    const nextRun = createFrame("run:two", "2026-03-19T10:06:00.000Z", {
      metadata: { paperclipRun: { runId: "two", issueId: "1", status: "failed" } },
    });
    const issue = createFrame("issue:1", "2026-03-19T10:05:00.000Z");

    const merged = mergeStoredFrames(null, "company-1", [
      candidate(duplicate, "next"),
      candidate(nextRun, "next"),
      candidate(issue, "now"),
    ], review);

    expect(merged.now?.taskId).toBe("issue:1");
    expect(merged.next.map((frame) => frame.taskId)).toEqual(["run:two"]);
  });

  it("does not give started runs or malformed run metadata identity-based suppression", () => {
    const review = {
      ...createEmptyReviewState("company-1"),
      frames: {
        "run:one": { lastSeenAt: "2026-03-19T10:00:00.000Z", suppressedAt: "2026-03-19T10:00:00.000Z" },
      },
    };
    const started = createFrame("run:one", "2026-03-19T10:05:00.000Z", {
      metadata: { paperclipRun: { runId: "one", status: "running" } },
    });
    const malformed = createFrame("run:one", "2026-03-19T10:05:00.000Z", {
      metadata: { paperclipRun: { runId: 42, status: "failed" } },
    });
    expect(isFrameSuppressed(started, started.timing.updatedAt, review)).toBe(false);
    expect(isFrameSuppressed(malformed, malformed.timing.updatedAt, review)).toBe(false);
  });

  it("viewing a started run alone never suppresses its later failure", () => {
    const review = {
      ...createEmptyReviewState("company-1"),
      frames: { "run:one": { lastSeenAt: "2026-03-19T10:00:00.000Z" } },
    };
    const failed = createFrame("run:one", "2026-03-19T10:05:00.000Z", {
      metadata: { paperclipRun: { runId: "one", status: "failed" } },
    });
    expect(isFrameSuppressed(failed, failed.timing.updatedAt, review)).toBe(false);
  });

  it("preserves the current now frame instead of re-scoring next lane candidates", () => {
    const snapshot = {
      ...createEmptySnapshot("company-1"),
      updatedAt: "2026-03-19T10:00:00.000Z",
      now: createFrame("issue:1", "2026-03-19T09:55:00.000Z", {
        tone: "ambient",
        consequence: "low",
        provenance: {
          factors: ["comment follow-up"],
        },
      }),
      counts: {
        now: 1,
        next: 0,
        ambient: 0,
        total: 1,
      },
    };
    const failedRun = createFrame("run:1", "2026-03-19T10:00:00.000Z", {
      tone: "critical",
      consequence: "high",
      provenance: {
        factors: ["run failed", "operator review"],
      },
    });

    const merged = mergeStoredFrames(snapshot, "company-1", [candidate(failedRun, "next")]);

    expect(merged.now?.taskId).toBe("issue:1");
    expect(merged.next.map((frame) => frame.taskId)).toContain("run:1");
  });

  it("replaces base frames with reconciled candidates that share a task id", () => {
    const staleBase = createFrame("issue:1", "2026-03-19T09:55:00.000Z", {
      title: "Old blocked issue title",
    });
    const freshCandidate = createFrame("issue:1", "2026-03-19T10:05:00.000Z", {
      title: "Fresh blocked issue title",
    });
    const snapshot = {
      ...createEmptySnapshot("company-1"),
      updatedAt: "2026-03-19T10:05:00.000Z",
      now: staleBase,
      counts: {
        now: 1,
        next: 0,
        ambient: 0,
        total: 1,
      },
    };

    const merged = mergeStoredFrames(snapshot, "company-1", [candidate(freshCandidate, "now")]);

    expect(merged.now?.title).toBe("Fresh blocked issue title");
    expect(merged.now?.timing.updatedAt).toBe("2026-03-19T10:05:00.000Z");
  });

  it("expires ambient frames after five minutes", () => {
    const recentAmbient = createFrame("issue:recent", "2026-03-19T10:01:30.000Z", {
      tone: "ambient",
      consequence: "low",
    });
    const staleAmbient = createFrame("issue:stale", "2026-03-19T09:54:59.000Z", {
      tone: "ambient",
      consequence: "low",
    });
    const snapshot = {
      ...createEmptySnapshot("company-1"),
      updatedAt: "2026-03-19T10:00:00.000Z",
      ambient: [recentAmbient, staleAmbient],
      counts: {
        now: 0,
        next: 0,
        ambient: 2,
        total: 2,
      },
    };

    const merged = mergeStoredFrames(snapshot, "company-1", [], null, "2026-03-19T10:05:00.000Z");

    expect(merged.ambient.map((frame) => frame.taskId)).toEqual(["issue:recent"]);
  });
});
