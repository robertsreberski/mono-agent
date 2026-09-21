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
});
