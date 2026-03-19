import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapDecisionToResponse } from "../aperture/response-mapper.js";
import {
  emitAttentionUpdate,
  persistSnapshot,
  requireCompanyId,
  requireStringParam,
} from "./shared.js";

export function registerActionHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.actions.register("acknowledge-frame", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const snapshot = store.submit(
      companyId,
      mapDecisionToResponse({ taskId, interactionId, action: "acknowledge" }),
      { eventType: "plugin.local.acknowledge", entityId: taskId },
    );
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
    const snapshot = store.submit(
      companyId,
      mapDecisionToResponse({ taskId, interactionId, action: "dismiss" }),
      { eventType: "plugin.local.dismiss", entityId: taskId },
    );
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
