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
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";

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

  it("fails fast with session_not_found on a resume miss without invoking the provider", async () => {
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      sessionId: "no-such-native-session",
      piSessionsRoot: sessionsRoot,
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
});
