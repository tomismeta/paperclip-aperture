import type { SemanticConfidence, SemanticRelationHint } from "@tomismeta/aperture-core/semantic";
import type { StoredAttentionFrame } from "./types.js";

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

export type FocusFrameMetadata = {
  entityType?: string;
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

export function readFocusMetadata(frame: StoredAttentionFrame): FocusFrameMetadata {
  const metadata = asRecord(frame.metadata);
  const attention = asRecord(metadata?.attention);
  const semantic = asRecord(metadata?.semantic);
  const episode = asRecord(metadata?.episode);
  const issueIntelligence = asRecord(metadata?.issueIntelligence);

  return {
    entityType: readString(metadata?.entityType),
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
  };
}
