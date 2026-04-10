import type { SemanticConfidence, SemanticRelationHint } from "@tomismeta/aperture-core/semantic";
import type { FrameLane } from "./frame-model.js";
import type { StoredAttentionFrame } from "./types.js";
import { readFocusMetadata } from "./contracts.js";

export type FrameExplainability = {
  whyNow: string | null;
  laneReason: string;
  signalStrength: SemanticConfidence | null;
  signals: string[];
  relationLabels: string[];
  continuity: string | null;
};

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readSemanticConfidence(frame: StoredAttentionFrame): SemanticConfidence | null {
  const confidence = readFocusMetadata(frame).semantic?.confidence;
  return confidence === "low" || confidence === "medium" || confidence === "high" ? confidence : null;
}

function readSemanticRelationHints(frame: StoredAttentionFrame): SemanticRelationHint[] {
  return readFocusMetadata(frame).semantic?.relationHints ?? [];
}

function relationHintLabel(hint: SemanticRelationHint): string {
  switch (hint.kind) {
    case "same_issue":
      return "Part of the same thread";
    case "resolves":
      return "Resolves an earlier blocker";
    case "supersedes":
      return "Moves the request forward";
    case "repeats":
      return "Repeats an earlier ask";
    case "escalates":
      return "Raises the urgency";
  }
}

function laneReason(lane: FrameLane): string {
  switch (lane) {
    case "now":
      return "This is the most urgent item in the queue right now.";
    case "next":
      return "This is staged behind the current top item.";
    case "ambient":
      return "This is visible for awareness without needing action yet.";
  }
}

function continuitySummary(frame: StoredAttentionFrame): string | null {
  const episode = readFocusMetadata(frame).episode;
  const size = episode?.size ?? null;
  const state = episode?.state?.replace(/_/g, " ") ?? null;

  if (!size || size <= 1) return null;
  if (state) return `Part of a ${state} thread with ${size} related interactions.`;
  return `Part of a thread with ${size} related interactions.`;
}

function frameSignals(frame: StoredAttentionFrame): string[] {
  const rationale = readFocusMetadata(frame).attention?.rationale ?? [];
  const factors = readStringArray(frame.provenance?.factors);
  return [...new Set([...(rationale.length > 0 ? rationale : factors), ...factors])];
}

export function signalStrengthLabel(confidence: SemanticConfidence): string {
  return `${confidence} confidence`;
}

export function explainFrame(frame: StoredAttentionFrame, lane: FrameLane): FrameExplainability {
  const relationLabels = [...new Set(readSemanticRelationHints(frame).map(relationHintLabel))];

  return {
    whyNow: frame.provenance?.whyNow ?? frame.summary ?? null,
    laneReason: laneReason(lane),
    signalStrength: readSemanticConfidence(frame),
    signals: frameSignals(frame),
    relationLabels,
    continuity: continuitySummary(frame),
  };
}
