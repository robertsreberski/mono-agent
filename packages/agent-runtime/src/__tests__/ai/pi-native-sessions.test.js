// Pi-native session lifecycle integration.
//
// Retargeted from the retired pi-sdk-sessions suite: these assert the SAME
// session contract (resume seeding, session_not_found / session_busy fail-fast,
// keep-alive vs. drop, durable jsonl reopen, per-run billing, dispose reach,
// failed-turn isolation, structured-output finalization retry) against the
// pi-native AgentHarness bridge — the sole pi runtime path.
//
// The harness has no streamFn injection seam, so the provider is driven through
// pi-ai's own `registerFauxProvider`: a real provider is registered into pi-ai's
// API registry, the REAL harness + REAL streamSimple dispatch run with scripted
// responses, and the faux Model is handed to the bridge via the `piResolvedModel`
// seam (the faux model is reachable only through the registration handle).

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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";

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

// Pull the user/assistant text turns out of a captured provider context so we
// can assert the seeded transcript on a resumed run.
function transcriptOf(context) {
  return (context?.messages || [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string"
        ? message.content
        : (message.content || [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("");
      return `${message.role}:${text}`;
    });
}

describe("pi-native sessions", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-native-sessions-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  it("forwards streamed thinking once and reports reasoning in per-run capabilities", async () => {
    const model = setup({ reasoning: true });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("checking context"), fauxText("reply")]),
    ]);
    const seen = [];
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      effort: "medium",
      onEvent: (event) => {
        const block = event?.message?.content?.[0];
        if (block?.type === "thinking" && block.text !== "Running...") seen.push(block.text);
      },
    }));

    expect(result.error).toBeNull();
    expect(result.thinking).toContain("checking context");
    expect(result.capabilitiesUsed.thinking_enabled).toBe(true);
    expect(seen.join("")).toContain("checking context");
  });

  it("keeps a session alive and seeds a resumed run with the prior transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();
    expect(first.text).toBe("reply-1");
    expect(first.providerSessionId).toBeTruthy();

    let resumedContext = null;
    faux.setResponses([
      (context) => { resumedContext = context; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);
    const second = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
    }));
    expect(second.error).toBeNull();
    expect(second.text).toBe("reply-2");
    expect(second.providerSessionId).toBe(first.providerSessionId);
    expect(transcriptOf(resumedContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-2",
    ]);
  });

  it("fails fast with session_not_found on a resume miss without invoking the provider", async () => {
    const model = setup();
    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hello" }],
      sessionId: "no-such-session",
    }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.error).toBe("Pi session no-such-session is not live");
    expect(result.cancelled).toBe(false);
    expect(result.numTurns).toBe(0);
    expect(result.providerSessionId).toBe("no-such-session");
    expect(result.diagnostics.pi_error_code).toBe("pi_session_not_found");
    expect(invoked).toBe(false);
  });

  it("does not persist a failed resumed turn; the next resume sees the last good transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();
    const sessionId = first.providerSessionId;

    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" }),
    ]);
    const failed = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    expect(failed.error).toBe("boom");
    expect(failed.failureKind).toBeTruthy();

    let retryContext = null;
    faux.setResponses([
      (context) => { retryContext = context; return fauxAssistantMessage([fauxText("reply-3")]); },
    ]);
    const third = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-3" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    expect(third.error).toBeNull();
    expect(transcriptOf(retryContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-3",
    ]);
  });

  it("registers no session without sessionKeepAlive", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
    }));
    expect(first.error).toBeNull();

    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const resume = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionId: first.providerSessionId,
    }));
    expect(resume.failureKind).toBe("session_not_found");
    expect(invoked).toBe(false);
  });

  it("rejects a concurrent resume of a busy session with session_busy", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    const sessionId = first.providerSessionId;

    // Gate the blocked run mid-turn so the session is observably busy.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    faux.setResponses([
      async () => { await gate; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);
    const blockedRun = generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const contended = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2b" }],
      sessionId,
    }));
    expect(contended.failureKind).toBe("session_busy");
    expect(contended.diagnostics.pi_error_code).toBe("pi_session_busy");

    release();
    const blocked = await blockedRun;
    expect(blocked.error).toBeNull();
    expect(blocked.text).toBe("reply-2");
  });

  it("reopens a durable jsonl session from disk after the live entry is dropped", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      piSessionsRoot: sessionsRoot,
    }));
    expect(first.error).toBeNull();

    // Dropping the live entry leaves the jsonl transcript on disk.
    await expect(disposeProviderSession(first.providerSessionId)).resolves.toBe(true);

    let resumedContext = null;
    faux.setResponses([
      (context) => { resumedContext = context; return fauxAssistantMessage([fauxText("reply-2")]); },
    ]);
    const resumed = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
      piSessionsRoot: sessionsRoot,
    }));
    expect(resumed.error).toBeNull();
    expect(resumed.text).toBe("reply-2");
    expect(transcriptOf(resumedContext)).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-2",
    ]);
  });

  it("bills a resumed run only for this run's messages, not the restored transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.numTurns).toBe(1);

    faux.setResponses([fauxAssistantMessage([fauxText("reply-2")])]);
    const second = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
    }));
    // The restored turn-1 assistant message must not be re-counted: the resumed
    // run reports exactly its own single turn and only its own assistant output
    // token, not the restored transcript's.
    expect(second.numTurns).toBe(1);
    expect(second.usage.output_tokens).toBe(first.usage.output_tokens);
  });

  it("disposeProviderSession drops the live native session", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
    }));
    expect(first.error).toBeNull();

    await expect(disposeProviderSession(first.providerSessionId)).resolves.toBe(true);

    let invoked = false;
    faux.setResponses([() => { invoked = true; return fauxAssistantMessage([fauxText("never")]); }]);
    const resume = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionId: first.providerSessionId,
    }));
    expect(resume.failureKind).toBe("session_not_found");
    expect(invoked).toBe(false);
  });

  it("re-prompts once for structured output when a turn ends with no result", async () => {
    const model = setup();
    // First turn yields neither text nor a StructuredOutput call; the bridge
    // must re-prompt once with only StructuredOutput active, after which the
    // model submits the structured result.
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("thinking only")]),
      fauxAssistantMessage([fauxToolCall("StructuredOutput", { answer: 7 }, { id: "so-1" })]),
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
    expect(result.structuredResult).toEqual({ answer: 7 });
    expect(result.structuredResultSource).toBe("StructuredOutput");
    expect(result.diagnostics.structured_output_finalization_retry_attempts).toBe(1);
    expect(result.diagnostics.structured_output_finalization_retry_reason).toBe("empty_final_output");
    expect(result.diagnostics.structured_output_finalization_retry_failed).toBe(false);
    expect(result.runtimeWarnings.some(
      (warning) => warning?.warning_kind === "structured_output_finalization_retry",
    )).toBe(true);
  });
});
