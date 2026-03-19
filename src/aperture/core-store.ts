import {
  ApertureCore,
  type ApertureEvent,
  type AttentionFrame,
  type AttentionResponse,
} from "@tomismeta/aperture-core";
import {
  createAttentionSnapshot,
  createEmptyLedger,
  type AttentionLedger,
  type AttentionLedgerEntry,
  type AttentionSnapshot,
  type SnapshotSource,
} from "./types.js";

type CompanySession = {
  core: ApertureCore;
  snapshot: AttentionSnapshot | null;
  ledger: AttentionLedger;
  eventCount: number;
};

export class ApertureCompanyStore {
  private readonly sessions = new Map<string, CompanySession>();

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

  appendLedgerEntry(companyId: string, entry: AttentionLedgerEntry): AttentionLedger {
    const session = this.ensureSession(companyId);
    session.ledger = [...session.ledger, entry];
    return this.getLedger(companyId);
  }

  replaceLedger(companyId: string, ledger: AttentionLedger): AttentionLedger {
    const session = this.ensureSession(companyId);
    session.ledger = [...ledger];
    return this.getLedger(companyId);
  }

  rebuildFromLedger(companyId: string, ledger: AttentionLedger): AttentionSnapshot {
    const session: CompanySession = {
      core: new ApertureCore(),
      snapshot: null,
      ledger: [...ledger],
      eventCount: 0,
    };

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

    session = {
      core: new ApertureCore(),
      snapshot: null,
      ledger: createEmptyLedger(),
      eventCount: 0,
    };
    this.sessions.set(companyId, session);
    return session;
  }
}
