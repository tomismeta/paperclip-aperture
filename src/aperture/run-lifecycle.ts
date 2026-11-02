import type { Issue } from "@paperclipai/plugin-sdk";
import { normalizeSourceEvent } from "@tomismeta/aperture-core/semantic";
import type { SourceEvent } from "@tomismeta/aperture-core";
import {
  parsePaperclipRunMetadata,
  readPaperclipRunMetadata,
  withFocusDecisionMetadata,
  type PaperclipRunMetadata,
  type PaperclipRunRecoveryMetadata,
} from "./contracts.js";
import { humanizeToken } from "./attention-context.js";
import type { StoredFrameCandidate } from "./frame-model.js";
import { parseTaskId } from "./task-ref.js";
import type { AttentionLedger, AttentionLedgerEntry, AttentionLedgerEventEntry, StoredAttentionFrame } from "./types.js";

// Core groups visible episodes by relation target, not task ID. Scope execution
// attention independently while keeping the real issue association in metadata.
export function runAttentionRelationTarget(taskId: string, issueId?: string): string {
  return issueId
    ? `paperclip:issue:${encodeURIComponent(issueId)}:execution:${encodeURIComponent(taskId)}`
    : `paperclip:execution:${encodeURIComponent(taskId)}`;
}

export type RunRetirementReason = "successor" | "agent-cleared" | "issue-closed" | "legacy-replaced";

export type RunLifecycleRecord = {
  taskId: string;
  metadata: PaperclipRunMetadata;
  observedStartedAt?: string;
  hostStartedAt?: string;
  failureFinishedAt?: string;
  latestTransition: AttentionLedgerEventEntry["apertureEvent"]["type"];
  retired: boolean;
};

export type RunLifecycleIndex = Map<string, RunLifecycleRecord>;

function validTimestamp(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function metadataForEntry(entry: AttentionLedgerEventEntry): PaperclipRunMetadata | null {
  return parsePaperclipRunMetadata(entry.sourceEvent?.metadata?.paperclipRun)
    ?? parsePaperclipRunMetadata(entry.apertureEvent.metadata?.paperclipRun);
}

function mergedMetadata(previous: PaperclipRunMetadata | undefined, current: PaperclipRunMetadata): PaperclipRunMetadata {
  return { ...previous, ...Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined)) };
}

export function observeRunLifecycleEntry(index: RunLifecycleIndex, entry: AttentionLedgerEventEntry): void {
  const event = entry.apertureEvent;
  if (parseTaskId(event.taskId)?.kind !== "run") return;
  const metadata = metadataForEntry(entry);
  if (!metadata) return;
  const previous = index.get(event.taskId);
  const retirement = entry.sourceEvent?.metadata?.paperclipRunRetirement ?? event.metadata?.paperclipRunRetirement;
  const observedAt = validTimestamp(entry.occurredAt);
  index.set(event.taskId, {
    taskId: event.taskId,
    metadata: mergedMetadata(previous?.metadata, metadata),
    observedStartedAt: previous?.observedStartedAt ?? (event.type === "task.started" ? observedAt : undefined),
    hostStartedAt: metadata.startedAt ?? previous?.hostStartedAt,
    failureFinishedAt: !retirement && event.type === "task.updated" && event.status === "failed"
      ? metadata.finishedAt ?? previous?.failureFinishedAt ?? observedAt
      : previous?.failureFinishedAt,
    latestTransition: event.type,
    retired: Boolean(retirement) || event.type === "task.completed" || event.type === "task.cancelled"
      || (previous?.retired ?? false),
  });
}

// Replay only materialized history: rebuilding this projection never creates events.
export function createRunLifecycleIndex(ledger: AttentionLedger = []): RunLifecycleIndex {
  const index: RunLifecycleIndex = new Map();
  for (const entry of ledger) {
    if (entry.kind === "event") observeRunLifecycleEntry(index, entry);
  }
  return index;
}

export function createRunRetirement(
  record: RunLifecycleRecord,
  trigger: AttentionLedgerEntry,
  reason: RunRetirementReason,
): AttentionLedgerEventEntry {
  const triggerRun = trigger.kind === "event" ? metadataForEntry(trigger) : null;
  const id = `run-retirement:${encodeURIComponent(trigger.id)}:${encodeURIComponent(record.taskId)}:${reason}`;
  const reasonText = reason === "successor"
    ? `Failure attention superseded by successful run ${triggerRun?.runId}.`
    : reason === "agent-cleared" ? "Agent error cleared in Paperclip."
      : reason === "issue-closed" ? "Linked issue closed in Paperclip."
        : "Legacy run attention replaced.";
  const sourceEvent: SourceEvent = {
    id,
    type: "task.cancelled",
    taskId: record.taskId,
    timestamp: trigger.occurredAt,
    source: { id: "paperclip:run", kind: "paperclip", label: "Paperclip run" },
    reason: reasonText,
    metadata: {
      paperclipRun: { ...record.metadata, status: "failed" },
      paperclipRunRetirement: { triggerEventId: trigger.id, reason },
    },
  };
  return {
    kind: "event",
    id,
    occurredAt: trigger.occurredAt,
    source: trigger.source,
    sourceEvent,
    apertureEvent: normalizeSourceEvent(sourceEvent),
  };
}

export function deriveRunRetirements(index: RunLifecycleIndex, trigger: AttentionLedgerEventEntry): AttentionLedgerEventEntry[] {
  const event = trigger.apertureEvent;
  const currentMetadata = metadataForEntry(trigger);
  const successor = currentMetadata ? mergedMetadata(index.get(event.taskId)?.metadata, currentMetadata) : null;
  const successorStart = successor?.startedAt ?? index.get(event.taskId)?.hostStartedAt
    ?? index.get(event.taskId)?.observedStartedAt;
  const metadata = trigger.sourceEvent?.metadata ?? event.metadata;
  const issueStatus = metadata?.paperclipIssueStatus;
  const issueClosed = issueStatus === "done" || issueStatus === "cancelled"
    || (trigger.source.eventType === "issue.updated" && event.type === "task.updated" && event.status === "completed");
  const task = parseTaskId(event.taskId);
  const issueId = issueClosed && task?.kind === "issue" ? task.id : undefined;
  const agentId = trigger.source.eventType === "agent.error_cleared"
    ? (trigger.source.entityType === "agent" ? trigger.source.entityId : task?.kind === "agent" ? task.id : undefined)
    : undefined;
  const retirements: AttentionLedgerEventEntry[] = [];
  for (const record of index.values()) {
    if (record.retired || record.metadata.status !== "failed" || record.taskId === event.taskId) continue;
    let reason: RunRetirementReason | undefined;
    if (agentId && record.metadata.agentId === agentId) reason = "agent-cleared";
    else if (issueId && record.metadata.issueId === issueId) reason = "issue-closed";
    else if (event.type === "task.completed" && successor?.runId && !successor.legacyIdentity
      && record.metadata.runId && !record.metadata.legacyIdentity && successor.runId !== record.metadata.runId
      && successorStart && record.failureFinishedAt
      && Date.parse(successorStart) > Date.parse(record.failureFinishedAt)) {
      const sameScope = successor.issueId
        ? record.metadata.issueId === successor.issueId
        : !record.metadata.issueId && Boolean(successor.agentId) && record.metadata.agentId === successor.agentId;
      if (sameScope) reason = "successor";
    }
    if (reason) retirements.push(createRunRetirement(record, trigger, reason));
  }
  return retirements.sort((left, right) => left.apertureEvent.taskId.localeCompare(right.apertureEvent.taskId));
}

// Company scope is checked by the reconciler against its canonical snapshot and issue list.
export function runRetryCandidate(frame: StoredAttentionFrame, issue: Issue): StoredFrameCandidate | null {
  const run = readPaperclipRunMetadata(frame);
  const task = parseTaskId(frame.taskId);
  const retry = issue.scheduledRetry;
  if (task?.kind !== "run" || !run?.runId || run.legacyIdentity || run.status !== "failed"
    || task.id !== run.runId || run.issueId !== issue.id || !run.agentId
    || !retry || retry.retryOfRunId !== run.runId || retry.agentId !== run.agentId
    || !retry.runId?.trim() || retry.runId === run.runId
    || (retry.status !== "scheduled_retry" && retry.status !== "queued" && retry.status !== "running")
    || retry.retryExhaustedReason || issue.blockedInboxAttention
    || issue.activeRecoveryAction?.status === "active" || issue.activeRecoveryAction?.status === "escalated"
    || !Number.isSafeInteger(retry.scheduledRetryAttempt) || retry.scheduledRetryAttempt < 0) return null;

  const retryTime = retry.scheduledRetryAt instanceof Date
    ? retry.scheduledRetryAt.getTime()
    : retry.scheduledRetryAt ? Date.parse(retry.scheduledRetryAt) : NaN;
  const scheduledRetryAt = Number.isFinite(retryTime) ? new Date(retryTime).toISOString() : undefined;
  const recovery: PaperclipRunRecoveryMetadata = {
    successorRunId: retry.runId,
    status: retry.status,
    ...(scheduledRetryAt ? { scheduledRetryAt } : {}),
    attempt: retry.scheduledRetryAttempt,
  };
  const rationale = ["Paperclip reports an active automatic retry for this failed run."];
  return {
    lane: "ambient",
    frame: withFocusDecisionMetadata({
      ...frame,
      summary: "Paperclip is retrying this run automatically.",
      consequence: "low",
      tone: "ambient",
      context: {
        ...frame.context,
        items: [
          ...(frame.context?.items ?? []).filter((item) => !["retry-status", "retry-at", "retry-attempt"].includes(item.id)),
          { id: "retry-status", label: "Retry status", value: humanizeToken(retry.status) },
          ...(scheduledRetryAt ? [{ id: "retry-at", label: "Next retry", value: scheduledRetryAt }] : []),
          { id: "retry-attempt", label: "Retry attempt", value: String(retry.scheduledRetryAttempt) },
        ],
      },
      provenance: { ...frame.provenance, whyNow: rationale[0], factors: rationale },
      metadata: { ...frame.metadata, paperclipRunRecovery: recovery },
    }, {
      owner: "paperclip_reconciliation",
      lane: "ambient",
      sourcePolicy: "run.scheduledRetry",
      rationale,
    }),
  };
}
