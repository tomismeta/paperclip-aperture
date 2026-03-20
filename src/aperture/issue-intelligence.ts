import type { Issue } from "@paperclipai/plugin-sdk";

export type LatestComment = {
  body: string;
  updatedAt: string;
} | null;

export type IssueIntentKey =
  | "clarification"
  | "resolution"
  | "share_with_board"
  | "confirmation"
  | "board_instruction"
  | "dependency_reference";

type IssueIntentDetector = {
  key: IssueIntentKey;
  pattern: RegExp;
};

const ISSUE_INTENT_DETECTORS: IssueIntentDetector[] = [
  { key: "clarification", pattern: /clarif|question|need info|need more|waiting on|feedback/i },
  { key: "resolution", pattern: /final direction|lock these in|use these|not a request for iteration|proceed to|proceed\.|unblock|ready to proceed/i },
  { key: "share_with_board", pattern: /share .* with the board/i },
  { key: "confirmation", pattern: /please review and confirm|review and confirm|confirm the direction|confirm whether/i },
  { key: "board_instruction", pattern: /(board should either .*?)(?:[.!?]|$)/i },
  { key: "dependency_reference", pattern: /\b[A-Z]+-\d+\b/ },
];

export type IssueIntentAnalysis = {
  text: string;
  owner: string | null;
  ownerKind: "agent" | "human" | null;
  blockingTarget: string | null;
  intents: Set<IssueIntentKey>;
  explicitBoardInstruction: string | null;
};

export type IssueActorDirectory = {
  agentNames: string[];
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

function normalizeActorKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const intents = new Set<IssueIntentKey>();

  for (const detector of ISSUE_INTENT_DETECTORS) {
    if (detector.pattern.test(text)) intents.add(detector.key);
  }

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

  const identifier = issue.identifier?.toUpperCase();
  const matches = text.match(/\b[A-Z]+-\d+\b/g) ?? [];
  const blockingTarget = matches.find((match) => match.toUpperCase() !== identifier) ?? null;
  const explicitBoardInstruction = text.replace(/\s+/g, " ").trim().match(/(board should either .*?)(?:[.!?]|$)/i)?.[1] ?? null;

  return {
    text,
    owner,
    ownerKind,
    blockingTarget,
    intents,
    explicitBoardInstruction,
  };
}

export function hasIntent(analysis: IssueIntentAnalysis, key: IssueIntentKey): boolean {
  return analysis.intents.has(key);
}

export function ownerPhrase(value: string, ownerKind: "agent" | "human" | null): string {
  if (ownerKind === "agent") return value;
  return actorPhrase(value);
}

export function issueRecommendedMove(issue: Issue, analysis: IssueIntentAnalysis): string | null {
  const normalized = analysis.text.replace(/\s+/g, " ").trim();

  if (hasIntent(analysis, "resolution")) {
    return "Monitor execution and confirm the team resumes work.";
  }

  if (hasIntent(analysis, "share_with_board")) {
    return "Share the memo with the board so review can continue.";
  }

  if (hasIntent(analysis, "confirmation")) {
    return analysis.blockingTarget
      ? `Confirm the direction so ${analysis.blockingTarget} can proceed.`
      : "Review the draft and confirm whether work should proceed.";
  }

  if (analysis.explicitBoardInstruction) return truncate(analysis.explicitBoardInstruction, 140);

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

export function issueHeadline(issue: Issue, analysis: IssueIntentAnalysis): string {
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

export function issueWhyNow(issue: Issue, analysis: IssueIntentAnalysis): { whyNow: string; factors: string[] } {
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
