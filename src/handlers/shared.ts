import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import {
  createPersistedAttentionState,
  isAttentionLedger,
  normalizeSplitAttentionState,
  normalizePersistedAttentionState,
  type PersistedAttentionState,
} from "../aperture/persisted-state.js";
import {
  createEmptyReviewState,
  createEmptySnapshot,
  normalizeAttentionSnapshot,
  type AttentionLedger,
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
const BEST_EFFORT_RETRY_DELAYS_MS = [10, 30] as const;

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

export function requireHumanActionScope(
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
): { companyId: string; actorUserId: string } {
  const companyId = context.companyId;
  if (typeof companyId !== "string" || companyId.trim().length === 0) {
    throw new Error("Host-authorized company scope is required.");
  }
  if (
    (params.companyId !== undefined && params.companyId !== companyId)
    || (context.actor.companyId != null && context.actor.companyId !== companyId)
  ) {
    throw new Error("Company scope does not match the authenticated action.");
  }
  if (
    context.actor.type !== "user"
    || typeof context.actor.userId !== "string"
    || context.actor.userId.trim().length === 0
  ) {
    throw new Error("A signed-in human operator is required for this action.");
  }
  return { companyId, actorUserId: context.actor.userId };
}

export function isInvocationScopeDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("invocation scope") || message.includes("not allowed to perform");
}

async function runCompanyMutation<T>(
  companyId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const prior = companyMutationQueue.get(companyId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => gate);
  companyMutationQueue.set(companyId, tail);

  await prior.catch(() => undefined);

  try {
    return await mutation();
  } finally {
    release();
    if (companyMutationQueue.get(companyId) === tail) {
      companyMutationQueue.delete(companyId);
    }
  }
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

type HydratedAttentionState = {
  baseLedger: AttentionLedger;
  snapshot: AttentionSnapshot;
  reviewState: AttentionReviewState;
};

function inMemoryAttentionState(store: ApertureCompanyStore, companyId: string): HydratedAttentionState {
  return {
    baseLedger: store.getLedger(companyId),
    snapshot: store.getSnapshot(companyId) ?? createEmptySnapshot(companyId),
    reviewState: store.getReview(companyId) ?? createEmptyReviewState(companyId),
  };
}

// Called only inside the company queue. Event callbacks may keep appending while reads await.
async function hydrateAttentionState(ctx: PluginContext, store: ApertureCompanyStore, companyId: string): Promise<void> {
  if (store.hasHydratedState(companyId)) return;
  let state = await loadPersistedAttentionState(ctx, companyId);
  if (!state) {
    const ledger = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_LEDGER_STATE_KEY });
    const snapshot = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_SNAPSHOT_STATE_KEY });
    const review = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: ATTENTION_REVIEW_STATE_KEY });
    if (!isAttentionLedger(ledger) && normalizeAttentionSnapshot(companyId, snapshot)) {
      ctx.logger.warn("Legacy snapshot found without replay ledger; rebuilt state may be partial until new events arrive.", { companyId });
    }
    state = normalizeSplitAttentionState(companyId, { ledger, snapshot, review });
  }
  store.hydrate(companyId, { ledger: state.ledger, snapshot: state.snapshot, review: state.review });
  if (state.needsMigrationPersistence) store.markPersistencePending(companyId);
}

async function flushPendingAttentionState(ctx: PluginContext, store: ApertureCompanyStore, companyId: string): Promise<boolean> {
  if (!store.hasPendingPersistence(companyId)) return false;
  const state = store.getPersistableState(companyId);
  if (!state) return false;
  try {
    await persistAttentionState(ctx, companyId, state);
    store.markPersistenceHealthy(companyId, state.ledger.length);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInvocationScopeDenied(error)) {
      ctx.logger.warn("Aperture pending state could not be persisted in this host callback; will retry from the next scoped invocation.", { companyId, error: message });
    } else {
      store.markPersistenceFault(companyId, message);
      ctx.logger.warn("Failed to persist pending Aperture event state.", { companyId, error: message });
    }
    return false;
  }
}

export async function ensureAttentionState(ctx: PluginContext, store: ApertureCompanyStore, companyId: string): Promise<HydratedAttentionState> {
  return runCompanyMutation(companyId, async () => {
    try {
      await hydrateAttentionState(ctx, store, companyId);
      await flushPendingAttentionState(ctx, store, companyId);
      return inMemoryAttentionState(store, companyId);
    } catch (error) {
      if (!isInvocationScopeDenied(error)) throw error;
      ctx.logger.warn("Aperture persisted state unavailable in this host callback; using in-memory attention state.", {
        companyId, error: error instanceof Error ? error.message : String(error),
      });
      return inMemoryAttentionState(store, companyId);
    }
  });
}

async function retryBestEffort(
  run: () => Promise<void>,
  onFailure: (error: unknown, attempt: number, final: boolean) => void,
): Promise<void> {
  for (let attempt = 0; attempt <= BEST_EFFORT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      const final = attempt === BEST_EFFORT_RETRY_DELAYS_MS.length;
      onFailure(error, attempt + 1, final);
      if (final) return;
      await new Promise((resolve) => {
        setTimeout(resolve, BEST_EFFORT_RETRY_DELAYS_MS[attempt]);
      });
    }
  }
}

export async function trackFocusTelemetry(
  ctx: PluginContext,
  eventName: string,
  dimensions?: Record<string, string | number | boolean>,
): Promise<void> {
  await retryBestEffort(
    async () => {
      await ctx.telemetry.track(eventName, {
        surface: "focus",
        ...(dimensions ?? {}),
      });
    },
    (error, attempt, final) => {
      ctx.logger.warn(final ? "Failed to emit Focus telemetry after retries" : "Retrying Focus telemetry after failure", {
        eventName,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
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
  await retryBestEffort(
    async () => {
      await ctx.activity.log({
        companyId: entry.companyId,
        message: entry.message,
        ...(entry.entityType ? { entityType: entry.entityType } : {}),
        ...(entry.entityId ? { entityId: entry.entityId } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    },
    (error, attempt, final) => {
      ctx.logger.warn(final ? "Failed to write Focus activity log entry after retries" : "Retrying Focus activity log entry after failure", {
        message: entry.message,
        entityType: entry.entityType,
        entityId: entry.entityId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
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
  onPersisted?: (result: T) => void,
): Promise<T> {
  return runCompanyMutation(companyId, async () => {
    await hydrateAttentionState(ctx, store, companyId);
    const previousLedger = store.getLedger(companyId);
    const previousSnapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
    const previousReview = store.getReview(companyId) ?? createEmptyReviewState(companyId);
    let persistenceAttempted = false;
    try {
      const result = await mutation();
      if (result.review) store.setReview(companyId, result.review);
      persistenceAttempted = true;
      await persistAttentionState(ctx, companyId, {
        ledger: result.ledger,
        snapshot: result.snapshot,
        review: result.review ?? store.getReview(companyId) ?? previousReview,
      });
      store.markPersistenceHealthy(companyId, result.ledger.length);
      onPersisted?.(result);
      return result;
    } catch (error) {
      const arrivedEvents = store.getLedger(companyId).slice(previousLedger.length).filter((entry) => entry.kind === "event");
      store.restore(companyId, { ledger: previousLedger, snapshot: previousSnapshot, review: previousReview });
      for (const entry of arrivedEvents) store.applyEvent(companyId, entry);
      if (arrivedEvents.length > 0) store.markPersistencePending(companyId);
      if (persistenceAttempted) store.markPersistenceFault(companyId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}
