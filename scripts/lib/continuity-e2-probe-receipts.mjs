// Private, informational retrieval evidence. Never forwarded to a model or gate.
import { writeE2ProbeReceipt, writeE2ProgressGap } from "./continuity-e2-progress.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
// Entry count is shared by every probe in one run to bound total receipt disk use.
export const E2_PROBE_RECEIPT_LIMITS = Object.freeze({ entries: 4096, argumentsBytes: 8192, responseBytes: 65536, metadataBytes: 32768, parseBytes: 1048576 });
function bounded(text, limit) {
  const bytes = Buffer.from(text), truncated = bytes.length > limit;
  // Decode only complete UTF-8 characters; the marker is outside the byte cap.
  let end = Math.min(bytes.length, limit);
  if (truncated) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const excerpt = bytes.subarray(0, end).toString("utf8");
  return { text: excerpt + (truncated ? "\n[probe receipt truncated]" : ""), bytes: bytes.length, capturedBytes: end, sha256: digest(bytes), truncated };
}
function responseText(content, summarize = true) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content.flatMap(block => block?.type === "text" && typeof block.text === "string"
    ? [block.text] : summarize ? [`[non-text ${typeof block?.type === "string" ? block.type : "unknown"} block]`] : []).join("\n");
}
function metadata(text) {
  if (Buffer.byteLength(text) > E2_PROBE_RECEIPT_LIMITS.parseBytes) return { status: "oversized" };
  // MCP may split its model-facing JSON into continued sections. Parse a copy,
  // retaining the original, unmodified text separately for clipping diagnosis.
  const joined = text.replace(/\n?\[continued section \d+ of \d+\]\n/gu, "");
  // Ignore inline navigation argument examples preceding the actual response.
  const start = joined.search(/^\s*\{\s*"(?:action|status)"\s*:/mu);
  if (start < 0) return { status: "unparsed" };
  let body; try { body = JSON.parse(joined.slice(start)); } catch { return { status: "unparsed" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || body.items !== undefined && !Array.isArray(body.items)) return { status: "unparsed" };
  const records = (body.items ?? (body.record !== undefined ? [body.record] : [])).slice(0, 10).flatMap((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return [];
    const row = { rank: index + 1 }; // Returned page order, not an inferred relevance score.
    for (const key of ["recordId", "ordinal", "kind", "sha256", "retainedBytes", "originalBytes", "truncated", "redacted", "status", "previewTruncated"])
      if (["string", "number", "boolean"].includes(typeof record[key])) row[key] = record[key];
    if (typeof record.preview === "string") row.previewBytes = Buffer.byteLength(record.preview);
    return [row];
  });
  const result = { status: "parsed", records };
  for (const key of ["action", "status", "nextCursor", "chunkOffset", "hasMore", "count"])
    if (["string", "number", "boolean"].includes(typeof body[key])) result[key === "status" ? "responseStatus" : key] = body[key];
  if (typeof body.chunk === "string") result.chunkBytes = Buffer.byteLength(body.chunk);
  return result;
}
export function createE2ProbeReceipts({ output, slotId, registrationSha256, noteProgressGap = () => {}, enabled = true }) {
  let binding, requestContext, requestOrdinal = 0, ordinal = 0, progressGap = 0, queue = Promise.resolve(), capped = false;
  const calls = new Map();
  function gap() {
    progressGap = Math.min(4096, noteProgressGap() ?? progressGap + 1);
    queue = queue.then(() => writeE2ProgressGap(output, progressGap)).catch(() => {});
  }
  function publish(value) {
    if (++ordinal > E2_PROBE_RECEIPT_LIMITS.entries) { if (!capped) { capped = true; gap(); } return; }
    const entry = ordinal;
    // Capture synchronously, write serially; no tool/model bytes are mutated.
    queue = queue.then(() => writeE2ProbeReceipt(output, entry, value)).catch(() => { gap(); });
  }
  return {
    begin(value) { binding = { slotId, ...(registrationSha256 ? { registrationSha256 } : {}), ...value }; requestOrdinal = 0; calls.clear(); },
    observeRequest(context) {
      if (!enabled || !binding) return;
      requestOrdinal++; requestContext = undefined;
      try { if (context) { const text = JSON.stringify(context); requestContext = { bytes: Buffer.byteLength(text), sha256: digest(text) }; } }
      catch { gap(); }
    },
    observe(event) {
      if (!enabled || !binding) return;
      try {
        for (const part of event.message?.content ?? []) {
          if (event.type === "assistant" && part.type === "tool_use" && (part.name === "ConversationHistory" || part.name?.endsWith("__ConversationHistory"))) {
            const call = { ...binding, requestOrdinal, ...(requestContext ? { requestContext } : {}), callId: bounded(String(part.id), 1024), arguments: bounded(JSON.stringify(part.input), E2_PROBE_RECEIPT_LIMITS.argumentsBytes) };
            // Bound retained call state too; the entry cap is shared by all probes.
            if (ordinal >= E2_PROBE_RECEIPT_LIMITS.entries) { publish({}); continue; }
            calls.set(part.id, call);
            publish({ schema: "continuity-e2-probe-receipt-v1", phase: "call", ...call });
          } else if (event.type === "user" && part.type === "tool_result" && calls.has(part.tool_use_id)) {
            const call = calls.get(part.tool_use_id); calls.delete(part.tool_use_id);
            const text = responseText(part.content);
            publish({ schema: "continuity-e2-probe-receipt-v1", phase: "response", ...call, isError: part.is_error === true,
              response: bounded(text, E2_PROBE_RECEIPT_LIMITS.responseBytes), metadata: bounded(JSON.stringify(metadata(responseText(part.content, false))), E2_PROBE_RECEIPT_LIMITS.metadataBytes) });
          }
        }
      } catch { gap(); } // Diagnostic capture failures never replace a run outcome.
    },
    async flush() { while (true) { const pending = queue; await pending; if (pending === queue) break; } },
    progressGap: () => progressGap,
  };
}
