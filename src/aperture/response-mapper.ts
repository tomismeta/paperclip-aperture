import type { AttentionResponse } from "@tomismeta/aperture-core";

export type FrameDecision = {
  taskId: string;
  interactionId: string;
  action: "acknowledge" | "dismiss" | "approve" | "reject" | "request-revision";
};

export function mapDecisionToResponse(decision: FrameDecision): AttentionResponse {
  return {
    taskId: decision.taskId,
    interactionId: decision.interactionId,
    response:
      decision.action === "dismiss"
        ? { kind: "dismissed" }
        : decision.action === "approve"
          ? { kind: "approved" }
          : decision.action === "reject"
            ? { kind: "rejected" }
            : decision.action === "request-revision"
              ? { kind: "rejected", reason: "revision requested" }
              : { kind: "acknowledged" },
  };
}
