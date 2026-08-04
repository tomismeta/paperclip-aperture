import { describe, expect, it } from "vitest";
import {
  ATTENTION_DECISION_RECORD_SCHEMA_VERSION,
  evaluateAttention,
} from "@tomismeta/aperture-core/evaluator";
import { semanticHintsForTruncatedSourceEvidence } from "@tomismeta/aperture-core/semantic";

describe("aperture-core 0.8 diagnostics surfaces", () => {
  it("evaluates a high-consequence blocking claim through the stateless evaluator", () => {
    const record = evaluateAttention({
      claim: {
        taskId: "issue-1",
        interactionId: "interaction-1",
        mode: "status",
        tone: "critical",
        consequence: "high",
        title: "Blocked rollout needs operator decision",
        summary: "The rollout is blocked on a human decision.",
        responseSpec: { kind: "none" },
        priority: "high",
        blocking: true,
        timestamp: "2026-08-04T01:00:00.000Z",
      },
      context: {
        operatorPresence: "present",
      },
      now: "2026-08-04T01:00:00.000Z",
    });

    expect(record.schemaVersion).toBe(ATTENTION_DECISION_RECORD_SCHEMA_VERSION);
    expect(record.planning.route).toBe("activate");
    expect(record.planning.plannedLane).toBe("now");
    expect(record.planning.reasonCodes).toContain("route:activate");
  });

  it("keeps truncation hints factual and consequence-aware", () => {
    const hints = semanticHintsForTruncatedSourceEvidence({ status: "failed" });

    expect(hints.confidence).toBe("low");
    expect(hints.consequence).toBe("high");
    expect(hints.factors).toContain("source evidence truncated");
  });
});
