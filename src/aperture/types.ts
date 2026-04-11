import type { ApertureEvent, AttentionFrame, AttentionResponse, AttentionView } from "@tomismeta/aperture-core";
import type { ApertureTrace } from "@tomismeta/aperture-core/trace";

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
  now: StoredAttentionFrame | null;
  next: StoredAttentionFrame[];
  ambient: StoredAttentionFrame[];
  counts: {
    now: number;
    next: number;
    ambient: number;
    total: number;
  };
  review?: {
    lastSeenAt?: string;
    unread: {
      now: number;
      next: number;
      ambient: number;
      total: number;
    };
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

export type AttentionExport = {
  companyId: string;
  exportedAt: string;
  ledger: AttentionLedger;
  eventEntries: AttentionLedgerEventEntry[];
  responseEntries: AttentionLedgerResponseEntry[];
  traces: ApertureTrace[];
  window: {
    entryLimit: number;
    traceLimit: number;
    totalLedgerEntries: number;
    returnedLedgerEntries: number;
    totalTraces: number;
    returnedTraces: number;
    hasMoreBefore: boolean;
  };
  snapshot: AttentionSnapshot;
  reconciledSnapshot: AttentionSnapshot;
  displaySnapshot: AttentionSnapshot;
  review: AttentionReviewState;
};

export type AttentionDisplayPayload = {
  companyId: string;
  snapshot: AttentionSnapshot;
  reviewState: AttentionReviewState;
};

export type AttentionReplayScenarioStep =
  | {
      kind: "publish";
      event: ApertureEvent;
      label?: string;
    }
  | {
      kind: "submit";
      response: AttentionResponse;
      label?: string;
    };

export type AttentionReplayScenario = {
  id: string;
  title: string;
  description?: string;
  doctrineTags?: string[];
  window?: {
    entryLimit: number;
    totalLedgerEntries: number;
    returnedSteps: number;
    hasMoreBefore: boolean;
  };
  expectations?: {
    finalNowInteractionId?: string | null;
    nextInteractionIds?: string[];
    ambientInteractionIds?: string[];
    resultLaneCounts?: {
      now?: number;
      next?: number;
      ambient?: number;
    };
  };
  steps: AttentionReplayScenarioStep[];
};

export type AttentionReviewState = {
  companyId: string;
  updatedAt: string;
  lastSeenAt?: string;
  frames: Record<string, {
    lastSeenAt?: string;
    suppressedAt?: string;
  }>;
};

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
    now: null,
    next: [],
    ambient: [],
    counts: {
      now: 0,
      next: 0,
      ambient: 0,
      total: 0,
    },
  };
}

export function createEmptyLedger(): AttentionLedger {
  return [];
}

export function createEmptyReviewState(companyId: string): AttentionReviewState {
  return {
    companyId,
    updatedAt: new Date().toISOString(),
    frames: {},
  };
}

export function createAttentionSnapshot(
  companyId: string,
  view: AttentionView,
  lastEvent?: AttentionSnapshot["lastEvent"],
  updatedAt?: string,
): AttentionSnapshot {
  const legacyView = view as AttentionView & {
    active?: AttentionFrame | null;
    queued?: AttentionFrame[];
  };
  const now = toStoredFrame("now" in view ? view.now : legacyView.active ?? null);
  const next = ("next" in view ? view.next : legacyView.queued ?? [])
    .map((frame) => toStoredFrame(frame))
    .filter((frame): frame is StoredAttentionFrame => frame !== null);
  const ambient = view.ambient.map((frame) => toStoredFrame(frame)).filter((frame): frame is StoredAttentionFrame => frame !== null);

  return {
    companyId,
    updatedAt: updatedAt ?? new Date().toISOString(),
    now,
    next,
    ambient,
    counts: {
      now: now ? 1 : 0,
      next: next.length,
      ambient: ambient.length,
      total: (now ? 1 : 0) + next.length + ambient.length,
    },
    ...(lastEvent ? { lastEvent } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStoredFrame(value: unknown): StoredAttentionFrame | null {
  const frame = asRecord(value);
  if (!frame) return null;
  return typeof frame.taskId === "string" && typeof frame.interactionId === "string"
    ? frame as StoredAttentionFrame
    : null;
}

function asStoredFrames(value: unknown): StoredAttentionFrame[] {
  if (!Array.isArray(value)) return [];
  return value.map(asStoredFrame).filter((frame): frame is StoredAttentionFrame => frame !== null);
}

export function normalizeAttentionSnapshot(companyId: string, value: unknown): AttentionSnapshot | null {
  const snapshot = asRecord(value);
  if (!snapshot) return null;
  if (snapshot.companyId !== companyId || typeof snapshot.updatedAt !== "string") return null;

  const legacyCounts = asRecord(snapshot.counts);
  const review = asRecord(snapshot.review);
  const unread = asRecord(review?.unread);

  const now = asStoredFrame(snapshot.now ?? snapshot.active ?? null);
  const next = asStoredFrames(snapshot.next ?? snapshot.queued ?? []);
  const ambient = asStoredFrames(snapshot.ambient);

  return {
    companyId,
    updatedAt: snapshot.updatedAt,
    now,
    next,
    ambient,
    counts: {
      now: typeof legacyCounts?.now === "number" ? legacyCounts.now : typeof legacyCounts?.active === "number" ? legacyCounts.active : now ? 1 : 0,
      next: typeof legacyCounts?.next === "number" ? legacyCounts.next : typeof legacyCounts?.queued === "number" ? legacyCounts.queued : next.length,
      ambient: typeof legacyCounts?.ambient === "number" ? legacyCounts.ambient : ambient.length,
      total: typeof legacyCounts?.total === "number" ? legacyCounts.total : (now ? 1 : 0) + next.length + ambient.length,
    },
    ...(review
      ? {
          review: {
            ...(typeof review.lastSeenAt === "string" ? { lastSeenAt: review.lastSeenAt } : {}),
            unread: {
              now: typeof unread?.now === "number" ? unread.now : typeof unread?.active === "number" ? unread.active : 0,
              next: typeof unread?.next === "number" ? unread.next : typeof unread?.queued === "number" ? unread.queued : 0,
              ambient: typeof unread?.ambient === "number" ? unread.ambient : 0,
              total: typeof unread?.total === "number" ? unread.total : 0,
            },
          },
        }
      : {}),
    ...(asRecord(snapshot.lastEvent)
      ? {
          lastEvent: {
            eventType: String((snapshot.lastEvent as Record<string, unknown>).eventType),
            ...(typeof (snapshot.lastEvent as Record<string, unknown>).entityId === "string"
              ? { entityId: (snapshot.lastEvent as Record<string, unknown>).entityId as string }
              : {}),
            ...(typeof (snapshot.lastEvent as Record<string, unknown>).entityType === "string"
              ? { entityType: (snapshot.lastEvent as Record<string, unknown>).entityType as string }
              : {}),
          },
        }
      : {}),
  };
}
