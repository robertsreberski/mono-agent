import { createHash } from "node:crypto";

import { redactJsonValue } from "@mono-agent/observability";

export const TOOL_HISTORY_ARGUMENT_MAX_BYTES = 8 * 1024;
export const TOOL_HISTORY_RESULT_MAX_BYTES = 16 * 1024;

const STRING_MAX_BYTES = 4 * 1024;
const SEARCH_TEXT_MAX_BYTES = 8 * 1024;
const PRE_REDACTION_MAX_NODES = 2_048;
const PRE_REDACTION_MAX_STRING_BYTES = 64 * 1024;
const PRE_REDACTION_MAX_COLLECTION_ITEMS = 512;
const PRE_REDACTION_MAX_KEY_BYTES = 512;
const PRE_REDACTION_OMISSION = "[oversized value omitted before redaction]";

export interface BoundedToolHistoryPayload {
  readonly json: string;
  readonly sha256: string;
  readonly searchText: string;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
}

/**
 * Apply the tool-history store's bounded inspection, redaction, and payload
 * limits without ever serializing an unbounded caller-owned value.
 */
export function boundedToolHistoryPayload(
  value: unknown,
  maxBytes: number,
  options: { readonly maxStringBytes?: number } = {},
): BoundedToolHistoryPayload {
  const preprocessed = securelyPreprocessPayload(value);
  const preprocessedJsonBytes = Buffer.byteLength(safeJson(preprocessed.value), "utf8");
  const originalBytes = preprocessed.truncated
    ? Math.max(preprocessedJsonBytes, PRE_REDACTION_MAX_STRING_BYTES + 1)
    : preprocessedJsonBytes;
  const maxStringBytes = Math.min(options.maxStringBytes ?? STRING_MAX_BYTES, maxBytes);
  const redacted = redactJsonValue(preprocessed.value, maxStringBytes, {
    contentPatternRedaction: true,
    visibleTextSanitization: {
      omitFilesystemPaths: true,
      omission: "[tool payload omitted because it contained a private host path]",
    },
  });
  const full = safeJson(redacted);
  let json = full;
  let truncated = preprocessed.truncated || originalBytes > maxBytes
    || /\[(?:max-(?:nodes|items|keys|depth)|circular)\]|…\[truncated \d+ bytes\]/u.test(full);
  if (Buffer.byteLength(full, "utf8") > maxBytes) {
    truncated = true;
    let preview = utf8Prefix(full, Math.max(1, maxBytes - 128));
    json = JSON.stringify({ preview, truncated: true, originalBytes });
    while (Buffer.byteLength(json, "utf8") > maxBytes && preview.length > 0) {
      preview = utf8Prefix(preview, Math.max(0, Buffer.byteLength(preview, "utf8") - 128));
      json = JSON.stringify({ preview, truncated: true, originalBytes });
    }
  }
  const retainedBytes = Buffer.byteLength(json, "utf8");
  return {
    json,
    sha256: createHash("sha256").update(json).digest("hex"),
    searchText: utf8Prefix(json.toLowerCase(), SEARCH_TEXT_MAX_BYTES),
    originalBytes,
    retainedBytes,
    truncated,
  };
}

interface SecurePreprocessBudget {
  remainingNodes: number;
  remainingStringBytes: number;
  truncated: boolean;
  readonly seen: WeakSet<object>;
}

function securelyPreprocessPayload(value: unknown): { readonly value: unknown; readonly truncated: boolean } {
  const budget: SecurePreprocessBudget = {
    remainingNodes: PRE_REDACTION_MAX_NODES,
    remainingStringBytes: PRE_REDACTION_MAX_STRING_BYTES,
    truncated: false,
    seen: new WeakSet<object>(),
  };
  const bounded = securePayloadValue(value, budget, 0);
  return { value: bounded, truncated: budget.truncated };
}

function securePayloadValue(value: unknown, budget: SecurePreprocessBudget, depth: number): unknown {
  if (budget.remainingNodes <= 0 || depth >= 24) {
    budget.truncated = true;
    return PRE_REDACTION_OMISSION;
  }
  budget.remainingNodes -= 1;
  if (typeof value === "string") return securePayloadString(value, budget);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return securePayloadString(value.toString(), budget);
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (typeof value !== "object") return "[unserializable]";
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return "[circular]";
  }
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const retained: unknown[] = [];
      const limit = Math.min(value.length, PRE_REDACTION_MAX_COLLECTION_ITEMS);
      for (let index = 0; index < limit && budget.remainingNodes > 0; index += 1) {
        retained.push(securePayloadValue(value[index], budget, depth + 1));
      }
      if (limit < value.length || budget.remainingNodes <= 0) {
        budget.truncated = true;
        retained.push(PRE_REDACTION_OMISSION);
      }
      return retained;
    }
    const retained: Record<string, unknown> = {};
    let retainedItems = 0;
    const source = value as Record<string, unknown>;
    for (const rawKey in source) {
      if (!Object.prototype.hasOwnProperty.call(source, rawKey)) continue;
      if (retainedItems >= PRE_REDACTION_MAX_COLLECTION_ITEMS || budget.remainingNodes <= 0) {
        budget.truncated = true;
        defineSecurePayloadProperty(retained, "__preprocessing_omitted__", PRE_REDACTION_OMISSION);
        break;
      }
      const keyBytes = rawKey.length > PRE_REDACTION_MAX_KEY_BYTES
        || rawKey.length > budget.remainingStringBytes
        ? undefined
        : Buffer.byteLength(rawKey, "utf8");
      const key = keyBytes === undefined
        || keyBytes > PRE_REDACTION_MAX_KEY_BYTES
        || keyBytes > budget.remainingStringBytes
        ? `__oversized_key_${String(retainedItems)}__`
        : rawKey;
      if (key !== rawKey) budget.truncated = true;
      else budget.remainingStringBytes -= keyBytes!;
      defineSecurePayloadProperty(
        retained,
        key,
        key === rawKey
          ? securePayloadValue(source[rawKey], budget, depth + 1)
          : PRE_REDACTION_OMISSION,
      );
      retainedItems += 1;
    }
    return retained;
  } finally {
    budget.seen.delete(value);
  }
}

function defineSecurePayloadProperty(
  target: Record<string, unknown>,
  requestedKey: string,
  value: unknown,
): void {
  let key = requestedKey;
  for (let ordinal = 2; Object.prototype.hasOwnProperty.call(target, key); ordinal += 1) {
    key = `${requestedKey} [key-${String(ordinal)}]`;
    if (ordinal > PRE_REDACTION_MAX_COLLECTION_ITEMS + 1) {
      throw new TypeError("Tool history payload keys could not be bounded safely.");
    }
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function securePayloadString(value: string, budget: SecurePreprocessBudget): string {
  if (value.length > budget.remainingStringBytes) {
    budget.truncated = true;
    return PRE_REDACTION_OMISSION;
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > budget.remainingStringBytes) {
    budget.truncated = true;
    return PRE_REDACTION_OMISSION;
  }
  budget.remainingStringBytes -= bytes;
  return value;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? JSON.stringify("[unserializable]"); }
  catch { return JSON.stringify("[unserializable]"); }
}

export function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}
