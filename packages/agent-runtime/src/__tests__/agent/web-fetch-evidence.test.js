import { describe, expect, it, vi } from "vitest";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { classifyWebAccessInterstitial } from "../../agent/tools/web-access-interstitial.js";
import { assertWebReadableEvidence } from "../../agent/tools/web-readable-evidence.js";

const url = "https://example.test/hotel/harbor-lodge";
const ctx = { workspace: process.cwd(), sandbox: passthroughSandbox };
const challenge = "## Show us your human side\n\nWe can't tell if you're a human or a bot.";
const emptyHtml = '<html><body><div id="app"></div><script>hydrate()</script></body></html>';
const htmlResponse = (text = emptyHtml) => new Response(text, { headers: { "content-type": "text/html" } });

function fetchOptions(extra = {}) {
  return { ctx, fetchConfig: { render: "auto" }, retryDelaysMs: [], ...extra };
}

describe("WebFetch readable evidence", () => {
  it.each([
    [challenge, undefined, "access_challenge"],
    [url, undefined, "unusable_content"],
    ["# Harbor Lodge", "Harbor Lodge", "unusable_content"],
    ["   ", undefined, "unusable_content"],
    ["...", undefined, "unusable_content"],
    ["x", undefined, "unusable_content"],
  ])("rejects explicit rendered non-evidence %s", async (text, title, code) => {
    const browserRenderer = vi.fn(async () => ({ text, title, finalUrl: url }));
    const fetchImpl = vi.fn();
    const result = await performWebFetch({ url, render: "always" }, fetchOptions({ browserRenderer, fetchImpl }));
    expect(result).toMatchObject({ error: true, outcome: { code } });
    expect(browserRenderer).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["Hotel rooms overlook the fictional harbor.", "ok"],
    [challenge, "access_challenge"],
    [url, "unusable_content"],
    ["", "unusable_content"],
    ["# Harbor Lodge", "unusable_content"],
  ])("renders after every HTML parser fails under auto: %s", async (text, code) => {
    const browserRenderer = vi.fn(async () => ({ text, finalUrl: url, title: "Harbor Lodge" }));
    const result = await performWebFetch({ url }, fetchOptions({ fetchImpl: async () => htmlResponse(), browserRenderer }));
    expect(browserRenderer).toHaveBeenCalledTimes(1);
    expect(result.outcome.code).toBe(code);
    expect(result.error).toBe(code !== "ok");
    if (code === "ok") expect(result.outcome).toMatchObject({ backend: "agent-browser", parserFailures: ["defuddle", "readability", "body"] });
  });

  it("reports unusable_content when auto rendering also fails", async () => {
    const browserRenderer = vi.fn(async () => { throw new Error("Renderer unavailable"); });
    const result = await performWebFetch({ url }, fetchOptions({ fetchImpl: async () => htmlResponse(), browserRenderer }));
    expect(browserRenderer).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ error: true, outcome: { code: "unusable_content", renderFailed: true } });
  });

  it("reports the parser failures truthfully without rendering under never", async () => {
    const browserRenderer = vi.fn();
    const result = await performWebFetch({ url, render: "never" }, fetchOptions({ fetchImpl: async () => htmlResponse(), browserRenderer }));
    expect(result).toMatchObject({ error: true, outcome: { code: "unusable_content", parserFailures: ["defuddle", "readability", "body"] } });
    expect(browserRenderer).not.toHaveBeenCalled();
  });

  it("classifies challenge headers on a tiny JSON 429 without rendering, retrying or advancing", async () => {
    const browserRenderer = vi.fn();
    const fetchImpl = vi.fn(async () => new Response('{"message":"Provisioned request rate has been exceeded"}', {
      status: 429, headers: { "content-type": "application/json", "x-page-id": "wildcard-challenge-handler" },
    }));
    const result = await performWebFetch({ url }, fetchOptions({ fetchImpl, browserRenderer, retryDelaysMs: [0, 0], fetchConfig: { render: "auto", provider: ["local", "parallel"] } }));
    expect(result).toMatchObject({ error: true, outcome: { code: "access_challenge", statusCode: 429, attemptedProviders: ["local"] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(browserRenderer).not.toHaveBeenCalled();
  });

  it.each([
    ["<html><body><p>OK</p></body></html>", "text/html"],
    ["<html><head><title>Status</title></head><body><p>Rooms available.</p></body></html>", "text/html"],
    ["x", "text/plain"],
    ["x", "text/markdown"],
    ["{}", "application/json"],
    ["<status>1</status>", "application/xml"],
    ["<html><body><article>" + "This article discusses captcha, bot protection, and human access. ".repeat(60) + "Verify you are human is a common challenge prompt.</article></body></html>", "text/html"],
  ])("preserves genuine short or explanatory documents (%s)", async (body, contentType) => {
    const result = await performWebFetch({ url, render: "never" }, fetchOptions({ fetchImpl: async () => new Response(body, { headers: { "content-type": contentType } }) }));
    expect(result).toMatchObject({ error: false, outcome: { status: "ok" } });
  });

  it.each([
    [`<html><body><p>${url}</p></body></html>`, "markdown"],
    ['<html><head><title>Harbor Lodge</title></head><body><h1>Harbor Lodge</h1></body></html>', "text"],
    ['<html><body><script>hydrate()</script></body></html>', "raw"],
  ])("rejects static HTML non-evidence (%s)", async (body, format) => {
    const result = await performWebFetch({ url, render: "never", format }, fetchOptions({ fetchImpl: async () => htmlResponse(body) }));
    expect(result).toMatchObject({ error: true, outcome: { code: "unusable_content" } });
  });

  it.each(["html", "rendered", "remote-markdown"])("shares normalized URL/title rejection for %s", (kind) => {
    expect(() => assertWebReadableEvidence({ kind, text: `[${url}/](${url}/)`, url })).toThrow(/readable document evidence/);
    expect(() => assertWebReadableEvidence({ kind, text: "# HARBOR   Lodge", title: "Harbor Lodge" })).toThrow(/readable document evidence/);
  });

  it.each(["text", "markdown", "json", "xml", "pdf"])("does not impose HTML evidence thresholds on %s", (kind) => {
    expect(() => assertWebReadableEvidence({ kind, text: "x", title: "x" })).not.toThrow();
  });
});

describe("general structural access signals", () => {
  it.each([202, 403, 429, 503])("combines tiny content and vocabulary at status %s", (statusCode) => {
    expect(classifyWebAccessInterstitial({ statusCode, text: "Human verification" })?.code).toBe("access_challenge");
    expect(classifyWebAccessInterstitial({ statusCode, text: "Unavailable" })).toBeUndefined();
  });
  it("recognizes mitigation headers without requiring phrases", () => {
    expect(classifyWebAccessInterstitial({ text: "", headers: new Headers({ "cf-mitigated": "challenge" }) })?.code).toBe("access_challenge");
  });
  it.each(["Prove you're human", "Are you a robot?", "Captcha robot check"])("recognizes generic short challenge %s", (text) => {
    expect(classifyWebAccessInterstitial({ text })?.code).toBe("access_challenge");
  });
  it("does not classify incidental short words or long explanatory phrases", () => {
    expect(classifyWebAccessInterstitial({ text: "Human resources guide" })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "A captcha tutorial" })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "This article discusses captcha, bot traffic and human visitors." })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "This article describes captcha and bot detection for human visitors. ".repeat(60) + challenge })).toBeUndefined();
  });
});
