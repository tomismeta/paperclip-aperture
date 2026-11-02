import { useEffect, useRef, useState } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { StoredAttentionFrame } from "../aperture/types.js";
import { ActionButton } from "./chrome.js";
import { compactTitle, isIssueFrame } from "./frame-helpers.js";

export function IssueCommentComposer(props: {
  frame: StoredAttentionFrame;
  pendingId: string | null;
  onComment: (frame: StoredAttentionFrame, body: string) => Promise<void>;
  triggerTone?: "link" | "secondary" | "primary" | "accent";
  triggerLabel?: string;
  triggerFullWidth?: boolean;
  onOpen?: () => void;
  rows?: number;
  panelClassName?: string;
}) {
  const { companyId } = useHostContext();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const issueFrame = isIssueFrame(props.frame);

  const isPending = submitting || props.pendingId === props.frame.id;

  useEffect(() => {
    lifecycleRef.current += 1;
    submittingRef.current = false;
    setSubmitting(false);
    setOpen(false);
    setBody("");
  }, [companyId, props.frame.taskId, props.frame.interactionId]);

  useEffect(() => {
    if (open && issueFrame) textareaRef.current?.focus();
  }, [open, issueFrame]);

  if (!issueFrame) return null;

  async function submit() {
    const nextBody = body.trim();
    if (!nextBody || submittingRef.current || isPending) return;
    const lifecycle = lifecycleRef.current;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await props.onComment(props.frame, nextBody);
      if (lifecycleRef.current !== lifecycle) return;
      setBody("");
      setOpen(false);
    } finally {
      if (lifecycleRef.current === lifecycle) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  if (!open) {
    const label = props.triggerLabel ?? "Leave comment";
    const triggerTone = props.triggerTone ?? "link";

    if (triggerTone === "link") {
      return (
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            props.onOpen?.();
            setOpen(true);
          }}
        >
          {label}
        </button>
      );
    }

    return (
      <ActionButton
        label={label}
        tone={triggerTone}
        className={props.triggerFullWidth ? "w-full" : undefined}
        disabled={isPending}
        onClick={() => {
          props.onOpen?.();
          setOpen(true);
        }}
      />
    );
  }

  return (
    <div className={props.panelClassName ?? "w-full space-y-2 rounded-md border border-border bg-secondary/40 p-3"}>
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Commenting on {compactTitle(props.frame)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        Posts to the issue thread without leaving Focus.
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        disabled={isPending}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }

          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setBody("");
          }
        }}
        rows={props.rows ?? 3}
        placeholder="Add a short operator note back to the issue…"
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <div className="flex items-center justify-end gap-2">
        <ActionButton
          label="Cancel"
          tone="secondary"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setBody("");
          }}
        />
        <ActionButton
          label={isPending ? "Posting…" : "Post comment"}
          tone="accent"
          disabled={isPending || body.trim().length === 0}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}
