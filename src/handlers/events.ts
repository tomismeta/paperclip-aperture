import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { normalizeSourceEvent } from "@tomismeta/aperture-core/semantic";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapPluginEventToAperture, mapPluginEventToSourceEvent } from "../aperture/event-mapper.js";
import type { AttentionLedgerEventEntry } from "../aperture/types.js";

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
  "issue.document.created",
  "issue.document.updated",
  "issue.document.deleted",
  "issue.relations.updated",
  "agent.run.started",
  "agent.run.failed",
  "agent.run.finished",
  "agent.run.cancelled",
  "agent.status_changed",
  "agent.error_cleared",
] as const;

const ATTENTION_ACTIVITY_ACTIONS = new Set([
  "issue.document_created",
  "issue.document_updated",
  "issue.document_deleted",
]);

const HOST_REFRESH_EVENT_TYPES = new Set([
  "issue.document.created",
  "issue.document.updated",
  "issue.document.deleted",
  "issue.relations.updated",
]);

type EventConfigProvider = () => Record<string, unknown>;

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

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function issueIdForHostRefresh(event: PluginEvent): string | undefined {
  if (event.entityType === "issue" && event.entityId) return event.entityId;
  const issueId = payloadRecord(event.payload).issueId;
  return typeof issueId === "string" && issueId.trim().length > 0 ? issueId : undefined;
}

function invalidateIssueHostState(ctx: PluginContext, store: ApertureCompanyStore, event: PluginEvent): void {
  const issueId = issueIdForHostRefresh(event);
  store.invalidateHostCache(event.companyId, {
    keys: issueId ? [
      `issue:${issueId}:detail`,
      `issue:${issueId}:comments`,
      `issue:${issueId}:documents`,
      `issue:${issueId}:relations`,
    ] : [],
    prefixes: ["issues:blocked", "issues:in_review"],
  });
  ctx.logger.info("Triggered Focus refresh from Paperclip host event", {
    companyId: event.companyId,
    eventType: event.eventType,
    issueId,
  });
}

async function handleEvent(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  event: PluginEvent,
  config: Record<string, unknown>,
): Promise<void> {
  if (!shouldCaptureEvent(config, event.eventType)) return;

  if (event.eventType === "activity.logged") {
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    const action = typeof payload.action === "string" ? payload.action : undefined;
    const entityType = typeof payload.entityType === "string" ? payload.entityType : event.entityType;

    if (entityType === "issue" && action && ATTENTION_ACTIVITY_ACTIONS.has(action)) {
      store.invalidateHostCache(event.companyId, {
        keys: event.entityId ? [
          `issue:${event.entityId}:documents`,
          `issue:${event.entityId}:relations`,
        ] : [],
        prefixes: [
          "issues:blocked",
          "issues:in_review",
        ],
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

  if (HOST_REFRESH_EVENT_TYPES.has(event.eventType)) {
    invalidateIssueHostState(ctx, store, event);
    return;
  }

  if (event.entityType === "issue" && event.entityId) {
    store.invalidateHostCache(event.companyId, {
      keys: [
        `issue:${event.entityId}:detail`,
        `issue:${event.entityId}:comments`,
        `issue:${event.entityId}:relations`,
      ],
      prefixes: ["issues:blocked", "issues:in_review"],
    });
  } else if (event.entityType === "agent") {
    store.invalidateHostCache(event.companyId, {
      keys: ["agents:all"],
    });
  }

  const enriched = event;
  const sourceEvent = mapPluginEventToSourceEvent(enriched);
  const mapped = sourceEvent ? normalizeSourceEvent(sourceEvent) : mapPluginEventToAperture(enriched);
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
    ...(sourceEvent ? { sourceEvent } : {}),
    apertureEvent: mapped,
  };

  store.applyEvent(enriched.companyId, ledgerEntry);
  store.markPersistencePending(enriched.companyId);
  ctx.logger.info("Captured Paperclip event for Aperture", {
    companyId: enriched.companyId,
    eventType: enriched.eventType,
    entityId: enriched.entityId,
    mappedType: mapped.type,
  });
}

export function registerEventHandlers(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  getConfig: EventConfigProvider = () => ({}),
): void {
  for (const eventName of SUBSCRIBED_EVENTS) {
    ctx.events.on(eventName as never, async (event) => {
      await handleEvent(ctx, store, event as PluginEvent, getConfig());
    });
  }
}
