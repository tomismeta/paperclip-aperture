import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapDecisionToResponse } from "../aperture/response-mapper.js";
import type { AttentionLedgerResponseEntry } from "../aperture/types.js";
import {
  emitAttentionUpdate,
  persistLedger,
  persistSnapshot,
  requireCompanyId,
  requireStringParam,
} from "./shared.js";

export function registerActionHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.actions.register("acknowledge-frame", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const response = mapDecisionToResponse({ taskId, interactionId, action: "acknowledge" });
    const ledgerEntry: AttentionLedgerResponseEntry = {
      kind: "response",
      id: `${taskId}:acknowledge:${Date.now()}`,
      occurredAt: new Date().toISOString(),
      source: {
        eventType: "plugin.local.acknowledge",
        entityId: taskId,
      },
      apertureResponse: response,
    };
    const nextLedger = store.appendLedgerEntry(companyId, ledgerEntry);
    const snapshot = store.submit(
      companyId,
      response,
      { eventType: "plugin.local.acknowledge", entityId: taskId },
    );
    await persistLedger(ctx, companyId, nextLedger);
    await persistSnapshot(ctx, companyId, snapshot);
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.acknowledge",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    return { ok: true, snapshot };
  });

  ctx.actions.register("dismiss-frame", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const response = mapDecisionToResponse({ taskId, interactionId, action: "dismiss" });
    const ledgerEntry: AttentionLedgerResponseEntry = {
      kind: "response",
      id: `${taskId}:dismiss:${Date.now()}`,
      occurredAt: new Date().toISOString(),
      source: {
        eventType: "plugin.local.dismiss",
        entityId: taskId,
      },
      apertureResponse: response,
    };
    const nextLedger = store.appendLedgerEntry(companyId, ledgerEntry);
    const snapshot = store.submit(
      companyId,
      response,
      { eventType: "plugin.local.dismiss", entityId: taskId },
    );
    await persistLedger(ctx, companyId, nextLedger);
    await persistSnapshot(ctx, companyId, snapshot);
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.dismiss",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    return { ok: true, snapshot };
  });
}
