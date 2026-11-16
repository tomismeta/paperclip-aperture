import type { AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "./types.js";
import { readFocusMetadata, readPaperclipRunMetadata, readPaperclipRunRecoveryMetadata, withFocusDecisionMetadata } from "./contracts.js";
import { taskIdMatchesKind } from "./task-ref.js";

export type FrameLane = "now" | "next" | "ambient";

const AMBIENT_MAX_AGE_MS = 5 * 60 * 1000;

export type StoredFrameCandidate = {
  frame: StoredAttentionFrame;
  lane: FrameLane;
};

export type DisplayEngagement = {
  taskId: string;
  interactionId: string;
  expiresAt: number;
};

export function applyDisplayEngagement(
  snapshot: AttentionSnapshot,
  engagement: DisplayEngagement,
  review: AttentionReviewState | null | undefined,
): AttentionSnapshot {
  if (Date.now() >= engagement.expiresAt) return snapshot;
  const matches = (frame: StoredAttentionFrame) => frame.taskId === engagement.taskId
    && frame.interactionId === engagement.interactionId;
  if (snapshot.now && matches(snapshot.now)) return snapshot;
  const held = snapshot.next.find(matches);
  if (!held) return snapshot;
  // Only ordinary next promotion may yield. Core/reconciliation NOW authority remains intact.
  if (snapshot.now && !isDisplayPromotedNow(snapshot.now)) return snapshot;
  const next = [
    ...(snapshot.now ? [snapshot.now] : []),
    ...snapshot.next.filter((frame) => !matches(frame)),
  ];
  const now = withFocusDecisionMetadata(held, {
    owner: "display_merge",
    lane: "now",
    sourcePolicy: "displayEngagement.holdCurrentNow",
    promotedFromLane: "next",
    rationale: ["The operator is engaging this current interaction; ordinary next promotion waits until its focus hold expires."],
  });
  return attachReviewState({
    ...snapshot,
    now,
    next,
    counts: { now: 1, next: next.length, ambient: snapshot.ambient.length, total: 1 + next.length + snapshot.ambient.length },
  }, review);
}

type LaneCounts = NonNullable<AttentionSnapshot["review"]>["unread"];

const DISPLAY_PROMOTION_POLICIES = new Set([
  "mergeStoredFrames.promoteNextWhenNowEmpty",
  "viewerPriority.promoteHumanAction",
]);

function isDisplayPromotedNow(frame: StoredAttentionFrame): boolean {
  const decision = readFocusMetadata(frame).decision;
  return decision?.owner === "display_merge" && DISPLAY_PROMOTION_POLICIES.has(decision.sourcePolicy ?? "");
}

function readMetadataString(frame: StoredAttentionFrame, key: string): string | undefined {
  const metadata = frame.metadata as Record<string, unknown> | undefined;
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function needsHumanAction(frame: StoredAttentionFrame, viewerUserId?: string | null): boolean {
  const viewer = viewerUserId?.trim() || null;
  if (frame.mode === "approval") return true;
  const metadata = readFocusMetadata(frame);
  if (metadata.entityType === "interaction" && frame.mode === "choice") {
    const decision = metadata.interactionDecision;
    if (!viewer || !decision) return true;
    if (decision.addresseeUserId && decision.addresseeUserId !== viewer) return false;
    return !(decision.effectiveResolverPolicy === "not_creator" && decision.createdByUserId === viewer);
  }
  if (metadata.entityType === "issue") {
    const assigneeUserId = readMetadataString(frame, "issueAssigneeUserId");
    return assigneeUserId !== undefined && (!viewer || assigneeUserId === viewer);
  }
  return false;
}

export function rankForViewer(
  snapshot: AttentionSnapshot,
  viewerUserId: string | null | undefined,
  review: AttentionReviewState | null | undefined,
): AttentionSnapshot {
  const ranked = [
    ...snapshot.next.filter((frame) => needsHumanAction(frame, viewerUserId)),
    ...snapshot.next.filter((frame) => !needsHumanAction(frame, viewerUserId)),
  ];
  const current = snapshot.now;
  const head = ranked[0];
  const yieldsNow = current !== null && head !== undefined
    && isDisplayPromotedNow(current)
    && current.tone !== "critical"
    && !needsHumanAction(current, viewerUserId)
    && needsHumanAction(head, viewerUserId);
  if (!yieldsNow) {
    if (ranked.every((frame, index) => frame === snapshot.next[index])) return snapshot;
    return { ...snapshot, next: ranked };
  }
  const rest = ranked.slice(1);
  const humanCount = rest.filter((frame) => needsHumanAction(frame, viewerUserId)).length;
  const yielded = withFocusDecisionMetadata(current, {
    owner: "display_merge",
    lane: "next",
    sourcePolicy: "viewerPriority.yieldToHumanAction",
    rationale: ["A frame that needs a human action took the focus from this status frame."],
  });
  const now = withFocusDecisionMetadata(head, {
    owner: "display_merge",
    lane: "now",
    sourcePolicy: "viewerPriority.promoteHumanAction",
    promotedFromLane: "next",
    rationale: ["A frame that needs a human action ranks above a promoted status frame."],
  });
  const next = [...rest.slice(0, humanCount), yielded, ...rest.slice(humanCount)];
  return attachReviewState({
    ...snapshot,
    now,
    next,
    counts: { now: 1, next: next.length, ambient: snapshot.ambient.length, total: 1 + next.length + snapshot.ambient.length },
  }, review);
}

export function isBudgetOverride(frame: StoredAttentionFrame): boolean {
  return frame.provenance?.factors?.includes("budget stop") ?? false;
}

export function frameUpdatedAt(frame: StoredAttentionFrame, snapshotUpdatedAt: string): string {
  return frame.timing.updatedAt || snapshotUpdatedAt;
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAmbientExpired(
  frame: StoredAttentionFrame,
  snapshotUpdatedAt: string,
  nowIso: string,
): boolean {
  const run = readPaperclipRunMetadata(frame);
  const recovery = readPaperclipRunRecoveryMetadata(frame);
  if (taskIdMatchesKind(frame.taskId, "run") && run?.status === "failed" && run.runId
    && !run.legacyIdentity && recovery && recovery.successorRunId !== run.runId) return false;
  const updatedAt = parseIsoMillis(frameUpdatedAt(frame, snapshotUpdatedAt));
  const now = parseIsoMillis(nowIso);
  if (updatedAt === null || now === null) return false;
  return now - updatedAt > AMBIENT_MAX_AGE_MS;
}

function emptyLaneCounts(): LaneCounts {
  return {
    now: 0,
    next: 0,
    ambient: 0,
    total: 0,
  };
}

function frameReviewState(review: AttentionReviewState | null | undefined, taskId: string) {
  return review?.frames[taskId];
}

export function isFrameSuppressed(
  frame: StoredAttentionFrame,
  snapshotUpdatedAt: string,
  review: AttentionReviewState | null | undefined,
): boolean {
  const marker = frameReviewState(review, frame.taskId);
  const suppressedAt = marker?.suppressedAt;
  if (!suppressedAt) return false;
  if (marker.suppressedInteractionId !== undefined && marker.suppressedInteractionId !== frame.interactionId) return false;
  if (taskIdMatchesKind(frame.taskId, "run") && readPaperclipRunMetadata(frame)?.status === "failed") return true;
  return frameUpdatedAt(frame, snapshotUpdatedAt).localeCompare(suppressedAt) <= 0;
}

export function isFrameUnread(
  frame: StoredAttentionFrame,
  snapshotUpdatedAt: string,
  review: AttentionReviewState | null | undefined,
): boolean {
  const updatedAt = frameUpdatedAt(frame, snapshotUpdatedAt);
  const seenAt = frameReviewState(review, frame.taskId)?.lastSeenAt ?? review?.lastSeenAt;
  if (!seenAt) return true;
  return updatedAt.localeCompare(seenAt) > 0;
}

export function calculateUnreadCounts(
  snapshot: AttentionSnapshot,
  review: AttentionReviewState | null | undefined,
): LaneCounts {
  const unread = emptyLaneCounts();

  if (snapshot.now && isFrameUnread(snapshot.now, snapshot.updatedAt, review)) unread.now += 1;
  unread.next = snapshot.next.filter((frame) => isFrameUnread(frame, snapshot.updatedAt, review)).length;
  unread.ambient = snapshot.ambient.filter((frame) => isFrameUnread(frame, snapshot.updatedAt, review)).length;
  unread.total = unread.now + unread.next + unread.ambient;

  return unread;
}

export function attachReviewState(
  snapshot: AttentionSnapshot,
  review: AttentionReviewState | null | undefined,
): AttentionSnapshot {
  return {
    ...snapshot,
    review: {
      lastSeenAt: review?.lastSeenAt,
      unread: calculateUnreadCounts(snapshot, review),
    },
  };
}

export function mergeStoredFrames(
  snapshot: AttentionSnapshot | null,
  companyId: string,
  candidates: StoredFrameCandidate[],
  review?: AttentionReviewState | null,
  nowIso = new Date().toISOString(),
): AttentionSnapshot {
  const base: AttentionSnapshot = snapshot ?? {
    companyId,
    updatedAt: new Date().toISOString(),
    now: null,
    next: [],
    ambient: [],
    counts: emptyLaneCounts(),
  };

  const candidateTaskIds = new Set(candidates.map((candidate) => candidate.frame.taskId));
  const baseEntries: StoredFrameCandidate[] = [
    ...(base.now ? [{ frame: base.now, lane: "now" as const }] : []),
    ...base.next.map((frame) => ({ frame, lane: "next" as const })),
    ...base.ambient.map((frame) => ({ frame, lane: "ambient" as const })),
  ].filter((candidate) => !candidateTaskIds.has(candidate.frame.taskId));

  const filtered = [...baseEntries, ...candidates].filter(
    (candidate) => !isFrameSuppressed(candidate.frame, base.updatedAt, review),
  );

  const orderLane = (lane: FrameLane) =>
    filtered
      .filter((candidate) => candidate.lane === lane)
      .sort((left, right) => frameUpdatedAt(right.frame, base.updatedAt).localeCompare(frameUpdatedAt(left.frame, base.updatedAt)));

  const explicitNow = orderLane("now");
  const explicitNext = orderLane("next");
  const ambient = orderLane("ambient").filter(
    (candidate) => !isAmbientExpired(candidate.frame, base.updatedAt, nowIso),
  );

  const nowCandidateFromExplicitNow = explicitNow.shift() ?? null;
  const promotedNextCandidate = nowCandidateFromExplicitNow ? null : explicitNext.shift() ?? null;
  const nowCandidate = nowCandidateFromExplicitNow ?? promotedNextCandidate;
  const next = [...explicitNow, ...explicitNext].map((candidate) => candidate.frame);
  const ambientFrames = ambient.map((candidate) => candidate.frame);
  const now = promotedNextCandidate
    ? withFocusDecisionMetadata(promotedNextCandidate.frame, {
        owner: "display_merge",
        lane: "now",
        sourcePolicy: "mergeStoredFrames.promoteNextWhenNowEmpty",
        promotedFromLane: "next",
        rationale: [
          "No explicit now candidate was available, so the highest next candidate became the active focus.",
        ],
      })
    : nowCandidate?.frame ?? null;

  return attachReviewState({
    ...base,
    now,
    next,
    ambient: ambientFrames,
    counts: {
      now: now ? 1 : 0,
      next: next.length,
      ambient: ambientFrames.length,
      total: (now ? 1 : 0) + next.length + ambientFrames.length,
    },
  }, review);
}
