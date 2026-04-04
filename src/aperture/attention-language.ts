import type { Agent } from "@paperclipai/plugin-sdk";
import type { StoredAttentionFrame } from "./types.js";
import type { FrameLane } from "./frame-model.js";
import { isBudgetOverride } from "./frame-model.js";

export const GENERIC_QUEUED_JUDGMENT = "Important enough to keep visible, but not enough to displace now.";
export const GENERIC_NEXT_JUDGMENT = GENERIC_QUEUED_JUDGMENT;

export function approvalBlockingSummary(budgetOverride: boolean): string {
  return budgetOverride
    ? "Budget controls are blocking work until a board decision lands."
    : "A board decision is blocking work in Paperclip.";
}

export function approvalBlockingWhyNow(budgetOverride: boolean): string {
  return budgetOverride
    ? "Budget controls are blocking work until a board decision lands."
    : "Paperclip is waiting on a human approval before work can continue.";
}

export function agentAttentionWhyNow(agent: Agent): { whyNow: string; factors: string[] } {
  if (agent.status === "error") {
    return {
      whyNow: "This agent is in an error state and may have a failed or stalled run.",
      factors: ["run failed", "operator review"],
    };
  }

  if (agent.status === "pending_approval") {
    return {
      whyNow: "This agent is paused behind a human approval gate.",
      factors: ["pending approval", "waiting on human"],
    };
  }

  if (agent.pauseReason === "budget") {
    return {
      whyNow: "This agent is paused by budget controls.",
      factors: ["budget stop", "paused work"],
    };
  }

  return {
    whyNow: "This agent is paused and may represent stale work.",
    factors: ["paused work"],
  };
}

export function agentAttentionSummary(agent: Agent): string {
  if (agent.status === "error") return "An agent needs operator attention after entering an error state.";
  if (agent.status === "pending_approval") return "A human decision is required before this agent can continue.";
  if (agent.pauseReason === "budget") return "Budget controls are holding this agent in a paused state.";
  return "This agent is paused and may need a quick operator check.";
}

export function agentAttentionTitle(agent: Agent): string {
  if (agent.status === "error") return `${agent.name} needs attention`;
  if (agent.status === "pending_approval") return `${agent.name} is waiting for approval`;
  return `${agent.name} is paused`;
}

export function runFailedSummary(): string {
  return "An agent run failed and may need operator attention.";
}

export function runFailedWhyNow(): string {
  return "A Paperclip-managed run failed and is now competing for operator attention.";
}

export function pendingApprovalEventTitle(): string {
  return "Agent waiting for approval";
}

export function pendingApprovalEventSummary(): string {
  return "A Paperclip-managed agent cannot continue until a pending approval is resolved.";
}

export function pendingApprovalEventWhyNow(): string {
  return "The agent is paused behind a Paperclip approval gate.";
}

export function genericJudgmentLine(frame: StoredAttentionFrame, lane: FrameLane): string {
  if (lane === "now") {
    if (isBudgetOverride(frame)) return approvalBlockingSummary(true);
    if (frame.mode === "approval") return "A human decision is blocking work right now.";
    if (frame.tone === "critical") return "This surfaced because it can displace the operator now.";
    return "This is the clearest current operator focus.";
  }

  if (isBudgetOverride(frame)) return "Budget review is staged behind the current focus.";
  if (lane === "next") return GENERIC_NEXT_JUDGMENT;
  return "Useful for awareness, but not interrupting.";
}
