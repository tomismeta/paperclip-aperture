import type { AttentionResponse } from "@tomismeta/aperture-core";

export type FrameDecision = {
  taskId: string;
  interactionId: string;
  action: "acknowledge" | "dismiss";
};

export function mapDecisionToResponse(decision: FrameDecision): AttentionResponse {
  return {
    taskId: decision.taskId,
    interactionId: decision.interactionId,
    response: decision.action === "dismiss" ? { kind: "dismissed" } : { kind: "acknowledged" },
  };
}
