import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { startSlackAdapter, type SlackAdapterStartOptions } from "../start.js";
import type {
  AgentRequest,
  AgentResponder,
} from "../adapter.js";
import type {
  SlackChatPostMessageParams,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackSocketModeEnvelope,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly opened: string[] = [];
  readonly postMessageCalls: SlackChatPostMessageParams[] = [];
  readonly updateCalls: SlackChatUpdateParams[] = [];

  async authTest() {
    return { ok: true as const };
  }

  async appsConnectionsOpen() {
    const url = "wss://slack.test/socket";
    this.opened.push(url);
    return { ok: true as const, url };
  }

  async chatPostMessage(params: SlackChatPostMessageParams) {
    this.postMessageCalls.push(params);
    return { ok: true as const, channel: params.channel, ts: "200.000001" };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    this.updateCalls.push(params);
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }
}

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function responderFrom(
  fn: (request: AgentRequest) => Promise<{ text: string }>,
): AgentResponder {
  return { respond: async (request) => fn(request) };
}

describe("startSlackAdapter", () => {
  it("wires the client, adapter, and runner with a single call using an injected transport", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const createApi = vi.fn(() => api);
    const seen: AgentRequest[] = [];

    const started = await startSlackAdapter(buildOptions({
      createApi,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async (request) => {
        seen.push(request);
        return { text: `echo: ${request.text}` };
      }),
    }));

    try {
      // The factory was used instead of a real Slack client.
      expect(createApi).toHaveBeenCalledTimes(1);
      expect(started.api).toBe(api);

      // The runner opened a Socket Mode connection through the fake transport.
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      expect(api.opened).toEqual(["wss://slack.test/socket"]);
      const socket = sockets[0];
      if (socket === undefined) {
        throw new Error("expected a socket");
      }
      socket.emitOpen();

      // A fake inbound DM is routed to the responder.
      socket.emitMessage(socketEnvelope("E1", directMessage("hello there")));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]?.text).toBe("hello there");
      expect(seen[0]?.channelId).toBe("D1");

      // The envelope was acknowledged, a status message was posted, and the
      // final responder text was flushed to that message via chatUpdate.
      expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ envelope_id: "E1" });
      expect(api.postMessageCalls.length).toBeGreaterThan(0);
      await vi.waitFor(() =>
        expect(api.updateCalls.some((call) => call.text === "echo: hello there")).toBe(true),
      );
    } finally {
      await started.stop();
    }

    // stop() tore the connection down: the socket is closed, no open handles.
    expect(sockets[0]?.closed).toBe(true);
  });

  it("stop() is idempotent and tears down the runner loop", async () => {
    const api = new FakeSlackApi();
    const sockets: FakeWebSocket[] = [];
    const started = await startSlackAdapter(buildOptions({
      createApi: () => api,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      responder: responderFrom(async () => ({ text: "ok" })),
    }));

    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await started.stop();
    await expect(started.stop()).resolves.toBeUndefined();
    expect(sockets[0]?.closed).toBe(true);
  });

  it("fails closed when no responder is provided", async () => {
    await expect(
      // @ts-expect-error intentional missing responder
      startSlackAdapter({ botToken: "bot-token", appToken: "app-token", allowAllChannels: true }),
    ).rejects.toThrow(/responder/);
  });

  it("fails closed when neither allowedChannelIds nor allowAllChannels is set", async () => {
    await expect(
      startSlackAdapter({
        botToken: "bot-token",
        appToken: "app-token",
        createApi: () => new FakeSlackApi(),
        responder: responderFrom(async () => ({ text: "ok" })),
      }),
    ).rejects.toThrow(/allowedChannelIds/);
  });
});

function buildOptions(
  overrides: Partial<SlackAdapterStartOptions> & Pick<SlackAdapterStartOptions, "responder">,
): SlackAdapterStartOptions {
  return {
    botToken: "test-bot-token",
    appToken: "test-app-token",
    allowAllChannels: true,
    reconnect: { initialMs: 0, maxMs: 0 },
    ...overrides,
  };
}

function socketEnvelope(
  envelopeId: string,
  callback: SlackEventCallback,
): SlackSocketModeEnvelope {
  return {
    envelope_id: envelopeId,
    type: "events_api",
    accepts_response_payload: false,
    payload: callback,
  };
}

function directMessage(text: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 171,
    event: {
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text,
      ts: "171.000001",
      event_ts: "171.000001",
    },
  };
}
