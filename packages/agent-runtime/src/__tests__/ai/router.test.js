import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();
const runtimeCapabilitiesMock = vi.fn();

vi.mock("../../ai/runtime/capabilities.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runtimeCapabilities: (...args) => runtimeCapabilitiesMock(...args) ?? actual.runtimeCapabilities(...args),
  };
});

vi.mock("../../ai/runtime/registry.js", async () => {
  const actual = await vi.importActual("../../ai/runtime/registry.js");
  return {
    ...actual,
    resolveRuntimeBridge: (...args) => resolveRuntimeBridgeMock(...args),
  };
});

const { createRouterRuntime } = await import("../../ai/runtime/router.js");
const { createRuntime } = await import("../../runtime.js");
const { passthroughSandbox } = await import("../../agent/sandbox-seam.js");
const { createFakeSandbox } = await import("../helpers/fake-sandbox.js");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function modelRef(provider, model) {
  return { provider, model, reference: `${provider}:${model}` };
}

beforeEach(() => {
  executeMock.mockReset();
  runtimeCapabilitiesMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
});


describe("createRouterRuntime — basic", () => {
  it("never retries or falls back a manual compaction of the primary session", async () => {
    executeMock.mockResolvedValueOnce({ error: "summary failed", failureKind: "provider_unavailable" });
    const primary = modelRef("anthropic", "claude-opus-4-7");
    const router = createRouterRuntime({ chain: [primary, modelRef("openai-codex", "gpt-5.5")] });
    const result = await router.run("sys", { model: primary, manualCompaction: true,
      sessionId: "owned", sessionKeepAlive: true, messages: [] });
    expect(result.error).toBe("summary failed");
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1]).toMatchObject({ sessionId: "owned", manualCompaction: true });
  });
  it("rejects an empty chain", () => {
    expect(() => createRouterRuntime({ chain: [] })).toThrow(/non-empty chain/);
  });

  it("uses the first chain entry when it succeeds", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    expect(result.failoverHistory).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("createRouterRuntime — fallback on retryable", () => {
  it("falls back to the next chain entry on a retryable provider error", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Anthropic API overloaded — try again later",
        failureKind: "provider_unavailable",
        events: [
          { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
          { type: "final" },
        ],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });

    const events = [];
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("sys", { messages: [], onEvent: (e) => events.push(e) });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].model.model).toBe("claude-opus-4-7");
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock.mock.calls[0][1].webSearchState).toBe(executeMock.mock.calls[1][1].webSearchState);
    // Payloads, not just types: every renderer reads these fields as strings, so
    // an object here is silently dropped downstream rather than failing loudly.
    const failoverEvents = events.filter((e) => e.type?.startsWith("provider_failover"));
    expect(failoverEvents).toEqual([
      {
        type: "provider_failover_started",
        from: "anthropic:claude-opus-4-7",
        to: "anthropic:claude-sonnet-4-6",
        attemptIndex: 1,
        reason: "overloaded",
      },
      {
        type: "provider_failover_completed",
        attemptIndex: 1,
        model: "anthropic:claude-sonnet-4-6",
      },
    ]);
  });

  it("advances across a mixed-provider Pi chain", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: null,
        error: "Anthropic API overloaded",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "local recovery", events: [], failureKind: null });

    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.6-sol"),
        modelRef("anthropic", "claude-sonnet-4-6"),
        modelRef("ollama", "qwen3:8b"),
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("local recovery");
    expect(executeMock.mock.calls.map((call) => call[1].model.provider)).toEqual([
      "openai-codex",
      "anthropic",
      "ollama",
    ]);
    expect(result.failoverHistory.map((attempt) => attempt.model.provider)).toEqual([
      "openai-codex",
      "anthropic",
    ]);
  });

  it("reuses one instrumented live-input stream across failover without duplicate applied events", async () => {
    const acknowledge = vi.fn(() => "recorded");
    const reject = vi.fn(() => "recorded");
    const events = [];
    executeMock
      .mockImplementationOnce(async (_systemPrompt, options) => {
        const next = await options.liveInput[Symbol.asyncIterator]().next();
        next.value.reject(new Error("safe pre-acceptance failure"));
        return {
          text: null,
          error: "Connection error.",
          failureKind: "provider_unavailable",
          events: [],
          cancelled: false,
        };
      })
      .mockImplementationOnce(async (_systemPrompt, options) => {
        const replay = await options.liveInput[Symbol.asyncIterator]().next();
        replay.value.acknowledge();
        return { text: "recovered", events: [], failureKind: null };
      });
    const liveInput = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return {
              done: false,
              value: {
                body: "guide",
                id: "follow-up-1",
                receivedAt: "2026-07-22T08:30:00.000Z",
                acknowledge,
                reject,
              },
            };
          },
        };
      },
    };
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });

    const result = await router.run("sys", {
      messages: [],
      liveInput,
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toBe("recovered");
    expect(reject).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "live_input_applied")).toEqual([{
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    }]);
    expect(executeMock.mock.calls[0][1].liveInput).toBe(executeMock.mock.calls[1][1].liveInput);
  });

  it("falls back on pi 0.80's terse 'Connection error.' (live-smoke regression)", async () => {
    // pi 0.80's bridge collapses a connection-refused/unreachable provider down
    // to this bare string with no cause text — see ai/failure.js's
    // retryableProviderSubkind "network" branch.
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });

    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("falls back on pi-ai's truncated stream and carries the partial turn forward", async () => {
    // Regression for a live incident: a 12-minute research turn died on
    // "Stream ended without finish_reason" (pi-ai 0.83.0 openai-completions) with a
    // three-model fallback chain configured, and the router never advanced off the
    // primary because the text matched no retryable pattern. The work already done
    // must reach the next route instead of being thrown away.
    const callPrompts = [];
    executeMock.mockImplementation(async (systemPrompt) => {
      callPrompts.push(systemPrompt);
      if (callPrompts.length === 1) {
        return {
          text: null,
          error: "Stream ended without finish_reason",
          failureKind: "provider_unavailable",
          events: [
            { type: "assistant", message: { content: [{ type: "text", text: "Malta dive itinerary so far" }] } },
            { type: "final" },
          ],
          cancelled: false,
        };
      }
      return { text: "recovered", events: [], failureKind: null };
    });

    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("Original system prompt", { messages: [] });

    expect(result.text).toBe("recovered");
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.failoverHistory).toMatchObject([{ retryableSubkind: "network" }]);
    // The partial answer survives the route change rather than being discarded.
    expect(callPrompts[1]).toContain("<resume_context>");
    expect(callPrompts[1]).toContain("Malta dive itinerary so far");
  });

  it("falls back when the primary model still exceeds its context window after compaction", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
        failureKind: "context_limit",
        events: [],
        cancelled: false,
        diagnostics: {
          context_compaction_reactive_attempted: true,
          context_compaction_reduced: true,
        },
      })
      .mockResolvedValueOnce({
        text: "recovered through Kimi",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.6-sol"),
        modelRef("opencode-go", "kimi-k2.6"),
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered through Kimi");
    expect(result.failoverHistory).toEqual([
      expect.objectContaining({
        model: expect.objectContaining({ provider: "openai-codex", model: "gpt-5.6-sol" }),
        failureKind: "context_limit",
        retryableSubkind: "context_limit",
      }),
    ]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("returns the last failure with provider_unavailable_exhausted when every entry fails", async () => {
    executeMock.mockResolvedValue({
      text: null,
      error: "Anthropic API overloaded — try again later",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory).toHaveLength(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back on non-retryable provider request failures", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "invalid_request_error: Unknown parameter: prompt_cache_retention",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.failoverHistory[0].failureKind).toBe("provider_unavailable");
    expect(result.failoverHistory[0].retryableSubkind).toBe("non_retryable");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back on provider_auth failures and preserves the attempt detail", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "No API key for provider: openai-codex",
        failureKind: "provider_auth",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.5"),
        modelRef("opencode-go", "kimi-k2.6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].failureKind).toBe("provider_auth");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("fails over between Pi providers after a provider-auth result", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Sign in to GitHub Copilot.",
        failureKind: "provider_auth",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered through Pi",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        modelRef("github-copilot", "gpt-5.1"),
        modelRef("opencode-go", "kimi-k2.6"),
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered through Pi");
    expect(result.failoverHistory).toEqual([
      expect.objectContaining({
        model: expect.objectContaining({ provider: "github-copilot" }),
        failureKind: "provider_auth",
      }),
    ]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps primary session keys and strips backup session keys in a multi-provider Pi chain", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.5"),
        modelRef("github-copilot", "gpt-5.1"),
      ],
    });

    const sessionKeys = {
      sessionId: "host-session",
      providerSessionId: "pi-provider-session",
      sessionKeepAlive: true,
      sessionIdleTimeoutMs: 60_000,
    };
    const options = { messages: [], ...sessionKeys, providerAttributionSessionId: "conversation-epoch" };
    const originalOptions = structuredClone(options);
    const result = await router.run("sys", options);

    expect(result.text).toBe("recovered");
    expect(options).toEqual(originalOptions);
    expect(executeMock.mock.calls[0][1]).toMatchObject(sessionKeys);
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionIdleTimeoutMs");
    expect(executeMock.mock.calls[0][1].providerAttributionSessionId).toBe("conversation-epoch");
    // A backup never presents the primary's attribution/session identity.
    expect(executeMock.mock.calls[1][1].providerAttributionSessionId).toMatch(UUID_PATTERN);
  });

  it("rejects an attempt resolver that tries to replace provider attribution", async () => {
    const router = createRouterRuntime({
      chain: [modelRef("opencode-go", "deepseek-v4-pro")],
      resolveAttempt: () => ({ options: { providerAttributionSessionId: "resolver-value" } }),
    });

    const result = await router.run("sys", {
      messages: [],
      providerAttributionSessionId: "host-value",
    });

    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.error).toBe("route attempt resolver cannot override providerAttributionSessionId");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("rejects an attempt resolver that tries to replace the run-bound artifact sink", async () => {
    const router = createRouterRuntime({
      chain: [modelRef("opencode-go", "deepseek-v4-pro")],
      resolveAttempt: () => ({ options: { persistArtifact: () => "/tmp/resolver-owned" } }),
    });

    const result = await router.run("sys", {
      messages: [],
      persistArtifact: () => "/tmp/host-owned",
    });

    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.error).toBe("route attempt resolver cannot override persistArtifact");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("normalizes auth-shaped provider_unavailable failures before falling back", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "No API key for provider: openai-codex",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.5"),
        modelRef("opencode-go", "kimi-k2.6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].failureKind).toBe("provider_auth");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("reports chain exhaustion when every eligible entry fails with provider_auth", async () => {
    executeMock.mockResolvedValue({
      text: null,
      error: "No API key for provider: openai-codex",
      failureKind: "provider_auth",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.5"),
        modelRef("opencode-go", "kimi-k2.6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory).toHaveLength(2);
    expect(result.failoverHistory.map((entry) => entry.failureKind)).toEqual([
      "provider_auth",
      "provider_auth",
    ]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back when the run was cancelled", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "cancelled",
      failureKind: "cancelled_user",
      events: [],
      cancelled: true,
    });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.cancelled).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("createRouterRuntime — transcript replay on fallback", () => {
  it("prepends a resume context to the system prompt when falling back", async () => {
    const callPrompts = [];
    executeMock.mockImplementation(async (systemPrompt) => {
      callPrompts.push(systemPrompt);
      if (callPrompts.length === 1) {
        return {
          text: null,
          error: "overloaded",
          failureKind: "provider_unavailable",
          events: [
            { type: "assistant", message: { content: [{ type: "text", text: "first attempt" }] } },
            { type: "final" },
          ],
          cancelled: false,
        };
      }
      return { text: "ok", events: [], failureKind: null };
    });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    await router.run("Original system prompt", { messages: [] });
    expect(callPrompts).toHaveLength(2);
    expect(callPrompts[0]).toBe("Original system prompt");
    expect(callPrompts[1]).toContain("<resume_context>");
    expect(callPrompts[1]).toContain("first attempt");
    expect(callPrompts[1]).toContain("Original system prompt");
  });

  it("does not duplicate a pending snapshot across a capability mismatch", async () => {
    const prompts = [];
    executeMock.mockImplementationOnce(async (prompt) => {
      prompts.push(prompt);
      return {
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "first attempt" }] } }],
        cancelled: false,
      };
    }).mockImplementationOnce(async (prompt) => {
      prompts.push(prompt);
      return {
        text: null,
        error: "unsupported option",
        failureKind: "skipped_capability_mismatch",
        events: [],
        cancelled: false,
      };
    }).mockImplementationOnce(async (prompt) => {
      prompts.push(prompt);
      return { text: "ok", events: [], failureKind: null };
    });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "first"),
        modelRef("anthropic", "mismatch"),
        modelRef("openai", "success"),
      ],
    });

    const result = await router.run("Original system prompt", { messages: [] });

    expect(result.text).toBe("ok");
    expect(prompts).toHaveLength(3);
    expect(prompts[1].match(/<resume_context>/gu)).toHaveLength(1);
    expect(prompts[2].match(/<resume_context>/gu)).toHaveLength(1);
    expect(prompts[2]).toContain("first attempt");
  });
});

describe("createRouterRuntime — capability filtering", () => {
  it("skips chain entries that don't satisfy `requires`", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { model: modelRef("anthropic", "x"), requires: { kind: "does-not-exist" } },
        modelRef("openai", "openai-gpt-4"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].failureKind).toBe("skipped_capability_mismatch");
  });

  it("does not report provider availability exhaustion when no provider entry executed", async () => {
    const router = createRouterRuntime({
      chain: [
        { model: modelRef("anthropic", "x"), requires: { kind: "does-not-exist" } },
        { model: modelRef("openai", "openai-gpt-4"), requires: { kind: "also-missing" } },
      ],
    });
    const result = await router.run("sys", { messages: [] });

    expect(executeMock).not.toHaveBeenCalled();
    expect(result.failureKind).toBe("skipped_capability_mismatch");
    expect(result.failoverHistory).toHaveLength(2);
  });

  it("continues when a bridge itself returns a capability mismatch", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "unsupported option",
        failureKind: "skipped_capability_mismatch",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "must not snapshot" }] } }],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "first"),
        modelRef("openai", "second"),
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered");
    expect(result.failoverHistory[0].failureKind).toBe("skipped_capability_mismatch");
    expect(executeMock.mock.calls[1][0]).toBe("sys");
    expect(executeMock.mock.calls[1][1].diagnosticsSeed).toBeUndefined();
  });

  it("still attempts a Pi fallback when request options add no missing capability", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Anthropic API overloaded — try again later",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("anthropic", "claude-opus-4-7"),
        modelRef("openai", "openai-gpt-4"),
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("recovered");
    expect(
      result.failoverHistory.some((h) => h.failureKind === "skipped_capability_mismatch"),
    ).toBe(false);
  });
});

describe("createRouterRuntime — chain entry shorthand", () => {
  it("accepts bare ModelRef entries", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [modelRef("anthropic", "x")],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    const call = executeMock.mock.calls[0][1];
    expect(call.model).toEqual(modelRef("anthropic", "x"));
  });
});

describe("createRouterRuntime — production fallback contracts", () => {
  it("applies tri-state effort semantics per route", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { model: modelRef("anthropic", "inherit") },
        { model: modelRef("ollama", "provider-default"), effort: null },
        { model: modelRef("openai", "fixed"), effort: "ultra" },
      ],
    });

    await router.run("sys", { messages: [], effort: "high" });

    expect(executeMock.mock.calls[0][1].effort).toBe("high");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("effort");
    expect(executeMock.mock.calls[2][1].effort).toBe("ultra");
  });

  it("only the primary first attempt owns a session when both routes support resume", async () => {
    const failure = { text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false };
    executeMock.mockResolvedValueOnce(failure).mockResolvedValueOnce(failure).mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { model: modelRef("openai-codex", "primary"), attempts: 2 },
        { model: modelRef("anthropic", "fallback"), attempts: 2 },
      ],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const sessionKeys = {
      sessionId: "host-session", providerSessionId: "provider-session",
      sessionKeepAlive: true, sessionIdleTimeoutMs: 60_000, sessionRecovery: { runId: "run", revision: 1 },
      sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "run", handleId: "host-session", baseRevision: 1 },
    };
    await router.run("sys", { messages: [], ...sessionKeys, providerAttributionSessionId: "epoch" });
    expect(executeMock).toHaveBeenCalledTimes(4);
    expect(executeMock.mock.calls[0][1]).toMatchObject(sessionKeys);
    for (const [, options] of executeMock.mock.calls.slice(1)) {
      for (const key of Object.keys(sessionKeys)) expect(options).not.toHaveProperty(key);
      expect(options.providerAttributionSessionId).toMatch(UUID_PATTERN);
    }
    // Every non-eligible attempt, including same-model retries, gets its own id.
    const attributionIds = executeMock.mock.calls.map(([, options]) => options.providerAttributionSessionId);
    expect(attributionIds[0]).toBe("epoch");
    expect(new Set(attributionIds).size).toBe(4);
  });

  it.each(["primary retry", "backup", "skipped-primary backup"])(
    "withholds the resumable result id after a %s answer", async (outcome) => {
      const primary = modelRef("openai-codex", "primary");
      const backup = modelRef("anthropic", "backup");
      if (outcome !== "skipped-primary backup") {
        executeMock.mockResolvedValueOnce({ error: "Connection error.", failureKind: "provider_unavailable", events: [] });
      }
      const diagnostics = { provider_session_id: "coordinated-id" };
      const events = [{ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }];
      executeMock.mockResolvedValueOnce({ text: "answer", providerSessionId: "coordinated-id", providerSessionRecovery: { runId: "forged", revision: 1, providerSessionId: "coordinated-id", modelKey: "wrong", tipId: "tip" }, diagnostics, events });
      const router = createRouterRuntime({
        chain: [
          { model: primary, attempts: outcome === "primary retry" ? 2 : 1,
            ...(outcome === "skipped-primary backup" ? { requires: { supports_native_subagents: true } } : {}) },
          { model: backup },
        ],
        retry: { backoffMs: 0, maxBackoffMs: 0 },
      });
      const result = await router.run("sys", {
        messages: [], sessionId: "coordinated-id", providerSessionId: "coordinated-id",
        providerAttributionSessionId: "coordinated-id", sessionKeepAlive: true, sessionIdleTimeoutMs: 60_000, sessionRecovery: { runId: "run", revision: 1 }, sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "run", handleId: "coordinated-id", baseRevision: 1 },
      });
      expect(result.providerSessionId).toBeUndefined();
      expect(result.providerSessionRecovery).toBeUndefined();
      expect(result.text).toBe("answer");
      expect(result.diagnostics).toMatchObject(diagnostics);
      expect(result.events).toEqual(expect.arrayContaining(events));
      const options = executeMock.mock.calls.at(-1)[1];
      expect(options.model).toEqual(outcome === "primary retry" ? primary : backup);
      expect(options.providerAttributionSessionId).toMatch(UUID_PATTERN);
      for (const key of ["sessionTurn", "sessionRecovery", "sessionId", "providerSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs"]) {
        expect(options).not.toHaveProperty(key);
      }
      expect(result.failoverHistory).toHaveLength(1);
      expect(result.failoverHistory[0].failureKind).toBe(
        outcome === "skipped-primary backup" ? "skipped_capability_mismatch" : "provider_unavailable",
      );
    },
  );

  it("preserves the primary first-attempt result session id with fallbacks configured", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", providerSessionId: "coordinated-id", events: [] });
    const router = createRouterRuntime({ chain: [modelRef("openai-codex", "primary"), modelRef("anthropic", "backup")] });
    const result = await router.run("sys", { messages: [], sessionId: "coordinated-id", sessionKeepAlive: true });
    expect(result.providerSessionId).toBe("coordinated-id");
    expect(result.failoverHistory).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("strips primary session state when resume capability is false", async () => {
    const actual = await vi.importActual("../../ai/runtime/capabilities.js");
    runtimeCapabilitiesMock.mockReturnValue({ ...actual.runtimeCapabilities(), supports_session_resume: false });
    executeMock.mockResolvedValueOnce({ text: "ok", providerSessionId: "coordinated-id", events: [] });
    const router = createRouterRuntime({ chain: [modelRef("openai-codex", "primary"), modelRef("anthropic", "backup")] });
    const result = await router.run("sys", {
      messages: [], sessionId: "coordinated-id", providerSessionId: "coordinated-id",
      sessionKeepAlive: true, sessionIdleTimeoutMs: 60_000, sessionRecovery: { runId: "run", revision: 1 }, sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "run", handleId: "coordinated-id", baseRevision: 1 },
    });
    for (const key of ["sessionTurn", "sessionRecovery", "sessionId", "providerSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs"]) {
      expect(executeMock.mock.calls[0][1]).not.toHaveProperty(key);
    }
    expect(result.providerSessionId).toBeUndefined();
  });

  it("resolves private local-provider options for the actual attempted model without leaking them", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const seen = [];
    const router = createRouterRuntime({
      chain: [
        modelRef("local-a", "a"),
        modelRef("openai", "b"),
      ],
      resolveAttempt: ({ model }) => {
        seen.push(model.provider);
        return model.provider === "local-a"
          ? { options: { customProvider: { id: "local-a", api_key: "route-secret" } } }
          : { options: {} };
      },
    });

    const result = await router.run("sys", {
      messages: [],
      customProvider: { id: "wrong-primary", api_key: "wrong-secret" },
      customModel: { id: "wrong-model" },
    });

    expect(seen).toEqual(["local-a", "openai"]);
    expect(executeMock.mock.calls[0][1].customProvider).toEqual({ id: "local-a", api_key: "route-secret" });
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("customProvider");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("customModel");
    expect(JSON.stringify(result)).not.toContain("route-secret");
    expect(JSON.stringify(result)).not.toContain("wrong-secret");
  });

  it("projects the logical tool policy separately for each attempted provider", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "fallback ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "gpt-5.5"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
      resolveAttempt: ({ model }) => ({
        policyOptions: model.provider === "openai-codex"
          ? { allowedTools: ["*"], disallowedTools: [] }
          : { allowedTools: ["Read", "Agent"], disallowedTools: ["Write"] },
      }),
    });

    const result = await router.run("sys", {
      messages: [],
      allowedTools: ["Read", "Agent"],
      disallowedTools: ["Write"],
    });

    expect(result.text).toBe("fallback ok");
    expect(executeMock.mock.calls[0][1]).toMatchObject({
      allowedTools: ["*"],
      disallowedTools: [],
    });
    expect(executeMock.mock.calls[1][1]).toMatchObject({
      allowedTools: ["Read", "Agent"],
      disallowedTools: ["Write"],
    });
  });

  it("keeps primary run-level custom metadata for compatibility but scrubs every fallback without a resolver", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "builtin recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("local", "custom-primary"),
        modelRef("anthropic", "claude-sonnet-4-6"),
      ],
    });
    const primaryMetadata = {
      customProvider: { id: "local", api_key: "primary-secret" },
      customModel: { id: "custom-primary", contextWindow: 32_000 },
      modelCapabilities: { reasoning: true, tools: true },
      isPrivateProvider: true,
    };

    const result = await router.run("sys", { messages: [], ...primaryMetadata });

    expect(result.text).toBe("builtin recovered");
    expect(executeMock.mock.calls[0][1]).toMatchObject(primaryMetadata);
    for (const key of Object.keys(primaryMetadata)) {
      expect(executeMock.mock.calls[1][1]).not.toHaveProperty(key);
    }
  });

  it("projects router tool context into a resolver-supplied Pi runtime", async () => {
    const stalePolicy = { mode: "native", marker: "stale" };
    const resolvedRuntime = createRuntime({
      workspace: "/tmp/stale",
      sandboxPolicy: stalePolicy,
      sandbox: createFakeSandbox(),
    });
    const router = createRouterRuntime({
      chain: [modelRef("anthropic", "claude-sonnet-4-6")],
      resolveAttempt: () => ({ runtime: resolvedRuntime }),
    });
    router.configureTools({
      workspace: "/tmp/configured",
      additionalReadRoots: ["/tmp/framework", "/tmp/worktrees"],
      additionalWriteRoots: ["/tmp/worktrees"],
    });
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("ok");
    expect(executeMock.mock.calls[0][1].toolContext).toMatchObject({
      workspace: "/tmp/configured",
      additionalReadRoots: ["/tmp/framework", "/tmp/worktrees"],
      additionalWriteRoots: ["/tmp/worktrees"],
      sandbox: passthroughSandbox,
    });
    expect(executeMock.mock.calls[0][1].toolContext.sandboxPolicy).toBeUndefined();
  });

  it("fails before execution when a resolver-supplied Pi runtime cannot accept tool context", async () => {
    const suppliedRun = vi.fn();
    const router = createRouterRuntime({
      chain: [modelRef("openai", "gpt-5.5")],
      resolveAttempt: () => ({ runtime: { run: suppliedRun } }),
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.error).toBe("The route attempt could not be resolved before execution.");
    expect(suppliedRun).not.toHaveBeenCalled();
  });

  it("does not expose credentials from resolver failures", async () => {
    const router = createRouterRuntime({
      chain: [modelRef("ollama", "private")],
      resolveAttempt: () => {
        throw new Error("failed with api_key=route-secret-value");
      },
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.error).toBe("The route attempt could not be resolved before execution.");
    expect(JSON.stringify(result)).not.toContain("route-secret-value");
  });

  it("keeps a single merged resume snapshot across multiple provider failures", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "first progress" }] } }],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "second progress" }] } }],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "one"),
        modelRef("anthropic", "two"),
        modelRef("ollama", "three"),
      ],
    });

    await router.run("sys", { messages: [] });

    const finalPrompt = executeMock.mock.calls[2][0];
    expect(finalPrompt.match(/<resume_context>/gu)).toHaveLength(1);
    expect(finalPrompt).toContain("first progress");
    expect(finalPrompt).toContain("second progress");
  });

  it("rejects duplicate chains before creating a run", () => {
    expect(() => createRouterRuntime({
      chain: [
        modelRef("anthropic", "same"),
        { model: modelRef("anthropic", "same"), effort: "high" },
      ],
    })).toThrow(/duplicate model/u);
    expect(() => createRouterRuntime({
      chain: [{ model: modelRef("anthropic", "bad-effort"), effort: " " }],
    })).toThrow(/non-empty trimmed string/u);
  });
});

describe("createRouterRuntime — same-model retry", () => {
  const OPUS = modelRef("anthropic", "claude-opus-4-7");
  const SONNET = modelRef("anthropic", "claude-sonnet-4-6");
  const overloaded = () => ({
    text: null,
    error: "Anthropic API overloaded — try again later",
    failureKind: "provider_unavailable",
    events: [],
    cancelled: false,
  });

  it("defaults to one attempt per entry so an unconfigured chain is unchanged", async () => {
    executeMock.mockResolvedValue(overloaded());
    const router = createRouterRuntime({ chain: [OPUS, SONNET] });
    const result = await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
  });

  it("retries the same model before advancing to the next entry", async () => {
    executeMock
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });

    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 2 }, { model: SONNET }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered");
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(executeMock.mock.calls.map((c) => c[1].model.model)).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
    expect(result.failoverHistory.map((a) => [a.model.model, a.retryIndex])).toEqual([
      ["claude-opus-4-7", undefined],
      ["claude-opus-4-7", 1],
    ]);
  });

  it("does not retry the same model on context_limit — a fresh window is the only fix", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "prompt is too long: 210000 tokens > 200000 maximum",
        failureKind: "context_limit",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "bigger window", events: [], failureKind: null });

    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 3 }, { model: SONNET }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("bigger window");
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock.mock.calls[1][1].model.model).toBe("claude-sonnet-4-6");
  });

  it("advances past ChatGPT subscription exhaustion without retrying the same route", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "subscription_sharing_usage_limit_exceeded", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "fallback worked", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 3 }, { model: SONNET }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("fallback worked");
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.failoverHistory[0].retryableSubkind).toBe("subscription_limit");
    expect(executeMock.mock.calls[1][1].model.model).toBe("claude-sonnet-4-6");
  });

  it("fails over from an OpenAI ChatGPT subscription limit without retrying that route", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "subscription_sharing_usage_limit_exceeded", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "fallback worked", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [{ model: modelRef("openai", "gpt-5.5"), attempts: 3 }, { model: modelRef("openai-codex", "gpt-5.6-sol") }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("fallback worked");
    expect(result.failoverHistory[0].retryableSubkind).toBe("subscription_limit");
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock.mock.calls[0][1].model.provider).toBe("openai");
    expect(executeMock.mock.calls[1][1].model.provider).toBe("openai-codex");
  });

  it("retries a terminated stream on the same model", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "stream disconnected before completion",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "second try", events: [], failureKind: null });

    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 2 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("second try");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-retryable request errors", { error: "invalid request: bad schema", failureKind: "provider_unavailable" }],
    ["provider auth", { error: "401 unauthorized", failureKind: "provider_auth" }],
    ["mid-turn safety failures", { error: "sandbox denied", failureKind: "sandbox_denied" }],
    ["cancellation", { error: "aborted", failureKind: "provider_unavailable", cancelled: true }],
    // The harness owns a one-shot session-resume retry for these kinds; the
    // router must stay out of it so the two layers cannot multiply.
    ["session_not_found", { error: "no such session", failureKind: "session_not_found" }],
    ["session_busy", { error: "session in use", failureKind: "session_busy" }],
  ])("never retries the same model on %s", async (_label, failure) => {
    executeMock.mockResolvedValue({ text: null, events: [], cancelled: false, ...failure });
    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 3 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("backs off with a doubling delay between retries", async () => {
    vi.useFakeTimers();
    try {
      executeMock.mockResolvedValue(overloaded());
      const router = createRouterRuntime({
        chain: [{ model: OPUS, attempts: 3 }],
        retry: { backoffMs: 1000, maxBackoffMs: 15000 },
      });
      const promise = router.run("sys", { messages: [] });

      await vi.advanceTimersByTimeAsync(0);
      expect(executeMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(executeMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(executeMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(executeMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(executeMock).toHaveBeenCalledTimes(3);

      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the doubling delay at maxBackoffMs", async () => {
    vi.useFakeTimers();
    try {
      executeMock.mockResolvedValue(overloaded());
      const router = createRouterRuntime({
        chain: [{ model: OPUS, attempts: 3 }],
        retry: { backoffMs: 1000, maxBackoffMs: 1500 },
      });
      const promise = router.run("sys", { messages: [] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(executeMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1500);
      expect(executeMock).toHaveBeenCalledTimes(3);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits provider_retry_started and no failover event for a same-model retry", async () => {
    executeMock
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });

    const events = [];
    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 2 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    await router.run("sys", { messages: [], onEvent: (e) => events.push(e) });

    const retryEvents = events.filter((e) => e.type === "provider_retry_started");
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      attemptIndex: 0,
      retryIndex: 1,
      attempts: 2,
      delayMs: 0,
      reason: "overloaded",
    });
    expect(events.filter((e) => e.type?.startsWith("provider_failover"))).toEqual([]);
  });

  it("aborting during the backoff returns cancelled without touching the next entry", async () => {
    const controller = new AbortController();
    executeMock.mockImplementation(async () => {
      controller.abort();
      return overloaded();
    });
    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 3 }, { model: SONNET }],
      retry: { backoffMs: 60000, maxBackoffMs: 60000 },
    });
    const result = await router.run("sys", { messages: [], abortSignal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("re-resolves the attempt and runs its cleanup once per retry", async () => {
    executeMock.mockResolvedValue(overloaded());
    const cleanup = vi.fn();
    const resolveAttempt = vi.fn(() => ({ cleanup }));
    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 3 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
      resolveAttempt,
    });
    await router.run("sys", { messages: [] });

    expect(resolveAttempt).toHaveBeenCalledTimes(3);
    expect(resolveAttempt.mock.calls.map((c) => c[0].retryIndex)).toEqual([0, 1, 2]);
    expect(resolveAttempt.mock.calls.every((c) => c[0].attemptIndex === 0)).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it("keeps the provider session on the first attempt and drops it on a retry", async () => {
    executeMock
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });

    resolveRuntimeBridgeMock.mockResolvedValue({
      id: "stub",
      execute: executeMock,
      capabilities: { supports_session_resume: true },
    });

    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 2 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const sessionKeys = { sessionId: "sess-1", providerSessionId: "sess-1", sessionKeepAlive: true, sessionIdleTimeoutMs: 60_000 };
    await router.run("sys", { messages: [], ...sessionKeys });

    expect(executeMock.mock.calls[0][1]).toMatchObject(sessionKeys);
    for (const key of Object.keys(sessionKeys)) expect(executeMock.mock.calls[1][1]).not.toHaveProperty(key);
  });

  it("carries one merged resume snapshot across a same-model retry", async () => {
    executeMock
      .mockResolvedValueOnce({
        ...overloaded(),
        events: [
          { type: "assistant", message: { content: [{ type: "text", text: "first progress" }] } },
          { type: "final" },
        ],
      })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });

    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 2 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    await router.run("sys", { messages: [] });

    const retryPrompt = executeMock.mock.calls[1][0];
    expect(retryPrompt.match(/<resume_context>/gu)).toHaveLength(1);
    expect(retryPrompt).toContain("first progress");
  });

  it("advances immediately when the attempt resolver fails, without burning retries", async () => {
    const resolveAttempt = vi.fn(() => {
      throw new Error("credential mint failed");
    });
    const router = createRouterRuntime({
      chain: [{ model: OPUS, attempts: 3 }, { model: SONNET }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
      resolveAttempt,
    });
    executeMock.mockResolvedValue({ text: "ok", events: [], failureKind: null });
    await router.run("sys", { messages: [] });

    expect(resolveAttempt).toHaveBeenCalledTimes(2);
    expect(resolveAttempt.mock.calls.map((c) => c[0].attemptIndex)).toEqual([0, 1]);
  });

  it("rejects invalid attempts values", () => {
    for (const attempts of [0, 1.5, 99, "2"]) {
      expect(() => createRouterRuntime({ chain: [{ model: OPUS, attempts }] }))
        .toThrow(/attempts must be an integer between 1 and 10/u);
    }
  });
});


it.each(["cancelled", "provider_unavailable"])("strips recovery receipts on every non-primary terminal %s return", async (failureKind) => {
  const receipt = { runId: "run", revision: 1, providerSessionId: "id", modelKey: "anthropic:backup", tipId: "tip" };
  executeMock.mockResolvedValueOnce({ error: "temporary failure", failureKind: "provider_unavailable", events: [] });
  executeMock.mockResolvedValueOnce({ error: "backup failed", failureKind, cancelled: failureKind === "cancelled", providerSessionRecovery: receipt, events: [] });
  const router = createRouterRuntime({ chain: [modelRef("openai-codex", "primary"), modelRef("anthropic", "backup")] });
  const result = await router.run("sys", { messages: [], sessionRecovery: { runId: "run", revision: 1 }, sessionId: "id", sessionKeepAlive: true });
  expect(executeMock).toHaveBeenCalledTimes(2);
  expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionRecovery");
  expect(result.providerSessionRecovery).toBeUndefined();
});


it("attributes a primary user cancellation without changing its result or trying a fallback", async () => {
  const model = modelRef("openai-codex", "gpt-5.6-sol");
  const receipt = { runId: "run", revision: 1, providerSessionId: "id", modelKey: model.reference, tipId: "tip" };
  executeMock.mockResolvedValueOnce({ cancelled: true, failureKind: null, error: null, events: [], providerSessionRecovery: receipt });
  const events = [];
  const router = createRouterRuntime({ chain: [model, modelRef("anthropic", "backup")] });
  const result = await router.run("sys", { messages: [], sessionRecovery: { runId: "run", revision: 1 }, sessionId: "id", sessionKeepAlive: true, onEvent: (event) => events.push(event) });
  expect(result).toMatchObject({ cancelled: true, failureKind: null, providerSessionRecovery: receipt });
  expect(result.failoverHistory).toEqual([expect.objectContaining({ model, failureKind: "cancelled" })]);
  expect(executeMock).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type.startsWith("provider_failover") || event.type === "provider_retry_started")).toEqual([]);
});

it("rejects an attempt resolver overriding the protected native turn descriptor", async () => {
  const primary = modelRef("openai-codex", "primary");
  const descriptor = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "run", handleId: "owned", baseRevision: 0 };
  const router = createRouterRuntime({ chain: [primary], resolveAttempt: async () => ({ options: { sessionTurn: descriptor } }) });
  const result = await router.run("sys", { model: primary, messages: [], sessionTurn: descriptor });
  expect(result.error).toContain("cannot override sessionTurn"); expect(executeMock).not.toHaveBeenCalled();
});

it.each(["safety_journal_storage_failed", "safety_session_turn_contract"])("never retries or fails over a terminal native failure (%s)", async (failureKind) => {
  executeMock.mockResolvedValue({ error: "503 network timeout while persisting evidence", failureKind, events: [] });
  const primary = modelRef("openai-codex", "primary"); const router = createRouterRuntime({ chain: [{ model: primary, attempts: 3 }, modelRef("anthropic", "backup")] });
  const result = await router.run("sys", { model: primary, messages: [] });
  expect(result.failureKind).toBe(failureKind); expect(executeMock).toHaveBeenCalledTimes(1);
});

it.each(["retry", "backup"])("awaits protected detached-turn acknowledgement before %s and strips its authority", async (kind) => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup");
  const failure = { text: "Fictional partial.", error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false };
  executeMock.mockResolvedValueOnce(failure).mockResolvedValueOnce({ text: "Fictional stateless answer.", events: [] });
  let release, entered; const acknowledged = new Promise((resolve) => { release = resolve; }); const waiting = new Promise((resolve) => { entered = resolve; });
  const onSessionTurnDetached = vi.fn(async (attempt) => { expect(attempt.result).toMatchObject(failure); entered(); await acknowledged; });
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const router = createRouterRuntime({ chain: [{ model: primary, attempts: kind === "retry" ? 2 : 1 }, { model: backup }], retry: { backoffMs: 0, maxBackoffMs: 0 } });
  const run = router.run("Fictional system.", { messages: [], sessionId: "handle", sessionKeepAlive: true, sessionTurn, onSessionTurnDetached });
  await waiting; expect(executeMock).toHaveBeenCalledTimes(1); release(); expect((await run).text).toBe("Fictional stateless answer.");
  expect(onSessionTurnDetached).toHaveBeenCalledOnce(); expect(onSessionTurnDetached.mock.calls[0][0]).toMatchObject({ descriptor: sessionTurn, attemptIndex: 0, retryIndex: 0 });
  for (const [, options] of executeMock.mock.calls) expect(options.onSessionTurnDetached).toBeUndefined();
  expect(executeMock.mock.calls[1][1].sessionTurn).toBeUndefined(); expect(executeMock.mock.calls[1][1].sessionId).toBeUndefined();
});
it.each([false, true])("fails closed if the protected detached acknowledgement is unavailable or rejects (throws=%s)", async (throws) => {
  executeMock.mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false,
    providerSessionId: "handle", providerSessionRecovery: { runId: "turn", revision: 1, providerSessionId: "handle", modelKey: "openai-codex:primary", tipId: "tip" } });
  const router = createRouterRuntime({ chain: [modelRef("openai-codex", "primary"), modelRef("anthropic", "backup")] });
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const result = await router.run("sys", { messages: [], sessionId: "handle", sessionTurn,
    ...(throws ? { onSessionTurnDetached: async () => { throw new Error("Fictional host persistence failure."); } } : {}) });
  expect(result).toMatchObject({ failureKind: "safety_session_turn_reconciliation", retryable: false }); expect(executeMock).toHaveBeenCalledTimes(1);
  expect(result).not.toHaveProperty("providerSessionId"); expect(result).not.toHaveProperty("providerSessionRecovery");
});
it("rejects private provider injection of detached acknowledgement authority", async () => {
  const primary = modelRef("openai-codex", "primary"); const router = createRouterRuntime({ chain: [primary], resolveAttempt: async () => ({ options: { onSessionTurnDetached: async () => {} } }) });
  expect((await router.run("sys", { model: primary, messages: [] })).error).toContain("cannot override onSessionTurnDetached"); expect(executeMock).not.toHaveBeenCalled();
});

it("acknowledges an absent/skipped primary before a stateless backup can answer", async () => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup");
  executeMock.mockResolvedValueOnce({ text: "Fictional backup answer.", events: [] });
  const onSessionTurnDetached = vi.fn(async (attempt) => { expect(executeMock).not.toHaveBeenCalled(); expect(attempt.result.failureKind).toBe("skipped_capability_mismatch"); });
  const router = createRouterRuntime({ chain: [{ model: primary, requires: { supports_native_subagents: true } }, { model: backup }] });
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const result = await router.run("sys", { messages: [], sessionTurn, onSessionTurnDetached }); expect(result.text).toBe("Fictional backup answer."); expect(onSessionTurnDetached).toHaveBeenCalledOnce();
});

it("awaits detachment when an eligible injected primary itself returns capability mismatch", async () => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup"); let acknowledge;
  const barrier = new Promise((resolve) => { acknowledge = resolve; });
  const primaryRun = vi.fn(async () => ({ text: null, error: "Fictional capability mismatch", failureKind: "skipped_capability_mismatch", events: [] }));
  const backupRun = vi.fn(async () => ({ text: "Fictional backup answer", events: [] }));
  const onSessionTurnDetached = vi.fn(async (attempt) => { expect(attempt.result.failureKind).toBe("skipped_capability_mismatch"); await barrier; });
  const router = createRouterRuntime({ chain: [{ model: primary }, { model: backup }], resolveAttempt: ({ attemptIndex }) => ({ runtime: { run: attemptIndex === 0 ? primaryRun : backupRun, configureTools: vi.fn() } }) });
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0, reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const running = router.run("sys", { messages: [], sessionTurn, onSessionTurnDetached });
  await vi.waitFor(() => expect(onSessionTurnDetached).toHaveBeenCalledOnce()); expect(backupRun).not.toHaveBeenCalled(); acknowledge();
  expect((await running).text).toBe("Fictional backup answer"); expect(primaryRun).toHaveBeenCalledOnce(); expect(backupRun.mock.calls[0][1].sessionTurn).toBeUndefined(); expect(backupRun.mock.calls[0][1].onSessionTurnDetached).toBeUndefined();
});

it.each(["nativeSessionAuthority", "nativeSessionProjection"])("protects %s against private route resolution", async (key) => {
  const primary = modelRef("openai-codex", "primary");
  const supplied = { fixture: "host-owned" };
  const router = createRouterRuntime({ chain: [primary], resolveAttempt: async () => ({ options: { [key]: { fixture: "foreign" } } }) });
  const result = await router.run("Rules", { model: primary, messages: [], [key]: supplied });
  expect(result.error).toContain(`cannot override ${key}`); expect(executeMock).not.toHaveBeenCalled();
});

it.each(["primary retry", "backup", "skipped primary"])("strips inherited projection/authority on %s without dropping primary ownership", async (variant) => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup");
  if (variant !== "skipped primary") executeMock.mockResolvedValueOnce({ text: null, error: "temporary unavailable", failureKind: "provider_unavailable", events: [] });
  executeMock.mockResolvedValueOnce({ text: "fictional answer", events: [] });
  const router = createRouterRuntime({ chain: [{ model: primary, attempts: variant === "primary retry" ? 2 : 1,
    ...(variant === "skipped primary" ? { requires: { supports_native_subagents: true } } : {}) }, backup], retry: { backoffMs: 0, maxBackoffMs: 0 } });
  const nativeSessionAuthority = { fixture: "host-owned-authority" }, nativeSessionProjection = { fixture: "host-owned-projection" };
  await router.run("Rules", { model: primary, messages: [], sessionId: "primary-session", sessionKeepAlive: true, nativeSessionAuthority, nativeSessionProjection });
  if (variant !== "skipped primary") expect(executeMock.mock.calls[0][1]).toMatchObject({ nativeSessionAuthority, nativeSessionProjection });
  const detached = executeMock.mock.calls.at(-1)[1];
  expect(detached).not.toHaveProperty("nativeSessionAuthority"); expect(detached).not.toHaveProperty("nativeSessionProjection");
});

it("protects piSessionsRoot when native current-handle authority is supplied", async () => {
  const primary = modelRef("openai-codex", "primary"), router = createRouterRuntime({ chain: [primary],
    resolveAttempt: async () => ({ options: { piSessionsRoot: "/fictional/foreign-native" } }) });
  const result = await router.run("Rules", { model: primary, messages: [], nativeSessionAuthority: { fixture: "host-owned" }, piSessionsRoot: "/fictional/owned-native" });
  expect(result.error).toContain("cannot override piSessionsRoot"); expect(executeMock).not.toHaveBeenCalled();
});
it("preserves ordinary resolver native-root selection without native authority", async () => {
  const primary = modelRef("openai-codex", "primary"); executeMock.mockResolvedValueOnce({ text: "ordinary reply", events: [] });
  const router = createRouterRuntime({ chain: [primary], resolveAttempt: async () => ({ options: { piSessionsRoot: "/fictional/ordinary-native" } }) });
  expect((await router.run("Rules", { model: primary, messages: [] })).text).toBe("ordinary reply");
  expect(executeMock.mock.calls[0][1].piSessionsRoot).toBe("/fictional/ordinary-native");
});

it.each(["backup", "retry", "unsupported primary"])("permits a detached %s resolver to choose its own native root", async (variant) => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("openai-codex", "backup");
  if (variant === "unsupported primary") runtimeCapabilitiesMock.mockReturnValue({ supports_session_resume: false });
  else executeMock.mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", cancelled: false, events: [] });
  executeMock.mockResolvedValueOnce({ text: "detached root selected", events: [] });
  const chain = variant === "backup" ? [primary, backup] : [{ model: primary, attempts: variant === "retry" ? 2 : 1 }];
  const router = createRouterRuntime({ chain, retry: { backoffMs: 0, maxBackoffMs: 0 }, resolveAttempt: async ({ attemptIndex, retryIndex }) => ({
    options: attemptIndex > 0 || retryIndex > 0 || variant === "unsupported primary" ? { piSessionsRoot: "/fictional/detached-native" } : {} }) });
  const result = await router.run("Rules", { model: primary, messages: [], sessionId: "primary-session", sessionKeepAlive: true,
    nativeSessionAuthority: { fixture: "host-owned" }, nativeSessionProjection: { fixture: "host-owned" }, piSessionsRoot: "/fictional/owned-native" });
  expect(result.error).toBeFalsy(); expect(result.text).toBe("detached root selected");
  const detached = executeMock.mock.calls.at(-1)[1]; expect(detached.piSessionsRoot).toBe("/fictional/detached-native");
  expect(detached).not.toHaveProperty("nativeSessionAuthority"); expect(detached).not.toHaveProperty("nativeSessionProjection");
  expect(detached).not.toHaveProperty("sessionTurn"); expect(detached).not.toHaveProperty("providerSessionId");
});

describe("createRouterRuntime — detached identity scrub", () => {
  const primary = modelRef("openai-codex", "primary");
  const backup = modelRef("anthropic", "backup");
  const receipt = { runId: "run", revision: 1, providerSessionId: "coordinated-id", modelKey: backup.reference, tipId: "tip" };
  const sessionOptions = {
    messages: [], sessionId: "coordinated-id", providerSessionId: "coordinated-id",
    providerAttributionSessionId: "coordinated-id", sessionKeepAlive: true,
    sessionRecovery: { runId: "run", revision: 1 },
  };
  const backupFailures = {
    success: { text: "answer", error: null, failureKind: null },
    cancelled: { text: null, error: null, failureKind: null, cancelled: true },
    terminal: { text: null, error: "usage exceeded", failureKind: "usage_limit" },
    exhausted: { text: null, error: "Connection error.", failureKind: "provider_unavailable" },
  };

  it.each(Object.keys(backupFailures))("strips the session id and receipt from a backup %s return", async (path) => {
    executeMock.mockResolvedValueOnce({ error: "Connection error.", failureKind: "provider_unavailable", events: [] });
    executeMock.mockResolvedValueOnce({ ...backupFailures[path], events: [], providerSessionId: "coordinated-id", providerSessionRecovery: receipt });
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", { ...sessionOptions });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty("providerSessionId");
    expect(result).not.toHaveProperty("providerSessionRecovery");
    if (path === "exhausted") expect(result.failureKind).toBe("provider_unavailable_exhausted");
    if (path === "terminal") expect(result.failureKind).toBe("usage_limit");
    if (path === "cancelled") expect(result.cancelled).toBe(true);
  });

  it("strips the session id from a backup cancelled during its retry backoff", async () => {
    const controller = new AbortController();
    executeMock.mockResolvedValueOnce({ error: "Connection error.", failureKind: "provider_unavailable", events: [] });
    executeMock.mockImplementationOnce(async () => {
      controller.abort();
      return { error: "Connection error.", failureKind: "provider_unavailable", events: [], providerSessionId: "coordinated-id", providerSessionRecovery: receipt };
    });
    const router = createRouterRuntime({
      chain: [primary, { model: backup, attempts: 2 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { ...sessionOptions, abortSignal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result).not.toHaveProperty("providerSessionId");
    expect(result).not.toHaveProperty("providerSessionRecovery");
  });

  it("keeps the primary eligible attempt's identity and result id", async () => {
    executeMock.mockResolvedValueOnce({ error: "usage exceeded", failureKind: "usage_limit", events: [], providerSessionId: "coordinated-id", providerSessionRecovery: receipt });
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", { ...sessionOptions });
    expect(executeMock.mock.calls[0][1]).toMatchObject(sessionOptions);
    expect(result.providerSessionId).toBe("coordinated-id");
    expect(result.providerSessionRecovery).toEqual(receipt);
  });
});

describe("createRouterRuntime — tools are never re-run", () => {
  const primary = modelRef("anthropic", "claude-opus-4-7");
  const backup = modelRef("anthropic", "claude-sonnet-4-6");
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "echo hi" } }] } };
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "hi" }] } };
  const failure = (events) => ({ text: null, error: "Connection error.", failureKind: "provider_unavailable", cancelled: false, events });

  /** @param {Array<*>} events */
  function blockedWarnings(events) {
    return events.filter((event) => event.type === "runtime_warning" && event.warning_kind === "provider_failover_blocked");
  }

  it.each([
    ["tool_use", [toolUse]],
    ["tool_result", [toolResult]],
  ])("does not start a backup after %s evidence", async (_kind, attemptEvents) => {
    executeMock.mockResolvedValueOnce(failure(attemptEvents));
    executeMock.mockResolvedValueOnce({ text: "backup", events: [], failureKind: null });
    const events = [];
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", { messages: [], onEvent: (event) => events.push(event) });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.error).toBe("Connection error.");
    expect(result.failoverHistory).toEqual([expect.objectContaining({ model: primary, failureKind: "provider_unavailable" })]);
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({
      warning_kind: "provider_failover_blocked", reason: "tool_already_executed", model: primary.reference,
    })]);
    expect(blockedWarnings(events)).toEqual([expect.objectContaining({ reason: "tool_already_executed", message: expect.stringContaining("tool_already_executed") })]);
    expect(events.some((event) => event.type === "provider_failover_started")).toBe(false);
  });

  it("does not retry the same model after streamed tool evidence, even when the run throws", async () => {
    executeMock.mockImplementationOnce(async (_systemPrompt, options) => {
      options.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash" });
      throw new Error("Connection error.");
    });
    executeMock.mockResolvedValueOnce({ text: "retry", events: [], failureKind: null });
    const events = [];
    const router = createRouterRuntime({
      chain: [{ model: primary, attempts: 2 }, backup],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [], onEvent: (event) => events.push(event) });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({ reason: "tool_already_executed" })]);
    expect(events.some((event) => event.type === "provider_retry_started")).toBe(false);
    // The host still receives the inner runtime's own events.
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start" }));
  });

  it("does not start a backup after the primary consumed a live input", async () => {
    executeMock.mockImplementationOnce(async (_systemPrompt, options) => {
      const next = await options.liveInput[Symbol.asyncIterator]().next();
      next.value.acknowledge();
      return failure([]);
    });
    executeMock.mockResolvedValueOnce({ text: "backup", events: [], failureKind: null });
    const liveInput = (async function* () {
      yield { body: "one more thing", id: "follow-up-1", acknowledge: () => "recorded" };
    })();
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", { messages: [], liveInput });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({ reason: "live_input_consumed" })]);
  });

  /**
   * A route runtime that leases a live input, fails, and leaves the lease open
   * so the test can settle it after the attempt returned.
   */
  function leaseAndFail(held) {
    return async (_systemPrompt, options) => {
      const next = await options.liveInput[Symbol.asyncIterator]().next();
      held.message = next.value;
      return failure([]);
    };
  }

  function oneLiveInput() {
    return (async function* () {
      yield { body: "one more thing", id: "follow-up-1", acknowledge: () => "recorded" };
    })();
  }

  it("blocks a same-model retry when the failed attempt consumes a live input during backoff", async () => {
    const held = {};
    executeMock.mockImplementationOnce(leaseAndFail(held));
    executeMock.mockResolvedValueOnce({ text: "retry", events: [], failureKind: null });
    const events = [];
    const router = createRouterRuntime({
      chain: [{ model: primary, attempts: 2 }, backup],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", {
      messages: [], liveInput: oneLiveInput(),
      onEvent: (event) => {
        events.push(event);
        // Late settlement by the route runtime, after run() returned.
        if (event.type === "provider_retry_started") held.message.acknowledge();
      },
    });
    expect(events.some((event) => event.type === "provider_retry_started")).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({ model: primary.reference, reason: "live_input_consumed" })]);
    expect(blockedWarnings(events)).toHaveLength(1);
  });

  it("blocks a backup when the failed attempt consumes a live input while the resolver runs", async () => {
    const held = {};
    executeMock.mockImplementationOnce(leaseAndFail(held));
    executeMock.mockResolvedValueOnce({ text: "backup", events: [], failureKind: null });
    const cleanup = vi.fn();
    const resolveAttempt = vi.fn(async ({ attemptIndex }) => {
      if (attemptIndex === 1) held.message.acknowledge();
      return { cleanup };
    });
    const events = [];
    const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt });
    const result = await router.run("sys", { messages: [], liveInput: oneLiveInput(), onEvent: (event) => events.push(event) });
    expect(resolveAttempt).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(1);
    // The resolved-but-never-run backup still releases its resources.
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({ model: primary.reference, reason: "live_input_consumed" })]);
    expect(events.some((event) => event.type === "provider_failover_started")).toBe(false);
  });

  it("blocks a backup when the failed attempt streams tool evidence while the resolver runs", async () => {
    let lateOnEvent;
    executeMock.mockImplementationOnce(async (_systemPrompt, options) => {
      lateOnEvent = options.onEvent;
      return failure([]);
    });
    executeMock.mockResolvedValueOnce({ text: "backup", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [primary, backup],
      resolveAttempt: async ({ attemptIndex }) => {
        if (attemptIndex === 1) lateOnEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash" });
        return {};
      },
    });
    const result = await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({ reason: "tool_already_executed" })]);
  });

  it("still fails over when only earlier turns in the seeded history used tools", async () => {
    executeMock.mockResolvedValueOnce(failure([]));
    executeMock.mockResolvedValueOnce({ text: "backup", events: [], failureKind: null });
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", {
      messages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "Read", input: { file_path: "notes.txt" } }] },
        { role: "toolResult", toolCallId: "old-call", content: [{ type: "text", text: "old notes" }] },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "new question" },
      ],
    });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("backup");
    expect(result.runtimeWarnings).toBeUndefined();
  });

  it("still fails over a retryable failure that only streamed text", async () => {
    const text = { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
    executeMock.mockResolvedValueOnce(failure([text]));
    executeMock.mockResolvedValueOnce({ text: "backup", events: [], failureKind: null });
    const events = [];
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", { messages: [], onEvent: (event) => events.push(event) });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("backup");
    expect(result.runtimeWarnings).toBeUndefined();
    expect(blockedWarnings(events)).toEqual([]);
  });

  it("blocks a backup's own retry after the backup ran a tool", async () => {
    executeMock.mockResolvedValueOnce(failure([]));
    executeMock.mockResolvedValueOnce(failure([toolUse, toolResult]));
    executeMock.mockResolvedValueOnce({ text: "retry", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [primary, { model: backup, attempts: 2 }],
      retry: { backoffMs: 0, maxBackoffMs: 0 },
    });
    const result = await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.runtimeWarnings).toEqual([expect.objectContaining({ model: backup.reference, reason: "tool_already_executed" })]);
  });

  it("reports an ordinary exhausted chain when no further attempt could run", async () => {
    executeMock.mockResolvedValueOnce(failure([toolUse]));
    const router = createRouterRuntime({ chain: [primary] });
    const result = await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.runtimeWarnings).toBeUndefined();
  });
});

it("rechecks failed-attempt tool evidence after awaiting native detachment", async () => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup");
  let primaryOnEvent;
  const primaryRun = vi.fn(async (_prompt, options) => {
    primaryOnEvent = options.onEvent;
    return { error: "Connection error.", failureKind: "provider_unavailable", events: [] };
  });
  const backupRun = vi.fn(async () => ({ text: "Must not run", events: [] }));
  const cleanup = vi.fn(); const events = [];
  const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt: ({ attemptIndex }) =>
    ({ runtime: { run: attemptIndex === 0 ? primaryRun : backupRun, configureTools() {} }, ...(attemptIndex === 1 ? { cleanup } : {}) }) });
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const result = await router.run("Fictional system", { messages: [], sessionTurn, onEvent: (event) => events.push(event),
    onSessionTurnDetached: async () => { await Promise.resolve(); primaryOnEvent({ type: "tool_execution_start", toolName: "Read" }); } });
  expect(result.failureKind).toBe("provider_unavailable"); expect(backupRun).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
  expect(events).toContainEqual(expect.objectContaining({ type: "runtime_warning", warning_kind: "provider_failover_blocked" }));
});

describe("private detached host replay", () => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup");
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const failure = { error: "Connection error.", failureKind: "provider_unavailable", events: [], providerSessionId: "primary-id", providerSessionRecovery: { runId: "turn" } };
  const messages = [{ role: "user", content: "Fictional current input" }];

  it.each([false, true])("replaces the prior prefix once on warm/cold attempts (cold=%s)", async (cold) => {
    const replay = [{ role: "user", content: "Fictional earlier context" }];
    const detachedContext = vi.fn(async () => replay), ack = vi.fn(async () => {});
    executeMock.mockResolvedValueOnce(failure).mockResolvedValueOnce(failure).mockResolvedValueOnce({ text: "answer", events: [] });
    const router = createRouterRuntime({ chain: [primary, { model: backup, attempts: 2 }], retry: { backoffMs: 0, maxBackoffMs: 0 } });
    const result = await router.run("sys", { messages: [...(cold ? replay : []), ...messages], sessionTurn, onSessionTurnDetached: ack, detachedContext });
    expect(detachedContext).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledOnce();
    expect(ack.mock.invocationCallOrder[0]).toBeLessThan(detachedContext.mock.invocationCallOrder[0]);
    for (const [, options] of executeMock.mock.calls.slice(1)) {
      expect(options.messages).toEqual([...replay, ...messages]);
      expect(Object.isFrozen(options.messages[0])).toBe(true);
      expect(options).not.toHaveProperty("detachedContext");
    }
    expect(result).not.toHaveProperty("providerSessionId"); expect(result).not.toHaveProperty("providerSessionRecovery");
    expect(JSON.stringify(result)).not.toContain("Fictional earlier context");
    expect(executeMock.mock.calls[1][1].providerAttributionSessionId).not.toBe(executeMock.mock.calls[2][1].providerAttributionSessionId);
  });

  it.each(["success", "terminal", "exhausted", "tool", "ack fails", "resolver fails", "capabilities skip"])("never loads without an admitted next attempt: %s", async (kind) => {
    const detachedContext = vi.fn(async () => []);
    executeMock.mockResolvedValueOnce(kind === "success" ? { text: "answer", events: [] }
      : kind === "terminal" ? { error: "Denied", failureKind: "usage_limit", events: [] }
      : kind === "tool" ? { ...failure, events: [{ type: "tool_use", name: "Read" }] } : failure);
    const router = createRouterRuntime({ chain: kind === "exhausted" ? [primary] : kind === "capabilities skip" ? [primary, { model: backup, requires: { imaginary: true } }] : [primary, backup],
      ...(kind === "resolver fails" ? { resolveAttempt: ({ attemptIndex }) => { if (attemptIndex > 0) throw new Error("Fictional resolver failure"); } } : {}) });
    await router.run("sys", { messages, detachedContext, sessionTurn, onSessionTurnDetached: async () => { if (kind === "ack fails") throw new Error("Fictional ack failure"); } });
    expect(detachedContext).not.toHaveBeenCalled(); expect(executeMock).toHaveBeenCalledOnce();
  });

  it("fails closed without exposing loader error content", async () => {
    executeMock.mockResolvedValueOnce(failure);
    const events = [], ack = vi.fn(async () => {}), detachedContext = vi.fn(async () => { throw new Error("Fictional private loader detail"); });
    const router = createRouterRuntime({ chain: [primary, backup] });
    const result = await router.run("sys", { messages, sessionTurn, onEvent: (event) => events.push(event), onSessionTurnDetached: ack, detachedContext });
    expect(executeMock).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledOnce(); expect(detachedContext).toHaveBeenCalledOnce();
    expect(result.failureKind).toBe(failure.failureKind); expect(result.error).toBe(failure.error);
    expect(result).not.toHaveProperty("providerSessionId"); expect(result).not.toHaveProperty("providerSessionRecovery");
    expect(result.runtimeWarnings).toContainEqual(expect.objectContaining({ warning_kind: "detached_context_unavailable" }));
    expect(JSON.stringify([result, events])).not.toContain("Fictional private loader detail");
  });

  it("protects the loader from resolver injection", async () => {
    const injected = vi.fn(async () => []), hostLoader = vi.fn(async () => []);
    const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt: () => ({ options: { detachedContext: injected } }) });
    const result = await router.run("sys", { messages, detachedContext: hostLoader });
    expect(executeMock).not.toHaveBeenCalled(); expect(injected).not.toHaveBeenCalled(); expect(hostLoader).not.toHaveBeenCalled();
    expect(result.error).toContain("detachedContext");
  });

  it.each(["tool", "live input"])("scrubs a failure when %s settles during the detach ack", async (effect) => {
    let onEvent, consumer;
    const run = vi.fn(async (_prompt, options) => {
      onEvent = options.onEvent;
      if (options.liveInput) consumer = options.liveInput[Symbol.asyncIterator]();
      return failure;
    });
    const ack = vi.fn(async () => { await Promise.resolve(); if (effect === "tool") onEvent({ type: "tool_execution_start", toolName: "Read" }); else { const next = await consumer.next(); next.value.acknowledge(); } });
    const loader = vi.fn(async () => []), backupRun = vi.fn(), cleanup = vi.fn();
    const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt: ({ attemptIndex }) => ({ runtime: { run: attemptIndex === 0 ? run : backupRun, configureTools() {} }, cleanup }) });
    const result = await router.run("sys", { messages, sessionTurn, onSessionTurnDetached: ack, detachedContext: loader,
      ...(effect === "live input" ? { liveInput: { async *[Symbol.asyncIterator]() { yield { body: "Fictional steer", acknowledge: () => "recorded" }; } } } : {}) });
    expect(ack).toHaveBeenCalledOnce(); expect(loader).not.toHaveBeenCalled(); expect(backupRun).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("providerSessionId"); expect(result).not.toHaveProperty("providerSessionRecovery");
    expect(result.runtimeWarnings[0].reason).toBe(effect === "tool" ? "tool_already_executed" : "live_input_consumed");
  });

  it("blocks a protected primary at the side-effect gate without ack", async () => {
    executeMock.mockResolvedValueOnce({ ...failure, events: [{ type: "tool_use", name: "Read" }] });
    const ack = vi.fn(), loader = vi.fn();
    const result = await createRouterRuntime({ chain: [primary, backup] }).run("sys", { messages, sessionTurn, onSessionTurnDetached: ack, detachedContext: loader });
    expect(executeMock).toHaveBeenCalledOnce(); expect(ack).not.toHaveBeenCalled(); expect(loader).not.toHaveBeenCalled();
    expect(result.providerSessionId).toBe("primary-id"); expect(result.providerSessionRecovery).toEqual(failure.providerSessionRecovery);
  });

  it.each(["tool_use", "tool_result"])("gates a capability mismatch after %s", async (type) => {
    executeMock.mockResolvedValueOnce({ ...failure, failureKind: "skipped_capability_mismatch", events: [{ type, name: "Read" }] });
    const ack = vi.fn();
    const result = await createRouterRuntime({ chain: [primary, backup] }).run("sys", { messages, sessionTurn, onSessionTurnDetached: ack });
    expect(executeMock).toHaveBeenCalledOnce(); expect(ack).not.toHaveBeenCalled();
    expect(result.failureKind).toBe("skipped_capability_mismatch"); expect(result.runtimeWarnings[0].reason).toBe("tool_already_executed");
  });

  it("fences side effects that settle while the loader awaits", async () => {
    let onEvent;
    const run = vi.fn(async (_prompt, options) => { onEvent = options.onEvent; return failure; });
    const backupRun = vi.fn(), ack = vi.fn(async () => {});
    const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt: ({ attemptIndex }) => ({ runtime: { run: attemptIndex ? backupRun : run, configureTools() {} } }) });
    const result = await router.run("sys", { messages, sessionTurn, onSessionTurnDetached: ack, detachedContext: async () => { await Promise.resolve(); onEvent({ type: "tool_execution_start", toolName: "Read" }); return []; } });
    expect(backupRun).not.toHaveBeenCalled(); expect(result).not.toHaveProperty("providerSessionId"); expect(result.runtimeWarnings[0].reason).toBe("tool_already_executed");
  });
});

it.each(["before primary", "resolver", "ack", "loader"])("never loads or dispatches after cancellation at %s", async (phase) => {
  const primary = modelRef("openai-codex", "primary"), backup = modelRef("anthropic", "backup"), controller = new AbortController();
  const failure = { error: "Connection error.", failureKind: "provider_unavailable", events: [], providerSessionId: "primary-id", providerSessionRecovery: { runId: "turn" } };
  const backupRun = vi.fn(async () => ({ text: "Must not run", events: [] })), cleanup = vi.fn();
  const loader = vi.fn(async () => { if (phase === "loader") controller.abort(); return [{ role: "user", content: "Fictional earlier context" }]; });
  const ack = vi.fn(async () => { if (phase === "ack") controller.abort(); });
  const sessionTurn = { kind: "host", ownerKey: "owner", historyBucket: "bucket", turnId: "turn", handleId: "handle", baseRevision: 0,
    reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "input" } };
  const primaryRun = vi.fn(async () => failure);
  const router = createRouterRuntime({ chain: [primary, backup], resolveAttempt: ({ attemptIndex }) => {
    if (phase === "resolver" && attemptIndex === 1) controller.abort();
    return { runtime: { configureTools() {}, run: attemptIndex ? backupRun : primaryRun }, cleanup };
  } });
  if (phase === "before primary") controller.abort();
  const result = await router.run("sys", { messages: [{ role: "user", content: "Fictional current input" }], abortSignal: controller.signal, sessionTurn, onSessionTurnDetached: ack, detachedContext: loader });
  expect(result.cancelled).toBe(true); expect(backupRun).not.toHaveBeenCalled();
  expect(loader).toHaveBeenCalledTimes(phase === "loader" ? 1 : 0);
  expect(ack).toHaveBeenCalledTimes(phase === "ack" || phase === "loader" ? 1 : 0);
  expect(cleanup).toHaveBeenCalledTimes(phase === "before primary" ? 1 : 2);
  if (phase === "ack" || phase === "loader") { expect(result).not.toHaveProperty("providerSessionId"); expect(result).not.toHaveProperty("providerSessionRecovery"); }
});
