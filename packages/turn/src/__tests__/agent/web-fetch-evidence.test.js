import { describe, expect, it, vi } from "vitest";
import { performWebFetch } from "../../agent/tools/web-fetch.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { classifyWebAccessInterstitial } from "../../agent/tools/web-access-interstitial.js";
import { assertWebReadableEvidence } from "../../agent/tools/web-readable-evidence.js";

const url = "https://example.test/hotel/harbor-lodge";
const ctx = { workspace: process.cwd(), sandbox: passthroughSandbox };
const challenge = "## Show us your human side\n\nWe can't tell if you're a human or a bot.";
const bigScript = `<script>${"var x=1;".repeat(400)}</script>`;
const shortCaptchaGlossary = "CAPTCHA is a security check used to tell a human from a bot. Sites verify users by showing distorted text. It was coined in 2003 and remains common on login forms and comment sections across the web.";
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
    ["&nbsp;&nbsp;", undefined, "unusable_content"],
    [`Harbor Lodge ${url}`, "Harbor Lodge", "unusable_content"],
    ["Prove that you are human", undefined, "access_challenge"],
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
    ["<html><body><article>" + "This article discusses captcha, bot protection, and human access. ".repeat(60) + "These defenses can affect visitors.</article></body></html>", "text/html"],
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

  it.each(["html", "rendered", "remote-markdown"])("decodes entities before judging %s evidence", (kind) => {
    for (const text of ["&nbsp;&nbsp;", "&amp;&lt;&gt;&quot;&#39;", "&#160;&#xA0;&#x26;&#38;"]) {
      expect(() => assertWebReadableEvidence({ kind, text, url })).toThrow(/readable document evidence/);
    }
    // Encoded substantive text is still real evidence, not a markup artifact.
    expect(() => assertWebReadableEvidence({ kind, text: "&#79;&#x4B;", url })).not.toThrow();
  });

  it.each(["html", "rendered", "remote-markdown"])("requires body evidence beyond combined title/URL echoes for %s", (kind) => {
    const title = "Harbor Lodge";
    for (const text of [`${title} ${url}`, `${url}\n# ${title}`, `(${title}) : ${url} ...`, `${url}&nbsp;&amp;${title}`]) {
      expect(() => assertWebReadableEvidence({ kind, text, url, title })).toThrow(/readable document evidence/);
    }
    expect(() => assertWebReadableEvidence({ kind, text: `${title} ${url} - OK`, url, title })).not.toThrow();
    expect(() => assertWebReadableEvidence({ kind, text: `${title}: Rooms overlook the harbor.`, url, title })).not.toThrow();
    expect(() => assertWebReadableEvidence({ kind, text: "Hotels", url, title: "Hotel" })).not.toThrow();
    expect(() => assertWebReadableEvidence({ kind, text: "OK", url })).not.toThrow();
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
  it.each(["Prove you're human", "Prove that you are human", "Are you a robot?"])("recognizes generic short challenge %s", (text) => {
    expect(classifyWebAccessInterstitial({ text })?.code).toBe("access_challenge");
  });
  it("does not classify incidental short words or long explanatory phrases", () => {
    expect(classifyWebAccessInterstitial({ text: "Human resources guide" })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "A captcha tutorial" })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "This article discusses captcha, bot traffic and human visitors." })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "This article describes captcha and bot detection for human visitors. ".repeat(60) + challenge })).toBeUndefined();
  });
});

describe("access classifier review regressions", () => {
  it.each(["never", "auto", "always"].flatMap((render) => [
    [render, "human verification", "Please verify you are human"],
    [render, "unusual traffic", "Our systems have detected unusual traffic from your computer network."],
  ]))("keeps big-script challenges terminal through %s: %s", async (render, _label, text) => {
    const body = `<html><body>${bigScript}<p>${text}</p></body></html>`;
    expect(classifyWebAccessInterstitial({ url, text: body, statusCode: 200 })?.code).toBe("access_challenge");
    const browserRenderer = vi.fn(async () => ({ text: body, finalUrl: url }));
    const fetchImpl = vi.fn(async () => htmlResponse(body));
    const result = await performWebFetch({ url, render }, fetchOptions({ fetchImpl, browserRenderer,
      fetchConfig: { render: "auto", provider: ["local", "parallel"] } }));
    expect(result).toMatchObject({ error: true, outcome: { code: "access_challenge", attemptedProviders: ["local"] } });
    if (render === "always") {
      expect(browserRenderer).toHaveBeenCalledTimes(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    } else {
      expect(browserRenderer).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    "Verify you are human",
    "Checking your browser before accessing",
    "Unusual traffic from your computer network",
    "Access denied. Reference: blocked by administrator",
    "Performing security verification. Enable JavaScript and cookies to continue",
    "Just a moment. Performing security verification",
    "Just a moment. Enable JavaScript and cookies to continue",
  ])("preserves original conclusive signal on long visible pages: %s", (text) => {
    expect(classifyWebAccessInterstitial({ url, text: `${"Waiting. ".repeat(300)}${text}`, statusCode: 200 })?.code).toBe("access_challenge");
  });

  it.each(["never", "always", "auto"])("accepts short CAPTCHA glossary through %s extraction", async (render) => {
    expect(classifyWebAccessInterstitial({ url, text: shortCaptchaGlossary, statusCode: 200 })).toBeUndefined();
    const browserRenderer = vi.fn(async () => ({ text: shortCaptchaGlossary, finalUrl: url }));
    const fetchImpl = vi.fn(async () => htmlResponse(render === "auto" ? emptyHtml : `<html><body><article>${shortCaptchaGlossary}</article></body></html>`));
    const result = await performWebFetch({ url, render }, fetchOptions({ fetchImpl, browserRenderer }));
    expect(result).toMatchObject({ error: false, outcome: { status: "ok", backend: render === "never" ? "http" : "agent-browser" } });
    expect(JSON.parse(result.text).content).toContain("CAPTCHA is a security check");
  });

  it("requires structural corroboration for vocabulary-only content", () => {
    expect(classifyWebAccessInterstitial({ text: "Captcha robot check", statusCode: 200 })).toBeUndefined();
    expect(classifyWebAccessInterstitial({ text: "Captcha robot check", statusCode: 202 })?.code).toBe("access_challenge");
  });

  it.each(["script", "style", "noscript", "template"])("ignores large %s contents for broader human-check length", (tag) => {
    const text = `<html><body><${tag}>${"var x=1;".repeat(5000)}</${tag}><p>${challenge}</p></body></html>`;
    expect(classifyWebAccessInterstitial({ text, statusCode: 200 })?.code).toBe("access_challenge");
  });

  it("does not count vocabulary hidden in scripts", () => {
    expect(classifyWebAccessInterstitial({ text: "<script>captcha human verification</script><p>Accepted</p>", statusCode: 202 })).toBeUndefined();
  });
});
