import type { ApertureEvent, SourceEvent } from "@tomismeta/aperture-core";
import { normalizeSourceEvent } from "@tomismeta/aperture-core/semantic";
import { parsePaperclipRunMetadata, type PaperclipRunMetadata } from "./contracts.js";
import {
  createRunLifecycleIndex,
  createRunRetirement,
  deriveRunRetirements,
  observeRunLifecycleEntry,
  runAttentionRelationTarget,
} from "./run-lifecycle.js";
import { createInteractionId, createTaskId, parseTaskId } from "./task-ref.js";
import {
  createEmptyLedger,
  createEmptyReviewState,
  createEmptySnapshot,
  normalizeAttentionSnapshot,
  type AttentionLedger,
  type AttentionLedgerEntry,
  type AttentionLedgerEventEntry,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "./types.js";

export const ATTENTION_STATE_SCHEMA_VERSION = 5;

export type PersistedAttentionStateMeta = {
  persistedAt: string;
  ledgerEntries: number;
  eventEntries: number;
  responseEntries: number;
  overlayResponseEntries: number;
  signalEntries: number;
  replayStrategy: "full-ledger";
  compactionRecommended: boolean;
};

export type PersistedAttentionState = {
  companyId: string;
  ledger: AttentionLedger;
  snapshot: AttentionSnapshot;
  review: AttentionReviewState;
  meta: PersistedAttentionStateMeta;
  needsMigrationPersistence?: true;
};

export type PersistedAttentionStateEnvelope = {
  schemaVersion: typeof ATTENTION_STATE_SCHEMA_VERSION;
  payload: PersistedAttentionState;
};


function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    (entry.kind !== "event" && entry.kind !== "response" && entry.kind !== "overlay-response" && entry.kind !== "signal")
    || typeof entry.id !== "string"
    || typeof entry.occurredAt !== "string"
    || !isLedgerSource(entry.source)
  ) {
    return false;
  }

  if (entry.kind === "event") return !!entry.apertureEvent && typeof entry.apertureEvent === "object";
  if (entry.kind === "response") return !!entry.apertureResponse && typeof entry.apertureResponse === "object";
  if (entry.kind === "overlay-response") {
    return !!entry.apertureResponse && typeof entry.apertureResponse === "object" && !!entry.overlay && typeof entry.overlay === "object";
  }
  return !!entry.apertureSignal && typeof entry.apertureSignal === "object";
}

export function isAttentionLedger(value: unknown): value is AttentionLedger {
  return Array.isArray(value) && value.every(isAttentionLedgerEntry);
}

export function isAttentionReviewState(value: unknown, companyId: string): value is AttentionReviewState {
  if (!value || typeof value !== "object") return false;

  const review = value as Partial<AttentionReviewState>;
  if (review.companyId !== companyId || typeof review.updatedAt !== "string") return false;
  if (!review.frames || typeof review.frames !== "object") return false;

  return Object.values(review.frames).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return (
      (candidate.lastSeenAt === undefined || typeof candidate.lastSeenAt === "string")
      && (candidate.suppressedAt === undefined || typeof candidate.suppressedAt === "string")
      && (candidate.suppressedInteractionId === undefined || typeof candidate.suppressedInteractionId === "string")
    );
  });
}

export function createPersistedAttentionState(
  companyId: string,
  input: {
    ledger: AttentionLedger;
    snapshot?: AttentionSnapshot | null;
    review?: AttentionReviewState | null;
  },
): PersistedAttentionStateEnvelope {
  const snapshot = input.snapshot ?? createEmptySnapshot(companyId);
  const review = input.review ?? createEmptyReviewState(companyId);

  return {
    schemaVersion: ATTENTION_STATE_SCHEMA_VERSION,
    payload: {
      companyId,
      ledger: [...input.ledger],
      snapshot,
      review,
      meta: createPersistedAttentionStateMeta(input.ledger),
    },
  };
}

export function normalizePersistedAttentionState(
  companyId: string,
  value: unknown,
): PersistedAttentionState | null {
  const envelope = asRecord(value);
  if (!envelope) return null;
  const schemaVersion = envelope.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 1 && schemaVersion !== 2
    && schemaVersion !== 3 && schemaVersion !== 4 && schemaVersion !== ATTENTION_STATE_SCHEMA_VERSION) return null;
  const normalized = normalizeStatePayload(companyId, schemaVersion === undefined ? envelope : envelope.payload);
  if (!normalized) return null;
  if (schemaVersion === ATTENTION_STATE_SCHEMA_VERSION) {
    return { ...normalized, review: deriveReviewStateFromLedger(companyId, normalized.ledger, normalized.review) };
  }
  const runMigrated = schemaVersion === 4 ? normalized : migrateRunLifecycleState(companyId, normalized);
  return migrateLegacyApprovalAcknowledgements(companyId, runMigrated);
}

function createPersistedAttentionStateMeta(
  ledger: AttentionLedger,
  persistedAt = new Date().toISOString(),
): PersistedAttentionStateMeta {
  const ledgerEntries = ledger.length;
  return {
    persistedAt,
    ledgerEntries,
    eventEntries: ledger.filter((entry) => entry.kind === "event").length,
    responseEntries: ledger.filter((entry) => entry.kind === "response").length,
    overlayResponseEntries: ledger.filter((entry) => entry.kind === "overlay-response").length,
    signalEntries: ledger.filter((entry) => entry.kind === "signal").length,
    replayStrategy: "full-ledger",
    compactionRecommended: ledgerEntries > 2_000,
  };
}

function normalizeStatePayload(
  companyId: string,
  value: unknown,
): PersistedAttentionState | null {
  const payload = asRecord(value);
  if (!payload || payload.companyId !== companyId) return null;
  const snapshot = normalizeAttentionSnapshot(companyId, payload.snapshot);
  if (!snapshot) return null;
  const ledger = isAttentionLedger(payload.ledger) ? payload.ledger : createEmptyLedger();
  return {
    companyId,
    ledger,
    snapshot,
    review: isAttentionReviewState(payload.review, companyId) ? payload.review : createEmptyReviewState(companyId),
    meta: normalizePersistedAttentionStateMeta(payload.meta, ledger),
  };
}

export function normalizeSplitAttentionState(
  companyId: string,
  input: { ledger: unknown; snapshot: unknown; review: unknown },
): PersistedAttentionState {
  const ledger = isAttentionLedger(input.ledger) ? input.ledger : createEmptyLedger();
  return migrateLegacyApprovalAcknowledgements(companyId, migrateRunLifecycleState(companyId, {
    companyId,
    ledger,
    snapshot: normalizeAttentionSnapshot(companyId, input.snapshot)
      ?? { ...createEmptySnapshot(companyId), updatedAt: new Date(0).toISOString() },
    review: isAttentionReviewState(input.review, companyId) ? input.review : createEmptyReviewState(companyId),
    meta: createPersistedAttentionStateMeta(ledger),
  }));
}

function laterIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function validTime(value: string | undefined): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function runMetadata(entry: AttentionLedgerEventEntry): PaperclipRunMetadata | null {
  const source = parsePaperclipRunMetadata(entry.sourceEvent?.metadata?.paperclipRun);
  const normalized = parsePaperclipRunMetadata(entry.apertureEvent.metadata?.paperclipRun);
  return source || normalized ? { ...source, ...normalized } : null;
}

export function deriveReviewStateFromLedger(
  companyId: string,
  ledger: AttentionLedger,
  persistedReview: AttentionReviewState | null,
): AttentionReviewState {
  const review: AttentionReviewState = persistedReview
    ? {
        ...persistedReview,
        frames: Object.fromEntries(Object.entries(persistedReview.frames).map(([taskId, state]) => [taskId, { ...state }])),
      }
    : { ...createEmptyReviewState(companyId), updatedAt: new Date(0).toISOString() };
  const runStatuses = new Map<string, PaperclipRunMetadata["status"]>();
  const firstFailures = new Map<string, string>();
  let legacyAcknowledgements: Map<string, string> | undefined;
  for (const entry of ledger) {
    if (entry.kind === "event") {
      if (parseTaskId(entry.apertureEvent.taskId)?.kind !== "run") continue;
      const metadata = runMetadata(entry);
      runStatuses.set(entry.apertureEvent.taskId, metadata?.status);
      if (metadata?.status === "failed" && entry.apertureEvent.type === "task.updated"
        && entry.apertureEvent.status === "failed" && !firstFailures.has(entry.apertureEvent.taskId)) {
        firstFailures.set(entry.apertureEvent.taskId, entry.occurredAt);
      }
      continue;
    }
    if (entry.kind !== "response" && entry.kind !== "overlay-response") continue;
    const { taskId, interactionId, response } = entry.apertureResponse;
    const current = review.frames[taskId] ?? {};
    const isRun = parseTaskId(taskId)?.kind === "run";
    const canSuppress = !isRun
      || (runStatuses.get(taskId) === "failed" && interactionId === `interaction:${taskId}:status`);
    const next = { ...current, lastSeenAt: laterIso(current.lastSeenAt, entry.occurredAt) };
    const persisted = persistedReview?.frames[taskId];
    if (persisted?.suppressedAt !== undefined && persisted.suppressedInteractionId === undefined) {
      if (entry.kind === "response" && response.kind === "acknowledged" && canSuppress
        && entry.source.eventType === "plugin.local.acknowledge"
        && entry.source.entityId === taskId && interactionId.trim().length > 0) {
        (legacyAcknowledgements ??= new Map()).set(taskId, interactionId);
      } else {
        legacyAcknowledgements?.delete(taskId);
      }
    }
    const preserveLegacyMarker = persisted?.suppressedAt !== undefined
      && persisted.suppressedInteractionId === undefined
      && persisted.suppressedAt.localeCompare(entry.occurredAt) >= 0;
    if ((response.kind === "acknowledged" || response.kind === "dismissed") && canSuppress
      && !preserveLegacyMarker
      && (!current.suppressedAt || entry.occurredAt.localeCompare(current.suppressedAt) >= 0)) {
      next.suppressedAt = entry.occurredAt;
      const legacyApproval = entry.kind === "overlay-response"
        && entry.overlay.compatibility === "core-0.9-approval-acknowledgement";
      if (response.kind === "acknowledged" && !legacyApproval) next.suppressedInteractionId = interactionId;
      else delete next.suppressedInteractionId;
    }
    review.frames[taskId] = next;
    review.lastSeenAt = laterIso(review.lastSeenAt, entry.occurredAt);
    review.updatedAt = laterIso(review.updatedAt, entry.occurredAt) ?? entry.occurredAt;
  }
  // Older workers stamped review after the response; recover its owner, not a new timestamp.
  if (legacyAcknowledgements) {
    for (const [taskId, interactionId] of legacyAcknowledgements) {
      const marker = review.frames[taskId];
      if (marker?.suppressedAt !== undefined && marker.suppressedInteractionId === undefined) {
        marker.suppressedInteractionId = interactionId;
      }
    }
  }
  for (const taskId of runStatuses.keys()) {
    const marker = review.frames[taskId];
    if (!marker?.suppressedAt) continue;
    const failureAt = validTime(firstFailures.get(taskId));
    const suppressionAt = validTime(marker.suppressedAt);
    if (failureAt === null || suppressionAt === null || suppressionAt < failureAt) {
      delete marker.suppressedAt;
      delete marker.suppressedInteractionId;
    }
  }
  return review;
}

function isRunLifecycleEntry(entry: AttentionLedgerEventEntry): boolean {
  if (entry.apertureEvent.metadata?.paperclipRunRetirement || entry.sourceEvent?.metadata?.paperclipRunRetirement) return false;
  return /^agent\.run\.(started|failed|timed_out|finished|cancelled)$/.test(entry.source.eventType)
    || (runMetadata(entry) !== null && parseTaskId(entry.apertureEvent.taskId)?.kind === "run");
}

function migrateRunEntry(entry: AttentionLedgerEventEntry): AttentionLedgerEventEntry {
  const event = entry.apertureEvent;
  const oldTask = parseTaskId(event.taskId);
  const stored = runMetadata(entry);
  const entityId = entry.source.entityId?.trim() ? entry.source.entityId : undefined;
  const runId = stored?.runId ?? (
    entry.source.entityType === "run" || entry.source.entityType === "heartbeat_run"
      ? entityId
      : undefined
  );
  const status: PaperclipRunMetadata["status"] = event.type === "task.started" ? "running"
    : event.type === "task.completed" ? "completed"
      : event.type === "task.cancelled" ? "cancelled"
        : event.type === "task.updated" && event.status === "failed" ? "failed" : stored?.status;
  const issueId = stored?.issueId ?? (status === "failed" && oldTask?.kind === "issue" ? oldTask.id : undefined);
  const agentId = stored?.agentId ?? (
    entry.source.entityType === "agent" ? entityId
      : oldTask?.kind === "agent" ? oldTask.id : undefined
  );
  const metadata: PaperclipRunMetadata = {
    ...stored,
    ...(runId ? { runId } : { legacyIdentity: true }),
    ...(agentId ? { agentId } : {}),
    ...(issueId ? { issueId } : {}),
    ...(status ? { status } : {}),
    ...(stored?.hostStatus ? {} : { hostStatus: entry.source.eventType.split(".").at(-1) }),
  };
  if (runId) delete metadata.legacyIdentity;
  const taskId = createTaskId("run", runId ?? `legacy:${entry.id}`);
  const source = { ...event.source, id: "paperclip:run", kind: "paperclip", label: "Paperclip run" };
  const relationHints = [{ kind: "same_issue" as const, target: runAttentionRelationTarget(taskId, issueId) }];
  const apertureEvent: ApertureEvent = {
    ...event,
    taskId,
    source,
    metadata: { ...entry.sourceEvent?.metadata, ...event.metadata, paperclipRun: metadata },
    ...(event.semantic ? { semantic: { ...event.semantic, relationHints } } : {}),
    ...(event.type === "human.input.requested" ? { interactionId: `interaction:${taskId}:status` } : {}),
  };
  const sourceEvent: SourceEvent | undefined = entry.sourceEvent ? {
    ...entry.sourceEvent,
    taskId,
    source: { ...entry.sourceEvent.source, ...source },
    metadata: { ...event.metadata, ...entry.sourceEvent.metadata, paperclipRun: metadata },
    semanticHints: { ...entry.sourceEvent.semanticHints, relationHints },
    ...(entry.sourceEvent.type === "human.input.requested" ? { interactionId: `interaction:${taskId}:status` } : {}),
  } : undefined;
  return {
    ...entry,
    apertureEvent: sourceEvent ? { ...normalizeSourceEvent(sourceEvent), id: event.id } : apertureEvent,
    ...(sourceEvent ? { sourceEvent } : {}),
  };
}

type RunInteractionOwner = {
  originalTaskId: string;
  taskId: string;
  from: string;
  until?: string;
};

function replacesSharedStatus(event: ApertureEvent): boolean {
  return event.type === "task.started" || event.type === "task.completed" || event.type === "task.cancelled"
    || (event.type === "task.updated" && event.status !== "failed");
}

export function migrateRunLifecycleState(
  companyId: string,
  state: PersistedAttentionState,
): PersistedAttentionState {
  const ledger: AttentionLedger = [];
  const index = createRunLifecycleIndex();
  const originalIds = new Set(state.ledger.map((entry) => entry.id));
  const appendedIds = new Set<string>();
  const owners = new Map<string, RunInteractionOwner>();
  const intervals: RunInteractionOwner[] = [];
  const firstFailures = new Map<string, string>();
  const independentMarkerTimes = new Map<string, Set<string>>();
  const review: AttentionReviewState = {
    ...state.review,
    frames: Object.fromEntries(Object.entries(state.review.frames).map(([taskId, marker]) => [taskId, { ...marker }])),
  };
  const keyFor = (taskId: string, interactionId = `interaction:${taskId}:status`) => `${taskId}\0${interactionId}`;
  const appendRetirements = (entries: AttentionLedgerEventEntry[]) => {
    for (const entry of entries.sort((left, right) => left.apertureEvent.taskId.localeCompare(right.apertureEvent.taskId))) {
      if (originalIds.has(entry.id) || appendedIds.has(entry.id)) continue;
      ledger.push(entry);
      appendedIds.add(entry.id);
      observeRunLifecycleEntry(index, entry);
    }
  };

  for (const original of state.ledger) {
    let entry = original;
    const retirements: AttentionLedgerEventEntry[] = [];
    if (original.kind === "event") {
      const key = keyFor(original.apertureEvent.taskId);
      const previousOwner = owners.get(key);
      const isRun = isRunLifecycleEntry(original);
      const eventEntry = isRun ? migrateRunEntry(original) : original;
      entry = eventEntry;
      if (isRun) {
        if (previousOwner?.taskId !== eventEntry.apertureEvent.taskId) {
          if (previousOwner) previousOwner.until = original.occurredAt;
          const owner = { originalTaskId: original.apertureEvent.taskId, taskId: eventEntry.apertureEvent.taskId, from: original.occurredAt };
          owners.set(key, owner);
          intervals.push(owner);
        }
        if (runMetadata(eventEntry)?.status === "failed" && !firstFailures.has(eventEntry.apertureEvent.taskId)) {
          firstFailures.set(eventEntry.apertureEvent.taskId, eventEntry.occurredAt);
        }
      } else if (previousOwner && replacesSharedStatus(original.apertureEvent)) {
        const previous = index.get(previousOwner.taskId);
        if (previous?.metadata.status === "failed" && !previous.retired) {
          retirements.push(createRunRetirement(previous, original, "legacy-replaced"));
        }
        previousOwner.until = original.occurredAt;
        owners.delete(key);
      }
      if (!eventEntry.apertureEvent.metadata?.paperclipRunRetirement && !eventEntry.sourceEvent?.metadata?.paperclipRunRetirement) {
        // Shared-status replacement has its own historical reason; do not emit a second clear for that task.
        const replacedTasks = new Set(retirements.map((retirement) => retirement.apertureEvent.taskId));
        retirements.push(...deriveRunRetirements(index, eventEntry).filter((retirement) => !replacedTasks.has(retirement.apertureEvent.taskId)));
      }
      ledger.push(eventEntry);
      observeRunLifecycleEntry(index, eventEntry);
    } else {
      const target = original.kind === "signal" ? original.apertureSignal : original.apertureResponse;
      if (target.interactionId !== `interaction:${target.taskId}:status`) {
        const times = independentMarkerTimes.get(target.taskId) ?? new Set<string>();
        times.add(original.occurredAt);
        independentMarkerTimes.set(target.taskId, times);
      }
      const owner = owners.get(keyFor(target.taskId, target.interactionId));
      if (owner) {
        const rewritten = { ...target, taskId: owner.taskId, interactionId: `interaction:${owner.taskId}:status` };
        if (original.kind === "signal") {
          entry = { ...original, apertureSignal: { ...original.apertureSignal, taskId: rewritten.taskId, interactionId: rewritten.interactionId } };
        } else {
          entry = { ...original, apertureResponse: { ...original.apertureResponse, taskId: rewritten.taskId, interactionId: rewritten.interactionId } };
          const responseKind = original.apertureResponse.response.kind;
          const run = index.get(owner.taskId);
          if ((responseKind === "acknowledged" || responseKind === "dismissed") && run?.metadata.status === "failed" && !run.retired) {
            retirements.push(createRunRetirement(run, original, "legacy-replaced"));
          }
        }
      }
      ledger.push(entry);
    }
    appendedIds.add(entry.id);
    appendRetirements(retirements);
  }

  for (const owner of intervals) {
    const marker = state.review.frames[owner.originalTaskId];
    if (!marker) continue;
    const from = validTime(owner.from);
    const until = validTime(owner.until);
    const covered = (value: string | undefined): boolean => {
      const at = validTime(value);
      return value !== undefined && at !== null && from !== null && at >= from && (until === null || at < until)
        && !independentMarkerTimes.get(owner.originalTaskId)?.has(value);
    };
    const firstFailureAt = validTime(firstFailures.get(owner.taskId));
    const suppressionAt = validTime(marker.suppressedAt);
    const current = review.frames[owner.taskId] ?? {};
    const lastSeenAt = covered(marker.lastSeenAt) ? laterIso(current.lastSeenAt, marker.lastSeenAt) : current.lastSeenAt;
    const suppressedAt = covered(marker.suppressedAt) && firstFailureAt !== null && suppressionAt !== null && suppressionAt >= firstFailureAt
      ? laterIso(current.suppressedAt, marker.suppressedAt) : current.suppressedAt;
    if (lastSeenAt || suppressedAt) review.frames[owner.taskId] = { ...current, ...(lastSeenAt ? { lastSeenAt } : {}), ...(suppressedAt ? { suppressedAt } : {}) };
  }
  return {
    companyId,
    ledger,
    snapshot: state.snapshot,
    review: deriveReviewStateFromLedger(companyId, ledger, review),
    meta: createPersistedAttentionStateMeta(ledger, state.meta.persistedAt),
    needsMigrationPersistence: true,
  };
}

function isLegacyMapperApprovalRequest(entry: AttentionLedgerEventEntry): boolean {
  const event = entry.sourceEvent ?? entry.apertureEvent;
  if (event.type !== "human.input.requested" || event.request?.kind !== "approval") return false;
  const kind = entry.source.eventType === "approval.created" ? "approval"
    : entry.source.eventType === "agent.status_changed" ? "agent" : null;
  if (!kind || entry.source.entityType !== kind || !entry.source.entityId?.trim()) return false;
  const taskId = createTaskId(kind, entry.source.entityId);
  return event.taskId === taskId
    && event.interactionId === createInteractionId(taskId, kind === "approval" ? "approval" : "pending-approval");
}

function migrateLegacyApprovalAcknowledgements(
  companyId: string,
  state: PersistedAttentionState,
): PersistedAttentionState {
  const approvalRequests = new Map<string, Set<string>>();
  const ledger = state.ledger.map((entry): AttentionLedgerEntry => {
    if (entry.kind === "event") {
      // Match the representation actually published during Core replay.
      const event = entry.sourceEvent ?? entry.apertureEvent;
      if (event.type === "human.input.requested") {
        if (isLegacyMapperApprovalRequest(entry)) {
          let interactions = approvalRequests.get(event.taskId);
          if (!interactions) {
            interactions = new Set();
            approvalRequests.set(event.taskId, interactions);
          }
          interactions.add(event.interactionId);
        } else {
          approvalRequests.get(event.taskId)?.delete(event.interactionId);
        }
      } else if (event.type === "task.completed" || event.type === "task.cancelled") {
        approvalRequests.delete(event.taskId);
      }
      return entry;
    }
    if (entry.kind !== "response") return entry;
    const { taskId, interactionId, response } = entry.apertureResponse;
    const interactions = approvalRequests.get(taskId);
    if (response.kind === "acknowledged"
      && entry.source.eventType === "plugin.local.acknowledge"
      && entry.source.entityId === taskId
      && interactions?.has(interactionId)) {
      // Audit-only acknowledgements leave Core pending, including for a later duplicate.
      return {
        ...entry,
        kind: "overlay-response",
        overlay: {
          kind: "display_overlay",
          reason: "Legacy approval acknowledgement preserved as local attention history; no native decision was made.",
          compatibility: "core-0.9-approval-acknowledgement",
        },
      };
    }
    interactions?.delete(interactionId);
    return entry;
  });
  return {
    ...state,
    ledger,
    review: deriveReviewStateFromLedger(companyId, ledger, state.review),
    meta: createPersistedAttentionStateMeta(ledger, state.meta.persistedAt),
    needsMigrationPersistence: true,
  };
}

function normalizePersistedAttentionStateMeta(
  value: unknown,
  ledger: AttentionLedger,
): PersistedAttentionStateMeta {
  const meta = asRecord(value);
  if (
    meta
    && typeof meta.persistedAt === "string"
    && typeof meta.ledgerEntries === "number"
    && typeof meta.eventEntries === "number"
    && typeof meta.responseEntries === "number"
  ) {
    return {
      persistedAt: meta.persistedAt,
      ledgerEntries: meta.ledgerEntries,
      eventEntries: meta.eventEntries,
      responseEntries: meta.responseEntries,
      overlayResponseEntries: typeof meta.overlayResponseEntries === "number" ? meta.overlayResponseEntries : ledger.filter((entry) => entry.kind === "overlay-response").length,
      signalEntries: typeof meta.signalEntries === "number" ? meta.signalEntries : ledger.filter((entry) => entry.kind === "signal").length,
      replayStrategy: "full-ledger",
      compactionRecommended: typeof meta.compactionRecommended === "boolean" ? meta.compactionRecommended : ledger.length > 2_000,
    };
  }

  return createPersistedAttentionStateMeta(ledger);
}
