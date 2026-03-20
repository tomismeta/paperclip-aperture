import type { AttentionReviewState, AttentionSnapshot, StoredAttentionFrame } from "./types.js";

export type FrameLane = "active" | "queued" | "ambient";

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

function frameSemanticWeight(frame: StoredAttentionFrame): number {
  const factors = new Set(frame.provenance?.factors ?? []);
  let weight = 0;

  if (factors.has("run failed")) weight += 20;
  if (factors.has("waiting on human")) weight += 16;
  if (factors.has("needs clarification")) weight += 16;
  if (factors.has("blocked")) weight += 12;
  if (factors.has("pending approval")) weight += 12;
  if (factors.has("paused work")) weight += 6;
  if (factors.has("comment follow-up")) weight += 4;

  return weight;
}

export function frameSortScore(frame: StoredAttentionFrame, lane: FrameLane): number {
  const toneWeight = frame.tone === "critical" ? 40 : frame.tone === "focused" ? 25 : 5;
  const consequenceWeight = frame.consequence === "high" ? 30 : frame.consequence === "medium" ? 15 : 0;
  const modeWeight = frame.mode === "approval" ? 12 : frame.mode === "choice" ? 8 : 0;
  const laneWeight = lane === "active" ? 20 : lane === "queued" ? 10 : 0;
  const budgetWeight = isBudgetOverride(frame) ? 10 : 0;
  return toneWeight + consequenceWeight + modeWeight + laneWeight + budgetWeight + frameSemanticWeight(frame);
}

function emptyLaneCounts(): LaneCounts {
  return {
    active: 0,
    queued: 0,
    ambient: 0,
    total: 0,
  };
}

function compareCandidates(
  left: StoredFrameCandidate,
  right: StoredFrameCandidate,
  snapshotUpdatedAt: string,
): number {
  const byScore = frameSortScore(right.frame, right.lane) - frameSortScore(left.frame, left.lane);
  if (byScore !== 0) return byScore;
  return frameUpdatedAt(right.frame, snapshotUpdatedAt).localeCompare(frameUpdatedAt(left.frame, snapshotUpdatedAt));
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

  if (snapshot.active && isFrameUnread(snapshot.active, snapshot.updatedAt, review)) unread.active += 1;
  unread.queued = snapshot.queued.filter((frame) => isFrameUnread(frame, snapshot.updatedAt, review)).length;
  unread.ambient = snapshot.ambient.filter((frame) => isFrameUnread(frame, snapshot.updatedAt, review)).length;
  unread.total = unread.active + unread.queued + unread.ambient;

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
    active: null,
    queued: [],
    ambient: [],
    counts: emptyLaneCounts(),
  };

  const candidateTaskIds = new Set(candidates.map((candidate) => candidate.frame.taskId));
  const baseEntries: StoredFrameCandidate[] = [
    ...(base.active ? [{ frame: base.active, lane: "active" as const }] : []),
    ...base.queued.map((frame) => ({ frame, lane: "queued" as const })),
    ...base.ambient.map((frame) => ({ frame, lane: "ambient" as const })),
  ].filter((candidate) => !candidateTaskIds.has(candidate.frame.taskId));

  const filtered = [...baseEntries, ...candidates]
    .filter((candidate) => !isFrameSuppressed(candidate.frame, base.updatedAt, review));

  const actionable = filtered
    .filter((candidate) => candidate.lane !== "ambient")
    .sort((left, right) => compareCandidates(left, right, base.updatedAt));
  const ambient = filtered
    .filter((candidate) => candidate.lane === "ambient")
    .filter((candidate) => !isAmbientExpired(candidate.frame, base.updatedAt, nowIso))
    .sort((left, right) => compareCandidates(left, right, base.updatedAt));

  const active = actionable.shift()?.frame ?? null;
  const queued = actionable.map((candidate) => candidate.frame);
  const ambientFrames = ambient.map((candidate) => candidate.frame);

  return attachReviewState({
    ...base,
    active,
    queued,
    ambient: ambientFrames,
    counts: {
      active: active ? 1 : 0,
      queued: queued.length,
      ambient: ambientFrames.length,
      total: (active ? 1 : 0) + queued.length + ambientFrames.length,
    },
  }, review);
}
