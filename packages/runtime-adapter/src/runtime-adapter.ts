import { createPiOAuthApiKeyResolver, createRouterRuntime, createRuntime } from "@mono-agent/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@mono-agent/agent-runtime/ai/runtime/registry.js";

import type {
  MonoRuntimeBackendCapabilities,
  MonoRuntimeBackendDescriptor,
  MonoRuntimeBackendId,
  MonoRuntimeHostOptions,
  MonoRuntimeLike,
  MonoRuntimeSelectionEntry,
  MonoRuntimeSupportDescription,
  RuntimeExecutionMode,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
  RuntimeToolOptions,
} from "./types.js";

export type RuntimeAdapterErrorCode =
  | "invalid_model_reference"
  | "invalid_execution_mode"
  | "incompatible_execution_mode"
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

export function isRuntimeExecutionMode(value: unknown): value is RuntimeExecutionMode {
  return value === "sdk" || value === "cli";
}

export function defaultExecutionModeForModel(model: RuntimeModelReference): RuntimeExecutionMode {
  assertParsedRuntimeModelReference(model);
  return model.sdk === "codex" ? "cli" : "sdk";
}

export function listMonoRuntimeBackends(): readonly MonoRuntimeBackendDescriptor[] {
  return RUNTIME_BACKEND_DEFINITIONS.map((definition) => buildBackendDescriptor(definition));
}

export function runtimeBackendForModel(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): MonoRuntimeBackendDescriptor {
  assertParsedRuntimeModelReference(model);
  const resolvedExecutionMode = executionMode ?? defaultExecutionModeForModel(model);
  assertExecutionModeCompatible(model, resolvedExecutionMode);
  return backendById(backendIdForModel(model, resolvedExecutionMode));
}

export function monoRuntimeSupportsSessionResume(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): boolean {
  return runtimeBackendForModel(model, executionMode).capabilities.supports_session_resume === true;
}

export function describeMonoRuntimeSupport(
  model: RuntimeModelReference,
  executionMode?: RuntimeExecutionMode,
): MonoRuntimeSupportDescription {
  assertParsedRuntimeModelReference(model);
  const resolvedExecutionMode = executionMode ?? defaultExecutionModeForModel(model);
  if (!isRuntimeExecutionMode(resolvedExecutionMode)) {
    return {
      model,
      executionMode: resolvedExecutionMode,
      compatible: false,
      incompatibilityReason: "Execution mode must be sdk or cli.",
    };
  }

  const incompatibilityReason = executionModeIncompatibilityReason(model, resolvedExecutionMode);
  if (typeof incompatibilityReason === "string" && incompatibilityReason.length > 0) {
    return {
      model,
      executionMode: resolvedExecutionMode,
      compatible: false,
      incompatibilityReason,
    };
  }

  return {
    model,
    executionMode: resolvedExecutionMode,
    compatible: true,
    backend: runtimeBackendForModel(model, resolvedExecutionMode),
  };
}

export function assertExecutionModeCompatible(
  model: RuntimeModelReference,
  executionMode: string,
): void {
  assertParsedRuntimeModelReference(model);
  if (!isRuntimeExecutionMode(executionMode)) {
    throw new RuntimeAdapterError("invalid_execution_mode", "Execution mode must be sdk or cli.", {
      executionMode,
    });
  }

  const reason = executionModeIncompatibilityReason(model, executionMode);
  if (typeof reason === "string" && reason.length > 0) {
    throw new RuntimeAdapterError("incompatible_execution_mode", reason, {
      executionMode,
      model: redactedModelReference(model),
    });
  }
}

export interface MonoRuntimeFallbackChainEntry {
  readonly model: RuntimeModelReference;
  readonly executionMode?: RuntimeExecutionMode;
}

export interface CreateMonoRuntimeOptions extends MonoRuntimeHostOptions {
  /**
   * Ordered model chain for provider failover. When present, runs are served by
   * the agent-runtime fallback router: the first entry is attempted first and
   * each retryable provider failure advances to the next entry, so callers
   * should put the primary model at index 0. The router overrides the per-run
   * `model`/`executionMode` with chain entries; failover details are reported
   * on the result as `failoverHistory`.
   */
  readonly fallbackChain?: readonly MonoRuntimeFallbackChainEntry[];
}

export function createMonoRuntime(options: CreateMonoRuntimeOptions = {}): MonoRuntimeLike {
  const { fallbackChain, ...hostOptions } = options;
  const chain = normalizeFallbackChain(fallbackChain);
  const runtime = chain === undefined
    ? createRuntime({ ...hostOptions })
    : createRouterRuntime({ host: { ...hostOptions }, chain });

  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
        throw new RuntimeAdapterError("invalid_runtime_options", "Runtime system prompt must be a non-empty string.");
      }
      if (runOptions === undefined || runOptions === null || typeof runOptions !== "object") {
        throw new RuntimeAdapterError("invalid_runtime_options", "Runtime run options must be an object.");
      }

      assertParsedRuntimeModelReference(runOptions.model);
      const executionMode = runOptions.executionMode ?? defaultExecutionModeForModel(runOptions.model);
      assertExecutionModeCompatible(runOptions.model, executionMode);

      const result = await runtime.run(systemPrompt, {
        ...runOptions,
        executionMode,
      });
      return result as RuntimeResult;
    },
    configureTools(next?: RuntimeToolOptions): void {
      runtime.configureTools?.(next === undefined ? undefined : { ...next });
    },
    async disposeSession(providerSessionId: string): Promise<boolean | void> {
      return runtime.disposeSession?.(providerSessionId);
    },
    async disposeAllSessions(): Promise<void> {
      await runtime.disposeAllSessions?.();
    },
  };
}

export { createPiOAuthApiKeyResolver };

function normalizeFallbackChain(
  fallbackChain: readonly MonoRuntimeFallbackChainEntry[] | undefined,
): readonly { model: RuntimeModelReference; executionMode: RuntimeExecutionMode }[] | undefined {
  if (fallbackChain === undefined) {
    return undefined;
  }
  if (!Array.isArray(fallbackChain) || fallbackChain.length === 0) {
    throw new RuntimeAdapterError("invalid_runtime_options", "Runtime fallback chain must be a non-empty array.");
  }
  return fallbackChain.map((entry) => {
    assertParsedRuntimeModelReference(entry.model);
    const executionMode = entry.executionMode ?? defaultExecutionModeForModel(entry.model);
    assertExecutionModeCompatible(entry.model, executionMode);
    return { model: entry.model, executionMode };
  });
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

interface RuntimeBackendDefinition {
  readonly id: MonoRuntimeBackendId;
  /**
   * Agent-runtime bridge id whose capabilities back this descriptor. Omit (use
   * `inlineCapabilities` instead) for standalone backends that are not routed
   * through @mono-agent/agent-runtime, e.g. the @openai/agents runtime.
   */
  readonly runtimeBridgeId?: string;
  /** Self-described capabilities for backends with no agent-runtime bridge. */
  readonly inlineCapabilities?: MonoRuntimeBackendCapabilities;
  readonly label: string;
  readonly sdk: RuntimeModelReference["sdk"];
  readonly executionMode: RuntimeExecutionMode;
  readonly transport: "sdk" | "cli";
  readonly providerBoundary: string;
  readonly modelReferenceExamples: readonly string[];
  readonly acceptsProviderIds: boolean;
}

const RUNTIME_BACKEND_DEFINITIONS: readonly RuntimeBackendDefinition[] = [
  {
    id: "claude-sdk",
    runtimeBridgeId: "claude",
    label: "Claude SDK",
    sdk: "claude",
    executionMode: "sdk",
    transport: "sdk",
    providerBoundary: "@anthropic-ai/claude-agent-sdk via @mono-agent/agent-runtime",
    modelReferenceExamples: ["claude:claude-sonnet-4-6"],
    acceptsProviderIds: false,
  },
  {
    id: "claude-code-cli",
    runtimeBridgeId: "claude-code",
    label: "Claude Code CLI",
    sdk: "claude",
    executionMode: "cli",
    transport: "cli",
    providerBoundary: "Claude Code CLI bridge via @mono-agent/agent-runtime",
    modelReferenceExamples: ["claude:claude-sonnet-4-6"],
    acceptsProviderIds: false,
  },
  {
    id: "codex-app-cli",
    runtimeBridgeId: "codex-app",
    label: "Codex app CLI",
    sdk: "codex",
    executionMode: "cli",
    transport: "cli",
    providerBoundary: "Codex app-server bridge via @mono-agent/agent-runtime",
    modelReferenceExamples: ["codex:gpt-5.5"],
    acceptsProviderIds: false,
  },
  {
    id: "openai-agents-sdk",
    // No agent-runtime bridge: @openai/agents is driven directly by
    // @mono-agent/openai-agents-runtime, so capabilities are self-described.
    inlineCapabilities: {
      kind: "openai-agents",
      runtime: "sdk",
      streaming: true,
      structured_output: false,
      supports_session_resume: false,
      supports_mcp: true,
      supports_skills: false,
      supports_builtin_tools: false,
      supports_live_input: false,
      supports_native_subagents: false,
    },
    label: "OpenAI Agents SDK",
    sdk: "openai",
    executionMode: "sdk",
    transport: "sdk",
    providerBoundary: "@openai/agents via @mono-agent/openai-agents-runtime",
    modelReferenceExamples: ["openai:gpt-5"],
    acceptsProviderIds: false,
  },
  {
    id: "pi-sdk",
    runtimeBridgeId: "pi",
    label: "Pi SDK provider",
    sdk: "pi",
    executionMode: "sdk",
    transport: "sdk",
    providerBoundary: "Pi SDK provider gateway via @mono-agent/agent-runtime",
    modelReferenceExamples: ["pi:openai-codex:gpt-5.5", "pi:github-copilot:gpt-4.1"],
    acceptsProviderIds: true,
  },
];

/**
 * The additive (sdk, executionMode) -> backend selection table. This is a
 * declarative building block: it states which backend serves a given sdk under a
 * given execution mode, and which sdk-id spellings each runtime accepts. It is
 * NOT wired into agent-host routing; consumers read it to align vocabularies.
 *
 * `sdkAliases[0]` is the canonical sdk id used by the backend descriptor; later
 * entries may be accepted legacy spellings. Runtime packages derive their
 * fail-closed `model.sdk` guard sets from these aliases via
 * {@link acceptedSdkIdsForBackend}.
 */
const RUNTIME_SELECTION_TABLE: readonly MonoRuntimeSelectionEntry[] = [
  { sdk: "claude", sdkAliases: ["claude"], executionMode: "sdk", backendId: "claude-sdk" },
  { sdk: "claude", sdkAliases: ["claude"], executionMode: "cli", backendId: "claude-code-cli" },
  { sdk: "codex", sdkAliases: ["codex"], executionMode: "cli", backendId: "codex-app-cli" },
  { sdk: "openai", sdkAliases: ["openai"], executionMode: "sdk", backendId: "openai-agents-sdk" },
  { sdk: "pi", sdkAliases: ["pi"], executionMode: "sdk", backendId: "pi-sdk" },
];

/**
 * Returns a defensive copy of the (sdk, executionMode) selection table. Additive
 * building block; does not perform routing.
 */
export function listMonoRuntimeSelectionTable(): readonly MonoRuntimeSelectionEntry[] {
  return RUNTIME_SELECTION_TABLE.map((entry) => ({
    ...entry,
    sdkAliases: [...entry.sdkAliases],
  }));
}

/**
 * Resolves a backend id from the selection table by sdk (canonical or alias) and
 * execution mode. Returns undefined when no row matches, leaving the caller to
 * decide how to fail.
 */
export function selectMonoRuntimeBackendId(
  sdk: string,
  executionMode: RuntimeExecutionMode,
): MonoRuntimeBackendId | undefined {
  const entry = RUNTIME_SELECTION_TABLE.find(
    (candidate) => candidate.executionMode === executionMode && candidate.sdkAliases.includes(sdk),
  );
  return entry?.backendId;
}

/**
 * The set of accepted `model.sdk` spellings for a backend, drawn from the
 * selection table. SDK runtimes use this to build a single-source-of-truth
 * fail-closed guard instead of hard-coding the vocabulary.
 */
export function acceptedSdkIdsForBackend(backendId: MonoRuntimeBackendId): readonly string[] {
  const aliases = new Set<string>();
  for (const entry of RUNTIME_SELECTION_TABLE) {
    if (entry.backendId === backendId) {
      for (const alias of entry.sdkAliases) {
        aliases.add(alias);
      }
    }
  }
  return [...aliases];
}

function buildBackendDescriptor(
  definition: RuntimeBackendDefinition,
): MonoRuntimeBackendDescriptor {
  const { runtimeBridgeId, inlineCapabilities, ...rest } = definition;
  const capabilities = runtimeBridgeId === undefined
    ? requireInlineCapabilities(definition.id, inlineCapabilities)
    : capabilitiesForRuntimeBridge(runtimeBridgeId);
  return {
    ...rest,
    // Public descriptors always carry a string bridge id; standalone backends
    // (no agent-runtime bridge) report their own backend id here.
    runtimeBridgeId: runtimeBridgeId ?? definition.id,
    capabilities,
  };
}

function requireInlineCapabilities(
  id: MonoRuntimeBackendId,
  inlineCapabilities: MonoRuntimeBackendCapabilities | undefined,
): MonoRuntimeBackendCapabilities {
  if (inlineCapabilities === undefined) {
    throw new RuntimeAdapterError(
      "runtime_backend_unavailable",
      "Runtime backend has neither a runtime bridge nor inline capabilities.",
      { id },
    );
  }
  return { ...inlineCapabilities };
}

function backendById(id: MonoRuntimeBackendId): MonoRuntimeBackendDescriptor {
  const definition = RUNTIME_BACKEND_DEFINITIONS.find((candidate) => candidate.id === id);
  if (definition === undefined) {
    throw new RuntimeAdapterError("runtime_backend_unavailable", "Runtime backend is not registered.", { id });
  }
  return buildBackendDescriptor(definition);
}

function backendIdForModel(
  model: RuntimeModelReference,
  executionMode: RuntimeExecutionMode,
): MonoRuntimeBackendId {
  if (model.sdk === "claude" && executionMode === "cli") {
    return "claude-code-cli";
  }
  if (model.sdk === "claude" && executionMode === "sdk") {
    return "claude-sdk";
  }
  if (model.sdk === "codex" && executionMode === "cli") {
    return "codex-app-cli";
  }
  if (model.sdk === "pi" && executionMode === "sdk") {
    return "pi-sdk";
  }
  throw new RuntimeAdapterError("runtime_backend_unavailable", "No runtime backend matches this model and execution mode.", {
    model: redactedModelReference(model),
    executionMode,
  });
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

function normalizedRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new RuntimeAdapterError("invalid_model_reference", `Runtime model reference ${field} must be a non-empty trimmed string.`, {
      field,
    });
  }
  return value;
}

function redactedModelReference(model: RuntimeModelReference): Record<string, string | undefined> {
  return {
    sdk: model.sdk,
    provider: model.provider,
    model: model.model,
    reference: model.reference,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
