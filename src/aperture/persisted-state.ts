import {
  createEmptyLedger,
  createEmptyReviewState,
  createEmptySnapshot,
  normalizeAttentionSnapshot,
  type AttentionLedger,
  type AttentionLedgerEntry,
  type AttentionReviewState,
  type AttentionSnapshot,
} from "./types.js";

export const ATTENTION_STATE_SCHEMA_VERSION = 1;

export type PersistedAttentionState = {
  companyId: string;
  ledger: AttentionLedger;
  snapshot: AttentionSnapshot;
  review: AttentionReviewState;
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
    (entry.kind !== "event" && entry.kind !== "response")
    || typeof entry.id !== "string"
    || typeof entry.occurredAt !== "string"
    || !isLedgerSource(entry.source)
  ) {
    return false;
  }

  if (entry.kind === "event") return !!entry.apertureEvent && typeof entry.apertureEvent === "object";
  return !!entry.apertureResponse && typeof entry.apertureResponse === "object";
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
    },
  };
}

export function normalizePersistedAttentionState(
  companyId: string,
  value: unknown,
): PersistedAttentionState | null {
  const envelope = asRecord(value);
  if (!envelope) return null;
  if (envelope.schemaVersion !== ATTENTION_STATE_SCHEMA_VERSION) return null;

  const payload = asRecord(envelope.payload);
  if (!payload || payload.companyId !== companyId) return null;

  const ledger = isAttentionLedger(payload.ledger) ? payload.ledger : createEmptyLedger();
  const snapshot = normalizeAttentionSnapshot(companyId, payload.snapshot);
  const review = isAttentionReviewState(payload.review, companyId)
    ? payload.review
    : createEmptyReviewState(companyId);

  if (!snapshot) return null;

  return {
    companyId,
    ledger,
    snapshot,
    review,
  };
}
