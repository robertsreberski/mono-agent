// @ts-check
import { isIP } from "node:net";
import { claimWebSearchRequest, countWebSearchDispatch } from "../web-search-state.js";
import { requestSignal, readLimitedText, normalizedResult, ollamaFetchFailure, parseRetryAfter } from "./shared.js";
export const ollamaProvider = {
  name: "ollama", batchesQueries: false,
  filterSupport: { language: "advisory", timeRange: "advisory", country: "unsupported" },
  configure(input, selected) {
    const result = normalizeOllamaSearchConfig(input?.ollama, selected ? "ollama" : undefined);
    return result.error ? result : { value: { ollama: result.value } };
  },
  eligibility: (config) => Boolean(config.ollama),
  admission: (config) => ({ kind: "ollama", key: config.ollama.baseUrl, processPolicy: "endpoint" }),
  networkTargets: (config) => [config.ollama.baseUrl],
  search: searchOllama,
};
async function searchOllama(query, options) {
  const config = options.config.ollama;
  if (!config) {
    return { ok: false, backend: "ollama", message: "Ollama Web Search is not configured.", retryable: false };
  }
  const official = config.baseUrl === "https://ollama.com";
  const paths = official ? ["/api/web_search"] : ["/api/experimental/web_search", "/api/web_search"];
  for (let index = 0; index < paths.length; index += 1) {
    const url = `${config.baseUrl}${paths[index]}`;
    if (!options.sandbox.networkAllowsUrl(options.policy, url)) {
      return { ok: false, backend: "ollama", message: "Network access denied by sandbox policy.", retryable: false };
    }
    try {
      if (index === 0) claimWebSearchRequest(options.searchState, "ollama", options.callClaims);
      else countWebSearchDispatch(options.searchState, "ollama");
      const response = await options.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "mono-agent-web/1",
          ...(official ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ query, max_results: options.maxResults }),
        signal: requestSignal(options.signal),
        redirect: "error",
      });
      const text = await readLimitedText(response);
      if (!official && index === 0 && [404, 405].includes(response.status)) continue;
      if (!official && index === 1 && [404, 405].includes(response.status)) {
        return { ok: false, backend: "ollama", code: "endpoint_not_supported", message: "Ollama Web Search endpoints are not supported by this server.", retryable: false };
      }
      if (!response.ok) {
        return {
          ok: false,
          backend: "ollama",
          code: [401, 403].includes(response.status) ? "auth_failed"
            : response.status === 408 ? "timeout"
              : response.status === 429 ? "rate_limited"
              : response.status >= 500 ? "provider_unavailable" : "provider_unavailable",
          message: `Ollama Web Search HTTP ${response.status}`,
          rateLimited: response.status === 429,
          retryAfterMs: parseRetryAfter(response),
          retryable: [408, 429].includes(response.status) || response.status >= 500,
        };
      }
      let data;
      try { data = JSON.parse(text); } catch {
        return { ok: false, backend: "ollama", code: "invalid_response", message: "Ollama Web Search returned invalid JSON.", retryable: false };
      }
      if (!Array.isArray(data?.results)) {
        return { ok: false, backend: "ollama", code: "invalid_response", message: "Ollama Web Search returned no results array.", retryable: false };
      }
      const results = data.results.flatMap((entry) => normalizedResult(entry, "ollama"));
      if (data.results.length > 0 && results.length === 0) {
        return { ok: false, backend: "ollama", code: "invalid_response", message: "Ollama Web Search returned no usable result URLs.", retryable: false };
      }
      return {
        ok: true,
        backend: "ollama",
        results,
      };
    } catch (error) {
      return ollamaFetchFailure(error, options.signal);
    }
  }
  return { ok: false, backend: "ollama", message: "Ollama Web Search endpoint is unavailable.", retryable: false };
}

function normalizeOllamaSearchConfig(input, backend) {
  if (backend !== "ollama" && input === undefined) return { value: undefined };
  let parsed;
  try { parsed = new URL(input?.baseUrl || "http://127.0.0.1:11434"); }
  catch { return { error: "Ollama Web Search base URL must be a valid HTTP(S) origin." }; }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !["", "/"].includes(parsed.pathname)) {
    return { error: "Ollama Web Search base URL must be an HTTP(S) origin without credentials, path, query, or fragment." };
  }
  const baseUrl = parsed.origin;
  const official = baseUrl === "https://ollama.com";
  if (!official && !isPrivateOllamaOrigin(parsed) && (parsed.protocol !== "https:" || input?.trustPublicUrl !== true)) {
    return { error: "A public custom Ollama origin requires HTTPS and trustPublicUrl=true." };
  }
  if (!official && (input?.apiKey !== undefined || input?.apiKeyEnv !== undefined)) {
    return { error: "Ollama Web Search credentials are allowed only for the exact https://ollama.com origin." };
  }
  if (official && (typeof input?.apiKey !== "string" || input.apiKey.trim().length === 0)) {
    return { error: "Hosted Ollama Web Search requires a resolved API key.", code: "auth_missing" };
  }
  return { value: {
    baseUrl,
    trustPublicUrl: input?.trustPublicUrl === true,
    ...(official ? { apiKey: input.apiKey } : {}),
    ...(typeof input?.apiKeyEnv === "string" ? { apiKeyEnv: input.apiKeyEnv } : {}),
  } };
}

function isPrivateOllamaOrigin(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "host.docker.internal", "::1"].includes(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

