// MCP result coercion, truncation and artifact parameters.
import { isAbsolute, resolve, basename, dirname } from "node:path";
import { isInsidePath } from "../shared/path-resolver.js";
import { mkdirSync } from "node:fs";
import { requireToolContext } from "../shared/tool-context.js";
import { normalizeImageForModel } from "../shared/image.js";
import { summarisePayload } from "../../agent/tool-bloat.js";

export const MCP_TEXT_RESULT_LIMIT = 12_000;

const MCP_RAW_DETAIL_LIMIT = 4_000;

export const MCP_IMAGE_INLINE_MAX_BYTES = 250_000;

const PLAYWRIGHT_FILENAME_TOOLS = new Set([
  "browser_console_messages",
  "browser_snapshot",
  "browser_take_screenshot",
]);

function artifactFilename(filename: any, outputDir: any) {
  if (!filename || typeof filename !== "string" || isAbsolute(filename) || !outputDir) return filename;
  const base = resolve(outputDir);
  const requested = resolve(base, filename);
  const target = isInsidePath(base, requested) ? requested : resolve(base, basename(filename));
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

/**
 * @param {any} _serverName
 * @param {any} toolName
 * @param {any} params
 * @param {{qaOutputDir?: any, ctx?: any}} [options]
 */
export function normalizeMcpToolParams(_serverName: any, toolName: any, params: any, { qaOutputDir, ctx }: { qaOutputDir?: any; ctx?: any } = {}): any {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  if (!PLAYWRIGHT_FILENAME_TOOLS.has(toolName) || !params.filename || isAbsolute(String(params.filename))) return params;
  const dir = qaOutputDir ?? (requireToolContext(ctx)).qaOutputDir;
  return {
    ...params,
    filename: artifactFilename(params.filename, dir),
  };
}

function base64Bytes(data: any) {
  const text = String(data || "");
  if (!text) return 0;
  const clean = text.includes(",") ? text.slice(text.indexOf(",") + 1) : text;
  return Math.floor(clean.length * 0.75);
}

function truncateMcpText(text: any, limit: number = MCP_TEXT_RESULT_LIMIT) {
  const value = String(text || "");
  if (value.length <= limit) return { text: value, truncated: false, originalLength: value.length };
  const marker = [
    "",
    `[truncated MCP tool result from ${value.length} to ${limit} characters]`,
    "Use a more specific MCP tool, filters, or a detail/get tool for the exact item you need.",
  ].join("\n");
  return {
    text: `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`,
    truncated: true,
    originalLength: value.length,
  };
}

export function compactRawMcpResult(out: any): any {
  let text;
  try {
    text = JSON.stringify(out || {});
  } catch {
    text = String(out ?? "");
  }
  if (text.length <= MCP_RAW_DETAIL_LIMIT) return out;
  return {
    truncated: true,
    original_length: text.length,
    preview: `${text.slice(0, MCP_RAW_DETAIL_LIMIT)}\n[truncated raw MCP result]`,
  };
}

// MCP servers hand back screenshots at whatever size they captured — the
// Playwright browser tools in particular follow browser_resize, so a wide desktop
// capture arrives well past the provider ceiling while staying tiny in bytes and
// sailing through the byte cap below. Normalize pixels before measuring bytes: a
// shrunk screenshot may now fit the inline budget instead of being dropped for a
// text pointer.
async function normalizeMcpImage(data: any, mimeType: any) {
  const raw = typeof data === "string" ? data : String(data ?? "");
  const source = Buffer.from(raw, "base64");
  if (source.length === 0) return { data: raw, mimeType };
  const normalized = await normalizeImageForModel(source, mimeType);
  // Shrinking is best-effort. An undecodable payload keeps the block exactly as
  // the server sent it: losing the tool result would be worse than an oversized one.
  if (normalized.reason !== undefined) return { data: raw, mimeType };
  // Images already within the ceiling come back as the same buffer. Return the
  // original base64 so the common path stays byte-identical and re-encodes nothing.
  if (normalized.data === source) return { data: raw, mimeType };
  return { data: normalized.data.toString("base64"), mimeType: normalized.mimeType };
}

export async function coerceMcpContent(out: any, {
  textLimit = MCP_TEXT_RESULT_LIMIT,
  imageInlineMaxBytes = MCP_IMAGE_INLINE_MAX_BYTES,
  persistArtifact = null,
  toolName = "mcp",
  toolUseId = null,
  onTruncate = null,
}: { textLimit?: number; imageInlineMaxBytes?: number; persistArtifact?: any; toolName?: string; toolUseId?: any; onTruncate?: any } = {}): Promise<any[]> {
  if (Array.isArray(out?.content) && out.content.length) {
    return await Promise.all(out.content.map(async (part: any) => {
      if (part.type === "text") return { type: "text", text: truncateMcpText(part.text || "", textLimit).text };
      if (part.type === "image") {
        const image = await normalizeMcpImage(part.data, part.mimeType || part.mime_type || "image/png");
        const bytes = base64Bytes(image.data);
        if (bytes > imageInlineMaxBytes) {
          const summary = summarisePayload(toolName, [{
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          }], persistArtifact, { maxBytes: imageInlineMaxBytes, toolUseId });
          if (summary.truncated && typeof onTruncate === "function") {
            try {
              onTruncate({
                tool: toolName,
                tool_use_id: toolUseId,
                original_bytes: summary.originalBytes,
                max_bytes: imageInlineMaxBytes,
                saved_paths: summary.savedPaths,
              });
            } catch { /* best-effort */ }
          }
          return summary.rewrittenBlocks[0] || {
            type: "text",
            text: `[omitted MCP image result: ${bytes} bytes exceeds ${imageInlineMaxBytes} byte context budget]`,
          };
        }
        return {
          type: "image",
          data: image.data,
          mimeType: image.mimeType,
        };
      }
      return { type: "text", text: truncateMcpText(JSON.stringify(part), textLimit).text };
    }));
  }
  return [{ type: "text", text: truncateMcpText(JSON.stringify(out || {}), textLimit).text }];
}

// Text-only. Images are measured after dimension normalization inside
// coerceMcpContent, which reports a real truncation through onTruncate; judging
// the raw part here would flag a screenshot that shrinking brought back under budget.
export function mcpContentWasTruncated(out: any, { textLimit = MCP_TEXT_RESULT_LIMIT }: { textLimit?: number } = {}): any {
  if (Array.isArray(out?.content) && out.content.length) {
    return out.content.some((part: any) => {
      if (part.type === "text") return truncateMcpText(part.text || "", textLimit).truncated;
      if (part.type === "image") return false;
      return truncateMcpText(JSON.stringify(part), textLimit).truncated;
    });
  }
  return truncateMcpText(JSON.stringify(out || {}), textLimit).truncated;
}
