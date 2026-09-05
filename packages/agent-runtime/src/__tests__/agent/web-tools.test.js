import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { renderWithAgentBrowser } from "../../agent/tools/web-browser-render.js";
import {
  __resetSharedSearchCacheForTests,
  createWebToolController,
} from "../../agent/tools/web-controller.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import {
  __resetWebSearchThrottleForTests,
  canonicalizeSearchUrl,
  mergeRankedResults,
  parseStartpageResults,
  performWebSearch,
} from "../../agent/tools/web-search.js";

const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-web-"));
  tempDirs.push(dir);
  return dir;
}

function runtimeContext(workspace = tempWorkspace(), sandbox = passthroughSandbox) {
  return { workspace, sandbox };
}

// The throttle, the backend cooldowns and the search cache are module state so
// that they bind every subagent in the process. Tests must therefore reset them,
// and drop the inter-request spacing so the suite does not pay for it.
beforeEach(() => {
  __resetWebSearchThrottleForTests({ minSpacingMs: 0 });
  __resetSharedSearchCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetWebSearchThrottleForTests();
  __resetSharedSearchCacheForTests();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("WebSearch", () => {
  it("rejects stateful SearXNG endpoint components before making a request", async () => {
    const fetchImpl = vi.fn();
    const result = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088?format=html#unsafe" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "invalid_search_config" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("queries strict loopback SearXNG, skips unneeded alternates, filters domains, and canonicalizes URLs", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        results: [
          {
            title: "Agent tools primary",
            url: "https://Example.com/article/?utm_source=test#section",
            content: "Useful result",
          },
          {
            title: "Duplicate",
            url: "https://example.com/article",
            content: "",
          },
          {
            title: "Excluded",
            url: "https://docs.example.com/private",
            content: "filtered",
          },
        ],
      }), { headers: { "content-type": "application/json" } });
    });

    const result = await performWebSearch({
      query: "agent tools",
      alternate_queries: ["runtime tools"],
      domains: ["example.com"],
      exclude_domains: ["docs.example.com"],
      language: "nl-NL",
      time_range: "month",
      limit: 5,
    }, {
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result.error).toBe(false);
    expect(result.outcome).toMatchObject({
      status: "ok",
      backend: "searxng",
      attempts: 1,
      resultCount: 1,
    });
    expect(result.text).toContain("https://example.com/article");
    expect(result.text).not.toContain("utm_source");
    expect(result.text).not.toContain("docs.example.com");
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call.url).toBe("http://127.0.0.1:8088/search");
      expect(call.init.method).toBe("POST");
      const body = new URLSearchParams(call.init.body);
      expect(body.get("q")).toContain("site:example.com");
      expect(body.get("language")).toBe("nl-NL");
      expect(body.get("time_range")).toBe("month");
    }
  });

  it("keeps strict SearXNG failures strict while auto falls back to keyless HTML search", async () => {
    const strictFetch = vi.fn(async () => new Response("down", { status: 503 }));
    const strict = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
      fetchImpl: strictFetch,
      ctx: runtimeContext(),
    });
    expect(strict).toMatchObject({
      error: true,
      outcome: { status: "error", code: "backend_unavailable", attempts: 1 },
    });
    expect(strictFetch).toHaveBeenCalledTimes(1);

    const autoFetch = vi.fn(async (url) => {
      if (String(url).startsWith("http://127.0.0.1")) {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      return new Response(`
        <div class="result">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Futm_campaign%3Dx">Mono agent guide</a>
          <div class="result__snippet">A useful mono-agent guide.</div>
        </div>
      `);
    });
    const automatic = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "auto", endpoint: "http://127.0.0.1:8088" },
      codexSearch: vi.fn(async () => ({
        ok: false, backend: "codex", message: "Codex subscription search unavailable.", retryable: false,
      })),
      fetchImpl: autoFetch,
      ctx: runtimeContext(),
    });
    expect(automatic).toMatchObject({
      error: false,
      outcome: { status: "ok", backend: "duckduckgo" },
    });
    expect(automatic.text).toContain("https://example.com/guide");
    expect(autoFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects irrelevant local results before using one exact Codex subscription search", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [{
        title: "Los Angeles traffic",
        url: "https://unrelated.example/traffic",
        content: "Tour de France and Telegram headlines",
      }],
    }), { headers: { "content-type": "application/json" } }));
    const codexSearch = vi.fn(async (query) => ({
      ok: true,
      backend: "codex",
      actualQuery: query,
      results: [{
        title: "Claude Opus 5",
        url: "https://www.anthropic.com/news/claude-opus-5",
        snippet: "Anthropic announces Claude Opus 5.",
        backend: "codex",
      }],
    }));

    const exactQuery = 'site:anthropic.com "Claude Opus 5"';
    const result = await performWebSearch({ query: exactQuery }, {
      searchConfig: {
        backend: "auto",
        endpoint: "http://127.0.0.1:8088",
        codex: { model: "gpt-5.6-luna" },
      },
      fetchImpl,
      codexSearch,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: false,
      outcome: {
        backend: "codex",
        attemptedBackends: ["searxng", "codex"],
        actualQueries: [exactQuery],
        failureMetadata: [{ backend: "searxng", code: "no_relevant_results" }],
      },
    });
    expect(codexSearch).toHaveBeenCalledOnce();
    expect(codexSearch).toHaveBeenCalledWith(exactQuery, expect.objectContaining({
      model: "gpt-5.6-luna",
    }));
    expect(result.text).toContain("actual_query=\"site:anthropic.com \\\"Claude Opus 5\\\"\"");
    expect(result.text).toContain("https://www.anthropic.com/news/claude-opus-5");
    expect(result.text).not.toContain("Los Angeles");
  });

  it("keeps strict Codex mode strict and never calls local or keyless HTTP backends", async () => {
    const fetchImpl = vi.fn();
    const codexSearch = vi.fn(async () => ({
      ok: false,
      backend: "codex",
      message: "Codex must be signed in with ChatGPT subscription access.",
      retryable: false,
    }));
    const result = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "codex", codex: { model: "gpt-5.6-luna" } },
      fetchImpl,
      codexSearch,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { backend: "codex", attemptedBackends: ["codex"] },
    });
    expect(codexSearch).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an all-engines-unresponsive SearXNG answer as a failure, not an empty result set", async () => {
    // A SearXNG whose engines are all captcha'd or suspended still answers
    // `HTTP 200 {"results": []}`. Reading only `results` turned a completely
    // dead instance into a confident "No results." on every single query.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [],
      unresponsive_engines: [["duckduckgo", "CAPTCHA"], ["brave", "too many requests"]],
    }), { headers: { "content-type": "application/json" } }));

    const result = await performWebSearch({ query: "best time to visit japan" }, {
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "rate_limited", rateLimited: true, retryable: true },
    });
    expect(result.text).not.toContain("No results.");
    // Naming each engine and its reason is the whole point: it turns "search is
    // broken" into "these engines are blocked" without reading any logs.
    expect(result.text).toContain("duckduckgo: CAPTCHA");
    expect(result.text).toContain("brave: too many requests");
  });

  it("treats a SearXNG response without a results array as a failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: "not found" }), {
      headers: { "content-type": "application/json" },
    }));

    const result = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({ error: true, outcome: { status: "error" } });
    expect(result.text).toContain("SearXNG returned no results array.");
  });

  it("keeps a genuinely empty SearXNG answer an empty answer when its engines responded", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [],
      unresponsive_engines: [],
    }), { headers: { "content-type": "application/json" } }));

    const result = await performWebSearch({ query: "zzzz no such thing zzzz" }, {
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: false,
      outcome: { status: "ok", code: "no_results", resultCount: 0 },
    });
    expect(result.text).toContain("No results.");
  });

  it("lets keyless results rescue an empty SearXNG answer in auto mode", async () => {
    // `auto` used to return the moment SearXNG answered `ok`, however empty, so
    // the keyless chain below it could never rescue the query.
    const fetchImpl = vi.fn(async (url) => (String(url).startsWith("http://127.0.0.1")
      ? new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })
      : new Response('<div class="result"><a class="result__a" href="https://example.com/guide">Mono agent guide</a></div>')));

    const result = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "auto", endpoint: "http://127.0.0.1:8088" },
      codexSearch: vi.fn(async () => ({
        ok: false, backend: "codex", message: "Codex subscription search unavailable.", retryable: false,
      })),
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: false,
      outcome: { status: "ok", backend: "duckduckgo", resultCount: 1 },
    });
    expect(result.text).toContain("https://example.com/guide");
  });

  it("treats an empty successful keyless search as a result, not a transport failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html><body>No matches</body></html>"));
    const result = await performWebSearch({ query: "no such result" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: false,
      outcome: { status: "ok", code: "no_results", resultCount: 0 },
    });
    expect(result.text).toContain("No results.");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to Startpage over a form POST when DuckDuckGo is rate-limited", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("duckduckgo")) {
        // What DuckDuckGo actually serves once it decides you are a bot: a 202,
        // which is `response.ok`, carrying an interstitial instead of results.
        return new Response("<html><body>anomaly detected</body></html>", { status: 202 });
      }
      return new Response(`
        <div class="result">
          <a class="result-link" href="https://example.com/japan">Japan Guide</a>
          <p class="result-description">Month by month.</p>
        </div>
      `);
    });

    const result = await performWebSearch({ query: "best time to visit japan" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({ error: false, outcome: { status: "ok", backend: "startpage" } });
    expect(result.text).toContain("https://example.com/japan");

    const startpageCall = calls.find((call) => call.url.includes("startpage"));
    expect(startpageCall.url).toBe("https://www.startpage.com/sp/search");
    expect(startpageCall.init.method).toBe("POST");
    expect(new URLSearchParams(startpageCall.init.body).get("query")).toBe("best time to visit japan");
    // Startpage bot-gates a POST that arrives without a browser User-Agent, so
    // the backend's Content-Type must not displace the shared headers.
    expect(startpageCall.init.headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(startpageCall.init.headers["Content-Type"]).toContain("x-www-form-urlencoded");
    // The degradation is still reported even though the query succeeded.
    expect(result.outcome.rateLimited).toBe(true);
  });

  it("maps time_range onto the Startpage with_date form field", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("duckduckgo")) return new Response("", { status: 503 });
      return new Response('<div class="result"><a class="result-link" href="https://example.com/a">Second result</a></div>');
    });

    await performWebSearch({ query: "tokyo news", time_range: "day" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    const startpageCall = calls.find((call) => call.url.includes("startpage"));
    expect(new URLSearchParams(startpageCall.init.body).get("with_date")).toBe("d");
  });

  it("reports a challenge page as an error instead of an empty result set", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "<html><body>unusual traffic from your network</body></html>",
      { status: 202 },
    ));

    const result = await performWebSearch({ query: "kyoto" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "rate_limited", rateLimited: true, retryable: true },
    });
    // The old behaviour turned a ban into a confident "No results." answer.
    expect(result.text).not.toContain("No results.");
    expect(result.text).toContain("DuckDuckGo rate-limited");
    expect(result.text).toContain("Startpage rate-limited");
  });

  it("detects a proof-of-work interstitial that carries none of the classic block wording", async () => {
    // Startpage now fronts its results with Anubis, which answers HTTP 200 and
    // says only "Verifying your request..." — no captcha, no anomaly, no
    // "are you a robot". It parsed to zero rows and passed as an empty success.
    const anubis = `<html><head>
      <script id="anubis_version" type="application/json">"v1.25.0"</script>
      <script id="anubis_challenge" type="application/json">{"rules":{"difficulty":4}}</script>
      </head><body><div class="sp-message">Verifying your request...</div></body></html>`;
    const fetchImpl = vi.fn(async () => new Response(anubis, { status: 200 }));

    const result = await performWebSearch({ query: "kyoto" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "rate_limited", rateLimited: true },
    });
    expect(result.text).not.toContain("No results.");
    expect(result.outcome.cooldownBackends).toContain("startpage");
  });

  it("puts a backend into cooldown on a 403 block, not just a 202 challenge", async () => {
    // DuckDuckGo escalates from a 202 challenge to an outright 403. Treating
    // that as an ordinary HTTP error would leave it in the rotation and get it
    // re-hit on every subsequent search.
    const fetchImpl = vi.fn(async (url) => (String(url).includes("duckduckgo")
      ? new Response("", { status: 403 })
      : new Response('<div class="result"><a class="result-link" href="https://example.com/a">A</a></div>')));

    const first = await performWebSearch({ query: "first" }, {
      searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext(),
    });
    expect(first.outcome.cooldownBackends).toContain("duckduckgo");

    const callsAfterFirst = fetchImpl.mock.calls.length;
    await performWebSearch({ query: "second" }, {
      searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext(),
    });
    const secondRoundUrls = fetchImpl.mock.calls.slice(callsAfterFirst).map(([url]) => String(url));
    expect(secondRoundUrls.some((url) => url.includes("duckduckgo"))).toBe(false);
  });

  it("stops queued query variants once a sibling has been blocked", async () => {
    // All four variants clear the cooldown check together, then queue behind the
    // concurrency bound. The first block must stop the ones still waiting.
    __resetWebSearchThrottleForTests({ minSpacingMs: 0, maxConcurrency: 1 });
    const duckCalls = [];
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("duckduckgo")) {
        duckCalls.push(String(url));
        return new Response("<html>anomaly</html>", { status: 202 });
      }
      return new Response('<div class="result"><a class="result-link" href="https://example.com/a">Second result</a></div>');
    });

    await performWebSearch({
      query: "one",
      alternate_queries: ["two", "three", "four"],
    }, { searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext() });

    // Only the variant that discovered the block should have reached the wire.
    expect(duckCalls).toHaveLength(1);
  });

  it("classifies a captcha redirect as rate limiting instead of a transport fault", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(init.redirect).toBe("manual");
      return new Response("", {
        status: 303,
        headers: { location: "https://www.startpage.com/sp/captcha-block?bc=NL" },
      });
    });

    const result = await performWebSearch({ query: "kyoto" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result.outcome).toMatchObject({ code: "rate_limited", rateLimited: true });
    expect(result.text).toContain("captcha redirect");
    // Following the hop only fetches the block page, so it must not happen.
    expect(fetchImpl.mock.calls.every(([callUrl]) => !String(callUrl).includes("captcha-block"))).toBe(true);
  });

  it("names every failed backend and preserves the underlying fetch cause", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("duckduckgo")) {
        return new Response("", { status: 503 });
      }
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("unexpected redirect"),
      });
    });

    const result = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx: runtimeContext(),
    });

    expect(result.outcome).toMatchObject({ status: "error", code: "backend_unavailable" });
    expect(result.text).toContain("DuckDuckGo HTTP 503");
    // Previously only the last failure survived, and `cause` was dropped — so
    // this read as "startpage request failed: fetch failed" and nothing else.
    expect(result.text).toContain("Startpage request failed: fetch failed (unexpected redirect)");
  });

  it("skips a rate-limited backend on later searches instead of re-hitting it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("duckduckgo")) {
        return new Response("<html>anomaly</html>", { status: 202 });
      }
      return new Response('<div class="result"><a class="result-link" href="https://example.com/a">Second result</a></div>');
    });

    await performWebSearch({ query: "first" }, {
      searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext(),
    });
    const callsAfterFirst = fetchImpl.mock.calls.length;

    const second = await performWebSearch({ query: "second" }, {
      searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext(),
    });

    const secondRoundUrls = fetchImpl.mock.calls.slice(callsAfterFirst).map(([url]) => String(url));
    expect(secondRoundUrls.some((url) => url.includes("duckduckgo"))).toBe(false);
    expect(second).toMatchObject({ error: false, outcome: { backend: "startpage" } });
    expect(second.outcome.cooldownBackends).toContain("duckduckgo");
  });

  it("bounds concurrent keyless requests across the whole process", async () => {
    __resetWebSearchThrottleForTests({ minSpacingMs: 0, maxConcurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    let admitAll;
    // Every request parks here, so the bound is observed by construction rather
    // than by racing a timer — under CPU contention a sleep-based version can
    // let requests finish before their siblings start and read as "bounded".
    const gate = new Promise((resolvePromise) => { admitAll = resolvePromise; });
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      // DuckDuckGo markup, so every query is answered by the first backend and
      // the call count reflects the fan-out alone.
      return new Response('<div class="result"><a class="result__a" href="https://example.com/a">one two three four</a></div>');
    });

    const search = Promise.all(["one", "two", "three", "four"].map((query) => performWebSearch({ query },
      { searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext() })));

    // Two run, two stay queued: proves the fan-out is concurrent AND capped.
    await vi.waitFor(() => { expect(inFlight).toBe(2); });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    admitAll();
    await search;
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
  });

  it("strips inline stylesheets out of Startpage titles", () => {
    const results = parseStartpageResults(`
      <div class="result">
        <a class="result-link" href="https://example.com/japan"><style>.css-i3irj7{line-height:18px;}</style>Best time to visit Japan</a>
        <p class="result-description">A guide.</p>
      </div>
    `);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Best time to visit Japan");
  });

  it("uses deterministic reciprocal-rank fusion and canonical URL identity", () => {
    const first = [
      { title: "A", url: "https://example.com/a?utm_source=x", snippet: "", backend: "one" },
      { title: "B", url: "https://example.com/b", snippet: "b", backend: "one" },
    ];
    const second = [
      { title: "A2", url: "https://EXAMPLE.com/a#fragment", snippet: "a", backend: "two" },
    ];
    expect(mergeRankedResults([first, second], 2).map((entry) => entry.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(canonicalizeSearchUrl(
      "https://html.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx%3Futm_medium%3Demail",
    )).toBe("https://example.com/x");
  });

  it("returns a structured abort without attempting later fallbacks", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const result = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "keyless" },
      fetchImpl,
      signal: controller.signal,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "aborted", attempts: 1, retryable: false },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("WebFetch", () => {
  it("extracts HTML as Markdown and returns useful JSON, RSS, and PDF text", async () => {
    const html = await performWebFetch({ url: "https://example.com/article" }, {
      fetchImpl: async () => new Response(
        "<html><head><title>Research</title></head><body><article><h1>Finding</h1><p>Readable evidence.</p></article></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      ctx: runtimeContext(),
    });
    expect(html.text).toContain("# Research");
    expect(html.text).toContain("## Finding");
    expect(html.text).not.toContain("<article>");

    const json = await performWebFetch({ url: "https://example.com/data.json" }, {
      fetchImpl: async () => new Response('{"answer":42}', {
        headers: { "content-type": "application/json" },
      }),
      ctx: runtimeContext(),
    });
    expect(json.text).toContain('  "answer": 42');

    const rss = await performWebFetch({ url: "https://example.com/feed", format: "text" }, {
      fetchImpl: async () => new Response(
        "<rss><channel><item><title>Update</title><link>https://example.com/u</link><description>News</description></item></channel></rss>",
        { headers: { "content-type": "application/rss+xml" } },
      ),
      ctx: runtimeContext(),
    });
    expect(rss.text).toContain("Update\nhttps://example.com/u\nNews");

    const pdf = await performWebFetch({ url: "https://example.com/file.pdf", format: "text" }, {
      fetchImpl: async () => new Response(minimalPdf("Hello PDF"), {
        headers: { "content-type": "application/pdf" },
      }),
      ctx: runtimeContext(),
    });
    expect(pdf.text).toContain("Hello PDF");
    expect(pdf.outcome.contentKind).toBe("pdf");

    const rawPdf = await performWebFetch({
      url: "https://example.com/file.pdf",
      format: "raw",
      render: "never",
    }, {
      fetchImpl: async () => new Response(minimalPdf("Raw PDF marker"), {
        headers: { "content-type": "application/pdf" },
      }),
      ctx: runtimeContext(),
    });
    expect(rawPdf.text).toContain("%PDF-");
    expect(rawPdf.text).toContain("Raw PDF marker");
  });

  it("rejects unsafe request headers and revalidates every redirect through the sandbox", async () => {
    const noFetch = vi.fn();
    const rejected = await performWebFetch({
      url: "https://example.com",
      headers: { Authorization: "Bearer secret" },
    }, { fetchImpl: noFetch, ctx: runtimeContext() });
    expect(rejected).toMatchObject({ error: true, outcome: { code: "header_rejected" } });
    expect(noFetch).not.toHaveBeenCalled();

    const checked = [];
    const sandbox = {
      mergePolicies: (_configured, request) => request,
      prepareCommand: async ({ command }) => command,
      networkAllowsUrl: (_policy, url) => {
        checked.push(url);
        return !String(url).includes("blocked.example");
      },
    };
    const fetchImpl = vi.fn(async () => new Response("", {
      status: 302,
      headers: { location: "https://blocked.example/private" },
    }));
    const redirected = await performWebFetch({ url: "https://example.com/start" }, {
      fetchImpl,
      ctx: runtimeContext(tempWorkspace(), sandbox),
    });
    expect(redirected).toMatchObject({
      error: true,
      outcome: { code: "redirect_network_denied" },
    });
    expect(checked).toEqual([
      "https://example.com/start",
      "https://blocked.example/private",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects binary responses and marks HTTP error previews as untrusted", async () => {
    const binary = await performWebFetch({ url: "https://example.com/image.png" }, {
      fetchImpl: async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]), {
        headers: { "content-type": "image/png" },
      }),
      ctx: runtimeContext(),
    });
    expect(binary).toMatchObject({
      error: true,
      outcome: { status: "error", code: "unsupported_content_type", statusCode: 200 },
    });

    const failed = await performWebFetch({ url: "https://example.com/failure" }, {
      fetchImpl: async () => new Response("untrusted failure instructions", { status: 404 }),
      retryDelaysMs: [],
      ctx: runtimeContext(),
    });
    expect(failed.text).toContain("[BEGIN UNTRUSTED WEB ERROR BODY");
    expect(failed.text).toContain("untrusted failure instructions");
    expect(failed.text).toContain("[END UNTRUSTED WEB ERROR BODY]");
    expect(failed).toMatchObject({
      error: true,
      outcome: { status: "error", code: "http_404", statusCode: 404 },
    });
  });

  it("retries transient body-stream failures without losing the eventual response", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
          },
        });
        return new Response(stream);
      }
      return new Response("recovered stream");
    });
    const result = await performWebFetch({ url: "https://example.com" }, {
      fetchImpl,
      retryDelaysMs: [0],
      ctx: runtimeContext(),
    });
    expect(result.text).toContain("recovered stream");
    expect(result.outcome.attempts).toBe(2);
  });

  it("returns a structured abort if cancellation arrives during retry backoff", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      setTimeout(() => controller.abort(), 10);
      throw Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
    });
    const result = await performWebFetch({ url: "https://example.com" }, {
      fetchImpl,
      retryDelaysMs: [1_000],
      signal: controller.signal,
      ctx: runtimeContext(),
    });

    expect(result).toMatchObject({
      error: true,
      outcome: { status: "error", code: "aborted", attempts: 1, retryable: false },
    });
  });

  it("renders only eligible successful HTML and keeps static content if auto rendering fails", async () => {
    const sparseSpa = `
      <html><body><div id="root"></div>
      <script src="/one.js"></script><script src="/two.js"></script>
      <script>window.__NEXT_DATA__={}</script></body></html>
    `;
    const renderer = vi.fn(async () => "# Rendered\n\nClient-side content");
    const rendered = await performWebFetch({ url: "https://example.com/app", render: "auto" }, {
      fetchImpl: async () => new Response(sparseSpa, { headers: { "content-type": "text/html" } }),
      fetchConfig: { render: "auto" },
      browserRenderer: renderer,
      ctx: runtimeContext(),
    });
    expect(rendered.text).toContain("Client-side content");
    expect(rendered.outcome).toMatchObject({ backend: "agent-browser", rendered: true });
    expect(renderer).toHaveBeenCalledTimes(1);

    const failedRenderer = vi.fn(async () => { throw new Error("browser unavailable"); });
    const staticFallback = await performWebFetch({ url: "https://example.com/app", render: "auto" }, {
      fetchImpl: async () => new Response(sparseSpa, { headers: { "content-type": "text/html" } }),
      fetchConfig: { render: "auto" },
      browserRenderer: failedRenderer,
      ctx: runtimeContext(),
    });
    expect(staticFallback).toMatchObject({
      error: true,
      outcome: { renderFailed: true, code: "unusable_content" },
    });

    const errorRenderer = vi.fn();
    const httpError = await performWebFetch({ url: "https://example.com/app", render: "always" }, {
      fetchImpl: async () => new Response("server failure", { status: 500 }),
      fetchConfig: { render: "auto" },
      retryDelaysMs: [],
      browserRenderer: errorRenderer,
      ctx: runtimeContext(),
    });
    expect(httpError).toMatchObject({ error: true, outcome: { code: "http_500" } });
    expect(errorRenderer).not.toHaveBeenCalled();

    const disabledRenderer = vi.fn(async () => "# should not run");
    const staticallyEnforced = await performWebFetch(
      { url: "https://example.com/app", render: "always" },
      {
        fetchImpl: async () => new Response(sparseSpa, { headers: { "content-type": "text/html" } }),
        fetchConfig: { render: "never" },
        browserRenderer: disabledRenderer,
        ctx: runtimeContext(),
      },
    );
    expect(staticallyEnforced).toMatchObject({
      error: true,
      outcome: { backend: "http", rendered: false },
    });
    expect(disabledRenderer).not.toHaveBeenCalled();
  });
});

describe("run-scoped web controller and browser isolation", () => {
  it("deduplicates concurrent requests, caches successes, and drops all state on close", async () => {
    let release;
    const gate = new Promise((resolvePromise) => { release = resolvePromise; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response("cached response");
    });
    const controller = createWebToolController({
      fetchImpl,
      ctx: runtimeContext(),
    });
    const first = controller.fetch({ url: "https://example.com", format: "text" });
    const duplicate = controller.fetch({ format: "text", url: "https://example.com" });
    release();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    const cached = await controller.fetch({ url: "https://example.com", format: "text" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(firstResult.outcome.cacheHit).toBe(false);
    expect(duplicateResult.outcome.cacheHit).toBe(true);
    expect(cached.outcome.cacheHit).toBe(true);
    await controller.close();
    await expect(controller.fetch({ url: "https://example.com" }))
      .resolves.toMatchObject({ error: true, outcome: { code: "controller_closed" } });
  });

  it("shares cached searches across controllers so sibling runs skip the network", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<div class="result"><a class="result__a" href="https://example.com/a">Shared result</a></div>',
    ));
    const options = { searchConfig: { backend: "keyless" }, fetchImpl, ctx: runtimeContext() };

    const first = createWebToolController(options);
    const firstResult = await first.search({ query: "shared" });
    const callsAfterFirst = fetchImpl.mock.calls.length;
    // A run ending must not throw away results the next turn will ask for again.
    await first.close();

    const second = createWebToolController(options);
    const secondResult = await second.search({ query: "shared" });

    expect(firstResult.outcome.cacheHit).toBe(false);
    expect(secondResult.outcome.cacheHit).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it("keys the shared search cache by backend config so controllers cannot cross-read", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith("http://127.0.0.1")) {
        return new Response(JSON.stringify({ results: [{ title: "S", url: "https://example.com/s" }] }));
      }
      return new Response('<div class="result"><a class="result__a" href="https://example.com/a">A</a></div>');
    });
    const ctx = runtimeContext();

    const keyless = createWebToolController({ searchConfig: { backend: "keyless" }, fetchImpl, ctx });
    await keyless.search({ query: "same" });
    const callsAfterKeyless = fetchImpl.mock.calls.length;

    const searxng = createWebToolController({
      searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
      fetchImpl,
      ctx,
    });
    const searxngResult = await searxng.search({ query: "same" });

    expect(searxngResult.outcome.cacheHit).toBe(false);
    expect(searxngResult.outcome.backend).toBe("searxng");
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterKeyless);
  });

  it("does not serve cached searches to a run whose context denies network", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<div class="result"><a class="result__a" href="https://example.com/a">A</a></div>',
    ));
    const searchConfig = { backend: "keyless" };
    const workspace = tempWorkspace();
    // The effective policy is the CONTEXT policy merged with the request
    // policy, so two controllers can share a request policy (here: none) and
    // still run under different network rules.
    const allowed = createWebToolController({
      searchConfig,
      fetchImpl,
      ctx: { workspace, sandbox: passthroughSandbox },
    });
    await allowed.search({ query: "policy" });

    const denied = createWebToolController({
      searchConfig,
      fetchImpl,
      ctx: {
        workspace,
        sandbox: passthroughSandbox,
        sandboxPolicy: { mode: "strict", network: { mode: "none", allowlist: [] } },
      },
    });
    const deniedResult = await denied.search({ query: "policy" });

    expect(deniedResult.outcome.cacheHit).toBe(false);
    expect(deniedResult).toMatchObject({ error: true, outcome: { code: "network_denied" } });
  });

  it("cannot cache a network-allowed result under a denied-policy key", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<div class="result"><a class="result__a" href="https://example.com/a">A</a></div>',
    ));
    const ctx = {
      workspace: tempWorkspace(),
      sandbox: passthroughSandbox,
      sandboxPolicy: { mode: "strict", network: { mode: "none", allowlist: [] } },
    };
    const controller = createWebToolController({
      searchConfig: { backend: "keyless" },
      fetchImpl,
      ctx,
    });

    const pending = controller.search({ query: "drift" });
    // updateToolContext mutates the context in place by design, and execution is
    // deferred by a microtask. Relaxing the policy inside that window must not
    // let the search run under the looser policy while the cache key still
    // describes the stricter one.
    ctx.sandboxPolicy = undefined;
    const result = await pending;

    expect(result).toMatchObject({ error: true, outcome: { code: "network_denied" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a fresh locked agent-browser session and removes its temporary config", async () => {
    const workspace = tempWorkspace();
    const preparedCommands = [];
    const cleanups = [];
    const sandbox = {
      mergePolicies: (_configured, request) => request,
      networkAllowsUrl: () => true,
      async prepareCommand({ command }) {
        preparedCommands.push(command);
        const cleanup = vi.fn(async () => {});
        cleanups.push(cleanup);
        const output = command.args.includes("read")
          ? JSON.stringify({ text: "# Rendered\n\nSafe page" })
          : "";
        return {
          command: process.execPath,
          args: ["--eval", `process.stdout.write(${JSON.stringify(output)})`],
          cwd: workspace,
          cleanup,
        };
      },
    };

    const text = await renderWithAgentBrowser("https://example.com/page", {
      namespace: "test-web",
      ctx: { workspace, sandbox },
    });
    expect(text).toContain("Safe page");
    expect(preparedCommands).toHaveLength(4);
    const sessions = new Set();
    for (const command of preparedCommands) {
      expect(command.command).toBe("agent-browser");
      expect(command.args).toContain("--content-boundaries");
      expect(command.args).toContain("--allowed-domains");
      expect(command.args).toContain("example.com,*.example.com");
      expect(command.args).toContain("--config");
      expect(command.args.slice(command.args.indexOf("--namespace"), command.args.indexOf("--namespace") + 2))
        .toEqual(["--namespace", "test-web"]);
      expect(command.env).toMatchObject({
        AGENT_BROWSER_AUTO_CONNECT: "false",
        AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
        AGENT_BROWSER_ARGS: undefined,
        AGENT_BROWSER_CDP: undefined,
        AGENT_BROWSER_EXTENSIONS: undefined,
        AGENT_BROWSER_PLUGINS: undefined,
        AGENT_BROWSER_PROFILE: undefined,
        AGENT_BROWSER_PROVIDER: undefined,
        AGENT_BROWSER_RESTORE: undefined,
        AGENT_BROWSER_RESTORE_SAVE: "never",
        AGENT_BROWSER_SESSION: undefined,
        AGENT_BROWSER_SESSION_NAME: undefined,
        AGENT_BROWSER_SOCKET_DIR: undefined,
        AGENT_BROWSER_STATE: undefined,
      });
      sessions.add(command.args[command.args.indexOf("--session") + 1]);
    }
    expect(sessions.size).toBe(1);
    expect(preparedCommands.at(-1).args.at(-1)).toBe("close");
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(readdirSync(workspace).filter((name) => name.startsWith(".mono-agent-web-"))).toEqual([]);
  });

  it("bounds browser namespace and session ids for macOS Unix socket paths", async () => {
    const workspace = tempWorkspace();
    const preparedCommands = [];
    const sandbox = {
      mergePolicies: (_configured, request) => request,
      networkAllowsUrl: () => true,
      async prepareCommand({ command }) {
        preparedCommands.push(command);
        const output = command.args.includes("read")
          ? JSON.stringify({ text: "Rendered from a bounded browser session" })
          : "";
        return {
          command: process.execPath,
          args: ["--eval", `process.stdout.write(${JSON.stringify(output)})`],
          cwd: workspace,
          cleanup: async () => {},
        };
      },
    };

    await renderWithAgentBrowser("https://example.com/page", {
      namespace: `mono-agent-web-${"a".repeat(36)}`,
      ctx: { workspace, sandbox },
    });

    const command = preparedCommands[0];
    const browserNamespace = command.args[command.args.indexOf("--namespace") + 1];
    const session = command.args[command.args.indexOf("--session") + 1];
    expect(browserNamespace).toMatch(/^mw-[a-f0-9]{10}$/u);
    expect(session).toMatch(/^s-[a-f0-9]{12}$/u);
    expect(browserNamespace.length + session.length).toBeLessThanOrEqual(27);
  });
});

function minimalPdf(text) {
  const escaped = String(text).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

describe("web research regressions", () => {
  it("tries Startpage when DuckDuckGo returns irrelevant results and forwards recency", async () => {
    const calls = [];
    const result = await performWebSearch({ query: "python documentation", time_range: "day" }, {
      searchConfig: { backend: "keyless" }, ctx: runtimeContext(),
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(String(url).includes("duckduckgo")
          ? '<div class="result"><a class="result__a" href="https://example.com/shop">Fashion shop</a></div>'
          : '<div class="result"><a class="result-link" href="https://docs.python.org/">Python documentation</a><p>Official guide</p></div>');
      },
    });
    expect(calls[0]).toContain("df=d");
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ error: false, outcome: { backend: "startpage" } });
  });
  it("passes Codex preferences separately without modifying the query", async () => {
    const codexSearch = vi.fn(async () => ({ ok: true, backend: "codex", results: [] }));
    await performWebSearch({ query: '"python docs"', language: "pl", time_range: "day" }, {
      searchConfig: { backend: "codex" }, codexSearch, ctx: runtimeContext(),
    });
    expect(codexSearch).toHaveBeenCalledWith('"python docs"', expect.objectContaining({ language: "pl", timeRange: "day" }));
  });
  it("does not send traffic or fall back when the shared coordinator fails", async () => {
    const fetchImpl = vi.fn(); const codexSearch = vi.fn();
    const result = await performWebSearch({ query: "python docs" }, {
      searchConfig: { backend: "auto", endpoint: "http://127.0.0.1:8088" }, ctx: runtimeContext(), fetchImpl, codexSearch,
      coordinator: { acquire: async () => { throw Object.assign(new Error("unavailable"), { code: "coordination_unavailable" }); } },
    });
    expect(result.outcome.code).toBe("coordination_unavailable");
    expect(fetchImpl).not.toHaveBeenCalled(); expect(codexSearch).not.toHaveBeenCalled();
  });
  it("reads later page slices from one extraction and validates cached range inputs", async () => {
    const fetchImpl = vi.fn(async () => new Response(Array.from({ length: 40 }, (_, i) => `Evidence line ${i + 1}`).join("\n"), { headers: { "content-type": "text/plain" } }));
    const controller = createWebToolController({ fetchImpl, ctx: runtimeContext() });
    try {
      const first = await controller.fetch({ url: "https://example.com/long", start_line: 1, max_lines: 10 });
      const second = await controller.fetch({ url: "https://example.com/long", start_line: first.outcome.nextLine, max_lines: 10 });
      expect(first.outcome.nextLine).toBe(11);
      expect(second.outcome).toMatchObject({ startLine: 11, endLine: 20, cacheHit: true });
      expect(second.text).toContain("Evidence line 20");
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect((await controller.fetch({ url: "https://example.com/long", start_line: -1 })).error).toBe(true);
    } finally { await controller.close(); }
  });
  it("preserves cancellation during auto rendering", async () => {
    const abort = new AbortController();
    const result = await performWebFetch({ url: "https://example.com/app" }, {
      ctx: runtimeContext(), signal: abort.signal, fetchConfig: { render: "auto" },
      fetchImpl: async () => new Response('<div id="app">Loading</div><script></script><script></script>', { headers: { "content-type": "text/html" } }),
      browserRenderer: async () => { abort.abort(); throw new Error("aborted"); },
    });
    expect(result).toMatchObject({ error: true, outcome: { code: "aborted" } });
  });
});

 it("does not skip a partially shown long line or refetch an invalid range", async () => {
   const fetchImpl = vi.fn(async () => new Response("a".repeat(1000) + "\nlast", { headers: { "content-type": "text/plain" } }));
   const controller = createWebToolController({ fetchImpl, ctx: runtimeContext() });
   const invalid = await controller.fetch({ url: "https://example.com/long", start_line: 0 });
   expect(invalid.outcome.code).toBe("invalid_range");
   expect(fetchImpl).not.toHaveBeenCalled();
   const first = await controller.fetch({ url: "https://example.com/long", start_line: 1, max_lines: 1, max_output_chars: 300 });
   expect(first.outcome.nextLine).toBe(1);
   expect(first.text).toContain("Increase max_output_chars");
   const complete = await controller.fetch({ url: "https://example.com/long", start_line: 1, max_lines: 1, max_output_chars: 2000 });
   expect(complete.outcome.nextLine).toBe(2);
   expect(fetchImpl).toHaveBeenCalledTimes(1);
   await controller.close();
 });

 it("does not spend alternate queries on a failed SearXNG transport", async () => {
   const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
   const result = await performWebSearch({ query: "Python", alternate_queries: ["Python tutorial", "Python docs"] }, {
     ctx: runtimeContext(), fetchImpl, searchConfig: { backend: "searxng", endpoint: "http://127.0.0.1:8088" },
   });
   expect(result.error).toBe(true);
   expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
