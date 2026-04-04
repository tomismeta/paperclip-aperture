import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reconcileAttentionSnapshot } from "../aperture/reconciliation.js";
import {
  type AttentionDisplayPayload,
  type AttentionExport,
  createEmptyLedger,
  createEmptyReviewState,
  createEmptySnapshot,
  normalizeAttentionSnapshot,
  type AttentionLedger,
  type AttentionLedgerEntry,
  type AttentionLedgerEventEntry,
  type AttentionReplayScenario,
  type AttentionLedgerResponseEntry,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "../aperture/types.js";
import { ApertureCompanyStore } from "../aperture/core-store.js";
import {
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_REVIEW_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
  persistLedger,
  persistReviewState,
  persistSnapshot,
  requireCompanyId,
} from "./shared.js";

function isAttentionSnapshot(value: unknown, companyId: string): value is AttentionSnapshot {
  return normalizeAttentionSnapshot(companyId, value) !== null;
}

function isLedgerSource(value: unknown): value is NonNullable<AttentionLedgerEntry["source"]> {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return typeof source.eventType === "string";
}

function isAttentionLedgerEntry(value: unknown): value is AttentionLedgerEntry {
  if (!value || typeof value !== "object") return false;

  const entry = value as Record<string, unknown>;
  if (
    (entry.kind !== "event" && entry.kind !== "response")
    || typeof entry.id !== "string"
    || typeof entry.occurredAt !== "string"
    || !isLedgerSource(entry.source)
  ) {
    return false;
  }

  if (entry.kind === "event") return !!entry.apertureEvent && typeof entry.apertureEvent === "object";
  return !!entry.apertureResponse && typeof entry.apertureResponse === "object";
}

function isAttentionLedger(value: unknown): value is AttentionLedger {
  return Array.isArray(value) && value.every(isAttentionLedgerEntry);
}

function isAttentionReviewState(value: unknown, companyId: string): value is AttentionReviewState {
  if (!value || typeof value !== "object") return false;

  const review = value as Partial<AttentionReviewState>;
  if (review.companyId !== companyId || typeof review.updatedAt !== "string") return false;
  if (!review.frames || typeof review.frames !== "object") return false;

  return Object.values(review.frames).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return (
      (candidate.lastSeenAt === undefined || typeof candidate.lastSeenAt === "string")
      && (candidate.suppressedAt === undefined || typeof candidate.suppressedAt === "string")
    );
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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

async function loadAttentionState(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
): Promise<{
  persistedLedger: unknown;
  persistedSnapshot: AttentionSnapshot | null;
  persistedReview: unknown;
  baseLedger: AttentionLedger;
  snapshot: AttentionSnapshot;
  reviewState: AttentionReviewState;
}> {
  const inMemoryLedger = store.getLedger(companyId);
  const persistedLedger = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_LEDGER_STATE_KEY,
  });
  const persistedSnapshot = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
  });
  const persistedReview = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_REVIEW_STATE_KEY,
  });
  const baseLedger = inMemoryLedger.length > 0
    ? inMemoryLedger
    : isAttentionLedger(persistedLedger)
      ? persistedLedger
      : createEmptyLedger();
  const normalizedPersistedSnapshot = normalizeAttentionSnapshot(companyId, persistedSnapshot);

  const snapshot = store.rebuildFromLedger(companyId, baseLedger);
  const reviewState = deriveReviewStateFromLedger(
    companyId,
    baseLedger,
    isAttentionReviewState(persistedReview, companyId) ? persistedReview : null,
  );

  return {
    persistedLedger,
    persistedSnapshot: normalizedPersistedSnapshot,
    persistedReview,
    baseLedger,
    snapshot,
    reviewState,
  };
}

async function loadReconciledAttentionSnapshot(
  ctx: PluginContext,
  companyId: string,
  snapshot: AttentionSnapshot,
  reviewState: AttentionReviewState,
): Promise<AttentionSnapshot> {
  const config = await ctx.config.get();
  return reconcileAttentionSnapshot(ctx, companyId, snapshot, reviewState, config);
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
    const {
      persistedLedger,
      persistedSnapshot,
      persistedReview,
      baseLedger,
      snapshot,
      reviewState,
    } = await loadAttentionState(ctx, store, companyId);
    const reconciledSnapshot = await loadReconciledAttentionSnapshot(ctx, companyId, snapshot, reviewState);

    const shouldPersistLedger = !isAttentionLedger(persistedLedger) || !sameJson(persistedLedger, baseLedger);
    const shouldPersistSnapshot = !persistedSnapshot || !sameJson(persistedSnapshot, snapshot);
    const shouldPersistReview = !isAttentionReviewState(persistedReview, companyId) || !sameJson(persistedReview, reviewState);

    if (shouldPersistLedger) await persistLedger(ctx, companyId, baseLedger);
    if (shouldPersistSnapshot) await persistSnapshot(ctx, companyId, snapshot);
    if (shouldPersistReview) await persistReviewState(ctx, companyId, reviewState);

    if (!isAttentionLedger(persistedLedger) && persistedSnapshot) {
      ctx.logger.warn("Legacy snapshot found without replay ledger; rebuilt state may be partial until new events arrive.", {
        companyId,
      });
    }

    return reconciledSnapshot ?? createEmptySnapshot(companyId);
  });

  ctx.data.register("attention-display", async (params) => {
    const companyId = requireCompanyId(params);
    const {
      persistedLedger,
      persistedSnapshot,
      persistedReview,
      baseLedger,
      snapshot,
      reviewState,
    } = await loadAttentionState(ctx, store, companyId);
    const reconciledSnapshot = await loadReconciledAttentionSnapshot(ctx, companyId, snapshot, reviewState);

    const shouldPersistLedger = !isAttentionLedger(persistedLedger) || !sameJson(persistedLedger, baseLedger);
    const shouldPersistSnapshot = !persistedSnapshot || !sameJson(persistedSnapshot, snapshot);
    const shouldPersistReview = !isAttentionReviewState(persistedReview, companyId) || !sameJson(persistedReview, reviewState);

    if (shouldPersistLedger) await persistLedger(ctx, companyId, baseLedger);
    if (shouldPersistSnapshot) await persistSnapshot(ctx, companyId, snapshot);
    if (shouldPersistReview) await persistReviewState(ctx, companyId, reviewState);

    if (!isAttentionLedger(persistedLedger) && persistedSnapshot) {
      ctx.logger.warn("Legacy snapshot found without replay ledger; rebuilt state may be partial until new events arrive.", {
        companyId,
      });
    }

    return {
      companyId,
      snapshot: reconciledSnapshot ?? createEmptySnapshot(companyId),
      reviewState,
    } satisfies AttentionDisplayPayload;
  });

  ctx.data.register("attention-export", async (params) => {
    const companyId = requireCompanyId(params);
    const {
      baseLedger,
      snapshot,
      reviewState,
    } = await loadAttentionState(ctx, store, companyId);
    const reconciledSnapshot = await loadReconciledAttentionSnapshot(ctx, companyId, snapshot, reviewState);

    return {
      companyId,
      exportedAt: new Date().toISOString(),
      ledger: baseLedger,
      eventEntries: baseLedger.filter((entry): entry is AttentionLedgerEventEntry => entry.kind === "event"),
      responseEntries: baseLedger.filter((entry): entry is AttentionLedgerResponseEntry => entry.kind === "response"),
      traces: store.getTraces(companyId),
      snapshot,
      reconciledSnapshot,
      review: reviewState,
    } satisfies AttentionExport;
  });

  ctx.data.register("attention-traces", async (params) => {
    const companyId = requireCompanyId(params);
    await loadAttentionState(ctx, store, companyId);
    return store.getTraces(companyId);
  });

  ctx.data.register("attention-replay-scenario", async (params) => {
    const companyId = requireCompanyId(params);
    const { baseLedger, snapshot } = await loadAttentionState(ctx, store, companyId);

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
    const { persistedReview, reviewState } = await loadAttentionState(ctx, store, companyId);
    const review = reviewState;

    if (!isAttentionReviewState(persistedReview, companyId) || !sameJson(persistedReview, review)) {
      await persistReviewState(ctx, companyId, review);
    }
    return review;
  });
}
