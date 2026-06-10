import { describe, expect, it } from "vitest";

import {
  acceptedSdkIdsForBackend,
  applyTemporaryEnv,
  assertBaseRunOptions,
  buildRuntimeResult,
  isPlainObject,
  isValidMcpServerName,
  listMonoRuntimeBackends,
  listMonoRuntimeSelectionTable,
  parseMcpServers,
  readLastStringUserMessage,
  selectMonoRuntimeBackendId,
  withTemporaryEnv,
} from "../index.js";
import type { RuntimeRunOptions } from "../index.js";

class TestRuntimeError extends Error {
  readonly code: string;
  constructor(code: "invalid_options", message: string) {
    super(message);
    this.name = "TestRuntimeError";
    this.code = code;
  }
}

const makeError = (code: "invalid_options", message: string): Error => new TestRuntimeError(code, message);

function runOptions(overrides: Partial<RuntimeRunOptions> = {}): RuntimeRunOptions {
  return {
    model: { sdk: "claude", model: "claude-opus-4-7" },
    messages: [{ role: "user", content: "hi" }],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("isPlainObject", () => {
  it("accepts records and rejects arrays/null/primitives", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});

describe("assertBaseRunOptions", () => {
  it("passes for a valid prompt + model + abort signal", () => {
    expect(() => assertBaseRunOptions("system", runOptions(), makeError, "Test runtime")).not.toThrow();
  });

  it("throws the runtime's own error for empty prompt", () => {
    expect(() => assertBaseRunOptions("  ", runOptions(), makeError, "Test runtime")).toThrow(TestRuntimeError);
  });

  it("throws for missing model.model and missing abort signal", () => {
    expect(() =>
      assertBaseRunOptions("system", runOptions({ model: { sdk: "claude", model: "" } }), makeError, "Test runtime"),
    ).toThrow(TestRuntimeError);
    expect(() =>
      assertBaseRunOptions("system", { ...runOptions(), abortSignal: undefined as unknown as AbortSignal }, makeError, "Test runtime"),
    ).toThrow(TestRuntimeError);
  });
});

describe("readLastStringUserMessage", () => {
  it("returns the last string message content", () => {
    expect(readLastStringUserMessage(runOptions({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }), makeError, "Test runtime")).toBe("b");
  });

  it("throws on empty messages and non-string content", () => {
    expect(() => readLastStringUserMessage(runOptions({ messages: [] }), makeError, "Test runtime")).toThrow(TestRuntimeError);
    expect(() => readLastStringUserMessage(runOptions({ messages: [{ role: "user", content: { blocks: [] } }] }), makeError, "Test runtime")).toThrow(TestRuntimeError);
  });
});

describe("buildRuntimeResult", () => {
  it("spreads only present optional fields and echoes sdk from the model", () => {
    const result = buildRuntimeResult({
      events: [],
      model: { sdk: "claude", model: "claude-opus-4-7" },
      numTurns: 1,
      durationMs: 10,
      text: "hi",
      stopReason: "end_turn",
      cancelled: false,
    });
    expect(result).toEqual({
      text: "hi",
      events: [],
      sdk: "claude",
      model: "claude-opus-4-7",
      numTurns: 1,
      durationMs: 10,
      stopReason: "end_turn",
    });
    expect(result).not.toHaveProperty("usage");
    expect(result).not.toHaveProperty("cancelled");
    expect(result).not.toHaveProperty("failureKind");
  });

  it("omits null stopReason and includes cancelled only when true", () => {
    const result = buildRuntimeResult({
      events: [],
      model: { sdk: "codex", model: "gpt-5.5" },
      numTurns: 0,
      durationMs: 5,
      stopReason: null,
      cancelled: true,
      failureKind: "cancelled",
    });
    expect(result).not.toHaveProperty("stopReason");
    expect(result.cancelled).toBe(true);
    expect(result.failureKind).toBe("cancelled");
  });
});

describe("isValidMcpServerName", () => {
  it("accepts alnum/_/- and rejects spaces and empty", () => {
    expect(isValidMcpServerName("github_one-2")).toBe(true);
    expect(isValidMcpServerName("bad name")).toBe(false);
    expect(isValidMcpServerName("")).toBe(false);
  });
});

describe("env helpers", () => {
  it("withTemporaryEnv applies during fn and restores after", async () => {
    const key = "RUNTIME_ADAPTER_TEST_ENV";
    delete process.env[key];
    let seen: string | undefined;
    await withTemporaryEnv({ [key]: "during" }, async () => {
      seen = process.env[key];
    });
    expect(seen).toBe("during");
    expect(process.env[key]).toBeUndefined();
  });

  it("applyTemporaryEnv restores a previously-set value", () => {
    const key = "RUNTIME_ADAPTER_TEST_ENV2";
    process.env[key] = "before";
    const restore = applyTemporaryEnv({ [key]: "during" });
    expect(process.env[key]).toBe("during");
    restore();
    expect(process.env[key]).toBe("before");
    delete process.env[key];
  });

  it("withTemporaryEnv restores even when fn throws", async () => {
    const key = "RUNTIME_ADAPTER_TEST_ENV3";
    delete process.env[key];
    await expect(
      withTemporaryEnv({ [key]: "during" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.env[key]).toBeUndefined();
  });
});

describe("parseMcpServers", () => {
  it("classifies http (default for url), explicit sse, and stdio entries", () => {
    const parsed = parseMcpServers({
      github: { type: "http", url: "http://example.com", headers: { Authorization: "Bearer x" } },
      docs: { url: "http://docs.example.com" },
      events: { type: "sse", url: "http://sse.example.com" },
      local: { command: "node", args: ["server.js", 7], env: { A: "1", B: 2 }, cwd: "/work" },
    });
    expect(parsed).toEqual([
      { name: "github", transport: "http", url: "http://example.com", headers: { Authorization: "Bearer x" } },
      { name: "docs", transport: "http", url: "http://docs.example.com" },
      { name: "events", transport: "sse", url: "http://sse.example.com" },
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], env: { A: "1" }, cwd: "/work" },
    ]);
  });

  it("drops invalid names and malformed shapes, and returns [] for undefined", () => {
    expect(parseMcpServers(undefined)).toEqual([]);
    expect(
      parseMcpServers({
        "bad name": { url: "http://x" },
        broken: { type: "http" },
        notobj: "nope" as unknown as Record<string, unknown>,
      }),
    ).toEqual([]);
  });
});

describe("(sdk, executionMode) selection table", () => {
  it("includes a row per backend and resolves backend ids alias-aware", () => {
    expect(selectMonoRuntimeBackendId("claude", "sdk")).toBe("claude-sdk");
    expect(selectMonoRuntimeBackendId("anthropic", "sdk")).toBeUndefined();
    expect(selectMonoRuntimeBackendId("claude", "cli")).toBe("claude-code-cli");
    expect(selectMonoRuntimeBackendId("codex", "cli")).toBe("codex-app-cli");
    expect(selectMonoRuntimeBackendId("openai", "sdk")).toBe("openai-agents-sdk");
    expect(selectMonoRuntimeBackendId("pi", "sdk")).toBe("pi-sdk");
    expect(selectMonoRuntimeBackendId("openai", "cli")).toBeUndefined();
  });

  it("derives accepted sdk ids per backend", () => {
    expect(acceptedSdkIdsForBackend("claude-sdk")).toEqual(["claude"]);
    expect(acceptedSdkIdsForBackend("codex-app-cli")).toEqual(["codex"]);
    expect(acceptedSdkIdsForBackend("openai-agents-sdk")).toEqual(["openai"]);
  });

  it("table rows reference real backend descriptors", () => {
    const backendIds = new Set(listMonoRuntimeBackends().map((backend) => backend.id));
    for (const entry of listMonoRuntimeSelectionTable()) {
      expect(backendIds.has(entry.backendId)).toBe(true);
    }
  });

  it("exposes the openai-agents backend with self-described capabilities", () => {
    const openai = listMonoRuntimeBackends().find((backend) => backend.id === "openai-agents-sdk");
    expect(openai?.sdk).toBe("openai");
    expect(openai?.capabilities.kind).toBe("openai-agents");
    expect(openai?.capabilities.supports_mcp).toBe(true);
  });
});
