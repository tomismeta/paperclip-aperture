import { describe, expect, it } from "vitest";
import type { Issue, PluginIssuesClient } from "@paperclipai/plugin-sdk";
import {
  analyzeIssueDocuments,
  analyzeIssueIntents,
  analyzeIssueTextSemantics,
  issueRelationTarget,
  type LatestComment,
} from "../src/aperture/issue-intelligence.js";

type IssueDocumentSummary = Awaited<ReturnType<PluginIssuesClient["documents"]["list"]>>[number];

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: "issue-1",
    companyId: "company-live",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Blocked rollout follow-up",
    description: "Need clarification from the operator before resuming the rollout.",
    status: "blocked",
    workMode: "standard",
    reviewPolicy: null,
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
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
  };
  return { ...base, ...overrides };
}

function createIssueDocumentSummary(
  overrides: Partial<IssueDocumentSummary> = {},
): IssueDocumentSummary {
  const base: IssueDocumentSummary = {
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
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-03-19T10:00:00.000Z"),
    updatedAt: new Date("2026-03-19T10:15:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("issue-intelligence", () => {
  it.each([
    "FYI @Atlas: the deployment notes are attached.",
    "FYI @ceo: the deployment notes are attached.",
    "Atlas supplied the deployment notes.",
    "Waiting on deployment; FYI @Atlas.",
    "Need clarification\nfrom @Atlas.",
    `Need ${"x".repeat(61)} from @Atlas.`,
    "Needed from @ops-lead; Atlas can observe.",
  ])("does not assign casual mentions or names to an agent: %s", (text) => {
    const analysis = analyzeIssueIntents(createIssue({ description: text }), null, {
      agentNames: ["Atlas", "CEO"],
    });
    expect(analysis.owner).toBe(text.startsWith("Needed from @ops-lead") ? "Ops-lead" : null);
    expect(analysis.ownerKind).toBe(text.startsWith("Needed from @ops-lead") ? "human" : null);
  });

  it.each([
    ["Needed from Founding Engineer: confirm the handoff.", "Founding Engineer", "agent"],
    ["Needed from @Atlas: confirm the handoff.", "Atlas", "agent"],
    ["Waiting on @ops-lead for the budget.", "Ops-lead", "human"],
    ["Need clarification from @Atlas before rollout.", "Atlas", "agent"],
    ["Needed from Jane Doe: confirm the handoff.", "Jane Doe", "human"],
    ["Board should confirm the handoff.", "Board", "human"],
    ["Requires human review.", "Human", "human"],
    ["Operator intervention is required.", "Operator", "human"],
    ["The CEO agent should review.", "CEO", "human"],
  ])("preserves explicit ownership: %s", (text, owner, ownerKind) => {
    expect(analyzeIssueIntents(createIssue({ description: text }), null, {
      agentNames: ["Atlas", "Founding Engineer"],
    })).toMatchObject({ owner, ownerKind });
  });

  it("marks clarification requests as medium-confidence repeats", () => {
    const analysis = analyzeIssueTextSemantics({
      text: "Need clarification from the board before the rollout can continue.",
      identifier: "CAM-9",
      issueTarget: issueRelationTarget("issue-1"),
    });

    expect(analysis.semanticConfidence).toBe("medium");
    expect(analysis.relationHints).toContainEqual({
      kind: "same_issue",
      target: "issue:issue-1",
    });
    expect(analysis.relationHints).toContainEqual({
      kind: "repeats",
      target: "issue:issue-1",
    });
  });

  it("marks explicit confirmation asks as high-confidence superseding steps", () => {
    const analysis = analyzeIssueTextSemantics({
      text: "Please review and confirm the direction before APE-4 starts.",
      identifier: "APE-2",
      issueTarget: issueRelationTarget("issue-2"),
    });

    expect(analysis.blockingTarget).toBe("APE-4");
    expect(analysis.semanticConfidence).toBe("high");
    expect(analysis.relationHints).toContainEqual({
      kind: "supersedes",
      target: "issue:issue-2",
    });
  });

  it("only treats attached documents as resolving an artifact request when they are newer than the comment", () => {
    const issue = createIssue({
      status: "in_review",
      title: "Review pricing experiment memo",
      identifier: "APE-7",
    });
    const comment: LatestComment = {
      body: "I don't actually see the actual memo. Can you share it with the board?",
      updatedAt: "2026-03-19T10:05:00.000Z",
    };
    const analysis = analyzeIssueIntents(issue, comment);

    const newerDocumentSignal = analyzeIssueDocuments(
      [createIssueDocumentSummary({ updatedAt: new Date("2026-03-19T10:15:00.000Z") })],
      comment,
      analysis,
    );
    const olderDocumentSignal = analyzeIssueDocuments(
      [createIssueDocumentSummary({ updatedAt: new Date("2026-03-19T10:01:00.000Z") })],
      comment,
      analysis,
    );

    expect(newerDocumentSignal.resolvesArtifactRequest).toBe(true);
    expect(olderDocumentSignal.resolvesArtifactRequest).toBe(false);
  });

  it("preserves document lock evidence when a locked artifact resolves a review request", () => {
    const issue = createIssue({
      status: "in_review",
      title: "Review pricing experiment memo",
      identifier: "APE-7",
    });
    const comment: LatestComment = {
      body: "Can you share it with the board?",
      updatedAt: "2026-03-19T10:05:00.000Z",
    };
    const analysis = analyzeIssueIntents(issue, comment);

    const signal = analyzeIssueDocuments(
      [
        createIssueDocumentSummary({
          lockedAt: new Date("2026-03-19T10:16:00.000Z"),
          lockedByUserId: "user-1",
        }),
      ],
      comment,
      analysis,
    );

    expect(signal.resolvesArtifactRequest).toBe(true);
    expect(signal.hasLockedDocuments).toBe(true);
    expect(signal.latestDocumentLockedAt).toBe("2026-03-19T10:16:00.000Z");
    expect(signal.latestDocumentLockOwnerKind).toBe("user");
  });
});
