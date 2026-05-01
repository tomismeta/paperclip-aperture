import type { PluginContext } from "@paperclipai/plugin-sdk";

export type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

function isReservedRangeFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("private/reserved ranges");
}

function resolvePaperclipApiBase(config: Record<string, unknown>): string | null {
  const configured = typeof config.paperclipApiBase === "string" ? config.paperclipApiBase.trim() : "";
  if (configured.length === 0) return null;

  const url = new URL(configured);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("paperclipApiBase must be an http(s) URL.");
  }
  return url.toString();
}

async function paperclipApiFetch<TResponse>(
  ctx: PluginContext,
  config: Record<string, unknown>,
  path: string,
  options: RequestInit & { expectJson?: boolean; retries?: number } = {},
): Promise<TResponse> {
  const {
    expectJson = true,
    retries = 0,
    headers,
    ...init
  } = options;
  const apiBase = resolvePaperclipApiBase(config);
  if (!apiBase) {
    throw new Error("Paperclip approval API base is not configured.");
  }
  const url = new URL(path, apiBase).toString();

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await ctx.http.fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          ...(headers ?? {}),
        },
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Request failed (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
      }

      if (!expectJson) return undefined as TResponse;
      return await response.json() as TResponse;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError ?? new Error("Request failed.");
}

export async function listPendingApprovals(
  ctx: PluginContext,
  companyId: string,
  config: Record<string, unknown>,
): Promise<ApprovalRecord[]> {
  if (!resolvePaperclipApiBase(config)) return [];

  try {
    return await paperclipApiFetch<ApprovalRecord[]>(
      ctx,
      config,
      `/api/companies/${companyId}/approvals?status=pending`,
      { method: "GET", retries: 2 },
    );
  } catch (error) {
    if (isReservedRangeFetchFailure(error)) return [];
    throw error;
  }
}

export async function submitApprovalDecision(
  ctx: PluginContext,
  approvalId: string,
  decision: "approve" | "reject" | "request-revision",
  config: Record<string, unknown>,
): Promise<void> {
  const path = decision === "request-revision"
    ? `/api/approvals/${approvalId}/request-revision`
    : `/api/approvals/${approvalId}/${decision}`;

  await paperclipApiFetch<void>(ctx, config, path, {
    method: "POST",
    expectJson: false,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
}
