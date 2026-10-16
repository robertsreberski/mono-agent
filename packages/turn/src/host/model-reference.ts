import { parseRuntimeModelReference } from "@mono-agent/turn/ai/runtime/model-refs.js";
import type { RuntimeModelReference } from "./types.js";

type RuntimeAdapterErrorCode =
  | "invalid_model_reference"
  | "runtime_backend_unavailable"
  | "invalid_runtime_options"
  | "invalid_local_provider";

interface RuntimeAdapterErrorDetails {
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
 * This is a DISPLAY budget, and it is the ONLY bound a model reference has left, because it is
 * the only kind of bound that costs nobody a working model. Two rounds tried to make the parser
 * share it, or share something like it: first as `MAX_MODEL_REFERENCE_BYTES` = 96 on the rule "a
 * reference is accepted exactly when every operator surface can quote it whole", which duly
 * refused a Hugging Face GGUF repo Ollama serves today at 100 bytes; then at 160, derived from a
 * sampled distribution, which refused an `ollama:<model>:<tag>` reference whose two halves Ollama
 * itself validates at 80 bytes each. The parser now has no length rule at all -- what a model may
 * be called is decided by providers -- and this number stayed exactly where it was.
 *
 * That asymmetry is the point, not an accident of which side moved. An echo is bounded by
 * TRUNCATING it, which `sanitizeModelReferenceText` does, marking the cut; a reference cannot be
 * truncated into validity, so a ceiling there can only ever refuse. Truncating an echo costs a
 * diagnostic some characters. Refusing a reference costs an operator a route that runs.
 *
 * Keeping this at 96 therefore costs nothing real. Every consumer is on a REJECTION path --
 * `modelReferenceEcho` in @mono-agent/config, `echoValue` in agent-app's request-model-override,
 * `echo` in its trigger-overrides -- so it never truncates a reference that parsed. It stays
 * large enough to show a mistyped one in full: 96 bytes covers every reference in Pi's
 * 1312-entry built-in catalog (longest 77) and every ref this machine's Ollama and LM Studio
 * discovery returns (longest 52), and a longer value is shown as much of itself as fits, plus
 * the marker. A reference that DID parse and is genuinely longer than this -- which is now
 * possible at any size -- is clamped here rather than refused there; the model-reference bound
 * suite asserts that at 100, 168, 400, 70,000 and 270,000 bytes.
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
