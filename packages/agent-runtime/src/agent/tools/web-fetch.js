import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import { networkPolicyAllowsUrl } from "@mono-agent/sandbox";
import { resolveSandboxPolicy } from "./shared/runtime-context.js";

const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

export async function webFetchToolImpl({ url, headers = {}, max_output_chars }, { sandboxPolicy } = {}) {
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  let parsed;
  try { parsed = new URL(url); } catch { return "Error: Invalid URL"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: WebFetch only supports http(s) URLs.";
  }
  const policy = resolveSandboxPolicy(sandboxPolicy);
  if (!networkPolicyAllowsUrl(policy, parsed.href)) return "Error: Network access denied by sandbox policy.";
  const requestHeaders = { "User-Agent": "AgentRuntime/0.1", ...headers };
  try {
    const restricted = policy !== undefined && policy.network.mode !== "all";
    const resp = restricted
      ? await fetchCheckingRedirects(parsed, requestHeaders, policy)
      : await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (typeof resp === "string") return resp;
    const text = await resp.text();
    if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    return capChars(text, { label: "WebFetch", maxChars });
  } catch (err) {
    return `Error fetching URL: ${err.message}`;
  }
}

// fetch() follows redirects transparently, which would let an allowed host
// bounce the request to a denied one — follow them manually and re-check the
// policy on every hop. Custom headers only travel to the original origin.
async function fetchCheckingRedirects(initialUrl, headers, policy) {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sameOrigin = current.origin === initialUrl.origin;
    const resp = await fetch(current, {
      headers: sameOrigin ? headers : { "User-Agent": headers["User-Agent"] },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = resp.headers.get("location");
    if (resp.status < 300 || resp.status >= 400 || !location) return resp;
    let next;
    try { next = new URL(location, current); } catch { return "Error: Invalid redirect URL."; }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return "Error: WebFetch only supports http(s) URLs.";
    }
    if (!networkPolicyAllowsUrl(policy, next.href)) {
      return "Error: Network access denied by sandbox policy (redirect).";
    }
    try { await resp.body?.cancel(); } catch { /* best-effort */ }
    current = next;
  }
  return "Error: Too many redirects.";
}
