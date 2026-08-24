import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MemoryOperatorError,
  type AgentResponder,
} from "@mono-agent/agent-contracts";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";

import { serializeAppOperation } from "../app-controller-operation-tail.js";
import { applyConfigChange, stop as stopAppLifecycle } from "../app-controller-lifecycle.js";
import { startMemoryRitualsIfConfigured } from "../app-controller-maintenance.js";
import {
  closeMemoryOperator,
  ensureMemoryOperatorService,
  failClosedMemoryOperatorIntegrity,
  guardResponderWithMemoryAdmission,
  guardMemoryOperatorWithAdmissionHealth,
  MemoryResponderAdmissionGate,
  runExclusiveMemoryMutation,
  type MemoryOperatorControllerPort,
} from "../memory-operator-lifecycle.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const NULL_STREAM = { append: async () => undefined };

describe("memory operator responder admission", () => {
  it("atomically pauses new turns and drains an already active responder", async () => {
    const response = deferred<{ readonly text: string }>();
    const entered = deferred<void>();
    const gate = new MemoryResponderAdmissionGate();
    const guarded = guardResponderWithMemoryAdmission({
      respond: async () => {
        entered.resolve();
        return await response.promise;
      },
    }, gate);

    const active = guarded.respond({
      conversationId: "web:active",
      text: "hello",
      abortSignal: new AbortController().signal,
    }, NULL_STREAM);
    await entered.promise;
    let drained = false;
    const pause = gate.pauseAndDrain("maintenance").then(() => { drained = true; });

    await expect(guarded.respond(
      {
        conversationId: "web:late",
        text: "too late",
        abortSignal: new AbortController().signal,
      },
      NULL_STREAM,
    )).rejects.toMatchObject({ code: "unavailable" });
    expect(drained).toBe(false);

    response.resolve({ text: "done" });
    await expect(active).resolves.toEqual({ text: "done" });
    await pause;
    expect(drained).toBe(true);
  });

  it("preserves responder controls and rejects a post-pause live-input offer", async () => {
    const cancel = vi.fn();
    const deliverVerbatim = vi.fn(async () => undefined);
    const openReplyArtifact = vi.fn(async () => ({
      attachment: {
        type: "attachment" as const,
        id: "file-one",
        reference: { scheme: "mono-agent-artifact" as const, id: "file-one" },
        name: "file.txt",
        mediaType: "text/plain",
        sizeBytes: 0,
        integrityId: `sha256:${"0".repeat(64)}`,
      },
      body: (async function* () {})(),
    }));
    const loadMcpApp = vi.fn(async () => ({}) as never);
    const requestMcpApp = vi.fn(async () => ({}));
    const dispose = vi.fn(async () => undefined);
    const startNewSession = vi.fn(async () => undefined);
    const responder: AgentResponder & {
      startNewSession(conversationId: string): Promise<void>;
      dispose(): Promise<void>;
    } = {
      respond: async () => ({}),
      offerLiveInput: () => ({ status: "unavailable", reason: "unsupported" }),
      cancel,
      deliverVerbatim,
      openReplyArtifact,
      loadMcpApp,
      requestMcpApp,
      startNewSession,
      dispose,
    };
    const gate = new MemoryResponderAdmissionGate();
    const guarded = guardResponderWithMemoryAdmission(responder, gate) as typeof responder;

    await gate.pauseAndDrain("maintenance");
    expect(guarded.offerLiveInput?.({
      conversationId: "web:one",
      id: "late",
      text: "late",
      receivedAt: new Date().toISOString(),
    })).toEqual({ status: "unavailable", reason: "inactive" });
    guarded.cancel?.("web:one");
    await guarded.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(guarded.openReplyArtifact).toBeTypeOf("function");
    expect(guarded.loadMcpApp).toBeTypeOf("function");
    expect(guarded.requestMcpApp).toBeTypeOf("function");
    await expect(guarded.loadMcpApp?.({} as never)).rejects.toMatchObject({ code: "unavailable" });
    await expect(guarded.requestMcpApp?.({} as never)).rejects.toMatchObject({ code: "unavailable" });
    expect(loadMcpApp).not.toHaveBeenCalled();
    expect(requestMcpApp).not.toHaveBeenCalled();
    expect(startNewSession).not.toHaveBeenCalled();
    expect(deliverVerbatim).not.toHaveBeenCalled();
  });

  it("counts an active MCP App bridge request in the admission drain", async () => {
    const response = deferred<unknown>();
    const entered = deferred<void>();
    const gate = new MemoryResponderAdmissionGate();
    const requestMcpApp = vi.fn(async () => {
      entered.resolve();
      return await response.promise;
    });
    const guarded = guardResponderWithMemoryAdmission({
      respond: async () => ({}),
      requestMcpApp,
    }, gate);

    const active = guarded.requestMcpApp?.({} as never);
    await entered.promise;
    let drained = false;
    const pause = gate.pauseAndDrain("maintenance").then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    response.resolve({ accepted: true });
    await expect(active).resolves.toEqual({ accepted: true });
    await pause;
    expect(drained).toBe(true);
  });
});

describe("memory operator lifecycle serialization", () => {
  it("stops rituals, drains active turns, and resumes only after a successful mutation", async () => {
    const controller = fakeController();
    const gate = controller.memoryResponderGate;
    const turn = deferred<void>();
    const active = gate.runAdmitted(async () => await turn.promise);
    const mutation = vi.fn(async () => "applied");
    const operation = runExclusiveMemoryMutation(controller, coreConfig(), mutation);

    await Promise.resolve();
    expect(mutation).not.toHaveBeenCalled();
    expect(gate.status().kind).toBe("paused");
    expect(controller.stopMemoryRituals).toHaveBeenCalledOnce();
    turn.resolve();
    await active;

    await expect(operation).resolves.toBe("applied");
    expect(mutation).toHaveBeenCalledOnce();
    expect(controller.stopMemoryRituals).toHaveBeenCalledOnce();
    expect(controller.startMemoryRitualsIfConfigured).toHaveBeenCalledOnce();
    expect(gate.status()).toEqual({ kind: "accepting" });
  });

  it("fails closed and degrades running channels after an unrecoverable mutation", async () => {
    const controller = fakeController();
    await expect(runExclusiveMemoryMutation(controller, coreConfig(), async () => {
      throw new Error("durable replay failed");
    })).rejects.toThrow("durable replay failed");

    expect(controller.memoryResponderGate.status().kind).toBe("degraded");
    expect(controller.statuses.get("tui")).toMatchObject({ kind: "degraded" });
    await expect(controller.memoryResponderGate.runAdmitted(async () => "late"))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it.each([
    ["revision conflict", "revision_conflict"],
    ["idempotency conflict", "idempotency_conflict"],
    ["invalid confirmation", "confirmation_invalid"],
  ] as const)("resumes after a rejected %s mutation", async (_label, code) => {
    const controller = fakeController();
    await expect(runExclusiveMemoryMutation(controller, coreConfig(), async () => {
      throw new MemoryOperatorError(code, "The action was rejected.");
    })).rejects.toMatchObject({ code });

    expect(controller.memoryResponderGate.status()).toEqual({ kind: "accepting" });
    expect(controller.statuses.get("tui")).toMatchObject({ kind: "running" });
    expect(controller.startMemoryRitualsIfConfigured).toHaveBeenCalledOnce();
  });

  it("resumes after a controlled ledger-capacity stop inside the mutation gate", async () => {
    const controller = fakeController();
    const capacity = new MemoryOperatorError(
      "unavailable",
      "Memory action state exceeds its durable bound.",
      { reason: "capacity" },
    );

    await expect(runExclusiveMemoryMutation(controller, coreConfig(), async () => {
      throw capacity;
    })).rejects.toBe(capacity);

    expect(controller.memoryResponderGate.status()).toEqual({ kind: "accepting" });
    expect(controller.statuses.get("tui")).toMatchObject({ kind: "running" });
    expect(controller.startMemoryRitualsIfConfigured).toHaveBeenCalledOnce();
  });

  it("fails closed synchronously when a live operator reports an async pump integrity failure", async () => {
    const controller = fakeController();
    const operator = guardMemoryOperatorWithAdmissionHealth(
      operatorFixture(),
      controller.memoryResponderGate,
    );
    controller.memoryOperatorValue = operator;
    const tail = controller.configApplyTail;
    let publishedAtStop = false;
    controller.stopMemoryRituals.mockImplementation(() => {
      publishedAtStop = controller.memoryOperatorValue === operator;
    });
    const provider = vi.fn(async () => ({ text: "provider must stay dark" }));
    const responder = guardResponderWithMemoryAdmission(
      { respond: provider },
      controller.memoryResponderGate,
    );

    failClosedMemoryOperatorIntegrity(controller, {
      code: "unavailable",
      reason: "pump",
      message: "Memory action recovery did not complete.",
    });

    expect(controller.configApplyTail).toBe(tail);
    expect(publishedAtStop).toBe(true);
    expect(controller.stopMemoryRituals).toHaveBeenCalledOnce();
    expect(controller.memoryResponderGate.status()).toMatchObject({ kind: "degraded" });
    expect(controller.memoryResponderGate.allowsMemoryRitualStart()).toBe(false);
    expect(controller.statuses.get("tui")).toMatchObject({ kind: "degraded" });
    await expect(responder.respond({
      conversationId: "web:after-pump-failure",
      text: "must not reach provider",
      abortSignal: new AbortController().signal,
    }, NULL_STREAM)).rejects.toMatchObject({ code: "unavailable" });
    await expect(operator.records({})).rejects.toMatchObject({ code: "unavailable" });
    expect(provider).not.toHaveBeenCalled();

    controller.memoryResponderGate.resume();
    expect(controller.memoryResponderGate.status()).toMatchObject({ kind: "degraded" });
    expect(controller.memoryResponderGate.recoverAfterReload()).toBe(false);
    expect(controller.memoryResponderGate.status()).toMatchObject({ kind: "degraded" });
  });

  it("does not arm rituals after an integrity callback during eager startup", async () => {
    const gate = new MemoryResponderAdmissionGate();
    gate.degradeForIntegrityFailure("Memory action integrity failed; reload required.");
    const configAccess = vi.fn(() => {
      throw new Error("startup must stop before config or store access");
    });

    await expect(startMemoryRitualsIfConfigured({
      stopped: false,
      memoryResponderGate: gate,
      get env() { return configAccess(); },
    } as never, "startup")).resolves.toBeUndefined();
    expect(configAccess).not.toHaveBeenCalled();
  });

  it("keeps a reload degraded when it does not construct a fresh healthy operator", async () => {
    const gate = new MemoryResponderAdmissionGate();
    gate.degradeForIntegrityFailure("Memory action integrity failed; reload required.");
    const degrade = vi.fn((reason?: string) => {
      gate.degrade(reason ?? "degraded");
    });
    const controller = {
      drivers: [],
      driversById: new Map(),
      running: new Map(),
      startsInFlight: new Map(),
      activeRuntimes: [],
      memoryResponderGate: gate,
      configApplyTail: Promise.resolve(),
      stopped: false,
      invalidateMemoryHealthRefresh: () => undefined,
      stopContinuationService: async () => undefined,
      stopProcessJobsService: async () => undefined,
      stopInteractionBridge: async () => undefined,
      stopMemoryRituals: () => undefined,
      stopArtifactRetentionScheduler: () => undefined,
      resetSharedMemory: async () => undefined,
      closeMemoryOperator: async () => undefined,
      prepareMemoryOperatorForLifecycle: async () => undefined,
      degradeMemoryAdmission: degrade,
      stopTraceSource: async () => undefined,
      refreshSandboxStatus: async () => ({}),
      startTraceability: async () => ({}),
      startExporters: async () => ({}),
      startContinuationServiceIfConfigured: async () => undefined,
      prepareProcessJobsProtection: async () => undefined,
      startProcessJobsIfConfigured: async () => undefined,
      activateProcessJobWakes: async () => undefined,
      startMemoryRitualsIfConfigured: async () => undefined,
      refreshMemoryHealthAfterLifecycle: async () => undefined,
      applyResult: () => ({ kind: "applied", message: "reloaded", transports: [] }),
    } as never;

    await expect(applyConfigChange(controller, "test-reload")).resolves.toMatchObject({
      kind: "failed",
      message: expect.stringContaining("Memory action integrity failed; reload required."),
    });
    expect(degrade).toHaveBeenCalledWith("Memory action integrity failed; reload required.");
    expect(gate.status()).toEqual({
      kind: "degraded",
      reason: "Memory action integrity failed; reload required.",
    });
  });

  it("keeps non-integrity request and capacity errors outside responder degradation", async () => {
    const gate = new MemoryResponderAdmissionGate();
    for (const error of [
      new MemoryOperatorError("revision_conflict", "The record changed."),
      new MemoryOperatorError("idempotency_conflict", "The key is already bound."),
      new MemoryOperatorError("confirmation_invalid", "The confirmation expired."),
      new MemoryOperatorError("unavailable", "Memory action history capacity is exhausted."),
    ]) {
      const service = guardMemoryOperatorWithAdmissionHealth({
        ...operatorFixture(),
        edit: async () => { throw error; },
      }, gate);
      await expect(service.edit("memory-one", {
        expectedRevision: "revision-one",
        idempotencyKey: "ordinary-rejection",
        patch: { text: "replacement" },
      })).rejects.toBe(error);
      expect(gate.status()).toEqual({ kind: "accepting" });
      expect(gate.allowsMemoryRitualStart()).toBe(true);
    }
  });

  it("reserves the same lifecycle tail before a mutation receipt can race reload or stop", async () => {
    const controller = fakeController();
    const mutationStarted = deferred<void>();
    const finishMutation = deferred<void>();
    const order: string[] = [];
    const action = runExclusiveMemoryMutation(controller, coreConfig(), async () => {
      order.push("mutation:start");
      mutationStarted.resolve();
      await finishMutation.promise;
      order.push("mutation:end");
    });
    await mutationStarted.promise;

    const lifecycle = serializeAppOperation(controller, async () => {
      order.push("lifecycle");
    });
    await Promise.resolve();
    expect(order).toEqual(["mutation:start"]);

    finishMutation.resolve();
    await action;
    await lifecycle;
    expect(order).toEqual(["mutation:start", "mutation:end", "lifecycle"]);
  });

  it("advertises and enforces provider-free read/action degradation after failure", async () => {
    const gate = new MemoryResponderAdmissionGate();
    const records = vi.fn(async () => ({ records: [] }));
    const graph = vi.fn(async () => ({ fidelity: "captured" as const, nodes: [], edges: [] }));
    const service = guardMemoryOperatorWithAdmissionHealth({
      capability: () => ({
        schema: 1,
        backend: "builtin",
        tier: "bujo",
        status: "ready",
        read: true,
        actions: true,
        graph: "captured",
      }),
      overview: () => ({
        generatedAt: new Date().toISOString(),
        capability: {
          schema: 1,
          backend: "builtin",
          tier: "bujo",
          status: "ready",
          read: true,
          actions: true,
          graph: "captured",
        },
        counts: {
          total: 0,
          active: 0,
          superseded: 0,
          forgotten: 0,
          byType: { task: 0, event: 0, note: 0 },
        },
        access: { totalCount: 0, accessedRecords: 0 },
      }),
      records,
      record: async () => { throw new Error("not used"); },
      graph,
      edit: async () => { throw new Error("not used"); },
      forget: async () => { throw new Error("not used"); },
      restore: async () => { throw new Error("not used"); },
      operation: async () => { throw new Error("not used"); },
    }, gate);

    gate.degrade("replay failed");
    await expect(service.capability()).resolves.toMatchObject({
      status: "degraded",
      read: false,
      actions: false,
      graph: "unavailable",
    });
    await expect(service.records({})).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.graph({})).rejects.toMatchObject({ code: "unavailable" });
    expect(records).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });

  it("closes operator read/action admission while maintenance is paused but permits receipt polling", async () => {
    const gate = new MemoryResponderAdmissionGate();
    const service = guardMemoryOperatorWithAdmissionHealth(operatorFixture(), gate);
    await gate.pauseAndDrain("maintenance");

    await expect(service.capability()).resolves.toMatchObject({
      status: "degraded",
      read: false,
      actions: false,
      graph: "unavailable",
    });
    await expect(service.records({})).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.edit("memory-one", {
      expectedRevision: "revision-one",
      idempotencyKey: "edit-one",
      patch: { text: "replacement" },
    })).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.operation("operation-one")).rejects.toThrow("receipt probe");
  });

  it.each(["degraded", "stopped"] as const)(
    "blocks operation receipt reads before touching the service while %s",
    async (state) => {
      const gate = new MemoryResponderAdmissionGate();
      const operation = vi.fn(async () => ({ id: "operation-one" }) as never);
      const service = guardMemoryOperatorWithAdmissionHealth({
        ...operatorFixture(),
        operation,
      }, gate);
      if (state === "degraded") gate.degrade("integrity failed");
      else gate.stop("agent stopped");

      await expect(service.operation("operation-one")).rejects.toMatchObject({ code: "unavailable" });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it("cancels a hung admitted turn before draining during config reload", async () => {
    const gate = new MemoryResponderAdmissionGate();
    const turn = deferred<void>();
    const active = gate.runAdmitted(async () => await turn.promise);
    const order: string[] = [];
    const controller = fakeLifecycleController(gate, () => {
      order.push("channel:stop");
      turn.resolve();
    }, order);

    await expect(applyConfigChange(controller, "hung-turn-reload")).resolves.toMatchObject({
      kind: "applied",
    });
    await active;
    expect(order.indexOf("channel:stop")).toBeLessThan(order.indexOf("memory:close"));
  });

  it("cancels a hung admitted turn before draining during app stop", async () => {
    const gate = new MemoryResponderAdmissionGate();
    const turn = deferred<void>();
    const active = gate.runAdmitted(async () => await turn.promise);
    const order: string[] = [];
    const controller = fakeLifecycleController(gate, () => {
      order.push("channel:stop");
      turn.resolve();
    }, order);

    await expect(stopAppLifecycle(controller)).resolves.toBeUndefined();
    await active;
    expect(order.indexOf("channel:stop")).toBeLessThan(order.indexOf("memory:close"));
    expect(gate.status()).toMatchObject({ kind: "stopped" });
  });

  it("keeps actions off when bujo config resolves to the actual journal tier", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-app-memory-operator-journal-"));
    const store = createBujoMemoryStore({
      root,
      embeddings: {
        id: "test-journal",
        embed: async (texts) => texts.map(() => [0, 0]),
      },
      dim: 2,
    });
    const controller = fakeController();
    controller.memoryStore = async () => store;
    const config = {
      ...coreConfig(),
      memory: {
        backend: "bujo",
        mode: "bujo",
        path: root,
        maxBytes: 8_000,
        writeMode: "capture",
        operatorActions: { enabled: true },
      },
    } as never;

    try {
      const service = await ensureMemoryOperatorService(controller, config);
      await expect(service?.capability()).resolves.toMatchObject({
        tier: "journal",
        read: true,
        actions: false,
        graph: "unavailable",
      });
    } finally {
      await closeMemoryOperator(controller);
      await store.close();
    }
  });

  it("fails closed during initial operator construction and recovers only after a healthy reload build", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-app-memory-operator-integrity-"));
    const ledger = join(root, ".memory-operator-v1.json");
    const store = createBujoMemoryStore({
      root,
      embeddings: {
        id: "test-integrity",
        embed: async (texts) => texts.map(() => [0, 0]),
      },
      dim: 2,
    });
    await writeFile(ledger, "not-json\n", { encoding: "utf8", mode: 0o600 });
    const controller = fakeController();
    controller.memoryStore = async () => store;
    const config = memoryConfig(root);
    let operatorValueAtStop: unknown = "not-called";
    controller.stopMemoryRituals.mockImplementation(() => {
      operatorValueAtStop = controller.memoryOperatorValue;
    });
    const provider = vi.fn(async () => ({ text: "provider reached" }));
    const responder = guardResponderWithMemoryAdmission(
      { respond: provider },
      controller.memoryResponderGate,
    );

    try {
      const service = await ensureMemoryOperatorService(controller, config);
      expect(operatorValueAtStop).toBeUndefined();
      expect(controller.stopMemoryRituals).toHaveBeenCalledOnce();
      expect(controller.memoryResponderGate.status()).toMatchObject({ kind: "degraded" });
      expect(controller.memoryResponderGate.allowsMemoryRitualStart()).toBe(false);
      expect(controller.statuses.get("tui")).toMatchObject({ kind: "degraded" });
      expect(JSON.stringify({
        gate: controller.memoryResponderGate.status(),
        channel: controller.statuses.get("tui"),
      })).not.toContain(root);
      await expect(service?.capability()).resolves.toMatchObject({
        status: "degraded",
        read: false,
        actions: false,
        graph: "unavailable",
      });
      await expect(service?.records({})).rejects.toMatchObject({ code: "unavailable" });
      await expect(service?.edit("memory-one", {
        expectedRevision: "revision-one",
        idempotencyKey: "blocked-after-startup-integrity",
        patch: { text: "replacement" },
      })).rejects.toMatchObject({ code: "unavailable" });
      await expect(responder.respond({
        conversationId: "web:startup-integrity",
        text: "must stay provider-zero",
        abortSignal: new AbortController().signal,
      }, NULL_STREAM)).rejects.toMatchObject({ code: "unavailable" });
      expect(provider).not.toHaveBeenCalled();

      expect(controller.memoryResponderGate.recoverAfterReload()).toBe(false);
      expect(controller.memoryResponderGate.status()).toMatchObject({ kind: "degraded" });
      await closeMemoryOperator(controller);
      await rm(ledger);
      controller.memoryResponderGate.pause("Agent configuration is reloading.", { allowDegraded: true });
      await expect(ensureMemoryOperatorService(controller, config)).resolves.toBeDefined();
      expect(controller.memoryResponderGate.allowsMemoryRitualStart()).toBe(true);
      expect(controller.memoryResponderGate.recoverAfterReload()).toBe(true);
      expect(controller.memoryResponderGate.status()).toEqual({ kind: "accepting" });
      await expect(responder.respond({
        conversationId: "web:after-healthy-reload",
        text: "provider may resume",
        abortSignal: new AbortController().signal,
      }, NULL_STREAM)).resolves.toEqual({ text: "provider reached" });
      expect(provider).toHaveBeenCalledOnce();
    } finally {
      await closeMemoryOperator(controller);
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advertises Supermemory as unsupported without exposing its store", async () => {
    const controller = fakeController();
    const store = {
      load: async () => undefined,
      appendHostSummary: async (conversationId: string) => ({
        conversationId,
        source: "remote",
        bytesWritten: 0,
      }),
    };
    controller.memoryStore = async () => store;
    const config = {
      ...coreConfig(),
      memory: {
        backend: "supermemory",
        mode: "bujo",
        path: "/must-not-be-exposed",
        maxBytes: 8_000,
        writeMode: "capture",
        supermemory: { baseUrl: "https://memory.invalid" },
        operatorActions: { enabled: true },
      },
    } as never;

    const service = await ensureMemoryOperatorService(controller, config);
    await expect(Promise.resolve(service?.capability())).resolves.toEqual({
      schema: 1,
      backend: "supermemory",
      status: "unsupported",
      read: false,
      actions: false,
      graph: "unavailable",
      reason: "Supermemory does not expose canonical records through this operator.",
    });
    expect(JSON.stringify(await service?.capability())).not.toContain("must-not-be-exposed");
    await closeMemoryOperator(controller);
  });
});

function operatorFixture() {
  const capability = {
    schema: 1,
    backend: "builtin",
    tier: "bujo",
    status: "ready",
    read: true,
    actions: true,
    graph: "captured",
  } as const;
  return {
    capability: () => capability,
    overview: () => ({
      generatedAt: new Date().toISOString(),
      capability,
      counts: {
        total: 0,
        active: 0,
        superseded: 0,
        forgotten: 0,
        byType: { task: 0, event: 0, note: 0 },
      },
      access: { totalCount: 0, accessedRecords: 0 },
    }),
    records: async () => ({ records: [] }),
    record: async () => { throw new Error("not used"); },
    graph: async () => ({ fidelity: "captured" as const, nodes: [], edges: [] }),
    edit: async () => { throw new Error("action should be gated"); },
    forget: async () => { throw new Error("action should be gated"); },
    restore: async () => { throw new Error("action should be gated"); },
    operation: async () => { throw new Error("receipt probe"); },
  };
}

function fakeController(): MemoryOperatorControllerPort & {
  readonly stopMemoryRituals: ReturnType<typeof vi.fn>;
  readonly startMemoryRitualsIfConfigured: ReturnType<typeof vi.fn>;
  readonly statuses: Map<string, { kind: "running"; summary: Record<string, unknown> } | { kind: "degraded"; reason: string }>;
} {
  const statuses = new Map<string, { kind: "running"; summary: Record<string, unknown> } | { kind: "degraded"; reason: string }>([
    ["tui", { kind: "running", summary: {} }],
  ]);
  const stopMemoryRituals = vi.fn();
  const startMemoryRitualsIfConfigured = vi.fn(async () => undefined);
  return {
    logger: undefined,
    drivers: [{ id: "tui" }],
    running: new Map([["tui", { summary: {}, stop: async () => undefined }]]),
    statuses,
    memoryResponderGate: new MemoryResponderAdmissionGate(),
    memoryOperatorValue: undefined,
    memoryOperatorStore: undefined,
    memoryOperatorBuild: undefined,
    configApplyTail: Promise.resolve(),
    stopped: false,
    memoryStore: async () => undefined,
    stopMemoryRituals,
    startMemoryRitualsIfConfigured,
    setStatus: (id, status) => {
      statuses.set(id, status as never);
      return status;
    },
  };
}

function fakeLifecycleController(
  memoryResponderGate: MemoryResponderAdmissionGate,
  onStopChannel: () => void,
  order: string[],
) {
  const driver = { id: "tui", label: "TUI" } as never;
  return {
    drivers: [driver],
    driversById: new Map([["tui", driver]]),
    running: new Map(),
    startsInFlight: new Map(),
    activeRuntimes: [],
    memoryResponderGate,
    configApplyTail: Promise.resolve(),
    stopped: false,
    invalidateMemoryHealthRefresh: () => undefined,
    stopChannel: async () => { onStopChannel(); },
    stopContinuationService: async () => undefined,
    stopProcessJobsService: async () => undefined,
    stopInteractionBridge: async () => undefined,
    stopMemoryRituals: () => undefined,
    stopArtifactRetentionScheduler: () => undefined,
    resetSharedMemory: async () => undefined,
    closeMemoryOperator: async () => { order.push("memory:close"); },
    prepareMemoryOperatorForLifecycle: async () => undefined,
    degradeMemoryAdmission: (reason?: string) => {
      memoryResponderGate.degrade(reason ?? "degraded");
    },
    stopTraceSource: async () => undefined,
    refreshSandboxStatus: async () => ({}),
    startTraceability: async () => ({}),
    startExporters: async () => ({}),
    startContinuationServiceIfConfigured: async () => undefined,
    prepareProcessJobsProtection: async () => undefined,
    startProcessJobsIfConfigured: async () => undefined,
    activateProcessJobWakes: async () => undefined,
    startChannelIfConfigured: async () => ({ kind: "running", summary: {} }),
    startMemoryRitualsIfConfigured: async () => undefined,
    refreshMemoryHealthAfterLifecycle: async () => undefined,
    applyResult: () => ({ kind: "applied", message: "reloaded", transports: [] }),
    channelStatus: () => ({ kind: "running", summary: {} }),
    refreshTraceSource: async () => undefined,
    startChannel: async () => ({ kind: "running", summary: {} }),
    releaseAgentRootOwnership: async () => undefined,
  } as never;
}

function coreConfig(): Parameters<typeof runExclusiveMemoryMutation>[1] {
  return {
    runtime: { model: { sdk: "codex", model: "gpt-5" }, workspace: "/tmp" },
    context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
    tools: { disallowedTools: [] },
  } as never;
}

function memoryConfig(root: string): Parameters<typeof ensureMemoryOperatorService>[1] {
  return {
    ...coreConfig(),
    memory: {
      backend: "bujo",
      mode: "bujo",
      path: root,
      maxBytes: 8_000,
      writeMode: "capture",
      operatorActions: { enabled: true },
    },
  } as never;
}
