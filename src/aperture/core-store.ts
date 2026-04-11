import {
  ApertureCore,
  type ApertureEvent,
  type AttentionFrame,
  type AttentionResponse,
} from "@tomismeta/aperture-core";
import type { ApertureTrace } from "@tomismeta/aperture-core/trace";
import type { StoredFrameCandidate } from "./frame-model.js";
import {
  createAttentionSnapshot,
  createEmptyLedger,
  createEmptyReviewState,
  type AttentionLedgerEntry,
  type AttentionLedgerEventEntry,
  type AttentionLedgerResponseEntry,
  type AttentionLedger,
  type AttentionReviewState,
  type AttentionSnapshot,
  type SnapshotSource,
} from "./types.js";
import type { ApprovalRecord } from "../host/paperclip-approvals.js";

type CachedCandidates = {
  key: string;
  candidates: StoredFrameCandidate[];
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
  review: AttentionReviewState;
  eventCount: number;
  traces: ApertureTrace[];
  reconciledCandidates: CachedCandidates | null;
  approvals: {
    records: ApprovalRecord[] | null;
    dirty: boolean;
  };
  hostCache: Map<string, HostCacheEntry>;
  hostDataRevision: number;
  persistence: PersistenceStatus;
  lastTouchedAt: number;
};

const MAX_TRACE_HISTORY = 100;
const MAX_COMPANY_SESSIONS = 100;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

export class ApertureCompanyStore {
  private readonly sessions = new Map<string, CompanySession>();

  getHealth() {
    return {
      trackedCompanies: this.sessions.size,
      maxCompanySessions: MAX_COMPANY_SESSIONS,
      idleSessionTtlMs: SESSION_IDLE_TTL_MS,
      faultedCompanies: [...this.sessions.values()].filter((session) => session.persistence.state === "faulted").length,
    };
  }

  hasSession(companyId: string): boolean {
    return this.sessions.has(companyId);
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
    if (existing) {
      this.touchSession(existing);
      return {
        snapshot: existing.snapshot ?? createAttentionSnapshot(companyId, existing.core.getAttentionView()),
        review: existing.review,
      };
    }

    const session = this.buildSession(companyId, input);
    this.sessions.set(companyId, session);
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
    return cached?.key === key ? [...cached.candidates] : null;
  }

  setCachedReconciledCandidates(companyId: string, key: string, candidates: StoredFrameCandidate[]): StoredFrameCandidate[] {
    const session = this.ensureSession(companyId);
    session.reconciledCandidates = {
      key,
      candidates: [...candidates],
    };
    return [...candidates];
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
    };
    return [...records];
  }

  approvalsDirty(companyId: string): boolean {
    const session = this.sessions.get(companyId);
    if (session) this.touchSession(session);
    return session?.approvals.dirty ?? true;
  }

  invalidateApprovals(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    session.approvals = {
      records: session.approvals.records,
      dirty: true,
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

  markPersistenceHealthy(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
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
    return this.getLedger(companyId);
  }

  applyEvent(companyId: string, entry: AttentionLedgerEventEntry): {
    frame: AttentionFrame | null;
    ledger: AttentionLedger;
    snapshot: AttentionSnapshot;
  } {
    const session = this.ensureSession(companyId);
    const previousLedger = session.ledger;
    const previousSnapshot = session.snapshot;
    const previousEventCount = session.eventCount;

    session.ledger = [...session.ledger, entry];

    try {
      const frame = session.core.publish(entry.apertureEvent);
      session.eventCount += 1;
      session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), entry.source, entry.occurredAt);
      session.reconciledCandidates = null;
      return {
        frame,
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

  replaceLedger(companyId: string, ledger: AttentionLedger): AttentionLedger {
    const session = this.ensureSession(companyId);
    session.ledger = [...ledger];
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
    session.ledger = [...input.ledger];
    session.review = input.review ?? createEmptyReviewState(companyId);
    session.approvals = {
      records: previous?.approvals.records ? [...previous.approvals.records] : null,
      dirty: previous?.approvals.dirty ?? true,
    };
    session.hostCache = previous ? new Map(previous.hostCache) : new Map<string, HostCacheEntry>();
    session.hostDataRevision = previous?.hostDataRevision ?? 0;
    session.persistence = previous?.persistence ?? healthyPersistenceStatus();
    session.traces = previous ? [...previous.traces] : [];

    if (input.ledger.length > 0) {
      let lastSource: SnapshotSource | undefined;
      let lastOccurredAt: string | undefined;
      for (const entry of input.ledger) {
        lastSource = entry.source;
        lastOccurredAt = entry.occurredAt;
        if (entry.kind === "event") {
          session.core.publish(entry.apertureEvent);
          session.eventCount += 1;
        } else {
          session.core.submit(entry.apertureResponse);
        }
      }
      session.snapshot = createAttentionSnapshot(companyId, session.core.getAttentionView(), lastSource, lastOccurredAt);
    } else {
      session.snapshot = input.snapshot ?? createAttentionSnapshot(companyId, session.core.getAttentionView());
    }

    session.persistence = previous?.persistence?.state === "faulted"
      ? previous.persistence
      : healthyPersistenceStatus();

    return session;
  }

  private createSession(companyId: string): CompanySession {
    const core = new ApertureCore();
    const now = Date.now();
    const session: CompanySession = {
      core,
      snapshot: null,
      ledger: createEmptyLedger(),
      review: createEmptyReviewState(companyId),
      eventCount: 0,
      traces: [],
      reconciledCandidates: null,
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

function healthyPersistenceStatus(): PersistenceStatus {
  return {
    state: "healthy",
    updatedAt: new Date().toISOString(),
  };
}
