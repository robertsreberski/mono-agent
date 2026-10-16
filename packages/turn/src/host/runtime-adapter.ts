import type { MonoRuntimeFallbackChainEntry, MonoRuntimeRetryPolicy, MonoRuntimeAttemptContext, MonoRuntimeAttemptResolution, MonoRuntimeAttemptResolver, CreateMonoRuntimeOptions } from "./runtime-options.js";
import { assertParsedRuntimeModelReference, RuntimeAdapterError } from "./model-reference.js";
import { bridgeOwnedForegroundProcesses } from "./owned-foreground-processes.js";
import { createRuntime } from "#turn/runtime/create-runtime";
import { createRouterRuntime } from "#turn/runtime/router";
import { listRuntimeBridges } from "#turn/runtime/bridges";
import { bridgeProcessJobsController } from "./process-jobs.js";
import { monoSandboxImpl } from "./sandbox-impl.js";

import type {
  MonoRuntimeBackendCapabilities,
  MonoRuntimeBackendDescriptor,
  MonoRuntimeHostOptions,
  MonoRuntimeLike,
  MonoRuntimeSupportDescription,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeToolOptions,
} from "./runtime-contracts.js";

type KernelHostOptions = NonNullable<Parameters<typeof createRuntime>[0]>;

export function monoRuntimeSupportsSessionResume(): boolean {
  return PI_RUNTIME_BACKEND.capabilities.supports_session_resume === true;
}

export function monoRuntimeSupportsLiveInput(): boolean {
  return PI_RUNTIME_BACKEND.capabilities.supports_live_input === true;
}

export function monoRuntimeSupportsMcpApps(): boolean {
  return PI_RUNTIME_BACKEND.capabilities.supports_mcp_apps === true;
}

export function describeMonoRuntimeSupport(
  model: RuntimeModelReference,
): MonoRuntimeSupportDescription {
  assertParsedRuntimeModelReference(model);
  return {
    model,
    compatible: true,
    backend: PI_RUNTIME_BACKEND,
  };
}

export function createMonoRuntime(options: CreateMonoRuntimeOptions = {}): MonoRuntimeLike {
  const { fallbackChain, retry, resolveAttempt, sessionTurnReconciliation, ...hostOptions } = options;
  const chain = normalizeFallbackChain(fallbackChain);
  const retryPolicy = normalizeRetryPolicy(retry);
  // agent-runtime's kernel ships only a fail-closed passthrough sandbox (see
  // agent/sandbox-seam.js) — this is the ONE place the real sandbox
  // implementation gets injected, so every mono-agent host's sandbox policy is
  // actually enforced without the kernel depending on this package itself.
  const hostWithSandbox: KernelHostOptions = {
    ...withoutCallerSandbox(hostOptions),
    sandbox: monoSandboxImpl,
  };
  const protectedResolveAttempt = resolveAttempt === undefined
    ? undefined
    : protectAttemptResolver(resolveAttempt);
  const runtime = chain === undefined
    ? createRuntime(hostWithSandbox)
    : createRouterRuntime({
        host: hostWithSandbox,
        chain,
        ...(sessionTurnReconciliation === undefined ? {} : { sessionTurnReconciliation }),
        ...(retryPolicy === undefined ? {} : { retry: retryPolicy }),
        ...(protectedResolveAttempt === undefined
          ? {}
          : {
              resolveAttempt: protectedResolveAttempt,
            }),
      });

  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
        throw new RuntimeAdapterError("invalid_runtime_options", "Runtime system prompt must be a non-empty string.");
      }
      if (runOptions === undefined || runOptions === null || typeof runOptions !== "object") {
        throw new RuntimeAdapterError("invalid_runtime_options", "Runtime run options must be an object.");
      }

      assertParsedRuntimeModelReference(runOptions.model);

      const result = await runtime.run(systemPrompt, {
        ...withoutCallerSandbox(runOptions),
        ...(runOptions.processJobs === undefined
          ? {}
          : { processJobs: bridgeProcessJobsController(runOptions.processJobs) }),
        ...(runOptions.ownedForegroundProcesses === undefined
          ? {}
          : { ownedForegroundProcesses: bridgeOwnedForegroundProcesses(runOptions.ownedForegroundProcesses) }),
      });
      return result;
    },
    async prepareNativeDispatch(systemPrompt, runOptions) {
      if (typeof systemPrompt !== "string" || !systemPrompt.trim() || !runOptions || typeof runOptions !== "object") {
        throw new RuntimeAdapterError("invalid_runtime_options", "Native preparation requires instructions and run options.");
      }
      assertParsedRuntimeModelReference(runOptions.model);
      if (!runtime.prepareNativeDispatch) {
        throw new RuntimeAdapterError("runtime_backend_unavailable", "Native prepared dispatch unavailable.");
      }
      return await runtime.prepareNativeDispatch(systemPrompt, {
        ...withoutCallerSandbox(runOptions),
        ...(runOptions.processJobs === undefined ? {} : { processJobs: bridgeProcessJobsController(runOptions.processJobs) }),
        ...(runOptions.ownedForegroundProcesses === undefined ? {} : { ownedForegroundProcesses: bridgeOwnedForegroundProcesses(runOptions.ownedForegroundProcesses) }),
      });
    },
    configureTools(next?: RuntimeToolOptions): void {
      runtime.configureTools?.(
        next === undefined
          ? undefined
          : withoutCallerSandbox(next),
      );
    },
    ...(runtime.sessionTurnReconciliation === undefined ? {} : { sessionTurnReconciliation: runtime.sessionTurnReconciliation }),
    async reconcileSessionTurn(request) {
      if (!runtime.reconcileSessionTurn) throw new RuntimeAdapterError("runtime_backend_unavailable", "Native turn reconciliation unavailable.");
      return await runtime.reconcileSessionTurn(request);
    },
    async recoverSession(receipt, context): Promise<boolean> {
      return await runtime.recoverSession?.(receipt, context) === true;
    },
    async syncSession(providerSessionId: string): Promise<boolean> {
      return await runtime.syncSession?.(providerSessionId) === true;
    },
    async refreshSession(providerSessionId: string): Promise<void> {
      if (typeof runtime.refreshSession !== "function") {
        throw new RuntimeAdapterError(
          "runtime_backend_unavailable",
          "The runtime cannot guarantee a cold provider-session reopen.",
        );
      }
      await runtime.refreshSession(providerSessionId);
    },
    async salvageDurableSession(providerSessionId: string, sessionsRoot: string) {
      if (!runtime.salvageDurableSession) throw new RuntimeAdapterError("runtime_backend_unavailable", "Durable session salvage unavailable.");
      return runtime.salvageDurableSession(providerSessionId, sessionsRoot);
    },
    async retireDurableSession(providerSessionId: string, sessionsRoot: string, deletion?: import("#kernel/native-journal-types").RuntimeNativeJournalDeletion): Promise<void> {
      if (typeof runtime.retireDurableSession !== "function") {
        throw new RuntimeAdapterError(
          "runtime_backend_unavailable",
          "The runtime cannot retire durable provider-session state.",
        );
      }
      if (deletion === undefined) await runtime.retireDurableSession(providerSessionId, sessionsRoot);
      else await runtime.retireDurableSession(providerSessionId, sessionsRoot, deletion);
    },
    async disposeSession(providerSessionId: string): Promise<boolean> {
      return Boolean(await runtime.disposeSession?.(providerSessionId));
    },
    async invalidateSession(providerSessionId: string): Promise<boolean> {
      return Boolean(await runtime.invalidateSession?.(providerSessionId));
    },
    async disposeAllSessions(): Promise<void> {
      await runtime.disposeAllSessions?.();
    },
  };
}

/**
 * The kernel intentionally supports request/configure-time sandbox implementation
 * replacement for non-mono hosts. The mono facade does not: it owns one concrete
 * implementation and accepts only policy/engine data from callers and plugins.
 * Always return a fresh object so rejecting that implementation never mutates a
 * caller-owned (possibly frozen) option bag.
 */
function withoutCallerSandbox<T extends Readonly<Record<string, unknown>> & { readonly sandbox?: never }>(
  input: T,
): T {
  const { sandbox: _callerSandbox, ...rest } = input;
  // Sandbox is forbidden by the host contract; retain its named fields and open index.
  return rest as T;
}

function protectAttemptResolver(
  resolveAttempt: MonoRuntimeAttemptResolver,
): MonoRuntimeAttemptResolver {
  return async (context) => {
    const resolution = await resolveAttempt(context);
    if (resolution === undefined) {
      return undefined;
    }
    return {
      ...resolution,
      ...(resolution.options === undefined
        ? {}
        : { options: withoutProtectedAttemptOptions(resolution.options) }),
    };
  };
}

function withoutProtectedAttemptOptions<T extends Readonly<Record<string, unknown>>>(
  input: T,
): Omit<T, "sandbox" | "processJobs" | "ownedForegroundProcesses" | "persistArtifact"> {
  const {
    sandbox: _callerSandbox,
    processJobs: _processJobs,
    ownedForegroundProcesses: _ownedForegroundProcesses,
    persistArtifact: _persistArtifact,
    ...rest
  } = input;
  return rest;
}


function normalizeFallbackChain(
  fallbackChain: readonly MonoRuntimeFallbackChainEntry[] | undefined,
): readonly {
  model: RuntimeModelReference;
  effort?: string | null;
  attempts?: number;
}[] | undefined {
  if (fallbackChain === undefined) {
    return undefined;
  }
  if (!Array.isArray(fallbackChain) || fallbackChain.length === 0) {
    throw new RuntimeAdapterError("invalid_runtime_options", "Runtime fallback chain must be a non-empty array.");
  }
  const normalized = fallbackChain.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RuntimeAdapterError(
        "invalid_runtime_options",
        "Each runtime fallback chain entry must be an object with a model reference.",
      );
    }
    assertParsedRuntimeModelReference(entry.model);
    if (
      entry.effort !== undefined
      && entry.effort !== null
      && (typeof entry.effort !== "string" || entry.effort.trim().length === 0 || entry.effort !== entry.effort.trim())
    ) {
      throw new RuntimeAdapterError(
        "invalid_runtime_options",
        "Runtime fallback effort must be a non-empty trimmed string, null, or omitted.",
      );
    }
    if (
      entry.attempts !== undefined
      && (!Number.isInteger(entry.attempts) || entry.attempts < 1 || entry.attempts > 10)
    ) {
      throw new RuntimeAdapterError(
        "invalid_runtime_options",
        "Runtime fallback attempts must be an integer between 1 and 10, or omitted.",
      );
    }
    return {
      model: entry.model,
      ...(entry.effort === undefined ? {} : { effort: entry.effort }),
      ...(entry.attempts === undefined ? {} : { attempts: entry.attempts }),
    };
  });
  return normalized;
}

function normalizeRetryPolicy(
  retry: MonoRuntimeRetryPolicy | undefined,
): MonoRuntimeRetryPolicy | undefined {
  if (retry === undefined) {
    return undefined;
  }
  if (retry === null || typeof retry !== "object" || Array.isArray(retry)) {
    throw new RuntimeAdapterError("invalid_runtime_options", "Runtime retry policy must be an object.");
  }
  for (const key of ["backoffMs", "maxBackoffMs"] as const) {
    const value = retry[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new RuntimeAdapterError(
        "invalid_runtime_options",
        `Runtime retry ${key} must be a non-negative finite number.`,
      );
    }
  }
  return retry;
}

function capabilitiesForRuntimeBridge(
  runtimeBridgeId: string,
): MonoRuntimeBackendCapabilities {
  const bridge = listRuntimeBridges().find((candidate) => candidate.id === runtimeBridgeId);
  if (bridge === undefined) {
    throw new RuntimeAdapterError("runtime_backend_unavailable", "Agent runtime bridge is not registered.", {
      runtimeBridgeId,
    });
  }
  const capabilities = bridge.capabilities();
  if (!isRecord(capabilities) || Array.isArray(capabilities)) {
    throw new RuntimeAdapterError("runtime_backend_unavailable", "Agent runtime bridge returned invalid capabilities.", {
      runtimeBridgeId,
    });
  }
  return { ...capabilities };
}

const PI_RUNTIME_BACKEND = Object.freeze<MonoRuntimeBackendDescriptor>({
  id: "pi-sdk",
  runtimeBridgeId: "pi",
  label: "Pi SDK provider",
  sdk: "pi",
  transport: "sdk",
  providerBoundary: "Pi SDK provider gateway via @mono-agent/turn",
  modelReferenceExamples: Object.freeze(["openai-codex:gpt-5.5", "github-copilot:gpt-4.1"]),
  acceptsProviderIds: true,
  capabilities: Object.freeze(capabilitiesForRuntimeBridge("pi")),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
