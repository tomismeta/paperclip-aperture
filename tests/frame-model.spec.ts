import { describe, expect, it } from "vitest";
import {
  calculateUnreadCounts,
  isFrameSuppressed,
  mergeStoredFrames,
  type FrameLane,
} from "../src/aperture/frame-model.js";
import { createEmptyReviewState, createEmptySnapshot, type StoredAttentionFrame } from "../src/aperture/types.js";

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

describe("frame-model", () => {
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
