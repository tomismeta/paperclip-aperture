import type { AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "./types.js";

export type FrameLane = "now" | "next" | "ambient";

const AMBIENT_MAX_AGE_MS = 5 * 60 * 1000;

export type StoredFrameCandidate = {
  frame: StoredAttentionFrame;
  lane: FrameLane;
};

type LaneCounts = NonNullable<AttentionSnapshot["review"]>["unread"];

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
  const suppressedAt = frameReviewState(review, frame.taskId)?.suppressedAt;
  if (!suppressedAt) return false;
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

  const nowCandidate = explicitNow.shift() ?? explicitNext.shift() ?? null;
  const next = [...explicitNow, ...explicitNext].map((candidate) => candidate.frame);
  const ambientFrames = ambient.map((candidate) => candidate.frame);
  const now = nowCandidate?.frame ?? null;

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
