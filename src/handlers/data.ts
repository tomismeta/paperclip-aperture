import type { PluginContext } from "@paperclipai/plugin-sdk";
import { mergeSnapshotWithApprovals } from "../aperture/approval-frames.js";
import {
  isAttentionLedger,
  isAttentionReviewState,
} from "../aperture/persisted-state.js";
import { reconcileAttentionSnapshot } from "../aperture/reconciliation.js";
import {
  type AttentionDisplayPayload,
  type AttentionExport,
  createEmptyLedger,
  createEmptyReviewState,
  createEmptySnapshot,
  normalizeAttentionSnapshot,
  type AttentionLedger,
  type AttentionLedgerEventEntry,
  type AttentionReplayScenario,
  type AttentionLedgerResponseEntry,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "../aperture/types.js";
import { ApertureCompanyStore } from "../aperture/core-store.js";
import { listPendingApprovals } from "../host/paperclip-approvals.js";
import {
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_REVIEW_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
  loadPersistedAttentionState,
  requireCompanyId,
} from "./shared.js";

function laterIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function deriveReviewStateFromLedger(
  companyId: string,
  ledger: AttentionLedger,
  persistedReview: AttentionReviewState | null,
): AttentionReviewState {
  const review: AttentionReviewState = persistedReview
    ? {
        ...persistedReview,
        frames: Object.fromEntries(
          Object.entries(persistedReview.frames).map(([taskId, state]) => [taskId, { ...state }]),
        ),
      }
    : createEmptyReviewState(companyId);

  for (const entry of ledger) {
    if (entry.kind !== "response") continue;

    const occurredAt = entry.occurredAt;
    const taskId = entry.apertureResponse.taskId;
    const responseKind = entry.apertureResponse.response.kind;
    const current = review.frames[taskId] ?? {};

    review.frames[taskId] = {
      ...current,
      lastSeenAt: laterIso(current.lastSeenAt, occurredAt),
      ...(responseKind === "acknowledged" || responseKind === "dismissed"
        ? { suppressedAt: laterIso(current.suppressedAt, occurredAt) }
        : {}),
    };
    review.lastSeenAt = laterIso(review.lastSeenAt, occurredAt);
    review.updatedAt = laterIso(review.updatedAt, occurredAt) ?? occurredAt;
  }

  return review;
}

type HydratedAttentionState = {
  baseLedger: AttentionLedger;
  snapshot: AttentionSnapshot;
  reviewState: AttentionReviewState;
};

async function ensureAttentionState(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
): Promise<HydratedAttentionState> {
  if (store.hasSession(companyId)) {
    const liveSnapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
    return {
      baseLedger: store.getLedger(companyId),
      snapshot: liveSnapshot,
      reviewState: store.getReview(companyId) ?? createEmptyReviewState(companyId),
    };
  }

  const persistedState = await loadPersistedAttentionState(ctx, companyId);
  if (persistedState) {
    const { snapshot } = store.hydrate(companyId, {
      ledger: persistedState.ledger,
      snapshot: persistedState.snapshot,
      review: persistedState.review,
    });

    return {
      baseLedger: persistedState.ledger,
      snapshot,
      reviewState: persistedState.review,
    };
  }

  const persistedLedgerValue = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_LEDGER_STATE_KEY,
  });
  const persistedSnapshotValue = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
  });
  const persistedReviewValue = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_REVIEW_STATE_KEY,
  });
  const baseLedger = isAttentionLedger(persistedLedgerValue)
    ? persistedLedgerValue
    : createEmptyLedger();
  const persistedSnapshot = normalizeAttentionSnapshot(companyId, persistedSnapshotValue);
  const reviewState = deriveReviewStateFromLedger(
    companyId,
    baseLedger,
    isAttentionReviewState(persistedReviewValue, companyId) ? persistedReviewValue : null,
  );
  const { snapshot } = store.hydrate(companyId, {
    ledger: baseLedger,
    snapshot: persistedSnapshot,
    review: reviewState,
  });

  if (!isAttentionLedger(persistedLedgerValue) && persistedSnapshot) {
    ctx.logger.warn("Legacy snapshot found without replay ledger; rebuilt state may be partial until new events arrive.", {
      companyId,
    });
  }

  return { baseLedger, snapshot, reviewState };
}

function reconciliationCacheKey(
  snapshot: AttentionSnapshot,
  reviewState: AttentionReviewState,
  config: Record<string, unknown>,
): string {
  return JSON.stringify({
    snapshotUpdatedAt: snapshot.updatedAt,
    reviewUpdatedAt: reviewState.updatedAt,
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
  options: { preferCache?: boolean } = {},
): Promise<AttentionSnapshot> {
  const config = await ctx.config.get();
  const cacheKey = reconciliationCacheKey(snapshot, reviewState, config);
  if (options.preferCache) {
    const cached = store.getCachedReconciledSnapshot(companyId, cacheKey);
    if (cached) return cached;
  }

  const reconciled = await reconcileAttentionSnapshot(ctx, companyId, snapshot, reviewState, config);
  if (options.preferCache) {
    store.setCachedReconciledSnapshot(companyId, cacheKey, reconciled);
  }
  return reconciled;
}

async function loadWorkerApprovals(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
): Promise<ReturnType<typeof store.setApprovals>> {
  const cached = store.getApprovals(companyId);
  if (!store.approvalsDirty(companyId) && cached) return cached;

  const config = await ctx.config.get();
  try {
    const approvals = await listPendingApprovals(ctx, companyId, config);
    return store.setApprovals(companyId, approvals);
  } catch (error) {
    ctx.logger.warn("Failed to load pending approvals for Focus display", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (cached) return cached;
    return store.setApprovals(companyId, []);
  }
}

async function loadDisplaySnapshot(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  snapshot: AttentionSnapshot,
  reviewState: AttentionReviewState,
): Promise<{
  reconciledSnapshot: AttentionSnapshot;
  displaySnapshot: AttentionSnapshot;
}> {
  const reconciledSnapshot = await loadReconciledAttentionSnapshot(ctx, store, companyId, snapshot, reviewState, { preferCache: true });
  const approvals = await loadWorkerApprovals(ctx, store, companyId);

  return {
    reconciledSnapshot,
    displaySnapshot: mergeSnapshotWithApprovals(reconciledSnapshot, companyId, approvals, reviewState),
  };
}

export function registerDataHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.data.register("health", async () => {
    return {
      status: "ok",
      checkedAt: new Date().toISOString(),
      trackedCompanies: store.getCompanyCount(),
    };
  });

  ctx.data.register("attention-summary", async (params) => {
    const companyId = requireCompanyId(params);
    const { snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const reconciledSnapshot = await loadReconciledAttentionSnapshot(ctx, store, companyId, snapshot, reviewState);
    return reconciledSnapshot ?? createEmptySnapshot(companyId);
  });

  ctx.data.register("attention-display", async (params) => {
    const companyId = requireCompanyId(params);
    const { snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const { displaySnapshot } = await loadDisplaySnapshot(ctx, store, companyId, snapshot, reviewState);

    return {
      companyId,
      snapshot: displaySnapshot ?? createEmptySnapshot(companyId),
      reviewState,
    } satisfies AttentionDisplayPayload;
  });

  ctx.data.register("attention-export", async (params) => {
    const companyId = requireCompanyId(params);
    const { baseLedger, snapshot, reviewState } = await ensureAttentionState(ctx, store, companyId);
    const reconciledSnapshot = await loadReconciledAttentionSnapshot(ctx, store, companyId, snapshot, reviewState);
    const approvals = await loadWorkerApprovals(ctx, store, companyId);
    const displaySnapshot = mergeSnapshotWithApprovals(reconciledSnapshot, companyId, approvals, reviewState);

    return {
      companyId,
      exportedAt: new Date().toISOString(),
      ledger: baseLedger,
      eventEntries: baseLedger.filter((entry): entry is AttentionLedgerEventEntry => entry.kind === "event"),
      responseEntries: baseLedger.filter((entry): entry is AttentionLedgerResponseEntry => entry.kind === "response"),
      traces: store.getTraces(companyId),
      snapshot,
      reconciledSnapshot,
      displaySnapshot,
      review: reviewState,
    } satisfies AttentionExport;
  });

  ctx.data.register("attention-traces", async (params) => {
    const companyId = requireCompanyId(params);
    await ensureAttentionState(ctx, store, companyId);
    return store.getTraces(companyId);
  });

  ctx.data.register("attention-replay-scenario", async (params) => {
    const companyId = requireCompanyId(params);
    const { baseLedger, snapshot } = await ensureAttentionState(ctx, store, companyId);

    return {
      id: `paperclip-attention-${companyId}`,
      title: `Paperclip attention replay for ${companyId}`,
      description: "Replay scenario exported from the Paperclip Aperture plugin ledger.",
      doctrineTags: ["paperclip", "aperture", "replay-export"],
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
      steps: baseLedger.map((entry) => (
        entry.kind === "event"
          ? {
              kind: "publish" as const,
              event: entry.apertureEvent,
              label: `${entry.source.eventType} @ ${entry.occurredAt}`,
            }
          : {
              kind: "submit" as const,
              response: entry.apertureResponse,
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
