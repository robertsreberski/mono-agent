import { describe, expect, it } from "vitest";
import { loadMonoAgentConfig } from "../config.js";
import { layerJsonOntoEnv } from "../layered-loader.js";
import type { MonoAgentConfigJson } from "../json-source.js";
const env = { MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5", MONO_AGENT_IDENTITY_PATH: "IDENTITY.md" };
function load(web: NonNullable<NonNullable<MonoAgentConfigJson["tools"]>["web"]>, extra = {}) {
  return loadMonoAgentConfig({ cwd: "/repo", env: layerJsonOntoEnv({ tools: { web } }, { ...env, ...extra }) }).tools.web;
}
describe("explicit web provider selection", () => {
  it("defaults to Parallel then local Ollama, with local fetch", () => {
    expect(load({})).toMatchObject({ search: { backend: ["parallel", "ollama"], ollama: { baseUrl: "http://127.0.0.1:11434" } }, fetch: { provider: "local" } });
  });
  it.each(["parallel", "ollama", "codex", "keyless", "duckduckgo", "startpage"])("accepts strict %s", (backend) => {
    expect(load({ search: { backend } })?.search.backend).toBe(backend);
  });
  it("retains array order, including single-element arrays, and accepts comma-separated env overrides", () => {
    expect(load({ search: { backend: ["ollama", "parallel"] } })?.search.backend).toEqual(["ollama", "parallel"]);
    expect(load({ search: { backend: ["parallel"] } })?.search.backend).toEqual(["parallel"]);
    expect(load({}, { MONO_AGENT_WEB_SEARCH_BACKEND: "parallel,ollama" })?.search.backend).toEqual(["parallel", "ollama"]);
  });
  it.each([[], ["parallel", "parallel"], ["missing"], "missing"].map((value) => [value]))("rejects invalid search selection %j", (backend) => {
    expect(() => load({ search: { backend } })).toThrow();
  });
  it("requires only SearXNG configuration, not an Ollama block", () => {
    expect(() => load({ search: { backend: ["parallel", "searxng"] } })).toThrow(/ENDPOINT/);
    expect(load({ search: { backend: ["parallel", "ollama"] } })?.search.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
  });
  it.each([
    [{}, '["codex","keyless"]'],
    [{ searxng: { endpoint: "http://127.0.0.1:8088" } }, '["searxng","codex","keyless"]'],
    [{ ollama: {}, searxng: { endpoint: "http://127.0.0.1:8088" } }, '["ollama","searxng","codex","keyless"]'],
  ])("spells the previous auto order for %j", (blocks, chain) => {
    expect(() => load({ search: { ...blocks, backend: "auto" } })).toThrow(`tools.web.search.backend "auto" was removed; use ${chain} (the previous auto order for this configuration)`);
  });
  it("rejects auto in env too", () => {
    expect(() => load({}, { MONO_AGENT_WEB_SEARCH_BACKEND: "auto" })).toThrow(/"auto" was removed/);
  });
  it("loads fetch provider chains and rejects empty, duplicate, or unknown providers", () => {
    expect(load({ fetch: { provider: ["local", "parallel"] } })?.fetch.provider).toEqual(["local", "parallel"]);
    expect(load({}, { MONO_AGENT_WEB_FETCH_PROVIDER: "local,parallel" })?.fetch.provider).toEqual(["local", "parallel"]);
    for (const provider of [[], ["local", "local"], "missing"]) expect(() => load({ fetch: { provider } })).toThrow();
  });
  it("rejects parallel-only browser rendering", () => {
    for (const provider of ["parallel", ["parallel"]]) expect(() => load({ fetch: { provider, render: "auto" } })).toThrow(/requires the local/);
    expect(load({ fetch: { provider: ["local", "parallel"], render: "auto" } })?.fetch.render).toBe("auto");
  });
  it("retains only a credential name, requiring a valid present variable", () => {
    expect(() => load({ search: { parallel: { apiKeyEnv: "MISSING_PARALLEL_KEY" } } })).toThrow(/missing or empty/);
    for (const apiKeyEnv of ["not a name", "", " "]) expect(() => load({ fetch: { parallel: { apiKeyEnv } } })).toThrow(/name an environment/);
    const config = load({ search: { parallel: { apiKeyEnv: "TEST_PARALLEL_KEY" } }, fetch: { parallel: { apiKeyEnv: "TEST_PARALLEL_KEY" } } }, { TEST_PARALLEL_KEY: "sentinel-secret" });
    expect(config?.search.parallel).toEqual({ apiKeyEnv: "TEST_PARALLEL_KEY" });
    expect(JSON.stringify(config)).not.toContain("sentinel-secret");
  });
  it("accepts hound with explicit loopback endpoints, required when selected", () => {
    const web = load({
      search: { backend: "hound", hound: { endpoint: "http://127.0.0.1:8765/mcp/" } },
      fetch: { provider: ["local", "hound"], hound: { endpoint: "http://localhost:8765/mcp" } },
    });
    expect(web?.search.hound).toEqual({ endpoint: "http://127.0.0.1:8765/mcp" });
    expect(web?.fetch.hound).toEqual({ endpoint: "http://localhost:8765/mcp" });
    expect(() => load({ search: { backend: "hound" } })).toThrow(/MONO_AGENT_WEB_SEARCH_HOUND_ENDPOINT/);
    expect(() => load({ fetch: { provider: "hound" } })).toThrow(/MONO_AGENT_WEB_FETCH_HOUND_ENDPOINT/);
  });
  it("rejects non-loopback, credentialed, or pathless hound endpoints", () => {
    for (const endpoint of [
      "https://example.com/mcp",
      "http://example.com:8765/mcp",
      "http://user@127.0.0.1:8765/mcp",
      "http://127.0.0.1:8765/mcp?token=abc",
      "http://127.0.0.1:8765/mcp#fragment",
      "http://127.0.0.1:8765/",
      "http://127.0.0.1:8765",
      "not-a-url",
    ]) {
      expect(() => load({ search: { backend: "hound", hound: { endpoint } } })).toThrow(/HOUND_ENDPOINT/);
      expect(() => load({ fetch: { provider: "hound", hound: { endpoint } } })).toThrow(/HOUND_ENDPOINT/);
    }
  });
  it("loads hound endpoints from env without changing defaults", () => {
    const web = load({}, {
      MONO_AGENT_WEB_SEARCH_BACKEND: "parallel,hound",
      MONO_AGENT_WEB_SEARCH_HOUND_ENDPOINT: "http://127.0.0.1:8765/mcp",
      MONO_AGENT_WEB_FETCH_PROVIDER: "local,hound",
      MONO_AGENT_WEB_FETCH_HOUND_ENDPOINT: "http://127.0.0.1:8765/mcp",
    });
    expect(web?.search.backend).toEqual(["parallel", "hound"]);
    expect(web?.search.hound).toEqual({ endpoint: "http://127.0.0.1:8765/mcp" });
    expect(web?.fetch.provider).toEqual(["local", "hound"]);
    expect(web?.fetch.hound).toEqual({ endpoint: "http://127.0.0.1:8765/mcp" });
  });
});
