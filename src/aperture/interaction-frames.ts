import type { Issue, IssueThreadInteraction } from "@paperclipai/plugin-sdk/types";
import { withFocusDecisionMetadata, type InteractionDecisionMetadata } from "./contracts.js";
import type { StoredFrameCandidate } from "./frame-model.js";
import { createInteractionId, createTaskId } from "./task-ref.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value: unknown, fallback: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

const plainConfirmationFields: Record<string, true> = {
  version: true, prompt: true, acceptLabel: true, rejectLabel: true, rejectRequiresReason: true,
  rejectReasonLabel: true, allowDeclineReason: true, declineReasonPlaceholder: true,
  detailsMarkdown: true, supersedeOnUserComment: true,
  target: true, toolAction: true, secretProposal: true, connectionAuthorization: true,
};
export function isInlineConfirmation(interaction: IssueThreadInteraction): boolean {
  const payload = record(interaction.payload);
  const policy = interaction.effectiveResolverPolicy;
  return interaction.status === "pending" && interaction.kind === "request_confirmation"
    && interaction.addresseeAgentId == null
    && (policy === "anyone" || policy === "not_creator" || policy === "human_only")
    && (interaction.addresseeUserId == null || text(interaction.addresseeUserId) !== undefined)
    && (interaction.createdByUserId == null || text(interaction.createdByUserId) !== undefined)
    && (interaction.acceptanceBlocker === undefined || interaction.acceptanceBlocker === "workspace_sync_pending")
    && payload !== null && payload.version === 1 && text(payload.prompt) !== undefined
    && ["toolAction", "secretProposal", "connectionAuthorization", "target"].every((key) => payload[key] == null)
    && Object.keys(payload).every((key) => Object.hasOwn(plainConfirmationFields, key))
    && ["rejectRequiresReason", "allowDeclineReason", "supersedeOnUserComment"]
      .every((key) => payload[key] === undefined || typeof payload[key] === "boolean")
    && ["acceptLabel", "rejectLabel", "rejectReasonLabel", "declineReasonPlaceholder", "detailsMarkdown"]
      .every((key) => payload[key] == null || typeof payload[key] === "string");
}

export function interactionRecordToCandidate(issue: Issue, interaction: IssueThreadInteraction): StoredFrameCandidate | null {
  if (interaction.status !== "pending" || interaction.addresseeAgentId != null
    || interaction.companyId !== issue.companyId || interaction.issueId !== issue.id || !text(interaction.id)) return null;
  const taskId = createTaskId("interaction", interaction.id);
  const payload = record(interaction.payload);
  const inline = isInlineConfirmation(interaction);
  const policy = interaction.effectiveResolverPolicy;
  const decision: InteractionDecisionMetadata = {
    inline,
    acceptLabel: inline ? text(payload?.acceptLabel) ?? "Confirm" : "Confirm",
    rejectLabel: inline ? text(payload?.rejectLabel) ?? "Decline" : "Decline",
    rejectRequiresReason: inline && payload?.rejectRequiresReason === true,
    allowDeclineReason: inline && payload?.allowDeclineReason === true,
    rejectReasonLabel: inline ? text(payload?.rejectReasonLabel) ?? "Reason" : "Reason",
    preparing: interaction.acceptanceBlocker === "workspace_sync_pending",
    ...(text(interaction.addresseeUserId) ? { addresseeUserId: interaction.addresseeUserId! } : {}),
    ...(text(interaction.createdByUserId) ? { createdByUserId: interaction.createdByUserId! } : {}),
    ...(policy === "anyone" || policy === "not_creator" || policy === "human_only" ? { effectiveResolverPolicy: policy } : {}),
  };
  const createdAt = timestamp(interaction.createdAt, new Date(0).toISOString());
  const instruction = inline ? "A human decision is required." : "Human input required. Open this decision in Paperclip to respond.";
  return {
    lane: "next",
    frame: withFocusDecisionMetadata({
      id: `paperclip-interaction:${interaction.id}`,
      taskId,
      interactionId: createInteractionId(taskId, "decision"),
      version: 1,
      mode: "choice",
      responseSpec: { kind: "none" },
      source: { id: "paperclip:interaction", kind: "paperclip", label: "Paperclip decision" },
      title: text(interaction.title) ?? text(payload?.prompt) ?? "Paperclip decision",
      summary: text(interaction.summary) ?? text(payload?.prompt) ?? "Respond in Paperclip.",
      consequence: "medium",
      tone: "focused",
      context: { items: [
        { id: "decision-instructions", label: "Next action", value: decision.preparing ? "Preparing approval…" : instruction },
        ...(decision.addresseeUserId ? [{ id: "decision-addressee", label: "Addressed to", value: decision.addresseeUserId }] : []),
      ] },
      provenance: { whyNow: instruction, factors: ["pending native decision", "human input required"] },
      timing: { createdAt, updatedAt: timestamp(interaction.updatedAt, createdAt) },
      metadata: {
        entityType: "interaction", issueId: issue.id, paperclipInteractionId: interaction.id,
        interactionKind: text(interaction.kind), interactionDecision: decision, liveReconciled: true,
      },
    }, {
      owner: "paperclip_reconciliation", lane: "next", sourcePolicy: "interaction.pending",
      rationale: ["Pending human decision fetched from Paperclip."],
    }),
  };
}
