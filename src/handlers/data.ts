import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import type { IssueThreadInteraction } from "@paperclipai/plugin-sdk/types";
import { mergeSnapshotWithApprovals, type ApprovalRecord } from "../aperture/approval-frames.js";
import { FOCUS_SURFACE_CAPABILITIES } from "../aperture/core-capabilities.js";
import { loadReconciledCandidates } from "../aperture/reconciliation.js";
import { buildOverlayDiagnostics } from "../aperture/overlay-diagnostics.js";
import { applyDisplayEngagement, mergeStoredFrames, type DisplayEngagement, type StoredFrameCandidate } from "../aperture/frame-model.js";
import { readFocusMetadata, readPaperclipRunRecoveryMetadata } from "../aperture/contracts.js";
import { parseTaskId, taskIdMatchesKind } from "../aperture/task-ref.js";
import {
  type AttentionCoreDiagnostics,
  type AttentionDisplayPayload,
  type AttentionExport,
  type AttentionOverlayDiagnostics,
  createEmptySnapshot,
  type AttentionLedgerEventEntry,
  type AttentionLedgerOverlayResponseEntry,
  type AttentionReplayScenario,
  type AttentionLedgerResponseEntry,
  type AttentionLedgerSignalEntry,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "../aperture/types.js";
import { ApertureCompanyStore } from "../aperture/core-store.js";
import {
  ensureAttentionState,
  isInvocationScopeDenied,
  requireCompanyId,
} from "./shared.js";

const DEFAULT_EXPORT_ENTRY_LIMIT = 250;
const DEFAULT_EXPORT_TRACE_LIMIT = 50;
const MAX_EXPORT_ENTRY_LIMIT = 1000;
const MAX_EXPORT_TRACE_LIMIT = 200;

function emptyCoreDiagnostics(exportedAt: string): AttentionCoreDiagnostics {
  return {
    eventCount: 0,
    persistence: { state: "healthy" },
    surfaceCapabilities: FOCUS_SURFACE_CAPABILITIES,
    operatorPresence: "present",
    globalSignalSummary: {
      recentSignals: 0,
      lifetimeSignals: 0,
      counts: {
        presented: 0,
        viewed: 0,
        responded: 0,
        dismissed: 0,
        deferred: 0,
        contextExpanded: 0,
        contextSkipped: 0,
        timedOut: 0,
        returned: 0,
        attentionShifted: 0,
      },
      deferred: {
        next: 0,
        suppressed: 0,
        manual: 0,
      },
      responseRate: 0,
      dismissalRate: 0,
      averageResponseLatencyMs: null,
      averageDismissalLatencyMs: null,
      lastSignalAt: null,
    },
    globalAttentionState: "monitoring",
    memoryProfile: {
      version: 1,
      operatorId: "unknown",
      updatedAt: exportedAt,
      sessionCount: 0,
    },
    ledger: {
      entries: 0,
      eventEntries: 0,
      responseEntries: 0,
      overlayResponseEntries: 0,
      signalEntries: 0,
      replayStrategy: "full-ledger",
      compactionRecommended: false,
    },
    host: {
      cacheEntries: 0,
      hostDataRevision: 0,
      approvalRecords: 0,
      approvalsDirty: false,
    },
    currentNowTask: null,
  };
}

function boundedPositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  if (normalized <= 0) return fallback;
  return Math.min(normalized, max);
}

function tailWindow<T>(items: T[], limit: number): {
  items: T[];
  total: number;
  hasMoreBefore: boolean;
} {
  const total = items.length;
  const normalizedLimit = Math.max(1, limit);
  if (total <= normalizedLimit) {
    return {
      items: [...items],
      total,
      hasMoreBefore: false,
    };
  }

  return {
    items: items.slice(-normalizedLimit),
    total,
    hasMoreBefore: true,
  };
}


function reconciliationCacheKey(
  store: ApertureCompanyStore,
  companyId: string,
  config: Record<string, unknown>,
): string {
  return JSON.stringify({
    reconciliationRevision: store.getReconciledRevision(companyId),
    captureIssueLifecycle: config.captureIssueLifecycle !== false,
    captureRunFailures: config.captureRunFailures !== false,
  });
}

async function loadReconciledAttentionSnapshot(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  snapshot: AttentionSnapshot,
  reviewState: AttentionReviewState,
  options: { preferCache?: boolean; freshHostData?: boolean } = {},
): Promise<{
  snapshot: AttentionSnapshot;
  reconciliationSyncError?: string;
  composeLatest: () => AttentionSnapshot;
}> {
  const config = await ctx.config.get(companyId);
  const useCache = options.preferCache && !options.freshHostData;
  let cacheKey = reconciliationCacheKey(store, companyId, config);
  const mergeCandidates = (candidates: StoredFrameCandidate[], complete: boolean): AttentionSnapshot => {
    const currentSnapshot = store.getSnapshot(companyId) ?? snapshot;
    const currentReview = store.getReview(companyId) ?? reviewState;
    const currentTasks = new Set([
      ...(currentSnapshot.now ? [currentSnapshot.now.taskId] : []),
      ...currentSnapshot.next.map((frame) => frame.taskId),
      ...currentSnapshot.ambient.map((frame) => frame.taskId),
    ]);
    const knownIssues = store.getCachedHostValue<Issue[]>(companyId, "issues:all");
    const issuesById = new Map(knownIssues?.map((issue) => [issue.id, issue]));
    const applicable = candidates.filter(({ frame }) => {
      if (config.captureIssueLifecycle === false && taskIdMatchesKind(frame.taskId, "issue")) return false;
      if (readPaperclipRunRecoveryMetadata(frame) && !currentTasks.has(frame.taskId)) return false;
      const metadata = readFocusMetadata(frame);
      const task = parseTaskId(frame.taskId);
      const issueId = task?.kind === "issue" ? task.id : metadata.issueId;
      const issue = issueId ? issuesById.get(issueId) : undefined;
      if (issue?.companyId === companyId && (issue.status === "done" || issue.status === "cancelled"
        || issue.hiddenAt != null || issue.archivedAt != null)) {
        store.retireDisplayCandidates(companyId, { issueId: issue.id });
        return false;
      }
      if (task?.kind === "interaction" && issueId) {
        const interactions = store.getCachedHostValue<IssueThreadInteraction[]>(companyId, `issue:${issueId}:interactions`);
        if (interactions?.some((interaction) => interaction.id === task.id
          && interaction.companyId === companyId && interaction.issueId === issueId
          && ["accepted", "rejected", "answered", "cancelled", "expired", "failed"].includes(interaction.status))) {
          store.retireDisplayCandidates(companyId, { taskId: frame.taskId });
          return false;
        }
      }
      return true;
    });
    const base = complete ? {
      ...currentSnapshot,
      now: currentSnapshot.now && !taskIdMatchesKind(currentSnapshot.now.taskId, "interaction") ? currentSnapshot.now : null,
      next: currentSnapshot.next.filter((frame) => !taskIdMatchesKind(frame.taskId, "interaction")),
      ambient: currentSnapshot.ambient.filter((frame) => !taskIdMatchesKind(frame.taskId, "interaction")),
    } : currentSnapshot;
    return mergeStoredFrames(base, companyId, applicable, currentReview);
  };
  const result = (candidates: StoredFrameCandidate[], complete: boolean, reconciliationSyncError?: string) => {
    const snapshot = mergeCandidates(candidates, complete);
    const revision = store.getReconciledRevision(companyId);
    return {
      snapshot,
      ...(reconciliationSyncError !== undefined ? { reconciliationSyncError } : {}),
      // Approvals await after reconciliation. Recompose from current state rather than a captured frame set.
      composeLatest: () => mergeCandidates(store.getLastGoodReconciledCandidates(companyId) ?? [],
        complete && store.getReconciledRevision(companyId) === revision),
    };
  };
  if (useCache) {
    const cachedCandidates = store.getCachedReconciledCandidates(companyId, cacheKey);
    if (cachedCandidates) return result(cachedCandidates, true);
    cacheKey = reconciliationCacheKey(store, companyId, config);
  }

  try {
    const loadCandidates = async () => {
      const loadedCandidates = await loadReconciledCandidates(ctx, store, companyId, config, {
        freshHostData: options.freshHostData,
        snapshot,
      });
      if (reconciliationCacheKey(store, companyId, config) === cacheKey) {
        store.setLastGoodReconciledCandidates(companyId, loadedCandidates);
        if (useCache) store.setCachedReconciledCandidates(companyId, cacheKey, loadedCandidates);
      }
      return loadedCandidates;
    };
    const candidates = useCache
      ? await store.runSingleFlight(companyId, "reconciled-candidates", cacheKey, loadCandidates)
      : await loadCandidates();
    if (reconciliationCacheKey(store, companyId, config) !== cacheKey) {
      const reconciliationSyncError = "Paperclip attention changed during synchronization. Retry the read.";
      if (options.freshHostData) throw new Error(reconciliationSyncError);
      return result(store.getLastGoodReconciledCandidates(companyId) ?? [], false, reconciliationSyncError);
    }
    return result(candidates, true);
  } catch (error) {
    if (isInvocationScopeDenied(error)) {
      ctx.logger.warn("Aperture host reconciliation unavailable in this host callback; using current attention snapshot.", {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { snapshot, composeLatest: () => store.getSnapshot(companyId) ?? snapshot };
    }
    if (options.freshHostData) throw error;
    const reconciliationSyncError = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("Failed to reconcile Paperclip attention; retaining the last complete candidate set.", {
      companyId,
      error: reconciliationSyncError,
    });
    return result(store.getLastGoodReconciledCandidates(companyId) ?? [], false, reconciliationSyncError);
  }
}

export async function loadWorkerApprovals(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
): Promise<{ approvals: ApprovalRecord[] | null; error?: string }> {
  const cached = store.getApprovals(companyId);
  if (!store.approvalsDirty(companyId) && cached !== null) return { approvals: cached };

  const revision = store.getReconciledRevision(companyId);
  return store.runSingleFlight(companyId, "approvals", String(revision), async () => {
    try {
      const lists = await Promise.all([
        ctx.approvals.list({ companyId, status: "pending" }),
        ctx.approvals.list({ companyId, status: "revision_requested" }),
      ]);
      if (store.getReconciledRevision(companyId) !== revision) {
        return { approvals: store.getApprovals(companyId) };
      }

      const records = new Map<string, ApprovalRecord>();
      for (const list of lists) {
        for (const approval of list) {
          const record: ApprovalRecord = {
            id: approval.id,
            companyId: approval.companyId,
            type: approval.type,
            status: approval.status,
            payload: approval.payload,
            createdAt: approval.createdAt instanceof Date
              ? approval.createdAt.toISOString()
              : new Date(approval.createdAt).toISOString(),
            updatedAt: approval.updatedAt instanceof Date
              ? approval.updatedAt.toISOString()
              : new Date(approval.updatedAt).toISOString(),
          };
          const previous = records.get(record.id);
          if (!previous || record.updatedAt > previous.updatedAt) records.set(record.id, record);
        }
      }
      return { approvals: store.setApprovals(companyId, [...records.values()]) };
    } catch (error) {
      if (store.getReconciledRevision(companyId) !== revision) {
        return { approvals: store.getApprovals(companyId) };
      }
      const message = error instanceof Error ? error.message : String(error);
      store.markApprovalAdapterFailure(companyId, message);
      ctx.logger.warn("Failed to load native approvals for Focus display", {
        companyId,
        error: message,
      });
      return { approvals: store.getApprovals(companyId), error: message };
    }
  });
}

export async function loadDisplaySnapshot(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  snapshot: AttentionSnapshot,
  reviewState: AttentionReviewState,
  options: { freshHostData?: boolean } = {},
): Promise<{
  reconciledSnapshot: AttentionSnapshot;
  displaySnapshot: AttentionSnapshot;
  approvalSyncError?: string;
  reconciliationSyncError?: string;
  canEngage: (engagement: DisplayEngagement) => boolean;
}> {
  const reconciliation = await loadReconciledAttentionSnapshot(
    ctx, store, companyId, snapshot, reviewState, { preferCache: true, ...options },
  );
  const revision = store.getReconciledRevision(companyId);
  const { error: approvalSyncError } = await loadWorkerApprovals(ctx, store, companyId);
  const composeLatest = (engagement: DisplayEngagement | null) => {
    const reconciledSnapshot = reconciliation.composeLatest();
    const currentReview = store.getReview(companyId) ?? reviewState;
    const baseline = mergeSnapshotWithApprovals(reconciledSnapshot, companyId, store.getApprovals(companyId), currentReview);
    let displaySnapshot = baseline;
    let engagementValid = false;
    if (engagement) {
      const target = [baseline.now, ...baseline.next].find((frame) => frame?.taskId === engagement.taskId
        && frame.interactionId === engagement.interactionId);
      const liveCandidates = store.getLastGoodReconciledCandidates(companyId);
      const liveTarget = !target || !readFocusMetadata(target).liveReconciled
        || liveCandidates?.some(({ frame, lane }) => lane !== "ambient"
          && frame.taskId === engagement.taskId && frame.interactionId === engagement.interactionId);
      const core = store.getSnapshot(companyId);
      const corePreempted = store.hasCoreInteraction(companyId, engagement.taskId, engagement.interactionId)
        && (core?.now?.taskId !== engagement.taskId || core.now.interactionId !== engagement.interactionId);
      if (target && liveTarget && !corePreempted && Date.now() < engagement.expiresAt) {
        displaySnapshot = applyDisplayEngagement(baseline, engagement, currentReview);
        engagementValid = displaySnapshot.now?.taskId === engagement.taskId
          && displaySnapshot.now.interactionId === engagement.interactionId;
      }
    }
    return { reconciledSnapshot, displaySnapshot, engagementValid };
  };
  const engagement = store.getDisplayEngagement(companyId);
  const { reconciledSnapshot, displaySnapshot, engagementValid } = composeLatest(engagement);
  if (engagement && !engagementValid) store.clearDisplayEngagement(companyId);
  const reconciliationSyncError = reconciliation.reconciliationSyncError
    ?? (store.getReconciledRevision(companyId) !== revision
      ? "Paperclip attention changed during synchronization. Retry the read." : undefined);
  if (options.freshHostData && reconciliationSyncError) throw new Error(reconciliationSyncError);
  return {
    reconciledSnapshot,
    displaySnapshot,
    canEngage: (engagement) => composeLatest(engagement).engagementValid,
    ...(approvalSyncError !== undefined ? { approvalSyncError } : {}),
    ...(reconciliationSyncError !== undefined ? { reconciliationSyncError } : {}),
  };
}

export function registerDataHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.data.register("health", async () => {
    const health = store.getHealth();
    return {
      status: "ok",
      checkedAt: new Date().toISOString(),
      trackedCompanies: health.trackedCompanies,
      maxCompanySessions: health.maxCompanySessions,
      idleSessionTtlMs: health.idleSessionTtlMs,
      faultedCompanies: health.faultedCompanies,
      hostCacheEntries: health.hostCacheEntries,
      cachedReconciliations: health.cachedReconciliations,
    };
  });

  ctx.data.register("attention-diagnostics", async (params) => {
    const companyId = requireCompanyId(params);
    await ensureAttentionState(ctx, store, companyId);
    return store.getCoreDiagnostics(companyId) ?? emptyCoreDiagnostics(new Date().toISOString());
  });

  ctx.data.register("attention-overlay-diagnostics", async (params) => {
    const companyId = requireCompanyId(params);
    const { snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const { reconciledSnapshot, displaySnapshot, approvalSyncError, reconciliationSyncError } = await loadDisplaySnapshot(ctx, store, companyId, snapshot, reviewState);
    return buildOverlayDiagnostics({
      snapshot,
      reconciledSnapshot,
      displaySnapshot,
      approvalSyncError,
      reconciliationSyncError,
    }) satisfies AttentionOverlayDiagnostics;
  });

  ctx.data.register("attention-summary", async (params) => {
    const companyId = requireCompanyId(params);
    const { snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const { snapshot: reconciledSnapshot } = await loadReconciledAttentionSnapshot(ctx, store, companyId, snapshot, reviewState, {
      freshHostData: true,
    });
    return reconciledSnapshot;
  });

  ctx.data.register("attention-display", async (params) => {
    const companyId = requireCompanyId(params);
    const { snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const { displaySnapshot, approvalSyncError, reconciliationSyncError } = await loadDisplaySnapshot(ctx, store, companyId, snapshot, reviewState);

    return {
      companyId,
      snapshot: displaySnapshot ?? createEmptySnapshot(companyId),
      reviewState,
      ...(approvalSyncError !== undefined ? { approvalSyncError } : {}),
      ...(reconciliationSyncError !== undefined ? { reconciliationSyncError } : {}),
    } satisfies AttentionDisplayPayload;
  });

  ctx.data.register("attention-export", async (params) => {
    const companyId = requireCompanyId(params);
    const entryLimit = boundedPositiveInt(params.limit, DEFAULT_EXPORT_ENTRY_LIMIT, MAX_EXPORT_ENTRY_LIMIT);
    const traceLimit = boundedPositiveInt(params.traceLimit, DEFAULT_EXPORT_TRACE_LIMIT, MAX_EXPORT_TRACE_LIMIT);
    const exportedAt = new Date().toISOString();
    const { baseLedger, snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const { reconciledSnapshot, displaySnapshot, approvalSyncError, reconciliationSyncError } = await loadDisplaySnapshot(ctx, store, companyId, snapshot, reviewState, {
      freshHostData: true,
    });
    const ledgerWindow = tailWindow(baseLedger, entryLimit);
    const traceWindow = tailWindow(store.getTraces(companyId), traceLimit);

    return {
      companyId,
      exportedAt,
      ledger: ledgerWindow.items,
      eventEntries: ledgerWindow.items.filter((entry): entry is AttentionLedgerEventEntry => entry.kind === "event"),
      responseEntries: ledgerWindow.items.filter((entry): entry is AttentionLedgerResponseEntry => entry.kind === "response"),
      overlayResponseEntries: ledgerWindow.items.filter((entry): entry is AttentionLedgerOverlayResponseEntry => entry.kind === "overlay-response"),
      signalEntries: ledgerWindow.items.filter((entry): entry is AttentionLedgerSignalEntry => entry.kind === "signal"),
      traces: traceWindow.items,
      window: {
        entryLimit,
        traceLimit,
        totalLedgerEntries: ledgerWindow.total,
        returnedLedgerEntries: ledgerWindow.items.length,
        totalTraces: traceWindow.total,
        returnedTraces: traceWindow.items.length,
        hasMoreBefore: ledgerWindow.hasMoreBefore || traceWindow.hasMoreBefore,
      },
      snapshot,
      reconciledSnapshot,
      displaySnapshot,
      review: reviewState,
      coreDiagnostics: store.getCoreDiagnostics(companyId) ?? emptyCoreDiagnostics(exportedAt),
      overlayDiagnostics: buildOverlayDiagnostics({
        snapshot,
        reconciledSnapshot,
        displaySnapshot,
        approvalSyncError,
        reconciliationSyncError,
      }),
    } satisfies AttentionExport;
  });

  ctx.data.register("attention-traces", async (params) => {
    const companyId = requireCompanyId(params);
    await ensureAttentionState(ctx, store, companyId);
    return store.getTraces(companyId);
  });

  ctx.data.register("attention-replay-scenario", async (params) => {
    const companyId = requireCompanyId(params);
    const entryLimit = boundedPositiveInt(params.limit, DEFAULT_EXPORT_ENTRY_LIMIT, MAX_EXPORT_ENTRY_LIMIT);
    const { baseLedger, snapshot } = await ensureAttentionState(ctx, store, companyId);
    const ledgerWindow = tailWindow(baseLedger, entryLimit);

    return {
      id: `paperclip-attention-${companyId}`,
      title: `Paperclip attention replay for ${companyId}`,
      description: "Replay scenario exported from the Paperclip Aperture plugin ledger.",
      doctrineTags: ["paperclip", "aperture", "replay-export"],
      window: {
        entryLimit,
        totalLedgerEntries: ledgerWindow.total,
        returnedSteps: ledgerWindow.items.length,
        hasMoreBefore: ledgerWindow.hasMoreBefore,
      },
      expectations: {
        finalNowInteractionId: snapshot.now?.interactionId ?? null,
        nextInteractionIds: snapshot.next.map((frame) => frame.interactionId),
        ambientInteractionIds: snapshot.ambient.map((frame) => frame.interactionId),
        resultLaneCounts: {
          now: snapshot.counts.now,
          next: snapshot.counts.next,
          ambient: snapshot.counts.ambient,
        },
      },
      steps: ledgerWindow.items.map((entry) => (
        entry.kind === "event"
          ? {
              kind: "publish" as const,
              event: entry.apertureEvent,
              label: `${entry.source.eventType} @ ${entry.occurredAt}`,
            }
          : entry.kind === "response"
            ? {
              kind: "submit" as const,
              response: entry.apertureResponse,
              label: `${entry.source.eventType} @ ${entry.occurredAt}`,
            }
            : entry.kind === "signal"
              ? {
                  kind: "signal" as const,
                  signal: entry.apertureSignal,
                  label: `${entry.source.eventType} @ ${entry.occurredAt}`,
                }
              : {
                  kind: "overlay-response" as const,
                  response: entry.apertureResponse,
                  overlay: entry.overlay,
                  label: `${entry.source.eventType} @ ${entry.occurredAt}`,
                }
      )),
    } satisfies AttentionReplayScenario;
  });

  ctx.data.register("attention-review", async (params) => {
    const companyId = requireCompanyId(params);
    const { reviewState } = await ensureAttentionState(ctx, store, companyId);
    return reviewState;
  });
}
