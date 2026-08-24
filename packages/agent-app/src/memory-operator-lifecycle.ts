import type { MonoAgentConfig } from "@mono-agent/config";
import type { MemoryOperatorIntegrityFailure } from "@mono-agent/memory/bujo";
import {
  MemoryOperatorError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type MemoryOperatorCapability,
  type MemoryOperatorService,
  type MemoryStore,
} from "@mono-agent/agent-contracts";

import type { ChannelId, ChannelStatus, MonoAgentAppLogger, RunningChannel } from "./channels.js";
import { serializeAppOperation } from "./app-controller-operation-tail.js";

type MemoryOperatorWithLifecycle = MemoryOperatorService & {
  drain?(): Promise<void>;
  close?(): Promise<void>;
};

type ExtendedResponder = AgentResponder & {
  startNewSession?(conversationId: string): Promise<void> | void;
  dispose?(): Promise<void>;
};

type GateState =
  | { readonly kind: "accepting" }
  | { readonly kind: "paused"; readonly reason: string }
  | { readonly kind: "degraded"; readonly reason: string }
  | { readonly kind: "stopped"; readonly reason: string };

/**
 * Process-wide admission boundary for responder-owned work that can reach the
 * shared memory store. Pausing is synchronous, so a drain snapshot cannot miss
 * a turn admitted immediately after maintenance begins.
 */
export class MemoryResponderAdmissionGate {
  private state: GateState = { kind: "accepting" };
  private active = 0;
  private readonly drainWaiters = new Set<() => void>();
  private integrityRecoveryRequired = false;
  private healthyOperatorBuiltAfterIntegrityFailure = false;
  private integrityFailureReason: string | undefined;

  status(): GateState {
    return this.state;
  }

  isAccepting(): boolean {
    return this.state.kind === "accepting";
  }

  async pauseAndDrain(
    reason: string,
    options: { readonly allowDegraded?: boolean } = {},
  ): Promise<void> {
    this.pause(reason, options);
    await this.drain();
  }

  pause(
    reason: string,
    options: { readonly allowDegraded?: boolean } = {},
  ): void {
    if (this.state.kind === "stopped"
      || (this.state.kind === "degraded" && options.allowDegraded !== true)) {
      throw unavailableAdmissionError(this.state.reason);
    }
    if (this.state.kind === "degraded" && options.allowDegraded === true
      && this.integrityRecoveryRequired) {
      // A proof belongs to one reload attempt only. If a later lifecycle step
      // failed, the next attempt must construct its own fresh service.
      this.healthyOperatorBuiltAfterIntegrityFailure = false;
    }
    this.state = { kind: "paused", reason };
  }

  async drain(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  resume(): void {
    if (this.state.kind !== "paused") return;
    if (this.integrityRecoveryRequired) {
      this.state = {
        kind: "degraded",
        reason: this.integrityFailureReason
          ?? "Memory action integrity requires an agent reload.",
      };
      return;
    }
    this.state = { kind: "accepting" };
  }

  /** A successful full reload is the only recovery from a degraded memory seam. */
  recoverAfterReload(): boolean {
    if (this.state.kind === "stopped") return false;
    if (this.integrityRecoveryRequired && !this.healthyOperatorBuiltAfterIntegrityFailure) {
      this.state = {
        kind: "degraded",
        reason: this.integrityFailureReason
          ?? "Memory action integrity requires an agent reload.",
      };
      return false;
    }
    this.integrityRecoveryRequired = false;
    this.healthyOperatorBuiltAfterIntegrityFailure = false;
    this.integrityFailureReason = undefined;
    this.state = { kind: "accepting" };
    return true;
  }

  degrade(reason: string): void {
    if (this.state.kind !== "stopped") this.state = { kind: "degraded", reason };
  }

  /** Latch an engine integrity incident until reload constructs a healthy replacement. */
  degradeForIntegrityFailure(reason: string): void {
    if (this.state.kind === "stopped") return;
    this.integrityRecoveryRequired = true;
    this.healthyOperatorBuiltAfterIntegrityFailure = false;
    this.integrityFailureReason = reason;
    this.state = { kind: "degraded", reason };
  }

  /** Record the fresh-service proof required by an integrity-degraded reload. */
  noteHealthyOperatorBuild(): void {
    if (this.integrityRecoveryRequired) {
      this.healthyOperatorBuiltAfterIntegrityFailure = true;
    }
  }

  /** Rituals stay stopped until reload has constructed a healthy replacement service. */
  allowsMemoryRitualStart(): boolean {
    return !this.integrityRecoveryRequired || this.healthyOperatorBuiltAfterIntegrityFailure;
  }

  stop(reason: string): void {
    this.state = { kind: "stopped", reason };
  }

  async stopAndDrain(reason: string): Promise<void> {
    this.stop(reason);
    await this.drain();
  }

  assertAccepting(): void {
    if (this.state.kind !== "accepting") {
      throw unavailableAdmissionError(this.state.reason);
    }
  }

  async runAdmitted<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAccepting();
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0 && this.drainWaiters.size > 0) {
        const waiters = [...this.drainWaiters];
        this.drainWaiters.clear();
        for (const resolve of waiters) resolve();
      }
    }
  }
}

/** Keep every optional responder capability while gating work that can extend a turn. */
export function guardResponderWithMemoryAdmission(
  responder: AgentResponder,
  gate: MemoryResponderAdmissionGate,
): AgentResponder {
  const extended = responder as ExtendedResponder;
  const wrapped: ExtendedResponder = {
    ...extended,
    respond: async (
      request: AgentRequestBase,
      stream: AgentMessageStream,
    ): Promise<AgentResponse> => await gate.runAdmitted(
      async () => await responder.respond(request, stream),
    ),
    ...(responder.cancel === undefined
      ? {}
      : { cancel: responder.cancel.bind(responder) }),
    ...(responder.offerLiveInput === undefined
      ? {}
      : {
          offerLiveInput: (request: Parameters<NonNullable<AgentResponder["offerLiveInput"]>>[0]) => {
            if (!gate.isAccepting()) return { status: "unavailable", reason: "inactive" } as const;
            return responder.offerLiveInput!.call(responder, request);
          },
        }),
    ...(responder.deliverVerbatim === undefined
      ? {}
      : {
          deliverVerbatim: async (...args: Parameters<NonNullable<AgentResponder["deliverVerbatim"]>>) =>
            await gate.runAdmitted(async () => await responder.deliverVerbatim!.call(responder, ...args)),
        }),
    ...(responder.openReplyArtifact === undefined
      ? {}
      : { openReplyArtifact: responder.openReplyArtifact.bind(responder) }),
    ...(responder.loadMcpApp === undefined
      ? {}
      : {
          loadMcpApp: async (...args: Parameters<NonNullable<AgentResponder["loadMcpApp"]>>) =>
            await gate.runAdmitted(async () => await responder.loadMcpApp!.call(responder, ...args)),
        }),
    ...(responder.requestMcpApp === undefined
      ? {}
      : {
          requestMcpApp: async (...args: Parameters<NonNullable<AgentResponder["requestMcpApp"]>>) =>
            await gate.runAdmitted(async () => await responder.requestMcpApp!.call(responder, ...args)),
        }),
    ...(extended.startNewSession === undefined
      ? {}
      : {
          startNewSession: async (conversationId: string) => await gate.runAdmitted(
            async () => await extended.startNewSession!.call(responder, conversationId),
          ),
        }),
    ...(extended.dispose === undefined
      ? {}
      : { dispose: extended.dispose.bind(responder) }),
  };
  return wrapped;
}

export interface MemoryOperatorControllerPort {
  readonly logger: MonoAgentAppLogger | undefined;
  readonly drivers: readonly { readonly id: ChannelId }[];
  readonly running: ReadonlyMap<ChannelId, RunningChannel>;
  readonly memoryResponderGate: MemoryResponderAdmissionGate;
  memoryOperatorValue: MemoryOperatorWithLifecycle | undefined;
  memoryOperatorStore: MemoryStore | undefined;
  memoryOperatorBuild: Promise<MemoryOperatorService | undefined> | undefined;
  configApplyTail: Promise<void>;
  stopped: boolean;
  memoryStore(coreConfig: MonoAgentConfig): Promise<MemoryStore | undefined>;
  stopMemoryRituals(): void;
  startMemoryRitualsIfConfigured(reason: string): Promise<void>;
  setStatus(id: ChannelId, status: ChannelStatus): ChannelStatus;
}

export async function ensureMemoryOperatorService(
  controller: MemoryOperatorControllerPort,
  coreConfig: MonoAgentConfig,
): Promise<MemoryOperatorService | undefined> {
  if (coreConfig.memory === undefined) return undefined;
  const store = await controller.memoryStore(coreConfig);
  if (store === undefined) return undefined;
  if (controller.memoryOperatorValue !== undefined && controller.memoryOperatorStore === store) {
    return controller.memoryOperatorValue;
  }
  if (controller.memoryOperatorBuild !== undefined) return await controller.memoryOperatorBuild;

  const build = (async (): Promise<MemoryOperatorService> => {
    if ((coreConfig.memory?.backend ?? "bujo") === "supermemory") {
      const service = unsupportedSupermemoryOperator();
      controller.memoryOperatorValue = service;
      controller.memoryOperatorStore = store;
      return service;
    }

    const bujo = await import("@mono-agent/memory/bujo");
    if (!(store instanceof bujo.BujoMemoryStore)) {
      throw new MemoryOperatorError(
        "unavailable",
        "Built-in memory operator could not verify the configured store.",
      );
    }
    let integrityFailedDuringBuild = false;
    const service = bujo.createBujoMemoryOperatorService(store, {
      actionsEnabled: coreConfig.memory?.operatorActions?.enabled === true,
      gate: {
        runExclusive: async <T>(mutation: () => Promise<T>): Promise<T> =>
          await runExclusiveMemoryMutation(controller, coreConfig, mutation),
      },
      onIntegrityFailure: (failure) => {
        integrityFailedDuringBuild = true;
        failClosedMemoryOperatorIntegrity(controller, failure);
      },
    });
    if (!integrityFailedDuringBuild) {
      controller.memoryResponderGate.noteHealthyOperatorBuild();
    }
    const guarded = guardMemoryOperatorWithAdmissionHealth(service, controller.memoryResponderGate);
    controller.memoryOperatorValue = guarded;
    controller.memoryOperatorStore = store;
    return guarded;
  })();
  controller.memoryOperatorBuild = build;
  try {
    return await build;
  } finally {
    if (controller.memoryOperatorBuild === build) controller.memoryOperatorBuild = undefined;
  }
}

export async function closeMemoryOperator(controller: MemoryOperatorControllerPort): Promise<void> {
  await controller.memoryOperatorBuild?.catch(() => undefined);
  const service = controller.memoryOperatorValue;
  controller.memoryOperatorValue = undefined;
  controller.memoryOperatorStore = undefined;
  controller.memoryOperatorBuild = undefined;
  if (service === undefined) return;
  if (service.close !== undefined) {
    // The BuJo service's close seam seals admission and abandons any queued
    // gate reservation before waiting for already-entered work. Calling its
    // normal drain() from inside this same lifecycle tail would deadlock a
    // queued mutation whose gate reservation is waiting behind the reload.
    await service.close();
    return;
  }
  await service.drain?.();
}

export async function runExclusiveMemoryMutation<T>(
  controller: MemoryOperatorControllerPort,
  coreConfig: MonoAgentConfig,
  mutation: () => Promise<T>,
): Promise<T> {
  return await serializeAppOperation(controller, async () => {
    if (controller.stopped) {
      throw new MemoryOperatorError("unavailable", "The agent is stopping.");
    }
    controller.memoryResponderGate.pause("Memory maintenance is in progress.");
    controller.stopMemoryRituals();
    await controller.memoryResponderGate.drain();
    let result: T;
    try {
      result = await mutation();
    } catch (error) {
      if (isRecoverableOperatorFailure(error)) {
        try {
          await controller.startMemoryRitualsIfConfigured("memory-operator:rejected");
          controller.memoryResponderGate.resume();
        } catch {
          degradeMemoryAdmission(controller);
        }
      } else {
        degradeMemoryAdmission(controller);
      }
      throw error;
    }
    try {
      await controller.startMemoryRitualsIfConfigured("memory-operator:complete");
      controller.memoryResponderGate.resume();
    } catch {
      // The durable mutation succeeded. Report it truthfully, but keep turn and
      // operator admission closed until a reload reconstructs maintenance.
      degradeMemoryAdmission(controller);
    }
    return result;
  });
}

export function guardMemoryOperatorWithAdmissionHealth(
  service: MemoryOperatorWithLifecycle,
  gate: MemoryResponderAdmissionGate,
): MemoryOperatorWithLifecycle {
  const capability = async (): Promise<MemoryOperatorCapability> => {
    const current = await service.capability();
    const state = gate.status();
    if (state.kind === "accepting") return current;
    return {
      ...current,
      status: "degraded",
      read: false,
      actions: false,
      graph: "unavailable",
      reason: state.kind === "paused"
        ? "Memory maintenance is in progress."
        : "Memory maintenance requires an agent reload.",
    };
  };
  const assertReadAvailable = (): void => {
    const state = gate.status();
    if (state.kind !== "accepting") throw unavailableAdmissionError(state.reason);
  };
  const assertActionAvailable = (): void => {
    assertReadAvailable();
  };
  return {
    capability,
    overview: async () => {
      assertReadAvailable();
      const overview = await service.overview();
      return { ...overview, capability: await capability() };
    },
    records: async (query) => {
      assertReadAvailable();
      return await service.records(query);
    },
    record: async (id) => {
      assertReadAvailable();
      return await service.record(id);
    },
    graph: async (query) => {
      assertReadAvailable();
      return await service.graph(query);
    },
    edit: async (id, input) => {
      assertActionAvailable();
      return await service.edit(id, input);
    },
    forget: async (id, input) => {
      assertActionAvailable();
      return await service.forget(id, input);
    },
    restore: async (id, input) => {
      assertActionAvailable();
      return await service.restore(id, input);
    },
    operation: async (id) => {
      const state = gate.status();
      // Receipt polling may need to observe the mutation that temporarily
      // paused ordinary admission. Once integrity is degraded or the app is
      // stopped, no ledger-derived state may escape through this read seam.
      if (state.kind === "degraded" || state.kind === "stopped") {
        throw unavailableAdmissionError(state.reason);
      }
      return await service.operation(id);
    },
    ...(service.drain === undefined ? {} : { drain: service.drain.bind(service) }),
    ...(service.close === undefined ? {} : { close: service.close.bind(service) }),
  };
}

function unsupportedSupermemoryOperator(): MemoryOperatorWithLifecycle {
  const capability = {
    schema: 1,
    backend: "supermemory",
    status: "unsupported",
    read: false,
    actions: false,
    graph: "unavailable",
    reason: "Supermemory does not expose canonical records through this operator.",
  } as const satisfies MemoryOperatorCapability;
  const unavailable = (): never => {
    throw new MemoryOperatorError(
      "unavailable",
      "Canonical memory records are unavailable for the configured backend.",
    );
  };
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
    records: unavailable,
    record: unavailable,
    graph: unavailable,
    edit: unavailable,
    forget: unavailable,
    restore: unavailable,
    operation: unavailable,
    close: async () => undefined,
  };
}

function isRecoverableOperatorFailure(error: unknown): boolean {
  if (!(error instanceof MemoryOperatorError)) return false;
  return error.code !== "unavailable" || error.details.reason === "capacity";
}

export function degradeMemoryAdmission(
  controller: MemoryOperatorControllerPort,
  reason = "Memory maintenance failed; reload the agent before accepting more turns.",
): void {
  controller.memoryResponderGate.degrade(reason);
  for (const driver of controller.drivers) {
    if (!controller.running.has(driver.id)) continue;
    controller.setStatus(driver.id, { kind: "degraded", reason });
  }
  controller.logger?.error?.("Memory-backed responder admission failed closed.", {});
}

const MEMORY_OPERATOR_INTEGRITY_REASON =
  "Memory action integrity failed; reload the agent before accepting more turns.";

/**
 * Engine integrity notifications can arrive in the constructor or from a pump
 * already running inside the shared lifecycle tail. Keep this callback wholly
 * synchronous: close admission first, cancel future ritual ticks, and publish
 * degraded transport status without reserving or awaiting that same tail.
 */
export function failClosedMemoryOperatorIntegrity(
  controller: MemoryOperatorControllerPort,
  failure: MemoryOperatorIntegrityFailure,
): void {
  controller.memoryResponderGate.degradeForIntegrityFailure(MEMORY_OPERATOR_INTEGRITY_REASON);
  try {
    controller.stopMemoryRituals();
  } catch {
    // Admission is already closed; a diagnostic/cleanup callback cannot reopen it.
  }
  for (const driver of controller.drivers) {
    if (!controller.running.has(driver.id)) continue;
    try {
      controller.setStatus(driver.id, {
        kind: "degraded",
        reason: MEMORY_OPERATOR_INTEGRITY_REASON,
      });
    } catch {
      // Preserve the process-wide admission fence even if a status sink fails.
    }
  }
  try {
    controller.logger?.error?.("Memory action integrity failed closed.", {
      reason: failure.reason,
    });
  } catch {
    // Logging cannot change admission state.
  }
}

function unavailableAdmissionError(reason: string): MemoryOperatorError {
  return new MemoryOperatorError("unavailable", reason);
}
