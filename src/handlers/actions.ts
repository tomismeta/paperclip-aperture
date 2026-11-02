import type { IssueComment, PluginContext } from "@paperclipai/plugin-sdk";
import type { AttentionSignal } from "@tomismeta/aperture-core";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import type { DisplayEngagement } from "../aperture/frame-model.js";
import { readFocusMetadata, readPaperclipRunMetadata } from "../aperture/contracts.js";
import { isInlineConfirmation } from "../aperture/interaction-frames.js";
import { mapDecisionToResponse } from "../aperture/response-mapper.js";
import { createInteractionId, parseTaskId, taskIdMatchesKind, taskKind } from "../aperture/task-ref.js";
import { createEmptyReviewState, createEmptySnapshot, type AttentionLedgerOverlayResponseEntry, type AttentionLedgerResponseEntry, type AttentionLedgerSignalEntry, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "../aperture/types.js";
import {
  emitAttentionUpdate,
  logFocusActivity,
  requireCompanyId,
  requireHumanActionScope,
  requireStringParam,
  runAttentionMutation,
  trackFocusTelemetry,
} from "./shared.js";
import { loadDisplaySnapshot, loadWorkerApprovals } from "./data.js";


function buildSeenReviewState(
  review: AttentionReviewState,
  companyId: string,
  taskIds: string[],
  suppress = false,
  now = new Date().toISOString(),
  suppressedInteractionId?: string,
): AttentionReviewState {
  const nextReview: AttentionReviewState = {
    ...review,
    updatedAt: now,
    lastSeenAt: now,
    frames: { ...review.frames },
  };

  for (const taskId of taskIds) {
    const current = nextReview.frames[taskId] ?? {};
    const applySuppression = suppress && (!current.suppressedAt || now.localeCompare(current.suppressedAt) >= 0);
    const next = {
      ...current,
      lastSeenAt: now,
      ...(applySuppression ? { suppressedAt: now } : {}),
    };
    if (applySuppression) {
      if (suppressedInteractionId === undefined) delete next.suppressedInteractionId;
      else next.suppressedInteractionId = suppressedInteractionId;
    }
    nextReview.frames[taskId] = next;
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

function createSignalLedgerEntry(input: {
  taskId: string;
  interactionId: string;
  occurredAt?: string;
  sourceEventType: string;
  sourceEntityId?: string;
  signal: {
    kind: AttentionSignal["kind"];
    surface?: string;
    section?: string;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
  };
}): AttentionLedgerSignalEntry {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    kind: "signal",
    id: `${input.taskId}:${input.signal.kind}:${occurredAt}`,
    occurredAt,
    source: {
      eventType: input.sourceEventType,
      entityId: input.sourceEntityId ?? input.taskId,
      entityType: entityTypeFromTaskId(input.taskId),
    },
    apertureSignal: {
      ...input.signal,
      taskId: input.taskId,
      interactionId: input.interactionId,
      timestamp: occurredAt,
    } as AttentionSignal,
  };
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

function isApprovalDecisionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const details = error as { status?: unknown; code?: unknown; message?: unknown };
  return details.status === 409
    || details.code === 409
    || details.code === "CONFLICT"
    || (
      typeof details.message === "string"
      && /^Only pending or revision requested approvals can be (approved|rejected)$/.test(details.message)
    );
}

export function registerActionHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.actions.register("set-focus-presence", async (params) => {
    const companyId = requireCompanyId(params);
    const requestedPresence = requireStringParam(params, "presence");
    const presence = requestedPresence === "absent" ? "absent" : "present";
    return {
      ok: true,
      operatorPresence: store.setOperatorPresence(companyId, presence),
    };
  });

  ctx.actions.register("mark-attention-viewed", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const surface = typeof params.surface === "string" && params.surface.trim().length > 0
      ? params.surface.trim()
      : "focus";

    const currentSnapshot = store.getSnapshot(companyId);
    const signalEntry = createSignalLedgerEntry({
      taskId,
      interactionId,
      sourceEventType: "plugin.local.viewed",
      signal: {
        kind: "viewed",
        surface,
      },
    });
    const { snapshot, changed } = await runAttentionMutation(ctx, store, companyId, () => {
      const { ledger, snapshot, changed } = store.applySignal(companyId, signalEntry);
      return { ledger, snapshot, changed };
    });

    if (changed) {
      emitAttentionUpdate(ctx, {
        companyId,
        reason: "action",
        eventType: "plugin.local.viewed",
        updatedAt: snapshot.updatedAt,
        counts: snapshot.counts,
      });
    }

    await trackFocusTelemetry(ctx, "frame_viewed", {
      ...focusDimensions(currentSnapshot, taskId),
      surface,
    });

    return { ok: true, snapshot, changed };
  });

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

    let currentSnapshot = store.getSnapshot(companyId);
    let canEngage: ((engagement: DisplayEngagement) => boolean) | undefined;
    let expiresAt = 0;
    const occurredAt = new Date().toISOString();
    const signalEntries = [
      createSignalLedgerEntry({
        taskId,
        interactionId,
        occurredAt,
        sourceEventType: "plugin.local.engage.viewed",
        signal: {
          kind: "viewed",
          surface: "focus",
        },
      }),
      ...(reason === "show_context" || reason === "comment_compose"
        ? [
            createSignalLedgerEntry({
              taskId,
              interactionId,
              occurredAt,
              sourceEventType: "plugin.local.engage.context_expanded",
              signal: {
                kind: "context_expanded",
                surface: "focus",
                section: reason === "show_context" ? "now_context" : "comment_compose",
              },
            }),
          ]
        : []),
    ];
    const { snapshot, changed } = await runAttentionMutation(ctx, store, companyId, async () => {
      const coreSnapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
      const display = await loadDisplaySnapshot(ctx, store, companyId, coreSnapshot,
        store.getReview(companyId) ?? createEmptyReviewState(companyId));
      const { displaySnapshot } = display;
      if (displaySnapshot.now?.taskId !== taskId || displaySnapshot.now.interactionId !== interactionId) {
        throw new Error("Only the current Focus NOW interaction can be engaged.");
      }
      currentSnapshot = displaySnapshot;
      canEngage = display.canEngage;
      expiresAt = Date.now() + (durationMs ?? 12_000);
      const engaged = store.hasCoreInteraction(companyId, taskId, interactionId)
        ? store.engage(companyId, taskId, interactionId, { durationMs })
        : { snapshot: coreSnapshot, changed: false };
      let ledger = store.getLedger(companyId);
      let latestSnapshot = engaged.snapshot;
      for (const entry of signalEntries) {
        const result = store.applySignal(companyId, entry);
        ledger = result.ledger;
        latestSnapshot = result.snapshot;
      }
      return {
        ledger,
        snapshot: latestSnapshot,
        changed: true,
      };
    }, () => {
      // Recheck the target after persistence; unrelated arrivals must not cancel a valid hold.
      const engagement = { taskId, interactionId, expiresAt };
      if (canEngage?.(engagement)) {
        store.setDisplayEngagement(companyId, engagement);
      }
    });

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
    const task = parseTaskId(taskId);
    if (task?.kind === "approval" || task?.kind === "interaction") {
      throw new Error("Respond to this decision instead of acknowledging it.");
    }
    if (task?.kind === "agent") {
      const agent = await ctx.agents.get(task.id, companyId);
      if (agent && agent.companyId !== companyId) throw new Error("Agent not found in this company.");
      if (agent?.status === "pending_approval") {
        throw new Error("Respond to this agent's approval in Paperclip instead of acknowledging it.");
      }
    }
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
    const { snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
      if (task?.kind === "run") {
        const active = store.getSnapshot(companyId);
        const frames = active ? [...(active.now ? [active.now] : []), ...active.next] : [];
        const failedRun = frames.find((frame) => frame.taskId === taskId
          && frame.interactionId === interactionId
          && readPaperclipRunMetadata(frame)?.status === "failed");
        if (!failedRun) throw new Error("Only a current failed run can be acknowledged.");
      }
      const review = buildSeenReviewState(
        store.getReview(companyId) ?? createEmptyReviewState(companyId),
        companyId, [taskId], true, ledgerEntry.occurredAt, interactionId,
      );
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

  ctx.actions.register("comment-on-issue", async (params, context) => {
    const { companyId, actorUserId } = requireHumanActionScope(params, context);
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

    const currentSnapshot = store.getSnapshot(companyId);
    let postedComment: IssueComment | undefined;
    let syncWarning: string | undefined;
    const { snapshot, review, comment } = await runAttentionMutation(ctx, store, companyId, async () => {
      const comment = await ctx.issues.createComment(issueId, body, companyId, { actorUserId });
      postedComment = comment;
      const review = buildSeenReviewState(store.getReview(companyId) ?? createEmptyReviewState(companyId), companyId, [taskId]);
      store.invalidateHostCache(companyId, {
        keys: [
          `issue:${issueId}:detail`,
          `issue:${issueId}:comments`,
          `issue:${issueId}:interactions`,
        ],
        prefixes: ["issues:all"],
      });
      store.setReview(companyId, review);
      return {
        comment,
        ledger: store.getLedger(companyId),
        snapshot: store.getSnapshot(companyId) ?? createEmptySnapshot(companyId),
        review,
      };
    }).catch((error: unknown) => {
      // The native write cannot be rolled back with Focus state. Only a confirmed
      // host response lets this action report success despite local rollback.
      if (!postedComment) throw error;
      syncWarning = "Your comment was posted in Paperclip, but Focus could not save its local state. Refresh Focus to synchronize; do not repost the comment.";
      ctx.logger.warn("Posted issue comment could not be synchronized to Focus state", {
        companyId,
        issueId,
        commentId: postedComment.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        comment: postedComment,
        ledger: store.getLedger(companyId),
        snapshot: store.getSnapshot(companyId) ?? createEmptySnapshot(companyId),
        review: store.getReview(companyId) ?? createEmptyReviewState(companyId),
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
    return { ok: true, comment, review, ...(syncWarning ? { syncWarning } : {}) };
  });

  ctx.actions.register("record-approval-response", async (params, context) => {
    const { companyId, actorUserId } = requireHumanActionScope(params, context);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const decision = requireStringParam(params, "decision");

    if (!taskIdMatchesKind(taskId, "approval")) {
      throw new Error("Approval responses can only be recorded for approval-backed frames.");
    }
    if (interactionId !== createInteractionId(taskId, "approval")) {
      throw new Error("Approval target does not match the selected frame.");
    }
    if (decision !== "approve" && decision !== "reject") {
      throw new Error("Approval decision must be approve or reject; request revisions in Paperclip.");
    }

    const approvalId = approvalIdFromTaskId(taskId);
    if (!approvalId) {
      throw new Error("Approval responses require a durable approval id.");
    }
    const approval = await ctx.approvals.get(approvalId, companyId);
    if (!approval || approval.companyId !== companyId) {
      throw new Error("Approval not found in this company.");
    }
    if (approval.status === "approved" || approval.status === "rejected") {
      store.retireDisplayCandidates(companyId, { taskId });
    }
    const decisionResult = await ctx.approvals.decide(approvalId, {
      action: decision,
      actorUserId,
    }, companyId).catch(async (error: unknown) => {
      if (!isApprovalDecisionConflict(error)) throw error;
      store.invalidateApprovals(companyId);
      await loadWorkerApprovals(ctx, store, companyId);
      throw new Error("This approval was already decided differently in Paperclip.");
    });
    store.invalidateApprovals(companyId);
    if (decisionResult.approval.status === "approved" || decisionResult.approval.status === "rejected") {
      store.retireDisplayCandidates(companyId, { taskId });
    }
    const expectedStatus = decision === "approve" ? "approved" : "rejected";
    if (decisionResult.approval.status !== expectedStatus) {
      await loadWorkerApprovals(ctx, store, companyId);
      if (decisionResult.approval.status === "approved" || decisionResult.approval.status === "rejected") {
        throw new Error("This approval was already decided differently in Paperclip.");
      }
      throw new Error("Paperclip did not confirm the requested approval decision.");
    }
    if (!decisionResult.applied) return { ok: true, applied: false };

    const response = mapDecisionToResponse({
      taskId,
      interactionId,
      action: decision,
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

    const currentSnapshot = store.getSnapshot(companyId);

    const { snapshot, review } = await runAttentionMutation(ctx, store, companyId, () => {
      const review = buildSeenReviewState(store.getReview(companyId) ?? createEmptyReviewState(companyId), companyId, [taskId], true);
      if (snapshotContainsTask(store.getSnapshot(companyId), taskId)) {
        const { ledger, snapshot } = store.applyResponse(companyId, ledgerEntry);
        return { ledger, snapshot, review };
      }

      const overlayEntry: AttentionLedgerOverlayResponseEntry = {
        kind: "overlay-response",
        id: ledgerEntry.id,
        occurredAt: ledgerEntry.occurredAt,
        source: ledgerEntry.source,
        apertureResponse: ledgerEntry.apertureResponse,
        overlay: {
          kind: "approval_overlay",
          reason: "Approval frame came from the Paperclip approvals display adapter, not the replayed Core snapshot.",
        },
      };
      const { ledger, snapshot } = store.applyOverlayResponse(companyId, overlayEntry);
      return {
        ledger,
        snapshot,
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
      decision,
    });
    await logFocusActivity(ctx, {
      companyId,
      message: decision === "approve" ? "Approved a Focus approval." : "Rejected a Focus approval.",
      entityType: "approval",
      entityId: approvalId,
      metadata: {
        source: "focus",
        decision,
        taskId,
      },
    });
    return { ok: true, applied: true, snapshot, review };
  });

  ctx.actions.register("respond-to-interaction", async (params, context) => {
    const { companyId, actorUserId } = requireHumanActionScope(params, context);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const issueId = requireStringParam(params, "issueId");
    const decision = requireStringParam(params, "decision");
    const task = parseTaskId(taskId);
    if (task?.kind !== "interaction" || interactionId !== createInteractionId(taskId, "decision")) {
      throw new Error("Interaction target does not match the selected frame.");
    }
    if (decision !== "accept" && decision !== "reject") {
      throw new Error("Interaction decision must be accept or reject.");
    }
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue || issue.id !== issueId || issue.companyId !== companyId) {
      throw new Error("Issue not found in this company.");
    }
    if (issue.status === "done" || issue.status === "cancelled" || issue.hiddenAt != null || issue.archivedAt != null) {
      store.retireDisplayCandidates(companyId, { issueId });
    }
    const interactions = await ctx.issues.listInteractions(issueId, companyId);
    const interaction = interactions.find((entry) => entry.id === task.id);
    if (!interaction || interaction.companyId !== companyId || interaction.issueId !== issueId) {
      throw new Error("Interaction not found on this issue in this company.");
    }
    const invalidate = () => store.invalidateHostCache(companyId, {
      keys: [`issue:${issueId}:detail`, `issue:${issueId}:comments`, `issue:${issueId}:interactions`],
      prefixes: ["issues:all"],
    });
    if (["accepted", "rejected", "answered", "cancelled", "expired", "failed"].includes(interaction.status)) {
      store.retireDisplayCandidates(companyId, { taskId });
      invalidate();
      return { ok: true, applied: false };
    }
    if (!isInlineConfirmation(interaction) || interaction.kind !== "request_confirmation") {
      throw new Error("Respond to this decision in Paperclip.");
    }
    if (interaction.addresseeUserId && interaction.addresseeUserId !== actorUserId) {
      throw new Error("This decision is addressed to another operator.");
    }
    if (interaction.effectiveResolverPolicy === "not_creator" && interaction.createdByUserId === actorUserId) {
      throw new Error("This decision must be resolved by someone other than its creator.");
    }
    if (decision === "accept" && interaction.acceptanceBlocker === "workspace_sync_pending") {
      throw new Error("Paperclip is still preparing this approval.");
    }
    const providedReason = typeof params.reason === "string" ? params.reason.trim() : "";
    if (decision === "reject" && interaction.payload.rejectRequiresReason && !providedReason) {
      throw new Error("A reason is required to decline this decision.");
    }
    const reason = decision === "reject"
      && (interaction.payload.rejectRequiresReason || interaction.payload.allowDeclineReason)
      ? providedReason || undefined : undefined;
    const result = await ctx.issues.respondInteraction(issueId, task.id, {
      action: decision, actorUserId, ...(reason ? { reason } : {}),
    }, companyId);
    invalidate();
    if (result.interaction.id !== task.id || result.interaction.issueId !== issueId
      || result.interaction.companyId !== companyId) {
      throw new Error("Paperclip did not confirm the requested interaction decision.");
    }
    if (!result.applied) {
      await ctx.issues.listInteractions(issueId, companyId);
      if (!["accepted", "rejected", "answered", "cancelled", "expired", "failed"].includes(result.interaction.status)) {
        throw new Error("Paperclip did not confirm the requested interaction decision.");
      }
      store.retireDisplayCandidates(companyId, { taskId });
      return { ok: true, applied: false };
    }
    if (result.interaction.status !== (decision === "accept" ? "accepted" : "rejected")) {
      throw new Error("Paperclip did not confirm the requested interaction decision.");
    }
    store.retireDisplayCandidates(companyId, { taskId });
    const occurredAt = new Date().toISOString();
    const entry: AttentionLedgerOverlayResponseEntry = {
      kind: "overlay-response",
      id: `${taskId}:${decision}:${occurredAt}`,
      occurredAt,
      source: { eventType: `plugin.local.interaction.${decision}`, entityType: "interaction", entityId: task.id },
      apertureResponse: mapDecisionToResponse({
        taskId, interactionId, action: decision === "accept" ? "approve" : "reject",
      }),
      overlay: {
        kind: "display_overlay",
        reason: "Native interaction resolved in Paperclip; this display candidate is not a Core input request.",
      },
    };
    const { snapshot, review } = await runAttentionMutation(ctx, store, companyId, () => {
      const review = buildSeenReviewState(store.getReview(companyId) ?? createEmptyReviewState(companyId), companyId, [taskId], true);
      const { ledger, snapshot } = store.applyOverlayResponse(companyId, entry);
      return { ledger, snapshot, review };
    });
    emitAttentionUpdate(ctx, {
      companyId, reason: "action", eventType: `plugin.local.interaction.${decision}`,
      updatedAt: snapshot.updatedAt, counts: snapshot.counts,
    });
    return { ok: true, applied: true, snapshot, review };
  });

  ctx.actions.register("mark-attention-seen", async (params) => {
    const companyId = requireCompanyId(params);
    const taskIds = Array.isArray(params.taskIds)
      ? params.taskIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (taskIds.length === 0) {
      throw new Error("taskIds must include at least one frame task id.");
    }
    const { snapshot, review } = await runAttentionMutation(ctx, store, companyId, () => {
      const review = buildSeenReviewState(store.getReview(companyId) ?? createEmptyReviewState(companyId), companyId, taskIds);
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
