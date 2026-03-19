import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  createEmptyLedger,
  createEmptySnapshot,
  type AttentionLedger,
  type AttentionLedgerEntry,
  type AttentionSnapshot,
} from "../aperture/types.js";
import { ApertureCompanyStore } from "../aperture/core-store.js";
import {
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
  persistLedger,
  persistSnapshot,
  requireCompanyId,
} from "./shared.js";

function isAttentionSnapshot(value: unknown, companyId: string): value is AttentionSnapshot {
  if (!value || typeof value !== "object") return false;

  const snapshot = value as Partial<AttentionSnapshot>;
  return (
    snapshot.companyId === companyId
    && typeof snapshot.updatedAt === "string"
    && !!snapshot.counts
    && typeof snapshot.counts.active === "number"
    && typeof snapshot.counts.queued === "number"
    && typeof snapshot.counts.ambient === "number"
    && typeof snapshot.counts.total === "number"
    && Array.isArray(snapshot.queued)
    && Array.isArray(snapshot.ambient)
  );
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
    const inMemoryLedger = store.getLedger(companyId);
    const persistedLedger = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: ATTENTION_LEDGER_STATE_KEY,
    });
    const baseLedger = inMemoryLedger.length > 0
      ? inMemoryLedger
      : isAttentionLedger(persistedLedger)
        ? persistedLedger
        : createEmptyLedger();

    const snapshot = store.rebuildFromLedger(companyId, baseLedger);

    await persistLedger(ctx, companyId, baseLedger);
    await persistSnapshot(ctx, companyId, snapshot);

    const persistedSnapshot = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
    });
    if (!isAttentionLedger(persistedLedger) && isAttentionSnapshot(persistedSnapshot, companyId)) {
      ctx.logger.warn("Legacy snapshot found without replay ledger; rebuilt state may be partial until new events arrive.", {
        companyId,
      });
    }

    return snapshot ?? createEmptySnapshot(companyId);
  });
}
