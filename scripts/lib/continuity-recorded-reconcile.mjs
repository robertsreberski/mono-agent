import { object } from "./continuity-observation-input.mjs";
import { bytes, callKey, contentBlocks } from "./continuity-recorded-schema.mjs";

// eventToolArgs fills these public declaration fields. Keep this closed; do not
// allow arbitrary extra web keys to excuse a changed model invocation.
export const EFFECTIVE_ARGUMENT_KEYS = ["workdir", "timeout_ms", "max_output_chars", "head_limit"];
export function effectiveArguments(web, model) {
  return object(web) && object(model) && Object.keys(model).every(k => Object.hasOwn(web, k) && callKey("", { value: web[k] }) === callKey("", { value: model[k] }))
    && Object.keys(web).every(k => Object.hasOwn(model, k) || EFFECTIVE_ARGUMENT_KEYS.includes(k));
}
// Agent lifecycle bookends publish only name/description (agent-tool.ts:1104).
// A display projection must omit keys, never add or change shared values.
export function webProjectionArguments(web, authoritative) {
  return object(web) && object(authoritative) && Object.keys(web).length < Object.keys(authoritative).length
    && Object.keys(web).every(k => Object.hasOwn(authoritative, k) && callKey("", { value: web[k] }) === callKey("", { value: authoritative[k] }));
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
  return contentBlocks(content) && content.every(p => p?.type === "text" && typeof p.text === "string") ? content.map(p => p.text).join("\n") : undefined;
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
export const hasRedactions = value => new RegExp(TOKENS.source).test(JSON.stringify(value) ?? "");
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
  truncated ||= /…\[truncated(?: \d+ bytes)?\]$/.test(textResult(value) ?? "")
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
// Same bounded legacy telemetry unwrapping as web/src/wake-reply.ts.
export function isBoundary(part, kind = "assistant_message_boundary") {
  if (part?.type !== "telemetry") return false;
  let current = part.data;
  const seen = new Set();
  for (let depth = 0; depth < 8 && object(current) && !seen.has(current); depth++, current = current.data) {
    seen.add(current);
    if (current.kind === kind) return true;
  }
  return false;
}
// Usage ends each assistant message before tool execution starts (pi/events.ts).
// An explicit marker for that same message replaces usage, never adds a step.
export function webGroups(parts, calls, toolAt, { allMessages = false } = {}) {
  const callAt = new Map(calls.map(index => [toolAt.get(index), index])), groups = [];
  let active = null, start = 0, valid = true;
  const finish = end => {
    if (active && (active.calls.length || allMessages && parts.slice(active.partStartIndex, end + 1).some(p => ["text", "reasoning"].includes(p?.type)))) { active.partEndIndex = end; groups.push(active); }
    active = null;
  };
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part?.type === "reasoning" || part?.type === "text") {
      if (active) { finish(index - 1); start = index; }
      continue;
    }
    const usage = isBoundary(part, "context_usage"), explicit = isBoundary(part);
    if (usage || explicit) {
      // Other telemetry may sit between the two markers, but prose, another
      // usage marker or any execution means they cannot be the same message.
      if (explicit && active?.origin === "web-usage-boundary" && !active.executed) {
        active.boundaryIndex = index; active.origin = "web-assistant-boundary";
      } else {
        if (active) { finish(index - 1); start = index; }
        active = { calls: [], boundaryIndex: index, partStartIndex: start,
          ...(usage ? { usageBoundaryIndex: index } : {}), subagentPartIndices: [],
          origin: usage ? "web-usage-boundary" : "web-assistant-boundary", gaps: [] };
      }
      continue;
    }
    if (part?.type !== "tool-call" && part?.type !== "subagent") continue;
    if (!active) { valid = false; continue; }
    active.executed = true;
    if (part.type === "subagent" || part.toolName === "Agent") active.subagentPartIndices.push(index);
    if (callAt.has(index)) active.calls.push(callAt.get(index));
  }
  if (active) finish(parts.length - 1);
  else if (allMessages && parts.slice(start).some(p => ["text", "reasoning"].includes(p?.type))) groups.push({ calls: [], origin: "web-prose", partStartIndex: start, partEndIndex: parts.length - 1, gaps: [] });
  if (groups.reduce((n, group) => n + group.calls.length, 0) !== calls.length) valid = false;
  // Terminal receipts may complete out of order *within* a parallel group.
  // They must not reverse or duplicate lifecycle sequence across groups.
  let previousMax = -1;
  for (const group of groups) {
    const seqs = group.calls.map(i => parts[toolAt.get(i)].history?.sequence).filter(v => v !== undefined);
    if (seqs.some(v => !Number.isSafeInteger(v) || v < 0 || v <= previousMax) || new Set(seqs).size !== seqs.length) valid = false;
    if (seqs.length) previousMax = Math.max(...seqs);
    delete group.executed;
  }
  return valid ? groups : [{ calls, origin: "web-message-conservative", gaps: ["assistant_step_boundaries_unknown"] }];
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
