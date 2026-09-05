import { describe, expect, it } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

import {
  isAgentResponseCancelledError,
  serializeAgentStreamFrame,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";
import {
  MAX_INFO_BODY_BYTES,
  MAX_INFO_PROVIDER_ID_BYTES,
  MAX_INFO_PROVIDER_ITEMS,
  MAX_INFO_PROVIDER_LABEL_BYTES,
} from "@mono-agent/agent-contracts";
import { startTuiAdapter, type TuiAdapterStartResult } from "@mono-agent/operator-adapter";

import { RemoteAgentResponder, RemoteAgentResponderError } from "../remote/client.js";

/**
 * Serve one fixed `/v1/info` body from a raw loopback server, so a payload the
 * real adapter would never produce can still be put in front of the client.
 */
async function withRawInfoBody(
  body: string,
  run: (client: RemoteAgentResponder) => Promise<void>,
): Promise<void> {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run(new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Serve one fixed `/v1/info` response with an arbitrary STATUS, so the client's
 * non-2xx path can be put in front of a real socket rather than only a double.
 */
async function withRawInfoResponse(
  status: number,
  body: string,
  run: (client: RemoteAgentResponder) => Promise<void>,
): Promise<void> {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run(new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${String(port)}` }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Round-trip tests against the real operator-adapter TUI server: the client half of the
 * wire contract is exercised against the exact server that agent-app runs.
 */
async function withAdapter(
  responder: AgentResponder,
  run: (adapter: TuiAdapterStartResult) => Promise<void>,
  apiKey?: string,
): Promise<void> {
  const adapter = await startTuiAdapter({
    responder,
    ...(apiKey === undefined ? {} : { apiKey }),
    info: { label: "fixture-agent", model: "claude-fable-5" },
  });
  try {
    await run(adapter);
  } finally {
    await adapter.stop();
  }
}

function collectingStream(): { stream: AgentMessageStream; events: AgentStreamEvent[]; text: string[] } {
  const events: AgentStreamEvent[] = [];
  const text: string[] = [];
  return {
    events,
    text,
    stream: {
      append: async (delta) => void text.push(delta),
      event: async (event) => void events.push(event),
    },
  };
}

function request(overrides: Partial<AgentRequestBase> = {}): AgentRequestBase {
  return {
    conversationId: "tui:test",
    text: "hello",
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("RemoteAgentResponder", () => {
  it("replays the full remote stream and returns the finish payload", async () => {
    await withAdapter(
      {
        respond: async (_request, stream) => {
          await stream.event?.({ type: "assistant_thought", text: "hm" });
          await stream.event?.({ type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } });
          await stream.event?.({ type: "tool_call_completed", id: "t1", content: "ok", executionMs: 7 });
          await stream.append("Hi ");
          await stream.append("there");
          return { text: "Hi there", metadata: { runId: "r9" } };
        },
      },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const { stream, events, text } = collectingStream();

        const response = await client.respond(request(), stream);

        expect(response).toEqual({ text: "Hi there", metadata: { runId: "r9" } });
        expect(text.join("")).toBe("Hi there");
        expect(events).toEqual([
          { type: "assistant_thought", text: "hm" },
          { type: "tool_call_started", id: "t1", name: "bash", arguments: { command: "ls" } },
          { type: "tool_call_completed", id: "t1", content: "ok", executionMs: 7 },
        ]);
      },
    );
  });

  it("keeps a silent remote turn alive beyond the transport body timeout", async () => {
    const previousDispatcher = getGlobalDispatcher();
    const testAgent = new Agent();
    setGlobalDispatcher(testAgent.compose(
      (dispatch) => (options, handler) => dispatch({
        ...options,
        bodyTimeout: options.bodyTimeout === 0 ? 0 : 100,
      }, handler),
    ));
    try {
      await withAdapter(
        {
          respond: async (_request, stream) => {
            await stream.append("waiting");
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            return { text: "answered" };
          },
        },
        async (adapter) => {
          const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
          const collected = collectingStream();
          await expect(client.respond(
            request({ abortSignal: AbortSignal.timeout(4_000) }),
            collected.stream,
          )).resolves.toEqual({ text: "answered" });
          expect(collected.text).toEqual(["waiting"]);
        },
      );
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await testAgent.close();
    }
  });

  it("reads /v1/info", async () => {
    await withAdapter(
      { respond: async () => ({ text: "ok" }) },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const info = await client.info();
        expect(info).toMatchObject({ schema: 1, label: "fixture-agent", model: "claude-fable-5" });
      },
    );
  });

  it("surfaces effort from /v1/info when the agent has one configured", async () => {
    const adapter = await startTuiAdapter({
      responder: { respond: async () => ({ text: "ok" }) },
      info: { label: "fixture-agent", model: "claude-fable-5", effort: "high" },
    });
    try {
      const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
      const info = await client.info();
      expect(info).toMatchObject({ effort: "high" });
    } finally {
      await adapter.stop();
    }
  });

  it("tolerates the absence of effort from an older agent's /v1/info", async () => {
    await withAdapter(
      { respond: async () => ({ text: "ok" }) },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const info = await client.info();
        expect(info.effort).toBeUndefined();
      },
    );
  });

  it("surfaces the candidate models list from /v1/info", async () => {
    const adapter = await startTuiAdapter({
      responder: { respond: async () => ({ text: "ok" }) },
      info: { model: "claude-fable-5", models: ["claude-fable-5", "codex:gpt-5.5"] },
    });
    try {
      const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
      const info = await client.info();
      expect(info.models).toEqual(["claude-fable-5", "codex:gpt-5.5"]);
    } finally {
      await adapter.stop();
    }
  });

  it("tolerates the absence of models from an older agent's /v1/info", async () => {
    await withAdapter(
      { respond: async () => ({ text: "ok" }) },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const info = await client.info();
        expect(info.models).toBeUndefined();
      },
    );
  });

  it("surfaces the providers catalog from /v1/info when configured", async () => {
    const adapter = await startTuiAdapter({
      responder: { respond: async () => ({ text: "ok" }) },
      info: {
        model: "ollama:qwen3:8b",
        providers: [
          { id: "anthropic", label: "Anthropic", modelCount: 2, source: "builtin", configured: true },
          { id: "openai-codex", label: "OpenAI Codex", modelCount: 1, totalModelCount: 12, source: "builtin" },
          { id: "ollama", label: "Ollama", modelCount: 1, source: "discovered" },
        ],
      },
    });
    try {
      const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
      const info = await client.info();
      expect(info.providers).toEqual([
        { id: "anthropic", label: "Anthropic", modelCount: 2, source: "builtin", configured: true },
        { id: "openai-codex", label: "OpenAI Codex", modelCount: 1, totalModelCount: 12, source: "builtin" },
        { id: "ollama", label: "Ollama", modelCount: 1, source: "discovered" },
      ]);
    } finally {
      await adapter.stop();
    }
  });

  it("tolerates the absence of providers from an older agent's /v1/info", async () => {
    await withAdapter(
      { respond: async () => ({ text: "ok" }) },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const info = await client.info();
        expect(info.providers).toBeUndefined();
      },
    );
  });

  it("drops malformed providers entries while keeping the well-formed ones", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          schema: 1,
          model: "x",
          providers: [
            { id: "good", label: "Good", modelCount: 3, source: "builtin" },
            { id: "bad-source", label: "Bad", modelCount: 1, source: "mystery" },
            { label: "no id", modelCount: 1, source: "builtin" },
            { id: "no-count", label: "No count" },
            "not-an-object",
            { id: "", label: "Empty id", modelCount: 1, source: "builtin" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` });
      const info = await client.info();
      expect(info.providers).toEqual([{ id: "good", label: "Good", modelCount: 3, source: "builtin" }]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("omits providers entirely when the payload's providers is not an array", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schema: 1, model: "x", providers: "garbage" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` });
      const info = await client.info();
      expect(info.providers).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  /**
   * `/v1/info` has two consumers -- this client and the web console's
   * `OperatorClient` -- and exactly one producer, which places the providers its
   * own routes use inside the shared parse window precisely because it knows
   * both consumers cut there. A client that reads a wider window than the other
   * is not being generous; it is a second opinion about one wire, and the
   * operator sees two different provider lists for one agent.
   */
  it("reads the same bounded provider window the console reads", async () => {
    const providers = Array.from({ length: MAX_INFO_PROVIDER_ITEMS + 7 }, (_unused, index) => ({
      id: `vendor-${String(index).padStart(5, "0")}`,
      label: `Vendor ${String(index)}`,
      modelCount: 1,
      source: "builtin" as const,
    }));

    await withRawInfoBody(JSON.stringify({ schema: 1, model: "x", providers }), async (client) => {
      const info = await client.info();
      expect(info.providers?.length).toBe(MAX_INFO_PROVIDER_ITEMS);
      expect(info.providers?.map((provider) => provider.id))
        .toEqual(providers.slice(0, MAX_INFO_PROVIDER_ITEMS).map((provider) => provider.id));
    });
  });

  it("agrees with the console on how long a provider id and label may be", async () => {
    const atBound = `p${"i".repeat(MAX_INFO_PROVIDER_ID_BYTES - 1)}`;
    const overBound = `p${"i".repeat(MAX_INFO_PROVIDER_ID_BYTES)}`;
    const longLabel = "L".repeat(MAX_INFO_PROVIDER_LABEL_BYTES + 1);

    await withRawInfoBody(
      JSON.stringify({
        schema: 1,
        model: "x",
        providers: [
          { id: atBound, label: "At bound", modelCount: 1, source: "builtin" },
          { id: overBound, label: "Over bound", modelCount: 1, source: "builtin" },
          { id: "labelled", label: longLabel, modelCount: 1, source: "builtin" },
        ],
      }),
      async (client) => {
        const info = await client.info();
        expect(info.providers?.map((provider) => provider.id)).toEqual([atBound, "labelled"]);
        // An over-long label degrades to the id rather than costing the entry.
        expect(info.providers?.at(-1)?.label).toBe("labelled");
      },
    );
  });

  it("refuses an oversized /v1/info body rather than parsing it whole", async () => {
    // The producer's fence keeps a real body under this cap; a body over it is
    // an agent this client cannot trust to be bounded anywhere else either, and
    // reading it whole is how one 5 s poll turns into an unbounded allocation.
    const body = JSON.stringify({ schema: 1, model: "x", label: "L".repeat(MAX_INFO_BODY_BYTES) });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_INFO_BODY_BYTES);

    await withRawInfoBody(body, async (client) => {
      const error = await client.info().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(RemoteAgentResponderError);
      expect((error as RemoteAgentResponderError).code).toBe("info_too_large");
    });
  });

  it("bounds an oversized NON-2xx body instead of buffering it whole", async () => {
    // The bounded reader used to sit behind the 2xx check: a non-2xx response
    // was read with `response.text()`, so the one case a bound exists for — a
    // hostile or broken peer — was the one case that had no bound. The
    // adapter's own error responder really did answer 1,052,696 bytes against
    // this 1,048,576-byte contract, so this body is not a hypothetical.
    const chunkBytes = 64 * 1024;
    const totalBytes = 8 * MAX_INFO_BODY_BYTES;
    let produced = 0;
    const fetchImpl: typeof fetch = async () => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced >= totalBytes) {
            controller.close();
            return;
          }
          const size = Math.min(chunkBytes, totalBytes - produced);
          produced += size;
          controller.enqueue(new Uint8Array(size).fill(0x45));
        },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );

    const client = new RemoteAgentResponder({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    const error = await client.info().then(() => undefined, (caught: unknown) => caught);

    // The failure still reads as the HTTP failure it is...
    expect(error).toBeInstanceOf(RemoteAgentResponderError);
    expect((error as RemoteAgentResponderError).code).toBe("http_error");
    expect((error as RemoteAgentResponderError).message).toContain("500");
    // ...and the client stopped pulling at the shared cap while the peer still
    // had 7 MiB queued. Counting what the peer was ASKED to produce is the only
    // honest measure here: asserting on the thrown message alone would pass
    // just as well while the client buffered every byte. The slack is the
    // stream's own one-chunk prefetch, not the client's buffer.
    expect(produced).toBeLessThan(MAX_INFO_BODY_BYTES + 4 * chunkBytes);
  });

  it("still reports the status and a detail prefix from an oversized error body", async () => {
    // Bounding must not cost the diagnostic: a clamped read still has to name
    // the status and echo the head of what the peer said.
    const body = `{"error":{"message":"Discovery failed: ${"D".repeat(2 * MAX_INFO_BODY_BYTES)}"}}`;

    await withRawInfoResponse(503, body, async (client) => {
      const error = await client.info().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(RemoteAgentResponderError);
      expect((error as RemoteAgentResponderError).code).toBe("http_error");
      const message = (error as RemoteAgentResponderError).message;
      expect(message).toContain("503");
      expect(message).toContain("Discovery failed: DDD");
    });
  });

  it("surfaces modelOptions from /v1/info when configured", async () => {
    const adapter = await startTuiAdapter({
      responder: { respond: async () => ({ text: "ok" }) },
      info: {
        model: "ollama:qwen3.6",
        models: ["ollama:qwen3.6", "lmstudio:qwen3-8b"],
        modelOptions: {
          // reasoningMode passes through end to end: a toggle model (no levels)
          // and an effort model (mode + levels).
          "ollama:qwen3.6": { reasoning: true, reasoningMode: "toggle", label: "qwen3.6" },
          "lmstudio:qwen3-8b": { effortLevels: ["low", "medium", "high"], reasoning: true, reasoningMode: "effort", label: "qwen3-8b" },
        },
      },
    });
    try {
      const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
      const info = await client.info();
      expect(info.modelOptions).toEqual({
        "ollama:qwen3.6": { reasoning: true, reasoningMode: "toggle", label: "qwen3.6" },
        "lmstudio:qwen3-8b": { effortLevels: ["low", "medium", "high"], reasoning: true, reasoningMode: "effort", label: "qwen3-8b" },
      });
    } finally {
      await adapter.stop();
    }
  });

  it("tolerates the absence of modelOptions from an older agent's /v1/info", async () => {
    await withAdapter(
      { respond: async () => ({ text: "ok" }) },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const info = await client.info();
        expect(info.modelOptions).toBeUndefined();
      },
    );
  });

  it("tolerates a malformed modelOptions payload without throwing, dropping unrecognized entries/fields", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          schema: 1,
          model: "x",
          modelOptions: {
            wellFormed: { effortLevels: ["low", "high"], reasoning: true, label: "ok" },
            // A malformed `effortLevels` is dropped, but the well-typed `reasoning`
            // alongside it survives — matching the documented degrade semantics
            // where `{ reasoning: true }` with no `effortLevels` means "fall back
            // to the global effort enum", so a partial entry is still meaningful.
            badEffortLevels: { effortLevels: ["low", 123], reasoning: true },
            badReasoning: { reasoning: "yes" },
            // A non-string reasoningMode is dropped; the toggle sibling survives.
            badReasoningMode: { reasoning: true, reasoningMode: 42 },
            toggle: { reasoning: true, reasoningMode: "toggle" },
            notAnObject: "nope",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` });
      const info = await client.info();
      expect(info.modelOptions).toEqual({
        wellFormed: { effortLevels: ["low", "high"], reasoning: true, label: "ok" },
        badEffortLevels: { reasoning: true },
        badReasoningMode: { reasoning: true },
        toggle: { reasoning: true, reasoningMode: "toggle" },
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("omits modelOptions entirely when the payload's modelOptions is not a record", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schema: 1, model: "x", modelOptions: "garbage" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` });
      const info = await client.info();
      expect(info.modelOptions).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("throws AgentResponseCancelledError for a cancelled remote turn", async () => {
    await withAdapter(
      {
        respond: async (turnRequest) => {
          await new Promise((resolve, reject) => {
            turnRequest.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            setTimeout(resolve, 5_000).unref();
          });
          return { text: "never" };
        },
      },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        const controller = new AbortController();
        const pending = client.respond(request({ abortSignal: controller.signal }), collectingStream().stream);
        setTimeout(() => controller.abort(), 50);

        await expect(pending).rejects.toSatisfy((error) => isAgentResponseCancelledError(error));
      },
    );
  });

  it("surfaces remote turn failures as typed errors with the server message", async () => {
    await withAdapter(
      {
        respond: async () => {
          throw new Error("model exploded");
        },
      },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });

        await expect(client.respond(request(), collectingStream().stream)).rejects.toMatchObject({
          name: "RemoteAgentResponderError",
          message: "model exploded",
        });
      },
    );
  });

  it("authenticates with a bearer key and rejects a missing one", async () => {
    await withAdapter(
      { respond: async () => ({ text: "ok" }) },
      async (adapter) => {
        const keyless = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        await expect(keyless.info()).rejects.toMatchObject({ code: "unauthorized" });

        const keyed = new RemoteAgentResponder({ baseUrl: adapter.baseUrl, apiKey: "fixture-secret" });
        await expect(keyed.info()).resolves.toMatchObject({ schema: 1 });
      },
      "fixture-secret",
    );
  });

  it("propagates explicit cancel to the adapter's cancel endpoint", async () => {
    const cancelled: string[] = [];
    await withAdapter(
      {
        respond: async () => ({ text: "ok" }),
        cancel: (conversationId) => void cancelled.push(conversationId),
      },
      async (adapter) => {
        const client = new RemoteAgentResponder({ baseUrl: adapter.baseUrl });
        client.cancel("tui:test");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(cancelled).toEqual(["tui:test"]);
      },
    );
  });

  it("fails fast with `unreachable` when no agent is listening", async () => {
    const client = new RemoteAgentResponder({ baseUrl: "http://127.0.0.1:1/gui" });

    await expect(client.info()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("rejects a stream that ends without a terminal frame", async () => {
    // A raw HTTP server that streams one append then closes mid-turn.
    const { createServer } = await import("node:http");
    const frames: AgentStreamWireFrame[] = [{ kind: "append", delta: "partial" }];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const frame of frames) {
        response.write(serializeAgentStreamFrame(frame));
      }
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` });
      await expect(client.respond(request(), collectingStream().stream)).rejects.toBeInstanceOf(
        RemoteAgentResponderError,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects an unterminated frame before its receive buffer can grow without bound", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end("x".repeat((1024 * 1024) + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new RemoteAgentResponder({ baseUrl: `http://127.0.0.1:${port}` });
      await expect(client.respond(request(), collectingStream().stream)).rejects.toMatchObject({
        code: "frame_too_large",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
