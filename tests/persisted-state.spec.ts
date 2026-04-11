import { describe, expect, it } from "vitest";
import {
  ATTENTION_STATE_SCHEMA_VERSION,
  createPersistedAttentionState,
  normalizePersistedAttentionState,
} from "../src/aperture/persisted-state.js";
import { createEmptyLedger, createEmptyReviewState, createEmptySnapshot } from "../src/aperture/types.js";

describe("persisted attention state", () => {
  it("round-trips the versioned attention envelope", () => {
    const companyId = "company-state";
    const envelope = createPersistedAttentionState(companyId, {
      ledger: createEmptyLedger(),
      snapshot: createEmptySnapshot(companyId),
      review: createEmptyReviewState(companyId),
    });

    expect(normalizePersistedAttentionState(companyId, envelope)).toEqual(envelope.payload);
  });

  it("migrates the legacy v1 envelope into the current payload shape", () => {
    const companyId = "company-state";
    const snapshot = createEmptySnapshot(companyId);
    const review = createEmptyReviewState(companyId);

    expect(normalizePersistedAttentionState(companyId, {
      schemaVersion: 1,
      payload: {
        companyId,
        ledger: createEmptyLedger(),
        snapshot,
        review,
      },
    })).toEqual(expect.objectContaining({
      companyId,
      ledger: [],
      snapshot,
      review,
      meta: expect.objectContaining({
        ledgerEntries: 0,
        eventEntries: 0,
        responseEntries: 0,
      }),
    }));
  });

  it("rejects unknown future schema versions", () => {
    const companyId = "company-state";
    const envelope = createPersistedAttentionState(companyId, {
      ledger: createEmptyLedger(),
      snapshot: createEmptySnapshot(companyId),
      review: createEmptyReviewState(companyId),
    });

    expect(normalizePersistedAttentionState(companyId, {
      ...envelope,
      schemaVersion: ATTENTION_STATE_SCHEMA_VERSION + 1,
    })).toBeNull();
  });
});
