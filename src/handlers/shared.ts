import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import {
  createEmptyReviewState,
  createEmptySnapshot,
  type AttentionLedger,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "../aperture/types.js";

export const ATTENTION_SNAPSHOT_STATE_KEY = "attention-snapshot";
export const ATTENTION_LEDGER_STATE_KEY = "attention-ledger";
export const ATTENTION_REVIEW_STATE_KEY = "attention-review";
export const ATTENTION_UPDATES_STREAM = "attention-updates";

const companyMutationQueue = new Map<string, Promise<void>>();

export type AttentionUpdateEvent = {
  companyId: string;
  reason: "event" | "action";
  eventType: string;
  updatedAt: string;
  counts: AttentionSnapshot["counts"];
};

export function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`${key} is required`);
}

export function requireCompanyId(params: Record<string, unknown>): string {
  return requireStringParam(params, "companyId");
}

export async function persistSnapshot(
  ctx: PluginContext,
  companyId: string,
  snapshot: AttentionSnapshot,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_SNAPSHOT_STATE_KEY },
    snapshot,
  );
}

export async function persistLedger(
  ctx: PluginContext,
  companyId: string,
  ledger: AttentionLedger,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_LEDGER_STATE_KEY },
    ledger,
  );
}

export async function persistReviewState(
  ctx: PluginContext,
  companyId: string,
  review: AttentionReviewState,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_REVIEW_STATE_KEY },
    review,
  );
}

export function emitAttentionUpdate(
  ctx: PluginContext,
  event: AttentionUpdateEvent,
): void {
  ctx.streams.open(ATTENTION_UPDATES_STREAM, event.companyId);
  ctx.streams.emit(ATTENTION_UPDATES_STREAM, event);
}

export async function trackFocusTelemetry(
  ctx: PluginContext,
  eventName: string,
  dimensions?: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    await ctx.telemetry.track(eventName, {
      surface: "focus",
      ...(dimensions ?? {}),
    });
  } catch (error) {
    ctx.logger.warn("Failed to emit Focus telemetry", {
      eventName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function logFocusActivity(
  ctx: PluginContext,
  entry: {
    companyId: string;
    message: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await ctx.activity.log({
      companyId: entry.companyId,
      message: entry.message,
      ...(entry.entityType ? { entityType: entry.entityType } : {}),
      ...(entry.entityId ? { entityId: entry.entityId } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
  } catch (error) {
    ctx.logger.warn("Failed to write Focus activity log entry", {
      message: entry.message,
      entityType: entry.entityType,
      entityId: entry.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type PersistedAttentionMutation = {
  ledger: AttentionLedger;
  snapshot: AttentionSnapshot;
  review?: AttentionReviewState;
};

export async function runAttentionMutation<T extends PersistedAttentionMutation>(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
  mutation: () => Promise<T> | T,
): Promise<T> {
  const prior = companyMutationQueue.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  companyMutationQueue.set(companyId, prior.catch(() => undefined).then(() => current));

  await prior.catch(() => undefined);

  const previousLedger = store.getLedger(companyId);
  const previousSnapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
  const previousReview = store.getReview(companyId)
    ?? await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: ATTENTION_REVIEW_STATE_KEY,
    });
  let persistStarted = false;

  try {
    const result = await mutation();
    if (result.review) store.setReview(companyId, result.review);
    persistStarted = true;
    await persistLedger(ctx, companyId, result.ledger);
    try {
      await persistSnapshot(ctx, companyId, result.snapshot);
      if (result.review) await persistReviewState(ctx, companyId, result.review);
    } catch (error) {
      ctx.logger.warn("Persisted attention ledger without a matching snapshot update", {
        companyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return result;
  } catch (error) {
    if (persistStarted) {
      try {
        await persistLedger(ctx, companyId, previousLedger);
        await persistSnapshot(ctx, companyId, previousSnapshot);
        await persistReviewState(
          ctx,
          companyId,
          previousReview && typeof previousReview === "object"
            ? previousReview as AttentionReviewState
            : createEmptyReviewState(companyId),
        );
      } catch (rollbackError) {
        ctx.logger.error("Failed to roll back attention state after mutation persistence error", {
          companyId,
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
    }

    store.rebuildFromLedger(companyId, previousLedger);
    store.setReview(
      companyId,
      previousReview && typeof previousReview === "object"
        ? previousReview as AttentionReviewState
        : createEmptyReviewState(companyId),
    );
    throw error;
  } finally {
    release();
  }
}
