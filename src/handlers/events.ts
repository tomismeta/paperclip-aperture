import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapPluginEventToAperture } from "../aperture/event-mapper.js";
import { emitAttentionUpdate, persistSnapshot } from "./shared.js";

const SUBSCRIBED_EVENTS: readonly string[] = [
  "approval.created",
  "approval.decided",
  "approval.approved",
  "approval.rejected",
  "approval.revision_requested",
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "issue.comment_added",
  "agent.run.started",
  "agent.run.failed",
  "agent.run.finished",
  "agent.run.cancelled",
  "agent.status_changed",
] as const;

async function enrichIssuePayload(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<PluginEvent> {
  if (event.entityType !== "issue" || !event.entityId) return event;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};

  try {
    const issue = await ctx.issues.get(event.entityId, event.companyId);
    if (!issue) return event;

    return {
      ...event,
      payload: {
        ...payload,
        title: typeof payload.title === "string" ? payload.title : issue.title,
        issueTitle: typeof payload.issueTitle === "string" ? payload.issueTitle : issue.title,
        identifier: typeof payload.identifier === "string" ? payload.identifier : issue.identifier,
        description: typeof payload.description === "string" ? payload.description : issue.description,
        status: typeof payload.status === "string" ? payload.status : issue.status,
      },
    };
  } catch (error) {
    ctx.logger.warn("Failed to enrich issue payload for Aperture", {
      issueId: event.entityId,
      eventType: event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
    return event;
  }
}

async function handleEvent(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  event: PluginEvent,
): Promise<void> {
  const enriched = await enrichIssuePayload(ctx, event);
  const mapped = mapPluginEventToAperture(enriched);
  if (!mapped) return;

  const { snapshot } = store.ingest(enriched.companyId, mapped, {
    eventType: enriched.eventType,
    entityId: enriched.entityId,
    entityType: enriched.entityType,
  });

  await persistSnapshot(ctx, enriched.companyId, snapshot);
  emitAttentionUpdate(ctx, {
    companyId: enriched.companyId,
    reason: "event",
    eventType: enriched.eventType,
    updatedAt: snapshot.updatedAt,
    counts: snapshot.counts,
  });
  ctx.logger.info("Captured Paperclip event for Aperture", {
    companyId: enriched.companyId,
    eventType: enriched.eventType,
    entityId: enriched.entityId,
    mappedType: mapped.type,
  });
}

export function registerEventHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  for (const eventName of SUBSCRIBED_EVENTS) {
    ctx.events.on(eventName as never, async (event) => {
      await handleEvent(ctx, store, event as PluginEvent);
    });
  }
}
