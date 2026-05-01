import { readFocusMetadata } from "./contracts.js";
import type {
  AttentionOverlayChange,
  AttentionOverlayDiagnostics,
  AttentionOverlayFrameReport,
  AttentionOverlayLane,
  AttentionOverlayStage,
  AttentionSnapshot,
  StoredAttentionFrame,
} from "./types.js";

type SnapshotFrameRef = {
  frame: StoredAttentionFrame;
  lane: AttentionOverlayLane;
};

function snapshotFrameMap(snapshot: AttentionSnapshot): Map<string, SnapshotFrameRef> {
  const entries: Array<[string, SnapshotFrameRef]> = [];

  if (snapshot.now) {
    entries.push([snapshot.now.taskId, { frame: snapshot.now, lane: "now" }]);
  }

  for (const frame of snapshot.next) {
    entries.push([frame.taskId, { frame, lane: "next" }]);
  }

  for (const frame of snapshot.ambient) {
    entries.push([frame.taskId, { frame, lane: "ambient" }]);
  }

  return new Map(entries);
}

function changeBetween(
  stage: Exclude<AttentionOverlayStage, "core">,
  fromLane: AttentionOverlayLane | null,
  toLane: AttentionOverlayLane | null,
): AttentionOverlayChange | null {
  if (fromLane === toLane) return null;
  if (fromLane === null && toLane !== null) {
    return { stage, kind: "introduced", fromLane, toLane };
  }
  if (fromLane !== null && toLane === null) {
    return { stage, kind: "removed", fromLane, toLane };
  }
  return { stage, kind: "moved", fromLane, toLane };
}

function canonicalSource(
  core: SnapshotFrameRef | undefined,
  reconciled: SnapshotFrameRef | undefined,
): AttentionOverlayFrameReport["canonicalSource"] {
  if (core) return "core";
  if (reconciled) return "reconciled";
  return "display_overlay";
}

function overlayKind(
  frame: StoredAttentionFrame,
  source: AttentionOverlayFrameReport["canonicalSource"],
): AttentionOverlayFrameReport["overlayKind"] {
  if (source !== "display_overlay") return undefined;
  return readFocusMetadata(frame).entityType === "approval" ? "approval_overlay" : "display_overlay";
}

export function buildOverlayDiagnostics(input: {
  snapshot: AttentionSnapshot;
  reconciledSnapshot: AttentionSnapshot;
  displaySnapshot: AttentionSnapshot;
}): AttentionOverlayDiagnostics {
  const coreFrames = snapshotFrameMap(input.snapshot);
  const reconciledFrames = snapshotFrameMap(input.reconciledSnapshot);
  const displayFrames = snapshotFrameMap(input.displaySnapshot);

  const taskIds = [...new Set([
    ...coreFrames.keys(),
    ...reconciledFrames.keys(),
    ...displayFrames.keys(),
  ])].sort();

  const frames: AttentionOverlayFrameReport[] = taskIds.map((taskId) => {
    const core = coreFrames.get(taskId);
    const reconciled = reconciledFrames.get(taskId);
    const display = displayFrames.get(taskId);
    const representative = display?.frame ?? reconciled?.frame ?? core?.frame;

    if (!representative) {
      throw new Error(`Overlay diagnostics could not resolve representative frame for ${taskId}.`);
    }

    const metadata = readFocusMetadata(representative);
    const changes = [
      changeBetween("reconciled", core?.lane ?? null, reconciled?.lane ?? null),
      changeBetween("display", reconciled?.lane ?? null, display?.lane ?? null),
    ].filter((entry): entry is AttentionOverlayChange => entry !== null);
    const source = canonicalSource(core, reconciled);

    return {
      taskId,
      title: representative.title,
      entityType: metadata.entityType,
      interactionIds: {
        ...(core ? { core: core.frame.interactionId } : {}),
        ...(reconciled ? { reconciled: reconciled.frame.interactionId } : {}),
        ...(display ? { display: display.frame.interactionId } : {}),
      },
      lanePath: {
        core: core?.lane ?? null,
        reconciled: reconciled?.lane ?? null,
        display: display?.lane ?? null,
      },
      canonicalSource: source,
      overlayKind: overlayKind(representative, source),
      liveReconciled: metadata.liveReconciled,
      attentionRationale: metadata.attention?.rationale ?? [],
      matchedRuleIds: metadata.issueIntelligence?.matchedRuleIds ?? [],
      relationHintKinds: metadata.semantic?.relationHints?.map((hint) => hint.kind) ?? [],
      decision: metadata.decision,
      changes,
    };
  });

  const summary = {
    coreFrames: coreFrames.size,
    reconciledFrames: reconciledFrames.size,
    displayFrames: displayFrames.size,
    introducedByReconciliation: frames.filter((frame) =>
      frame.changes.some((change) => change.stage === "reconciled" && change.kind === "introduced")).length,
    removedByReconciliation: frames.filter((frame) =>
      frame.changes.some((change) => change.stage === "reconciled" && change.kind === "removed")).length,
    movedByReconciliation: frames.filter((frame) =>
      frame.changes.some((change) => change.stage === "reconciled" && change.kind === "moved")).length,
    introducedByDisplayOverlay: frames.filter((frame) =>
      frame.changes.some((change) => change.stage === "display" && change.kind === "introduced")).length,
    removedByDisplayOverlay: frames.filter((frame) =>
      frame.changes.some((change) => change.stage === "display" && change.kind === "removed")).length,
    movedByDisplayOverlay: frames.filter((frame) =>
      frame.changes.some((change) => change.stage === "display" && change.kind === "moved")).length,
    approvalOverlayFrames: frames.filter((frame) => frame.overlayKind === "approval_overlay").length,
  };

  return {
    generatedAt: input.displaySnapshot.updatedAt,
    summary,
    frames,
  };
}
