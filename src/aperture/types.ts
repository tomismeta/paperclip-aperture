import type { ApertureEvent, AttentionFrame, AttentionResponse, AttentionView } from "@tomismeta/aperture-core";

export type StoredAttentionFrame = Pick<
  AttentionFrame,
  | "id"
  | "taskId"
  | "interactionId"
  | "source"
  | "version"
  | "mode"
  | "tone"
  | "consequence"
  | "title"
  | "summary"
  | "context"
  | "responseSpec"
  | "provenance"
  | "timing"
  | "metadata"
>;

export type AttentionSnapshot = {
  companyId: string;
  updatedAt: string;
  active: StoredAttentionFrame | null;
  queued: StoredAttentionFrame[];
  ambient: StoredAttentionFrame[];
  counts: {
    active: number;
    queued: number;
    ambient: number;
    total: number;
  };
  lastEvent?: {
    eventType: string;
    entityId?: string;
    entityType?: string;
  };
};

export type SnapshotSource = NonNullable<AttentionSnapshot["lastEvent"]>;

export type AttentionLedgerEventEntry = {
  kind: "event";
  id: string;
  occurredAt: string;
  source: SnapshotSource;
  apertureEvent: ApertureEvent;
};

export type AttentionLedgerResponseEntry = {
  kind: "response";
  id: string;
  occurredAt: string;
  source: SnapshotSource;
  apertureResponse: AttentionResponse;
};

export type AttentionLedgerEntry = AttentionLedgerEventEntry | AttentionLedgerResponseEntry;
export type AttentionLedger = AttentionLedgerEntry[];

export function toStoredFrame(frame: AttentionFrame | null): StoredAttentionFrame | null {
  if (!frame) return null;

  return {
    id: frame.id,
    taskId: frame.taskId,
    interactionId: frame.interactionId,
    source: frame.source,
    version: frame.version,
    mode: frame.mode,
    tone: frame.tone,
    consequence: frame.consequence,
    title: frame.title,
    summary: frame.summary,
    context: frame.context,
    responseSpec: frame.responseSpec,
    provenance: frame.provenance,
    timing: frame.timing,
    metadata: frame.metadata,
  };
}

export function createEmptySnapshot(companyId: string): AttentionSnapshot {
  return {
    companyId,
    updatedAt: new Date().toISOString(),
    active: null,
    queued: [],
    ambient: [],
    counts: {
      active: 0,
      queued: 0,
      ambient: 0,
      total: 0,
    },
  };
}

export function createEmptyLedger(): AttentionLedger {
  return [];
}

export function createAttentionSnapshot(
  companyId: string,
  view: AttentionView,
  lastEvent?: AttentionSnapshot["lastEvent"],
  updatedAt?: string,
): AttentionSnapshot {
  const active = toStoredFrame(view.active);
  const queued = view.queued.map((frame) => toStoredFrame(frame)).filter((frame): frame is StoredAttentionFrame => frame !== null);
  const ambient = view.ambient.map((frame) => toStoredFrame(frame)).filter((frame): frame is StoredAttentionFrame => frame !== null);

  return {
    companyId,
    updatedAt: updatedAt ?? new Date().toISOString(),
    active,
    queued,
    ambient,
    counts: {
      active: active ? 1 : 0,
      queued: queued.length,
      ambient: ambient.length,
      total: (active ? 1 : 0) + queued.length + ambient.length,
    },
    ...(lastEvent ? { lastEvent } : {}),
  };
}
