


import { MODEL_REFERENCE_ECHO_MAX_BYTES,MODEL_REFERENCE_REASON_MAX_BYTES,parseMonoRuntimeModelReference,RuntimeAdapterError,sanitizeModelReferenceText } from "@mono-agent/turn/host/config";








import type { MonoAgentConfig } from "../types.js";

import { MonoAgentConfigError } from "../errors.js";



import { requireJsonString } from "./scalars.js";

/**
 * The concrete repair for a rejected model reference (`codex:x` -> `openai-codex:x`, a tier
 * alias, the `<provider>:<model>` grammar) is built by the kernel parser and nested by the
 * runtime adapter in `details.reason`. Config used to keep only the adapter's generic outer
 * sentence, which is the one string every operator surface prints — so the repair the code
 * already knew was thrown away before anyone saw it. Unwrap one layer so the message carries
 * the innermost, actionable text.
 */
export function modelReferenceReason(error: unknown): string {
  const reason = error instanceof RuntimeAdapterError && typeof error.details.reason === "string"
    ? error.details.reason
    : error instanceof Error
      ? error.message
      : String(error);
  // The adapter already bounds its own reason; re-bounding is a no-op there and is what
  // covers the branches above it, where the text is an arbitrary thrown value.
  return sanitizeModelReferenceText(reason, MODEL_REFERENCE_REASON_MAX_BYTES);
}

/**
 * Bound and neutralize the operator's own value before quoting it back at them. Naming the
 * rejected value is the half of the message that tells an operator *which* field to open, so
 * it stays -- but it is untrusted, unbounded text on its way into durable operator-shared
 * output, and it is treated as such.
 */
export function modelReferenceEcho(raw: string): string {
  return sanitizeModelReferenceText(raw, MODEL_REFERENCE_ECHO_MAX_BYTES);
}

export function parseModel(raw: string, path: string): MonoAgentConfig["runtime"]["model"] {
  try {
    return parseMonoRuntimeModelReference(raw);
  } catch (error) {
    const reason = modelReferenceReason(error);
    throw new MonoAgentConfigError(
      "invalid_model_reference",
      `${path} \`${modelReferenceEcho(raw)}\` is not a valid runtime model reference: ${reason}`,
      { path, reason },
    );
  }
}

/** Validate the object form before reading its ref; never coerce unknown values. */
export function readModelSelection(value: unknown, path: string): string {
  if (typeof value === "string" || value === undefined) return requireJsonString(value, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new MonoAgentConfigError("invalid_json", `${path} must be a string or a model/context1M object.`, { path });
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "model" && key !== "context1M")
    || typeof record.model !== "string" || record.model.length === 0
    || (record.context1M !== undefined && typeof record.context1M !== "boolean")) {
    throw new MonoAgentConfigError("invalid_json", `${path} accepts only model (string) and optional context1M (boolean).`, { path });
  }
  return record.model;
}
