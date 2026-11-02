import type { Issue, RequestConfirmationInteraction } from "@paperclipai/plugin-sdk/types";

export const interactionCompanyId = "native-interactions";

export function interactionIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1", companyId: interactionCompanyId, projectId: null, projectWorkspaceId: null,
    goalId: null, parentId: null, title: "Running work", description: null, status: "in_progress",
    workMode: "standard", reviewPolicy: null, priority: "medium", assigneeAgentId: null,
    assigneeUserId: null, checkoutRunId: null, executionRunId: null, executionAgentNameKey: null,
    executionLockedAt: null, createdByAgentId: null, createdByUserId: null, responsibleUserId: null,
    issueNumber: 1, identifier: "NAT-1", requestDepth: 0, billingCode: null,
    assigneeAdapterOverrides: null, executionWorkspaceId: null, executionWorkspacePreference: null,
    executionWorkspaceSettings: null, startedAt: null, completedAt: null, cancelledAt: null, hiddenAt: null,
    createdAt: new Date("2026-10-01T10:00:00Z"), updatedAt: new Date("2026-10-01T10:01:00Z"),
    ...overrides,
  };
}

export function confirmation(overrides: Partial<RequestConfirmationInteraction> = {}): RequestConfirmationInteraction {
  return {
    id: "decision-1", companyId: interactionCompanyId, issueId: "issue-1",
    kind: "request_confirmation", status: "pending", continuationPolicy: "none",
    payload: { version: 1, prompt: "Proceed with the plan?", allowDeclineReason: true },
    resolverPolicy: "human_only", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdByUserId: "author", createdAt: new Date("2026-10-01T10:00:00Z"),
    updatedAt: new Date("2026-10-01T10:01:00Z"), ...overrides,
  };
}
