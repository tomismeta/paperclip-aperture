import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { readFocusMetadata } from "../aperture/contracts.js";
import { mapDecisionToResponse } from "../aperture/response-mapper.js";
import { parseTaskId, taskIdMatchesKind, taskKind } from "../aperture/task-ref.js";
import { createEmptyReviewState, createEmptySnapshot, type AttentionLedgerResponseEntry, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "../aperture/types.js";
import { submitApprovalDecision } from "../host/paperclip-approvals.js";
import {
  emitAttentionUpdate,
  loadPersistedAttentionState,
  logFocusActivity,
  requireCompanyId,
  requireStringParam,
  runAttentionMutation,
  trackFocusTelemetry,
} from "./shared.js";

async function loadReviewState(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  companyId: string,
): Promise<AttentionReviewState> {
  const liveReview = store.getReview(companyId);
  if (liveReview) return liveReview;

  const persisted = await loadPersistedAttentionState(ctx, companyId);
  if (persisted?.review) return persisted.review;

  return createEmptyReviewState(companyId);
}

function buildSeenReviewState(
  review: AttentionReviewState,
  companyId: string,
  taskIds: string[],
  suppress = false,
): AttentionReviewState {
  const now = new Date().toISOString();
  const nextReview: AttentionReviewState = {
    ...review,
    updatedAt: now,
    lastSeenAt: now,
    frames: { ...review.frames },
  };

  for (const taskId of taskIds) {
    const current = nextReview.frames[taskId] ?? {};
    nextReview.frames[taskId] = {
      ...current,
      lastSeenAt: now,
      ...(suppress ? { suppressedAt: now } : {}),
    };
  }

  return nextReview;
}

function snapshotContainsTask(snapshot: AttentionSnapshot | null, taskId: string): boolean {
  if (!snapshot) return false;
  const frames: StoredAttentionFrame[] = [
    ...(snapshot.now ? [snapshot.now] : []),
    ...snapshot.next,
    ...snapshot.ambient,
  ];
  return frames.some((frame) => frame.taskId === taskId);
}

function entityTypeFromTaskId(taskId: string): string {
  return taskKind(taskId) ?? "unknown";
}

function laneForTask(snapshot: AttentionSnapshot | null, taskId: string): "now" | "next" | "ambient" | "ui_only" {
  if (!snapshot) return "ui_only";
  if (snapshot.now?.taskId === taskId) return "now";
  if (snapshot.next.some((frame) => frame.taskId === taskId)) return "next";
  if (snapshot.ambient.some((frame) => frame.taskId === taskId)) return "ambient";
  return "ui_only";
}

function focusDimensions(
  snapshot: AttentionSnapshot | null,
  taskId: string,
): Record<string, string | number | boolean> {
  const lane = laneForTask(snapshot, taskId);
  const entityType = entityTypeFromTaskId(taskId);
  const frame = lane === "ui_only"
    ? null
    : lane === "now"
      ? snapshot?.now ?? null
      : lane === "next"
        ? snapshot?.next.find((candidate) => candidate.taskId === taskId) ?? null
        : snapshot?.ambient.find((candidate) => candidate.taskId === taskId) ?? null;

  const dimensions: Record<string, string | number | boolean> = {
    entityType,
    lane,
  };

  if (frame?.mode) dimensions.mode = frame.mode;
  if (frame?.source?.kind) dimensions.sourceKind = frame.source.kind;
  if (frame) {
    const metadata = readFocusMetadata(frame);
    if (typeof metadata.liveReconciled === "boolean") dimensions.liveReconciled = metadata.liveReconciled;
  }

  return dimensions;
}

function approvalIdFromTaskId(taskId: string): string | null {
  const taskRef = parseTaskId(taskId);
  return taskRef?.kind === "approval" ? taskRef.id : null;
}

export function registerActionHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.actions.register("engage-focus", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const durationMs = typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
      ? Math.max(25, Math.floor(params.durationMs))
      : undefined;
    const reason = typeof params.reason === "string" && params.reason.trim().length > 0
      ? params.reason.trim()
      : "operator_interaction";

    const currentSnapshot = store.getSnapshot(companyId);
    const { snapshot, changed } = store.engage(companyId, taskId, interactionId, { durationMs });

    if (changed) {
      emitAttentionUpdate(ctx, {
        companyId,
        reason: "action",
        eventType: "plugin.local.engage",
        updatedAt: snapshot.updatedAt,
        counts: snapshot.counts,
      });
    }

    await trackFocusTelemetry(ctx, "focus_engaged", {
      ...focusDimensions(currentSnapshot, taskId),
      actionKind: "engage",
      reason,
      ...(durationMs ? { durationMs } : {}),
    });

    return { ok: true, snapshot, changed };
  });

  ctx.actions.register("acknowledge-frame", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const response = mapDecisionToResponse({ taskId, interactionId, action: "acknowledge" });
    const ledgerEntry: AttentionLedgerResponseEntry = {
      kind: "response",
      id: `${taskId}:acknowledge:${Date.now()}`,
      occurredAt: new Date().toISOString(),
      source: {
        eventType: "plugin.local.acknowledge",
        entityId: taskId,
      },
      apertureResponse: response,
    };
    const currentSnapshot = store.getSnapshot(companyId);
    const currentReview = await loadReviewState(ctx, store, companyId);
    const review = buildSeenReviewState(currentReview, companyId, [taskId], true);
    const { snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
      const { ledger, snapshot } = store.applyResponse(companyId, ledgerEntry);
      return { ledger, snapshot, review };
    });
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.acknowledge",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "frame_acknowledged", {
      ...focusDimensions(currentSnapshot, taskId),
    });
    return { ok: true, snapshot };
  });

  ctx.actions.register("comment-on-issue", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const issueId = requireStringParam(params, "issueId");
    const body = requireStringParam(params, "body").trim();

    const taskRef = parseTaskId(taskId);
    if (!taskRef || taskRef.kind !== "issue") {
      throw new Error("Comments can only be posted on issue-backed frames.");
    }
    if (taskRef.id !== issueId) {
      throw new Error("Issue comment target does not match the selected frame.");
    }

    const comment = await ctx.issues.createComment(issueId, body, companyId);
    const currentSnapshot = store.getSnapshot(companyId);
    const currentReview = await loadReviewState(ctx, store, companyId);
    const review = buildSeenReviewState(currentReview, companyId, [taskId], false);
    const { snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
      store.setReview(companyId, review);
      return {
        ledger: store.getLedger(companyId),
        snapshot: store.getSnapshot(companyId) ?? createEmptySnapshot(companyId),
        review,
      };
    });
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.comment",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "issue_comment_submitted", {
      ...focusDimensions(currentSnapshot, taskId),
      actionKind: "comment",
    });
    await logFocusActivity(ctx, {
      companyId,
      message: "Posted an issue comment from Focus.",
      entityType: "issue",
      entityId: issueId,
      metadata: {
        source: "focus",
        taskId,
      },
    });
    return { ok: true, comment, review };
  });

  ctx.actions.register("record-approval-response", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const decision = requireStringParam(params, "decision");

    if (!taskIdMatchesKind(taskId, "approval")) {
      throw new Error("Approval responses can only be recorded for approval-backed frames.");
    }
    if (!["approve", "reject", "request-revision"].includes(decision)) {
      throw new Error("decision must be approve, reject, or request-revision.");
    }

    const response = mapDecisionToResponse({
      taskId,
      interactionId,
      action: decision as "approve" | "reject" | "request-revision",
    });
    const ledgerEntry: AttentionLedgerResponseEntry = {
      kind: "response",
      id: `${taskId}:${decision}:${Date.now()}`,
      occurredAt: new Date().toISOString(),
      source: {
        eventType: `plugin.local.approval.${decision}`,
        entityId: taskId,
      },
      apertureResponse: response,
    };
    const approvalId = approvalIdFromTaskId(taskId);
    if (!approvalId) {
      throw new Error("Approval responses require a durable approval id.");
    }

    const config = await ctx.config.get();
    await submitApprovalDecision(ctx, approvalId, decision as "approve" | "reject" | "request-revision", config);
    store.invalidateApprovals(companyId);

    const currentReview = await loadReviewState(ctx, store, companyId);
    const review = buildSeenReviewState(currentReview, companyId, [taskId], true);
    const currentSnapshot = store.getSnapshot(companyId);
    const shouldIngest = snapshotContainsTask(currentSnapshot, taskId);

    const { snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
      if (shouldIngest) {
        const { ledger, snapshot } = store.applyResponse(companyId, ledgerEntry);
        return { ledger, snapshot, review };
      }

      return {
        ledger: store.getLedger(companyId),
        snapshot: currentSnapshot ?? createEmptySnapshot(companyId),
        review,
      };
    });
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: `plugin.local.approval.${decision}`,
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "approval_response_recorded", {
      ...focusDimensions(currentSnapshot, taskId),
      decision: decision === "request-revision" ? "request_revision" : decision,
    });
    await logFocusActivity(ctx, {
      companyId,
      message:
        decision === "approve"
          ? "Approved a Focus approval."
          : decision === "reject"
            ? "Rejected a Focus approval."
            : "Requested revision on a Focus approval.",
      entityType: "approval",
      entityId: approvalId,
      metadata: {
        source: "focus",
        decision,
        taskId,
      },
    });
    return { ok: true, snapshot, review };
  });

  ctx.actions.register("mark-attention-seen", async (params) => {
    const companyId = requireCompanyId(params);
    const taskIds = Array.isArray(params.taskIds)
      ? params.taskIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (taskIds.length === 0) {
      throw new Error("taskIds must include at least one frame task id.");
    }
    const currentReview = await loadReviewState(ctx, store, companyId);
    const review = buildSeenReviewState(currentReview, companyId, taskIds);
    const { snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
      store.setReview(companyId, review);
      return {
        ledger: store.getLedger(companyId),
        snapshot: store.getSnapshot(companyId) ?? createEmptySnapshot(companyId),
        review,
      };
    });
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.seen",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "attention_seen_marked", {
      frameCount: taskIds.length,
    });
    return { ok: true, review, snapshot };
  });
}
