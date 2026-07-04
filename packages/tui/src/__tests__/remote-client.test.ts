import { describe, expect, it } from "vitest";

import {
  isAgentResponseCancelledError,
  serializeAgentStreamFrame,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentStreamEvent,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";
import { startTuiAdapter, type TuiAdapterStartResult } from "@mono-agent/tui-adapter";

import { RemoteAgentResponder, RemoteAgentResponderError } from "../remote/client.js";

/**
 * Round-trip tests against the REAL tui-adapter server: the client half of the
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
    const client = new RemoteAgentResponder({ baseUrl: "http://127.0.0.1:1/tui" });

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
});
