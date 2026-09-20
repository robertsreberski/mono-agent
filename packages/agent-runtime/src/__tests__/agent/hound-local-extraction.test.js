import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { extractHoundHtml, htmlToMarkdown } from "../../agent/tools/hound-local/extract.js";
import { extractHtmlLinks } from "../../agent/tools/hound-local/links.js";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";

const url = "https://example.com/docs/intro";
const article = "Native document extraction must retain useful article prose and citations rather than just a tiny navigation label. ".repeat(6);

describe("native Hound-derived extraction", () => {
  it("rejects a tiny primary candidate when a real article is available", async () => {
    const output = await extractHoundHtml(`<html><head><title>Article title</title></head><body><main>${article}</main></body></html>`, url, {
      primary: async () => ({ contentMarkdown: "Menu", title: "Bad candidate" }), article: () => null,
    });
    expect(output).toMatchObject({ title: "Article title", stage: "main", failures: ["defuddle", "readability"] });
    expect(output.markdown).toContain(article.trim());
    expect(output.markdown).not.toContain("Menu");
  });

  it("preserves truly short pages and standalone HTML fragments", async () => {
    expect(await extractHoundHtml("<p>Hi.</p>", url, { primary: async () => ({ contentMarkdown: "Hi." }) }))
      .toMatchObject({ markdown: "Hi.", stage: "defuddle" });
    expect(htmlToMarkdown('<p>See <a href="../ref">reference</a>.</p>', url)).toBe("See [reference](https://example.com/ref).");
  });

  it("retains code and links inside fallback Markdown tables", async () => {
    const output = await extractHoundHtml('<main><table><tr><th>Name</th><th>Value</th></tr><tr><td><a href="/ref">Reference</a></td><td><code>a|b</code></td></tr></table><pre><code>const answer = 42;\n</code></pre></main>', url, {
      primary: async () => { throw new Error("primary failed"); }, article: () => null,
    });
    expect(output.markdown).toContain("| Name | Value |\n| --- | --- |");
    expect(output.markdown).toContain("[Reference](https://example.com/ref)");
    expect(output.markdown).toContain("`a\\|b`");
    expect(output.markdown).toContain("```\nconst answer = 42;\n```");
  });

  it("does not return noise or raw HTML as successful extraction", async () => {
    await expect(extractHoundHtml('<html><body><script>secret()</script><nav>Menu</nav><svg>icon</svg></body></html>', url, {
      primary: async () => { throw new Error("failed"); }, article: () => null,
    })).rejects.toMatchObject({ code: "extraction_failed" });
  });

  it("prioritizes content citations after more than twenty navigation anchors", () => {
    const nav = Array.from({ length: 30 }, (_, i) => `<a href="/nav/${i}">Navigation ${i}</a>`).join("");
    const links = extractHtmlLinks(`<nav>${nav}<a href="/evidence#menu">menu copy</a></nav><main><p><a href="/evidence#section">Evidence</a></p><a href="https://elsewhere.example/paper">Paper</a><a href="#local">local</a><a href="javascript:bad()">bad</a><a href="https://user:pass@example.com/">bad</a></main>`, url);
    expect(links).toHaveLength(20);
    expect(links[0]).toEqual({ url: "https://example.com/evidence", text: "Evidence", provenance: "main-content" });
    expect(links[1]).toMatchObject({ url: "https://elsewhere.example/paper", provenance: "main-content" });
    expect(links.filter((link) => link.url.includes("/evidence"))).toHaveLength(1);
    expect(links.every((link) => !link.url.includes("#") && !link.url.includes("pass"))).toBe(true);
  });

  it("benefits existing default-local callers without adding a robots prerequisite", async () => {
    const calls = [];
    const result = await performWebFetch({ url, include_links: true }, {
      ctx: { workspace: process.cwd(), sandbox: passthroughSandbox },
      fetchImpl: async (target) => {
        calls.push(String(target));
        return new Response(`<html><head><title>Native extraction</title></head><body><nav>${Array.from({ length: 25 }, (_, i) => `<a href="/nav/${i}">Menu</a>`).join("")}</nav><main><p>${article}</p><a href="/evidence">Evidence</a></main></body></html>`, { headers: { "content-type": "text/html" } });
      },
    });
    expect(result.error).toBe(false);
    expect(result.text).toContain("Native extraction");
    expect(JSON.parse(result.text).links[0]).toMatchObject({ url: "https://example.com/evidence", provenance: "main-content" });
    expect(calls).toEqual([url]);
  });
  it("extracts a real native HTTP redirect response, not a provider envelope fixture", async () => {
    const paths = [];
    const server = createServer((request, response) => {
      paths.push(request.url);
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/article" }); response.end(); return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><head><title>Native HTTP article</title></head><body><main><p>${article}</p><a href="/citation">Citation</a></main></body></html>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await performWebFetch({ url: `${origin}/redirect`, include_links: true }, {
        ctx: { workspace: process.cwd(), sandbox: passthroughSandbox },
      });
      expect(result).toMatchObject({ error: false, outcome: { redirectCount: 1 } });
      const envelope = JSON.parse(result.text);
      expect(envelope.content).toContain("Native HTTP article");
      expect(envelope.links[0]).toEqual({ url: `${origin}/citation`, text: "Citation", provenance: "main-content" });
      expect(paths).toEqual(["/redirect", "/article"]);
    } finally {
      const closed = once(server, "close");
      server.close(); server.closeAllConnections();
      await closed;
    }
  });

});
