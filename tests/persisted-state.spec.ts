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
