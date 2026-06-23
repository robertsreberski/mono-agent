// Pi-native AgentHarness bridge integration.
//
// Drives generatePiNativeResponse end-to-end through pi-ai's own
// `registerFauxProvider`: a real provider is registered into pi-ai's API
// registry, so the REAL AgentHarness + REAL `streamSimple` dispatch run with
// scripted assistant responses and no network/API key. This exercises the
// production harness path while keeping the provider deterministic.
//
// The bridge's `piResolvedModel` seam hands the harness the faux Model
// directly (the faux model is only reachable via the registration handle, not
// the static model registry).
//
// The native bridge must return the SAME unified result shape and emit the
// SAME normalized runtime events as the legacy pi-sdk bridge.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePiNativeResponse, splitPromptMessages } from "../../ai/providers/pi-native.js";

const FAUX_MODEL = { api: "faux", provider: "faux", id: "faux-model" };

describe("splitPromptMessages (pi-native multimodal preservation)", () => {
  it("preserves text + image parts of the final user turn (no JSON stringification)", () => {
    const { priorMessages, promptText, promptImages } = splitPromptMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", data: "BASE64DATA", mimeType: "image/png" },
          ],
        },
      ],
      FAUX_MODEL,
    );
    expect(priorMessages).toEqual([]);
    expect(promptText).toBe("describe this");
    expect(promptImages).toEqual([{ type: "image", data: "BASE64DATA", mimeType: "image/png" }]);
  });

  it("keeps prior-turn structure (image blocks) via toAgentMessages instead of stringifying", () => {
    const { priorMessages, promptText, promptImages } = splitPromptMessages(
      [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "X", mimeType: "image/jpeg" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "follow up" },
      ],
      FAUX_MODEL,
    );
    expect(promptText).toBe("follow up");
    expect(promptImages).toEqual([]);
    const priorUser = priorMessages.find((message) => message.role === "user");
    expect(Array.isArray(priorUser.content)).toBe(true);
    expect(priorUser.content).toContainEqual({ type: "image", data: "X", mimeType: "image/jpeg" });
  });

  it("handles a plain string final turn", () => {
    const { promptText, promptImages } = splitPromptMessages([{ role: "user", content: "just text" }], FAUX_MODEL);
    expect(promptText).toBe("just text");
    expect(promptImages).toEqual([]);
  });
});

describe("pi-sdk.js compatibility shim", () => {
  it("re-exports the pi-native bridge + helpers under the legacy names", async () => {
    const shim = await import("../../ai/providers/pi-sdk.js");
    expect(typeof shim.generatePiResponse).toBe("function");
    expect(shim.piRuntimeBridge?.kind).toBe("pi");
    expect(typeof shim.piRuntimeBridge?.execute).toBe("function");
    expect(shim.piOpenAiBackend?.execute).toBe(shim.generatePiResponse);
    expect(typeof shim.isContextLimitError).toBe("function");
    expect(typeof shim.normalizePiErrorMessage).toBe("function");
  });
});

let faux = null;

function setup({ reasoning = false } = {}) {
  faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", reasoning }],
    tokensPerSecond: undefined,
  });
  return faux.getModel();
}

beforeEach(() => {
  faux = null;
});

afterEach(() => {
  faux?.unregister();
  faux = null;
});

function runOptions(model, overrides = {}) {
  return {
    model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model" },
    piResolvedModel: model,
    effort: "none",
    allowedTools: [],
    ...overrides,
  };
}

describe("pi-native AgentHarness bridge", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-native-sessions-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  it("returns the unified result shape and streams normalized events on a simple turn", async () => {
    const model = setup({ reasoning: true });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("considering"), fauxText("hello world")]),
    ]);
    const onEvent = vi.fn();

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "say hi" }],
      effort: "medium",
      onEvent,
    }));

    expect(result.error).toBeNull();
    expect(result.text).toBe("hello world");
    expect(result.sdk).toBe("pi");
    expect(result.model).toBe("pi:faux:faux-model");
    expect(result.cancelled).toBe(false);
    expect(result.providerSessionId).toBeTruthy();
    expect(Array.isArray(result.events)).toBe(true);
    expect(result.numTurns).toBe(1);
    expect(result.diagnostics.provider_session_id).toBe(result.providerSessionId);
    expect(result.diagnostics.pi_engine).toBe("native");

    const events = onEvent.mock.calls.map(([event]) => event);
    expect(events[0]).toMatchObject({ type: "provider_request_started", sdk: "pi", runtime: "pi" });
    expect(events.some((event) => event?.type === "provider_request_completed")).toBe(true);
    const textBlocks = events
      .filter((event) => event?.type === "assistant")
      .flatMap((event) => event.message?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text);
    expect(textBlocks.join("")).toContain("hello world");
  });

  it("delivers final-turn images to the model as image content blocks (not dropped)", async () => {
    // Regression: AgentHarness.prompt takes images under an options object
    // (`{ images }`). Passing a bare ImageContent[] as the second positional arg
    // makes `options?.images` undefined, so the image is silently dropped and
    // never reaches the model. Assert the image block survives to the provider.
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", input: ["text", "image"] }],
      tokensPerSecond: undefined,
    });
    const model = faux.getModel();

    let capturedMessages = null;
    faux.setResponses([
      (context) => {
        capturedMessages = context.messages;
        return fauxAssistantMessage([fauxText("seen")]);
      },
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image", data: "BASE64DATA", mimeType: "image/png" },
          ],
        },
      ],
    }));

    expect(result.error).toBeNull();
    expect(capturedMessages).not.toBeNull();
    const lastUser = [...capturedMessages].reverse().find((message) => message.role === "user");
    expect(lastUser).toBeDefined();
    expect(Array.isArray(lastUser.content)).toBe(true);
    expect(lastUser.content).toContainEqual({ type: "image", data: "BASE64DATA", mimeType: "image/png" });
    expect(lastUser.content).toContainEqual({ type: "text", text: "what is this" });
  });

  it("maps a tool call to normalized tool_use and tool_result events", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-tool-"));
    try {
      writeFileSync(join(root, "notes.txt"), "important context\n");
      const model = setup();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Read", { file_path: "notes.txt" }, { id: "call-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();

      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Read"],
        messages: [{ role: "user", content: "read the notes" }],
        onEvent,
      }));

      expect(result.error).toBeNull();
      expect(result.text).toBe("done");

      const events = onEvent.mock.calls.map(([event]) => event);
      const progress = events.find((event) =>
        event?.message?.content?.[0]?.type === "thinking"
        && event.message.content[0].text === "Running Read...");
      const toolUse = events.find((event) =>
        event?.message?.content?.[0]?.type === "tool_use"
        && event.message.content[0].name === "Read");
      const toolResult = events.find((event) =>
        event?.message?.content?.[0]?.type === "tool_result"
        && event.message.content[0].tool_use_id === "call-1");
      const toolTiming = events.find((event) =>
        event?.type === "tool_timing" && event.tool_use_id === "call-1");
      expect(progress).toBeTruthy();
      expect(toolUse).toBeTruthy();
      expect(toolResult).toBeTruthy();
      expect(toolTiming).toBeTruthy();
      expect(toolTiming.name).toBe("Read");
      expect(typeof toolTiming.execution_ms).toBe("number");
      expect(toolTiming.execution_ms).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces MCP server init failures in runtimeWarnings, not just as transient events", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const onEvent = vi.fn();

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      // A stdio child that exits immediately fails the MCP handshake ("Connection closed"),
      // mirroring the adapter-send -32000 flake that was previously invisible in the run summary.
      mcpServers: { broken: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
      onEvent,
    }));

    expect(result.error).toBeNull();
    const initWarnings = (result.runtimeWarnings || []).filter((warning) => warning?.warning_kind === "mcp_init_failed");
    expect(initWarnings.length).toBeGreaterThanOrEqual(1);
    expect(initWarnings[0]).toMatchObject({ warning_kind: "mcp_init_failed", server: "broken" });
    // ...and it is STILL emitted to the live event stream (existing behavior preserved).
    const events = onEvent.mock.calls.map(([event]) => event);
    expect(events.some((event) => event?.warning_kind === "mcp_init_failed")).toBe(true);
  });

  it("captures structured output through the StructuredOutput tool", async () => {
    const model = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("StructuredOutput", { answer: 42 }, { id: "so-1" })]),
      fauxAssistantMessage([fauxText("final")]),
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "give structured output" }],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }));

    expect(result.error).toBeNull();
    expect(result.structuredResult).toEqual({ answer: 42 });
    expect(result.structuredResultSource).toBe("StructuredOutput");
  });

  it("forwards maxRetries to the provider stream options", async () => {
    const model = setup();
    let seenOptions = null;
    faux.setResponses([
      (_context, options) => {
        seenOptions = options;
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      piMaxRetries: 4,
    }));

    expect(result.error).toBeNull();
    expect(seenOptions?.maxRetries).toBe(4);
  });

  it("surfaces a provider stream error in the unified failure shape", async () => {
    const model = setup();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom provider failure" }),
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
    }));

    expect(result.error).toBe("boom provider failure");
    expect(result.failureKind).toBeTruthy();
    expect(result.cancelled).toBe(false);
  });

  it("resumes a durable session and seeds the next run with the prior transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      piSessionsRoot: sessionsRoot,
    }));
    expect(first.error).toBeNull();
    expect(first.text).toBe("reply-1");
    expect(first.providerSessionId).toBeTruthy();

    // Capture the provider context of the resumed run to assert prior turns are seeded.
    let resumedContext = null;
    faux.setResponses([
      (context) => {
        resumedContext = context;
        return fauxAssistantMessage([fauxText("reply-2")]);
      },
    ]);
    const second = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
      piSessionsRoot: sessionsRoot,
    }));
    expect(second.error).toBeNull();
    expect(second.text).toBe("reply-2");
    expect(second.providerSessionId).toBe(first.providerSessionId);

    const userTexts = (resumedContext?.messages || [])
      .filter((message) => message?.role === "user")
      .map((message) => (typeof message.content === "string"
        ? message.content
        : (message.content || [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("")));
    expect(userTexts).toContain("turn-1");
    expect(userTexts).toContain("turn-2");
  });

  it("fails fast with session_not_found on an in-memory resume miss without invoking the provider", async () => {
    // In-memory resume miss (no piSessionsRoot): no live entry and no durable
    // repo to create-on-miss into, so the per-process session_not_found contract
    // holds. (The DURABLE resume miss now creates-on-miss under the requested id
    // — see the cross-restart resume test in pi-native-sessions.test.js, F9.)
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      sessionId: "no-such-native-session",
    }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.providerSessionId).toBe("no-such-native-session");
    expect(result.diagnostics.pi_error_code).toBe("pi_session_not_found");
    expect(invoked).toBe(false);
  });

  it("honors an already-aborted signal without invoking the provider", async () => {
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);
    const controller = new AbortController();
    controller.abort();
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    }));
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(invoked).toBe(false);
  });

  it("honors an abort that fires DURING setup, before the provider call (F5)", async () => {
    // The bridge installs its abort handler only AFTER a long stretch of awaited
    // setup (reopen/create/MCP-init/buildContext/appendMessage/getLeafId). An
    // abort that lands during that window is dropped by the (not-yet-attached)
    // handler, so the F5 re-check right before provider_request_started is the
    // load-bearing guard. We model "abort fired during setup" with a signal that
    // is NOT aborted at the entry pre-check (~:356) but flips to aborted exactly
    // when the bridge attaches its handler (~:640) — i.e. AFTER all setup awaits
    // and BEFORE the provider call (~:706). The faux response must never run.
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);

    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      reason: undefined,
      // The bridge attaches its handler here (post-setup); flipping aborted on
      // that call deterministically simulates an abort the handler install missed.
      addEventListener(_type, _handler, _opts) { aborted = true; },
      removeEventListener() {},
    };

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      abortSignal: signal,
    }));
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(invoked).toBe(false);
  });

  it("applies configured tool-output limits to tool params (not the pi-bridge fallbacks)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-limits-"));
    try {
      writeFileSync(join(root, "a.txt"), "needle here\n");
      const model = setup();
      // The model issues a Grep call with NO explicit max_output_chars/head_limit
      // so the params are filled in purely from the resolved tool limits. The
      // configured clamps are set BELOW the pi-bridge fallbacks (16000 text /
      // 100 search) so the normalized params can only equal the configured values
      // if settings-driven clamping reached the tool builder + display path.
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Grep", { pattern: "needle" }, { id: "g-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();
      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Grep"],
        messages: [{ role: "user", content: "search" }],
        settings: {
          // Both below the pi-bridge fallbacks (16000 text / 100 search) AND
          // within resolveAgentCompactionPolicy's clamp floors (>=1000 text,
          // >=10 search) so they survive policy resolution verbatim.
          agent_tool_text_limit_chars: 1000,
          agent_search_result_limit: 25,
        },
        onEvent,
      }));
      expect(result.error).toBeNull();

      const events = onEvent.mock.calls.map(([event]) => event);
      const toolUse = events
        .filter((event) => event?.message?.content?.[0]?.type === "tool_use")
        .map((event) => event.message.content[0])
        .find((block) => block.name === "Grep");
      expect(toolUse).toBeTruthy();
      // 1000 / 25 are the configured clamps; the fallback path would yield 16000 / 100.
      expect(toolUse.input.max_output_chars).toBe(1000);
      expect(toolUse.input.head_limit).toBe(25);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports context_compaction_applied as false when enabled but not triggered", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(result.error).toBeNull();
    // false = the compaction path is enabled but did not need to fire this run.
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(false);
  });

  it("reports context_compaction_applied as null when disabled via settings", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      settings: { agent_compaction_enabled: false },
    }));
    expect(result.error).toBeNull();
    expect(result.capabilitiesUsed.context_compaction_applied).toBeNull();
  });
});

describe("pi-native auto-compaction", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-native-compaction-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  // Build a transcript large enough that AgentHarness.compact() (keepRecent ~20k)
  // finds a cut point and actually summarizes a prefix. The trailing user turn
  // becomes the prompt; the rest is seeded as prior history.
  function bigHistory(turns, chars) {
    const blob = "x".repeat(chars);
    const messages = [];
    for (let i = 0; i < turns; i += 1) {
      messages.push({ role: "user", content: `u${i} ${blob}` });
      messages.push({ role: "assistant", content: `a${i} ${blob}` });
    }
    messages.push({ role: "user", content: "continue" });
    return messages;
  }

  it("proactively compacts before the turn when near the window", async () => {
    const base = setup();
    const windowed = { ...base, contextWindow: 4000 };
    let summaryCalled = false;
    faux.setResponses([
      () => { summaryCalled = true; return fauxAssistantMessage([fauxText("SUMMARY of earlier work")]); },
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:proactive" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(result.error).toBeNull();
    expect(result.text).toBe("done");
    expect(summaryCalled).toBe(true);
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
    expect(result.diagnostics.context_compaction_proactive).toBe(true);
  });

  it("reactively compacts and re-prompts once when a turn overflows", async () => {
    const base = setup();
    // Huge window so the PROACTIVE trigger never fires; the overflow forces the
    // REACTIVE path. The big transcript lets compact() actually find a cut.
    const windowed = { ...base, contextWindow: 10_000_000 };
    let summaryCalled = false;
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }),
      () => { summaryCalled = true; return fauxAssistantMessage([fauxText("SUMMARY")]); },
      fauxAssistantMessage([fauxText("recovered")]),
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:reactive" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(result.error).toBeNull();
    expect(result.text).toBe("recovered");
    expect(summaryCalled).toBe(true);
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
    expect(result.diagnostics.context_compaction_reactive).toBe(true);
    expect(result.diagnostics.context_compaction_proactive).toBeUndefined();
  });

  it("does not re-compact (or loop) when a proactively-compacted turn still overflows", async () => {
    const base = setup();
    // Small window so the PROACTIVE trigger fires; the turn then still overflows.
    const windowed = { ...base, contextWindow: 4000 };
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("SUMMARY")]); }, // proactive compact
      () => { providerCalls += 1; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("should-not-happen")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:guard" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    // Proactive compaction fired, the turn still overflowed, and the bridge
    // surfaces the overflow WITHOUT a second compaction or a re-prompt.
    expect(result.diagnostics.context_compaction_proactive).toBe(true);
    expect(result.error).toBe("Your input exceeds the context window of this model.");
    expect(result.failureKind).toBe("usage_limit");
    expect(providerCalls).toBe(2); // summary + main overflow; no re-prompt
  });

  it("re-prompts at most once even if the overflow persists after compaction", async () => {
    const base = setup();
    const windowed = { ...base, contextWindow: 10_000_000 };
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("SUMMARY")]); },
      () => { providerCalls += 1; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("should-not-happen")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:loop" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(result.failureKind).toBe("usage_limit");
    // overflow + summary + ONE re-prompt overflow = 3 calls; never the 4th.
    expect(providerCalls).toBe(3);
    expect(result.diagnostics.context_compaction_reactive).toBe(true);
  });

  it("learns the real context window from an overflow error and triggers proactively next run", async () => {
    const base = setup();
    // Declared window is large, so proactively nothing fires at first.
    const windowed = { ...base, contextWindow: 200000 };
    const runRef = { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:learn" };

    // Run 1: a ~60k-token transcript stays under the declared-window trigger
    // (~150k), so it does NOT compact proactively. The overflow names the real
    // ceiling (120000), which the bridge records for this model.
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "maximum context length is 120000 tokens" }),
      fauxAssistantMessage([fauxText("SUMMARY")]),
      fauxAssistantMessage([fauxText("recovered-1")]),
    ]);
    const run1 = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: runRef,
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(run1.diagnostics.context_compaction_proactive).toBeUndefined();
    expect(run1.diagnostics.context_compaction_reactive).toBe(true);

    // Run 2: same model. A ~110k-token transcript is under the declared trigger
    // (~150k) but OVER the learned-window trigger (~90k), so proactive fires only
    // because the real ceiling (120000) was learned.
    faux.setResponses([
      fauxAssistantMessage([fauxText("SUMMARY")]),
      fauxAssistantMessage([fauxText("done-2")]),
    ]);
    const run2 = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: runRef,
      messages: bigHistory(110, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(run2.error).toBeNull();
    expect(run2.text).toBe("done-2");
    expect(run2.diagnostics.context_compaction_proactive).toBe(true);
    expect(run2.diagnostics.context_window).toBe(120000);
  });

  // Budget-aware compaction (Layer A): the raw transcript estimate excludes the
  // system prompt + tool schemas the provider meters. On a seeded session whose
  // last-assistant usage is absent (cron-after-restart / daily rollover) the raw
  // branch wins, so without the fixed-overhead correction the trigger under-fires
  // and the request overflows. These two runs use the SAME transcript (sized just
  // UNDER the trigger) so the ONLY thing that flips proactive compaction on is the
  // overhead from a large system prompt + several tools.
  //
  // contextWindow 100000 -> trigger 75000, keepRecent 24000. The seeded transcript
  // (~56k tokens) sits below the trigger but above keepRecent (so compact() has a
  // prefix to summarize). The overhead counts the system prompt (~30k tokens) +
  // tool schemas + the trailing per-turn user message ("continue", ~3 tokens) —
  // NOT the prior transcript (already summed by the raw branch). That ~30k of
  // overhead pushes the corrected estimate (~56k + ~30k = ~86k) over 75000.
  function overheadFixture(reference) {
    const base = setup();
    const windowed = { ...base, contextWindow: 100000 };
    // ~120k chars -> ~30k tokens of system-prompt overhead.
    const bigSystemPrompt = "S".repeat(120000);
    // Several distinct tools so toolSchemaTokens is non-trivial too (the bridge's
    // built-in tools are also counted, but allowing a couple makes the intent
    // explicit and keeps the schemas in the overhead estimate).
    const messages = bigHistory(28, 4000); // ~56k-token transcript, under 75000.
    return { base, windowed, reference, bigSystemPrompt, messages };
  }

  it("proactively compacts on a seeded session once fixed overhead is counted (default on)", async () => {
    const { base, windowed, bigSystemPrompt, messages } = overheadFixture("pi:faux:overhead-on");
    // When the corrected trigger fires: call 1 = compaction summary, call 2 = turn.
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("SUMMARY")]); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("done")]); },
    ]);
    const result = await generatePiNativeResponse(bigSystemPrompt, runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:overhead-on" },
      messages,
      allowedTools: ["Read", "Grep", "Bash"],
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
      // On by default — no flag set; the correction fires unless explicitly disabled.
    }));
    expect(result.error).toBeNull();
    expect(result.text).toBe("done");
    expect(providerCalls).toBe(2); // summary + turn — proactive compaction fired
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
    expect(result.diagnostics.context_compaction_proactive).toBe(true);
    // A4 observability: the new budget-aware diagnostics are present and consistent.
    expect(result.diagnostics.context_fixed_overhead_tokens).toBeGreaterThan(0);
    expect(result.diagnostics.context_system_prompt_tokens).toBeGreaterThan(0);
    expect(typeof result.diagnostics.context_tool_schema_tokens).toBe("number");
    expect(result.diagnostics.context_compaction_trigger_tokens).toBe(75000);
    expect(result.diagnostics.context_transcript_estimate)
      .toBeGreaterThanOrEqual(result.diagnostics.context_compaction_trigger_tokens);
    // Regression guard for the transcript double-count: only the TRAILING per-turn
    // user message ("continue", ~3 tokens) plus the system prompt (~30k) + tool
    // schemas may be counted — NOT the ~56k-token prior transcript (already summed
    // by the raw branch). A double-count would inflate this past the system prompt
    // by tens of thousands of tokens, so bound it just above the system-prompt size.
    expect(result.diagnostics.context_fixed_overhead_tokens)
      .toBeLessThan(result.diagnostics.context_system_prompt_tokens + 1000);
  });

  it("does NOT proactively compact on the same seeded session when fixed overhead is explicitly disabled", async () => {
    const { base, windowed, bigSystemPrompt, messages } = overheadFixture("pi:faux:overhead-off");
    // With overhead explicitly disabled the transcript alone is under the trigger,
    // so no compaction fires: call 1 IS the turn (text "turn-output"), never a summary.
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("turn-output")]); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("should-not-happen")]); },
    ]);
    const result = await generatePiNativeResponse(bigSystemPrompt, runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:overhead-off" },
      messages,
      allowedTools: ["Read", "Grep", "Bash"],
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
      // Escape hatch: explicitly disable the correction to restore the prior
      // transcript-only trigger (under-counts overhead).
      settings: { agent_compaction_fixed_overhead_enabled: false },
    }));
    expect(result.error).toBeNull();
    // Disabling overhead reproduces the prior under-counting behavior: the proactive
    // path does NOT fire, so the very first provider call is the turn itself.
    expect(providerCalls).toBe(1);
    expect(result.text).toBe("turn-output");
    expect(result.diagnostics.context_compaction_proactive).toBeUndefined();
    expect(result.diagnostics.context_fixed_overhead_tokens).toBeUndefined();
  });
});
