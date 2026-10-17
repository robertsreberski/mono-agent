import { modelReferenceKey, parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import type { RuntimeModelReference } from "@mono-agent/turn/host/types";

/** Normalize accepted input aliases before writing a strict persisted binding. */
export function sessionModelKey(model: RuntimeModelReference): string {
  return modelReferenceKey(parseMonoRuntimeModelReference(modelReferenceKey(model)));
}

/** Persisted keys are canonical references, never aliases or routing guesses. */
export function assertSessionModelKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || modelReferenceKey(parseMonoRuntimeModelReference(value)) !== value) {
    throw new TypeError("Session modelKey must be a canonical model reference.");
  }
}
