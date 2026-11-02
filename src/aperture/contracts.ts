import type { SemanticConfidence, SemanticRelationHint } from "@tomismeta/aperture-core/semantic";
import type { StoredAttentionFrame } from "./types.js";

export type PaperclipRunMetadata = {
  runId?: string;
  agentId?: string;
  issueId?: string;
  status?: "running" | "failed" | "completed" | "cancelled";
  hostStatus?: string;
  errorCode?: string;
  startedAt?: string;
  finishedAt?: string;
  legacyIdentity?: boolean;
};

export function parsePaperclipRunMetadata(value: unknown): PaperclipRunMetadata | null {
  const record = asRecord(value);
  if (!record) return null;
  const runId = readString(record.runId);
  const legacyIdentity = record.legacyIdentity === true;
  if (!runId && !legacyIdentity) return null;
  const status = record.status;
  if (status !== undefined && status !== "running" && status !== "failed"
    && status !== "completed" && status !== "cancelled") return null;
  const timestamp = (value: unknown): string | undefined => {
    const text = readString(value);
    return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
  };
  return {
    ...(runId && !legacyIdentity ? { runId } : {}),
    ...(legacyIdentity ? { legacyIdentity: true } : {}),
    agentId: readString(record.agentId),
    issueId: readString(record.issueId),
    status,
    hostStatus: readString(record.hostStatus),
    errorCode: readString(record.errorCode),
    startedAt: timestamp(record.startedAt),
    finishedAt: timestamp(record.finishedAt),
  };
}

export function readPaperclipRunMetadata(frame: StoredAttentionFrame): PaperclipRunMetadata | null {
  return parsePaperclipRunMetadata(asRecord(frame.metadata)?.paperclipRun);
}

export type PaperclipRunRecoveryMetadata = {
  successorRunId: string;
  status: "scheduled_retry" | "queued" | "running";
  scheduledRetryAt?: string;
  attempt: number;
};

export function readPaperclipRunRecoveryMetadata(frame: StoredAttentionFrame): PaperclipRunRecoveryMetadata | null {
  const value = asRecord(asRecord(frame.metadata)?.paperclipRunRecovery);
  if (!value) return null;
  const successorRunId = readString(value.successorRunId);
  const { status, attempt } = value;
  if (!successorRunId || (status !== "scheduled_retry" && status !== "queued" && status !== "running")
    || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0) return null;
  let scheduledRetryAt: string | undefined;
  if (value.scheduledRetryAt !== undefined) {
    const timestamp = readString(value.scheduledRetryAt);
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
    scheduledRetryAt = new Date(timestamp).toISOString();
  }
  return { successorRunId, status, attempt, ...(scheduledRetryAt ? { scheduledRetryAt } : {}) };
}

export type InteractionDecisionMetadata = {
  inline: boolean;
  acceptLabel: string;
  rejectLabel: string;
  rejectRequiresReason: boolean;
  allowDeclineReason: boolean;
  rejectReasonLabel: string;
  preparing: boolean;
  addresseeUserId?: string;
  effectiveResolverPolicy?: "anyone" | "not_creator" | "human_only";
  createdByUserId?: string;
};

type AttentionMetadata = {
  rationale?: string[];
};

type EpisodeMetadata = {
  size?: number;
  state?: string;
};

type IssueIntelligenceMetadata = {
  matchedRuleIds?: string[];
  owner?: string | null;
  ownerKind?: "agent" | "human" | null;
  blockingTarget?: string | null;
};

export type FocusDecisionOwner = "aperture_core" | "paperclip_reconciliation" | "approval_overlay" | "display_merge";

export type FocusDecisionMetadata = {
  owner?: FocusDecisionOwner;
  lane?: "now" | "next" | "ambient";
  sourcePolicy?: string;
  rationale?: string[];
  promotedFromLane?: "next" | "ambient";
};

export type FocusFrameMetadata = {
  entityType?: string;
  issueId?: string;
  paperclipInteractionId?: string;
  interactionKind?: string;
  interactionDecision?: InteractionDecisionMetadata;
  issueStatus?: string;
  issuePriority?: string;
  approvalStatus?: string;
  approvalType?: string;
  agentStatus?: string;
  pauseReason?: string | null;
  liveReconciled?: boolean;
  activityPath?: string;
  attention?: AttentionMetadata;
  semantic?: {
    confidence?: SemanticConfidence;
    relationHints?: SemanticRelationHint[];
  };
  episode?: EpisodeMetadata;
  issueIntelligence?: IssueIntelligenceMetadata;
  decision?: FocusDecisionMetadata;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return entries.length > 0 ? entries : undefined;
}

function readRelationHints(value: unknown): SemanticRelationHint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hints = value.filter((entry): entry is SemanticRelationHint => {
    if (typeof entry !== "object" || entry === null) return false;
    const hint = entry as Record<string, unknown>;
    return (
      hint.kind === "same_issue"
      || hint.kind === "resolves"
      || hint.kind === "supersedes"
      || hint.kind === "repeats"
      || hint.kind === "escalates"
    );
  });
  return hints.length > 0 ? hints : undefined;
}

function readInteractionDecision(value: unknown): InteractionDecisionMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const policy = record.effectiveResolverPolicy;
  const effectiveResolverPolicy = policy === "anyone" || policy === "not_creator" || policy === "human_only"
    ? policy : undefined;
  const validBooleans = ["inline", "rejectRequiresReason", "allowDeclineReason", "preparing"]
    .every((key) => typeof record[key] === "boolean");
  const validIdentities = ["addresseeUserId", "createdByUserId"]
    .every((key) => record[key] === undefined || readString(record[key]) !== undefined);
  return {
    inline: record.inline === true && validBooleans && validIdentities && effectiveResolverPolicy !== undefined,
    acceptLabel: readString(record.acceptLabel) ?? "Confirm",
    rejectLabel: readString(record.rejectLabel) ?? "Decline",
    rejectRequiresReason: record.rejectRequiresReason === true,
    allowDeclineReason: record.allowDeclineReason === true,
    rejectReasonLabel: readString(record.rejectReasonLabel) ?? "Reason",
    preparing: record.preparing === true,
    addresseeUserId: readString(record.addresseeUserId),
    effectiveResolverPolicy,
    createdByUserId: readString(record.createdByUserId),
  };
}

export function readFocusMetadata(frame: StoredAttentionFrame): FocusFrameMetadata {
  const metadata = asRecord(frame.metadata);
  const attention = asRecord(metadata?.attention);
  const semantic = asRecord(metadata?.semantic);
  const episode = asRecord(metadata?.episode);
  const issueIntelligence = asRecord(metadata?.issueIntelligence);
  const decision = asRecord(metadata?.decision);

  return {
    entityType: readString(metadata?.entityType),
    issueId: readString(metadata?.issueId),
    paperclipInteractionId: readString(metadata?.paperclipInteractionId),
    interactionKind: readString(metadata?.interactionKind),
    interactionDecision: readInteractionDecision(metadata?.interactionDecision),
    issueStatus: readString(metadata?.issueStatus),
    issuePriority: readString(metadata?.issuePriority),
    approvalStatus: readString(metadata?.approvalStatus),
    approvalType: readString(metadata?.approvalType),
    agentStatus: readString(metadata?.agentStatus),
    pauseReason: readNullableString(metadata?.pauseReason),
    liveReconciled: typeof metadata?.liveReconciled === "boolean" ? metadata.liveReconciled : undefined,
    activityPath: readString(metadata?.activityPath),
    attention: attention
      ? {
          rationale: readStringArray(attention.rationale),
        }
      : undefined,
    semantic: semantic
      ? {
          confidence:
            semantic.confidence === "low" || semantic.confidence === "medium" || semantic.confidence === "high"
              ? semantic.confidence
              : undefined,
          relationHints: readRelationHints(semantic.relationHints),
        }
      : undefined,
    episode: episode
      ? {
          size: typeof episode.size === "number" ? episode.size : undefined,
          state: readString(episode.state),
        }
      : undefined,
    issueIntelligence: issueIntelligence
      ? {
          matchedRuleIds: readStringArray(issueIntelligence.matchedRuleIds),
          owner: readNullableString(issueIntelligence.owner),
          ownerKind:
            issueIntelligence.ownerKind === "agent" || issueIntelligence.ownerKind === "human"
              ? issueIntelligence.ownerKind
              : issueIntelligence.ownerKind === null
                ? null
                : undefined,
          blockingTarget: readNullableString(issueIntelligence.blockingTarget),
        }
      : undefined,
    decision: decision
      ? {
          owner:
            decision.owner === "aperture_core"
            || decision.owner === "paperclip_reconciliation"
            || decision.owner === "approval_overlay"
            || decision.owner === "display_merge"
              ? decision.owner
              : undefined,
          lane:
            decision.lane === "now" || decision.lane === "next" || decision.lane === "ambient"
              ? decision.lane
              : undefined,
          sourcePolicy: readString(decision.sourcePolicy),
          rationale: readStringArray(decision.rationale),
          promotedFromLane:
            decision.promotedFromLane === "next" || decision.promotedFromLane === "ambient"
              ? decision.promotedFromLane
              : undefined,
        }
      : undefined,
  };
}

export function withFocusDecisionMetadata(
  frame: StoredAttentionFrame,
  decision: FocusDecisionMetadata,
): StoredAttentionFrame {
  const metadata = asRecord(frame.metadata) ?? {};
  const currentDecision = asRecord(metadata.decision) ?? {};
  const rationale = [
    ...(readStringArray(currentDecision.rationale) ?? []),
    ...(decision.rationale ?? []),
  ].filter((entry, index, entries) => entries.indexOf(entry) === index);

  return {
    ...frame,
    metadata: {
      ...metadata,
      decision: {
        ...currentDecision,
        ...decision,
        ...(rationale.length > 0 ? { rationale } : {}),
      },
    },
  };
}
