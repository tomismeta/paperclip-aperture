import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import {
  createPersistedAttentionState,
  normalizePersistedAttentionState,
  type PersistedAttentionState,
} from "../aperture/persisted-state.js";
import {
  createEmptyReviewState,
  createEmptySnapshot,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "../aperture/types.js";

export const ATTENTION_STATE_KEY = "attention-state";
// Legacy split keys remain readable for migration, but new writes go through ATTENTION_STATE_KEY.
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
  ledger: PersistedAttentionState["ledger"],
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

export async function loadPersistedAttentionState(
  ctx: PluginContext,
  companyId: string,
): Promise<PersistedAttentionState | null> {
  const value = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_STATE_KEY,
  });
  return normalizePersistedAttentionState(companyId, value);
}

export async function persistAttentionState(
  ctx: PluginContext,
  companyId: string,
  state: {
    ledger: PersistedAttentionState["ledger"];
    snapshot: AttentionSnapshot;
    review: AttentionReviewState;
  },
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_STATE_KEY },
    createPersistedAttentionState(companyId, state),
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
  ledger: PersistedAttentionState["ledger"];
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
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => gate);
  companyMutationQueue.set(companyId, tail);

  await prior.catch(() => undefined);

  const persistedState = await loadPersistedAttentionState(ctx, companyId);
  const previousLedger = store.getLedger(companyId);
  const previousSnapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
  const previousReview = store.getReview(companyId)
    ?? persistedState?.review
    ?? createEmptyReviewState(companyId);

  try {
    const result = await mutation();
    if (result.review) store.setReview(companyId, result.review);
    await persistAttentionState(ctx, companyId, {
      ledger: result.ledger,
      snapshot: result.snapshot,
      review: result.review ?? store.getReview(companyId) ?? previousReview,
    });
    return result;
  } catch (error) {
    store.rebuildFromLedger(companyId, previousLedger);
    store.setReview(companyId, previousReview);
    throw error;
  } finally {
    release();
    if (companyMutationQueue.get(companyId) === tail) {
      companyMutationQueue.delete(companyId);
    }
  }
}
