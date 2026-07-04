import { afterEach, describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  parseAgentStreamFrame,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";

import { MAX_FRAME_BYTES, startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

let running: TuiAdapterStartResult | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function scriptedResponder(
  script: (request: AgentRequestBase, stream: AgentMessageStream) => Promise<AgentResponse>,
  cancel?: (conversationId: string, reason?: unknown) => void,
): AgentResponder {
  return { respond: script, ...(cancel === undefined ? {} : { cancel }) };
}

async function readFrames(response: globalThis.Response): Promise<AgentStreamWireFrame[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseAgentStreamFrame);
}

async function postTurn(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("startTuiAdapter", () => {
  it("serves /v1/info with schema and identity", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5" },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({ schema: 1, pid: process.pid, label: "test-agent", model: "claude-fable-5" });
  });

  it("includes effort in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5", effort: "high" },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      label: "test-agent",
      model: "claude-fable-5",
      effort: "high",
    });
  });

  it("includes the candidate models list in /v1/info when configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });

    const info = await (await fetch(running.infoUrl)).json();

    expect(info).toEqual({
      schema: 1,
      pid: process.pid,
      model: "claude-fable-5",
      models: ["claude-fable-5", "codex:gpt-5.5"],
    });
  });

  it("omits models from /v1/info when the list is empty or absent", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { model: "claude-fable-5", models: [] },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("models" in info).toBe(false);
  });

  it("omits effort from /v1/info when not configured", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => ({ text: "ok" })),
      info: { label: "test-agent", model: "claude-fable-5" },
    });

    const info = (await (await fetch(running.infoUrl)).json()) as Record<string, unknown>;

    expect("effort" in info).toBe(false);
  });

  it("streams the full callback sequence as NDJSON frames in order", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request, stream) => {
        expect(request.conversationId).toBe("tui:main");
        expect(request.metadata?.source).toBe("tui");
        await stream.status?.("Thinking…");
        await stream.event?.({ type: "assistant_thought", text: "let me look" });
        await stream.event?.({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });
        await stream.event?.({ type: "tool_call_progress", id: "t1", partialResult: "a.txt\n" });
        await stream.event?.({ type: "tool_call_completed", id: "t1", content: "a.txt\nb.txt", isError: false, executionMs: 12 });
        await stream.event?.({ type: "usage_update", cumulativeUsd: 0.02, tokens: { input: 5, output: 9, cacheRead: 0, cacheCreation: 0 } });
        await stream.append("Here");
        await stream.append(" you go.");
        return { text: "Here you go.", metadata: { runId: "r1" } };
      }),
    });

    const response = await postTurn(running.baseUrl, { conversationId: "tui:main", text: "list files" });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = await readFrames(response);

    expect(frames).toEqual([
      { kind: "status", text: "Thinking…" },
      { kind: "event", event: { type: "assistant_thought", text: "let me look" } },
      { kind: "event", event: { type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } } },
      { kind: "event", event: { type: "tool_call_progress", id: "t1", partialResult: "a.txt\n" } },
      { kind: "event", event: { type: "tool_call_completed", id: "t1", content: "a.txt\nb.txt", isError: false, executionMs: 12 } },
      { kind: "event", event: { type: "usage_update", cumulativeUsd: 0.02, tokens: { input: 5, output: 9, cacheRead: 0, cacheCreation: 0 } } },
      { kind: "append", delta: "Here" },
      { kind: "append", delta: " you go." },
      { kind: "finish", finalText: "Here you go.", metadata: { runId: "r1" } },
    ]);
  });

  it("emits a terminal error frame with cancelled=true for a cancelled turn", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => {
        throw new AgentResponseCancelledError();
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));

    expect(frames).toEqual([
      { kind: "error", message: "Agent response was cancelled.", cancelled: true },
    ]);
  });

  it("emits a terminal error frame for a failed turn", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(async () => {
        throw new Error("model exploded");
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));

    expect(frames).toEqual([{ kind: "error", message: "model exploded", cancelled: false }]);
  });

  it("aborts the in-flight turn when the client socket closes mid-stream", async () => {
    let sawAbort: Promise<void> | undefined;
    running = await startTuiAdapter({
      responder: scriptedResponder(async (request, stream) => {
        await stream.append("started");
        sawAbort = new Promise((resolve) => {
          request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        await sawAbort;
        throw new AgentResponseCancelledError();
      }),
    });

    const controller = new AbortController();
    const responsePromise = postTurn(running.baseUrl, { conversationId: "c", text: "hi" });
    const response = await responsePromise;
    const reader = response.body!.getReader();
    await reader.read(); // first chunk arrived — the turn is in flight
    controller.abort();
    await reader.cancel(); // tear down the client side of the socket

    // The server-side abort must fire (fail the test via timeout otherwise).
    await expect(
      Promise.race([
        sawAbort,
        new Promise((_, reject) => setTimeout(() => reject(new Error("abort never fired")), 4000)),
      ]),
    ).resolves.toBeUndefined();
  });

  it("routes explicit cancel to responder.cancel and 501s when unsupported", async () => {
    const cancelled: Array<[string, unknown]> = [];
    running = await startTuiAdapter({
      responder: scriptedResponder(
        async () => ({ text: "ok" }),
        (conversationId, reason) => void cancelled.push([conversationId, reason]),
      ),
    });

    const accepted = await fetch(`${running.baseUrl}/v1/conversations/tui%3Amain/cancel`, { method: "POST" });
    expect(accepted.status).toBe(202);
    expect(cancelled).toEqual([["tui:main", "tui_cancel"]]);

    await running.stop();
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });
    const unsupported = await fetch(`${running.baseUrl}/v1/conversations/c/cancel`, { method: "POST" });
    expect(unsupported.status).toBe(501);
  });

  it("rejects malformed turn bodies with 400", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    expect((await postTurn(running.baseUrl, { text: "no conversation" })).status).toBe(400);
    expect((await postTurn(running.baseUrl, { conversationId: "c" })).status).toBe(400);
  });

  it("reports server-side handler failures as 500, not 400", async () => {
    running = await startTuiAdapter({
      responder: scriptedResponder(
        async () => ({ text: "ok" }),
        () => {
          throw new Error("cancel backend exploded");
        },
      ),
    });

    const response = await fetch(`${running.baseUrl}/v1/conversations/c/cancel`, { method: "POST" });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("exploded");
  });

  it("keeps body-parse failures as 400", async () => {
    running = await startTuiAdapter({ responder: scriptedResponder(async () => ({ text: "ok" })) });

    const response = await fetch(`${running.baseUrl}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
  });

  it("enforces the bearer key on every route when configured", async () => {
    running = await startTuiAdapter({
      apiKey: "fixture-secret",
      responder: scriptedResponder(async () => ({ text: "ok" })),
    });

    expect((await fetch(running.infoUrl)).status).toBe(401);
    expect((await postTurn(running.baseUrl, { conversationId: "c", text: "hi" })).status).toBe(401);
    expect(
      (await fetch(running.infoUrl, { headers: { authorization: "Bearer fixture-secret" } })).status,
    ).toBe(200);
  });

  it("refuses to bind a non-loopback host without allowNonLoopback", async () => {
    await expect(
      startTuiAdapter({ host: "0.0.0.0", responder: scriptedResponder(async () => ({ text: "ok" })) }),
    ).rejects.toMatchObject({ code: "unsafe_host" });
  });

  it("truncates oversized event frames instead of streaming them verbatim", async () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1024);
    running = await startTuiAdapter({
      responder: scriptedResponder(async (_request, stream) => {
        await stream.event?.({ type: "tool_call_completed", id: "t1", content: huge });
        return { text: "done" };
      }),
    });

    const frames = await readFrames(await postTurn(running.baseUrl, { conversationId: "c", text: "hi" }));
    const eventFrame = frames[0] as Extract<AgentStreamWireFrame, { kind: "event" }>;

    expect(eventFrame.kind).toBe("event");
    const event = eventFrame.event as { content: string; metadata?: Record<string, unknown> };
    expect(event.content.length).toBeLessThan(huge.length);
    expect(event.content.endsWith("… [truncated]")).toBe(true);
    expect(event.metadata?.truncated).toBe(true);
    expect(frames.at(-1)).toEqual({ kind: "finish", finalText: "done" });
  });
});
