import { describe, expect, it } from "vitest";
import { explainFrame, signalStrengthLabel } from "../src/aperture/explainability.js";
import type { StoredAttentionFrame } from "../src/aperture/types.js";

function createFrame(overrides: Partial<StoredAttentionFrame> = {}): StoredAttentionFrame {
  return {
    id: "frame-1",
    taskId: "issue:1",
    interactionId: "issue:1:blocked",
    source: {
      id: "paperclip:issue",
      kind: "paperclip",
      label: "Paperclip issue",
    },
    version: 1,
    mode: "status",
    tone: "focused",
    consequence: "medium",
    title: "APE-12 Review launch memo",
    summary: "Board still needs the memo before review can continue.",
    provenance: {
      whyNow: "The board still needs the memo before review can continue.",
      factors: ["waiting on human", "issue review"],
    },
    timing: {
      createdAt: "2026-03-25T15:00:00.000Z",
      updatedAt: "2026-03-25T15:05:00.000Z",
    },
    metadata: {},
    ...overrides,
  };
}

describe("explainability", () => {
  it("summarizes lane reason, confidence, and relation hints", () => {
    const explanation = explainFrame(createFrame({
      metadata: {
        semantic: {
          confidence: "medium",
          relationHints: [
            { kind: "same_issue", target: "issue:1" },
            { kind: "supersedes", target: "issue:1" },
          ],
        },
        attention: {
          rationale: ["waiting on human", "issue review"],
        },
      },
    }), "next");

    expect(explanation.laneReason).toContain("staged behind the current top item");
    expect(explanation.signalStrength).toBe("medium");
    expect(explanation.relationLabels).toContain("Part of the same thread");
    expect(explanation.relationLabels).toContain("Moves the request forward");
    expect(explanation.signals).toContain("waiting on human");
  });

  it("falls back to provenance factors and episode continuity", () => {
    const explanation = explainFrame(createFrame({
      metadata: {
        episode: {
          state: "emerging",
          size: 3,
        },
      },
    }), "now");

    expect(explanation.signalStrength).toBeNull();
    expect(explanation.signals).toContain("issue review");
    expect(explanation.continuity).toContain("3 related interactions");
    expect(explanation.continuity).toContain("thread");
    expect(explanation.laneReason).toContain("most urgent item");
  });

  it("formats signal strength labels", () => {
    expect(signalStrengthLabel("high")).toBe("high confidence");
  });
});
