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

export function redactJsonValue(value: unknown, maxStringBytes = DEFAULT_MAX_STRING_BYTES): unknown {
  return redact(value, maxStringBytes, 0, undefined, new WeakSet<object>());
}

function redact(value: unknown, maxStringBytes: number, depth: number, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
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
    return errorToJson(value);
  }
  if (depth >= 12) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, maxStringBytes, depth + 1, undefined, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    out[entryKey] = redact(entryValue, maxStringBytes, depth + 1, entryKey, seen);
  }
  return out;
}

export function truncateString(value: string, maxStringBytes: number): string {
  const bytes = TEXT_ENCODER.encode(value).length;
  if (bytes <= maxStringBytes) {
    return value;
  }
  return `${value.slice(0, maxStringBytes)}…[truncated ${bytes - maxStringBytes} bytes]`;
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
