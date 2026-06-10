import { networkPolicyAllowsUrl } from "@mono-agent/sandbox";

export async function webSearchToolImpl({ query, limit = 5 }, { sandboxPolicy } = {}) {
  const max = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (!networkPolicyAllowsUrl(sandboxPolicy, url)) return "Error: Network access denied by sandbox policy.";
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 AgentRuntime/0.1" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return `Search failed: HTTP ${resp.status}`;
  const html = await resp.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    results.push(`${m[2].replace(/<[^>]+>/g, "").trim()}\n${m[1]}\n${m[3].replace(/<[^>]+>/g, "").trim()}`);
  }
  return results.length ? results.join("\n\n") : "No results.";
}
