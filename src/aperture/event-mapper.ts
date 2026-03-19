import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { ApertureEvent, SourceRef, TaskStatus } from "@tomismeta/aperture-core";

type ExtendedPluginEventType =
  | PluginEvent["eventType"]
  | "approval.approved"
  | "approval.rejected"
  | "approval.revision_requested"
  | "issue.comment_added";

type MappablePluginEvent = Omit<PluginEvent, "eventType"> & {
  eventType: ExtendedPluginEventType;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArrayLength(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.length : undefined;
}

function readPayloadString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return readString((payload as Record<string, unknown>)[key]);
}

function humanizeToken(value: string): string {
  return value
    .split(/[_\-.]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function humanizeApprovalType(value: string | undefined): string | undefined {
  return value ? humanizeToken(value) : undefined;
}

function makeTaskId(event: MappablePluginEvent): string {
  const entityType = event.entityType ?? "event";
  const entityId = event.entityId ?? event.eventId;
  return `${entityType}:${entityId}`;
}

function makeSource(event: MappablePluginEvent): SourceRef {
  const entityType = event.entityType ?? "event";

  switch (entityType) {
    case "approval":
      return {
        id: `paperclip:${entityType}`,
        kind: "paperclip",
        label: "Paperclip approval",
      };
    case "issue":
      return {
        id: `paperclip:${entityType}`,
        kind: "paperclip",
        label: "Paperclip issue",
      };
    case "run":
      return {
        id: `paperclip:${entityType}`,
        kind: "paperclip",
        label: "Paperclip run",
      };
    case "agent":
      return {
        id: `paperclip:${entityType}`,
        kind: "paperclip",
        label: "Paperclip agent",
      };
    default:
      return {
        id: `paperclip:${event.eventType}`,
        kind: "paperclip",
        label: "Paperclip",
      };
  }
}

function inferIssueStatus(payload: unknown): TaskStatus {
  const raw = readPayloadString(payload, "status")?.toLowerCase();
  const summary = [
    readPayloadString(payload, "summary"),
    readPayloadString(payload, "description"),
    readPayloadString(payload, "bodySnippet"),
    readPayloadString(payload, "title"),
    readPayloadString(payload, "issueTitle"),
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();

  if (raw?.includes("block")) return "blocked";
  if (raw?.includes("wait")) return "waiting";
  if (raw?.includes("done") || raw?.includes("complete") || raw?.includes("closed")) return "completed";
  if (raw?.includes("fail")) return "failed";
  if (summary.includes("blocked") || summary.includes("clarification")) return "blocked";
  if (summary.includes("waiting")) return "waiting";
  return "running";
}

function inferAgentStatus(payload: unknown): TaskStatus {
  const raw = readPayloadString(payload, "status")?.toLowerCase();
  if (!raw) return "running";
  if (raw.includes("approval")) return "blocked";
  if (raw.includes("block")) return "blocked";
  if (raw.includes("wait") || raw.includes("pause")) return "waiting";
  if (raw.includes("fail") || raw.includes("error")) return "failed";
  if (raw.includes("done") || raw.includes("complete")) return "completed";
  return "running";
}

function approvalTitle(event: MappablePluginEvent): string {
  const explicitTitle =
    readPayloadString(event.payload, "title")
    ?? readPayloadString(event.payload, "plan")
    ?? readPayloadString(event.payload, "name");
  if (explicitTitle) return explicitTitle;

  const approvalType = humanizeApprovalType(readPayloadString(event.payload, "type"));
  return approvalType ? `${approvalType} approval` : "Approval requested";
}

function approvalType(event: MappablePluginEvent): string | undefined {
  return readPayloadString(event.payload, "type");
}

function isBudgetOverrideApproval(event: MappablePluginEvent): boolean {
  return approvalType(event) === "budget_override_required";
}

function issueDisplayTitle(event: MappablePluginEvent, fallback: string): string {
  const identifier = readPayloadString(event.payload, "identifier");
  const issueTitle = readPayloadString(event.payload, "issueTitle") ?? readPayloadString(event.payload, "title");

  if (identifier && issueTitle) return `${identifier}  ${issueTitle}`;
  if (identifier) return `${identifier}  ${fallback}`;
  if (issueTitle) return issueTitle;
  return fallback;
}

export function mapPluginEventToAperture(event: MappablePluginEvent): ApertureEvent | null {
  const eventType = event.eventType;
  const taskId = makeTaskId(event);
  const source = makeSource(event);

  switch (eventType) {
    case "approval.created":
      {
        const type = approvalType(event);
        const budgetOverride = isBudgetOverrideApproval(event);
        const requestedAmount = readPayloadString(event.payload, "requestedAmount");
        const reason = readPayloadString(event.payload, "reason");
        const decisionContext = readPayloadString(event.payload, "decisionContext");

      return {
        id: `${event.eventId}:approval`,
        type: "human.input.requested",
        taskId,
        interactionId: `${taskId}:approval`,
        timestamp: event.occurredAt,
        source,
        toolFamily: "paperclip",
        activityClass: "permission_request",
        title: approvalTitle(event),
        summary:
          readPayloadString(event.payload, "summary")
          ?? (budgetOverride
            ? "Budget controls are blocking work until a board decision lands."
            : "A board decision is blocking work in Paperclip."),
        consequence: budgetOverride ? "high" : "medium",
        tone: "focused",
        request: { kind: "approval" },
        context: {
          items: [
            ...(humanizeApprovalType(type)
              ? [{
                  id: "approval-type",
                  label: "Type",
                  value: humanizeApprovalType(type),
                }]
              : []),
            ...(requestedAmount
              ? [{
                  id: "requested-amount",
                  label: "Requested amount",
                  value: requestedAmount,
                }]
              : []),
            ...(reason
              ? [{
                  id: "budget-reason",
                  label: "Reason",
                  value: reason,
                }]
              : []),
            ...(decisionContext
              ? [{
                  id: "decision-context",
                  label: "Decision context",
                  value: decisionContext,
                }]
              : []),
            ...(readStringArrayLength(event.payload, "issueIds")
              ? [{
                  id: "linked-issues",
                  label: "Linked issues",
                  value: String(readStringArrayLength(event.payload, "issueIds")),
                }]
              : []),
          ],
        },
        provenance: {
          whyNow: budgetOverride
            ? "Budget controls are blocking work until a board decision lands."
            : "Paperclip is waiting on a human approval before work can continue.",
          factors: budgetOverride
            ? ["budget stop", "approval", "operator decision"]
            : ["approval", "operator decision"],
        },
      };
      }

    case "approval.decided":
    case "approval.approved":
    case "approval.rejected":
    case "approval.revision_requested":
      return {
        id: `${event.eventId}:resolved`,
        type: "task.completed",
        taskId,
        timestamp: event.occurredAt,
        source,
        summary:
          readPayloadString(event.payload, "status")
          ?? (eventType === "approval.approved"
            ? "Approval approved"
            : eventType === "approval.rejected"
              ? "Approval rejected"
              : eventType === "approval.revision_requested"
                ? "Revision requested"
                : "Approval resolved"),
      };

    case "issue.created":
      return inferIssueStatus(event.payload) === "running"
        ? {
            id: `${event.eventId}:issue-created`,
            type: "task.started",
            taskId,
            timestamp: event.occurredAt,
            source,
            title: issueDisplayTitle(event, "Issue created"),
            summary: readPayloadString(event.payload, "description") ?? "A new issue entered Paperclip.",
          }
        : {
            id: `${event.eventId}:issue-created-status`,
            type: "task.updated",
            taskId,
            timestamp: event.occurredAt,
            source,
            title: issueDisplayTitle(event, "Issue created"),
            summary: readPayloadString(event.payload, "description") ?? "A new issue entered Paperclip.",
            activityClass: "status_update",
            status: inferIssueStatus(event.payload),
          };

    case "issue.updated":
      return {
        id: `${event.eventId}:issue-updated`,
        type: "task.updated",
        taskId,
        timestamp: event.occurredAt,
        source,
        title: issueDisplayTitle(event, "Issue updated"),
        summary: readPayloadString(event.payload, "summary") ?? readPayloadString(event.payload, "description"),
        activityClass: "status_update",
        status: inferIssueStatus(event.payload),
      };

    case "issue.comment.created":
    case "issue.comment_added":
      return {
        id: `${event.eventId}:issue-comment`,
        type: "task.updated",
        taskId,
        timestamp: event.occurredAt,
        source,
        title: issueDisplayTitle(event, "Issue comment"),
        summary:
          readPayloadString(event.payload, "bodySnippet")
          ?? "A comment added new context in Paperclip.",
        activityClass: "follow_up",
        status: inferIssueStatus(event.payload),
        progress: undefined,
      };

    case "agent.run.started":
      return {
        id: `${event.eventId}:run-started`,
        type: "task.started",
        taskId,
        timestamp: event.occurredAt,
        source,
        title: readPayloadString(event.payload, "title") ?? "Agent run started",
        summary: readPayloadString(event.payload, "summary") ?? "A Paperclip agent began a new run.",
      };

    case "agent.run.failed":
      return {
        id: `${event.eventId}:run-failed`,
        type: "human.input.requested",
        taskId,
        interactionId: `${taskId}:run-failed`,
        timestamp: event.occurredAt,
        source,
        toolFamily: "paperclip",
        activityClass: "tool_failure",
        title: readPayloadString(event.payload, "title") ?? "Agent run failed",
        summary: readPayloadString(event.payload, "summary") ?? "An agent run failed and may need operator attention.",
        consequence: "high",
        tone: "critical",
        request: { kind: "approval" },
        provenance: {
          whyNow: "A Paperclip-managed run failed and is now competing for operator attention.",
          factors: ["run failed", "operator review"],
        },
      };

    case "agent.run.finished":
      return {
        id: `${event.eventId}:run-finished`,
        type: "task.completed",
        taskId,
        timestamp: event.occurredAt,
        source,
        summary: readPayloadString(event.payload, "summary") ?? "Agent run finished",
      };

    case "agent.run.cancelled":
      return {
        id: `${event.eventId}:run-cancelled`,
        type: "task.cancelled",
        taskId,
        timestamp: event.occurredAt,
        source,
        reason: readPayloadString(event.payload, "summary") ?? "Agent run cancelled",
      };

    case "agent.status_changed": {
      const status = readPayloadString(event.payload, "status")?.toLowerCase();
      if (status === "pending_approval") {
        return {
          id: `${event.eventId}:status-pending-approval`,
          type: "human.input.requested",
          taskId,
          interactionId: `${taskId}:pending-approval`,
          timestamp: event.occurredAt,
          source,
          toolFamily: "paperclip",
          activityClass: "permission_request",
          title: "Agent waiting for approval",
          summary: "A Paperclip-managed agent cannot continue until a pending approval is resolved.",
          consequence: "medium",
          tone: "focused",
          request: { kind: "approval" },
          provenance: {
            whyNow: "The agent is paused behind a Paperclip approval gate.",
            factors: ["pending approval"],
          },
        };
      }

      return {
        id: `${event.eventId}:status-updated`,
        type: "task.updated",
        taskId,
        timestamp: event.occurredAt,
        source,
        title: "Agent status changed",
        summary: status ? `Agent status is now ${status}.` : "Agent status changed.",
        activityClass: "session_status",
        status: inferAgentStatus(event.payload),
      };
    }

    default:
      return null;
  }
}
