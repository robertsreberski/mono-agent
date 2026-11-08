import { object } from "./continuity-observation-input.mjs";
import { bytes, callKey } from "./continuity-recorded-schema.mjs";

// eventToolArgs fills these public declaration fields. Keep this closed; do not
// allow arbitrary extra web keys to excuse a changed model invocation.
export const EFFECTIVE_ARGUMENT_KEYS = ["workdir", "timeout_ms", "max_output_chars", "head_limit"];
export function effectiveArguments(web, model) {
  return object(web) && object(model) && Object.keys(model).every(k => Object.hasOwn(web, k) && callKey("", { value: web[k] }) === callKey("", { value: model[k] }))
    && Object.keys(web).every(k => Object.hasOwn(model, k) || EFFECTIVE_ARGUMENT_KEYS.includes(k));
}
export const REDACTION_OPTIONS = { contentPatternRedaction: true, visibleTextSanitization: {
  omitFilesystemPaths: true, omission: "[tool payload omitted because it contained a private host path]",
} };
export function normalizeSidecar(value, redactJsonValue) {
  const preprocessed = securelyPreprocessPayload(value);
  return redactJsonValue(preprocessed.value, 4096, REDACTION_OPTIONS);
}
export function textResult(value) {
  if (typeof value === "string") return value;
  const content = Array.isArray(value) ? value : value?.content;
  return Array.isArray(content) && content.every(p => p?.type === "text" && typeof p.text === "string") ? content.map(p => p.text).join("\n") : undefined;
}
const TOKENS = /\[home-path\]|\[host-path\]|\[private-path\]|\[redacted\]|\[tool payload omitted because it contained a private host path\]|\[diagnostic omitted because it contained private host data\]/g;
// Legacy fallback: only token-bearing spans may vary. Keys, array topology,
// ordinary sibling fields and non-token string fragments must still match.
export function redactedSpansMatch(web, sidecar) {
  if (callKey("", { value: web }) === callKey("", { value: sidecar })) return true;
  if (typeof sidecar === "string") {
    if (typeof web !== "string") return sidecar.match(TOKENS) !== null && sidecar.replace(TOKENS, "") === "";
    const pieces = sidecar.split(TOKENS);
    if (pieces.length === 1) return false;
    let position = 0;
    if (!web.startsWith(pieces[0])) return false;
    position = pieces[0].length;
    for (let i = 1; i < pieces.length; i++) {
      const piece = pieces[i];
      if (i === pieces.length - 1) return web.endsWith(piece) && web.length - piece.length >= position;
      const found = web.indexOf(piece, position); if (found === -1) return false;
      position = found + piece.length;
    }
  }
  if (Array.isArray(web) && Array.isArray(sidecar)) return web.length === sidecar.length && web.every((v, i) => redactedSpansMatch(v, sidecar[i]));
  if (object(web) && object(sidecar)) return Object.keys(web).length === Object.keys(sidecar).length && Object.keys(web).every(k => Object.hasOwn(sidecar, k) && redactedSpansMatch(web[k], sidecar[k]));
  return false;
}
export function compareCopies(web, sidecar, redact, argumentsOnly = false) {
  const same = callKey("", { value: web }) === callKey("", { value: sidecar });
  if (argumentsOnly ? same : bytes(web) === bytes(sidecar)) return "exact";
  if (same) return "representation_difference";
  if (!argumentsOnly && textResult(web) !== undefined && textResult(web) === textResult(sidecar)) return "text_equivalent";
  if (callKey("", { value: normalizeSidecar(web, redact) }) === callKey("", { value: sidecar })) return "sidecar_redacted";
  if (redactedSpansMatch(web, sidecar)) return "sidecar_redacted_unverified";
  if (!argumentsOnly && textResult(web) !== undefined && textResult(sidecar) !== undefined) {
    if (normalizeSidecar(textResult(web), redact) === textResult(sidecar)) return "sidecar_redacted";
    if (redactedSpansMatch(textResult(web), textResult(sidecar))) return "sidecar_redacted_unverified";
  }
  return "different";
}
export function resultCopy(store, value, { truncated = false, originalBytes, redacted = false } = {}) {
  const retainedBytes = Buffer.byteLength(textResult(value) ?? bytes(value));
  originalBytes ??= object(value) ? value.originalBytes : undefined;
  truncated ||= value?.truncated === true || /…\[truncated(?: \d+ bytes)?\]$/.test(textResult(value) ?? "")
    || store !== "sidecar" && Number.isSafeInteger(originalBytes) && originalBytes > retainedBytes;
  return { store, value, truncated, retainedBytes, originalBytes: Number.isSafeInteger(originalBytes) && originalBytes > 0 ? originalBytes : (truncated ? null : retainedBytes), redacted };
}
export function selectResult(copies) {
  const comparable = copies.filter(c => c.truncated).every(c => Number.isFinite(c.originalBytes) && c.originalBytes > 0);
  return [...copies].sort((a, b) => Number(a.truncated) - Number(b.truncated)
    || (a.truncated ? (comparable ? b.retainedBytes / b.originalBytes - a.retainedBytes / a.originalBytes : 0) || b.retainedBytes - a.retainedBytes : 0)
    || Number(a.redacted) - Number(b.redacted)
    || ["web", "journal", "sidecar"].indexOf(a.store) - ["web", "journal", "sidecar"].indexOf(b.store))[0];
}
export function isBoundary(part) {
  if (part?.type !== "telemetry" || part.event !== "runtime_telemetry") return false;
  let current = part.data;
  for (let depth = 0; depth < 8 && object(current); depth++, current = current.data) if (current.type === "runtime_telemetry" && current.kind === "assistant_message_boundary" && object(current.data)) return true;
  return false;
}
// Native boundaries precede tool_execution_start (execution/pi/events.ts:160–219).
export function webGroups(parts, calls, toolAt) {
  const boundaries = parts.flatMap((p, i) => isBoundary(p) ? [i] : []);
  const groups = new Map(); let valid = boundaries.length > 0, pendingUsage = false;
  for (const part of parts) {
    if (part?.type === "telemetry" && part.data?.kind === "context_usage") { if (pendingUsage) valid = false; pendingUsage = true; }
    if (isBoundary(part)) pendingUsage = false;
    else if (part?.type === "tool-call" && pendingUsage) { valid = false; pendingUsage = false; }
  }
  if (pendingUsage) valid = false;
  for (const index of calls) {
    const position = toolAt.get(index), boundary = boundaries.findLast(b => b < position);
    if (boundary === undefined) valid = false;
    const key = boundary ?? -1;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(index);
  }
  // Terminal receipts may complete out of order *within* a parallel group.
  // They must not reverse or duplicate lifecycle sequence across groups.
  let previousMax = -1;
  for (const indices of groups.values()) {
    const seqs = indices.map(i => parts[toolAt.get(i)].history?.sequence).filter(v => v !== undefined);
    if (seqs.some(v => !Number.isSafeInteger(v) || v < 0 || v <= previousMax) || new Set(seqs).size !== seqs.length) valid = false;
    if (seqs.length) previousMax = Math.max(...seqs);
  }
  return valid ? [...groups].map(([boundary, group]) => ({ calls: group, boundaryIndex: boundary, origin: "web-assistant-boundary", gaps: [] }))
    : [{ calls, origin: "web-message-conservative", gaps: ["assistant_step_boundaries_unknown"] }];
}

// Exact secure preprocessing from tool-history/payload.ts; parity-tested.
const PRE_REDACTION_MAX_NODES = 2_048;
const PRE_REDACTION_MAX_STRING_BYTES = 64 * 1024;
const PRE_REDACTION_MAX_COLLECTION_ITEMS = 512;
const PRE_REDACTION_MAX_KEY_BYTES = 512;
const PRE_REDACTION_OMISSION = "[oversized value omitted before redaction]";
function securelyPreprocessPayload(value) {
    const budget = {
        remainingNodes: PRE_REDACTION_MAX_NODES,
        remainingStringBytes: PRE_REDACTION_MAX_STRING_BYTES,
        truncated: false,
        seen: new WeakSet(),
    };
    const bounded = securePayloadValue(value, budget, 0);
    return { value: bounded, truncated: budget.truncated };
}
function securePayloadValue(value, budget, depth) {
    if (budget.remainingNodes <= 0 || depth >= 24) {
        budget.truncated = true;
        return PRE_REDACTION_OMISSION;
    }
    budget.remainingNodes -= 1;
    if (typeof value === "string")
        return securePayloadString(value, budget);
    if (value === null || typeof value === "boolean" || typeof value === "number")
        return value;
    if (typeof value === "bigint")
        return securePayloadString(value.toString(), budget);
    if (typeof value === "undefined")
        return "[undefined]";
    if (typeof value === "function" || typeof value === "symbol")
        return `[${typeof value}]`;
    if (typeof value !== "object")
        return "[unserializable]";
    if (budget.seen.has(value)) {
        budget.truncated = true;
        return "[circular]";
    }
    budget.seen.add(value);
    try {
        if (Array.isArray(value)) {
            const retained = [];
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
        const retained = {};
        let retainedItems = 0;
        const source = value;
        for (const rawKey in source) {
            if (!Object.prototype.hasOwnProperty.call(source, rawKey))
                continue;
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
            if (key !== rawKey)
                budget.truncated = true;
            else
                budget.remainingStringBytes -= keyBytes;
            defineSecurePayloadProperty(retained, key, key === rawKey
                ? securePayloadValue(source[rawKey], budget, depth + 1)
                : PRE_REDACTION_OMISSION);
            retainedItems += 1;
        }
        return retained;
    }
    finally {
        budget.seen.delete(value);
    }
}
function defineSecurePayloadProperty(target, requestedKey, value) {
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
function securePayloadString(value, budget) {
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
