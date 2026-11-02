import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { useEffect, useRef, useState } from "react";
import type { AttentionSnapshot, StoredAttentionFrame } from "../aperture/types.js";
import { readFocusMetadata } from "../aperture/contracts.js";
import {
  approvalIdForFrame,
  compactTitle,
  entityIdFromFrame,
  entityTypeFromFrame,
} from "./frame-helpers.js";
import {
  acknowledgeFailureMessage,
  acknowledgeSuccessMessage,
  approvalDecisionFailureMessage,
  approvalDecisionSuccessMessage,
  approvalFrameUnsupportedMessage,
  commentFailureMessage,
  commentSuccessMessage,
  issueFrameUnsupportedMessage,
} from "./interaction-copy.js";

const FOCUS_HOLD_CONTEXT_MS = 20_000;
const FOCUS_HOLD_COMPOSE_MS = 45_000;

export function useFocusPageActions(input: {
  companyId: string | null | undefined;
  displaySnapshot: AttentionSnapshot | null;
  refresh: () => void;
}) {
  const acknowledge = usePluginAction("acknowledge-frame");
  const commentOnIssue = usePluginAction("comment-on-issue");
  const engageFocus = usePluginAction("engage-focus");
  const markAttentionViewed = usePluginAction("mark-attention-viewed");
  const recordApprovalResponse = usePluginAction("record-approval-response");
  const respondToInteraction = usePluginAction("respond-to-interaction");
  const setFocusPresence = usePluginAction("set-focus-presence");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const focusReleaseTimerRef = useRef<number | null>(null);
  const lastViewedInteractionRef = useRef<string | null>(null);
  const markAttentionViewedRef = useRef(markAttentionViewed);
  const setFocusPresenceRef = useRef(setFocusPresence);
  const companyRef = useRef(input.companyId);
  const companyEpochRef = useRef(0);
  if (companyRef.current !== input.companyId) {
    companyRef.current = input.companyId;
    companyEpochRef.current += 1;
  }

  markAttentionViewedRef.current = markAttentionViewed;
  setFocusPresenceRef.current = setFocusPresence;

  useEffect(() => {
    if (!statusOverride) return;

    const timer = window.setTimeout(() => {
      setStatusOverride(null);
    }, 4000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [statusOverride]);

  useEffect(() => {
    return () => {
      companyEpochRef.current += 1;
      if (focusReleaseTimerRef.current) {
        window.clearTimeout(focusReleaseTimerRef.current);
        focusReleaseTimerRef.current = null;
      }
    };
  }, [input.companyId]);

  useEffect(() => {
    const companyId = input.companyId;
    if (!companyId) return;

    void setFocusPresenceRef.current({ companyId, presence: "present" }).catch(() => {
      // Presence is best-effort and should not interrupt the operator.
    });

    return () => {
      void setFocusPresenceRef.current({ companyId, presence: "absent" }).catch(() => {
        // Presence is best-effort and should not interrupt the operator.
      });
    };
  }, [input.companyId]);

  useEffect(() => {
    const companyId = input.companyId;
    const frame = input.displaySnapshot?.now;
    if (!companyId || !frame) {
      lastViewedInteractionRef.current = null;
      return;
    }

    const viewKey = `${companyId}:${frame.interactionId}`;
    if (lastViewedInteractionRef.current === viewKey) return;
    lastViewedInteractionRef.current = viewKey;

    void markAttentionViewedRef.current({
      companyId,
      taskId: frame.taskId,
      interactionId: frame.interactionId,
      surface: "focus",
    }).catch(() => {
      if (lastViewedInteractionRef.current === viewKey) {
        lastViewedInteractionRef.current = null;
      }
    });
  }, [input.companyId, input.displaySnapshot?.now?.interactionId]);

  async function holdNowFrame(frame: StoredAttentionFrame, reason: "show_context" | "comment_compose") {
    const companyId = input.companyId;
    if (!companyId) return;
    if (input.displaySnapshot?.now?.interactionId !== frame.interactionId) return;
    const companyEpoch = companyEpochRef.current;

    const durationMs = reason === "comment_compose" ? FOCUS_HOLD_COMPOSE_MS : FOCUS_HOLD_CONTEXT_MS;

    try {
      await engageFocus({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        reason,
        durationMs,
      });
      if (companyEpochRef.current !== companyEpoch) return;
      input.refresh();
      if (focusReleaseTimerRef.current) {
        window.clearTimeout(focusReleaseTimerRef.current);
      }
      focusReleaseTimerRef.current = window.setTimeout(() => {
        input.refresh();
        focusReleaseTimerRef.current = null;
      }, durationMs + 150);
    } catch {
      // Failed focus hold should stay silent so operator work is not interrupted.
    }
  }

  async function acknowledgeFrame(frame: StoredAttentionFrame) {
    const companyId = input.companyId;
    if (!companyId) return;
    setPendingId(frame.id);
    try {
      await acknowledge({ companyId, taskId: frame.taskId, interactionId: frame.interactionId });
      setStatusOverride(acknowledgeSuccessMessage(compactTitle(frame)));
      input.refresh();
    } catch (actionError) {
      setStatusOverride(acknowledgeFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function commentOnIssueFrame(frame: StoredAttentionFrame, body: string) {
    const companyId = input.companyId;
    const issueId = entityIdFromFrame(frame);
    if (!companyId || !issueId || entityTypeFromFrame(frame) !== "issue") {
      setStatusOverride(issueFrameUnsupportedMessage());
      return;
    }

    setPendingId(frame.id);
    try {
      const result = await commentOnIssue({ companyId, taskId: frame.taskId, issueId, body });
      setStatusOverride(
        result && typeof result === "object" && "syncWarning" in result && typeof result.syncWarning === "string"
          ? result.syncWarning
          : commentSuccessMessage(compactTitle(frame)),
      );
      input.refresh();
    } catch (actionError) {
      setStatusOverride(commentFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function submitApprovalDecision(frame: StoredAttentionFrame, decision: "approve" | "reject") {
    const companyId = input.companyId;
    const approvalId = approvalIdForFrame(frame);
    if (!companyId || !approvalId) {
      setStatusOverride(approvalFrameUnsupportedMessage());
      return;
    }

    setPendingId(frame.id);
    try {
      const result = await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision,
      });
      if (result && typeof result === "object" && "applied" in result && result.applied === false) {
        await markAttentionViewed({
          companyId,
          taskId: frame.taskId,
          interactionId: frame.interactionId,
          surface: "focus",
        });
      }

      setStatusOverride(
        result && typeof result === "object" && "applied" in result && result.applied === false
          ? "This approval was already resolved in Paperclip."
          : approvalDecisionSuccessMessage(compactTitle(frame), decision),
      );
      input.refresh();
    } catch (actionError) {
      setStatusOverride(approvalDecisionFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function submitInteractionDecision(
    frame: StoredAttentionFrame,
    decision: "accept" | "reject",
    reason?: string,
  ): Promise<boolean> {
    const companyId = input.companyId;
    const metadata = readFocusMetadata(frame);
    if (!companyId || !metadata.issueId || !metadata.paperclipInteractionId) return false;
    if (decision === "reject" && metadata.interactionDecision?.rejectRequiresReason && !reason?.trim()) {
      setStatusOverride("A reason is required to decline this decision.");
      return false;
    }
    setPendingId(frame.id);
    try {
      const result = await respondToInteraction({
        companyId, taskId: frame.taskId, interactionId: frame.interactionId,
        issueId: metadata.issueId, decision, ...(reason?.trim() ? { reason: reason.trim() } : {}),
      });
      const converged = result && typeof result === "object" && "applied" in result && result.applied === false;
      setStatusOverride(converged
        ? "This decision was already resolved in Paperclip."
        : decision === "accept" ? "Decision confirmed in Paperclip." : "Decision declined in Paperclip.");
      input.refresh();
      return true;
    } catch (error) {
      setStatusOverride(error instanceof Error ? error.message : "Failed to respond to this decision.");
      return false;
    } finally {
      setPendingId(null);
    }
  }

  return {
    pendingId,
    statusOverride,
    holdNowFrame,
    acknowledgeFrame,
    commentOnIssueFrame,
    submitApprovalDecision,
    submitInteractionDecision,
  };
}
