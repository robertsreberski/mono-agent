import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { SlackSocketModeRunner } from "../socket-mode-runner.js";
import type {
  SlackChatPostMessageParams,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackSocketModeEnvelope,
  SlackWebApi,
} from "../types.js";

class FakeSlackApi implements SlackWebApi {
  readonly opened: string[] = [];
  private nextUrlIndex = 0;

  constructor(private readonly urls: readonly string[]) {}

  async authTest() {
    return { ok: true as const };
  }

  async appsConnectionsOpen() {
    const url = this.urls[this.nextUrlIndex] ?? this.urls.at(-1) ?? "wss://slack.test/default";
    this.nextUrlIndex += 1;
    this.opened.push(url);
    return { ok: true as const, url };
  }

  async chatPostMessage(_params: SlackChatPostMessageParams) {
    return { ok: true as const, channel: "C1", ts: "171.1" };
  }

  async chatUpdate(params: SlackChatUpdateParams) {
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }

  async downloadFile() {
    return new Uint8Array();
  }
}

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];
  closed = false;
  pings = 0;
  terminated = false;
  /** When true, each ping() synchronously echoes a pong (a responsive peer). */
  respondToPing = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  ping(): void {
    this.pings += 1;
    if (this.respondToPing) {
      this.emit("pong");
    }
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitMessage(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

describe("SlackSocketModeRunner", () => {
  it("opens Socket Mode, acknowledges events, and dispatches event callbacks", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const handled: SlackEventCallback[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: {
        async handleEventCallback(callback) {
          handled.push(callback);
          return { kind: "handled", eventId: callback.event_id, channelId: "C1", action: "responded", trigger: "direct" };
        },
      },
      webSocketFactory: (url) => {
        expect(url).toBe("wss://slack.test/1");
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage(socketEnvelope("E1", eventCallback("Ev1")));
    await vi.waitFor(() => expect(handled).toHaveLength(1));
    controller.abort();
    await started;

    expect(api.opened).toEqual(["wss://slack.test/1"]);
    expect(sockets[0]?.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
      { envelope_id: "E1" },
    ]);
    expect(handled[0]?.event_id).toBe("Ev1");
  });

  it("acknowledges unsupported envelopes without dispatching", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const handler = { handleEventCallback: vi.fn() };
    const runner = new SlackSocketModeRunner({
      api,
      handler,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({ envelope_id: "E-ignore", type: "slash_commands", payload: { command: "/x" } });
    await vi.waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    controller.abort();
    await started;

    expect(handler.handleEventCallback).not.toHaveBeenCalled();
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ envelope_id: "E-ignore" });
  });

  it("reconnects after Slack refresh disconnects", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitMessage({ type: "disconnect", reason: "refresh_requested" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    controller.abort();
    await started;

    expect(api.opened).toEqual(["wss://slack.test/1", "wss://slack.test/2"]);
  });

  it("backs off before reconnecting after too_many_websockets disconnects", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        reconnect: { initialMs: 1000, maxMs: 1000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });

      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      controller.abort();
      await started;

      expect(api.opened).toEqual(["wss://slack.test/1", "wss://slack.test/2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recycles a silently dead socket via the heartbeat watchdog", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        reconnect: { initialMs: 0, maxMs: 0 },
        heartbeat: { intervalMs: 1000, timeoutMs: 3000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();

      // The peer goes silent (no message/ping/pong). The watchdog probes...
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets[0]?.pings).toBeGreaterThan(0);
      expect(sockets).toHaveLength(1);

      // ...and after the timeout window with no activity, force-recycles it,
      // which triggers a reconnect.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(sockets[0]?.terminated).toBe(true);

      controller.abort();
      await started;
      expect(api.opened).toEqual(["wss://slack.test/1", "wss://slack.test/2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recycle a responsive socket that answers heartbeats", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => {
          const socket = new FakeWebSocket();
          socket.respondToPing = true; // healthy peer pongs every probe
          sockets.push(socket);
          return socket;
        },
        reconnect: { initialMs: 0, maxMs: 0 },
        heartbeat: { intervalMs: 1000, timeoutMs: 3000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();

      // Far past the timeout window, but pongs keep refreshing activity.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets[0]?.pings).toBeGreaterThan(0);
      expect(sockets[0]?.terminated).toBe(false);
      expect(sockets).toHaveLength(1);

      controller.abort();
      await started;
      expect(api.opened).toEqual(["wss://slack.test/1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

function eventCallback(eventId: string): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: eventId,
    event_time: 171,
    event: {
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "hello",
      ts: "171.000001",
      event_ts: "171.000001",
    },
  };
}
