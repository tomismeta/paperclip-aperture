import type { Agent, Issue, IssueComment, PluginContext, PluginIssuesClient } from "@paperclipai/plugin-sdk";
import type { SemanticConfidence } from "@tomismeta/aperture-core/semantic";
import type { AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "./types.js";
import {
  agentStatusItem,
  agentTitleItem,
  blocksTargetItem,
  issuePriorityItem,
  issueStatusItem,
  latestCommentItem,
  needsActionFromItem,
  pauseReasonItem,
  recommendedMoveItem,
} from "./attention-context.js";
import { mergeStoredFrames, type FrameLane, type StoredFrameCandidate } from "./frame-model.js";
import {
  agentAttentionSummary,
  agentAttentionTitle,
  agentAttentionWhyNow,
} from "./attention-language.js";
import {
  analyzeIssueDocuments,
  analyzeIssueIntents,
  hasIntent,
  issueHeadline as issueHeadlineText,
  issueRecommendedMove,
  issueWhyNow,
  type IssueDocumentSignal,
  type IssueIntentAnalysis,
  type IssueActorDirectory,
  type LatestComment,
  truncate,
} from "./issue-intelligence.js";

type IssueDocumentSummary = Awaited<ReturnType<PluginIssuesClient["documents"]["list"]>>[number];

const COMMENT_LOOKUP_CONCURRENCY = 6;

function semanticMetadata(
  confidence: SemanticConfidence | null,
  relationHints: IssueIntentAnalysis["relationHints"],
): Record<string, unknown> | undefined {
  const semantic = {
    ...(confidence ? { confidence } : {}),
    ...(relationHints.length > 0 ? { relationHints } : {}),
  };

  return Object.keys(semantic).length > 0 ? semantic : undefined;
}

function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return value.toISOString();
}

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function acknowledgeResponseSpec() {
  return {
    kind: "acknowledge" as const,
    actions: [
      { id: "acknowledge", label: "Acknowledge", kind: "acknowledge" as const, emphasis: "primary" as const },
    ],
  };
}

function issueTitle(issue: Issue): string {
  return issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
}

type IssueFrameEvidence = {
  analysis: IssueIntentAnalysis;
  documentSignal: IssueDocumentSignal;
};

function latestComment(comments: IssueComment[]): LatestComment {
  if (comments.length === 0) return null;
  const newest = [...comments].sort(
    (left, right) => toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
  )[0];
  const updatedAt = toIsoString(newest.updatedAt) ?? toIsoString(newest.createdAt) ?? new Date(0).toISOString();
  return {
    body: truncate(newest.body),
    updatedAt,
  };
}

function priorityConsequence(issue: Issue): "low" | "medium" | "high" {
  return issue.priority === "critical" || issue.priority === "high" ? "high" : "medium";
}

function issueLane(issue: Issue, comment: LatestComment, evidence: IssueFrameEvidence): FrameLane | null {
  if (
    (issue.status === "blocked" || issue.status === "in_review")
    && (hasIntent(evidence.analysis, "resolution") || evidence.documentSignal.resolvesArtifactRequest)
  ) {
    return comment || issue.isUnreadForMe || evidence.documentSignal.hasDocuments ? "ambient" : null;
  }
  if (issue.status === "blocked") return issue.priority === "critical" ? "active" : "queued";
  if (issue.status === "in_review") return "queued";
  if (comment || issue.isUnreadForMe) return "ambient";
  return null;
}

function issueSummary(issue: Issue, evidence: IssueFrameEvidence): string {
  return issueHeadlineText(issue, evidence.analysis, evidence.documentSignal);
}

function issueProvenance(issue: Issue, evidence: IssueFrameEvidence) {
  return issueWhyNow(issue, evidence.analysis, evidence.documentSignal);
}

function issueAttentionTimestamp(
  issue: Issue,
  comment: LatestComment,
  documentSignal: IssueDocumentSignal,
): string {
  const commentSignals = [comment?.updatedAt, toIsoString(issue.lastExternalCommentAt), documentSignal.latestDocumentUpdatedAt]
    .filter((value): value is string => !!value)
    .sort();
  if (commentSignals.length > 0) return commentSignals.at(-1) as string;

  return toIsoString(issue.updatedAt)
    ?? toIsoString(issue.createdAt)
    ?? new Date(0).toISOString();
}

function issueFrame(
  issue: Issue,
  comment: LatestComment,
  documents: IssueDocumentSummary[],
  directory?: IssueActorDirectory,
): StoredFrameCandidate | null {
  const analysis = analyzeIssueIntents(issue, comment, directory);
  const documentSignal = analyzeIssueDocuments(documents, comment, analysis);
  const evidence: IssueFrameEvidence = { analysis, documentSignal };
  const lane = issueLane(issue, comment, evidence);
  if (!lane) return null;

  const updatedAt = issueAttentionTimestamp(issue, comment, documentSignal);
  const provenance = issueProvenance(issue, evidence);
  const owner = hasIntent(analysis, "resolution") || documentSignal.resolvesArtifactRequest ? null : analysis.owner;
  const move = issueRecommendedMove(issue, analysis, documentSignal);
  const target = analysis.blockingTarget;
  const semantic = semanticMetadata(analysis.semanticConfidence, analysis.relationHints);

  return {
    lane,
    frame: {
      id: `reconcile:issue:${issue.id}:${updatedAt}`,
      taskId: `issue:${issue.id}`,
      interactionId: `issue:${issue.id}:${issue.status}`,
      source: {
        id: "paperclip:issue",
        kind: "paperclip",
        label: "Paperclip issue",
      },
      version: 1,
      mode: "status",
      tone: issue.status === "blocked" ? "focused" : lane === "ambient" ? "ambient" : "focused",
      consequence: issue.status === "blocked" ? priorityConsequence(issue) : lane === "ambient" ? "low" : "medium",
      title: issueTitle(issue),
      summary: issueSummary(issue, evidence),
      context: {
        items: [
          ...(owner ? [needsActionFromItem(owner)] : []),
          ...(target ? [blocksTargetItem(target)] : []),
          ...(move ? [recommendedMoveItem(move)] : []),
          issueStatusItem(issue.status.replace(/_/g, " ")),
          issuePriorityItem(issue.priority),
          ...(comment ? [latestCommentItem(comment.body)] : []),
        ],
      },
      responseSpec: acknowledgeResponseSpec(),
      provenance,
      timing: {
        createdAt: toIsoString(issue.createdAt) ?? updatedAt,
        updatedAt,
      },
      metadata: {
        entityType: "issue",
        issueStatus: issue.status,
        issuePriority: issue.priority,
        liveReconciled: true,
        activityPath: comment ? "activity" : undefined,
        attention: {
          rationale: provenance.factors ?? [],
        },
        ...(semantic ? { semantic } : {}),
      },
    },
  };
}

function agentLane(agent: Agent): FrameLane | null {
  if (agent.status === "error") return "active";
  if (agent.status === "pending_approval") return "queued";
  if (agent.status === "paused" && agent.pauseReason === "budget") return "queued";
  if (agent.status === "paused") return "ambient";
  return null;
}

function agentProvenance(agent: Agent) {
  return agentAttentionWhyNow(agent);
}

function agentSummary(agent: Agent): string {
  return agentAttentionSummary(agent);
}

function agentFrame(agent: Agent): StoredFrameCandidate | null {
  const lane = agentLane(agent);
  if (!lane) return null;

  const updatedAt = toIsoString(agent.updatedAt) ?? toIsoString(agent.createdAt) ?? new Date(0).toISOString();
  const provenance = agentProvenance(agent);

  return {
    lane,
    frame: {
      id: `reconcile:agent:${agent.id}:${updatedAt}`,
      taskId: `agent:${agent.id}`,
      interactionId: `agent:${agent.id}:${agent.status}`,
      source: {
        id: "paperclip:agent",
        kind: "paperclip",
        label: "Paperclip agent",
      },
      version: 1,
      mode: "status",
      tone:
        agent.status === "error"
          ? "critical"
          : agent.pauseReason === "budget" || agent.status === "pending_approval"
            ? "focused"
            : "ambient",
      consequence:
        agent.status === "error" || agent.pauseReason === "budget"
          ? "high"
          : agent.status === "pending_approval"
            ? "medium"
            : "low",
      title: agentAttentionTitle(agent),
      summary: agentSummary(agent),
      context: {
        items: [
          agentStatusItem(agent.status.replace(/_/g, " ")),
          ...(agent.pauseReason ? [pauseReasonItem(agent.pauseReason)] : []),
          ...(agent.title ? [agentTitleItem(agent.title)] : []),
        ],
      },
      responseSpec: acknowledgeResponseSpec(),
      provenance,
      timing: {
        createdAt: toIsoString(agent.createdAt) ?? updatedAt,
        updatedAt,
      },
      metadata: {
        entityType: "agent",
        agentStatus: agent.status,
        pauseReason: agent.pauseReason,
        liveReconciled: true,
        activityPath: agent.status === "error" ? "activity" : undefined,
        attention: {
          rationale: provenance.factors ?? [],
        },
        semantic: {
          confidence: "high" as const,
        },
      },
    },
  };
}

async function safeListComments(ctx: PluginContext, issue: Issue): Promise<LatestComment> {
  try {
    const comments = await ctx.issues.listComments(issue.id, issue.companyId);
    return latestComment(comments);
  } catch (error) {
    ctx.logger.warn("Failed to load issue comments during Aperture reconciliation", {
      issueId: issue.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function safeListDocuments(
  ctx: PluginContext,
  issue: Issue,
): Promise<IssueDocumentSummary[]> {
  try {
    return await ctx.issues.documents.list(issue.id, issue.companyId);
  } catch (error) {
    ctx.logger.warn("Failed to load issue documents during Aperture reconciliation", {
      issueId: issue.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];

  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function loadIssueCandidates(ctx: PluginContext, companyId: string): Promise<StoredFrameCandidate[]> {
  const [blocked, inReview] = await Promise.all([
    ctx.issues.list({ companyId, status: "blocked", limit: 25 }),
    ctx.issues.list({ companyId, status: "in_review", limit: 25 }),
  ]);

  const issues = [...blocked, ...inReview];
  const [comments, documents, allAgents] = await Promise.all([
    mapWithConcurrency(
      issues,
      COMMENT_LOOKUP_CONCURRENCY,
      (issue) => safeListComments(ctx, issue),
    ),
    mapWithConcurrency(
      issues,
      COMMENT_LOOKUP_CONCURRENCY,
      (issue) => safeListDocuments(ctx, issue),
    ),
    ctx.agents.list({ companyId, limit: 100 }),
  ]);
  const directory: IssueActorDirectory = {
    agentNames: allAgents.map((agent) => agent.name).filter((name): name is string => typeof name === "string" && name.trim().length > 0),
  };

  return issues
    .map((issue, index) => issueFrame(issue, comments[index] ?? null, documents[index] ?? [], directory))
    .filter((candidate): candidate is StoredFrameCandidate => candidate !== null);
}

async function loadAgentCandidates(ctx: PluginContext, companyId: string): Promise<StoredFrameCandidate[]> {
  const [pendingApproval, errored, paused] = await Promise.all([
    ctx.agents.list({ companyId, status: "pending_approval", limit: 25 }),
    ctx.agents.list({ companyId, status: "error", limit: 25 }),
    ctx.agents.list({ companyId, status: "paused", limit: 25 }),
  ]);

  return [...pendingApproval, ...errored, ...paused]
    .map((agent) => agentFrame(agent))
    .filter((candidate): candidate is StoredFrameCandidate => candidate !== null);
}

export async function reconcileAttentionSnapshot(
  ctx: PluginContext,
  companyId: string,
  snapshot: AttentionSnapshot,
  review: AttentionReviewState | null,
  config: Record<string, unknown>,
): Promise<AttentionSnapshot> {
  const issueCandidatesPromise = config.captureIssueLifecycle === false
    ? Promise.resolve<StoredFrameCandidate[]>([])
    : loadIssueCandidates(ctx, companyId);

  const agentCandidatesPromise = loadAgentCandidates(ctx, companyId);

  const [issueCandidates, agentCandidates] = await Promise.all([
    issueCandidatesPromise,
    agentCandidatesPromise,
  ]);

  return mergeStoredFrames(snapshot, companyId, [...issueCandidates, ...agentCandidates], review);
}
