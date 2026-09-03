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

/**
 * A model reference is operator-supplied and otherwise unbounded: nothing stops a token, an
 * API key, or a URL with credentials being pasted into a model field by mistake. Whatever
 * lands there is echoed back by `mono-agent validate`, `doctor`, the daemon log and launchd's
 * captured stdout -- all durable and routinely shared. Those surfaces are also line-oriented,
 * so an embedded newline lets one config value forge diagnostic lines that read as the
 * loader's own.
 *
 * The rule, therefore, is not "trim model ids": it is that no operator-supplied text reaches a
 * diagnostic without being reduced to printable single-line text AND bounded.
 *
 * This is a DISPLAY budget, and it is deliberately its own number rather than the parser's
 * acceptance ceiling. A previous round defined it as `MAX_MODEL_REFERENCE_BYTES` on the rule
 * "a reference is accepted exactly when every operator surface can quote it whole" -- elegant,
 * and wrong in the one direction that costs an operator something: it made a print width
 * decide what a model may be called, and duly refused a real Hugging Face GGUF repo Ollama
 * serves today at 100 bytes. The concerns are not one. An echo is bounded by TRUNCATING it,
 * which `sanitizeModelReferenceText` does, marking the cut; a reference cannot be truncated
 * into validity, so its ceiling has to be justified by what model ids are (see
 * `MAX_MODEL_REFERENCE_BYTES`, now 160 and derived from the real distribution).
 *
 * Keeping this at 96 costs nothing real. It bounds the value quoted back at an operator when
 * that value FAILED to parse -- `modelReferenceEcho` in @mono-agent/config, the only consumer,
 * is on the rejection path -- so it never truncates a working reference. It stays large enough
 * to show a mistyped one in full: 96 bytes covers every reference in Pi's 1312-entry built-in
 * catalog (longest 77) and every ref this machine's Ollama and LM Studio discovery returns
 * (longest 52), and a longer value is shown as much of itself as fits, plus the marker.
 */
export const MODEL_REFERENCE_ECHO_MAX_BYTES = 96;

/** Longest fixed repair sentence the kernel parser emits, 127 bytes (the ACP one), rounded up. */
const MODEL_REFERENCE_REPAIR_MAX_BYTES = 128;

/**
 * A parser reason is one fixed repair sentence plus at most one echo of the operator's value,
 * so its budget is the sum. Deriving it rather than picking a number is what keeps the repair
 * -- the actionable half an operator actually needs -- from ever being clamped away.
 */
export const MODEL_REFERENCE_REASON_MAX_BYTES =
  MODEL_REFERENCE_ECHO_MAX_BYTES + MODEL_REFERENCE_REPAIR_MAX_BYTES;

/**
 * Control (`Cc`), format (`Cf`), line- and paragraph-separator code points. Every one of them
 * either moves the cursor or is invisible, which is exactly what makes a value able to
 * restyle or extend the diagnostic that quotes it.
 */
const DIAGNOSTIC_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const UTF8_ENCODER = new TextEncoder();

function escapeDiagnosticCharacter(character: string): string {
  if (character === "\n") return "\\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";
  const code = character.codePointAt(0) ?? 0;
  return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Escape, then clamp: escaping expands, so clamping last is what makes the returned byte
 * length an actual bound. Clamping walks code points (never splitting one) on a UTF-8 byte
 * budget, the same convention as `clampUtf8Bytes` in agent-harness and `clampUtf8` in the
 * agent-app skill registry, and marks the cut so a clamped echo is distinguishable from a
 * short value. Escaping is idempotent and clamping is monotone, so applying this twice --
 * which happens when config re-bounds a reason the adapter already bounded -- is a no-op.
 */
export function sanitizeModelReferenceText(value: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer.");
  }
  const escaped = value.replace(DIAGNOSTIC_UNSAFE_CHARACTERS, escapeDiagnosticCharacter);
  if (UTF8_ENCODER.encode(escaped).length <= maxBytes) {
    return escaped;
  }
  const marker = "…";
  const markerBytes = UTF8_ENCODER.encode(marker).length;
  // The bound is the contract; the marker is a courtesy. A budget too small to hold the
  // marker still has to be honoured rather than overrun by it.
  const keepMarker = maxBytes >= markerBytes;
  const budget = keepMarker ? maxBytes - markerBytes : maxBytes;
  let kept = "";
  let used = 0;
  for (const character of escaped) {
    const width = UTF8_ENCODER.encode(character).length;
    if (used + width > budget) break;
    kept += character;
    used += width;
  }
  return keepMarker ? `${kept}${marker}` : kept;
}

export function parseMonoRuntimeModelReference(value: string): RuntimeModelReference {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_model_reference", "Model reference must be a non-empty trimmed string.");
  }

  try {
    return normalizeRuntimeModelReference(parseRuntimeModelReference(value));
  } catch (error) {
    // The kernel parser is the only layer that knows the concrete repair for a retired
    // backend (`codex:x` -> `openai-codex:x`, `vercel:p:m` -> `p:m`, ...). Every operator
    // surface renders `message` and nothing else, so the repair has to travel in the
    // message; `details.reason` keeps the unprefixed text for programmatic callers.
    // The parser interpolates the operator's own model id into that repair, so the reason
    // is operator-supplied text and is bounded here, at the one place it is derived.
    const reason = sanitizeModelReferenceText(
      error instanceof Error ? error.message : String(error),
      MODEL_REFERENCE_REASON_MAX_BYTES,
    );
    throw new RuntimeAdapterError("invalid_model_reference", `Invalid runtime model reference: ${reason}`, {
      reason,
    });
  }
}

/** Stable canonical string used for model comparison, caching, and display. */
export function modelReferenceKey(model: RuntimeModelReference): string {
  return model.reference;
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
      "Runtime model reference must be a parsed object with provider, model, and reference.",
    );
  }

  const provider = normalizedRequiredString(value.provider, "provider");
  const model = normalizedRequiredString(value.model, "model");
  const reference = normalizedRequiredString(value.reference, "reference");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider)) {
    throw new RuntimeAdapterError(
      "invalid_model_reference",
      "Runtime model reference provider has invalid characters.",
      { field: "provider" },
    );
  }
  if (reference !== `${provider}:${model}`) {
    throw new RuntimeAdapterError(
      "invalid_model_reference",
      "Runtime model reference must use its canonical <provider>:<model> spelling.",
      { field: "reference" },
    );
  }

  return { provider, model, reference };
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
  modelReferenceExamples: Object.freeze(["openai-codex:gpt-5.5", "github-copilot:gpt-4.1"]),
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
