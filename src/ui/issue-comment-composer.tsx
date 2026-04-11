import { useEffect, useRef, useState } from "react";
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
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const issueFrame = isIssueFrame(props.frame);

  const isPending = props.pendingId === props.frame.id;

  useEffect(() => {
    setOpen(false);
    setBody("");
  }, [props.frame.id]);

  useEffect(() => {
    if (open && issueFrame) textareaRef.current?.focus();
  }, [open, issueFrame]);

  if (!issueFrame) return null;

  async function submit() {
    const nextBody = body.trim();
    if (!nextBody) return;
    await props.onComment(props.frame, nextBody);
    setBody("");
    setOpen(false);
  }

  if (!open) {
    const label = props.triggerLabel ?? "Leave comment";
    const triggerTone = props.triggerTone ?? "link";

    if (triggerTone === "link") {
      return (
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setOpen(true)}
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
        onClick={() => setOpen(true)}
      />
    );
  }

  return (
    <div className="w-full space-y-2 rounded-md border border-border bg-secondary/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Commenting on {compactTitle(props.frame)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        Posts to the issue thread without leaving Focus.
      </div>
      <textarea
        ref={textareaRef}
        value={body}
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
        rows={3}
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
