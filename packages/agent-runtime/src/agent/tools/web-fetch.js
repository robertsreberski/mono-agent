import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import { networkPolicyAllowsUrl } from "@mono-agent/sandbox";

export async function webFetchToolImpl({ url, headers = {}, max_output_chars }, { sandboxPolicy } = {}) {
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  let parsed;
  try { parsed = new URL(url); } catch { return "Error: Invalid URL"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: WebFetch only supports http(s) URLs.";
  }
  if (!networkPolicyAllowsUrl(sandboxPolicy, parsed.href)) return "Error: Network access denied by sandbox policy.";
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "AgentRuntime/0.1", ...headers }, signal: AbortSignal.timeout(15000) });
    const text = await resp.text();
    if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 500)}`;
    return capChars(text, { label: "WebFetch", maxChars });
  } catch (err) {
    return `Error fetching URL: ${err.message}`;
  }
}
