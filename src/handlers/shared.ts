import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AttentionLedger, AttentionSnapshot } from "../aperture/types.js";

export const ATTENTION_SNAPSHOT_STATE_KEY = "attention-snapshot";
export const ATTENTION_LEDGER_STATE_KEY = "attention-ledger";
export const ATTENTION_UPDATES_STREAM = "attention-updates";
export const MAX_LEDGER_ENTRIES = 250;

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
    ledger.slice(-MAX_LEDGER_ENTRIES),
  );
}

export function emitAttentionUpdate(
  ctx: PluginContext,
  event: AttentionUpdateEvent,
): void {
  ctx.streams.open(ATTENTION_UPDATES_STREAM, event.companyId);
  ctx.streams.emit(ATTENTION_UPDATES_STREAM, event);
}
