import type { Agent, Issue, IssueComment, PluginContext, PluginIssuesClient } from "@paperclipai/plugin-sdk";
import type { SemanticConfidence } from "@tomismeta/aperture-core/semantic";
import type { AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "./types.js";
import type { ApertureCompanyStore } from "./core-store.js";
import {
  agentStatusItem,
  agentTitleItem,
  blockedByItem,
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
import { createInteractionId, createTaskId } from "./task-ref.js";
import { withFocusDecisionMetadata } from "./contracts.js";

type IssueDocumentSummary = Awaited<ReturnType<PluginIssuesClient["documents"]["list"]>>[number];
type IssueRelationSummary = Awaited<ReturnType<PluginIssuesClient["relations"]["get"]>>;
type IssueRelationIssueSummary = IssueRelationSummary["blockedBy"][number];

const COMMENT_LOOKUP_CONCURRENCY = 6;
const ISSUE_LIST_TTL_MS = 15_000;
const ISSUE_COMMENTS_TTL_MS = 15_000;
const ISSUE_DOCUMENTS_TTL_MS = 15_000;
const ISSUE_RELATIONS_TTL_MS = 15_000;
const AGENT_LIST_TTL_MS = 15_000;

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
  relations: IssueRelationSummary | null;
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
  if (issue.status === "blocked") return issue.priority === "critical" ? "now" : "next";
  if (issue.status === "in_review") return "next";
  if (comment || issue.isUnreadForMe) return "ambient";
  return null;
}

function isResolvedRelationIssue(issue: IssueRelationIssueSummary): boolean {
  return issue.status === "done" || issue.status === "cancelled";
}

function unresolvedBlockers(relations: IssueRelationSummary | null): IssueRelationIssueSummary[] {
  return relations?.blockedBy.filter((issue) => !isResolvedRelationIssue(issue)) ?? [];
}

function primaryUnresolvedBlocker(relations: IssueRelationSummary | null): IssueRelationIssueSummary | null {
  return unresolvedBlockers(relations)[0] ?? null;
}

function relationIssueLabel(issue: IssueRelationIssueSummary): string {
  return issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
}

function relationContextLabel(relations: IssueRelationSummary | null): string | null {
  const blockers = unresolvedBlockers(relations);
  if (blockers.length === 0) return null;

  const [first, ...rest] = blockers;
  const label = relationIssueLabel(first);
  return rest.length > 0 ? `${label} +${rest.length} more` : label;
}

function relationMetadata(relations: IssueRelationSummary | null): Record<string, unknown> | undefined {
  if (!relations || (relations.blockedBy.length === 0 && relations.blocks.length === 0)) return undefined;

  const summarize = (issue: IssueRelationIssueSummary) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
  });

  return {
    blockedBy: relations.blockedBy.map(summarize),
    blocks: relations.blocks.map(summarize),
  };
}

function issueSummary(issue: Issue, evidence: IssueFrameEvidence): string {
  const blocker = primaryUnresolvedBlocker(evidence.relations);
  if (blocker) return `${relationIssueLabel(blocker)} is a tracked blocker for this issue.`;

  return issueHeadlineText(issue, evidence.analysis, evidence.documentSignal);
}

function issueProvenance(issue: Issue, evidence: IssueFrameEvidence) {
  const base = issueWhyNow(issue, evidence.analysis, evidence.documentSignal);
  const blocker = primaryUnresolvedBlocker(evidence.relations);
  if (!blocker) return base;

  return {
    ...base,
    whyNow: `${relationIssueLabel(blocker)} is linked as a blocker in Paperclip.`,
    factors: [...new Set([...(base.factors ?? []), "blocked by issue relation"])],
  };
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
  relations: IssueRelationSummary | null,
  directory?: IssueActorDirectory,
): StoredFrameCandidate | null {
  const analysis = analyzeIssueIntents(issue, comment, directory);
  const documentSignal = analyzeIssueDocuments(documents, comment, analysis);
  const evidence: IssueFrameEvidence = { analysis, documentSignal, relations };
  const lane = issueLane(issue, comment, evidence);
  if (!lane) return null;

  const updatedAt = issueAttentionTimestamp(issue, comment, documentSignal);
  const provenance = issueProvenance(issue, evidence);
  const owner = hasIntent(analysis, "resolution") || documentSignal.resolvesArtifactRequest ? null : analysis.owner;
  const move = issueRecommendedMove(issue, analysis, documentSignal);
  const target = analysis.blockingTarget;
  const semantic = semanticMetadata(analysis.semanticConfidence, analysis.relationHints);
  const taskId = createTaskId("issue", issue.id);
  const blockedBy = relationContextLabel(relations);
  const relationsMetadata = relationMetadata(relations);

  return {
    lane,
    frame: withFocusDecisionMetadata({
      id: `reconcile:issue:${issue.id}:${updatedAt}`,
      taskId,
      interactionId: createInteractionId(taskId, issue.status),
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
          ...(blockedBy ? [blockedByItem(blockedBy)] : []),
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
          issueIntelligence: {
            matchedRuleIds: analysis.matchedRuleIds,
            owner: analysis.owner,
            ownerKind: analysis.ownerKind,
            blockingTarget: analysis.blockingTarget,
          },
          ...(relationsMetadata ? { issueRelations: relationsMetadata } : {}),
          ...(semantic ? { semantic } : {}),
        },
    }, {
      owner: "paperclip_reconciliation",
      lane,
      sourcePolicy: `issue.${issue.status}.${issue.priority}`,
      rationale: provenance.factors ?? [],
    }),
  };
}

function agentLane(agent: Agent): FrameLane | null {
  if (agent.status === "error") return "now";
  if (agent.status === "pending_approval") return "next";
  if (agent.status === "paused" && agent.pauseReason === "budget") return "next";
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
  const taskId = createTaskId("agent", agent.id);

  return {
    lane,
    frame: withFocusDecisionMetadata({
      id: `reconcile:agent:${agent.id}:${updatedAt}`,
      taskId,
      interactionId: createInteractionId(taskId, agent.status),
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
    }, {
      owner: "paperclip_reconciliation",
      lane,
      sourcePolicy: `agent.${agent.status}${agent.pauseReason ? `.${agent.pauseReason}` : ""}`,
      rationale: provenance.factors ?? [],
    }),
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

async function cachedRead<T>(
  store: ApertureCompanyStore,
  companyId: string,
  key: string,
  ttlMs: number,
  options: { fresh?: boolean } | undefined,
  loader: () => Promise<T>,
): Promise<T> {
  if (!options?.fresh) {
    const cached = store.getCachedHostValue<T>(companyId, key);
    if (cached !== null) return cached;
  }
  const value = await loader();
  return store.setCachedHostValue(companyId, key, value, ttlMs);
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

async function safeListRelations(
  ctx: PluginContext,
  issue: Issue,
): Promise<IssueRelationSummary | null> {
  const inlineBlockedBy = issue.blockedBy ?? [];
  const inlineBlocks = issue.blocks ?? [];
  if (inlineBlockedBy.length > 0 || inlineBlocks.length > 0) {
    return {
      blockedBy: inlineBlockedBy,
      blocks: inlineBlocks,
    };
  }

  try {
    return await ctx.issues.relations.get(issue.id, issue.companyId);
  } catch (error) {
    ctx.logger.warn("Failed to load issue relations during Aperture reconciliation", {
      issueId: issue.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
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

async function loadIssuesForStatus(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  status: "blocked" | "in_review",
  options?: { freshHostData?: boolean },
): Promise<Issue[]> {
  return cachedRead(store, companyId, `issues:${status}`, ISSUE_LIST_TTL_MS, { fresh: options?.freshHostData }, async () => (
    await ctx.issues.list({ companyId, status, limit: 25 })
  ));
}

async function loadAllAgents(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  options?: { freshHostData?: boolean },
): Promise<Agent[]> {
  return cachedRead(store, companyId, "agents:all", AGENT_LIST_TTL_MS, { fresh: options?.freshHostData }, async () => (
    await ctx.agents.list({ companyId, limit: 100 })
  ));
}

async function loadIssueCandidates(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  allAgents: Agent[],
  options?: { freshHostData?: boolean },
): Promise<StoredFrameCandidate[]> {
  const [blocked, inReview] = await Promise.all([
    loadIssuesForStatus(ctx, store, companyId, "blocked", options),
    loadIssuesForStatus(ctx, store, companyId, "in_review", options),
  ]);

  const issues = [...blocked, ...inReview];
  const [comments, documents, relations] = await Promise.all([
    mapWithConcurrency(
      issues,
      COMMENT_LOOKUP_CONCURRENCY,
      (issue) => cachedRead(
        store,
        companyId,
        `issue:${issue.id}:comments`,
        ISSUE_COMMENTS_TTL_MS,
        { fresh: options?.freshHostData },
        () => safeListComments(ctx, issue),
      ),
    ),
    mapWithConcurrency(
      issues,
      COMMENT_LOOKUP_CONCURRENCY,
      (issue) => cachedRead(
        store,
        companyId,
        `issue:${issue.id}:documents`,
        ISSUE_DOCUMENTS_TTL_MS,
        { fresh: options?.freshHostData },
        () => safeListDocuments(ctx, issue),
      ),
    ),
    mapWithConcurrency(
      issues,
      COMMENT_LOOKUP_CONCURRENCY,
      (issue) => cachedRead(
        store,
        companyId,
        `issue:${issue.id}:relations`,
        ISSUE_RELATIONS_TTL_MS,
        { fresh: options?.freshHostData },
        () => safeListRelations(ctx, issue),
      ),
    ),
  ]);
  const directory: IssueActorDirectory = {
    agentNames: allAgents.map((agent) => agent.name).filter((name): name is string => typeof name === "string" && name.trim().length > 0),
  };

  return issues
    .map((issue, index) => issueFrame(issue, comments[index] ?? null, documents[index] ?? [], relations[index] ?? null, directory))
    .filter((candidate): candidate is StoredFrameCandidate => candidate !== null);
}

function loadAgentCandidates(allAgents: Agent[]): StoredFrameCandidate[] {
  return allAgents
    .filter((agent) => agent.status === "pending_approval" || agent.status === "error" || agent.status === "paused")
    .map((agent) => agentFrame(agent))
    .filter((candidate): candidate is StoredFrameCandidate => candidate !== null);
}

export async function loadReconciledCandidates(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  config: Record<string, unknown>,
  options?: { freshHostData?: boolean },
): Promise<StoredFrameCandidate[]> {
  const allAgents = await loadAllAgents(ctx, store, companyId, options);
  const issueCandidatesPromise = config.captureIssueLifecycle === false
    ? Promise.resolve<StoredFrameCandidate[]>([])
    : loadIssueCandidates(ctx, store, companyId, allAgents, options);

  const agentCandidatesPromise = Promise.resolve(loadAgentCandidates(allAgents));

  const [issueCandidates, agentCandidates] = await Promise.all([
    issueCandidatesPromise,
    agentCandidatesPromise,
  ]);

  return [...issueCandidates, ...agentCandidates];
}

export async function reconcileAttentionSnapshot(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  snapshot: AttentionSnapshot,
  review: AttentionReviewState | null,
  config: Record<string, unknown>,
): Promise<AttentionSnapshot> {
  const candidates = await loadReconciledCandidates(ctx, store, companyId, config);
  return mergeStoredFrames(snapshot, companyId, candidates, review);
}
