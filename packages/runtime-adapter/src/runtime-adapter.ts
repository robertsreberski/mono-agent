import { createRuntime } from "@worklab-ai/agent-runtime";
import { executionModeIncompatibilityReason, parseRuntimeModelReference } from "@worklab-ai/agent-runtime/ai/runtime/model-refs.js";

import type {
  MonoRuntimeHostOptions,
  MonoRuntimeLike,
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
  | "invalid_runtime_options";

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
