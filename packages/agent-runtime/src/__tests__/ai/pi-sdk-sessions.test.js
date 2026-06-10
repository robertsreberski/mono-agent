// Pi-sdk native Session integration.
//
// Drives generatePiResponse end-to-end through a fake streamFn (the Agent's
// injectable LLM transport): each call yields a scripted assistant message,
// so no API keys or network are involved. The pi model ref resolves through
// pi-ai's static model registry.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generatePiResponse } from "../../ai/providers/pi-sdk.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";

const MODEL = {
  sdk: "pi",
  provider: "openai",
  model: "gpt-5.5",
  reference: "pi:openai:gpt-5.5",
};

function fakeAssistantMessage(model, spec) {
  const base = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
  if (spec.error) {
    return { ...base, content: [], stopReason: "error", errorMessage: spec.error };
  }
  return { ...base, content: [{ type: "text", text: spec.text }], stopReason: "stop" };
}

// Returns a StreamFn-compatible fake: async-iterable over
// AssistantMessageEvents with a result() resolving to the final message.
// Each invocation consumes the next reply from `plan`; calls are recorded
// with a snapshot of the LLM context for assertions.
function makeStreamFn(plan, { gate } = {}) {
  const calls = [];
  let index = 0;
  const streamFn = (model, context) => {
    calls.push({ model, context: { ...context, messages: [...context.messages] } });
    const spec = plan[Math.min(index, plan.length - 1)];
    index += 1;
    const message = fakeAssistantMessage(model, spec);
    const events = spec.error
      ? [{ type: "error", reason: "error", error: message }]
      : [
        { type: "start", partial: message },
        { type: "text_end", contentIndex: 0, content: spec.text, partial: message },
        { type: "done", reason: "stop", message },
      ];
    return {
      async *[Symbol.asyncIterator]() {
        if (gate) await gate;
        for (const event of events) yield event;
      },
      async result() {
        if (gate) await gate;
        return message;
      },
    };
  };
  streamFn.calls = calls;
  return streamFn;
}

function transcriptOf(call) {
  return call.context.messages.map((message) => {
    const text = typeof message.content === "string"
      ? message.content
      : (message.content || [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("");
    return `${message.role}:${text}`;
  });
}

function runOptions(overrides = {}) {
  return {
    model: MODEL,
    effort: "none",
    allowedTools: [],
    ...overrides,
  };
}

describe("pi-sdk native sessions", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-sdk-sessions-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  it("keeps a session alive and seeds a resumed run with the prior transcript", async () => {
    const streamFn = makeStreamFn([{ text: "reply-1" }, { text: "reply-2" }]);

    const first = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      streamFn,
    }));
    expect(first.error).toBeNull();
    expect(first.text).toBe("reply-1");
    expect(first.providerSessionId).toBeTruthy();
    expect(transcriptOf(streamFn.calls[0])).toEqual(["user:turn-1"]);

    const second = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
      streamFn,
    }));
    expect(second.error).toBeNull();
    expect(second.text).toBe("reply-2");
    expect(second.providerSessionId).toBe(first.providerSessionId);
    expect(transcriptOf(streamFn.calls[1])).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-2",
    ]);
  });

  it("fails fast with session_not_found on a resume miss without constructing an Agent", async () => {
    const streamFn = makeStreamFn([{ text: "never" }]);
    const result = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "hello" }],
      sessionId: "no-such-session",
      streamFn,
    }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.error).toBe("Pi session no-such-session is not live");
    expect(result.cancelled).toBe(false);
    expect(result.numTurns).toBe(0);
    expect(result.providerSessionId).toBe("no-such-session");
    expect(result.diagnostics.pi_error_code).toBe("pi_session_not_found");
    expect(streamFn.calls.length).toBe(0);
  });

  it("does not persist a failed resumed turn; the next resume sees the last good transcript", async () => {
    const okStream = makeStreamFn([{ text: "reply-1" }]);
    const first = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      streamFn: okStream,
    }));
    expect(first.error).toBeNull();
    const sessionId = first.providerSessionId;

    const failingStream = makeStreamFn([{ error: "boom" }]);
    const failed = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
      streamFn: failingStream,
      piStreamRetryMax: 0,
    }));
    expect(failed.error).toBe("boom");
    expect(failed.failureKind).toBeTruthy();

    const retryStream = makeStreamFn([{ text: "reply-3" }]);
    const third = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-3" }],
      sessionKeepAlive: true,
      sessionId,
      streamFn: retryStream,
    }));
    expect(third.error).toBeNull();
    expect(transcriptOf(retryStream.calls[0])).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-3",
    ]);
  });

  it("registers no session without sessionKeepAlive", async () => {
    const streamFn = makeStreamFn([{ text: "reply-1" }]);
    const first = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-1" }],
      streamFn,
    }));
    expect(first.error).toBeNull();

    const resume = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2" }],
      sessionId: first.providerSessionId,
      streamFn,
    }));
    expect(resume.failureKind).toBe("session_not_found");
    expect(streamFn.calls.length).toBe(1);
  });

  it("rejects a concurrent resume of a busy session with session_busy", async () => {
    const setupStream = makeStreamFn([{ text: "reply-1" }]);
    const first = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      streamFn: setupStream,
    }));
    const sessionId = first.providerSessionId;

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const blockedStream = makeStreamFn([{ text: "reply-2" }], { gate });
    const blockedRun = generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId,
      streamFn: blockedStream,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const contended = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2b" }],
      sessionId,
      streamFn: makeStreamFn([{ text: "never" }]),
    }));
    expect(contended.failureKind).toBe("session_busy");
    expect(contended.diagnostics.pi_error_code).toBe("pi_session_busy");

    release();
    const blocked = await blockedRun;
    expect(blocked.error).toBeNull();
    expect(blocked.text).toBe("reply-2");
  });

  it("reopens a durable jsonl session from disk after the live entry is dropped", async () => {
    const streamFn = makeStreamFn([{ text: "reply-1" }, { text: "reply-2" }]);
    const first = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      piSessionsRoot: sessionsRoot,
      streamFn,
    }));
    expect(first.error).toBeNull();

    // Dropping the live entry leaves the jsonl transcript on disk.
    await expect(disposeProviderSession(first.providerSessionId)).resolves.toBe(true);

    const resumed = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
      piSessionsRoot: sessionsRoot,
      streamFn,
    }));
    expect(resumed.error).toBeNull();
    expect(resumed.text).toBe("reply-2");
    expect(transcriptOf(streamFn.calls[1])).toEqual([
      "user:turn-1",
      "assistant:reply-1",
      "user:turn-2",
    ]);
  });

  it("disposeProviderSession drops the live session", async () => {
    const streamFn = makeStreamFn([{ text: "reply-1" }, { text: "never" }]);
    const first = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      streamFn,
    }));
    expect(first.error).toBeNull();

    await expect(disposeProviderSession(first.providerSessionId)).resolves.toBe(true);

    const resume = await generatePiResponse("system", runOptions({
      messages: [{ role: "user", content: "turn-2" }],
      sessionId: first.providerSessionId,
      streamFn,
    }));
    expect(resume.failureKind).toBe("session_not_found");
    expect(streamFn.calls.length).toBe(1);
  });
});
