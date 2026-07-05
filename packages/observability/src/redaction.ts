import { DEFAULT_MAX_STRING_BYTES } from "./guards.js";

/**
 * Node-free redaction + truncation helpers shared by the recorder and the
 * export-mapping surface. Sensitive keys collapse to `[redacted]`, circular
 * references to `[circular]`, and deeply nested values to `[max-depth]`; long
 * strings are truncated by UTF-8 byte length. Kept import-free of `node:*`
 * (the prior `Buffer.byteLength` call is replaced with `TextEncoder`) so the
 * mapping module can stay browser-safe.
 */

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|api[_-]?key|cookie)/iu;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAX_REDACTION_NODES = 10_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_OBJECT_KEYS = 1_000;

export function redactJsonValue(value: unknown, maxStringBytes = DEFAULT_MAX_STRING_BYTES): unknown {
  return redact(value, maxStringBytes, 0, undefined, new WeakSet<object>(), { remainingNodes: MAX_REDACTION_NODES });
}

interface RedactionBudget {
  remainingNodes: number;
}

function redact(
  value: unknown,
  maxStringBytes: number,
  depth: number,
  key: string | undefined,
  seen: WeakSet<object>,
  budget: RedactionBudget,
): unknown {
  // Secrets (access tokens, API keys, passwords, cookies) are always strings, so a
  // numeric value under a "sensitive" key is a count/flag — e.g. `input_tokens`,
  // `output_tokens`, `cache_read_tokens` all match /token/ but carry token COUNTS
  // we want visible for cost observability. Only redact non-numeric matches.
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key) && typeof value !== "number") {
    return "[redacted]";
  }
  if (!consumeNode(budget)) {
    return "[max-nodes]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, maxStringBytes);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Error) {
    return redact(errorToJson(value), maxStringBytes, depth + 1, key, seen, budget);
  }
  if (depth >= 12) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    const out: unknown[] = [];
    for (let index = 0; index < limit; index += 1) {
      out.push(redact(value[index], maxStringBytes, depth + 1, undefined, seen, budget));
    }
    if (value.length > limit) {
      out.push("[max-items]");
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const limit = Math.min(entries.length, MAX_OBJECT_KEYS);
  for (let index = 0; index < limit; index += 1) {
    const [entryKey, entryValue] = entries[index]!;
    out[entryKey] = redact(entryValue, maxStringBytes, depth + 1, entryKey, seen, budget);
  }
  if (entries.length > limit) {
    out.__truncated__ = "[max-keys]";
  }
  return out;
}

function consumeNode(budget: RedactionBudget): boolean {
  if (budget.remainingNodes <= 0) {
    return false;
  }
  budget.remainingNodes -= 1;
  return true;
}

export function truncateString(value: string, maxStringBytes: number): string {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.length <= maxStringBytes) {
    return value;
  }
  // Cut on a UTF-8 boundary so the kept text never EXCEEDS the byte cap and never
  // splits a multi-byte code point. Slicing the string by `maxStringBytes` UTF-16
  // code units (the prior bug) could emit several bytes per unit. Walk back from
  // the byte cap past any continuation byte (0b10xxxxxx) to the start of its code point.
  let end = maxStringBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  const head = TEXT_DECODER.decode(encoded.subarray(0, end));
  return `${head}…[truncated ${encoded.length - end} bytes]`;
}

export function errorFailureKind(error: unknown): string {
  if (typeof error === "object" && error !== null && "failureKind" in error) {
    const failureKind = (error as { readonly failureKind?: unknown }).failureKind;
    if (typeof failureKind === "string" && failureKind.trim().length > 0) {
      return failureKind;
    }
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "exception";
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}
