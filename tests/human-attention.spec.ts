import type { Issue, IssueThreadInteraction } from "@paperclipai/plugin-sdk/types";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import { withFocusDecisionMetadata } from "../src/aperture/contracts.js";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { applyDisplayEngagement, needsHumanAction, rankForViewer } from "../src/aperture/frame-model.js";
import { isAssignedUserWork, loadReconciledCandidates, waitsOnlyOnAgents } from "../src/aperture/reconciliation.js";
import {
  createEmptyLedger, createEmptyReviewState, createEmptySnapshot,
  type AttentionDisplayPayload, type AttentionSnapshot, type StoredAttentionFrame,
} from "../src/aperture/types.js";
import { registerActionHandlers } from "../src/handlers/actions.js";
import { registerDataHandlers } from "../src/handlers/data.js";

const companyId = "company-human";
const timestamp = "2026-10-22T10:00:00.000Z";
const viewer = "user-viewer";

type Blocker = NonNullable<Issue["blockedBy"]>[number];

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id, companyId, projectId: null, projectWorkspaceId: null, goalId: null, parentId: null,
    title: `Work ${id}`, description: null, status: "in_progress", workMode: "standard",
    reviewPolicy: null, priority: "medium", assigneeAgentId: "agent-1", assigneeUserId: null,
    checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    createdByAgentId: null, createdByUserId: null, responsibleUserId: null,
    issueNumber: 1, identifier: null, requestDepth: 0, billingCode: null,
    assigneeAdapterOverrides: null, executionWorkspaceId: null, executionWorkspacePreference: null,
    executionWorkspaceSettings: null, startedAt: null, completedAt: null, cancelledAt: null,
    hiddenAt: null, createdAt: new Date(timestamp), updatedAt: new Date(timestamp), ...overrides,
  };
}

function blocker(id: string, overrides: Partial<Blocker> = {}): Blocker {
  return {
    id, identifier: id.toUpperCase(), title: `Blocker ${id}`, status: "in_progress", priority: "medium",
    assigneeAgentId: "agent-1", assigneeUserId: null, ...overrides,
  };
}

function relations(blockedBy: Blocker[]) {
  return { blockedBy, blocks: [] };
}

function confirmation(id: string, issueId: string, overrides: { addresseeUserId?: string; updatedAt?: string } = {}): IssueThreadInteraction {
  return {
    id, issueId, companyId, kind: "request_confirmation", status: "pending",
    payload: { version: 1, prompt: `Confirm ${id}?` }, continuationPolicy: "none",
    resolverPolicy: "anyone", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

function frame(taskId: string, overrides: Partial<StoredAttentionFrame> = {}): StoredAttentionFrame {
  return {
    id: `${taskId}:frame`, taskId, interactionId: `${taskId}:interaction`,
    source: { id: "paperclip:test", kind: "paperclip", label: "Paperclip test" },
    version: 1, mode: "status", tone: "focused", consequence: "medium",
    title: taskId, summary: `${taskId} summary`,
    timing: { createdAt: timestamp, updatedAt: timestamp },
    metadata: {}, ...overrides,
  };
}

function statusIssue(id: string, metadata: Record<string, unknown> = {}): StoredAttentionFrame {
  return frame(`issue:${id}`, { metadata: { entityType: "issue", ...metadata } });
}

function choice(id: string, decision: Record<string, unknown> = {}): StoredAttentionFrame {
  return frame(`interaction:${id}`, {
    mode: "choice",
    metadata: {
      entityType: "interaction",
      interactionDecision: {
        inline: true, acceptLabel: "Confirm", rejectLabel: "Decline", rejectRequiresReason: false,
        allowDeclineReason: false, rejectReasonLabel: "Reason", preparing: false, ...decision,
      },
    },
  });
}

function promoted(value: StoredAttentionFrame): StoredAttentionFrame {
  return withFocusDecisionMetadata(value, {
    owner: "display_merge", lane: "now", sourcePolicy: "mergeStoredFrames.promoteNextWhenNowEmpty", promotedFromLane: "next",
  });
}

function snapshot(now: StoredAttentionFrame | null, next: StoredAttentionFrame[]): AttentionSnapshot {
  return {
    ...createEmptySnapshot(companyId),
    updatedAt: timestamp,
    now,
    next,
    counts: { now: now ? 1 : 0, next: next.length, ambient: 0, total: (now ? 1 : 0) + next.length },
  };
}

function setup() {
  const harness = createTestHarness({ manifest, config: {} });
  const store = new ApertureCompanyStore();
  store.hydrate(companyId, {
    ledger: createEmptyLedger(), snapshot: createEmptySnapshot(companyId), review: createEmptyReviewState(companyId),
  });
  registerDataHandlers(harness.ctx, store);
  registerActionHandlers(harness.ctx, store);
  return {
    ...harness,
    store,
    candidates: () => loadReconciledCandidates(harness.ctx, store, companyId, {}, { freshHostData: true }),
    display: (viewerUserId?: string) => harness.getData<AttentionDisplayPayload>(
      "attention-display", { companyId, ...(viewerUserId ? { viewerUserId } : {}) },
    ),
  };
}

describe("agent-owned blocked issues", () => {
  it("treats a blocked issue as agent-owned only when every open blocker is assigned to an agent", () => {
    const blocked = { status: "blocked" as const, unblockDescriptor: null };
    expect(waitsOnlyOnAgents(blocked, relations([blocker("a"), blocker("b")]))).toBe(true);
    expect(waitsOnlyOnAgents(blocked, relations([blocker("a"), blocker("b", { assigneeAgentId: null, assigneeUserId: "user-1" })]))).toBe(false);
    expect(waitsOnlyOnAgents(blocked, relations([blocker("a"), blocker("b", { assigneeAgentId: null })]))).toBe(false);
    expect(waitsOnlyOnAgents(blocked, relations([blocker("a", { assigneeUserId: "user-1" })]))).toBe(false);
    expect(waitsOnlyOnAgents(blocked, relations([blocker("a"), blocker("b", { status: "done", assigneeAgentId: null, assigneeUserId: "user-1" })]))).toBe(true);
    expect(waitsOnlyOnAgents(blocked, relations([blocker("a", { status: "done" })]))).toBe(false);
    expect(waitsOnlyOnAgents(blocked, relations([]))).toBe(false);
    expect(waitsOnlyOnAgents(blocked, null)).toBe(false);
    expect(waitsOnlyOnAgents({ status: "in_review", unblockDescriptor: null }, relations([blocker("a")]))).toBe(false);
  });

  it("lets the unblock descriptor owner decide over the blocker assignees", () => {
    const humanBlockers = relations([blocker("a", { assigneeAgentId: null, assigneeUserId: "user-1" })]);
    const agentBlockers = relations([blocker("a")]);
    expect(waitsOnlyOnAgents({ status: "blocked", unblockDescriptor: { owner: { agentId: "agent-2" }, action: "Finish" } }, humanBlockers)).toBe(true);
    expect(waitsOnlyOnAgents({ status: "blocked", unblockDescriptor: { owner: { userId: "user-1" }, action: "Decide" } }, agentBlockers)).toBe(false);
    expect(waitsOnlyOnAgents({ status: "blocked", unblockDescriptor: { owner: "board", action: "Approve" } }, agentBlockers)).toBe(false);
  });

  it("moves an agent-owned blocked issue to the ambient lane and keeps human-owned and critical blocks", async () => {
    const harness = setup();
    harness.seed({ issues: [
      issue("agent-owned", { status: "blocked", blockedBy: [blocker("a"), blocker("b", { status: "blocked" })] }),
      issue("human-owned", { status: "blocked", blockedBy: [blocker("c", { assigneeAgentId: null, assigneeUserId: "user-1" })] }),
      issue("critical", { status: "blocked", priority: "critical", blockedBy: [blocker("d")] }),
    ] });
    const candidates = await harness.candidates();
    const byTask = new Map(candidates.map((candidate) => [candidate.frame.taskId, candidate]));

    expect(byTask.get("issue:agent-owned")?.lane).toBe("ambient");
    expect(byTask.get("issue:agent-owned")?.frame.tone).toBe("ambient");
    expect(byTask.get("issue:agent-owned")?.frame.consequence).toBe("low");
    expect(byTask.get("issue:agent-owned")?.frame.provenance?.factors).toContain("waiting on agents");
    expect(byTask.get("issue:human-owned")?.lane).toBe("next");
    expect(byTask.get("issue:human-owned")?.frame.tone).toBe("focused");
    expect(byTask.get("issue:critical")?.lane).toBe("now");
  });

  it("keeps host blocked inbox attention in charge of an agent-owned block", async () => {
    const harness = setup();
    harness.seed({ issues: [issue("inbox", {
      status: "blocked",
      blockedBy: [blocker("a")],
      blockedInboxAttention: {
        kind: "blocked", state: "needs_attention", reason: "pending_board_decision", severity: "medium",
        stoppedSinceAt: timestamp, owner: { type: "board", agentId: null, userId: null, label: "Board" },
        action: { label: "Decide", detail: null }, sourceIssue: null, leafIssue: null, recoveryIssue: null,
        approvalId: null, interactionId: null, sampleIssueIdentifier: null,
        redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
      },
    })] });
    const candidates = await harness.candidates();
    expect(candidates.find((candidate) => candidate.frame.taskId === "issue:inbox")?.lane).toBe("now");
  });
});

describe("issues assigned to a person", () => {
  it("counts only open todo and in-progress work of a user as assigned user work", () => {
    expect(isAssignedUserWork({ status: "todo", assigneeUserId: "user-1" })).toBe(true);
    expect(isAssignedUserWork({ status: "in_progress", assigneeUserId: "user-1" })).toBe(true);
    expect(isAssignedUserWork({ status: "backlog", assigneeUserId: "user-1" })).toBe(false);
    expect(isAssignedUserWork({ status: "todo", assigneeUserId: null })).toBe(false);
  });

  it("surfaces user-assigned work in next with its assignee and leaves agent work alone", async () => {
    const harness = setup();
    harness.seed({ issues: [
      issue("mine", { status: "todo", assigneeAgentId: null, assigneeUserId: viewer }),
      issue("backlog", { status: "backlog", assigneeAgentId: null, assigneeUserId: viewer }),
      issue("agent-work", { status: "in_progress" }),
    ] });
    const candidates = await harness.candidates();

    expect(candidates.map((candidate) => candidate.frame.taskId)).toEqual(["issue:mine"]);
    expect(candidates[0]?.lane).toBe("next");
    expect(candidates[0]?.frame.metadata).toMatchObject({ issueAssigneeUserId: viewer });
    expect(candidates[0]?.frame.provenance?.factors).toEqual(["assigned to a person"]);
  });
});

describe("viewer priority", () => {
  it("decides human action from mode, addressee, resolver policy and issue assignee", () => {
    expect(needsHumanAction(frame("approval:1", { mode: "approval" }), viewer)).toBe(true);
    expect(needsHumanAction(choice("open"), viewer)).toBe(true);
    expect(needsHumanAction(choice("mine", { addresseeUserId: viewer }), viewer)).toBe(true);
    expect(needsHumanAction(choice("other", { addresseeUserId: "user-other" }), viewer)).toBe(false);
    expect(needsHumanAction(choice("other", { addresseeUserId: "user-other" }), null)).toBe(true);
    expect(needsHumanAction(choice("own", { effectiveResolverPolicy: "not_creator", createdByUserId: viewer }), viewer)).toBe(false);
    expect(needsHumanAction(choice("own", { effectiveResolverPolicy: "anyone", createdByUserId: viewer }), viewer)).toBe(true);
    expect(needsHumanAction(statusIssue("mine", { issueAssigneeUserId: viewer }), viewer)).toBe(true);
    expect(needsHumanAction(statusIssue("theirs", { issueAssigneeUserId: "user-other" }), viewer)).toBe(false);
    expect(needsHumanAction(statusIssue("theirs", { issueAssigneeUserId: "user-other" }), null)).toBe(true);
    expect(needsHumanAction(statusIssue("agent", { issueAssigneeAgentId: "agent-1" }), viewer)).toBe(false);
  });

  it("orders next by human action and keeps the order inside each group", () => {
    const ranked = rankForViewer(snapshot(choice("first"), [
      statusIssue("s1"), choice("c1"), statusIssue("s2"), statusIssue("mine", { issueAssigneeUserId: viewer }), choice("other", { addresseeUserId: "user-other" }),
    ]), viewer, null);
    expect(ranked.now?.taskId).toBe("interaction:first");
    expect(ranked.next.map((value) => value.taskId)).toEqual([
      "interaction:c1", "issue:mine", "issue:s1", "issue:s2", "interaction:other",
    ]);
  });

  it("returns the same snapshot when the order already fits", () => {
    const input = snapshot(choice("first"), [choice("c1"), statusIssue("s1")]);
    expect(rankForViewer(input, viewer, null)).toBe(input);
  });

  it("lets a human action take a promoted status focus and puts the status frame first among status frames", () => {
    const ranked = rankForViewer(snapshot(promoted(statusIssue("waiting")), [
      statusIssue("s1"), choice("c1"), choice("c2"),
    ]), viewer, null);
    expect(ranked.now?.taskId).toBe("interaction:c1");
    expect(ranked.now?.metadata).toMatchObject({ decision: { sourcePolicy: "viewerPriority.promoteHumanAction", lane: "now" } });
    expect(ranked.next.map((value) => value.taskId)).toEqual(["interaction:c2", "issue:waiting", "issue:s1"]);
    expect(ranked.next[1]?.metadata).toMatchObject({ decision: { sourcePolicy: "viewerPriority.yieldToHumanAction", lane: "next" } });
    expect(ranked.counts).toEqual({ now: 1, next: 3, ambient: 0, total: 4 });
    expect(ranked.review?.unread).toEqual({ now: 1, next: 3, ambient: 0, total: 4 });
  });

  it("keeps an explicit, critical or human-action focus in place", () => {
    const explicit = withFocusDecisionMetadata(statusIssue("explicit"), { owner: "paperclip_reconciliation", lane: "now" });
    const critical = promoted(statusIssue("critical"));
    critical.tone = "critical";
    const human = promoted(statusIssue("mine", { issueAssigneeUserId: viewer }));
    for (const now of [explicit, critical, human]) {
      expect(rankForViewer(snapshot(now, [choice("c1")]), viewer, null).now?.taskId).toBe(now.taskId);
    }
  });

  it("does not move focus to a decision addressed to another person", () => {
    const ranked = rankForViewer(snapshot(promoted(statusIssue("waiting")), [choice("other", { addresseeUserId: "user-other" })]), viewer, null);
    expect(ranked.now?.taskId).toBe("issue:waiting");
  });

  it("lets an engagement hold take over a viewer-promoted focus", () => {
    const ranked = rankForViewer(snapshot(promoted(statusIssue("waiting")), [statusIssue("held"), choice("c1")]), viewer, null);
    expect(ranked.now?.taskId).toBe("interaction:c1");
    const held = applyDisplayEngagement(ranked, {
      taskId: "issue:held", interactionId: "issue:held:interaction", expiresAt: Date.now() + 60_000,
    }, null);
    expect(held.now?.taskId).toBe("issue:held");
  });
});

describe("Focus display for the viewer", () => {
  it("shows the viewer's decision instead of an agent-owned block", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:01:00.000Z"));
    try {
      const harness = setup();
      harness.seed({
        issues: [
          issue("parent", { status: "blocked", priority: "high", blockedBy: [blocker("child")] }),
          issue("waiting", { status: "in_review", updatedAt: new Date("2026-10-22T10:00:30.000Z") }),
          issue("decision-host"),
        ],
        issueInteractions: [
          confirmation("for-other", "decision-host", { addresseeUserId: "user-other" }),
          confirmation("for-viewer", "decision-host", { addresseeUserId: viewer }),
        ],
      });

      const forViewer = await harness.display(viewer);
      expect(forViewer.snapshot.now?.taskId).toBe("interaction:for-viewer");
      expect(forViewer.snapshot.next.map((value) => value.taskId)).toEqual(["issue:waiting", "interaction:for-other"]);
      expect(forViewer.snapshot.ambient.map((value) => value.taskId)).toEqual(["issue:parent"]);

      const anonymous = await harness.display();
      expect(anonymous.snapshot.now?.taskId).toBe("interaction:for-other");
      expect(anonymous.snapshot.next.map((value) => value.taskId)).toEqual(["interaction:for-viewer", "issue:waiting"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the signed-in actor engage the NOW that the Focus page showed", async () => {
    const harness = setup();
    harness.seed({
      issues: [
        issue("review", { status: "in_review", updatedAt: new Date("2026-10-22T10:00:30.000Z") }),
        issue("decision-host"),
      ],
      issueInteractions: [
        confirmation("for-viewer", "decision-host", { addresseeUserId: viewer }),
        confirmation("for-other", "decision-host", { addresseeUserId: "user-other", updatedAt: "2026-10-22T10:00:10.000Z" }),
      ],
    });
    expect((await harness.display()).snapshot.now?.taskId).toBe("interaction:for-other");
    const now = (await harness.display(viewer)).snapshot.now!;
    expect(now.taskId).toBe("interaction:for-viewer");

    const response = await harness.performAction<{ ok: boolean }>("engage-focus", {
      companyId, taskId: now.taskId, interactionId: now.interactionId, durationMs: 1_000,
    }, { actor: { type: "user", userId: viewer } });
    expect(response.ok).toBe(true);
  });

  it("ranks the summary for the viewer hint", async () => {
    const harness = setup();
    harness.seed({
      issues: [
        issue("review", { status: "in_review", updatedAt: new Date("2026-10-22T10:00:30.000Z") }),
        issue("mine", { status: "todo", assigneeAgentId: null, assigneeUserId: viewer }),
      ],
    });
    const summary = await harness.getData<AttentionSnapshot>("attention-summary", { companyId, viewerUserId: viewer });
    expect(summary.now?.taskId).toBe("issue:mine");
    expect(summary.next.map((value) => value.taskId)).toEqual(["issue:review"]);
  });
});
