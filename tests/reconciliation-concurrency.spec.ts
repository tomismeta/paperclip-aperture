import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ApertureCompanyStore } from "../src/aperture/core-store.js";
import { loadReconciledCandidates } from "../src/aperture/reconciliation.js";
import {
  createEmptyLedger,
  createEmptyReviewState,
  createEmptySnapshot,
} from "../src/aperture/types.js";
import { registerDataHandlers } from "../src/handlers/data.js";

type DataHandler = (params: Record<string, unknown>) => Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createContext(options: {
  listAgents: (params: { companyId: string; limit: number }) => Promise<Agent[]>;
  getConfig?: (companyId: string) => Promise<Record<string, unknown>>;
}) {
  const handlers = new Map<string, DataHandler>();
  const listAgents = vi.fn(options.listAgents);
  const ctx = {
    agents: {
      list: listAgents,
    },
    config: {
      get: vi.fn(options.getConfig ?? (async () => ({ captureIssueLifecycle: false }))),
    },
    data: {
      register: vi.fn((key: string, handler: DataHandler) => {
        handlers.set(key, handler);
      }),
    },
    issues: {
      list: vi.fn(async () => []),
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
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    },
  } as unknown as PluginContext;

  return { ctx, handlers, listAgents };
}

describe("reconciliation concurrency", () => {
  it("coalesces eight concurrent host reads independently for each company", async () => {
    const companyAGate = deferred<Agent[]>();
    const companyBGate = deferred<Agent[]>();
    const harness = createContext({
      listAgents: ({ companyId }) => companyId === "company-a"
        ? companyAGate.promise
        : companyBGate.promise,
    });
    const store = new ApertureCompanyStore();
    const cacheWrites = vi.spyOn(store, "setCachedHostValue");

    const companyAReads = Array.from({ length: 8 }, () => (
      loadReconciledCandidates(harness.ctx, store, "company-a", { captureIssueLifecycle: false })
    ));
    const companyBReads = Array.from({ length: 8 }, () => (
      loadReconciledCandidates(harness.ctx, store, "company-b", { captureIssueLifecycle: false })
    ));

    await Promise.resolve();
    const callsBeforeRelease = harness.listAgents.mock.calls.length;
    companyAGate.resolve([]);
    companyBGate.resolve([]);
    await Promise.all([...companyAReads, ...companyBReads]);

    expect(callsBeforeRelease).toBe(2);
    expect(harness.listAgents).toHaveBeenCalledTimes(2);
    expect(cacheWrites).toHaveBeenCalledTimes(2);
  });

  it("coalesces eight display reconciliations after the same cache miss", async () => {
    const allConfigReadsStarted = deferred<void>();
    let configReads = 0;
    const harness = createContext({
      listAgents: async () => {
        throw new Error("agents.list should be served from the host-value cache");
      },
      getConfig: async () => {
        configReads += 1;
        if (configReads === 8) allConfigReadsStarted.resolve();
        if (configReads <= 8) await allConfigReadsStarted.promise;
        return { captureIssueLifecycle: false };
      },
    });
    const store = new ApertureCompanyStore();
    const companyId = "company-display";
    store.hydrate(companyId, {
      ledger: createEmptyLedger(),
      snapshot: createEmptySnapshot(companyId),
      review: createEmptyReviewState(companyId),
    });
    store.setCachedHostValue(companyId, "agents:all", [], 60_000);
    const reconciliationCacheWrites = vi.spyOn(store, "setCachedReconciledCandidates");
    registerDataHandlers(harness.ctx, store);
    const display = harness.handlers.get("attention-display");
    expect(display).toBeTypeOf("function");

    const reads = Array.from({ length: 8 }, () => display?.({ companyId }));
    await Promise.all(reads);

    expect(harness.listAgents).not.toHaveBeenCalled();
    expect(reconciliationCacheWrites).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent display reconciliations after candidate cache expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const allConfigReadsStarted = deferred<void>();
      const agentsGate = deferred<Agent[]>();
      let configReads = 0;
      const harness = createContext({
        listAgents: () => agentsGate.promise,
        getConfig: async () => {
          configReads += 1;
          if (configReads === 2) allConfigReadsStarted.resolve();
          if (configReads <= 2) await allConfigReadsStarted.promise;
          return { captureIssueLifecycle: false };
        },
      });
      const store = new ApertureCompanyStore();
      const companyId = "company-expired-candidate-cache";
      store.hydrate(companyId, {
        ledger: createEmptyLedger(),
        snapshot: createEmptySnapshot(companyId),
        review: createEmptyReviewState(companyId),
      });
      store.setCachedReconciledCandidates(
        companyId,
        JSON.stringify({
          reconciliationRevision: 0,
          captureIssueLifecycle: false,
          captureRunFailures: true,
        }),
        [],
      );
      vi.setSystemTime(new Date(16_000));
      let candidateLoadCount = 0;
      const originalRunSingleFlight = store.runSingleFlight.bind(store);
      vi.spyOn(store, "runSingleFlight").mockImplementation(
        <T>(companyId: string, namespace: string, key: string, loader: () => Promise<T>) => {
          if (namespace !== "reconciled-candidates") {
            return originalRunSingleFlight(companyId, namespace, key, loader);
          }
          return originalRunSingleFlight(companyId, namespace, key, async () => {
            candidateLoadCount += 1;
            return loader();
          });
        },
      );
      const reconciliationCacheWrites = vi.spyOn(store, "setCachedReconciledCandidates");
      registerDataHandlers(harness.ctx, store);
      const display = harness.handlers.get("attention-display");
      expect(display).toBeTypeOf("function");

      const reads = [display!({ companyId }), display!({ companyId })];
      await allConfigReadsStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
      agentsGate.resolve([]);
      await Promise.all(reads);

      expect(candidateLoadCount).toBe(1);
      expect(reconciliationCacheWrites).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts a rejected host read so a later request can retry", async () => {
    const failureGate = deferred<Agent[]>();
    let fail = true;
    const harness = createContext({
      listAgents: async () => {
        if (fail) return failureGate.promise;
        return [];
      },
    });
    const store = new ApertureCompanyStore();
    const firstReads = Array.from({ length: 8 }, () => (
      loadReconciledCandidates(harness.ctx, store, "company-retry", { captureIssueLifecycle: false })
    ));

    await Promise.resolve();
    const callsBeforeFailure = harness.listAgents.mock.calls.length;
    failureGate.reject(new Error("temporary host read failure"));
    const failures = await Promise.allSettled(firstReads);
    fail = false;
    await expect(loadReconciledCandidates(
      harness.ctx,
      store,
      "company-retry",
      { captureIssueLifecycle: false },
    )).resolves.toEqual([]);

    expect(callsBeforeFailure).toBe(1);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    expect(harness.listAgents).toHaveBeenCalledTimes(2);
  });

  it("does not join or restore a host read invalidated while in flight", async () => {
    const staleGate = deferred<Agent[]>();
    const refreshedGate = deferred<Agent[]>();
    let loadCount = 0;
    const harness = createContext({
      listAgents: () => {
        loadCount += 1;
        return loadCount === 1 ? staleGate.promise : refreshedGate.promise;
      },
    });
    const store = new ApertureCompanyStore();
    const companyId = "company-invalidated";
    const refreshedAgent = { id: "agent-refreshed", status: "idle" } as Agent;
    store.hydrate(companyId, {
      ledger: createEmptyLedger(),
      snapshot: createEmptySnapshot(companyId),
      review: createEmptyReviewState(companyId),
    });

    const staleRead = loadReconciledCandidates(
      harness.ctx,
      store,
      companyId,
      { captureIssueLifecycle: false },
    );
    await Promise.resolve();
    store.invalidateHostCache(companyId, { keys: ["agents:all"] });
    const refreshedRead = loadReconciledCandidates(
      harness.ctx,
      store,
      companyId,
      { captureIssueLifecycle: false },
    );
    await Promise.resolve();

    refreshedGate.resolve([refreshedAgent]);
    await refreshedRead;
    staleGate.resolve([]);
    await staleRead;

    expect(harness.listAgents).toHaveBeenCalledTimes(2);
    expect(store.getCachedHostValue<Agent[]>(companyId, "agents:all")).toEqual([refreshedAgent]);
  });
});
