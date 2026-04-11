import type { Issue, PluginIssuesClient } from "@paperclipai/plugin-sdk";
import type { SemanticConfidence, SemanticRelationHint } from "@tomismeta/aperture-core/semantic";
import { createTaskId } from "./task-ref.js";

export type LatestComment = {
  body: string;
  updatedAt: string;
} | null;

type IssueDocumentSummary = Awaited<ReturnType<PluginIssuesClient["documents"]["list"]>>[number];

export type IssueIntentKey =
  | "clarification"
  | "resolution"
  | "share_with_board"
  | "confirmation"
  | "board_instruction"
  | "dependency_reference";

type IssueIntentDetector = {
  id: string;
  key: IssueIntentKey;
  pattern: RegExp;
  description: string;
};

const ISSUE_INTENT_DETECTORS: IssueIntentDetector[] = [
  { id: "clarification.generic", key: "clarification", pattern: /clarif|question|need info|need more|waiting on|feedback/i, description: "Signals that the thread is blocked on clarification or more information." },
  { id: "resolution.direction", key: "resolution", pattern: /final direction|lock these in|use these|not a request for iteration|you can proceed|ready to proceed|unblocked|resolved/i, description: "Signals that the latest guidance appears to resolve or unblock the thread." },
  { id: "artifact.share_with_board", key: "share_with_board", pattern: /share .* with the board/i, description: "Signals that a review artifact still needs to be shared with the board." },
  { id: "confirmation.explicit", key: "confirmation", pattern: /please review and confirm|review and confirm|confirm the direction|confirm whether|\bconfirm\b/i, description: "Signals an explicit confirmation step before work can continue." },
  { id: "board_instruction.explicit", key: "board_instruction", pattern: /(board should either .*?)(?:[.!?]|$)/i, description: "Signals explicit board-facing instructions in the latest operator text." },
  { id: "dependency.reference", key: "dependency_reference", pattern: /\b[A-Z]+-\d+\b/, description: "Signals a downstream dependency reference in the thread." },
];

export type IssueIntentAnalysis = {
  text: string;
  owner: string | null;
  ownerKind: "agent" | "human" | null;
  blockingTarget: string | null;
  intents: Set<IssueIntentKey>;
  matchedRuleIds: string[];
  explicitBoardInstruction: string | null;
  semanticConfidence: SemanticConfidence | null;
  relationHints: SemanticRelationHint[];
};

export type IssueActorDirectory = {
  agentNames: string[];
};

export type IssueDocumentSignal = {
  hasDocuments: boolean;
  latestDocumentTitle: string | null;
  latestDocumentUpdatedAt: string | null;
  resolvesArtifactRequest: boolean;
};

function titleCase(value: string): string {
  if (value.toUpperCase() === value) return value;
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

export function actorPhrase(value: string): string {
  return value.toUpperCase() === value ? value : value.toLowerCase();
}

export function truncate(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function issueText(issue: Issue, comment: LatestComment): string {
  return [comment?.body, issue.description].filter((value): value is string => !!value).join("\n");
}

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function normalizeActorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function issueRelationTarget(issueId: string): string {
  return createTaskId("issue", issueId);
}

function detectIssueIntents(text: string): {
  intents: Set<IssueIntentKey>;
  matchedRuleIds: string[];
} {
  const intents = new Set<IssueIntentKey>();
  const matchedRuleIds: string[] = [];

  for (const detector of ISSUE_INTENT_DETECTORS) {
    if (detector.pattern.test(text)) {
      intents.add(detector.key);
      matchedRuleIds.push(detector.id);
    }
  }

  return {
    intents,
    matchedRuleIds,
  };
}

function blockingTargetForText(text: string, identifier?: string | null): string | null {
  const normalizedIdentifier = identifier?.toUpperCase();
  const matches = text.match(/\b[A-Z]+-\d+\b/g) ?? [];
  return matches.find((match) => match.toUpperCase() !== normalizedIdentifier) ?? null;
}

function explicitBoardInstructionForText(text: string): string | null {
  return text.replace(/\s+/g, " ").trim().match(/(board should either .*?)(?:[.!?]|$)/i)?.[1] ?? null;
}

function semanticConfidenceForIntents(intents: Set<IssueIntentKey>): SemanticConfidence | null {
  if (
    intents.has("resolution")
    || intents.has("share_with_board")
    || intents.has("confirmation")
    || intents.has("board_instruction")
  ) {
    return "high";
  }

  if (intents.has("clarification")) return "medium";
  return null;
}

function relationHintsForIntents(
  intents: Set<IssueIntentKey>,
  issueTarget?: string | null,
): SemanticRelationHint[] {
  const hints: SemanticRelationHint[] = [];
  const target = issueTarget ?? undefined;

  if (target) {
    hints.push({ kind: "same_issue", target });
  }

  if (intents.has("resolution")) {
    hints.push(target ? { kind: "resolves", target } : { kind: "resolves" });
    return hints;
  }

  if (
    intents.has("share_with_board")
    || intents.has("confirmation")
    || intents.has("board_instruction")
  ) {
    hints.push(target ? { kind: "supersedes", target } : { kind: "supersedes" });
    return hints;
  }

  if (intents.has("clarification")) {
    hints.push(target ? { kind: "repeats", target } : { kind: "repeats" });
  }

  return hints;
}

export function analyzeIssueTextSemantics(input: {
  text: string;
  identifier?: string | null;
  issueTarget?: string | null;
}): Pick<IssueIntentAnalysis, "text" | "blockingTarget" | "intents" | "matchedRuleIds" | "explicitBoardInstruction" | "semanticConfidence" | "relationHints"> {
  const { intents, matchedRuleIds } = detectIssueIntents(input.text);

  return {
    text: input.text,
    blockingTarget: blockingTargetForText(input.text, input.identifier),
    intents,
    matchedRuleIds,
    explicitBoardInstruction: explicitBoardInstructionForText(input.text),
    semanticConfidence: semanticConfidenceForIntents(intents),
    relationHints: relationHintsForIntents(intents, input.issueTarget),
  };
}

function resolveAgentOwner(text: string, directory: IssueActorDirectory | undefined): string | null {
  if (!directory || directory.agentNames.length === 0) return null;

  const mentionMatch = text.match(/needed from\s+@([a-z0-9_-]+)/i) ?? text.match(/@([a-z0-9_-]+)/i);
  if (mentionMatch?.[1]) {
    const mentionKey = normalizeActorKey(mentionMatch[1]);
    const fromMention = directory.agentNames.find((name) => normalizeActorKey(name) === mentionKey);
    if (fromMention) return fromMention;
  }

  return [...directory.agentNames]
    .sort((left, right) => right.length - left.length)
    .find((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, "i").test(text))
    ?? null;
}

export function analyzeIssueIntents(
  issue: Issue,
  comment: LatestComment,
  directory?: IssueActorDirectory,
): IssueIntentAnalysis {
  const text = issueText(issue, comment);
  const semanticAnalysis = analyzeIssueTextSemantics({
    text,
    identifier: issue.identifier,
    issueTarget: issueRelationTarget(issue.id),
  });

  const agentOwner = resolveAgentOwner(text, directory);
  const mentionMatch = text.match(/needed from\s+@([a-z0-9_-]+)/i) ?? text.match(/@([a-z0-9_-]+)/i);
  const owner = agentOwner
    ?? (mentionMatch?.[1]
      ? titleCase(mentionMatch[1])
      : /board should|board can/i.test(text)
        ? "Board"
        : /ceo agent|@ceo|\bceo\b/i.test(text)
          ? "CEO"
          : /requires human|waiting on human|human review/i.test(text)
            ? "Human"
            : /operator intervention|operator review/i.test(text)
              ? "Operator"
              : null);
  const ownerKind = agentOwner
    ? "agent"
    : owner
      ? "human"
      : null;

  return {
    ...semanticAnalysis,
    owner,
    ownerKind,
  };
}

export function hasIntent(analysis: IssueIntentAnalysis, key: IssueIntentKey): boolean {
  return analysis.intents.has(key);
}

export function ownerPhrase(value: string, ownerKind: "agent" | "human" | null): string {
  if (ownerKind === "agent") return value;
  return actorPhrase(value);
}

function latestIssueDocument(documents: IssueDocumentSummary[]): IssueDocumentSummary | null {
  if (documents.length === 0) return null;

  return [...documents].sort(
    (left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
  )[0] ?? null;
}

export function analyzeIssueDocuments(
  documents: IssueDocumentSummary[],
  comment: LatestComment,
  analysis: IssueIntentAnalysis,
): IssueDocumentSignal {
  const latest = latestIssueDocument(documents);
  const latestUpdatedAt = toIsoString(latest?.updatedAt);
  const commentUpdatedAt = comment?.updatedAt ?? null;

  return {
    hasDocuments: documents.length > 0,
    latestDocumentTitle: latest?.title ?? null,
    latestDocumentUpdatedAt: latestUpdatedAt,
    resolvesArtifactRequest:
      hasIntent(analysis, "share_with_board")
      && !!latest
      && (!commentUpdatedAt || toTimestamp(latestUpdatedAt) >= toTimestamp(commentUpdatedAt)),
  };
}

export function issueRecommendedMove(
  issue: Issue,
  analysis: IssueIntentAnalysis,
  documentSignal?: IssueDocumentSignal,
): string | null {
  const normalized = analysis.text.replace(/\s+/g, " ").trim();

  if (documentSignal?.resolvesArtifactRequest) {
    return "Monitor the review now that the memo is attached.";
  }

  if (hasIntent(analysis, "resolution")) {
    return "Monitor execution and confirm the team resumes work.";
  }

  if (hasIntent(analysis, "share_with_board")) {
    return "Share the memo with the board so review can continue.";
  }

  if (analysis.explicitBoardInstruction) return truncate(analysis.explicitBoardInstruction, 140);

  if (hasIntent(analysis, "confirmation")) {
    return analysis.blockingTarget
      ? `Confirm the direction so ${analysis.blockingTarget} can proceed.`
      : "Review the draft and confirm whether work should proceed.";
  }

  if (/leave a comment/i.test(normalized)) {
    return "Leave a comment with enough context for work to resume.";
  }

  if (/complete [A-Z]+-\d+/i.test(normalized)) {
    return "Complete the blocking dependency or add enough context to proceed.";
  }

  if (issue.status === "blocked") {
    return "Unblock the dependency or add the missing context needed to continue.";
  }

  if (issue.status === "in_review") {
    return "Review the issue and decide whether work can continue.";
  }

  return null;
}

export function issueHeadline(
  issue: Issue,
  analysis: IssueIntentAnalysis,
  documentSignal?: IssueDocumentSignal,
): string {
  if (documentSignal?.resolvesArtifactRequest) {
    return "The requested memo appears attached, so review should be able to continue.";
  }

  if (hasIntent(analysis, "resolution")) {
    return "Latest operator guidance appears to unblock this issue.";
  }

  if (hasIntent(analysis, "share_with_board")) {
    return "Board still needs the memo before review can continue.";
  }

  if (hasIntent(analysis, "confirmation") && analysis.blockingTarget) {
    return `Waiting on confirmation before ${analysis.blockingTarget} can proceed.`;
  }

  const clarification = hasIntent(analysis, "clarification");
  const owner = analysis.owner;

  if (issue.status === "blocked" && owner) {
    return clarification
      ? `Blocked on ${ownerPhrase(owner, analysis.ownerKind)} clarification before work can continue.`
      : `Blocked on ${ownerPhrase(owner, analysis.ownerKind)} action before work can continue.`;
  }

  if (issue.status === "blocked") {
    return clarification
      ? "Blocked issue waiting on clarification before work can continue."
      : "Blocked issue that may need operator intervention to move forward.";
  }

  if (issue.status === "in_review") {
    return owner
      ? `Waiting on ${ownerPhrase(owner, analysis.ownerKind)} review before work can continue.`
      : "Issue is waiting on human review before work can continue.";
  }

  if (issue.description) return truncate(issue.description);
  return "This issue has new operator-relevant activity.";
}

export function issueWhyNow(
  issue: Issue,
  analysis: IssueIntentAnalysis,
  documentSignal?: IssueDocumentSignal,
): { whyNow: string; factors: string[] } {
  if (documentSignal?.resolvesArtifactRequest) {
    return {
      whyNow: documentSignal.latestDocumentTitle
        ? `${documentSignal.latestDocumentTitle} was attached after the request, so the missing artifact appears resolved.`
        : "A review document was attached after the request, so the missing artifact appears resolved.",
      factors: ["document attached", "review can proceed"],
    };
  }

  if (hasIntent(analysis, "resolution")) {
    return {
      whyNow: "The latest comment appears to resolve the blocker; monitor execution rather than intervening.",
      factors: ["comment follow-up"],
    };
  }

  if (hasIntent(analysis, "share_with_board")) {
    return {
      whyNow: "The board still needs the memo before review can continue.",
      factors: ["waiting on human", "issue review"],
    };
  }

  if (hasIntent(analysis, "confirmation") && analysis.blockingTarget) {
    return {
      whyNow: `${analysis.blockingTarget} is waiting on explicit confirmation before work can continue.`,
      factors: ["waiting on human", "issue review"],
    };
  }

  const owner = analysis.owner;
  if (issue.status === "blocked") {
    const clarification = hasIntent(analysis, "clarification");
    return {
      whyNow: owner
        ? clarification
          ? `This issue is blocked on clarification from ${ownerPhrase(owner, analysis.ownerKind)}.`
          : `This issue is blocked on action from ${ownerPhrase(owner, analysis.ownerKind)}.`
        : clarification
          ? "This issue is blocked on clarification from a human."
          : "This issue is blocked and may need operator intervention.",
      factors: clarification
        ? ["blocked", "needs clarification", "waiting on human"]
        : ["blocked", "operator review"],
    };
  }

  if (issue.status === "in_review") {
    return {
      whyNow: "This issue is waiting on human review before work can continue.",
      factors: ["waiting on human", "issue review"],
    };
  }

  return {
    whyNow: "A recent issue comment added operator-relevant context.",
    factors: ["comment follow-up"],
  };
}

export function issueBlocksTargetLine(target: string): string {
  return `Blocks ${target} until the review lands.`;
}

export function issueNeedsActionFromLine(owner: string): string {
  return `Needs action from ${owner}.`;
}
