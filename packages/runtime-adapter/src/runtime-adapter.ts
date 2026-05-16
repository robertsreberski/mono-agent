import { createRuntime } from "@worklab-ai/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@worklab-ai/agent-runtime/ai/runtime/model-refs.js";
import { listRuntimeBridges } from "@worklab-ai/agent-runtime/ai/runtime/registry.js";

import type {
  MonoRuntimeBackendCapabilities,
  MonoRuntimeBackendDescriptor,
  MonoRuntimeBackendId,
  MonoRuntimeHostOptions,
  MonoRuntimeLike,
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
  executionMode: RuntimeExecutionMode,
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

export function createMonoRuntime(options: MonoRuntimeHostOptions = {}): MonoRuntimeLike {
  const runtime = createRuntime({ ...options });

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
  };
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
  readonly runtimeBridgeId: string;
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
    providerBoundary: "@anthropic-ai/claude-agent-sdk via @worklab-ai/agent-runtime",
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
    providerBoundary: "Claude Code CLI bridge via @worklab-ai/agent-runtime",
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
    providerBoundary: "Codex app-server bridge via @worklab-ai/agent-runtime",
    modelReferenceExamples: ["codex:gpt-5.5"],
    acceptsProviderIds: false,
  },
  {
    id: "pi-sdk",
    runtimeBridgeId: "pi",
    label: "Pi SDK provider",
    sdk: "pi",
    executionMode: "sdk",
    transport: "sdk",
    providerBoundary: "Pi SDK provider gateway via @worklab-ai/agent-runtime",
    modelReferenceExamples: ["pi:openai-codex:gpt-5.5", "pi:github-copilot:gpt-4.1"],
    acceptsProviderIds: true,
  },
];

function buildBackendDescriptor(
  definition: RuntimeBackendDefinition,
): MonoRuntimeBackendDescriptor {
  return {
    ...definition,
    capabilities: capabilitiesForRuntimeBridge(definition.runtimeBridgeId),
  };
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
