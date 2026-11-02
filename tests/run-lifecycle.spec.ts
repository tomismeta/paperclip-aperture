import type { Issue, PluginEvent } from "@paperclipai/plugin-sdk";
import { normalizeSourceEvent } from "@tomismeta/aperture-core/semantic";
import { describe, expect, it } from "vitest";
import { parsePaperclipRunMetadata, readPaperclipRunRecoveryMetadata } from "../src/aperture/contracts.js";
import { mergeStoredFrames } from "../src/aperture/frame-model.js";
import { mapPluginEventToAperture, mapPluginEventToSourceEvent } from "../src/aperture/event-mapper.js";
import { createRunLifecycleIndex, deriveRunRetirements, observeRunLifecycleEntry, runRetryCandidate } from "../src/aperture/run-lifecycle.js";
import { createEmptyReviewState, createEmptySnapshot, type AttentionLedgerEventEntry, type StoredAttentionFrame } from "../src/aperture/types.js";

function runEvent(id: string, transition: string, payload: Record<string, unknown> = {}, occurredAt = "2026-10-22T10:00:00.000Z"): PluginEvent {
  return {
    eventId: `${id}-${transition}`,
    eventType: `agent.run.${transition === "timed_out" ? "failed" : transition}`,
    companyId: "company-runs",
    entityType: "heartbeat_run",
    entityId: id,
    occurredAt,
    actorType: "agent",
    actorId: "agent-1",
    payload: { agentId: "agent-1", issueId: "issue-1", ...payload },
  } as PluginEvent;
}

function entry(event: PluginEvent): AttentionLedgerEventEntry {
  const sourceEvent = mapPluginEventToSourceEvent(event)!;
  return {
    kind: "event", id: `${event.eventId}:event`, occurredAt: event.occurredAt,
    source: { eventType: event.eventType, entityType: event.entityType, entityId: event.entityId },
    sourceEvent, apertureEvent: normalizeSourceEvent(sourceEvent),
  };
}

const failureTime = "2026-10-22T10:01:00.000Z";
const laterStart = "2026-10-22T10:02:00.000Z";

describe("Paperclip run lifecycle", () => {
  it.each([
    ["started", "task.started", "running"],
    ["failed", "task.updated", "failed"],
    ["timed_out", "task.updated", "failed"],
    ["finished", "task.completed", "completed"],
    ["cancelled", "task.cancelled", "cancelled"],
  ])("maps %s to a dedicated run and preserves factual identity", (transition, type, status) => {
    const event = runEvent("run-1", transition, { error: "Host execution failed", errorCode: "adapter_error", status: transition });
    for (const mapped of [mapPluginEventToAperture(event), mapPluginEventToSourceEvent(event)]) {
      expect(mapped).toMatchObject({
        taskId: "run:run-1", type, source: { id: "paperclip:run" },
        metadata: { actorId: "agent-1", actorType: "agent", paperclipRun: {
          runId: "run-1", agentId: "agent-1", issueId: "issue-1", status, hostStatus: transition, errorCode: "adapter_error",
        } },
      });
      if (transition === "failed" || transition === "timed_out") {
        expect(mapped).toMatchObject({ status: "failed", activityClass: "tool_failure", summary: "Host execution failed" });
      }
    }
    const source = mapPluginEventToSourceEvent(event)!;
    expect(source.semanticHints?.relationHints).toEqual([expect.objectContaining({ kind: "same_issue" })]);
  });

  it("never mistakes agent identity for run identity and prefers explicit runId", () => {
    const event = { ...runEvent("agent-1", "failed"), entityType: "agent" };
    expect(mapPluginEventToSourceEvent(event)).toBeNull();
    expect(mapPluginEventToAperture({ ...event, payload: { runId: "actual-run" } })?.taskId).toBe("run:actual-run");
    expect(mapPluginEventToAperture({ ...event, entityType: "run" })?.taskId).toBe("run:agent-1");
  });

  it("validates metadata, excluding synthetic legacy IDs and malformed status/timestamps", () => {
    expect(parsePaperclipRunMetadata({ agentId: "agent-1", status: "failed" })).toBeNull();
    expect(parsePaperclipRunMetadata({ runId: "run-1", status: "invented" })).toBeNull();
    expect(parsePaperclipRunMetadata({ runId: "synthetic", legacyIdentity: true, status: "failed", startedAt: "invalid" }))
      .toMatchObject({ legacyIdentity: true, status: "failed", startedAt: undefined });
    expect(parsePaperclipRunMetadata({ runId: "synthetic", legacyIdentity: true })?.runId).toBeUndefined();
  });

  it("materializes only strictly later successful attempts with durable deterministic identity", () => {
    const failed = entry(runEvent("old", "failed", { finishedAt: failureTime }));
    const index = createRunLifecycleIndex([failed]);
    const started = entry(runEvent("new", "started", {}, laterStart));
    expect(deriveRunRetirements(index, started)).toEqual([]);
    observeRunLifecycleEntry(index, started);
    expect(deriveRunRetirements(index, entry(runEvent("new", "cancelled")))).toEqual([]);
    const success = entry(runEvent("new", "finished"));
    const [retirement] = deriveRunRetirements(index, success);
    expect(retirement).toMatchObject({
      id: `run-retirement:${encodeURIComponent(success.id)}:run%3Aold:successor`,
      occurredAt: success.occurredAt, source: success.source,
      sourceEvent: { type: "task.cancelled", taskId: "run:old", reason: "Failure attention superseded by successful run new.",
        metadata: { paperclipRun: { status: "failed", runId: "old" }, paperclipRunRetirement: { triggerEventId: success.id, reason: "successor" } } },
    });
    expect(retirement.sourceEvent?.id).toBe(retirement.id);
    expect(retirement.apertureEvent.id).toBe(retirement.id);
    expect(retirement.apertureEvent.metadata).toEqual(retirement.sourceEvent?.metadata);
    observeRunLifecycleEntry(index, retirement);
    expect(deriveRunRetirements(index, success)).toEqual([]);
    expect(createRunLifecycleIndex([failed, started, success, retirement]).get("run:old")?.retired).toBe(true);
  });

  it.each([
    { startedAt: failureTime },
    { startedAt: "2026-10-22T10:00:00.000Z" },
    { startedAt: "invalid" },
    {},
    { startedAt: laterStart, issueId: "another-issue" },
    { startedAt: laterStart, issueId: undefined },
  ])("does not infer recovery without matching scope and strictly ordered evidence: %j", (payload) => {
    const index = createRunLifecycleIndex([entry(runEvent("old", "failed", { finishedAt: failureTime }))]);
    expect(deriveRunRetirements(index, entry(runEvent("new", "finished", payload)))).toEqual([]);
  });

  it("uses observed failure timing when host timing is absent", () => {
    const index = createRunLifecycleIndex([entry(runEvent("old", "failed", {}, failureTime))]);
    expect(deriveRunRetirements(index, entry(runEvent("new", "finished", { startedAt: laterStart })))).toHaveLength(1);
  });

  it("requires the same agent for issue-less recovery and never crosses linked scopes", () => {
    const index = createRunLifecycleIndex([entry(runEvent("old", "failed", { issueId: undefined, finishedAt: failureTime }))]);
    expect(deriveRunRetirements(index, entry(runEvent("new", "finished", { issueId: undefined, startedAt: laterStart })))).toHaveLength(1);
    expect(deriveRunRetirements(index, entry(runEvent("new", "finished", { issueId: undefined, agentId: "other", startedAt: laterStart })))).toEqual([]);
    expect(deriveRunRetirements(index, entry(runEvent("new", "finished", { startedAt: laterStart })))).toEqual([]);
  });

  it("retires identifiable legacy attention only on explicit matching clears", () => {
    const failed = entry(runEvent("old", "failed", { finishedAt: failureTime }));
    const legacy = { legacyIdentity: true, agentId: "agent-1", status: "failed" };
    failed.apertureEvent.metadata = { paperclipRun: legacy };
    failed.sourceEvent!.metadata = { paperclipRun: legacy };
    const index = createRunLifecycleIndex([failed]);
    expect(deriveRunRetirements(index, entry(runEvent("new", "finished", { startedAt: laterStart })))).toEqual([]);
    const cleared = entry({ ...runEvent("agent-1", "failed"), eventType: "agent.error_cleared", entityType: "agent", payload: {} } as PluginEvent);
    expect(deriveRunRetirements(index, cleared)[0]?.sourceEvent).toMatchObject({ reason: "Agent error cleared in Paperclip." });
  });

  it.each(["done", "cancelled"])("maps authoritative issue %s and retires only matching failures", (status) => {
    const index = createRunLifecycleIndex([
      entry(runEvent("old", "failed")),
      entry(runEvent("unrelated", "failed", { issueId: "other" })),
    ]);
    const closed = entry({ ...runEvent("issue-1", "failed"), eventType: "issue.updated", entityType: "issue", payload: { status } });
    expect(closed.apertureEvent.type).toBe(status === "done" ? "task.completed" : "task.cancelled");
    expect(closed.sourceEvent?.metadata?.paperclipIssueStatus).toBe(status);
    expect(closed.apertureEvent.metadata?.paperclipIssueStatus).toBe(status);
    expect(deriveRunRetirements(index, closed).map((record) => record.apertureEvent.taskId)).toEqual(["run:old"]);
  });
});

function failedRunFrame(runId = "old"): StoredAttentionFrame {
  return {
    id: `frame:${runId}`, taskId: `run:${runId}`, interactionId: `interaction:run:${runId}:status`,
    source: { id: "paperclip:run", kind: "paperclip", label: "Paperclip run" },
    version: 1, mode: "status", tone: "focused", consequence: "high",
    title: "Execution failed", summary: "Adapter failed", responseSpec: { kind: "none" },
    timing: { createdAt: failureTime, updatedAt: failureTime },
    context: { items: [{ id: "failure", label: "Failure", value: "Adapter failed" }] },
    metadata: { paperclipRun: { runId, agentId: "agent-1", issueId: "issue-1", status: "failed" } },
  };
}

function retryingIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1", companyId: "company-runs",
    scheduledRetry: {
      runId: "successor", retryOfRunId: "old", agentId: "agent-1", agentName: null,
      status: "scheduled_retry", scheduledRetryAt: laterStart, scheduledRetryAttempt: 2,
      scheduledRetryReason: "Retry transient execution failure",
    },
    ...overrides,
  } as Issue;
}

describe("scheduled retry display policy", () => {
  it.each(["scheduled_retry", "queued", "running"] as const)("downgrades only the direct failed predecessor while %s", (status) => {
    const frame = failedRunFrame();
    const original = structuredClone(frame);
    const issue = retryingIssue();
    issue.scheduledRetry!.status = status;
    const candidate = runRetryCandidate(frame, issue)!;
    expect(candidate).toMatchObject({
      lane: "ambient",
      frame: {
        id: frame.id, taskId: frame.taskId, interactionId: frame.interactionId,
        tone: "ambient", consequence: "low", summary: "Paperclip is retrying this run automatically.",
        metadata: {
          paperclipRun: { runId: "old", status: "failed" },
          paperclipRunRecovery: { successorRunId: "successor", status, attempt: 2, scheduledRetryAt: laterStart },
          decision: { owner: "paperclip_reconciliation", lane: "ambient", sourcePolicy: "run.scheduledRetry" },
        },
      },
    });
    expect(candidate.frame.context?.items).toEqual([
      { id: "failure", label: "Failure", value: "Adapter failed" },
      { id: "retry-status", label: "Retry status", value: status === "scheduled_retry" ? "Scheduled Retry" : status === "queued" ? "Queued" : "Running" },
      { id: "retry-at", label: "Next retry", value: laterStart },
      { id: "retry-attempt", label: "Retry attempt", value: "2" },
    ]);
    expect(frame).toEqual(original);
    expect(runRetryCandidate(failedRunFrame("older"), issue)).toBeNull();
  });

  it.each([
    { runId: "" }, { runId: "  " }, { runId: "old" }, { retryOfRunId: "other" },
    { agentId: "other" }, { status: "cancelled" }, { retryExhaustedReason: "max retries" },
    { scheduledRetryAttempt: -1 }, { scheduledRetryAttempt: NaN }, { scheduledRetryAttempt: 1.5 },
  ])("rejects ineligible retry facts %j", (retry) => {
    const issue = retryingIssue();
    Object.assign(issue.scheduledRetry!, retry);
    expect(runRetryCandidate(failedRunFrame(), issue)).toBeNull();
  });

  it.each([
    { status: "completed" }, { status: "running" }, { status: "cancelled" },
    { legacyIdentity: true }, { runId: undefined }, { runId: "other" },
    { issueId: "other" }, { issueId: undefined }, { agentId: "other" }, { agentId: undefined },
  ])("requires trustworthy matching failed run identity %j", (run) => {
    const frame = failedRunFrame();
    Object.assign(frame.metadata!.paperclipRun as object, run);
    expect(runRetryCandidate(frame, retryingIssue())).toBeNull();
  });

  it("never downgrades a different task kind or independent host blocker", () => {
    expect(runRetryCandidate({ ...failedRunFrame(), taskId: "issue:old" }, retryingIssue())).toBeNull();
    expect(runRetryCandidate(failedRunFrame(), retryingIssue({ scheduledRetry: null }))).toBeNull();
    for (const status of ["active", "escalated"]) {
      expect(runRetryCandidate(failedRunFrame(), retryingIssue({
        activeRecoveryAction: { status } as NonNullable<Issue["activeRecoveryAction"]>,
      }))).toBeNull();
    }
    expect(runRetryCandidate(failedRunFrame(), retryingIssue({
      blockedInboxAttention: { reason: "pending_user_decision" } as NonNullable<Issue["blockedInboxAttention"]>,
    }))).toBeNull();
  });

  it.each([null, "invalid", new Date(NaN)])("omits unavailable retry time without inventing a timestamp: %s", (scheduledRetryAt) => {
    const issue = retryingIssue();
    issue.scheduledRetry!.scheduledRetryAt = scheduledRetryAt;
    const candidate = runRetryCandidate(failedRunFrame(), issue)!;
    expect(candidate.frame.context?.items?.some((item) => item.id === "retry-at")).toBe(false);
    expect(readPaperclipRunRecoveryMetadata(candidate.frame)?.scheduledRetryAt).toBeUndefined();
  });

  it("normalizes Date retry timestamps and preserves acknowledgement", () => {
    const issue = retryingIssue();
    issue.scheduledRetry!.scheduledRetryAt = new Date(laterStart);
    const candidate = runRetryCandidate(failedRunFrame(), issue)!;
    expect(readPaperclipRunRecoveryMetadata(candidate.frame)?.scheduledRetryAt).toBe(laterStart);
    const review = createEmptyReviewState("company-runs");
    review.frames[candidate.frame.taskId] = { suppressedAt: failureTime };
    expect(mergeStoredFrames(null, "company-runs", [candidate], review).counts.total).toBe(0);
  });

  it("keeps active retry awareness beyond five minutes and restores canonical failure when retry disappears", () => {
    const frame = failedRunFrame();
    const unrelated = { ...failedRunFrame("independent"), taskId: "issue:review", title: "Independent review" };
    const snapshot = {
      ...createEmptySnapshot("company-runs"), now: frame, next: [unrelated],
      counts: { now: 1, next: 1, ambient: 0, total: 2 },
    };
    const candidate = runRetryCandidate(frame, retryingIssue())!;
    const display = mergeStoredFrames(snapshot, "company-runs", [candidate], null, "2026-10-22T11:00:00.000Z");
    expect(display.ambient).toEqual([candidate.frame]);
    expect(display.now?.taskId).toBe(unrelated.taskId);
    expect(snapshot.now).toBe(frame);
    expect(snapshot.now.summary).toBe("Adapter failed");
    for (const scheduledRetry of [null, { ...retryingIssue().scheduledRetry!, status: "cancelled" as const },
      { ...retryingIssue().scheduledRetry!, retryExhaustedReason: "max retries" }]) {
      expect(runRetryCandidate(frame, retryingIssue({ scheduledRetry }))).toBeNull();
      const restored = mergeStoredFrames(snapshot, "company-runs", [], null, "2026-10-22T11:00:00.000Z");
      expect(restored.now).toBe(frame);
      expect(restored.next).toEqual([unrelated]);
      expect(restored.ambient).toEqual([]);
    }
  });
});
