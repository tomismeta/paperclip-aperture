import {
  ApertureCore,
  type ApertureEvent,
  type AttentionFrame,
  type AttentionResponse,
} from "@tomismeta/aperture-core";
import { createAttentionSnapshot, type AttentionSnapshot } from "./types.js";

type CompanySession = {
  core: ApertureCore;
  snapshot: AttentionSnapshot | null;
  eventCount: number;
};

type SnapshotSource = AttentionSnapshot["lastEvent"];

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

  hydrateSnapshot(companyId: string, snapshot: AttentionSnapshot): AttentionSnapshot {
    const session = this.ensureSession(companyId);
    session.snapshot = snapshot;
    return snapshot;
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
      eventCount: 0,
    };
    this.sessions.set(companyId, session);
    return session;
  }
}
