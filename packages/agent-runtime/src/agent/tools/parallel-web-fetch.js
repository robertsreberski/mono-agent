// @ts-check
import { callParallelMcp, parallelFailure, parallelStructuredContent, PARALLEL_MCP_URL } from "./parallel-mcp.js";
import { guardedSearch } from "./web-search-providers/shared.js";
import { assertNoWebAccessInterstitial } from "./web-access-interstitial.js";
import { markdownToText } from "./web-document-extractor.js";

export function unsupportedParallelFetchOption(params) {
  if (params.format === "raw") return "format:raw";
  if (params.headers != null && Object.keys(params.headers).length) return "headers";
  if (["auto", "always"].includes(params.render)) return `render:${params.render}`;
  if (params.include_links) return "include_links";
  return undefined;
}

export async function fetchParallelDocument(url, params, options) {
  const started = Date.now();
  if (![url.href, PARALLEL_MCP_URL].every((target) => options.sandbox.networkAllowsUrl(options.policy, target))) {
    return { ok: false, backend: "parallel", code: "network_denied", message: "Network access denied by sandbox policy.", retryable: false };
  }
  try {
    return await guardedSearch("parallel", PARALLEL_MCP_URL, { ...options, admission: { processPolicy: "endpoint" } }, async () => {
      try {
        const response = await callParallelMcp("web_fetch", { urls: [url.href], full_content: true, session_id: options.sessionId }, options);
        const data = parallelStructuredContent(response);
        if (typeof data.extract_id !== "string" || !Array.isArray(data.errors)) throw new Error("Malformed Parallel extraction response.");
        const entry = data.results.find((item) => item.url === url.href);
        if (!entry) {
          const error = data.errors.find((item) => item?.url === url.href);
          const status = error?.http_status_code;
          if (Number.isInteger(status) && status >= 400 && status <= 599) {
            return { ok: false, backend: "parallel", code: `http_${status}`, statusCode: status,
              message: `Parallel extraction HTTP ${status}.`, retryable: status === 429 || status >= 500,
              ...(status === 429 ? { rateLimited: true, retryAfterMs: 60_000 } : {}) };
          }
          throw new Error("Parallel extraction unavailable.");
        }
        if (!(entry.full_content === null || typeof entry.full_content === "string")
          || !Array.isArray(entry.excerpts) || entry.excerpts.some((text) => typeof text !== "string")) throw new Error("Malformed Parallel extraction result.");
        const excerptsOnly = !entry.full_content;
        const markdown = excerptsOnly ? entry.excerpts.join("\n\n") : entry.full_content;
        if (!markdown.trim()) throw new Error("Parallel returned no readable content.");
        assertNoWebAccessInterstitial({ url: url.href, text: markdown });
        const body = params.format === "text" ? markdownToText(markdown) : markdown;
        const outcome = { status: "ok", code: "ok", backend: "parallel", retryable: false, attempts: 1,
          cacheHit: false, durationMs: Date.now() - started, bytes: Buffer.byteLength(body, "utf8"),
          truncated: false, rendered: false, extractionStage: "parallel", excerptsOnly };
        return { ok: true, document: { body, finalUrl: url.href,
          metadata: excerptsOnly ? "Parallel remote extraction [excerpts only]; full content unavailable." : "Parallel remote extraction; provider-supplied full content.", outcome } };
      } catch (error) { return parallelFailure(error, options.signal); }
    });
  } catch (error) { return parallelFailure(error, options.signal); }
}
