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
const { resetToolRuntime } = await import("../../agent/tools/shared/runtime-context.js");

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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [], onEvent: (e) => events.push(e) });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].model.model).toBe("claude-opus-4-7");
    expect(executeMock).toHaveBeenCalledTimes(2);
    const failoverEvents = events.filter((e) => e.type?.startsWith("provider_failover"));
    expect(failoverEvents.map((e) => e.type)).toEqual([
      "provider_failover_started",
      "provider_failover_completed",
    ]);
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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory).toHaveLength(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back on non-retryable failures (e.g. invalid api key)", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "401 invalid api key — authentication failed",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failureKind).toBe("provider_auth");
    expect(result.failoverHistory[0].failureKind).toBe("provider_auth");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("preserves provider_auth terminal failures instead of reporting failover exhaustion", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "No API key for provider: openai-codex",
      failureKind: "provider_auth",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", model: "openai-codex:gpt-5.5" },
        { sdk: "pi", model: "opencode-go:kimi-k2.6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failureKind).toBe("provider_auth");
    expect(result.failoverHistory).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    await router.run("Original system prompt", { messages: [] });
    expect(callPrompts).toHaveLength(2);
    expect(callPrompts[0]).toBe("Original system prompt");
    expect(callPrompts[1]).toContain("<resume_context>");
    expect(callPrompts[1]).toContain("first attempt");
    expect(callPrompts[1]).toContain("Original system prompt");
  });
});

describe("createRouterRuntime — capability filtering", () => {
  it("skips chain entries that don't satisfy `requires`", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { model: { sdk: "claude", model: "x" }, requires: { kind: "does-not-exist" } },
        { sdk: "pi", model: "openai-gpt-4" },
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
        { model: { sdk: "claude", model: "x" }, requires: { kind: "does-not-exist" } },
        { model: { sdk: "pi", model: "openai-gpt-4" }, requires: { kind: "also-missing" } },
      ],
    });
    const result = await router.run("sys", { messages: [] });

    expect(executeMock).not.toHaveBeenCalled();
    expect(result.failureKind).toBe("skipped_capability_mismatch");
    expect(result.failoverHistory).toHaveLength(2);
  });

  it("skips a pi fallback when native-subagent teammates are required (F1)", async () => {
    // Claude primary (supports_native_subagents:true) is handed native teammates,
    // fails retryably; the pi fallback (supports_native_subagents:false) must be
    // SKIPPED rather than silently succeeding with the teammates dropped — the run
    // is then exhausted, surfacing the correct signal instead of false success.
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "Anthropic API overloaded — try again later",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "pi", model: "openai-gpt-4" },
      ],
    });
    const result = await router.run("sys", {
      messages: [],
      nativeSubagents: { provider: "claude", teammates: [{ name: "researcher" }] },
    });
    // Claude attempted once (and failed retryably); pi never attempted.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    const piSkip = result.failoverHistory.find(
      (h) => h.model?.sdk === "pi" && h.failureKind === "skipped_capability_mismatch",
    );
    expect(piSkip).toBeDefined();
  });

  it("still attempts a pi fallback when no native subagents are requested (F1 negative)", async () => {
    // Guards against over-restricting normal fallback: with no teammates, the pi
    // entry is NOT capability-filtered and the fallback succeeds.
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
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "pi", model: "openai-gpt-4" },
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
      chain: [{ sdk: "claude", model: "x" }],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    const call = executeMock.mock.calls[0][1];
    expect(call.model).toEqual({ sdk: "claude", model: "x" });
  });
});
