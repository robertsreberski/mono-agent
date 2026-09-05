import { describe, expect, it, vi } from "vitest";

import {
  discoverLocalProviderModels,
  parseMonoRuntimeModelReference,
  resolveModelEffortLevels,
  type LocalProviderDefinition,
} from "../index.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function fakeFetch(impl: (url: string) => Promise<Response>): typeof fetch {
  return ((url: string) => impl(url)) as unknown as typeof fetch;
}

const LMSTUDIO_PROVIDER: LocalProviderDefinition = {
  id: "lmstudio",
  type: "lmstudio",
  baseUrl: "http://localhost:1234",
  enabled: true,
};

describe("discoverLocalProviderModels", () => {
  it("bounds metadata concurrency and retains models when its shared deadline expires", async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const pending = discoverLocalProviderModels([{
        id: "ollama", type: "ollama", baseUrl: "http://localhost:11434",
      }], { timeoutMs: 100, fetch: (async (url, init) => {
        if (String(url).endsWith("/v1/models")) return jsonResponse({
          data: Array.from({ length: 12 }, (_, i) => ({ id: `model-${i}` })),
        });
        active++;
        peak = Math.max(peak, active);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { active--; reject(new Error("aborted")); });
        });
      }) as typeof fetch });
      await vi.advanceTimersByTimeAsync(100);
      const models = await pending;
      expect(peak).toBe(4);
      expect(active).toBe(0);
      expect(models).toHaveLength(12);
      expect(models.every((model) => model.embeddingOnly === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies LM Studio embedding keys and loaded instance ids without guessing names", async () => {
    const models = await discoverLocalProviderModels([{ ...LMSTUDIO_PROVIDER, id: "desk" }], {
      fetch: fakeFetch(async (url) => jsonResponse(url.endsWith("/api/v1/models")
        ? { models: [
          { key: "vector", type: "embedding", loaded_instances: [{ id: "loaded-vector" }] },
          { key: "embedding-in-chat-name", type: "llm" },
        ] }
        : { data: [{ id: "vector" }, { id: "loaded-vector" }, { id: "embedding-in-chat-name" }] })),
    });
    expect(models.map((model) => [model.ref, model.embeddingOnly ?? false])).toEqual([
      ["desk:vector", true], ["desk:loaded-vector", true], ["desk:embedding-in-chat-name", false],
    ]);
  });

  it("classifies only Ollama embedding-only models and retains unknown or dual-purpose models", async () => {
    const models = await discoverLocalProviderModels([{
      id: "desk", type: "ollama", baseUrl: "http://localhost:11434/v1",
    }], {
      fetch: (async (url, init) => {
        if (String(url).endsWith("/v1/models")) return jsonResponse({
          data: ["vector", "both", "chat", "unknown"].map((id) => ({ id })),
        });
        expect(String(url)).toBe("http://localhost:11434/api/show");
        const { model } = JSON.parse(String(init?.body));
        if (model === "unknown") throw new Error("unavailable");
        return jsonResponse({ capabilities: model === "vector" ? ["embedding"]
          : model === "both" ? ["embedding", "completion"] : ["completion"] });
      }) as typeof fetch,
    });
    expect(models.map((model) => [model.ref, model.embeddingOnly ?? false])).toEqual([
      ["desk:vector", true], ["desk:both", false], ["desk:chat", false], ["desk:unknown", false],
    ]);
  });

  it("parses a well-formed /v1/models response into <providerId>:<modelId> refs", async () => {
    const models = await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch(() => Promise.resolve(jsonResponse({ data: [{ id: "qwen3-8b" }, { id: "llama-3.1" }] }))),
    });

    expect(models).toEqual([
      { ref: "lmstudio:qwen3-8b", label: "qwen3-8b", providerId: "lmstudio" },
      { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ]);
  });

  it("builds a correct ref for a model id containing a slash", async () => {
    const models = await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch(() => Promise.resolve(jsonResponse({ data: [{ id: "meta/llama-3.1-8b-instruct" }] }))),
    });

    expect(models).toEqual([
      { ref: "lmstudio:meta/llama-3.1-8b-instruct", label: "meta/llama-3.1-8b-instruct", providerId: "lmstudio" },
    ]);
  });

  it("requests <root>/v1/models for a non-ollama provider whose baseUrl has no version segment", async () => {
    const calls: string[] = [];
    await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch((url) => {
        calls.push(url);
        return Promise.resolve(jsonResponse({ data: [] }));
      }),
    });

    expect(calls).toEqual(["http://localhost:1234/v1/models"]);
  });

  it("requests <root>/v1/models for an ollama provider, stripping any existing /api or /v1 suffix", async () => {
    const calls: string[] = [];
    await discoverLocalProviderModels(
      [{ id: "ollama", type: "ollama", baseUrl: "http://localhost:11434/api", enabled: true }],
      {
        fetch: fakeFetch((url) => {
          calls.push(url);
          return Promise.resolve(jsonResponse({ data: [] }));
        }),
      },
    );

    expect(calls).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("does not double-append /v1 when the configured baseUrl already ends in a version segment", async () => {
    const calls: string[] = [];
    await discoverLocalProviderModels(
      [{ id: "gateway", type: "openai_compat", baseUrl: "http://localhost:9000/v1", enabled: true }],
      {
        fetch: fakeFetch((url) => {
          calls.push(url);
          return Promise.resolve(jsonResponse({ data: [] }));
        }),
      },
    );

    expect(calls).toEqual(["http://localhost:9000/v1/models"]);
  });

  it("skips a provider whose fetch rejects, without throwing", async () => {
    const models = await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch(() => Promise.reject(new Error("ECONNREFUSED"))),
    });

    expect(models).toEqual([]);
  });

  it("skips a provider whose endpoint times out, without throwing", async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch;

      const pending = discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
        fetch: hangingFetch,
        timeoutMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const models = await pending;

      expect(models).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a provider that returns a non-JSON body, without throwing", async () => {
    const models = await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
        } as unknown as Response)),
    });

    expect(models).toEqual([]);
  });

  it("skips a provider whose response is not the expected { data: [...] } shape", async () => {
    const models = await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch(() => Promise.resolve(jsonResponse({ models: ["not-the-openai-shape"] }))),
    });

    expect(models).toEqual([]);
  });

  it("skips a provider whose response is a non-2xx status", async () => {
    const models = await discoverLocalProviderModels([LMSTUDIO_PROVIDER], {
      fetch: fakeFetch(() => Promise.resolve(jsonResponse({ data: [{ id: "x" }] }, false))),
    });

    expect(models).toEqual([]);
  });

  it("honors enabled:false and never fetches a disabled provider", async () => {
    const fetchSpy = vi.fn();
    const models = await discoverLocalProviderModels(
      [{ id: "disabled", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: false }],
      { fetch: fetchSpy as unknown as typeof fetch },
    );

    expect(models).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns [] for undefined or empty providers", async () => {
    expect(await discoverLocalProviderModels(undefined)).toEqual([]);
    expect(await discoverLocalProviderModels([])).toEqual([]);
  });

  it("flattens results across multiple enabled providers and skips a failing one", async () => {
    const models = await discoverLocalProviderModels(
      [
        { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
        { id: "down", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
        { id: "disabled-gw", type: "openai_compat", baseUrl: "http://localhost:9999", enabled: false },
      ],
      {
        fetch: fakeFetch((url) => {
          if (url.includes("11434")) {
            return Promise.resolve(jsonResponse({ data: [{ id: "gpt-oss:20b" }] }));
          }
          return Promise.reject(new Error("down"));
        }),
      },
    );

    expect(models).toEqual([{ ref: "ollama:gpt-oss:20b", label: "gpt-oss:20b", providerId: "ollama" }]);
  });
});

describe("resolveModelEffortLevels", () => {
  const configuredProviders: readonly LocalProviderDefinition[] = [
    {
      id: "lmstudio",
      type: "lmstudio",
      baseUrl: "http://localhost:1234",
      enabled: true,
      models: [
        {
          name: "qwen/qwen3-8b",
          capabilities: { reasoning: true, reasoning_mode: "effort", reasoning_levels: ["low", "medium", "high"] },
        },
      ],
    },
  ];

  it("returns the configured reasoning levels + effort mode for a configured local model", () => {
    const ref = parseMonoRuntimeModelReference("lmstudio:qwen/qwen3-8b");

    expect(resolveModelEffortLevels(ref, configuredProviders)).toEqual({
      reasoning: true,
      reasoningMode: "effort",
      effortLevels: ["low", "medium", "high"],
    });
  });

  it("returns reasoningMode:'toggle' with no effortLevels for an Ollama toggle-reasoning model (e.g. qwen)", () => {
    const providers: readonly LocalProviderDefinition[] = [
      { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
    ];
    const ref = parseMonoRuntimeModelReference("ollama:qwen3.6:latest");

    // Toggle models support only binary thinking, so they carry NO graded
    // effortLevels — the client renders on/off from the mode alone.
    expect(resolveModelEffortLevels(ref, providers)).toEqual({ reasoning: true, reasoningMode: "toggle" });
  });

  it("returns reasoningMode:'effort' + levels for an Ollama effort-reasoning model (e.g. gpt-oss)", () => {
    const providers: readonly LocalProviderDefinition[] = [
      { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
    ];
    const ref = parseMonoRuntimeModelReference("ollama:gpt-oss:20b");

    expect(resolveModelEffortLevels(ref, providers)).toEqual({
      reasoning: true,
      reasoningMode: "effort",
      effortLevels: ["low", "medium", "high"],
    });
  });

  it("defaults an undeclared local model to non-reasoning (reasoningMode 'none', no capabilities configured for it)", () => {
    const providers: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const ref = parseMonoRuntimeModelReference("lmstudio:some-new-model");

    expect(resolveModelEffortLevels(ref, providers)).toEqual({ reasoning: false, reasoningMode: "none" });
  });

  it("degrades to reasoning:true with no effortLevels for a cloud model reference", () => {
    const ref = parseMonoRuntimeModelReference("anthropic:claude-fable-5");

    expect(resolveModelEffortLevels(ref, configuredProviders)).toEqual({ reasoning: true });
  });

  it("degrades to reasoning:true with no effortLevels for a local ref whose provider isn't configured", () => {
    const ref = parseMonoRuntimeModelReference("unknown-provider:some-model");

    expect(resolveModelEffortLevels(ref, configuredProviders)).toEqual({ reasoning: true });
  });

  it("degrades to reasoning:true when no providers are configured at all", () => {
    const ref = parseMonoRuntimeModelReference("lmstudio:qwen/qwen3-8b");

    expect(resolveModelEffortLevels(ref, undefined)).toEqual({ reasoning: true });
  });

  it("never throws even for a malformed local provider definition", () => {
    const brokenProviders = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "not-a-url", enabled: true },
    ] as unknown as readonly LocalProviderDefinition[];
    const ref = parseMonoRuntimeModelReference("lmstudio:model");

    expect(() => resolveModelEffortLevels(ref, brokenProviders)).not.toThrow();
  });
});
