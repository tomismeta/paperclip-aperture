import { useId, useState } from "react";
import { readFocusMetadata } from "../aperture/contracts.js";
import type { StoredAttentionFrame } from "../aperture/types.js";
import { ActionButton } from "./chrome.js";

export type InteractionResponseHandler = (
  frame: StoredAttentionFrame,
  decision: "accept" | "reject",
  reason?: string,
) => Promise<boolean>;

export function InteractionActions(props: {
  frame: StoredAttentionFrame;
  pendingId: string | null;
  userId: string | null | undefined;
  onRespond: InteractionResponseHandler;
}) {
  const decision = readFocusMetadata(props.frame).interactionDecision;
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  if (!decision?.inline || !props.userId
    || (decision.addresseeUserId && decision.addresseeUserId !== props.userId)
    || (decision.effectiveResolverPolicy === "not_creator" && decision.createdByUserId === props.userId)) {
    return null;
  }
  const pending = props.pendingId === props.frame.id;
  async function decline() {
    if (!decision) return;
    if ((decision.rejectRequiresReason || decision.allowDeclineReason) && !declining) {
      setDeclining(true);
      return;
    }
    if (decision.rejectRequiresReason && !reason.trim()) {
      setError("A reason is required to decline this decision.");
      return;
    }
    setError(null);
    if (await props.onRespond(props.frame, "reject", reason.trim() || undefined)) {
      setDeclining(false);
      setReason("");
    }
  }
  return (
    <div className="space-y-2">
      {declining ? (
        <div className="space-y-1">
          <label htmlFor={reasonId} className="text-xs font-medium">{decision.rejectReasonLabel}</label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => { setReason(event.target.value); setError(null); }}
            disabled={pending}
            required={decision.rejectRequiresReason}
            aria-invalid={!!error}
            aria-describedby={error ? `${reasonId}-error` : undefined}
            rows={3}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          {error ? <p id={`${reasonId}-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          label={decision.preparing ? "Preparing approval…" : decision.acceptLabel}
          tone="accent"
          disabled={pending || decision.preparing}
          onClick={() => void props.onRespond(props.frame, "accept")}
        />
        <ActionButton label={decision.rejectLabel} tone="accent" disabled={pending} onClick={() => void decline()} />
        {declining ? <ActionButton label="Cancel" tone="secondary" disabled={pending} onClick={() => { setDeclining(false); setError(null); }} /> : null}
      </div>
    </div>
  );
}
