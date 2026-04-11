import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue, IssueComment, PluginIssuesClient } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import type { AttentionExport, AttentionReplayScenario, AttentionReviewState, AttentionSnapshot } from "../src/aperture/types.js";
import type { ApprovalRecord } from "../src/aperture/approval-frames.js";
import plugin from "../src/worker.js";
import {
  ATTENTION_STATE_KEY,
  ATTENTION_LEDGER_STATE_KEY,
  ATTENTION_SNAPSHOT_STATE_KEY,
} from "../src/handlers/shared.js";

type IssueDocumentSummary = Awaited<ReturnType<PluginIssuesClient["documents"]["list"]>>[number];

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

function createIssueDocumentSummary(overrides: Partial<IssueDocumentSummary> = {}): IssueDocumentSummary {
  return {
    id: "document-1",
    companyId: "company-live",
    issueId: "issue-1",
    key: "plan",
    title: "Pricing experiment memo",
    format: "markdown",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-03-19T10:00:00.000Z"),
    updatedAt: new Date("2026-03-19T10:15:00.000Z"),
    ...overrides,
  };
}

function createApprovalRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-live",
    type: "approve_ceo_strategy",
    status: "pending",
    payload: {
      title: "Approve launch cutover",
      summary: "Launch cutover is waiting on a human decision.",
    },
    createdAt: "2026-03-19T10:00:00.000Z",
    updatedAt: "2026-03-19T10:05:00.000Z",
    ...overrides,
  };
}

function mockApprovalApi(
  harness: ReturnType<typeof createTestHarness>,
  approvals: Array<Record<string, unknown>> = [],
) {
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/companies/") && url.includes("/approvals?status=pending")) {
      return new Response(JSON.stringify(approvals), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      url.includes("/api/approvals/")
      && init?.method === "POST"
    ) {
      return new Response("", { status: 200 });
    }

    throw new Error(`Unhandled approval API request in test: ${url}`);
  });
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
    expect(snapshot.now?.mode).toBe("approval");
    expect(snapshot.now?.title).toBe("Approve production deploy");
    expect(snapshot.counts.now).toBe(1);

    await harness.performAction("acknowledge-frame", {
      companyId: "company-1",
      taskId: snapshot.now?.taskId,
      interactionId: snapshot.now?.interactionId,
    });

    const cleared = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-1" });
    expect(cleared.now).toBeNull();
    expect(cleared.counts.now).toBe(0);
    expect(harness.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "frame_acknowledged",
        dimensions: expect.objectContaining({
          surface: "focus",
          entityType: "approval",
        }),
      }),
    ]));
  });

  it("records operator engagement for the active now item", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve pricing memo",
        summary: "The pricing memo is ready for review.",
      },
      { companyId: "company-focus-hold", entityId: "approval-1", entityType: "approval" },
    );

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-focus-hold" });
    const response = await harness.performAction<{ ok: boolean; snapshot: AttentionSnapshot }>("engage-focus", {
      companyId: "company-focus-hold",
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
      durationMs: 1000,
      reason: "test_hold",
    });

    expect(response.ok).toBe(true);
    expect(response.snapshot.now?.title).toBe("Approve pricing memo");
    expect(harness.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "focus_engaged",
        dimensions: expect.objectContaining({
          surface: "focus",
          actionKind: "engage",
          reason: "test_hold",
        }),
      }),
    ]));
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
    expect(snapshot.now?.consequence).toBe("high");
    expect(snapshot.now?.title).toContain("Build failed");
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
    expect(snapshot.now?.title).toBe("Approve temporary budget override for CAM-9");
    expect(snapshot.now?.consequence).toBe("high");
    expect(snapshot.now?.provenance?.factors).toContain("budget stop");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "requested-amount")?.value).toBe("$500");
  });

  it("attaches richer core semantic payloads and issue relation hints to mapped events", async () => {
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

    await harness.emit(
      "issue.comment.created",
      {
        identifier: "CAM-10",
        issueTitle: "Launch memo resolved",
        bodySnippet: "Final direction. Use these. Unblock CAM-10 and proceed to launch review.",
        status: "blocked",
      },
      { companyId: "company-semantic", entityId: "issue-100", entityType: "issue" },
    );

    const exported = await harness.getData<AttentionExport>("attention-export", { companyId: "company-semantic" });
    const approvalEntry = exported.eventEntries.find((entry) => entry.source.eventType === "approval.created");
    const blockingIssueEntry = exported.eventEntries.find(
      (entry) => entry.source.eventType === "issue.comment.created" && entry.source.entityId === "issue-99",
    );
    const resolvingIssueEntry = exported.eventEntries.find(
      (entry) => entry.source.eventType === "issue.comment.created" && entry.source.entityId === "issue-100",
    );

    expect(approvalEntry?.apertureEvent.semantic?.confidence).toBe("high");
    expect(approvalEntry?.apertureEvent.semantic?.relationHints).toContainEqual({
      kind: "same_issue",
      target: "issue:issue-99",
    });
    expect(blockingIssueEntry?.apertureEvent.semantic?.confidence).toBe("high");
    expect(blockingIssueEntry?.apertureEvent.semantic?.relationHints).toContainEqual({
      kind: "same_issue",
      target: "issue:issue-99",
    });
    expect(blockingIssueEntry?.apertureEvent.semantic?.relationHints).toContainEqual({
      kind: "supersedes",
      target: "issue:issue-99",
    });
    expect(resolvingIssueEntry?.apertureEvent.semantic?.confidence).toBe("high");
    expect(resolvingIssueEntry?.apertureEvent.semantic?.relationHints).toContainEqual({
      kind: "resolves",
      target: "issue:issue-100",
    });
  });

  it("records approval responses through the plugin action path and clears the frame after restart", async () => {
    const firstHarness = createTestHarness({ manifest });
    await plugin.definition.setup(firstHarness.ctx);
    mockApprovalApi(firstHarness);

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
    expect(initial.now?.taskId).toBe("approval:approval-response-1");

    await firstHarness.performAction("record-approval-response", {
      companyId: "company-approval-response",
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
      decision: "approve",
    });

    const cleared = await firstHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-approval-response" });
    expect(cleared.now).toBeNull();
    expect(firstHarness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Approved a Focus approval.",
        entityType: "approval",
        entityId: "approval-response-1",
        metadata: expect.objectContaining({
          source: "focus",
          decision: "approve",
          taskId: "approval:approval-response-1",
        }),
      }),
    ]));

    const persistedState = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-approval-response",
      stateKey: ATTENTION_STATE_KEY,
    });

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-approval-response", stateKey: ATTENTION_STATE_KEY },
      persistedState,
    );

    const rebuilt = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-approval-response" });
    expect(rebuilt.now).toBeNull();
    expect(rebuilt.counts.total).toBe(0);
  });

  it("persists approval suppression even when the approval frame only exists in the UI layer", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    mockApprovalApi(harness);

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
    const persistedState = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-replay",
      stateKey: ATTENTION_STATE_KEY,
    });

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-replay", stateKey: ATTENTION_STATE_KEY },
      persistedState,
    );

    const rebuilt = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay" });
    expect(rebuilt.now?.title).toBe(original.now?.title);
    expect(rebuilt.counts.now).toBe(1);

    await secondHarness.performAction("acknowledge-frame", {
      companyId: "company-replay",
      taskId: rebuilt.now?.taskId,
      interactionId: rebuilt.now?.interactionId,
    });

    const cleared = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay" });
    expect(cleared.now).toBeNull();
    expect(cleared.counts.now).toBe(0);
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
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
    });

    const persistedState = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-review-replay",
      stateKey: ATTENTION_STATE_KEY,
    });
    const persistedLedger = (persistedState as { payload?: { ledger?: unknown } })?.payload?.ledger;
    const persistedSnapshot = (persistedState as { payload?: { snapshot?: unknown } })?.payload?.snapshot;

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-review-replay", stateKey: ATTENTION_STATE_KEY },
      persistedState,
    );
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
    expect(rebuilt.now).toBeNull();
    expect(rebuilt.counts.total).toBe(0);
  });

  it("hydrates from the legacy split state keys for backwards compatibility", async () => {
    const firstHarness = createTestHarness({ manifest });
    await plugin.definition.setup(firstHarness.ctx);

    await firstHarness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve migration-safe replay",
        summary: "A legacy replay path is waiting on review.",
      },
      { companyId: "company-legacy-envelope", entityId: "approval-legacy-1", entityType: "approval" },
    );

    const persistedState = firstHarness.getState({
      scopeKind: "company",
      scopeId: "company-legacy-envelope",
      stateKey: ATTENTION_STATE_KEY,
    }) as { payload?: { ledger?: unknown; snapshot?: unknown } };
    const persistedLedger = persistedState.payload?.ledger;
    const persistedSnapshot = persistedState.payload?.snapshot;

    const secondHarness = createTestHarness({ manifest });
    await plugin.definition.setup(secondHarness.ctx);
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-legacy-envelope", stateKey: ATTENTION_LEDGER_STATE_KEY },
      persistedLedger,
    );
    await secondHarness.ctx.state.set(
      { scopeKind: "company", scopeId: "company-legacy-envelope", stateKey: ATTENTION_SNAPSHOT_STATE_KEY },
      persistedSnapshot,
    );

    const rebuilt = await secondHarness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-legacy-envelope" });
    expect(rebuilt.now?.title).toBe("Approve migration-safe replay");
    expect(rebuilt.counts.now).toBe(1);
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
    expect(snapshot.now).toBeNull();
    expect(snapshot.next).toHaveLength(0);
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
    expect(snapshot.now).toBeNull();
    expect(snapshot.next).toHaveLength(0);
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
    expect(snapshot.now?.taskId).toBe("issue:issue-1");
    expect(snapshot.now?.title).toContain("CAM-9");
    expect(snapshot.now?.summary).toBe("Blocked issue waiting on clarification before work can continue.");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "latest-comment")?.value).toContain("Need clarification");
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
    expect(snapshot.now?.taskId).toBe("issue:issue-1");
    expect(snapshot.now?.summary).toBe("Blocked issue waiting on clarification before work can continue.");
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
    expect(snapshot.now).toBeNull();
    expect(snapshot.next).toHaveLength(0);
    expect(snapshot.ambient).toHaveLength(0);
    expect(snapshot.counts.total).toBe(0);
  });

  it("reconciles errored agents as now attention", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      agents: [createAgent()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.now?.taskId).toBe("agent:agent-1");
    expect(snapshot.now?.consequence).toBe("high");
    expect(snapshot.now?.title).toContain("Atlas");
  });

  it("suppresses reconciled frames after acknowledgement until the underlying item changes", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(initial.now?.taskId).toBe("issue:issue-1");

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
    });

    const suppressed = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(suppressed.now).toBeNull();
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
    expect(resurfaced.now?.taskId).toBe("issue:issue-1");
    expect(resurfaced.now?.summary).toBe("Blocked issue waiting on clarification before work can continue.");
    expect(resurfaced.now?.context?.items?.find((item) => item.id === "latest-comment")?.value).toContain("New clarification request");
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
    expect(initial.now?.taskId).toBe("issue:issue-1");

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
    });

    harness.seed({
      issues: [createIssue({ updatedAt: new Date("2026-03-19T10:20:00.000Z") })],
      issueComments: [createIssueComment({ updatedAt: commentUpdatedAt, createdAt: commentUpdatedAt })],
    });

    const suppressed = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(suppressed.now).toBeNull();
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
      expect(snapshot.now).toBeNull();
      expect(snapshot.next).toHaveLength(0);
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
    expect(snapshot.now?.taskId).toBe("issue:issue-1");
    expect(snapshot.now?.summary).toBe("Waiting on confirmation before APE-4 can proceed.");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
      "Confirm the direction so APE-4 can proceed.",
    );
    expect(snapshot.now?.context?.items?.find((item) => item.id === "blocks-target")?.value).toBe("APE-4");
    expect(snapshot.now?.provenance?.whyNow).toBe("APE-4 is waiting on explicit confirmation before work can continue.");
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
    expect(snapshot.now?.summary).toBe("Board still needs the memo before review can continue.");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
      "Share the memo with the board so review can continue.",
    );
    expect(snapshot.now?.provenance?.whyNow).toBe("The board still needs the memo before review can continue.");
    expect(snapshot.now?.metadata?.attention).toEqual({
      rationale: ["waiting on human", "issue review"],
    });
    expect(snapshot.now?.metadata?.semantic).toEqual({
      confidence: "high",
      relationHints: [
        { kind: "same_issue", target: "issue:issue-1" },
        { kind: "supersedes", target: "issue:issue-1" },
      ],
    });
  });

  it("downgrades memo-share review requests after a document is attached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T10:16:00.000Z"));
    const harness = createTestHarness({ manifest });
    try {
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
            createdAt: new Date("2026-03-19T10:05:00.000Z"),
            updatedAt: new Date("2026-03-19T10:05:00.000Z"),
          }),
        ],
      });
      harness.ctx.issues.documents.list = vi.fn(async () => [
        createIssueDocumentSummary({
          issueId: "issue-1",
          updatedAt: new Date("2026-03-19T10:15:00.000Z"),
        }),
      ]);

      const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
      expect(snapshot.now).toBeNull();
      expect(snapshot.next).toHaveLength(0);
      expect(snapshot.ambient).toHaveLength(1);
      expect(snapshot.ambient[0]?.summary).toBe("The requested memo appears attached, so review should be able to continue.");
      expect(snapshot.ambient[0]?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
        "Monitor the review now that the memo is attached.",
      );
      expect(snapshot.ambient[0]?.provenance?.whyNow).toBe(
        "Pricing experiment memo was attached after the request, so the missing artifact appears resolved.",
      );
      expect(snapshot.ambient[0]?.metadata?.attention).toEqual({
        rationale: ["document attached", "review can proceed"],
      });
      expect(snapshot.ambient[0]?.metadata?.semantic).toEqual({
        confidence: "high",
        relationHints: [
          { kind: "same_issue", target: "issue:issue-1" },
          { kind: "supersedes", target: "issue:issue-1" },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to comment-based review blocking when document lookup fails", async () => {
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
    harness.ctx.issues.documents.list = vi.fn(async () => {
      throw new Error("document read unavailable");
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(snapshot.now?.summary).toBe("Board still needs the memo before review can continue.");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "recommended-move")?.value).toBe(
      "Share the memo with the board so review can continue.",
    );
  });

  it("acknowledges reconciled issue frames and clears unread state", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(initial.now?.taskId).toBe("issue:issue-1");
    expect(initial.review?.unread.total).toBeGreaterThan(0);

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
    });

    const acknowledged = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(acknowledged.now).toBeNull();
    expect(acknowledged.counts.total).toBe(0);
    expect(acknowledged.review?.unread.total).toBe(0);
    expect(harness.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "frame_acknowledged",
        dimensions: expect.objectContaining({
          surface: "focus",
          entityType: "issue",
        }),
      }),
    ]));
  });

  it("restores the prior focus state and marks health when persistence fails", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const initial = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(initial.now?.taskId).toBe("issue:issue-1");

    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    vi.spyOn(harness.ctx.state, "set").mockImplementationOnce(async (descriptor, value) => {
      if (descriptor.stateKey === ATTENTION_STATE_KEY) {
        throw new Error("state persistence unavailable");
      }
      return originalSet(descriptor, value);
    });

    await expect(harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: initial.now?.taskId,
      interactionId: initial.now?.interactionId,
    })).rejects.toThrow("state persistence unavailable");

    const restored = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(restored.now?.taskId).toBe("issue:issue-1");

    const failedHealth = await harness.getData<{ faultedCompanies: number }>("health", {});
    expect(failedHealth.faultedCompanies).toBe(1);

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: restored.now?.taskId,
      interactionId: restored.now?.interactionId,
    });

    const recoveredHealth = await harness.getData<{ faultedCompanies: number }>("health", {});
    expect(recoveredHealth.faultedCompanies).toBe(0);
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
      taskId: snapshot.now?.taskId,
      issueId: "issue-1",
      body: "Board can cover outreach directly this week while tooling is sorted out.",
    });

    const comments = await harness.ctx.issues.listComments("issue-1", "company-live");
    expect(comments).toHaveLength(2);
    expect(comments.at(-1)?.body).toContain("Board can cover outreach directly");
    expect(harness.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "issue_comment_submitted",
        dimensions: expect.objectContaining({
          surface: "focus",
          entityType: "issue",
        }),
      }),
    ]));
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Posted an issue comment from Focus.",
        entityType: "issue",
        entityId: "issue-1",
        metadata: expect.objectContaining({
          source: "focus",
          taskId: "issue:issue-1",
        }),
      }),
    ]));

    const updated = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(updated.now?.taskId).toBe("issue:issue-1");
    expect(updated.now?.context?.items?.find((item) => item.id === "latest-comment")?.value).toContain("Board can cover outreach directly");
  });

  it("retries telemetry writes before giving up", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    const trackSpy = vi.spyOn(harness.ctx.telemetry, "track")
      .mockRejectedValueOnce(new Error("telemetry unavailable"));

    await harness.performAction("acknowledge-frame", {
      companyId: "company-live",
      taskId: snapshot.now?.taskId,
      interactionId: snapshot.now?.interactionId,
    });

    expect(trackSpy).toHaveBeenCalledTimes(2);
    expect(harness.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventName: "frame_acknowledged",
      }),
    ]));
  });

  it("retries activity writes before giving up", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    const activitySpy = vi.spyOn(harness.ctx.activity, "log")
      .mockRejectedValueOnce(new Error("activity unavailable"));

    await harness.performAction("comment-on-issue", {
      companyId: "company-live",
      taskId: snapshot.now?.taskId,
      issueId: "issue-1",
      body: "Board can cover outreach directly this week while tooling is sorted out.",
    });

    expect(activitySpy).toHaveBeenCalledTimes(2);
    expect(harness.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Posted an issue comment from Focus.",
      }),
    ]));
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
    expect(snapshot.now?.summary).toBe("Blocked on CEO action before work can continue.");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "needs-action-from")?.value).toBe("CEO");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "recommended-move")?.value).toContain("Board should either");
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
    expect(snapshot.now?.summary).toBe("Blocked on Founding Engineer action before work can continue.");
    expect(snapshot.now?.context?.items?.find((item) => item.id === "needs-action-from")?.value).toBe("Founding Engineer");
    expect(snapshot.now?.provenance?.whyNow).toBe("This issue is blocked on action from Founding Engineer.");
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
      ...(initial.now ? [initial.now.taskId] : []),
      ...initial.next.map((frame) => frame.taskId),
      ...initial.ambient.map((frame) => frame.taskId),
    ];

    expect(initial.review?.unread.total).toBeGreaterThan(0);

    await harness.performAction("mark-attention-seen", {
      companyId: "company-live",
      taskIds,
    });

    const seen = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-live" });
    expect(seen.now?.taskId).toBe(initial.now?.taskId);
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
    expect(beforeResponse.traces.length).toBeGreaterThan(0);
    expect(beforeResponse.reconciledSnapshot.now?.title).toBe("Approve launch cutover");
    expect(beforeResponse.displaySnapshot.now?.title).toBe("Approve launch cutover");

    await harness.performAction("acknowledge-frame", {
      companyId: "company-export",
      taskId: beforeResponse.reconciledSnapshot.now?.taskId,
      interactionId: beforeResponse.reconciledSnapshot.now?.interactionId,
    });

    const afterResponse = await harness.getData<AttentionExport>("attention-export", { companyId: "company-export" });
    expect(afterResponse.ledger).toHaveLength(2);
    expect(afterResponse.eventEntries).toHaveLength(1);
    expect(afterResponse.responseEntries).toHaveLength(1);
    expect(afterResponse.traces.length).toBeGreaterThanOrEqual(beforeResponse.traces.length);
    expect(afterResponse.snapshot.now).toBeNull();
    expect(afterResponse.displaySnapshot.now).toBeNull();
  });

  it("exposes recent core traces for debugging exports", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "approval.created",
      {
        type: "approve_ceo_strategy",
        title: "Approve launch cutover",
        summary: "Launch cutover is waiting on a human decision.",
      },
      { companyId: "company-traces", entityId: "approval-trace-1", entityType: "approval" },
    );

    const traces = await harness.getData<unknown[]>("attention-traces", { companyId: "company-traces" });
    expect(Array.isArray(traces)).toBe(true);
    expect(traces.length).toBeGreaterThan(0);
  });

  it("bounds export and replay windows while exposing totals", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    for (let index = 1; index <= 5; index += 1) {
      await harness.emit(
        "approval.created",
        {
          type: "approve_ceo_strategy",
          title: `Approve launch cutover ${index}`,
          summary: `Launch cutover ${index} is waiting on a human decision.`,
        },
        { companyId: "company-windowed-export", entityId: `approval-window-${index}`, entityType: "approval" },
      );
    }

    const exported = await harness.getData<AttentionExport>("attention-export", {
      companyId: "company-windowed-export",
      limit: 3,
      traceLimit: 2,
    });
    expect(exported.ledger).toHaveLength(3);
    expect(exported.window).toEqual(expect.objectContaining({
      entryLimit: 3,
      traceLimit: 2,
      totalLedgerEntries: 5,
      returnedLedgerEntries: 3,
      returnedTraces: 2,
      hasMoreBefore: true,
    }));
    expect(exported.ledger[0]?.source.entityId).toBe("approval-window-3");
    expect(exported.ledger[2]?.source.entityId).toBe("approval-window-5");

    const replay = await harness.getData<AttentionReplayScenario>("attention-replay-scenario", {
      companyId: "company-windowed-export",
      limit: 2,
    });
    expect(replay.steps).toHaveLength(2);
    expect(replay.window).toEqual(expect.objectContaining({
      entryLimit: 2,
      totalLedgerEntries: 5,
      returnedSteps: 2,
      hasMoreBefore: true,
    }));
  });

  it("reacts to issue document activity events for refresh invalidation", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await harness.emit(
      "activity.logged",
      {
        action: "issue.document_created",
        entityType: "issue",
        entityId: "issue-1",
      },
      { companyId: "company-activity", entityId: "issue-1", entityType: "issue" },
    );

    expect(harness.logs).toContainEqual({
      level: "info",
      message: "Triggered Focus refresh from activity log event",
      meta: {
        companyId: "company-activity",
        action: "issue.document_created",
        entityId: "issue-1",
        entityType: "issue",
      },
    });
  });

  it("builds the final display snapshot in the worker by merging pending approvals", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    mockApprovalApi(harness, [createApprovalRecord({ companyId: "company-display" })]);

    const display = await harness.getData<{ snapshot: AttentionSnapshot }>("attention-display", {
      companyId: "company-display",
    });

    expect(display.snapshot.now?.taskId).toBe("approval:approval-1");
    expect(display.snapshot.now?.title).toBe("Approve launch cutover");
  });

  it("reuses cached display reconciliation until an invalidating activity event arrives", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    mockApprovalApi(harness, []);
    harness.seed({
      issues: [createIssue()],
      issueComments: [createIssueComment()],
    });

    const originalListIssues = harness.ctx.issues.list.bind(harness.ctx.issues);
    const originalListComments = harness.ctx.issues.listComments.bind(harness.ctx.issues);
    const originalListDocuments = harness.ctx.issues.documents.list.bind(harness.ctx.issues.documents);

    const listIssues = vi.fn(originalListIssues);
    const listComments = vi.fn(originalListComments);
    const listDocuments = vi.fn(originalListDocuments);

    harness.ctx.issues.list = listIssues;
    harness.ctx.issues.listComments = listComments;
    harness.ctx.issues.documents.list = listDocuments;

    await harness.getData("attention-display", { companyId: "company-live" });
    const issueCallsAfterFirstRead = listIssues.mock.calls.length;
    const commentCallsAfterFirstRead = listComments.mock.calls.length;
    const documentCallsAfterFirstRead = listDocuments.mock.calls.length;
    const approvalCallsAfterFirstRead = (harness.ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    await harness.getData("attention-display", { companyId: "company-live" });

    expect(listIssues.mock.calls.length).toBe(issueCallsAfterFirstRead);
    expect(listComments.mock.calls.length).toBe(commentCallsAfterFirstRead);
    expect(listDocuments.mock.calls.length).toBe(documentCallsAfterFirstRead);
    expect((harness.ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(approvalCallsAfterFirstRead);

    await harness.emit(
      "activity.logged",
      {
        action: "issue.document_created",
        entityType: "issue",
        entityId: "issue-1",
      },
      { companyId: "company-live", entityId: "issue-1", entityType: "issue" },
    );

    await harness.getData("attention-display", { companyId: "company-live" });

    expect(listIssues.mock.calls.length).toBeGreaterThan(issueCallsAfterFirstRead);
    expect(listComments.mock.calls.length).toBe(commentCallsAfterFirstRead);
    expect(listDocuments.mock.calls.length).toBeGreaterThan(documentCallsAfterFirstRead);
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
    expect(beforeResponse.expectations?.finalNowInteractionId).toBeTruthy();

    const snapshot = await harness.getData<AttentionSnapshot>("attention-summary", { companyId: "company-replay-export" });
    await harness.performAction("acknowledge-frame", {
      companyId: "company-replay-export",
      taskId: snapshot.now?.taskId,
      interactionId: snapshot.now?.interactionId,
    });

    const afterResponse = await harness.getData<AttentionReplayScenario>("attention-replay-scenario", {
      companyId: "company-replay-export",
    });
    expect(afterResponse.steps).toHaveLength(2);
    expect(afterResponse.steps[0]?.kind).toBe("publish");
    expect(afterResponse.steps[1]?.kind).toBe("submit");
    expect(afterResponse.expectations?.finalNowInteractionId).toBeNull();
    expect(afterResponse.expectations?.resultLaneCounts?.now).toBe(0);
  });

});
