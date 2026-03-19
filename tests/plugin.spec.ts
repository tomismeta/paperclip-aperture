import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import type { AttentionSnapshot } from "../src/aperture/types.js";
import plugin from "../src/worker.js";

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
});
