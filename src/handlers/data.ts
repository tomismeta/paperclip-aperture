import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createEmptySnapshot, type AttentionSnapshot, type StoredAttentionFrame } from "../aperture/types.js";
import { ApertureCompanyStore } from "../aperture/core-store.js";
import { mapPluginEventToAperture } from "../aperture/event-mapper.js";
import { ATTENTION_SNAPSHOT_STATE_KEY, persistSnapshot, requireCompanyId } from "./shared.js";

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function isAttentionSnapshot(value: unknown, companyId: string): value is AttentionSnapshot {
  if (!value || typeof value !== "object") return false;

  const snapshot = value as Partial<AttentionSnapshot>;
  return (
    snapshot.companyId === companyId &&
    typeof snapshot.updatedAt === "string" &&
    !!snapshot.counts &&
    typeof snapshot.counts.active === "number" &&
    typeof snapshot.counts.queued === "number" &&
    typeof snapshot.counts.ambient === "number" &&
    typeof snapshot.counts.total === "number" &&
    Array.isArray(snapshot.queued) &&
    Array.isArray(snapshot.ambient)
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isApprovalFrame(frame: StoredAttentionFrame | null | undefined): frame is StoredAttentionFrame {
  return !!frame && frame.taskId.startsWith("approval:");
}

function snapshotWithoutApprovalFrames(snapshot: AttentionSnapshot): AttentionSnapshot {
  return {
    ...snapshot,
    active: isApprovalFrame(snapshot.active) ? null : snapshot.active,
    queued: snapshot.queued.filter((frame) => !isApprovalFrame(frame)),
    ambient: snapshot.ambient.filter((frame) => !isApprovalFrame(frame)),
  };
}

function mergeApprovalFrames(
  snapshot: AttentionSnapshot,
  approvalFrames: AttentionSnapshot,
): AttentionSnapshot {
  const base = snapshotWithoutApprovalFrames(snapshot);
  const mergedActive = base.active ?? approvalFrames.active;
  const mergedQueued = [
    ...(base.active ? [approvalFrames.active, ...approvalFrames.queued].filter((frame): frame is StoredAttentionFrame => frame !== null) : approvalFrames.queued),
    ...base.queued,
  ];

  return {
    ...base,
    updatedAt: new Date().toISOString(),
    active: mergedActive,
    queued: mergedQueued,
    counts: {
      active: mergedActive ? 1 : 0,
      queued: mergedQueued.length,
      ambient: base.ambient.length,
      total: (mergedActive ? 1 : 0) + mergedQueued.length + base.ambient.length,
    },
  };
}

function approvalApiBaseUrl(): string {
  return process.env.PAPERCLIP_API_URL
    ?? `http://127.0.0.1:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`;
}

async function listPendingApprovals(companyId: string): Promise<ApprovalRecord[]> {
  const url = new URL(`/api/companies/${companyId}/approvals`, approvalApiBaseUrl());
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to load approvals (${response.status})`);
  }

  const approvals = await response.json() as ApprovalRecord[];
  return approvals
    .filter((approval) => approval.status === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function buildApprovalSnapshot(companyId: string, approvals: ApprovalRecord[]): AttentionSnapshot {
  const approvalStore = new ApertureCompanyStore();

  for (const approval of approvals) {
    const mapped = mapPluginEventToAperture({
      eventId: `approval-sync:${approval.id}`,
      companyId,
      eventType: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      occurredAt: approval.updatedAt ?? approval.createdAt,
      payload: {
        ...approval.payload,
        type: approval.type,
      },
    });

    if (!mapped) continue;

    approvalStore.ingest(companyId, mapped, {
      eventType: "approval.created",
      entityId: approval.id,
      entityType: "approval",
    });
  }

  return approvalStore.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
}

async function reconcilePendingApprovals(
  ctx: PluginContext,
  store: ApertureCompanyStore,
  snapshot: AttentionSnapshot,
  companyId: string,
): Promise<AttentionSnapshot> {
  try {
    const approvals = await listPendingApprovals(companyId);
    const approvalSnapshot = buildApprovalSnapshot(companyId, approvals);
    const reconciled = mergeApprovalFrames(snapshot, approvalSnapshot);

    if (JSON.stringify(reconciled) !== JSON.stringify(snapshot)) {
      store.hydrateSnapshot(companyId, reconciled);
      await persistSnapshot(ctx, companyId, reconciled);
    }

    return reconciled;
  } catch (error) {
    ctx.logger.warn("Failed to reconcile pending approvals for Aperture", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return snapshot;
  }
}

export function registerDataHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.data.register("health", async () => {
    return {
      status: "ok",
      checkedAt: new Date().toISOString(),
      trackedCompanies: store.getCompanyCount(),
    };
  });

  ctx.data.register("attention-summary", async (params) => {
    const companyId = requireCompanyId(params);
    const existing = store.getSnapshot(companyId);
    if (existing) return reconcilePendingApprovals(ctx, store, existing, companyId);

    const persisted = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      stateKey: ATTENTION_SNAPSHOT_STATE_KEY,
    });

    if (isAttentionSnapshot(persisted, companyId)) {
      const hydrated = store.hydrateSnapshot(companyId, persisted);
      return reconcilePendingApprovals(ctx, store, hydrated, companyId);
    }

    return reconcilePendingApprovals(ctx, store, createEmptySnapshot(companyId), companyId);
  });
}
