export function actionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function acknowledgeSuccessMessage(title: string): string {
  return `Acknowledged ${title}.`;
}

export function acknowledgeFailureMessage(error: unknown): string {
  return actionErrorMessage(error, "Failed to acknowledge frame.");
}

export function issueFrameUnsupportedMessage(): string {
  return "This frame is not backed by a Paperclip issue.";
}

export function commentSuccessMessage(title: string): string {
  return `Posted a comment on ${title}.`;
}

export function commentFailureMessage(error: unknown): string {
  return actionErrorMessage(error, "Failed to post comment.");
}

export function approvalFrameUnsupportedMessage(): string {
  return "This frame is not backed by a Paperclip approval.";
}

export function approvalDecisionSuccessMessage(title: string, decision: "approve" | "reject"): string {
  return `${decision === "approve" ? "Approved" : "Rejected"} ${title}.`;
}

export function approvalDecisionFailureMessage(error: unknown): string {
  return actionErrorMessage(error, "Failed to submit approval decision.");
}

export function approvalRevisionSuccessMessage(title: string): string {
  return `Requested revision for ${title}.`;
}

export function approvalRevisionFailureMessage(error: unknown): string {
  return actionErrorMessage(error, "Failed to request approval revision.");
}
