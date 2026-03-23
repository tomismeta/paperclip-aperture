import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, IssueComment } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import type { AttentionExport, AttentionReplayScenario, AttentionReviewState, AttentionSnapshot } from "../src/aperture/types.js";
import plugin from "../src/worker.js";
import {
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
} from "../src/handlers/shared.js";

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-live",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Blocked rollout follow-up",
    description: "Need clarification from the operator before resuming the rollout.",
    status: "blocked",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 9,
    identifier: "CAM-9",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-18T10:00:00.000Z"),
    updatedAt: new Date("2026-03-19T10:00:00.000Z"),
    ...overrides,
  };
}

function createIssueComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "comment-1",
    companyId: "company-live",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Need clarification on whether we should proceed with the customer-visible fix.",
    createdAt: new Date("2026-03-19T10:05:00.000Z"),
    updatedAt: new Date("2026-03-19T10:05:00.000Z"),
    ...overrides,
  };
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-live",
    name: "Atlas",
    urlKey: "atlas",
    role: "engineer",
    title: "Platform Engineer",
    icon: null,
    status: "error",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 10000,
    spentMonthlyCents: 2500,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    metadata: null,
    lastHeartbeatAt: new Date("2026-03-19T10:00:00.000Z"),
    createdAt: new Date("2026-03-18T09:00:00.000Z"),
    updatedAt: new Date("2026-03-19T10:10:00.000Z"),
    ...overrides,
  };
}

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

  it("attaches core semantic payloads and issue relation hints to mapped events", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "budget_override_required",
        title: "Approve launch budget exception",
        summary: "Budget controls are blocking launch prep for CAM-9.",
        issueIds: ["issue-99"],
      },
      { companyId: "company-semantic", entityId: "approval-semantic-1", entityType: "approval" },
    );

    await harness.emit(
      "issue.comment.created",
      {
        identifier: "CAM-9",
        issueTitle: "Launch prep blocked",
        bodySnippet: "Can you share the memo with the board so review can continue?",
        status: "blocked",
      },
      { companyId: "company-semantic", entityId: "issue-99", entityType: "issue" },
    );

    const exported = await harness.getData<AttentionExport>("attention-export", { companyId: "company-semantic" });
    const approvalEntry = exported.eventEntries.find((entry) => entry.source.eventType === "approval.created");
    const issueEntry = exported.eventEntries.find((entry) => entry.source.eventType === "issue.comment.created");

    expect(approvalEntry?.apertureEvent.semantic?.confidence).toBe("high");
    expect(approvalEntry?.apertureEvent.semantic?.relationHints).toContainEqual({
      kind: "same_issue",
      target: "issue:issue-99",
    });
    expect(issueEntry?.apertureEvent.semantic?.relationHints).toContainEqual({
      kind: "same_issue",
      target: "issue:issue-99",
    });
  });

  it("records approval responses through the plugin action path and clears the frame after restart", async () => {
    const firstHarness = createTestHarness({ manifest });
    await plugin.definition.setup(firstHarness.ctx);

    await firstHarness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve launch cutover",
        summary: "Launch cutover is waiting on a human decision.",
      },
      { companyId: "company-approval-response", entityId: "approval-response-1", entityType: "approval" },
    );

    const initial = await firstHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-approval-response" });
    expect(initial.active?.taskId).toBe("approval:approval-response-1");

    await firstHarness.performAction("record-approval-response", {
      companyId: "company-approval-response",
      taskId: initial.active?.taskId,
      interactionId: initial.active?.interactionId,
      decision: "approve",
    });

    const cleared = await firstHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-approval-response" });
    expect(cleared.active).toBeNull();

    const persistedLedger = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-approval-response",
      stateKey: ATTENTION_LEDGER_STATE_KEY,
    });
    const persistedSnapshot = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-approval-response",
      stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
    });

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-approval-response", stateKey: ATTENTION_LEDGER_STATE_KEY },
      persistedLedger,
    );
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-approval-response", stateKey: ATTENTION_SNAPSHOT_STATE_KEY },
      persistedSnapshot,
    );

    const rebuilt = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-approval-response" });
    expect(rebuilt.active).toBeNull();
    expect(rebuilt.counts.total).toBe(0);
  });

  it("persists approval suppression even when the approval frame only exists in the UI layer", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("record-approval-response", {
      companyId: "company-approval-ui-only",
      taskId: "approval:approval-ui-only-1",
      interactionId: "approval:approval-ui-only-1:approval",
      decision: "request-revision",
    });

    const review = await harness.getData<AttentionReviewState>("attention-review", { companyId: "company-approval-ui-only" });
    expect(review.frames["approval:approval-ui-only-1"]?.suppressedAt).toBeTruthy();

    const summary = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-approval-ui-only" });
    expect(summary.counts.total).toBe(0);
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

  it("reconstructs acknowledged suppression from the ledger after restart even without persisted review state", async () => {
    const firstHarness = createTestHarness({ manifest });
    await plugin.definition.setup(firstHarness.ctx);
    firstHarness.seed({
      issues: [createIssue({ companyId: "company-review-replay" })],
      issueComments: [createIssueComment({ companyId: "company-review-replay" })],
    });

    const initial = await firstHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-review-replay" });
    await firstHarness.performAction("acknowledge-frame", {
      companyId: "company-review-replay",
      taskId: initial.active?.taskId,
      interactionId: initial.active?.interactionId,
    });

    const persistedLedger = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-review-replay",
      stateKey: ATTENTION_LEDGER_STATE_KEY,
    });
    const persistedSnapshot = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-review-replay",
      stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
    });

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-review-replay", stateKey: ATTENTION_LEDGER_STATE_KEY },
      persistedLedger,
    );
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-review-replay", stateKey: ATTENTION_SNAPSHOT_STATE_KEY },
      persistedSnapshot,
    );

    const review = await secondHarness.getData<AttentionReviewState>("attention-review", { companyId: "company-review-replay" });
    expect(review.frames["issue:issue-1"]?.suppressedAt).toBeTruthy();

    const rebuilt = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-review-replay" });
    expect(rebuilt.active).toBeNull();
    expect(rebuilt.counts.total).toBe(0);
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

  it("reconciles blocked issues with latest comments even without a prior event", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.taskId).toBe("issue:issue-1");
    expect(snapshot.active?.title).toContain("CAM-9");
    expect(snapshot.active?.summary).toBe("Blocked issue waiting on clarification before work can continue.");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "latest-comment")?.value).toContain("Need clarification");
    expect(snapshot.review?.unread.total).toBeGreaterThan(0);
  });

  it("reconciles blocked issues when host comment timestamps are ISO strings", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [
        createIssueComment({
          createdAt: "2026-03-19T10:05:00.000Z" as unknown as Date,
          updatedAt: "2026-03-19T10:05:00.000Z" as unknown as Date,
        }),
      ],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.taskId).toBe("issue:issue-1");
    expect(snapshot.active?.summary).toBe("Blocked issue waiting on clarification before work can continue.");
  });

  it("does not reconcile seeded issues when issue lifecycle capture is disabled", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        captureIssueLifecycle: false,
      },
    });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active).toBeNull();
    expect(snapshot.queued).toHaveLength(0);
    expect(snapshot.ambient).toHaveLength(0);
    expect(snapshot.counts.total).toBe(0);
  });

  it("reconciles errored agents as active attention", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      agents: [createAgent()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.taskId).toBe("agent:agent-1");
    expect(snapshot.active?.consequence).toBe("high");
    expect(snapshot.active?.title).toContain("Atlas");
  });

  it("suppresses reconciled frames after acknowledgement until the underlying item changes", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(initial.active?.taskId).toBe("issue:issue-1");

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.active?.taskId,
      interactionId: initial.active?.interactionId,
    });

    const suppressed = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(suppressed.active).toBeNull();
    expect(suppressed.counts.total).toBe(0);
    const refreshedIssueUpdatedAt = new Date(Date.now() + 60_000);
    const refreshedCommentUpdatedAt = new Date(Date.now() + 120_000);

    harness.seed({
      issues: [
        createIssue({
          updatedAt: refreshedIssueUpdatedAt,
          description: "Fresh update from the operator is needed before the rollout can continue.",
        }),
      ],
      issueComments: [
        createIssueComment({
          createdAt: refreshedCommentUpdatedAt,
          updatedAt: refreshedCommentUpdatedAt,
          body: "New clarification request after the latest rollout attempt.",
        }),
      ],
    });

    const resurfaced = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(resurfaced.active?.taskId).toBe("issue:issue-1");
    expect(resurfaced.active?.summary).toBe("Blocked issue waiting on clarification before work can continue.");
    expect(resurfaced.active?.context?.items?.find((item) => item.id === "latest-comment")?.value).toContain("New clarification request");
    expect(resurfaced.review?.unread.total).toBeGreaterThan(0);
  });

  it("does not resurface an acknowledged issue when only the generic issue timestamp advances", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const commentUpdatedAt = new Date("2026-03-19T10:05:00.000Z");
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment({ updatedAt: commentUpdatedAt, createdAt: commentUpdatedAt })],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(initial.active?.taskId).toBe("issue:issue-1");

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.active?.taskId,
      interactionId: initial.active?.interactionId,
    });

    harness.seed({
      issues: [createIssue({ updatedAt: new Date("2026-03-19T10:20:00.000Z") })],
      issueComments: [createIssueComment({ updatedAt: commentUpdatedAt, createdAt: commentUpdatedAt })],
    });

    const suppressed = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(suppressed.active).toBeNull();
    expect(suppressed.counts.total).toBe(0);
  });

  it("downgrades blocked issues with a resolving comment into ambient follow-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T10:04:00.000Z"));
    const harness = createTestHarness({ manifest });
    try {
      await plugin.definition.setup(harness.ctx);
      harness.seed({
        issues: [createIssue()],
        issueComments: [createIssueComment({
          body: "CEO Confirmation: final direction. Use these. Unblock CAM-9 and proceed to launch review.",
        })],
      });

      const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
      expect(snapshot.active).toBeNull();
      expect(snapshot.queued).toHaveLength(0);
      expect(snapshot.ambient).toHaveLength(1);
      expect(snapshot.ambient[0]?.summary).toBe("Latest operator guidance appears to unblock this issue.");
      expect(snapshot.ambient[0]?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
        "Monitor execution and confirm the team resumes work.",
      );
      expect(snapshot.ambient[0]?.context?.items?.find((item) => item.id === "needs-action-from")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives a specific review recommendation and blocker hint from explicit confirmation requests", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [
        createIssue({
          status: "in_review",
          priority: "high",
          identifier: "APE-2",
          title: "Write product definition 1-pager",
        }),
      ],
      issueComments: [
        createIssueComment({
          body: "Please review and confirm the direction before the Founding Engineer starts on APE-4.",
        }),
      ],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.taskId).toBe("issue:issue-1");
    expect(snapshot.active?.summary).toBe("Waiting on confirmation before APE-4 can proceed.");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
      "Confirm the direction so APE-4 can proceed.",
    );
    expect(snapshot.active?.context?.items?.find((item) => item.id === "blocks-target")?.value).toBe("APE-4");
    expect(snapshot.active?.provenance?.whyNow).toBe("APE-4 is waiting on explicit confirmation before work can continue.");
  });

  it("derives a specific sharing recommendation when the board still needs the memo", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [
        createIssue({
          status: "in_review",
          priority: "high",
          identifier: "APE-7",
          title: "Review pricing experiment memo",
        }),
      ],
      issueComments: [
        createIssueComment({
          body: "I don't actually see the actual memo. Can you share it with the board?",
        }),
      ],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.summary).toBe("Board still needs the memo before review can continue.");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
      "Share the memo with the board so review can continue.",
    );
    expect(snapshot.active?.provenance?.whyNow).toBe("The board still needs the memo before review can continue.");
  });

  it("acknowledges reconciled issue frames and clears unread state", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(initial.active?.taskId).toBe("issue:issue-1");
    expect(initial.review?.unread.total).toBeGreaterThan(0);

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.active?.taskId,
      interactionId: initial.active?.interactionId,
    });

    const acknowledged = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(acknowledged.active).toBeNull();
    expect(acknowledged.counts.total).toBe(0);
    expect(acknowledged.review?.unread.total).toBe(0);
  });

  it("posts issue comments back to Paperclip from the frame action", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    await harness.performAction("comment-on-issue", {
      companyId: "company-live",
      taskId: snapshot.active?.taskId,
      issueId: "issue-1",
      body: "Board can cover outreach directly this week while tooling is sorted out.",
    });

    const comments = await harness.ctx.issues.listComments("issue-1", "company-live");
    expect(comments).toHaveLength(2);
    expect(comments.at(-1)?.body).toContain("Board can cover outreach directly");

    const updated = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(updated.active?.taskId).toBe("issue:issue-1");
    expect(updated.active?.context?.items?.find((item) => item.id === "latest-comment")?.value).toContain("Board can cover outreach directly");
  });

  it("surfaces actor routing and a recommended move when the issue text is explicit", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [
        createIssue({
          title: "Reach out to early users",
          description: "Board should either send the outreach directly or equip the agent with comms tooling.",
        }),
      ],
      issueComments: [
        createIssueComment({
          body: "Blocked on actual outreach. Needed from @CEO: confirm who should send the first messages.",
        }),
      ],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.summary).toBe("Blocked on CEO action before work can continue.");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "needs-action-from")?.value).toBe("CEO");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "recommended-move")?.value).toContain("Board should either");
  });

  it("resolves known company agent names as agents in issue routing", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      agents: [createAgent({ id: "agent-fe", name: "Founding Engineer", title: "Founding Engineer", status: "active" as Agent["status"] })],
      issues: [
        createIssue({
          title: "Confirm prototype handoff",
          description: "Need the implementation owner to confirm the handoff before rollout.",
        }),
      ],
      issueComments: [
        createIssueComment({
          body: "Needed from Founding Engineer: confirm the rollout handoff before the board reviews it.",
        }),
      ],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.active?.summary).toBe("Blocked on Founding Engineer action before work can continue.");
    expect(snapshot.active?.context?.items?.find((item) => item.id === "needs-action-from")?.value).toBe("Founding Engineer");
    expect(snapshot.active?.provenance?.whyNow).toBe("This issue is blocked on action from Founding Engineer.");
  });

  it("marks current attention as seen without suppressing it", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
      agents: [createAgent()],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    const taskIds = [
      ...(initial.active ? [initial.active.taskId] : []),
      ...initial.queued.map((frame) => frame.taskId),
      ...initial.ambient.map((frame) => frame.taskId),
    ];

    expect(initial.review?.unread.total).toBeGreaterThan(0);

    await harness.performAction("mark-attention-seen", {
      companyId: "company-live",
      taskIds,
    });

    const seen = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(seen.active?.taskId).toBe(initial.active?.taskId);
    expect(seen.counts.total).toBe(initial.counts.total);
    expect(seen.review?.unread.total).toBe(0);
    expect(seen.review?.lastSeenAt).toBeTruthy();
  });

  it("exports the ledger, responses, and reconciled snapshot for offline analysis", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve launch cutover",
        summary: "Launch cutover is waiting on a human decision.",
      },
      { companyId: "company-export", entityId: "approval-export-1", entityType: "approval" },
    );

    const beforeResponse = await harness.getData<AttentionExport>("attention-export", { companyId: "company-export" });
    expect(beforeResponse.ledger).toHaveLength(1);
    expect(beforeResponse.eventEntries).toHaveLength(1);
    expect(beforeResponse.responseEntries).toHaveLength(0);
    expect(beforeResponse.reconciledSnapshot.active?.title).toBe("Approve launch cutover");

    await harness.performAction("acknowledge-frame", {
      companyId: "company-export",
      taskId: beforeResponse.reconciledSnapshot.active?.taskId,
      interactionId: beforeResponse.reconciledSnapshot.active?.interactionId,
    });

    const afterResponse = await harness.getData<AttentionExport>("attention-export", { companyId: "company-export" });
    expect(afterResponse.ledger).toHaveLength(2);
    expect(afterResponse.eventEntries).toHaveLength(1);
    expect(afterResponse.responseEntries).toHaveLength(1);
    expect(afterResponse.snapshot.active).toBeNull();
  });

  it("exports a lab-compatible replay scenario from the attention ledger", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve launch cutover",
        summary: "Launch cutover is waiting on a human decision.",
      },
      { companyId: "company-replay-export", entityId: "approval-replay-export-1", entityType: "approval" },
    );

    const beforeResponse = await harness.getData<AttentionReplayScenario>("attention-replay-scenario", {
      companyId: "company-replay-export",
    });
    expect(beforeResponse.steps).toHaveLength(1);
    expect(beforeResponse.steps[0]?.kind).toBe("publish");
    expect(beforeResponse.expectations?.finalActiveInteractionId).toBeTruthy();

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay-export" });
    await harness.performAction("acknowledge-frame", {
      companyId: "company-replay-export",
      taskId: snapshot.active?.taskId,
      interactionId: snapshot.active?.interactionId,
    });

    const afterResponse = await harness.getData<AttentionReplayScenario>("attention-replay-scenario", {
      companyId: "company-replay-export",
    });
    expect(afterResponse.steps).toHaveLength(2);
    expect(afterResponse.steps[0]?.kind).toBe("publish");
    expect(afterResponse.steps[1]?.kind).toBe("submit");
    expect(afterResponse.expectations?.finalActiveInteractionId).toBeNull();
    expect(afterResponse.expectations?.resultBucketCounts?.active).toBe(0);
  });

});
