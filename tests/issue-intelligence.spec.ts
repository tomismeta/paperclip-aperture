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

function createIssueDocumentSummary(
  overrides: Partial<IssueDocumentSummary> = {},
): IssueDocumentSummary {
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

describe("issue-intelligence", () => {
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
});
