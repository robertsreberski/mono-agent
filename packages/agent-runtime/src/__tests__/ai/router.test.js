import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();

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
const { resetToolRuntime } = await import("../../agent/tools/shared/runtime-context.js");
const { createFakeSandbox } = await import("../helpers/fake-sandbox.js");

function modelRef(provider, model) {
  return { provider, model, reference: `${provider}:${model}` };
}

beforeEach(() => {
  executeMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
  resetToolRuntime();
});

afterEach(() => {
  resetToolRuntime();
});

describe("createRouterRuntime — basic", () => {
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
    const acknowledge = vi.fn();
    const events = [];
    executeMock
      .mockImplementationOnce(async (_systemPrompt, options) => {
        const next = await options.liveInput[Symbol.asyncIterator]().next();
        next.value.acknowledge();
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
    expect(acknowledge).toHaveBeenCalledTimes(2);
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

  it("strips session state from every entry in a multi-provider Pi chain", async () => {
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

    const result = await router.run("sys", {
      messages: [],
      sessionId: "host-session",
      providerSessionId: "pi-provider-session",
      sessionKeepAlive: true,
      sessionIdleTimeoutMs: 60_000,
    });

    expect(result.text).toBe("recovered");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionId");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionIdleTimeoutMs");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionIdleTimeoutMs");
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

  it("makes the entire fallback chain stateless even when both routes support resume", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        modelRef("openai-codex", "primary"),
        modelRef("anthropic", "fallback"),
      ],
    });

    await router.run("sys", {
      messages: [],
      sessionId: "host-session",
      providerSessionId: "provider-session",
      sessionKeepAlive: true,
      sessionIdleTimeoutMs: 60_000,
    });

    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionKeepAlive");
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
          ? { allowedTools: ["*"], disallowedTools: [], permissionMode: "plan" }
          : { allowedTools: ["Read", "Agent"], disallowedTools: ["Write"], permissionMode: undefined },
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
      permissionMode: "plan",
    });
    expect(executeMock.mock.calls[1][1]).toMatchObject({
      allowedTools: ["Read", "Agent"],
      disallowedTools: ["Write"],
    });
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("permissionMode");
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
    await router.run("sys", { messages: [], sessionId: "sess-1" });

    expect(executeMock.mock.calls[0][1].sessionId).toBe("sess-1");
    expect(executeMock.mock.calls[1][1].sessionId).toBeUndefined();
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
