// @ts-check
// Native, host-governed transport. No Hound impersonation/proxy/retry code.
import { guardedSearch, acquireKeylessRequestSlot, rateLimited } from "../web-search-providers/shared.js";
import { decodeWebBytes } from "../web-document-extractor.js";
import { classifyWebAccessInterstitial } from "../web-access-interstitial.js";

export const HOUND_USER_AGENT = "mono-agent-hound/1 (web research)";

export function assertHoundTarget(url, options) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
    || !options.sandbox.networkAllowsUrl(options.policy, parsed.href)) {
    throw Object.assign(new Error("Network access denied by sandbox policy."), { code: "network_denied" });
  }
  return parsed;
}

/** Each real request is gated before either host admission or byte acquisition.
 * Redirects are returned, never followed by fetch; the caller owns hop policy.
 */
export async function houndRequest(url, options, init = {}, maxBytes = 2 * 1024 * 1024) {
  const target = assertHoundTarget(url, options);
  const kind = options.engine ?? "fetch";
  const key = options.engine ?? target.origin;
  const result = await guardedSearch(kind, key, {
    ...options, admission: { processPolicy: options.engine ? "keyless" : "endpoint" },
  }, async () => {
    const release = options.engine ? await acquireKeylessRequestSlot(kind, options.signal) : () => {};
    try {
      options.signal?.throwIfAborted();
      options.beforeDispatch?.();
      const response = await options.fetchImpl(target.href, {
        ...init, redirect: "manual", signal: options.signal,
        headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": options.userAgent ?? HOUND_USER_AGENT, ...init.headers },
      });
      const bytes = await readHoundBytes(response, maxBytes, options.signal);
      const text = decodeWebBytes(bytes, response.headers.get("content-type") ?? "text/plain").text;
      const challenge = classifyWebAccessInterstitial({ url: target.href, text, statusCode: response.status });
      const softGate = (options.rejectRedirects && response.status >= 300 && response.status < 400)
        || response.status === 202 || response.status === 403
        || /anubis[_-]?challenge|verifying your request|challenge-form|anomaly-modal/iu.test(text);
      if (response.status === 429 || challenge || softGate) {
        const limited = rateLimited({ backend: kind, label: "Hound engine" }, "access refused", response);
        return { ...limited, code: response.status === 429 ? "rate_limited" : challenge?.code ?? "access_challenge" };
      }
      return { ok: true, response, text };
    } finally { release(); }
  });
  options.recordMetrics?.(result);
  if (!result.ok) throw Object.assign(new Error("Hound request refused."), {
    code: result.code ?? (result.cooldown || result.rateLimited ? "rate_limited" : "backend_unavailable"), retryAfterMs: result.retryAfterMs,
  });
  options.signal?.throwIfAborted();
  return result;
}

export async function readHoundBytes(response, maxBytes, signal) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw Object.assign(new Error("Hound response exceeded byte limit."), { code: "response_too_large" });
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) throw Object.assign(new Error("Hound response exceeded byte limit."), { code: "response_too_large" });
      chunks.push(item.value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
