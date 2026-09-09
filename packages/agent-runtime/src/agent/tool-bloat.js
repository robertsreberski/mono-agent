// Tool-result bloat containment.
//
// Single tool_result payloads can reach several megabytes and frequently trip
// the context_bloat warning. This module caps tool_result payloads before they
// reach the model and substitutes a compact reference text so the agent can
// still cite the artifact.
//
// Persistence is delegated to the host via a `persistArtifact({ filename, buffer,
// toolName, toolUseId }) -> path | null` callback. The app binds that callback
// per run and stores payloads under its configured tool-output artifact root.
// Hosts that don't provide a sink still receive bounded retained text.

export const MAX_TOOL_RESULT_BYTES = 262144;

export const BINARY_BLOAT_TOOLS = Object.freeze([
  "mcp__playwright__browser_take_screenshot",
  "mcp__playwright__browser_snapshot",
]);

export const DEFAULT_TOOL_BLOAT_CONFIG = Object.freeze({
  maxBytes: MAX_TOOL_RESULT_BYTES,
  binaryBloatTools: BINARY_BLOAT_TOOLS,
});

const RETAINED_UNTRUSTED_BEGIN = "[BEGIN RETAINED UNTRUSTED TOOL RESULT]";
const RETAINED_UNTRUSTED_END = "[END RETAINED UNTRUSTED TOOL RESULT]";
const RETAINED_MIDDLE_NOTICE = "[Omitted middle may contain additional source content; retained tail is not the source ending.]";

function blockBytes(block) {
  if (!block || typeof block !== "object") return 0;
  if (block.type === "text") return Buffer.byteLength(String(block.text || ""), "utf8");
  if (block.type === "image") {
    const data = String(block.data || "");
    const clean = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    return Math.floor(clean.length * 0.75);
  }
  try { return Buffer.byteLength(JSON.stringify(block), "utf8"); } catch { return 0; }
}

function totalBytes(blocks) {
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce((sum, block) => sum + blockBytes(block), 0);
}

function safeBasename(name) {
  return String(name || "tool").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
}

function imageExtension(block) {
  const mime = block?.mimeType || block?.mime_type || "";
  const m = /image\/([a-z0-9]+)/i.exec(mime);
  return m ? `.${m[1].toLowerCase()}` : ".bin";
}

function persistBlock(toolName, block, idx, idTag, persistArtifact) {
  if (typeof persistArtifact !== "function" || !block || typeof block !== "object") return null;
  let filename;
  let buffer;
  if (block.type === "image") {
    filename = `${safeBasename(toolName)}__${idTag}__${idx}${imageExtension(block)}`;
    const data = String(block.data || "");
    const clean = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    buffer = Buffer.from(clean, "base64");
  } else {
    const text = block.type === "text"
      ? String(block.text || "")
      : (() => {
          try { return JSON.stringify(block, null, 2); } catch { return String(block); }
        })();
    filename = `${safeBasename(toolName)}__${idTag}__${idx}.txt`;
    buffer = Buffer.from(text, "utf8");
  }
  try {
    const path = persistArtifact({ filename, buffer, toolName, toolUseId: idTag });
    return typeof path === "string" && path.length ? path : null;
  } catch {
    return null;
  }
}

function controlFree(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

function persistenceSummary(savedPaths, includePath = true) {
  if (savedPaths.length === 0) return "persistence unavailable";
  if (!includePath) return `saved_files=${savedPaths.length}`;
  if (savedPaths.length === 1) return `saved_to=${controlFree(savedPaths[0])}`;
  return `saved_to=${controlFree(savedPaths[0])}; saved_files=${savedPaths.length}`;
}

function summaryText(toolName, originalBytes, retainedBytes, maxBytes, savedPaths, includePath = true) {
  const parts = [
    `[truncated tool_result: ${originalBytes} bytes exceeded ${maxBytes} byte cap`,
    `retained=${retainedBytes} bytes`,
    `tool=${controlFree(toolName)}`,
  ];
  parts.push(persistenceSummary(savedPaths, includePath));
  return `${parts.join("; ")}]`;
}

function capSummary(text, maxBytes) {
  for (const candidate of [text, "[truncated tool_result]", "[truncated]", "[]"]) {
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }
  return "";
}

function summaryOnly(toolName, originalBytes, maxBytes, savedPaths) {
  const parts = [
    `[truncated tool_result: ${originalBytes} bytes exceeded ${maxBytes} byte cap`,
    `tool=${controlFree(toolName)}`,
  ];
  parts.push(persistenceSummary(savedPaths));
  return `${parts.join("; ")}]`;
}

function neutralizeRetainedFrames(value) {
  return value
    .replaceAll(RETAINED_UNTRUSTED_BEGIN, `(BEGIN RETAINED UNTRUSTED TOOL RESULT)`)
    .replaceAll(RETAINED_UNTRUSTED_END, `(END RETAINED UNTRUSTED TOOL RESULT)`)
    .replaceAll(RETAINED_MIDDLE_NOTICE, `(Omitted middle may contain additional source content; retained tail is not the source ending.)`);
}

function utf8Head(value, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let out = "";
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maxBytes) break;
    out += point;
    bytes += size;
  }
  return out;
}

function utf8Tail(value, maxBytes) {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  const out = [];
  for (const point of [...value].reverse()) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > maxBytes) break;
    out.push(point);
    bytes += size;
  }
  return out.reverse().join("");
}

function retainedTextPayload(toolName, blocks, originalBytes, maxBytes, savedPaths) {
  const source = neutralizeRetainedFrames(blocks.map((block) => String(block.text || "")).join("\n\n"));
  const maximumDigits = String(originalBytes).length;
  const retainedPlaceholder = "9".repeat(maximumDigits);
  const omittedPlaceholder = "9".repeat(maximumDigits);
  let summary = summaryText(toolName, originalBytes, Number(retainedPlaceholder), maxBytes, savedPaths, true);
  const fixedBody = [
    summary,
    RETAINED_UNTRUSTED_BEGIN,
    "",
    `[... ${omittedPlaceholder} source bytes omitted ...]`,
    RETAINED_MIDDLE_NOTICE,
    "",
    RETAINED_UNTRUSTED_END,
  ].join("\n");
  if (Buffer.byteLength(fixedBody, "utf8") > maxBytes) {
    summary = summaryText(toolName, originalBytes, 0, maxBytes, savedPaths, false);
    return capSummary(summary, maxBytes);
  }

  const sourceBudget = maxBytes - Buffer.byteLength(fixedBody, "utf8");
  const head = utf8Head(source, Math.floor(sourceBudget * 0.6));
  const tail = utf8Tail(source, sourceBudget - Buffer.byteLength(head, "utf8"));
  const retainedBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(0, originalBytes - retainedBytes);
  summary = summaryText(toolName, originalBytes, retainedBytes, maxBytes, savedPaths, true);
  const rendered = [
    summary,
    RETAINED_UNTRUSTED_BEGIN,
    head,
    `[... ${omittedBytes} source bytes omitted ...]`,
    RETAINED_MIDDLE_NOTICE,
    tail,
    RETAINED_UNTRUSTED_END,
  ].join("\n");
  if (Buffer.byteLength(rendered, "utf8") <= maxBytes) return rendered;

  // A long saved path can make the exact-path summary larger than the reserved
  // placeholder. Preserve the trust frame and source slices by falling back to
  // the honest saved-file count, never by returning a partial path.
  const countSummary = summaryText(toolName, originalBytes, retainedBytes, maxBytes, savedPaths, false);
  const countRendered = [countSummary, ...rendered.split("\n").slice(1)].join("\n");
  return Buffer.byteLength(countRendered, "utf8") <= maxBytes
    ? countRendered
    : capSummary(countSummary, maxBytes);
}

export function summarisePayload(toolName, contentBlocks, persistArtifact, options = {}) {
  const {
    maxBytes = MAX_TOOL_RESULT_BYTES,
    imageMaxBytes = maxBytes,
    toolUseId = null,
    now = Date.now,
  } = options;
  const blocks = Array.isArray(contentBlocks) ? contentBlocks : [];
  const originalBytes = totalBytes(blocks);
  // Images get their own (typically larger) budget so a vision model can still
  // see large screenshots; text/other payloads stay bound by maxBytes.
  const imageBytes = blocks.reduce((sum, block) => sum + (block?.type === "image" ? blockBytes(block) : 0), 0);
  const otherBytes = originalBytes - imageBytes;
  if (otherBytes <= maxBytes && imageBytes <= imageMaxBytes) {
    return { rewrittenBlocks: blocks, savedPaths: [], originalBytes, truncated: false };
  }

  const stamp = String(now()).slice(-10);
  const idTag = toolUseId ? safeBasename(toolUseId) : `payload-${stamp}`;
  const savedPaths = [];
  blocks.forEach((block, idx) => {
    const path = persistBlock(toolName, block, idx, idTag, persistArtifact);
    if (path) savedPaths.push(path);
  });
  const textOnly = blocks.length > 0 && blocks.every((block) => block?.type === "text");
  const rewrittenText = textOnly && otherBytes > maxBytes && imageBytes === 0
    ? retainedTextPayload(toolName, blocks, originalBytes, maxBytes, savedPaths)
    : summaryOnly(toolName, originalBytes, maxBytes, savedPaths);
  return {
    rewrittenBlocks: [{ type: "text", text: rewrittenText }],
    savedPaths,
    originalBytes,
    truncated: true,
  };
}

export async function applyToolBloatGuard(toolName, executePromise, options = {}) {
  const {
    persistArtifact = null,
    toolUseId = null,
    maxBytes = MAX_TOOL_RESULT_BYTES,
    imageMaxBytes = maxBytes,
    onTruncate = null,
  } = options;
  const result = await executePromise;
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  const summary = summarisePayload(toolName, result.content, persistArtifact, { maxBytes, imageMaxBytes, toolUseId });
  if (!summary.truncated) return result;
  if (typeof onTruncate === "function") {
    try {
      onTruncate({
        tool: toolName,
        tool_use_id: toolUseId,
        original_bytes: summary.originalBytes,
        max_bytes: maxBytes,
        saved_paths: summary.savedPaths,
      });
    } catch { /* best-effort */ }
  }
  return {
    ...result,
    content: summary.rewrittenBlocks,
    details: {
      ...(result.details || {}),
      tool_payload_truncated: true,
      tool_payload_original_bytes: summary.originalBytes,
      tool_payload_saved_paths: summary.savedPaths,
    },
  };
}

export function wrapToolsWithBloatGuard(tools, options = {}) {
  const list = Array.isArray(tools) ? tools : [];
  return list.map((tool) => {
    if (!tool || typeof tool.execute !== "function") return tool;
    const originalExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(toolCallId, params, signal) {
        return applyToolBloatGuard(tool.name, originalExecute(toolCallId, params, signal), {
          ...options,
          toolUseId: toolCallId,
        });
      },
    };
  });
}
