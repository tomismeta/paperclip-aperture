import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { useEffect, useRef, useState } from "react";
import type { AttentionSnapshot, StoredAttentionFrame } from "../aperture/types.js";
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
  approvalRevisionFailureMessage,
  approvalRevisionSuccessMessage,
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
  const setFocusPresence = usePluginAction("set-focus-presence");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const focusReleaseTimerRef = useRef<number | null>(null);
  const lastViewedInteractionRef = useRef<string | null>(null);
  const markAttentionViewedRef = useRef(markAttentionViewed);
  const setFocusPresenceRef = useRef(setFocusPresence);

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
      if (focusReleaseTimerRef.current) {
        window.clearTimeout(focusReleaseTimerRef.current);
      }
    };
  }, []);

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

    const durationMs = reason === "comment_compose" ? FOCUS_HOLD_COMPOSE_MS : FOCUS_HOLD_CONTEXT_MS;

    try {
      await engageFocus({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        reason,
        durationMs,
      });
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
      await commentOnIssue({ companyId, taskId: frame.taskId, issueId, body });
      setStatusOverride(commentSuccessMessage(compactTitle(frame)));
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
      await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision,
      });

      setStatusOverride(approvalDecisionSuccessMessage(compactTitle(frame), decision));
      input.refresh();
    } catch (actionError) {
      setStatusOverride(approvalDecisionFailureMessage(actionError));
    } finally {
      setPendingId(null);
    }
  }

  async function requestApprovalRevision(frame: StoredAttentionFrame) {
    const companyId = input.companyId;
    const approvalId = approvalIdForFrame(frame);
    if (!companyId || !approvalId) {
      setStatusOverride(approvalFrameUnsupportedMessage());
      return;
    }

    setPendingId(frame.id);
    try {
      await recordApprovalResponse({
        companyId,
        taskId: frame.taskId,
        interactionId: frame.interactionId,
        decision: "request-revision",
      });

      setStatusOverride(approvalRevisionSuccessMessage(compactTitle(frame)));
      input.refresh();
    } catch (actionError) {
      setStatusOverride(approvalRevisionFailureMessage(actionError));
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
    requestApprovalRevision,
  };
}
