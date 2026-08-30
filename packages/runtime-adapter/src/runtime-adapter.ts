import {
  createPiOAuthApiKeyResolver,
  createRouterRuntime,
  createRuntime,
} from "@mono-agent/agent-runtime";
import { parseRuntimeModelReference } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@mono-agent/agent-runtime/ai/runtime/registry.js";
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
} from "./types.js";

type KernelRuntimeInstance = ReturnType<typeof createRuntime>;
type KernelHostOptions = NonNullable<Parameters<typeof createRuntime>[0]>;
type KernelRouterOptions = NonNullable<Parameters<typeof createRouterRuntime>[0]>;
type KernelRunOptions = Parameters<KernelRuntimeInstance["run"]>[1];
type KernelToolOptions = Parameters<KernelRuntimeInstance["configureTools"]>[0];

export type RuntimeAdapterErrorCode =
  | "invalid_model_reference"
  | "runtime_backend_unavailable"
  | "invalid_runtime_options"
  | "invalid_local_provider";

export interface RuntimeAdapterErrorDetails {
  readonly code?: RuntimeAdapterErrorCode;
  readonly [key: string]: unknown;
}

export class RuntimeAdapterError extends Error {
  readonly code: RuntimeAdapterErrorCode;
  readonly details: RuntimeAdapterErrorDetails;

  constructor(code: RuntimeAdapterErrorCode, message: string, details: RuntimeAdapterErrorDetails = {}) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export function parseMonoRuntimeModelReference(value: string): RuntimeModelReference {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_model_reference", "Model reference must be a non-empty trimmed string.");
  }

  try {
    return normalizeRuntimeModelReference(parseRuntimeModelReference(value));
  } catch (error) {
    throw new RuntimeAdapterError("invalid_model_reference", "Invalid runtime model reference.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Stable canonical string for a model reference — its authored `reference` when
 * present, else `sdk[:provider]:model`. The one place this format lives, so
 * callers comparing/caching/keying by model (harness override selection, app
 * runtime cache, host/doctor display ids) stay in agreement.
 */
export function modelReferenceKey(model: RuntimeModelReference): string {
  return model.reference ?? `${model.sdk}:${model.provider === undefined ? "" : `${model.provider}:`}${model.model}`;
}

export function listMonoRuntimeBackends(): readonly MonoRuntimeBackendDescriptor[] {
  return MONO_RUNTIME_BACKENDS;
}

export function runtimeBackendForModel(
  model: RuntimeModelReference,
): MonoRuntimeBackendDescriptor {
  assertParsedRuntimeModelReference(model);
  return PI_RUNTIME_BACKEND;
}

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

export interface MonoRuntimeFallbackChainEntry {
  readonly model: RuntimeModelReference;
  /** String pins this route, `null` selects the provider default, omitted inherits the run effort. */
  readonly effort?: string | null;
  /**
   * Total attempts on this route including the first, 1–10. Omitted means a
   * single shot. A retry re-runs the whole logical turn on the same model and
   * only fires for transient provider failures.
   */
  readonly attempts?: number;
}

export interface MonoRuntimeRetryPolicy {
  /** Delay before the first retry; doubles per retry. Defaults to 1000. */
  readonly backoffMs?: number;
  /** Ceiling for the doubled delay. Defaults to 15000. */
  readonly maxBackoffMs?: number;
}

export interface MonoRuntimeAttemptContext {
  readonly model: RuntimeModelReference;
  /** Index of this route in the chain. Stable across same-model retries. */
  readonly attemptIndex: number;
  /** 0 for the first try of a route, then 1, 2, … for each same-model retry. */
  readonly retryIndex: number;
}

export interface MonoRuntimeAttemptResolution {
  /** Optional isolated runtime for this route. */
  readonly runtime?: MonoRuntimeLike;
  /** Private per-attempt provider options. These are never copied into router telemetry. */
  readonly options?: Readonly<Record<string, unknown>> & {
    /** The sandbox implementation is owned by createMonoRuntime. */
    readonly sandbox?: never;
    /** Logical Codex network policy is caller-owned and resolver-protected. */
    readonly codexSandboxNetworkAccess?: never;
    /** Attempt plugins cannot replace the host's durable process-job owner. */
    readonly processJobs?: never;
  };
  /** Provider-specific projection of the logical tool policy for this attempt. */
  readonly policyOptions?: Readonly<Pick<
    RuntimeRunOptions,
    "allowedTools" | "disallowedTools" | "permissionMode"
  >>;
  readonly cleanup?: () => void | Promise<void>;
}

export type MonoRuntimeAttemptResolver = (
  context: MonoRuntimeAttemptContext,
) => MonoRuntimeAttemptResolution | undefined | Promise<MonoRuntimeAttemptResolution | undefined>;

export interface CreateMonoRuntimeOptions extends MonoRuntimeHostOptions {
  /** The sandbox implementation is owned and injected by runtime-adapter. */
  readonly sandbox?: never;
  /**
   * Ordered model chain for provider failover. When present, runs are served by
   * the agent-runtime fallback router: the first entry is attempted first and
   * each retryable provider failure advances to the next entry, so callers
   * should put the primary model at index 0. The router overrides the per-run
   * `model` with chain entries; failover details are reported on the result as
   * `failoverHistory`.
   */
  readonly fallbackChain?: readonly MonoRuntimeFallbackChainEntry[];
  /** Backoff shape for same-model retries. Per-route counts live on each chain entry's `attempts`. */
  readonly retry?: MonoRuntimeRetryPolicy;
  /** Private host seam for actual-model provider options and route-owned runtimes. */
  readonly resolveAttempt?: MonoRuntimeAttemptResolver;
}

export function createMonoRuntime(options: CreateMonoRuntimeOptions = {}): MonoRuntimeLike {
  const { fallbackChain, retry, resolveAttempt, ...hostOptions } = options;
  const chain = normalizeFallbackChain(fallbackChain);
  const retryPolicy = normalizeRetryPolicy(retry);
  // agent-runtime's kernel ships only a fail-closed passthrough sandbox (see
  // agent/sandbox-seam.js) — this is the ONE place the real sandbox
  // implementation gets injected, so every mono-agent host's sandbox policy is
  // actually enforced without the kernel depending on this package itself.
  const hostWithSandbox = {
    ...withoutCallerSandbox(hostOptions),
    sandbox: monoSandboxImpl,
  } as unknown as KernelHostOptions;
  const protectedResolveAttempt = resolveAttempt === undefined
    ? undefined
    : protectAttemptResolver(resolveAttempt);
  const runtime = chain === undefined
    ? createRuntime(hostWithSandbox)
    : createRouterRuntime({
        host: hostWithSandbox,
        chain,
        ...(retryPolicy === undefined ? {} : { retry: retryPolicy }),
        ...(protectedResolveAttempt === undefined
          ? {}
          : {
              resolveAttempt: protectedResolveAttempt as unknown as NonNullable<KernelRouterOptions["resolveAttempt"]>,
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
      } as unknown as KernelRunOptions);
      return result as RuntimeResult;
    },
    configureTools(next?: RuntimeToolOptions): void {
      runtime.configureTools?.(
        next === undefined
          ? undefined
          : (withoutCallerSandbox(next) as unknown as KernelToolOptions),
      );
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
    async retireDurableSession(providerSessionId: string, sessionsRoot: string): Promise<void> {
      if (typeof runtime.retireDurableSession !== "function") {
        throw new RuntimeAdapterError(
          "runtime_backend_unavailable",
          "The runtime cannot retire durable provider-session state.",
        );
      }
      await runtime.retireDurableSession(providerSessionId, sessionsRoot);
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
function withoutCallerSandbox<T extends Readonly<Record<string, unknown>>>(
  input: T,
): Omit<T, "sandbox"> {
  const { sandbox: _callerSandbox, ...rest } = input;
  return rest;
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
): Omit<T, "sandbox" | "processJobs"> {
  const { sandbox: _callerSandbox, processJobs: _processJobs, ...rest } = input;
  return rest;
}

export { createPiOAuthApiKeyResolver };

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

export function assertParsedRuntimeModelReference(value: unknown): asserts value is RuntimeModelReference {
  normalizeRuntimeModelReference(value);
}

function normalizeRuntimeModelReference(value: unknown): RuntimeModelReference {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new RuntimeAdapterError(
      "invalid_model_reference",
      "Runtime model reference must be a parsed object with sdk and model.",
    );
  }

  const sdk = normalizedRequiredString(value.sdk, "sdk");
  const model = normalizedRequiredString(value.model, "model");
  const normalized: { sdk: string; model: string; provider?: string; reference?: string } = { sdk, model };

  if (value.provider !== undefined) {
    normalized.provider = normalizedRequiredString(value.provider, "provider");
  }
  if (value.reference !== undefined) {
    normalized.reference = normalizedRequiredString(value.reference, "reference");
  }

  return normalized;
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
  providerBoundary: "Pi SDK provider gateway via @mono-agent/agent-runtime",
  modelReferenceExamples: Object.freeze(["pi:openai-codex:gpt-5.5", "pi:github-copilot:gpt-4.1"]),
  acceptsProviderIds: true,
  capabilities: Object.freeze(capabilitiesForRuntimeBridge("pi")),
});

const MONO_RUNTIME_BACKENDS = Object.freeze([PI_RUNTIME_BACKEND]);

function normalizedRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_model_reference", `Runtime model reference ${field} must be a non-empty trimmed string.`, {
      field,
    });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
