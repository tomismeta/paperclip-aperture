import { describe, expect, it } from "vitest";
import {
  createInteractionId,
  createTaskId,
  parseTaskId,
  taskEntityId,
  taskIdMatchesKind,
  taskKind,
} from "../src/aperture/task-ref.js";

describe("task-ref codec", () => {
  it("round-trips task ids with delimiter-bearing entity ids", () => {
    const taskId = createTaskId("issue", "ENG-123:follow-up");

    expect(taskId).toBe("issue:ENG-123%3Afollow-up");
    expect(parseTaskId(taskId)).toEqual({
      kind: "issue",
      id: "ENG-123:follow-up",
    });
    expect(taskKind(taskId)).toBe("issue");
    expect(taskEntityId(taskId)).toBe("ENG-123:follow-up");
    expect(taskIdMatchesKind(taskId, "issue")).toBe(true);
  });

  it("encodes interaction steps without corrupting the task id", () => {
    const taskId = createTaskId("approval", "approval:1");
    expect(createInteractionId(taskId, "request:revision")).toBe(
      "approval:approval%3A1:request%3Arevision",
    );
  });
});
