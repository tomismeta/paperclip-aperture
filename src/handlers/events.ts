import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapPluginEventToAperture } from "../aperture/event-mapper.js";
import type { AttentionLedgerEventEntry } from "../aperture/types.js";
import { emitAttentionUpdate, runAttentionMutation } from "./shared.js";

const SUBSCRIBED_EVENTS: readonly string[] = [
  "activity.logged",
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

const ATTENTION_ACTIVITY_ACTIONS = new Set([
  "issue.document_created",
  "issue.document_updated",
  "issue.document_deleted",
]);
const ISSUE_ENRICH_TTL_MS = 10_000;

function shouldCaptureEvent(
  config: Record<string, unknown>,
  eventType: string,
): boolean {
  if (
    (eventType === "issue.created"
      || eventType === "issue.updated"
      || eventType === "issue.comment.created"
      || eventType === "issue.comment_added")
    && config.captureIssueLifecycle === false
  ) {
    return false;
  }

  if (eventType === "agent.run.failed" && config.captureRunFailures === false) {
    return false;
  }

  return true;
}

async function enrichIssuePayload(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  event: PluginEvent,
): Promise<PluginEvent> {
  if (event.entityType !== "issue" || !event.entityId) return event;
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};

  try {
    const cacheKey = `issue:${event.entityId}:detail`;
    const issue = store.getCachedHostValue<Awaited<ReturnType<typeof ctx.issues.get>>>(event.companyId, cacheKey)
      ?? await ctx.issues.get(event.entityId, event.companyId);
    if (!issue) return event;
    store.setCachedHostValue(event.companyId, cacheKey, issue, ISSUE_ENRICH_TTL_MS);

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
  const config = await ctx.config.get();
  if (!shouldCaptureEvent(config, event.eventType)) return;

  if (event.eventType === "activity.logged") {
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    const action = typeof payload.action === "string" ? payload.action : undefined;
    const entityType = typeof payload.entityType === "string" ? payload.entityType : event.entityType;

    if (entityType === "issue" && action && ATTENTION_ACTIVITY_ACTIONS.has(action)) {
      store.invalidateHostCache(event.companyId, {
        keys: event.entityId ? [`issue:${event.entityId}:documents`] : [],
        prefixes: [
          "issues:blocked",
          "issues:in_review",
        ],
      });
      emitAttentionUpdate(ctx, {
        companyId: event.companyId,
        reason: "event",
        eventType: `activity.${action}`,
        updatedAt: event.occurredAt,
        counts: store.getSnapshot(event.companyId)?.counts ?? {
          now: 0,
          next: 0,
          ambient: 0,
          total: 0,
        },
      });
      ctx.logger.info("Triggered Focus refresh from activity log event", {
        companyId: event.companyId,
        action,
        entityId: event.entityId,
        entityType,
      });
    }
    return;
  }

  if (event.entityType === "issue" && event.entityId) {
    store.invalidateHostCache(event.companyId, {
      keys: [
        `issue:${event.entityId}:detail`,
        `issue:${event.entityId}:comments`,
      ],
      prefixes: ["issues:blocked", "issues:in_review"],
    });
  } else if (event.entityType === "agent") {
    store.invalidateHostCache(event.companyId, {
      keys: ["agents:all"],
    });
  }

  const enriched = await enrichIssuePayload(ctx, store, event);
  const mapped = mapPluginEventToAperture(enriched);
  if (!mapped) return;

  if (enriched.entityType === "approval") {
    store.invalidateApprovals(enriched.companyId);
  }

  const ledgerEntry: AttentionLedgerEventEntry = {
    kind: "event",
    id: `${enriched.eventId}:event`,
    occurredAt: enriched.occurredAt,
    source: {
      eventType: enriched.eventType,
      entityId: enriched.entityId,
      entityType: enriched.entityType,
    },
    apertureEvent: mapped,
  };

  const { snapshot } = await runAttentionMutation(ctx, store, enriched.companyId, () => {
    const { ledger, snapshot } = store.applyEvent(enriched.companyId, ledgerEntry);
    return { ledger, snapshot };
  });
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
