import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapDecisionToResponse } from "../aperture/response-mapper.js";
import { createEmptyReviewState, createEmptySnapshot, type AttentionLedgerResponseEntry, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "../aperture/types.js";
import {
  ATTENTION_REVIEW_STATE_KEY,
  emitAttentionUpdate,
  persistReviewState,
  requireCompanyId,
  requireStringParam,
  runAttentionMutation,
} from "./shared.js";

async function loadReviewState(ctx: PluginContext, companyId: string): Promise<AttentionReviewState> {
  const persisted = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: ATTENTION_REVIEW_STATE_KEY,
  });

  if (
    persisted
    && typeof persisted === "object"
    && (persisted as AttentionReviewState).companyId === companyId
    && typeof (persisted as AttentionReviewState).updatedAt === "string"
    && typeof (persisted as AttentionReviewState).frames === "object"
  ) {
    return persisted as AttentionReviewState;
  }

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
    ...(snapshot.active ? [snapshot.active] : []),
    ...snapshot.queued,
    ...snapshot.ambient,
  ];
  return frames.some((frame) => frame.taskId === taskId);
}

export function registerActionHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
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
    const currentReview = await loadReviewState(ctx, companyId);
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
    return { ok: true, snapshot };
  });

  ctx.actions.register("comment-on-issue", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const issueId = requireStringParam(params, "issueId");
    const body = requireStringParam(params, "body").trim();

    if (!taskId.startsWith("issue:")) {
      throw new Error("Comments can only be posted on issue-backed frames.");
    }
    const expectedIssueId = taskId.slice("issue:".length);
    if (expectedIssueId !== issueId) {
      throw new Error("Issue comment target does not match the selected frame.");
    }

    const comment = await ctx.issues.createComment(issueId, body, companyId);
    const currentReview = await loadReviewState(ctx, companyId);
    const review = buildSeenReviewState(currentReview, companyId, [taskId], false);
    await persistReviewState(ctx, companyId, review);
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.comment",
      updatedAt: review.updatedAt,
      counts: store.getSnapshot(companyId)?.counts ?? {
        active: 0,
        queued: 0,
        ambient: 0,
        total: 0,
      },
    });
    return { ok: true, comment, review };
  });

  ctx.actions.register("record-approval-response", async (params) => {
    const companyId = requireCompanyId(params);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const decision = requireStringParam(params, "decision");

    if (taskId.startsWith("approval:") === false) {
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
    const currentReview = await loadReviewState(ctx, companyId);
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
    const currentReview = await loadReviewState(ctx, companyId);
    const review = buildSeenReviewState(currentReview, companyId, taskIds);
    await persistReviewState(ctx, companyId, review);
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.seen",
      updatedAt: review.updatedAt,
      counts: store.getSnapshot(companyId)?.counts ?? {
        active: 0,
        queued: 0,
        ambient: 0,
        total: 0,
      },
    });
    return { ok: true, review };
  });
}
