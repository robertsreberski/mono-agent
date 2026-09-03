import { describe, expect, it, vi } from "vitest";

import { MAX_MODEL_REFERENCE_BYTES } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";

import {
  createPiOAuthApiKeyResolver,
  createMonoRuntime,
  describeMonoRuntimeSupport,
  listMonoRuntimeBackends,
  monoRuntimeSupportsLiveInput,
  monoRuntimeSupportsMcpApps,
  monoRuntimeSupportsSessionResume,
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
  runtimeBackendForModel,
  RuntimeAdapterError,
  sanitizeModelReferenceText,
} from "../index.js";

describe("runtime adapter model references", () => {
  it("canonicalizes the legacy pi wrapper", () => {
    expect(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5")).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
      reference: "openai-codex:gpt-5.5",
    });
  });

  it("rejects raw or legacy-invalid model references with a stable error", () => {
    expect(() => parseMonoRuntimeModelReference("haiku")).toThrow(RuntimeAdapterError);
    try {
      parseMonoRuntimeModelReference("haiku");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_model_reference" });
    }
  });

  it("preserves the parser's concrete replacement in error details", () => {
    try {
      parseMonoRuntimeModelReference("codex:gpt-5.6-sol");
      throw new Error("Expected the removed runtime reference to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_model_reference",
        details: { reason: expect.stringContaining("openai-codex:gpt-5.6-sol") },
      });
    }
  });

  // Every operator surface (doctor, `mono-agent validate`, `config --json`, cron/webhook
  // override issues) renders `error.message` and nothing else. A replacement that lives
  // only in `details` is a replacement nobody is ever shown, so the message itself must
  // name it for each retired runtime backend.
  it.each([
    ["codex:gpt-5.6-sol", "openai-codex:gpt-5.6-sol"],
    ["claude:claude-sonnet-4-6", "anthropic:claude-sonnet-4-6"],
    ["claude-code:claude-sonnet-4-6", "anthropic:claude-sonnet-4-6"],
    ["codex-cli:gpt-5.6-sol", "openai-codex:gpt-5.6-sol"],
    ["vercel:openai:gpt-5.5", "openai:gpt-5.5"],
    ["opencode:openai:gpt-5.5", "openai:gpt-5.5"],
  ])("names the replacement for %s in the message operators see", (reference, replacement) => {
    try {
      parseMonoRuntimeModelReference(reference);
      throw new Error(`Expected ${reference} to be rejected.`);
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeAdapterError);
      expect((error as RuntimeAdapterError).message).toContain(replacement);
    }
  });

  it("names the surviving ACP bridge in the message for an acp: reference", () => {
    try {
      parseMonoRuntimeModelReference("acp:some-agent");
      throw new Error("Expected acp:some-agent to be rejected.");
    } catch (error) {
      expect((error as RuntimeAdapterError).message).toContain("mono-agent bridge acp");
    }
  });

  it("names the tier-alias repair in the message, not only in details", () => {
    try {
      parseMonoRuntimeModelReference("anthropic:opus");
      throw new Error("Expected a tier alias to be rejected.");
    } catch (error) {
      expect((error as RuntimeAdapterError).message).toContain("tier aliases are not valid model ids");
    }
  });

  it("exposes one frozen Pi backend descriptor", () => {
    const model = parseMonoRuntimeModelReference("github-copilot:gpt-4.1");
    const backends = listMonoRuntimeBackends();

    expect(backends).toHaveLength(1);
    const backend = backends[0];
    if (backend === undefined) {
      throw new Error("Expected the sole Pi runtime backend.");
    }
    expect(backend).toMatchObject({
      id: "pi-sdk",
      runtimeBridgeId: "pi",
      sdk: "pi",
      transport: "sdk",
      acceptsProviderIds: true,
      capabilities: expect.objectContaining({
        kind: "pi",
        supports_session_resume: true,
        supports_live_input: true,
        supports_mcp_apps: true,
        tool_policy: "projected",
      }),
    });
    expect(runtimeBackendForModel(model)).toBe(backend);
    expect(Object.isFrozen(backends)).toBe(true);
    expect(Object.isFrozen(backend)).toBe(true);
    expect(Object.isFrozen(backend.capabilities)).toBe(true);
  });

  it("describes every parsed model through the sole Pi backend", () => {
    const model = parseMonoRuntimeModelReference("ollama:qwen3:8b");
    expect(describeMonoRuntimeSupport(model)).toEqual({
      model,
      compatible: true,
      backend: runtimeBackendForModel(model),
    });
  });
});

describe("runtime adapter Pi exports and capabilities", () => {
  it("re-exports the Pi OAuth API key resolver factory", () => {
    expect(typeof createPiOAuthApiKeyResolver).toBe("function");
  });

  it("reads constant capabilities from the sole backend", () => {
    expect(monoRuntimeSupportsMcpApps()).toBe(true);
    expect(monoRuntimeSupportsLiveInput()).toBe(true);
    expect(monoRuntimeSupportsSessionResume()).toBe(true);
  });

  it("exposes session lifecycle on the mono runtime", async () => {
    const runtime = createMonoRuntime();
    expect(typeof runtime.syncSession).toBe("function");
    expect(typeof runtime.refreshSession).toBe("function");
    expect(typeof runtime.retireDurableSession).toBe("function");
    expect(typeof runtime.disposeSession).toBe("function");
    expect(typeof runtime.invalidateSession).toBe("function");
    expect(typeof runtime.disposeAllSessions).toBe("function");
    await expect(runtime.syncSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.refreshSession?.("no-such-session")).resolves.toBeUndefined();
    await expect(runtime.retireDurableSession?.("no-such-session", "/tmp/mono-agent-no-sessions")).resolves.toBeUndefined();
    await expect(runtime.disposeSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.invalidateSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
  });
});

describe("runtime adapter fallback chain", () => {
  it("builds a Pi router that still exposes session lifecycle", async () => {
    const runtime = createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5") },
        { model: parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6") },
      ],
    });
    expect(typeof runtime.run).toBe("function");
    expect(typeof runtime.configureTools).toBe("function");
    await expect(runtime.syncSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.refreshSession?.("no-such-session")).resolves.toBeUndefined();
    await expect(runtime.retireDurableSession?.("no-such-session", "/tmp/mono-agent-no-sessions-router")).resolves.toBeUndefined();
    await expect(runtime.disposeSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.invalidateSession?.("no-such-session")).resolves.toBeFalsy();
    await expect(runtime.disposeAllSessions?.()).resolves.toBeUndefined();
  });

  it("rejects an empty fallback chain", () => {
    expect(() => createMonoRuntime({ fallbackChain: [] })).toThrow(RuntimeAdapterError);
  });

  it("forwards the actual attempted model and exact effort tri-state", async () => {
    const attempts: Array<{ model: string; effort: unknown }> = [];
    const configureTools = vi.fn();
    const fakeRuntime = {
      configureTools,
      async run(_systemPrompt: string, options: { model: { model: string }; effort?: string }) {
        attempts.push({
          model: options.model.model,
          effort: Object.hasOwn(options, "effort") ? options.effort : "provider-default",
        });
        return { text: "ok", events: [], cancelled: false, usage: {} };
      },
    };
    const model = parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6");
    const runtime = createMonoRuntime({
      fallbackChain: [{ model, effort: null }],
      resolveAttempt: (context) => {
        expect(context).toEqual({
          attemptIndex: 0,
          retryIndex: 0,
          model,
        });
        return { runtime: fakeRuntime as never, options: { privateSentinel: "not-telemetry" } };
      },
    });

    const result = await runtime.run("SYSTEM", {
      model: parseMonoRuntimeModelReference("openai-codex:ignored-by-chain"),
      effort: "high",
      messages: [{ role: "user", content: "hi" }],
      abortSignal: new AbortController().signal,
    });

    expect(configureTools).toHaveBeenCalledOnce();
    expect(attempts).toEqual([{
      model: "claude-sonnet-4-6",
      effort: "provider-default",
    }]);
    expect(JSON.stringify(result)).not.toContain("privateSentinel");
  });

  it("rejects malformed effort values", () => {
    expect(() => createMonoRuntime({
      fallbackChain: [{
        model: parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6"),
        effort: " high",
      }],
    })).toThrow(RuntimeAdapterError);
  });

  it("rejects chain entries with unparsed model references", () => {
    expect(() =>
      createMonoRuntime({
        fallbackChain: [{ model: { provider: "", model: "", reference: "" } }],
      }),
    ).toThrow(RuntimeAdapterError);
  });

  it("rejects non-object chain entries with a typed error", () => {
    for (const entry of [null, undefined, "anthropic:claude-sonnet-4-6", ["anthropic"]]) {
      expect(() =>
        createMonoRuntime({
          fallbackChain: [entry as never],
        }),
      ).toThrow(RuntimeAdapterError);
    }
  });

  it("rejects duplicate routes authored with mixed pi-wrapper spellings", () => {
    expect(() => createMonoRuntime({
      fallbackChain: [
        { model: parseMonoRuntimeModelReference("pi:anthropic:claude-sonnet-4-6") },
        { model: parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6") },
      ],
    })).toThrow(/duplicate model anthropic:claude-sonnet-4-6/u);
  });
});

describe("runtime adapter local providers", () => {
  it("maps Ollama provider config to agent-runtime custom Pi options", () => {
    const options = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("ollama:qwen3:8b"),
      [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: true,
          models: [
            {
              name: "qwen3:8b",
              capabilities: { context_window: 32768 },
            },
          ],
        },
      ],
    );

    expect(options.customProvider).toMatchObject({
      id: "ollama",
      provider_type: "ollama",
      base_url: "http://localhost:11434",
      enabled: true,
    });
    expect(options.customModel).toMatchObject({
      model_name: "qwen3:8b",
      display_name: "qwen3:8b",
      enabled: true,
      pricing: {},
    });
    expect(options.modelCapabilities).toMatchObject({
      context_window: 32768,
      json_mode: true,
      reasoning: true,
      reasoning_mode: "toggle",
    });
    expect(options.isPrivateProvider).toBe(true);
  });

  it("preserves disabled local providers so agent-runtime can fail honestly", () => {
    const options = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("ollama:llama3"),
      [
        {
          id: "ollama",
          type: "ollama",
          baseUrl: "http://localhost:11434",
          enabled: false,
        },
      ],
    );

    expect(options.customProvider).toMatchObject({
      id: "ollama",
      provider_type: "ollama",
      enabled: false,
    });
  });

  it("does nothing for providers that are not configured locally", () => {
    const localProviders = [
      {
        id: "ollama",
        type: "ollama" as const,
        baseUrl: "http://localhost:11434",
        enabled: true,
      },
    ];

    expect(runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("openai-codex:gpt-5.5"),
      localProviders,
    )).toEqual({});
    expect(runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6"),
      localProviders,
    )).toEqual({});
  });

  it("rejects untrusted public HTTP local-provider URLs", () => {
    expect(() => runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("gateway:gpt-oss"),
      [
        {
          id: "gateway",
          type: "openai_compat",
          baseUrl: "http://api.example.com",
          enabled: true,
        },
      ],
    )).toThrow(RuntimeAdapterError);
  });

  it("maps LM Studio and trusted OpenAI-compatible providers through the same custom-provider contract", () => {
    const lmStudio = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("lmstudio:local-model"),
      [
        {
          id: "lmstudio",
          type: "lmstudio",
          baseUrl: "http://localhost:1234",
          enabled: true,
        },
      ],
    );
    expect(lmStudio.customProvider).toMatchObject({
      id: "lmstudio",
      provider_type: "lmstudio",
      base_url: "http://localhost:1234",
    });
    expect(lmStudio.isPrivateProvider).toBe(true);

    const gateway = runtimeOptionsForLocalProvider(
      parseMonoRuntimeModelReference("local-gateway:gpt-oss"),
      [
        {
          id: "local-gateway",
          type: "openai_compat",
          baseUrl: "https://api.example.com/openai",
          trustPublicUrl: true,
          enabled: true,
          apiKey: "fixture-key-from-env",
        },
      ],
    );
    expect(gateway.customProvider).toMatchObject({
      id: "local-gateway",
      provider_type: "openai_compat",
      base_url: "https://api.example.com/openai",
      api_key: "fixture-key-from-env",
    });
    expect(gateway.isPrivateProvider).toBe(false);
  });
});

describe("createMonoRuntime same-model retry options", () => {
  const model = { provider: "anthropic", model: "claude-sonnet-4-6", reference: "anthropic:claude-sonnet-4-6" } as const;

  it.each([0, 11, 1.5, "2" as unknown as number])("rejects a fallback attempts value of %s", (attempts) => {
    expect(() => createMonoRuntime({ fallbackChain: [{ model, attempts }] }))
      .toThrow(/attempts must be an integer between 1 and 10/u);
  });

  it("accepts an omitted or in-range attempts value", () => {
    expect(() => createMonoRuntime({ fallbackChain: [{ model }] })).not.toThrow();
    expect(() => createMonoRuntime({ fallbackChain: [{ model, attempts: 3 }] })).not.toThrow();
  });

  it.each([
    ["backoffMs", -1],
    ["maxBackoffMs", Number.POSITIVE_INFINITY],
  ])("rejects a non-negative-finite retry %s", (key, value) => {
    expect(() => createMonoRuntime({
      fallbackChain: [{ model }],
      retry: { [key]: value } as Record<string, number>,
    })).toThrow(/must be a non-negative finite number/u);
  });
});

/**
 * A model reference is operator-supplied, unbounded and uninspected, and every diagnostic that
 * quotes one lands somewhere durable and operator-shared: the terminal, `doctor`, the daemon
 * log, launchd's captured stdout. So the parser's derived reason -- which interpolates the
 * operator's own model id into the repair -- is bounded and de-controlled where it is derived,
 * once, rather than at each of the five surfaces that render it.
 */
describe("sanitizeModelReferenceText", () => {
  const utf8 = (value: string): number => new TextEncoder().encode(value).length;

  it("escapes newlines so a value cannot forge an extra diagnostic line", () => {
    const forged = sanitizeModelReferenceText("codex:gpt\n[ok]    Core config", MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(forged).toBe("codex:gpt\\n[ok]    Core config");
    expect(forged).not.toContain("\n");
  });

  it.each([
    ["carriage return", "a\rb", "a\\rb"],
    ["tab", "a\tb", "a\\tb"],
    ["NUL", "a\u0000b", "a\\u0000b"],
    ["line separator", "a\u2028b", "a\\u2028b"],
    ["paragraph separator", "a\u2029b", "a\\u2029b"],
    ["right-to-left override", "a\u202Eb", "a\\u202Eb"],
    ["zero-width space", "a\u200Bb", "a\\u200Bb"],
  ])("escapes a %s", (_label, raw, expected) => {
    expect(sanitizeModelReferenceText(raw, MODEL_REFERENCE_ECHO_MAX_BYTES)).toBe(expected);
  });

  it("clamps to the byte budget and marks the cut", () => {
    const clamped = sanitizeModelReferenceText("x".repeat(500), MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(utf8(clamped)).toBeLessThanOrEqual(MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("bounds by bytes, not characters, and never splits a code point", () => {
    const clamped = sanitizeModelReferenceText("🧠".repeat(200), MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(utf8(clamped)).toBeLessThanOrEqual(MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(clamped).not.toContain("\uFFFD");
    expect([...clamped].every((character) => character === "🧠" || character === "…")).toBe(true);
  });

  it("counts the escaped form against the budget, so escaping cannot blow the bound", () => {
    const clamped = sanitizeModelReferenceText("\n".repeat(200), MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(utf8(clamped)).toBeLessThanOrEqual(MODEL_REFERENCE_ECHO_MAX_BYTES);
    // Clamping first would satisfy the byte bound and still emit raw newlines, so the order
    // -- escape, then clamp -- is what is asserted here, not only the resulting length.
    expect(clamped).not.toContain("\n");
    expect(clamped.startsWith("\\n\\n")).toBe(true);
  });

  it("leaves every legitimate reference in Pi's built-in catalog untouched", () => {
    const longest = "cloudflare-ai-gateway:workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct";
    expect(utf8(longest)).toBe(77);
    expect(sanitizeModelReferenceText(longest, MODEL_REFERENCE_ECHO_MAX_BYTES)).toBe(longest);
  });

  it("is idempotent, so re-bounding an already bounded reason is a no-op", () => {
    const once = sanitizeModelReferenceText("a\nb".repeat(80), MODEL_REFERENCE_REASON_MAX_BYTES);
    expect(sanitizeModelReferenceText(once, MODEL_REFERENCE_REASON_MAX_BYTES)).toBe(once);
  });

  it("honours a budget too small to hold the truncation marker", () => {
    // The marker is 3 bytes. Emitting it unconditionally would overrun exactly the bound the
    // function exists to enforce, so it is dropped rather than the bound.
    for (const maxBytes of [1, 2, 3]) {
      for (const value of ["x".repeat(40), "🧠".repeat(40), "\n".repeat(40)]) {
        expect(utf8(sanitizeModelReferenceText(value, maxBytes))).toBeLessThanOrEqual(maxBytes);
      }
    }
  });

  it("rejects a non-positive-integer budget rather than silently disabling the bound", () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => sanitizeModelReferenceText("codex:gpt", maxBytes)).toThrow(RangeError);
    }
  });
});

describe("parseMonoRuntimeModelReference bounds the reason it derives", () => {
  it("keeps the whole repair for every retired form", () => {
    // The reason budget exists to bound the operator's value, never to clamp the repair --
    // the ACP one is the longest fixed sentence the kernel parser emits.
    expect(() => parseMonoRuntimeModelReference("acp:some-agent")).toThrow(/mono-agent bridge acp to serve mono-agent over ACP/u);
    expect(() => parseMonoRuntimeModelReference("codex:gpt-5.6-sol")).toThrow(/use openai-codex:gpt-5\.6-sol/u);
  });

  it("bounds a reason built from an oversized model id", () => {
    let thrown: unknown;
    try {
      parseMonoRuntimeModelReference(`codex:${"sk-live-AAAA".repeat(60)}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeAdapterError);
    const { message, details } = thrown as RuntimeAdapterError;
    expect(new TextEncoder().encode(details.reason as string).length)
      .toBeLessThanOrEqual(MODEL_REFERENCE_REASON_MAX_BYTES);
    expect(message).toContain("use openai-codex:sk-live-AAAA");
    expect(message.endsWith("…")).toBe(true);
  });

  it("escapes a newline the kernel parser interpolated into the repair", () => {
    let thrown: unknown;
    try {
      parseMonoRuntimeModelReference("codex:gpt\n[ok]    Core config");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeAdapterError);
    expect((thrown as RuntimeAdapterError).message).not.toContain("\n");
    expect((thrown as RuntimeAdapterError).details.reason).toBe(
      "codex is no longer a runtime backend; use openai-codex:gpt\\n[ok]    Core config",
    );
  });
});

/**
 * The rendering bound and the parse bound are two halves of one guarantee, and neither is worth
 * much without the other: the parser refuses what a renderer could not quote whole, and the
 * renderer clamps what the parser refused. What follows asserts the seam between them -- that
 * they are the same bound, drawn at the same set of code points -- rather than either half on
 * its own.
 */
describe("the parse ceiling and the diagnostic echo budget are one bound", () => {
  const utf8 = (value: string): number => new TextEncoder().encode(value).length;

  it("is literally the same constant on both sides, so the two cannot drift apart", () => {
    expect(MODEL_REFERENCE_ECHO_MAX_BYTES).toBe(MAX_MODEL_REFERENCE_BYTES);
  });

  it.each([
    ["a newline", "openai:foo\nbar"],
    ["400 bytes", `openai:${"a".repeat(400)}`],
  ])("no longer hands a reference carrying %s to a renderer as an accepted value", (_label, value) => {
    let thrown: unknown;
    try {
      parseMonoRuntimeModelReference(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeAdapterError);
    const error = thrown as RuntimeAdapterError;
    expect(error.code).toBe("invalid_model_reference");
    expect(error.message).not.toContain("\n");
    expect(utf8(error.message)).toBeLessThanOrEqual(
      "Invalid runtime model reference: ".length + MODEL_REFERENCE_REASON_MAX_BYTES,
    );
  });

  it("echoes a reference it accepted whole, never clamped", () => {
    // The equality of the two constants only pays off if it holds at the boundary: a
    // reference sitting exactly on the parse ceiling must still survive the echo untouched.
    const filler = "a".repeat(MODEL_REFERENCE_ECHO_MAX_BYTES - "openai:".length);
    const accepted = parseMonoRuntimeModelReference(`openai:${filler}`);
    expect(utf8(accepted.reference)).toBe(MODEL_REFERENCE_ECHO_MAX_BYTES);
    expect(sanitizeModelReferenceText(accepted.reference, MODEL_REFERENCE_ECHO_MAX_BYTES))
      .toBe(accepted.reference);
  });

  it("never accepts a reference the echo would then have to clamp", () => {
    // The whole invariant in one line: for any candidate, either the parser refuses it or the
    // renderer hands it back untouched. Stated this way it also pins the *unit* -- a ceiling
    // measured in UTF-16 code units rather than UTF-8 bytes still looks like a bound and still
    // passes an ASCII boundary case, but lets these multibyte references through to be
    // clamped, which is the exact half-fix this seam exists to prevent.
    const candidates = [
      `openai:${"a".repeat(MODEL_REFERENCE_ECHO_MAX_BYTES - "openai:".length)}`,
      "cloudflare-ai-gateway:workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct",
      `openai:${"\u{1F9E0}".repeat(40)}`,
      `openai:${"é".repeat(60)}`,
      `openai:${"中".repeat(50)}`,
    ];
    const violations = candidates.filter((candidate) => {
      let reference: string;
      try {
        reference = parseMonoRuntimeModelReference(candidate).reference;
      } catch {
        return false;
      }
      return sanitizeModelReferenceText(reference, MODEL_REFERENCE_ECHO_MAX_BYTES) !== reference;
    });
    expect(violations).toEqual([]);
  });

  it("refuses exactly the code points the sanitizer would otherwise have to escape", () => {
    // The kernel parser and this module each name the unsafe set with their own regex, in
    // different packages and different languages. Asserting the two agree code point by code
    // point is what keeps that duplication honest; a comment would not.
    const disagreements: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const value = `openai:a${String.fromCodePoint(codePoint)}b`;
      const escapedByRenderer = sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES) !== value;
      let refusedByParser = false;
      try {
        parseMonoRuntimeModelReference(value);
      } catch {
        refusedByParser = true;
      }
      if (escapedByRenderer !== refusedByParser) {
        disagreements.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
