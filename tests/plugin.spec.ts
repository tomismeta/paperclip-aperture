import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import type { AttentionSnapshot } from "../src/aperture/types.js";
import plugin from "../src/worker.js";
import {
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
} from "../src/handlers/shared.js";

describe("paperclip aperture", () => {
  it("maps approval events into attention state and clears them on acknowledgement", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve production deploy",
        summary: "Deployment is ready for review.",
      },
      { companyId: "company-1", entityId: "approval-1", entityType: "approval" },
    );

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-1" });
    expect(snapshot.active?.mode).toBe("approval");
    expect(snapshot.active?.title).toBe("Approve production deploy");
    expect(snapshot.counts.active).toBe(1);

    await harness.performAction("acknowledge-frame", {
      companyId: "company-1",
      taskId: snapshot.active?.taskId,
      interactionId: snapshot.active?.interactionId,
    });

    const cleared = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-1" });
    expect(cleared.active).toBeNull();
    expect(cleared.counts.active).toBe(0);
  });

  it("captures run failures as high-salience updates", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "agent.run.failed",
      { title: "Build failed", summary: "The deploy pipeline crashed during tests." },
      { companyId: "company-2", entityId: "run-77", entityType: "run" },
    );

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-2" });
    expect(snapshot.active?.consequence).toBe("high");
    expect(snapshot.active?.title).toContain("Build failed");
  });

  it("preserves budget override semantics for approval frames", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "budget_override_required",
        title: "Approve temporary budget override for CAM-9",
        summary: "Budget controls are blocking follow-up work on CAM-9.",
        requestedAmount: "$500",
        reason: "Additional investigation work exceeded the planned budget.",
      },
      { companyId: "company-3", entityId: "approval-budget-1", entityType: "approval" },
    );

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-3" });
    expect(snapshot.active?.title).toBe("Approve temporary budget override for CAM-9");
    expect(snapshot.active?.consequence).toBe("high");
    expect(snapshot.active?.provenance?.factors).toContain("budget stop");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "requested-amount")?.value).toBe("$500");
  });

  it("rebuilds the live ApertureCore from the persisted ledger after restart", async () => {
    const firstHarness = createTestHarness({ manifest });
    await plugin.definition.setup(firstHarness.ctx);

    await firstHarness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve restart-sensitive deployment",
        summary: "A deployment is waiting on a board decision.",
      },
      { companyId: "company-replay", entityId: "approval-replay-1", entityType: "approval" },
    );

    const original = await firstHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay" });
    const persistedLedger = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-replay",
      stateKey: ATTENTION_LEDGER_STATE_KEY,
    });
    const persistedSnapshot = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-replay",
      stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
    });

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-replay", stateKey: ATTENTION_LEDGER_STATE_KEY },
      persistedLedger,
    );
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-replay", stateKey: ATTENTION_SNAPSHOT_STATE_KEY },
      persistedSnapshot,
    );

    const rebuilt = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay" });
    expect(rebuilt.active?.title).toBe(original.active?.title);
    expect(rebuilt.counts.active).toBe(1);

    await secondHarness.performAction("acknowledge-frame", {
      companyId: "company-replay",
      taskId: rebuilt.active?.taskId,
      interactionId: rebuilt.active?.interactionId,
    });

    const cleared = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay" });
    expect(cleared.active).toBeNull();
    expect(cleared.counts.active).toBe(0);
  });

  it("respects the issue lifecycle capture toggle", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        captureIssueLifecycle: false,
      },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "issue.created",
      {
        title: "This issue should be ignored",
        description: "Issue lifecycle capture is disabled for this test.",
      },
      { companyId: "company-config", entityId: "issue-config-1", entityType: "issue" },
    );

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-config" });
    expect(snapshot.counts.total).toBe(0);
    expect(snapshot.active).toBeNull();
    expect(snapshot.queued).toHaveLength(0);
    expect(snapshot.ambient).toHaveLength(0);
  });

  it("respects the run failure capture toggle", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        captureRunFailures: false,
      },
    });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "agent.run.failed",
      {
        title: "This failure should be ignored",
        summary: "Run failure capture is disabled for this test.",
      },
      { companyId: "company-run-config", entityId: "run-config-1", entityType: "run" },
    );

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-run-config" });
    expect(snapshot.counts.total).toBe(0);
    expect(snapshot.active).toBeNull();
    expect(snapshot.queued).toHaveLength(0);
    expect(snapshot.ambient).toHaveLength(0);
  });

});
