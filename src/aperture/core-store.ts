import {
  ApertureCore,
  type ApertureEvent,
  type AttentionFrame,
  type AttentionResponse,
} from "@tomismeta/aperture-core";
import type { ApertureTrace } from "@tomismeta/aperture-core/trace";
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

type CachedSnapshot = {
  key: string;
  snapshot: AttentionSnapshot;
};

type CompanySession = {
  core: ApertureCore;
  snapshot: AttentionSnapshot | null;
  ledger: AttentionLedger;
  review: AttentionReviewState;
  eventCount: number;
  traces: ApertureTrace[];
  reconciled: CachedSnapshot | null;
  approvals: {
    records: ApprovalRecord[] | null;
    dirty: boolean;
  };
};

const MAX_TRACE_HISTORY = 100;

export class ApertureCompanyStore {
  private readonly sessions = new Map<string, CompanySession>();

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
      return {
        snapshot: existing.snapshot ?? createAttentionSnapshot(companyId, existing.core.getAttentionView()),
        review: existing.review,
      };
    }

    const session = this.createSession(companyId);
    session.ledger = [...input.ledger];
    session.review = input.review ?? createEmptyReviewState(companyId);

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

    this.sessions.set(companyId, session);
    return {
      snapshot: session.snapshot,
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
    return this.sessions.get(companyId)?.snapshot ?? null;
  }

  getLedger(companyId: string): AttentionLedger {
    return [...(this.sessions.get(companyId)?.ledger ?? [])];
  }

  getReview(companyId: string): AttentionReviewState | null {
    return this.sessions.get(companyId)?.review ?? null;
  }

  setReview(companyId: string, review: AttentionReviewState): AttentionReviewState {
    const session = this.ensureSession(companyId);
    session.review = review;
    this.invalidateReconciled(companyId);
    return session.review;
  }

  getTraces(companyId: string): ApertureTrace[] {
    return [...(this.sessions.get(companyId)?.traces ?? [])];
  }

  getCachedReconciledSnapshot(companyId: string, key: string): AttentionSnapshot | null {
    const cached = this.sessions.get(companyId)?.reconciled;
    return cached?.key === key ? cached.snapshot : null;
  }

  setCachedReconciledSnapshot(companyId: string, key: string, snapshot: AttentionSnapshot): AttentionSnapshot {
    const session = this.ensureSession(companyId);
    session.reconciled = { key, snapshot };
    return snapshot;
  }

  invalidateReconciled(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (session) session.reconciled = null;
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
    return this.sessions.get(companyId)?.approvals.dirty ?? true;
  }

  invalidateApprovals(companyId: string): void {
    const session = this.sessions.get(companyId);
    if (!session) return;
    session.approvals = {
      records: session.approvals.records,
      dirty: true,
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
      session.reconciled = null;
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
      session.reconciled = null;
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
    session.reconciled = null;
    return this.getLedger(companyId);
  }

  rebuildFromLedger(companyId: string, ledger: AttentionLedger): AttentionSnapshot {
    const previousReview = this.sessions.get(companyId)?.review ?? createEmptyReviewState(companyId);
    const session = this.createSession(companyId);
    session.ledger = [...ledger];
    session.review = previousReview;

    let lastSource: SnapshotSource | undefined;
    let lastOccurredAt: string | undefined;
    for (const entry of ledger) {
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
    this.sessions.set(companyId, session);
    return session.snapshot;
  }

  getCompanyCount(): number {
    return this.sessions.size;
  }

  private ensureSession(companyId: string): CompanySession {
    let session = this.sessions.get(companyId);
    if (session) return session;

    session = this.createSession(companyId);
    this.sessions.set(companyId, session);
    return session;
  }

  private createSession(companyId: string): CompanySession {
    const core = new ApertureCore();
    const session: CompanySession = {
      core,
      snapshot: null,
      ledger: createEmptyLedger(),
      review: createEmptyReviewState(companyId),
      eventCount: 0,
      traces: [],
      reconciled: null,
      approvals: {
        records: null,
        dirty: true,
      },
    };

    core.onTrace((trace) => {
      session.traces = [...session.traces.slice(-(MAX_TRACE_HISTORY - 1)), trace];
    });

    return session;
  }
}
