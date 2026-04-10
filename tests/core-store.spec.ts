import { describe, expect, it, vi } from "vitest";
import type { ApertureEvent } from "@tomismeta/aperture-core";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";

function approvalEvent(input: {
  id: string;
  taskId: string;
  interactionId: string;
  timestamp: string;
  title: string;
  consequence: "low" | "medium" | "high";
}): ApertureEvent {
  return {
    id: input.id,
    type: "human.input.requested",
    taskId: input.taskId,
    interactionId: input.interactionId,
    timestamp: input.timestamp,
    source: {
      id: "paperclip:approval",
      kind: "paperclip",
      label: "Paperclip approval",
    },
    title: input.title,
    summary: `${input.title} is ready for review.`,
    consequence: input.consequence,
    request: { kind: "approval" },
  };
}

describe("ApertureCompanyStore", () => {
  it("holds the engaged now item steady until the hold expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T10:00:00.000Z"));

    try {
      const store = new ApertureCompanyStore();
      const companyId = "company-hold";

      store.ingest(
        companyId,
        approvalEvent({
          id: "approval-1",
          taskId: "approval:approval-1",
          interactionId: "approval:approval-1:approval",
          timestamp: "2026-04-10T10:00:00.000Z",
          title: "Approve pricing memo",
          consequence: "low",
        }),
      );

      const firstSnapshot = store.getSnapshot(companyId);
      expect(firstSnapshot?.now?.title).toBe("Approve pricing memo");

      store.engage(
        companyId,
        firstSnapshot?.now?.taskId ?? "",
        firstSnapshot?.now?.interactionId ?? "",
        { durationMs: 1000 },
      );

      store.ingest(
        companyId,
        approvalEvent({
          id: "approval-2",
          taskId: "approval:approval-2",
          interactionId: "approval:approval-2:approval",
          timestamp: "2026-04-10T10:00:01.000Z",
          title: "Approve launch checklist",
          consequence: "medium",
        }),
      );

      const heldSnapshot = store.getSnapshot(companyId);
      expect(heldSnapshot?.now?.title).toBe("Approve pricing memo");
      expect(heldSnapshot?.next.map((frame) => frame.title)).toEqual(["Approve launch checklist"]);

      await vi.advanceTimersByTimeAsync(1005);

      const releasedSnapshot = store.getSnapshot(companyId);
      expect(releasedSnapshot?.now?.title).toBe("Approve launch checklist");
      expect(releasedSnapshot?.next.map((frame) => frame.title)).toEqual(["Approve pricing memo"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
