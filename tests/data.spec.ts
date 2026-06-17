import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { registerDataHandlers } from "../src/handlers/data.js";

type DataHandler = (params: Record<string, unknown>) => Promise<unknown>;

function invocationScopeDenied(method: string): Error {
  return new Error(`Plugin is not allowed to perform "${method}": the worker referenced a missing, expired, or unknown invocation scope`);
}

function createDataHarness() {
  const handlers = new Map<string, DataHandler>();
  const ctx = {
    agents: {
      list: vi.fn(async () => {
        throw invocationScopeDenied("agents.list");
      }),
    },
    config: { get: vi.fn(async () => ({})) },
    data: {
      register: vi.fn((key: string, handler: DataHandler) => {
        handlers.set(key, handler);
      }),
    },
    issues: {
      list: vi.fn(async () => {
        throw invocationScopeDenied("issues.list");
      }),
      listComments: vi.fn(async () => []),
      documents: { list: vi.fn(async () => []) },
      relations: { get: vi.fn(async () => null) },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    state: {
      get: vi.fn(async () => {
        throw invocationScopeDenied("state.get");
      }),
      set: vi.fn(async () => undefined),
    },
  } as unknown as PluginContext;

  return { ctx, handlers };
}

describe("data handlers", () => {
  it("returns a degraded attention display when host state scope is unavailable", async () => {
    const harness = createDataHarness();
    registerDataHandlers(harness.ctx, new ApertureCompanyStore());

    const handler = harness.handlers.get("attention-display");
    expect(handler).toBeTypeOf("function");
    const payload = await handler?.({ companyId: "company-data" });

    expect(payload).toMatchObject({
      companyId: "company-data",
      snapshot: {
        companyId: "company-data",
        counts: {
          now: 0,
          next: 0,
          ambient: 0,
          total: 0,
        },
      },
      reviewState: {
        companyId: "company-data",
      },
    });
    expect(harness.ctx.state.get).toHaveBeenCalled();
    expect(harness.ctx.agents.list).toHaveBeenCalled();
    expect(harness.ctx.logger.warn).toHaveBeenCalledWith(
      "Aperture persisted state unavailable in this host callback; using in-memory attention state.",
      expect.objectContaining({ companyId: "company-data" }),
    );
    expect(harness.ctx.logger.warn).toHaveBeenCalledWith(
      "Aperture host reconciliation unavailable in this host callback; using current attention snapshot.",
      expect.objectContaining({ companyId: "company-data" }),
    );
  });
});
