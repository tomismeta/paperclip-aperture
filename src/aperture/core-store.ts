import {
  ApertureCore,
  type ApertureEvent,
  type AttentionSignal,
  type AttentionFrame,
  type AttentionResponse,
} from "@tomismeta/aperture-core";
import type { ApertureTrace } from "@tomismeta/aperture-core/trace";
import type { DisplayEngagement, StoredFrameCandidate } from "./frame-model.js";
import { readFocusMetadata } from "./contracts.js";
import { createTaskId } from "./task-ref.js";
import {
  createAttentionSnapshot,
  createEmptyLedger,
  createEmptyReviewState,
  type AttentionCoreDiagnostics,
  type AttentionLedgerEntry,
  type AttentionLedgerEventEntry,
  type AttentionLedgerOverlayResponseEntry,
  type AttentionLedgerResponseEntry,
  type AttentionLedgerSignalEntry,
  type AttentionLedger,
  type AttentionReviewState,
  type AttentionSnapshot,
  type SnapshotSource,
} from "./types.js";
import { FOCUS_SURFACE_CAPABILITIES } from "./core-capabilities.js";
import type { ApprovalRecord } from "./approval-frames.js";
import { deriveReviewStateFromLedger } from "./persisted-state.js";
import {
  createRunLifecycleIndex,
  deriveRunRetirements,
  observeRunLifecycleEntry,
  type RunLifecycleIndex,
} from "./run-lifecycle.js";

type CachedCandidates = {
  key: string;
  candidates: StoredFrameCandidate[];
  expiresAt: number;
};

type HostCacheEntry = {
  value: unknown;
  expiresAt: number;
};

type PersistenceStatus = {
  state: "healthy" | "faulted";
  updatedAt?: string;
  lastError?: string;
};

type CompanySession = {
  core: ApertureCore;
  snapshot: AttentionSnapshot | null;
  ledger: AttentionLedger;
  runIndex: RunLifecycleIndex;
  review: AttentionReviewState;
  hydrated: boolean;
  pendingHydrationEvents: Map<string, { entry: AttentionLedgerEventEntry; capturePrimary: boolean }>;
  pendingPersistence: boolean;
  eventCount: number;
  traces: ApertureTrace[];
  reconciledCandidates: CachedCandidates | null;
  lastGoodReconciledCandidates: StoredFrameCandidate[] | null;
  displayEngagement: DisplayEngagement | null;
  approvals: {
    records: ApprovalRecord[] | null;
    dirty: boolean;
    lastLoadedAt?: string;
    lastError?: string;
  };
  hostCache: Map<string, HostCacheEntry>;
  hostDataRevision: number;
  persistence: PersistenceStatus;
  lastTouchedAt: number;
};

const MAX_TRACE_HISTORY = 100;
const MAX_COMPANY_SESSIONS = 100;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const RECONCILED_CANDIDATE_TTL_MS = 15_000;
const APPROVAL_CACHE_TTL_MS = 15_000;

export class ApertureCompanyStore {
  private readonly sessions = new Map<string, CompanySession>();
  private readonly inFlightLoads = new Map<string, Promise<unknown>>();

  runSingleFlight<T>(
    companyId: string,
    namespace: string,
    key: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const flightKey = JSON.stringify([companyId, namespace, key]);
    const current = this.inFlightLoads.get(flightKey);
    if (current) return current as Promise<T>;

    const flight = Promise.resolve().then(loader);
    this.inFlightLoads.set(flightKey, flight);
    const clear = () => {
      if (this.inFlightLoads.get(flightKey) === flight) {
        this.inFlightLoads.delete(flightKey);
      }
    };
    void flight.then(clear, clear);
    return flight;
  }

  getHealth() {
    return {
      trackedCompanies: this.sessions.size,
      maxCompanySessions: MAX_COMPANY_SESSIONS,
      idleSessionTtlMs: SESSION_IDLE_TTL_MS,
      faultedCompanies: [...this.sessions.values()].filter((session) => session.persistence.state === "faulted").length,
      hostCacheEntries: [...this.sessions.values()].reduce((sum, session) => sum + session.hostCache.size, 0),
      cachedReconciliations: [...this.sessions.values()].filter((session) => session.reconciledCandidates !== null).length,
    };
  }

  getCoreDiagnostics(companyId: string): AttentionCoreDiagnostics | null {
    const session = this.sessions.get(companyId);
    if (!session) return null;
    this.touchSession(session);

    const snapshot = this.syncSnapshotFromCore(companyId, session);
    const currentNowTask = snapshot.now
      ? {
          taskId: snapshot.now.taskId,
          interactionId: snapshot.now.interactionId,
          signalSummary: session.core.getSignalSummary(snapshot.now.taskId),
          attentionState: session.core.getAttentionState(snapshot.now.taskId),
        }
      : null;

    return {
      eventCount: session.eventCount,
      persistence: { ...session.persistence },
      surfaceCapabilities: session.core.getSurfaceCapabilities(),
      operatorPresence: session.core.getOperatorPresence(),
      globalSignalSummary: session.core.getSignalSummary(),
      globalAttentionState: session.core.getAttentionState(),
      memoryProfile: session.core.snapshotMemoryProfile(snapshot.updatedAt),
      ledger: ledgerDiagnostics(session.ledger),
      host: {
        cacheEntries: session.hostCache.size,
        hostDataRevision: session.hostDataRevision,
        approvalRecords: session.approvals.records?.length ?? 0,
        approvalsDirty: this.approvalsDirty(companyId),
        approvalAdapterLastLoadedAt: session.approvals.lastLoadedAt,
        approvalAdapterLastError: session.approvals.lastError,
      },
      currentNowTask,
    };
  }

  hasSession(companyId: string): boolean {
    return this.sessions.has(companyId);
  }

  hasHydratedState(companyId: string): boolean {
    return this.sessions.get(companyId)?.hydrated ?? false;
  }

  hydrate(
    companyId: string,
    input: {
      ledger: AttentionLedger;
      snapshot?: AttentionSnapshot | null;
      review?: AttentionReviewState | null;
    },
  ): {
    snapshot: AttentionSnapshot;
    review: AttentionReviewState;
  } {
    const existing = this.sessions.get(companyId);
    if (existing?.hydrated) {
      this.touchSession(existing);
      return {
        snapshot: existing.snapshot ?? createAttentionSnapshot(companyId, existing.core.getAttentionView()),
        review: existing.review,
      };
    }

    const session = this.buildSession(companyId, input, existing);
    session.hydrated = true;
    session.pendingHydrationEvents = new Map();
    this.sessions.set(companyId, session);
    // Reapply live facts after durable history, including capture-disabled closure facts.
    if (existing?.pendingHydrationEvents.size) {
      try {
        for (const { entry, capturePrimary } of existing.pendingHydrationEvents.values()) {
          this.applyEvent(companyId, entry, { capturePrimary });
        }
        session.pendingPersistence = true;
      } catch (error) {
        this.sessions.set(companyId, existing);
        throw error;
      }
    }
    this.pruneSessions();
    return {
      snapshot: session.snapshot ?? createAttentionSnapshot(companyId, session.core.getAttentionView()),
      review: session.review,
    };
  }

  ingest(companyId: string, event: ApertureEvent, source?: SnapshotSource): {
    frame: AttentionFrame | null;
    snapshot: AttentionSnapshot;
  } {
    const session = this.ensureSession(companyId);
    const frame = session.core.publish(event);
    session.eventCount += 1;
    session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), source);
    return { frame, snapshot: session.snapshot };
  }

  submit(companyId: string, response: AttentionResponse, source?: SnapshotSource): AttentionSnapshot {
    const session = this.ensureSession(companyId);
    session.core.submit(response);
    session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), source);
    return session.snapshot;
  }

  getSnapshot(companyId: string): AttentionSnapshot | null {
    const session = this.sessions.get(companyId);
    if (!session) return null;
    this.touchSession(session);
    return this.syncSnapshotFromCore(companyId, session);
  }

  getLedger(companyId: string): AttentionLedger {
    const session = this.sessions.get(companyId);
    if (session) this.touchSession(session);
    return [...(session?.ledger ?? [])];
  }

  getReview(companyId: string): AttentionReviewState | null {
    const session = this.sessions.get(companyId);
    if (!session) return null;
    this.touchSession(session);
    return session.review;
  }

  hasPendingPersistence(companyId: string): boolean {
    return this.sessions.get(companyId)?.pendingPersistence ?? false;
  }

  markPersistencePending(companyId: string): void {
    const session = this.ensureSession(companyId);
    session.pendingPersistence = true;
  }

  getPersistableState(companyId: string): {
    ledger: AttentionLedger;
    snapshot: AttentionSnapshot;
    review: AttentionReviewState;
  } | null {
    const session = this.sessions.get(companyId);
    if (!session) return null;
    this.touchSession(session);
    return {
      ledger: this.getLedger(companyId),
      snapshot: this.syncSnapshotFromCore(companyId, session),
      review: session.review,
    };
  }

  setReview(companyId: string, review: AttentionReviewState): AttentionReviewState {
    const session = this.ensureSession(companyId);
    session.review = review;
    this.invalidateReconciled(companyId);
    return session.review;
  }

  getTraces(companyId: string): ApertureTrace[] {
    const session = this.sessions.get(companyId);
    if (session) this.touchSession(session);
    return [...(session?.traces ?? [])];
  }

  getCachedReconciledCandidates(companyId: string, key: string): StoredFrameCandidate[] | null {
    const session = this.sessions.get(companyId);
    if (session) this.touchSession(session);
    const cached = session?.reconciledCandidates;
    if (!cached || cached.key !== key) return null;
    if (cached.expiresAt <= Date.now()) {
      if (session) {
        session.reconciledCandidates = null;
        session.hostDataRevision += 1;
      }
      return null;
    }
    return [...cached.candidates];
  }

  setCachedReconciledCandidates(companyId: string, key: string, candidates: StoredFrameCandidate[]): StoredFrameCandidate[] {
    const session = this.ensureSession(companyId);
    session.reconciledCandidates = {
      key,
      candidates: [...candidates],
      expiresAt: Date.now() + RECONCILED_CANDIDATE_TTL_MS,
    };
    return [...candidates];
  }

  getLastGoodReconciledCandidates(companyId: string): StoredFrameCandidate[] | null {
    const session = this.sessions.get(companyId);
    if (session) this.touchSession(session);
    return session?.lastGoodReconciledCandidates ? [...session.lastGoodReconciledCandidates] : null;
  }

  setLastGoodReconciledCandidates(companyId: string, candidates: StoredFrameCandidate[]): void {
    this.ensureSession(companyId).lastGoodReconciledCandidates = [...candidates];
  }

  getDisplayEngagement(companyId: string): DisplayEngagement | null {
    const session = this.sessions.get(companyId);
    if (!session) return null;
    this.touchSession(session);
    if (session.displayEngagement && Date.now() >= session.displayEngagement.expiresAt) {
      session.displayEngagement = null;
    }
    return session.displayEngagement;
  }

  setDisplayEngagement(companyId: string, engagement: DisplayEngagement): void {
    this.ensureSession(companyId).displayEngagement = engagement;
  }

  clearDisplayEngagement(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (session) session.displayEngagement = null;
  }

  hasCoreInteraction(companyId: string, taskId: string, interactionId: string): boolean {
    const view = this.sessions.get(companyId)?.core.getTaskView(taskId);
    return !!view && (view.now?.interactionId === interactionId
      || view.next.some((frame) => frame.interactionId === interactionId)
      || view.ambient.some((frame) => frame.interactionId === interactionId));
  }

  // Retain uncertainty on failed reads, but never retain candidates contradicted by known host facts.
  retireDisplayCandidates(companyId: string, target: { taskId?: string; issueId?: string }): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    const taskId = target.taskId ?? (target.issueId ? createTaskId("issue", target.issueId) : undefined);
    const matches = ({ frame }: StoredFrameCandidate) => frame.taskId === taskId
      || (!!target.issueId && readFocusMetadata(frame).issueId === target.issueId);
    const retired = session.lastGoodReconciledCandidates?.filter(matches) ?? [];
    const engagement = session.displayEngagement;
    if (engagement && (engagement.taskId === taskId
      || retired.some(({ frame }) => frame.taskId === engagement.taskId))) {
      session.displayEngagement = null;
    }
    if (retired.length > 0) {
      session.lastGoodReconciledCandidates = session.lastGoodReconciledCandidates!.filter((candidate) => !matches(candidate));
    }
    const approvals = session.approvals.records;
    const remainingApprovals = approvals?.filter((record) => createTaskId("approval", record.id) !== taskId);
    const retiredApproval = !!approvals && remainingApprovals?.length !== approvals.length;
    if (retiredApproval) session.approvals.records = remainingApprovals!;
    if (retired.length > 0 || retiredApproval) this.invalidateReconciled(companyId);
  }

  getReconciledRevision(companyId: string): number {
    return this.sessions.get(companyId)?.hostDataRevision ?? 0;
  }

  invalidateReconciled(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    session.reconciledCandidates = null;
    session.hostDataRevision += 1;
  }

  getCachedHostValue<T>(companyId: string, key: string): T | null {
    const session = this.sessions.get(companyId);
    if (!session) return null;
    this.touchSession(session);
    const cached = session.hostCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      session.hostCache.delete(key);
      return null;
    }
    return cached.value as T;
  }

  setCachedHostValue<T>(companyId: string, key: string, value: T, ttlMs: number): T {
    const session = this.ensureSession(companyId);
    session.hostCache.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlMs),
    });
    return value;
  }

  invalidateHostCache(
    companyId: string,
    options: {
      keys?: string[];
      prefixes?: string[];
      bumpRevision?: boolean;
    } = {},
  ): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    const { keys = [], prefixes = [], bumpRevision = true } = options;
    for (const key of keys) session.hostCache.delete(key);
    if (prefixes.length > 0) {
      for (const key of [...session.hostCache.keys()]) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
          session.hostCache.delete(key);
        }
      }
    }
    if (bumpRevision) this.invalidateReconciled(companyId);
  }

  getApprovals(companyId: string): ApprovalRecord[] | null {
    return this.sessions.get(companyId)?.approvals.records ?? null;
  }

  setApprovals(companyId: string, records: ApprovalRecord[]): ApprovalRecord[] {
    const session = this.ensureSession(companyId);
    session.approvals = {
      records: [...records],
      dirty: false,
      lastLoadedAt: new Date().toISOString(),
      lastError: undefined,
    };
    return [...records];
  }

  approvalsDirty(companyId: string): boolean {
    const session = this.sessions.get(companyId);
    if (session) this.touchSession(session);
    return !session
      || session.approvals.dirty
      || session.approvals.records === null
      || !session.approvals.lastLoadedAt
      || Date.now() - Date.parse(session.approvals.lastLoadedAt) >= APPROVAL_CACHE_TTL_MS;
  }

  invalidateApprovals(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    session.approvals = {
      records: session.approvals.records,
      dirty: true,
      lastLoadedAt: session.approvals.lastLoadedAt,
      lastError: session.approvals.lastError,
    };
    this.invalidateReconciled(companyId);
  }

  markApprovalAdapterFailure(companyId: string, error: string): void {
    const session = this.ensureSession(companyId);
    session.approvals = {
      records: session.approvals.records,
      dirty: true,
      lastLoadedAt: session.approvals.lastLoadedAt,
      lastError: error,
    };
  }

  restore(
    companyId: string,
    input: {
      ledger: AttentionLedger;
      snapshot?: AttentionSnapshot | null;
      review?: AttentionReviewState | null;
    },
  ): {
    snapshot: AttentionSnapshot;
    review: AttentionReviewState;
  } {
    const session = this.buildSession(companyId, input, this.sessions.get(companyId));
    this.sessions.set(companyId, session);
    return {
      snapshot: session.snapshot ?? createAttentionSnapshot(companyId, session.core.getAttentionView()),
      review: session.review,
    };
  }

  markPersistenceHealthy(companyId: string, persistedEntryCount: number): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    session.pendingPersistence = session.ledger.length !== persistedEntryCount;
    session.persistence = {
      state: "healthy",
      updatedAt: new Date().toISOString(),
    };
  }

  markPersistenceFault(companyId: string, error: string): void {
    const session = this.ensureSession(companyId);
    session.persistence = {
      state: "faulted",
      updatedAt: new Date().toISOString(),
      lastError: error,
    };
  }

  appendLedgerEntry(companyId: string, entry: AttentionLedgerEntry): AttentionLedger {
    const session = this.ensureSession(companyId);
    session.ledger = [...session.ledger, entry];
    if (entry.kind === "event") observeRunLifecycleEntry(session.runIndex, entry);
    return this.getLedger(companyId);
  }

  applyEvent(
    companyId: string,
    entry: AttentionLedgerEventEntry,
    options: { capturePrimary?: boolean } = {},
  ): {
    frame: AttentionFrame | null;
    ledger: AttentionLedger;
    snapshot: AttentionSnapshot;
  } {
    const session = this.ensureSession(companyId);
    const previousLedger = session.ledger;
    const previousReview = session.review;
    const existingIds = new Set<string>();
    for (const applied of previousLedger) {
      existingIds.add(applied.id);
      if (applied.kind === "event") {
        existingIds.add(applied.apertureEvent.id);
        if (applied.sourceEvent) existingIds.add(applied.sourceEvent.id);
      }
    }
    if (existingIds.has(entry.id) || existingIds.has(entry.apertureEvent.id)
      || (entry.sourceEvent && existingIds.has(entry.sourceEvent.id))) {
      return { frame: null, ledger: this.getLedger(companyId), snapshot: this.syncSnapshotFromCore(companyId, session) };
    }
    const batch = [
      ...(options.capturePrimary === false ? [] : [entry]),
      ...deriveRunRetirements(session.runIndex, entry),
    ].filter((candidate) => {
      const ids = [candidate.id, candidate.apertureEvent.id, ...(candidate.sourceEvent ? [candidate.sourceEvent.id] : [])];
      if (ids.some((id) => existingIds.has(id))) return false;
      for (const id of ids) existingIds.add(id);
      return true;
    });
    if (batch.length === 0) {
      if (!session.hydrated) session.pendingHydrationEvents.set(entry.id, { entry, capturePrimary: options.capturePrimary !== false });
      return { frame: null, ledger: this.getLedger(companyId), snapshot: this.syncSnapshotFromCore(companyId, session) };
    }
    try {
      let frame: AttentionFrame | null = null;
      for (const candidate of batch) {
        const published = candidate.sourceEvent
          ? session.core.publishSourceEvent(candidate.sourceEvent)
          : session.core.publish(candidate.apertureEvent);
        if (candidate === entry) frame = published;
        observeRunLifecycleEntry(session.runIndex, candidate);
        session.eventCount += 1;
      }
      session.ledger = [...previousLedger, ...batch];
      session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), entry.source, entry.occurredAt);
      if (!session.hydrated) session.pendingHydrationEvents.set(entry.id, { entry, capturePrimary: options.capturePrimary !== false });
      this.invalidateReconciled(companyId);
      return { frame, ledger: this.getLedger(companyId), snapshot: session.snapshot };
    } catch (error) {
      this.sessions.set(companyId, this.buildSession(companyId, {
        ledger: previousLedger,
        review: previousReview,
      }, session));
      throw error;
    }
  }

  applyResponse(companyId: string, entry: AttentionLedgerResponseEntry): {
    ledger: AttentionLedger;
    snapshot: AttentionSnapshot;
  } {
    const session = this.ensureSession(companyId);
    const previousLedger = session.ledger;
    const previousSnapshot = session.snapshot;
    const previousEventCount = session.eventCount;

    session.ledger = [...session.ledger, entry];

    try {
      session.core.submit(entry.apertureResponse);
      session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), entry.source, entry.occurredAt);
      session.reconciledCandidates = null;
      return {
        ledger: this.getLedger(companyId),
        snapshot: session.snapshot,
      };
    } catch (error) {
      session.ledger = previousLedger;
      session.snapshot = previousSnapshot;
      session.eventCount = previousEventCount;
      throw error;
    }
  }

  applyOverlayResponse(companyId: string, entry: AttentionLedgerOverlayResponseEntry): {
    ledger: AttentionLedger;
    snapshot: AttentionSnapshot;
  } {
    const session = this.ensureSession(companyId);
    session.ledger = [...session.ledger, entry];
    session.reconciledCandidates = null;
    return {
      ledger: this.getLedger(companyId),
      snapshot: this.syncSnapshotFromCore(companyId, session),
    };
  }

  applySignal(companyId: string, entry: AttentionLedgerSignalEntry): {
    ledger: AttentionLedger;
    snapshot: AttentionSnapshot;
    changed: boolean;
  } {
    const session = this.ensureSession(companyId);
    const previousSnapshot = this.syncSnapshotFromCore(companyId, session);
    session.ledger = [...session.ledger, entry];
    session.core.recordSignal(entry.apertureSignal as AttentionSignal);
    const snapshot = this.syncSnapshotFromCore(companyId, session);
    return {
      ledger: this.getLedger(companyId),
      snapshot,
      changed: !sameSnapshotAttention(previousSnapshot, snapshot),
    };
  }

  replaceLedger(companyId: string, ledger: AttentionLedger): AttentionLedger {
    const session = this.ensureSession(companyId);
    session.ledger = [...ledger];
    session.runIndex = createRunLifecycleIndex(ledger);
    session.reconciledCandidates = null;
    return this.getLedger(companyId);
  }

  rebuildFromLedger(companyId: string, ledger: AttentionLedger): AttentionSnapshot {
    const previousReview = this.sessions.get(companyId)?.review ?? createEmptyReviewState(companyId);
    const session = this.buildSession(companyId, {
      ledger,
      review: previousReview,
    }, this.sessions.get(companyId));
    this.sessions.set(companyId, session);
    return session.snapshot ?? createAttentionSnapshot(companyId, session.core.getAttentionView());
  }

  getCompanyCount(): number {
    return this.sessions.size;
  }

  engage(
    companyId: string,
    taskId: string,
    interactionId: string,
    options: { durationMs?: number } = {},
  ): {
    snapshot: AttentionSnapshot;
    changed: boolean;
  } {
    const session = this.ensureSession(companyId);
    const previousSnapshot = this.syncSnapshotFromCore(companyId, session);
    session.core.engage(taskId, interactionId, options);
    const snapshot = this.syncSnapshotFromCore(companyId, session);
    return {
      snapshot,
      changed: !sameSnapshotAttention(previousSnapshot, snapshot),
    };
  }

  markViewed(
    companyId: string,
    taskId: string,
    interactionId: string,
    options: { surface?: string } = {},
  ): {
    snapshot: AttentionSnapshot;
    changed: boolean;
  } {
    const session = this.ensureSession(companyId);
    const previousSnapshot = this.syncSnapshotFromCore(companyId, session);
    session.core.markViewed(taskId, interactionId, options);
    const snapshot = this.syncSnapshotFromCore(companyId, session);
    return {
      snapshot,
      changed: !sameSnapshotAttention(previousSnapshot, snapshot),
    };
  }

  markContextExpanded(
    companyId: string,
    taskId: string,
    interactionId: string,
    options: { surface?: string; section?: string } = {},
  ): {
    snapshot: AttentionSnapshot;
    changed: boolean;
  } {
    const session = this.ensureSession(companyId);
    const previousSnapshot = this.syncSnapshotFromCore(companyId, session);
    session.core.markContextExpanded(taskId, interactionId, options);
    const snapshot = this.syncSnapshotFromCore(companyId, session);
    return {
      snapshot,
      changed: !sameSnapshotAttention(previousSnapshot, snapshot),
    };
  }

  setOperatorPresence(
    companyId: string,
    presence: "present" | "absent",
  ): "present" | "absent" {
    const session = this.ensureSession(companyId);
    session.core.setOperatorPresence(presence);
    this.touchSession(session);
    return session.core.getOperatorPresence();
  }

  private ensureSession(companyId: string): CompanySession {
    let session = this.sessions.get(companyId);
    if (session) {
      this.touchSession(session);
      return session;
    }

    session = this.createSession(companyId);
    this.sessions.set(companyId, session);
    this.pruneSessions();
    return session;
  }

  private buildSession(
    companyId: string,
    input: {
      ledger: AttentionLedger;
      snapshot?: AttentionSnapshot | null;
      review?: AttentionReviewState | null;
    },
    previous?: CompanySession,
  ): CompanySession {
    const session = this.createSession(companyId);
    if (previous) session.core.setOperatorPresence(previous.core.getOperatorPresence());
    session.ledger = [...input.ledger];
    session.runIndex = createRunLifecycleIndex(input.ledger);
    session.review = deriveReviewStateFromLedger(companyId, input.ledger, input.review ?? null);
    session.approvals = {
      records: previous?.approvals.records ? [...previous.approvals.records] : null,
      dirty: previous?.approvals.dirty ?? true,
      lastLoadedAt: previous?.approvals.lastLoadedAt,
      lastError: previous?.approvals.lastError,
    };
    session.hostCache = previous ? new Map(previous.hostCache) : new Map<string, HostCacheEntry>();
    session.hostDataRevision = previous?.hostDataRevision ?? 0;
    session.persistence = previous?.persistence ?? healthyPersistenceStatus();
    session.traces = previous ? [...previous.traces] : [];
    session.pendingPersistence = previous?.pendingPersistence ?? false;
    session.hydrated = previous?.hydrated ?? false;
    if (previous) session.pendingHydrationEvents = previous.pendingHydrationEvents;
    session.reconciledCandidates = previous?.reconciledCandidates ?? null;
    session.lastGoodReconciledCandidates = previous?.lastGoodReconciledCandidates ?? null;
    const engagement = previous?.displayEngagement;
    if (engagement && Date.now() < engagement.expiresAt) session.displayEngagement = engagement;

    if (input.ledger.length > 0) {
      let lastSource: SnapshotSource | undefined;
      let lastOccurredAt: string | undefined;
      for (const entry of input.ledger) {
        lastSource = entry.source;
        lastOccurredAt = entry.occurredAt;
        if (entry.kind === "event") {
          if (entry.sourceEvent) {
            session.core.publishSourceEvent(entry.sourceEvent);
          } else {
            session.core.publish(entry.apertureEvent);
          }
          session.eventCount += 1;
        } else if (entry.kind === "response") {
          session.core.submit(entry.apertureResponse);
        } else if (entry.kind === "signal") {
          session.core.recordSignal(entry.apertureSignal);
        }
      }
      session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), lastSource, lastOccurredAt);
    } else {
      session.snapshot = input.snapshot ?? createAttentionSnapshot(companyId, session.core.getAttentionView());
    }

    const previousNow = previous?.core.getAttentionView().now;
    if (session.displayEngagement && previousNow?.taskId === session.displayEngagement.taskId
      && previousNow.interactionId === session.displayEngagement.interactionId) {
      session.core.engage(session.displayEngagement.taskId, session.displayEngagement.interactionId, {
        durationMs: Math.max(25, session.displayEngagement.expiresAt - Date.now()),
      });
      session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), session.snapshot?.lastEvent);
    }

    session.persistence = previous?.persistence?.state === "faulted"
      ? previous.persistence
      : healthyPersistenceStatus();

    return session;
  }

  private createSession(companyId: string): CompanySession {
    const core = new ApertureCore({
      surfaceCapabilities: FOCUS_SURFACE_CAPABILITIES,
    });
    const now = Date.now();
    const session: CompanySession = {
      core,
      snapshot: null,
      ledger: createEmptyLedger(),
      runIndex: createRunLifecycleIndex(),
      review: createEmptyReviewState(companyId),
      hydrated: false,
      pendingHydrationEvents: new Map(),
      pendingPersistence: false,
      eventCount: 0,
      traces: [],
      reconciledCandidates: null,
      lastGoodReconciledCandidates: null,
      displayEngagement: null,
      approvals: {
        records: null,
        dirty: true,
      },
      hostCache: new Map<string, HostCacheEntry>(),
      hostDataRevision: 0,
      persistence: healthyPersistenceStatus(),
      lastTouchedAt: now,
    };

    core.onTrace((trace) => {
      session.traces = [...session.traces.slice(-(MAX_TRACE_HISTORY - 1)), trace];
    });

    return session;
  }

  private touchSession(session: CompanySession): void {
    session.lastTouchedAt = Date.now();
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [companyId, session] of this.sessions.entries()) {
      if (now - session.lastTouchedAt > SESSION_IDLE_TTL_MS) {
        this.sessions.delete(companyId);
      }
    }

    if (this.sessions.size <= MAX_COMPANY_SESSIONS) return;

    const oldestSessions = [...this.sessions.entries()]
      .sort((left, right) => left[1].lastTouchedAt - right[1].lastTouchedAt);

    while (this.sessions.size > MAX_COMPANY_SESSIONS && oldestSessions.length > 0) {
      const [companyId] = oldestSessions.shift() as [string, CompanySession];
      this.sessions.delete(companyId);
    }
  }

  private syncSnapshotFromCore(companyId: string, session: CompanySession): AttentionSnapshot {
    const liveView = session.core.getAttentionView();
    const currentSnapshot = session.snapshot;
    if (currentSnapshot && sameSnapshotAttentionView(currentSnapshot, liveView)) {
      return currentSnapshot;
    }

    const nextSnapshot = createAttentionSnapshot(
      companyId,
      liveView,
      currentSnapshot?.lastEvent,
    );
    session.snapshot = nextSnapshot;
    return nextSnapshot;
  }
}

function sameSnapshotAttention(left: AttentionSnapshot | null, right: AttentionSnapshot | null): boolean {
  if (!left || !right) return left === right;
  return left.now?.interactionId === right.now?.interactionId
    && sameInteractionOrder(left.next, right.next)
    && sameInteractionOrder(left.ambient, right.ambient);
}

function sameSnapshotAttentionView(snapshot: AttentionSnapshot, view: ReturnType<ApertureCore["getAttentionView"]>): boolean {
  return snapshot.now?.interactionId === view.now?.interactionId
    && sameInteractionOrder(snapshot.next, view.next)
    && sameInteractionOrder(snapshot.ambient, view.ambient);
}

function sameInteractionOrder(
  left: Array<{ interactionId: string }>,
  right: Array<{ interactionId: string }>,
): boolean {
  return left.length === right.length
    && left.every((frame, index) => frame.interactionId === right[index]?.interactionId);
}

function ledgerDiagnostics(ledger: AttentionLedger) {
  return {
    entries: ledger.length,
    eventEntries: ledger.filter((entry) => entry.kind === "event").length,
    responseEntries: ledger.filter((entry) => entry.kind === "response").length,
    overlayResponseEntries: ledger.filter((entry) => entry.kind === "overlay-response").length,
    signalEntries: ledger.filter((entry) => entry.kind === "signal").length,
    replayStrategy: "full-ledger" as const,
    compactionRecommended: ledger.length > 2_000,
  };
}

function healthyPersistenceStatus(): PersistenceStatus {
  return {
    state: "healthy",
    updatedAt: new Date().toISOString(),
  };
}
