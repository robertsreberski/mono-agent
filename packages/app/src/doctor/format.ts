import { stat } from "node:fs/promises";
import { modelReferenceKey } from "@mono-agent/turn/host/config";
import type { RuntimeModelReference } from "@mono-agent/turn/host/types";
import { MODEL_REFERENCE_ECHO_MAX_BYTES, MODEL_REFERENCE_REASON_MAX_BYTES, TurnHostError, sanitizeModelReferenceText } from "@mono-agent/turn/host/config";

export function referenceOf(model: RuntimeModelReference): string {
  return modelReferenceKey(model);
}

/**
 * Bounded, single-line rendering of operator-supplied text for a diagnostic.
 *
 * `referenceOf` is the canonical KEY -- it is compared against
 * `verifiedCredentialModelRefs`, which carries whole references -- so it must
 * stay unbounded. What gets PRINTED must not be. The parser deliberately has no
 * length ceiling any more (a reference cannot be truncated into validity, so a
 * ceiling there could only refuse a model that runs), which means acceptance
 * stopped being a length guarantee: a 500,000-byte reference parses today and
 * every one of these lines is echoed by `mono-agent validate`, the daemon log
 * and launchd's captured stdout. Escaping comes with the clamp, so a reference
 * carrying a newline also cannot forge a detail line that reads as doctor's own.
 */
export function displayText(value: string): string {
  return sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES);
}

/** Bounded display form of a model reference. Never use it as a map or set key. */
export function displayReferenceOf(model: RuntimeModelReference): string {
  return displayText(referenceOf(model));
}

/**
 * Bounded display form of a thrown reason. A reason gets the larger budget because it is one
 * fixed repair sentence plus at most one echo of the value.
 *
 * Unwrap one layer first, as `modelReferenceReason` in @mono-agent/config and `reasonOf` in
 * trigger-overrides already do: the adapter's `message` wraps a 32-byte generic prefix around
 * a reason ALREADY at the full reason budget, so clamping the wrapped form spends the budget
 * on the prefix and pays for it out of the tail -- which is where the kernel parser puts the
 * concrete repair whenever it quotes the operator's value first.
 */
export function displayReason(error: unknown): string {
  const reason = error instanceof TurnHostError && typeof error.details.reason === "string"
    ? error.details.reason
    : error instanceof Error
      ? error.message
      : String(error);
  return sanitizeModelReferenceText(reason, MODEL_REFERENCE_REASON_MAX_BYTES);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
