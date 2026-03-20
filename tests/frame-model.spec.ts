import { describe, expect, it } from "vitest";
import {
  calculateUnreadCounts,
  frameSortScore,
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
      active: createFrame("issue:1", "2026-03-19T10:00:00.000Z"),
      queued: [createFrame("issue:2", "2026-03-19T09:59:00.000Z")],
      ambient: [createFrame("issue:3", "2026-03-19T09:58:00.000Z")],
      counts: {
        active: 1,
        queued: 1,
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
      active: 1,
      queued: 0,
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

  it("promotes the strongest actionable candidate regardless of original lane", () => {
    const snapshot = {
      ...createEmptySnapshot("company-1"),
      updatedAt: "2026-03-19T10:00:00.000Z",
      active: createFrame("issue:1", "2026-03-19T09:55:00.000Z", {
        tone: "ambient",
        consequence: "low",
        provenance: {
          factors: ["comment follow-up"],
        },
      }),
      counts: {
        active: 1,
        queued: 0,
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

    const merged = mergeStoredFrames(snapshot, "company-1", [candidate(failedRun, "queued")]);

    expect(merged.active?.taskId).toBe("run:1");
    expect(frameSortScore(failedRun, "queued")).toBeGreaterThan(frameSortScore(snapshot.active!, "active"));
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
      active: staleBase,
      counts: {
        active: 1,
        queued: 0,
        ambient: 0,
        total: 1,
      },
    };

    const merged = mergeStoredFrames(snapshot, "company-1", [candidate(freshCandidate, "active")]);

    expect(merged.active?.title).toBe("Fresh blocked issue title");
    expect(merged.active?.timing.updatedAt).toBe("2026-03-19T10:05:00.000Z");
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
        active: 0,
        queued: 0,
        ambient: 2,
        total: 2,
      },
    };

    const merged = mergeStoredFrames(snapshot, "company-1", [], null, "2026-03-19T10:05:00.000Z");

    expect(merged.ambient.map((frame) => frame.taskId)).toEqual(["issue:recent"]);
  });
});
