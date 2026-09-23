import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { ollamaProvider } from "../../agent/tools/web-search-providers/ollama.js";
import {
  __resetWebSearchThrottleForTests,
  performWebSearch,
} from "../../agent/tools/web-search.js";
import { createWebSearchRunState } from "../../agent/tools/web-search-state.js";
import { __resetSharedSearchCacheForTests } from "../../agent/tools/web-controller.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { mkdtempSync } from "node:fs";
import { resolve } from "node:path";

const ENV_NAME = "MONO_AGENT_TEST_OLLAMA_WEB_KEY";

function runtimeContext(workspace, sandbox = passthroughSandbox) {
  return { workspace, sandbox };
}

beforeEach(() => {
  __resetWebSearchThrottleForTests({ minSpacingMs: 0 });
  __resetSharedSearchCacheForTests();
});

afterEach(() => {
  delete process.env[ENV_NAME];
});

describe("hosted Ollama apiKeyEnv resolution", () => {
  it("configures from apiKeyEnv alone", () => {
    const configured = ollamaProvider.configure(
      { ollama: { baseUrl: "https://ollama.com", apiKeyEnv: ENV_NAME } },
      "ollama",
    );
    // Without the fix this is { error: "Hosted Ollama Web Search requires a
    // resolved API key.", code: "auth_missing" } because the loader only
    // carries the variable name.
    expect(configured).not.toHaveProperty("error");
    expect(configured.value.ollama).toMatchObject({
      baseUrl: "https://ollama.com",
      apiKeyEnv: ENV_NAME,
    });
  });

  it("sends the resolved bearer token at use", async () => {
    process.env[ENV_NAME] = "env-resolved-key";
    const seen = {};
    const fetchImpl = vi.fn(async (url, init) => {
      seen.authorization = init?.headers?.Authorization;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const dir = mkdtempSync(resolve("/tmp", "agent-runtime-ollama-"));
    const result = await performWebSearch({ query: "hello" }, {
      searchConfig: {
        backend: "ollama",
        ollama: { baseUrl: "https://ollama.com", apiKeyEnv: ENV_NAME },
      },
      searchState: createWebSearchRunState({}),
      fetchImpl,
      ctx: runtimeContext(dir),
    });
    expect(result).toMatchObject({ error: false });
    expect(seen.authorization).toBe("Bearer env-resolved-key");
  });

  it("prefers the declared name over a stale inline literal", async () => {    // Declared-name-authoritative: an unset name yields nothing even when an
    // inline literal is present, so a stale literal can never authenticate as
    // a newly selected credential the way the base loader's semantics required.
    delete process.env[ENV_NAME];
    const dir = mkdtempSync(resolve("/tmp", "agent-runtime-ollama-"));
    const result = await performWebSearch({ query: "hello" }, {
      searchConfig: {
        backend: "ollama",
        ollama: { baseUrl: "https://ollama.com", apiKeyEnv: ENV_NAME, apiKey: "stale-literal" },
      },
      searchState: createWebSearchRunState({}),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ results: [] }))),
      ctx: runtimeContext(dir),
    });
    expect(result).toMatchObject({ error: true });
    expect(JSON.stringify(result)).toContain("auth_missing");
  });

  it("returns auth_missing at use when the named variable is unset", async () => {
    delete process.env[ENV_NAME];
    const dir = mkdtempSync(resolve("/tmp", "agent-runtime-ollama-"));
    const result = await performWebSearch({ query: "hello" }, {
      searchConfig: {
        backend: "ollama",
        ollama: { baseUrl: "https://ollama.com", apiKeyEnv: ENV_NAME },
      },
      searchState: createWebSearchRunState({}),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ results: [] }))),
      ctx: runtimeContext(dir),
    });
    expect(result).toMatchObject({ error: true });
    expect(JSON.stringify(result)).toContain("auth_missing");
  });

  it("keys the shared search cache by credential digest, never the value", async () => {
    // A rotation must change the identity (otherwise operators sharing a
    // process read each other's cached results); the value itself must never
    // appear in it.
    const { __ollamaCacheIdentityForTests } = await import("../../agent/tools/web-controller.js");
    const config = { baseUrl: "https://ollama.com", apiKeyEnv: ENV_NAME };
    process.env[ENV_NAME] = "key-one";
    const first = __ollamaCacheIdentityForTests(config);
    expect(JSON.stringify(first)).not.toContain("key-one");
    expect(first).toMatchObject({ apiKeyEnv: ENV_NAME });
    expect(typeof first.credentialDigest).toBe("string");
    await searchOnce();
    process.env[ENV_NAME] = "key-two";
    const second = __ollamaCacheIdentityForTests(config);
    expect(second.credentialDigest).not.toBe(first.credentialDigest);
    expect(JSON.stringify(second)).not.toContain("key-two");

    async function searchOnce() {
      const dir = mkdtempSync(resolve("/tmp", "agent-runtime-ollama-"));
      return performWebSearch({ query: "rotation probe" }, {
        searchConfig: { backend: "ollama", ollama: { ...config } },
        searchState: createWebSearchRunState({}),
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })),
        ctx: runtimeContext(dir),
      });
    }
  });
});
