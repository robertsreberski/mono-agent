import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { renderWithAgentBrowser } from "../../agent/tools/web-browser-render.js";
import { createWebToolController } from "../../agent/tools/web-controller.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import {
  canonicalizeSearchUrl,
  mergeRankedResults,
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

afterEach(() => {
  vi.restoreAllMocks();
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

  it("queries strict loopback SearXNG, fuses alternates, filters domains, and canonicalizes URLs", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        results: [
          {
            title: "Primary",
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
      attempts: 2,
      resultCount: 1,
    });
    expect(result.text).toContain("https://example.com/article");
    expect(result.text).not.toContain("utm_source");
    expect(result.text).not.toContain("docs.example.com");
    expect(calls).toHaveLength(2);
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
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fguide%3Futm_campaign%3Dx">Guide</a>
          <div class="result__snippet">A useful guide.</div>
        </div>
      `);
    });
    const automatic = await performWebSearch({ query: "mono agent" }, {
      searchConfig: { backend: "auto", endpoint: "http://127.0.0.1:8088" },
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
      error: false,
      outcome: { backend: "http", renderFailed: true, code: "ok_static_render_failed" },
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
      error: false,
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
        AGENT_BROWSER_STATE: undefined,
      });
      sessions.add(command.args[command.args.indexOf("--session") + 1]);
    }
    expect(sessions.size).toBe(1);
    expect(preparedCommands.at(-1).args.at(-1)).toBe("close");
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(readdirSync(workspace).filter((name) => name.startsWith(".mono-agent-web-"))).toEqual([]);
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
