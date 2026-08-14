import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SlackEventHandlingResult } from "../adapter.js";
import {
  SlackSocketModeRunner,
  type SlackSocketModeRunnerOptions,
} from "../socket-mode-runner.js";
import type {
  SlackChatPostMessageParams,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackInteractivityPayload,
  SlackSlashCommandPayload,
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
  sendError: unknown = undefined;
  closed = false;
  pings = 0;
  terminated = false;
  /** When true, each ping() synchronously echoes a pong (a responsive peer). */
  respondToPing = false;
  /** When true, terminate() marks terminated but emits no "close" (a wedged socket). */
  silentTerminate = false;

  send(data: string): void {
    if (this.sendError !== undefined) {
      throw this.sendError;
    }
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
    if (!this.silentTerminate) {
      this.close();
    }
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

  it("acknowledges a concurrent duplicate but admits it only once while the handler is unresolved", async () => {
    const held = createDeferred<SlackEventHandlingResult>();
    const handler = vi.fn(async () => await held.promise);
    const onEventResult = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: { handleEventCallback: handler },
      onEventResult,
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      socket.emitMessage(socketEnvelope("E-first", eventCallback("Ev-concurrent")));
      socket.emitMessage(socketEnvelope("E-retry", eventCallback("Ev-concurrent")));

      expect(socket.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
        { envelope_id: "E-first" },
        { envelope_id: "E-retry" },
      ]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(onEventResult).not.toHaveBeenCalled();

      held.resolve(handledResult("Ev-concurrent"));
      await vi.waitFor(() => expect(onEventResult).toHaveBeenCalledTimes(1));
    } finally {
      controller.abort();
      await started;
    }
  });

  it("keys exact event ids and treats retry metadata as logging context, never admission input", async () => {
    const handled: string[] = [];
    const info = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: {
        async handleEventCallback(callback) {
          handled.push(callback.event_id);
          return handledResult(callback.event_id);
        },
      },
      logger: { info },
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      socket.emitMessage(socketEnvelope("E-1", eventCallback("Ev-exact")));
      socket.emitMessage({
        ...socketEnvelope("E-2", eventCallback("Ev-exact")),
        retry_attempt: 1,
        retry_reason: "http_timeout",
      });
      socket.emitMessage({
        ...socketEnvelope("E-3", eventCallback(" Ev-exact ")),
        retry_attempt: 1,
        retry_reason: "http_timeout",
      });
      socket.emitMessage({
        ...socketEnvelope("E-4", eventCallback("Ev-distinct")),
        retry_attempt: 1,
        retry_reason: "http_timeout",
      });
      socket.emitMessage({
        ...socketEnvelope("E-5", eventCallback("Ev-distinct")),
        retry_attempt: "2",
        retry_reason: 2,
      });

      await vi.waitFor(() => expect(handled).toEqual([
        "Ev-exact",
        " Ev-exact ",
        "Ev-distinct",
      ]));
      expect(info.mock.calls).toEqual([
        [
          "Suppressed duplicate Slack event callback.",
          { eventId: "Ev-exact", retryAttempt: 1, retryReason: "http_timeout" },
        ],
        [
          "Suppressed duplicate Slack event callback.",
          { eventId: "Ev-distinct" },
        ],
      ]);
    } finally {
      controller.abort();
      await started;
    }
  });

  it("admits an event again at the exact ten-minute boundary without refreshing TTL on a hit", async () => {
    let now = 100;
    const handled: string[] = [];
    const { runner, sockets } = buildTestRunner({
      handler: {
        async handleEventCallback(callback) {
          handled.push(callback.event_id);
          return handledResult(callback.event_id);
        },
      },
      eventDedupeNow: () => now,
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      socket.emitMessage(socketEnvelope("E-1", eventCallback("Ev-ttl")));
      now += 10 * 60_000 - 1;
      socket.emitMessage(socketEnvelope("E-2", eventCallback("Ev-ttl")));
      expect(handled).toEqual(["Ev-ttl"]);

      now += 1;
      socket.emitMessage(socketEnvelope("E-3", eventCallback("Ev-ttl")));
      expect(handled).toEqual(["Ev-ttl", "Ev-ttl"]);
    } finally {
      controller.abort();
      await started;
    }
  });

  it("evicts the oldest event at the 10,000-entry FIFO cap and warns only once", async () => {
    let handled = 0;
    const warn = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: {
        async handleEventCallback(callback) {
          handled += 1;
          return handledResult(callback.event_id);
        },
      },
      eventDedupeNow: () => 0,
      logger: { warn },
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      for (let index = 0; index < 10_000; index += 1) {
        socket.emitMessage(socketEnvelope(`E-${String(index)}`, eventCallback(`Ev-${String(index)}`)));
      }
      expect(handled).toBe(10_000);
      expect(warn).not.toHaveBeenCalled();

      socket.emitMessage(socketEnvelope("E-newest", eventCallback("Ev-newest")));
      expect(handled).toBe(10_001);
      expect(warn.mock.calls).toEqual([[
        "Slack event callback dedupe cache reached its cap; bounded at-most-once guarantee is degraded.",
        { maxEntries: 10_000 },
      ]]);

      socket.emitMessage(socketEnvelope("E-oldest-replay", eventCallback("Ev-0")));
      socket.emitMessage(socketEnvelope("E-newest-replay", eventCallback("Ev-newest")));
      expect(handled).toBe(10_002);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await started;
    }
  });

  it("retains admitted ids across a reconnect", async () => {
    const handler = vi.fn(async (callback: SlackEventCallback) => handledResult(callback.event_id));
    const { runner, sockets } = buildTestRunner(
      { handler: { handleEventCallback: handler } },
      ["wss://slack.test/1", "wss://slack.test/2"],
    );
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitMessage(socketEnvelope("E-original", eventCallback("Ev-reconnect")));
      expect(handler).toHaveBeenCalledTimes(1);
      sockets[0]?.emitMessage({ type: "disconnect", reason: "refresh_requested" });
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      sockets[1]?.emitMessage(socketEnvelope("E-replay", eventCallback("Ev-reconnect")));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(sockets[1]?.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
        { envelope_id: "E-replay" },
      ]);
    } finally {
      controller.abort();
      await started;
    }
  });

  it("retains admitted ids across repeated start calls while a fresh runner starts empty", async () => {
    const handler = vi.fn(async (callback: SlackEventCallback) => handledResult(callback.event_id));
    const reused = buildTestRunner({ handler: { handleEventCallback: handler } });
    const firstController = new AbortController();
    const firstStart = reused.runner.start({ signal: firstController.signal });
    await vi.waitFor(() => expect(reused.sockets).toHaveLength(1));
    reused.sockets[0]?.emitMessage(socketEnvelope("E-first", eventCallback("Ev-reused")));
    expect(handler).toHaveBeenCalledTimes(1);
    firstController.abort();
    await firstStart;

    const secondController = new AbortController();
    const secondStart = reused.runner.start({ signal: secondController.signal });
    try {
      await vi.waitFor(() => expect(reused.sockets).toHaveLength(2));
      reused.sockets[1]?.emitMessage(socketEnvelope("E-second", eventCallback("Ev-reused")));
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      secondController.abort();
      await secondStart;
    }

    const fresh = buildTestRunner({ handler: { handleEventCallback: handler } });
    const freshController = new AbortController();
    const freshStart = fresh.runner.start({ signal: freshController.signal });
    try {
      await vi.waitFor(() => expect(fresh.sockets).toHaveLength(1));
      fresh.sockets[0]?.emitMessage(socketEnvelope("E-fresh", eventCallback("Ev-reused")));
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      freshController.abort();
      await freshStart;
    }
  });

  it("leaves an event eligible after ack failure", async () => {
    const handler = vi.fn(async (callback: SlackEventCallback) => handledResult(callback.event_id));
    const error = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: { handleEventCallback: handler },
      logger: { error },
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      socket.sendError = new Error("ack failed");
      socket.emitMessage(socketEnvelope("E-failed-ack", eventCallback("Ev-ack")));
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      expect(handler).not.toHaveBeenCalled();

      socket.sendError = undefined;
      socket.emitMessage(socketEnvelope("E-successful-ack", eventCallback("Ev-ack")));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(socket.sent.map((raw) => JSON.parse(raw) as unknown)).toEqual([
        { envelope_id: "E-successful-ack" },
      ]);
    } finally {
      controller.abort();
      await started;
    }
  });

  it("retains admission after handler and event-result failures", async () => {
    const handler = vi.fn(async (callback: SlackEventCallback) => {
      if (callback.event_id === "Ev-handler-failure") {
        throw new Error("handler failed");
      }
      return handledResult(callback.event_id);
    });
    const onEventResult = vi.fn(async () => {
      throw new Error("event result failed");
    });
    const error = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: { handleEventCallback: handler },
      onEventResult,
      logger: { error },
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      socket.emitMessage(socketEnvelope("E-handler-1", eventCallback("Ev-handler-failure")));
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      socket.emitMessage(socketEnvelope("E-handler-2", eventCallback("Ev-handler-failure")));
      expect(handler).toHaveBeenCalledTimes(1);

      socket.emitMessage(socketEnvelope("E-result-1", eventCallback("Ev-result-failure")));
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
      socket.emitMessage(socketEnvelope("E-result-2", eventCallback("Ev-result-failure")));
      expect(handler).toHaveBeenCalledTimes(2);
      expect(onEventResult).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await started;
    }
  });

  it("fails open for blank string ids but keeps missing and non-string ids on the existing non-dispatch path", async () => {
    const handled: string[] = [];
    const debug = vi.fn();
    const info = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: {
        async handleEventCallback(callback) {
          handled.push(callback.event_id);
          return handledResult(callback.event_id);
        },
      },
      logger: { debug, info },
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const socket = sockets[0]!;
      for (const [index, eventId] of ["", "", "   ", "   "].entries()) {
        socket.emitMessage(socketEnvelope(`E-blank-${String(index)}`, eventCallback(eventId)));
      }
      const missingId: Partial<SlackEventCallback> = { ...eventCallback("unused") };
      delete missingId.event_id;
      socket.emitMessage({ envelope_id: "E-missing", type: "events_api", payload: missingId });
      socket.emitMessage({
        envelope_id: "E-non-string",
        type: "events_api",
        payload: { ...eventCallback("unused"), event_id: 42 },
      });

      await vi.waitFor(() => expect(handled).toEqual(["", "", "   ", "   "]));
      expect(socket.sent).toHaveLength(6);
      expect(debug.mock.calls).toEqual(Array.from({ length: 4 }, () => [
        "Slack event callback has no usable event ID; bypassing dedupe.",
        { hasEventId: false },
      ]));
      expect(info).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await started;
    }
  });

  it("logs suppressed duplicates with only the permitted transport metadata", async () => {
    const info = vi.fn();
    const { runner, sockets } = buildTestRunner({
      handler: {
        async handleEventCallback(callback) {
          return handledResult(callback.event_id);
        },
      },
      logger: { info },
    });
    const controller = new AbortController();
    const started = runner.start({ signal: controller.signal });

    try {
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      const callback: SlackEventCallback = {
        ...eventCallback("Ev-safe"),
        team_id: "TEAM_SENTINEL",
        event_time: 987_654_321,
        event: {
          type: "message",
          channel: "CHANNEL_SENTINEL",
          user: "USER_SENTINEL",
          text: "PAYLOAD_TEXT_SENTINEL",
          ts: "TIMESTAMP_SENTINEL",
        },
      };
      sockets[0]?.emitMessage(socketEnvelope("ENVELOPE_SENTINEL_1", callback));
      sockets[0]?.emitMessage({
        ...socketEnvelope("ENVELOPE_SENTINEL_2", callback),
        retry_attempt: 3,
        retry_reason: "http_timeout",
      });

      expect(info.mock.calls).toEqual([[
        "Suppressed duplicate Slack event callback.",
        { eventId: "Ev-safe", retryAttempt: 3, retryReason: "http_timeout" },
      ]]);
      const serialized = JSON.stringify(info.mock.calls);
      expect(serialized).not.toContain("TEAM_SENTINEL");
      expect(serialized).not.toContain("CHANNEL_SENTINEL");
      expect(serialized).not.toContain("USER_SENTINEL");
      expect(serialized).not.toContain("PAYLOAD_TEXT_SENTINEL");
      expect(serialized).not.toContain("TIMESTAMP_SENTINEL");
      expect(serialized).not.toContain("ENVELOPE_SENTINEL");
    } finally {
      controller.abort();
      await started;
    }
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

  it("acknowledges and routes valid slash-command envelopes", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const commands: SlackSlashCommandPayload[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      onSlashCommand: (payload) => {
        commands.push(payload);
      },
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
    sockets[0]?.emitMessage({
      envelope_id: "E-command",
      type: "slash_commands",
      payload: {
        command: "/mickey-model",
        text: "default",
        channel_id: "C1",
        user_id: "U1",
      },
    });
    await vi.waitFor(() => expect(commands).toHaveLength(1));
    controller.abort();
    await started;

    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ envelope_id: "E-command" });
    expect(commands[0]).toMatchObject({
      command: "/mickey-model",
      text: "default",
      channel_id: "C1",
    });
  });

  it("acknowledges interactive envelopes and routes shortcut payloads to onInteraction", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const interactions: SlackInteractivityPayload[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: {
        async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        },
      },
      onInteraction: (payload) => {
        interactions.push(payload);
      },
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
    sockets[0]?.emitMessage({
      envelope_id: "E-sc",
      type: "interactive",
      payload: { type: "shortcut", callback_id: "sync_now", trigger_id: "T1", user: { id: "U1" } },
    });
    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    controller.abort();
    await started;

    // The interactive envelope is acked, and the shortcut payload is routed.
    expect(JSON.parse(sockets[0]?.sent[0] ?? "{}")).toEqual({ envelope_id: "E-sc" });
    expect(interactions[0]?.callback_id).toBe("sync_now");
  });

  it("routes block_actions (button) payloads to onInteraction too", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1"]);
    const sockets: FakeWebSocket[] = [];
    const interactions: SlackInteractivityPayload[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: {
        async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        },
      },
      onInteraction: (payload) => {
        interactions.push(payload);
      },
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
    sockets[0]?.emitMessage({
      envelope_id: "E-ba",
      type: "interactive",
      payload: { type: "block_actions", actions: [{ action_id: "sync_now" }], user: { id: "U1" } },
    });
    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    controller.abort();
    await started;

    expect(interactions[0]?.type).toBe("block_actions");
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
        // jitterRatio: 0 keeps the backoff deterministic for the exact-timing assertions.
        reconnect: { initialMs: 1000, maxMs: 1000, jitterRatio: 0 },
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

  it("terminates (not just closes) the old socket on a too_many_websockets disconnect", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
      reconnect: { initialMs: 0, maxMs: 0 },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    // A throttled/half-dead peer never completes the close handshake; terminate()
    // drops the TCP connection immediately so Slack's per-app budget frees.
    expect(sockets[0]?.terminated).toBe(true);
    controller.abort();
    await started;
  });

  it("reports degraded via onConnectionLost exactly once on a non-refresh disconnect", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const lost: string[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
      reconnect: { initialMs: 0, maxMs: 0 },
      onConnectionLost: (reason) => { lost.push(reason); },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
    await vi.waitFor(() => expect(lost).toEqual(["too_many_websockets"]));
    controller.abort();
    await started;
  });

  it("treats a warning disconnect as a graceful refresh — reconnects with no backoff and no degraded signal", async () => {
    const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
    const sockets: FakeWebSocket[] = [];
    const lost: string[] = [];
    const runner = new SlackSocketModeRunner({
      api,
      handler: { async handleEventCallback() {
        return { kind: "ignored", reason: "unsupported_event" };
      } },
      webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
      // Large backoff: if "warning" wrongly took the backoff path, this would stall.
      reconnect: { initialMs: 60_000, maxMs: 60_000 },
      onConnectionLost: (reason) => { lost.push(reason); },
    });
    const controller = new AbortController();

    const started = runner.start({ signal: controller.signal });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.emitOpen();
    sockets[0]?.emitMessage({ type: "disconnect", reason: "warning" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(lost).toEqual([]);
    expect(sockets[0]?.terminated).toBe(false);
    controller.abort();
    await started;
  });

  it("fires onConnectionRestored only after a reconnect survives the stability window, never on first connect", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const lost: string[] = [];
      let restored = 0;
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 0, maxMs: 0, stabilityMs: 5000 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        onConnectionLost: (reason) => { lost.push(reason); },
        onConnectionRestored: () => { restored += 1; },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      // First connect crosses the stability window but must NOT fire restored
      // (it was never degraded).
      await vi.advanceTimersByTimeAsync(5000);
      expect(restored).toBe(0);

      // Lose the connection, reconnect, and stay open past the stability window.
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.waitFor(() => expect(lost).toEqual(["too_many_websockets"]));
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      sockets[1]?.emitOpen();
      await vi.advanceTimersByTimeAsync(4999);
      expect(restored).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(restored).toBe(1);

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reset backoff when a connection drops before the stability window (graceful refresh included)", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi([
        "wss://slack.test/1", "wss://slack.test/2", "wss://slack.test/3", "wss://slack.test/4",
      ]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 1000, maxMs: 8000, stabilityMs: 60_000, jitterRatio: 0.2 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        random: () => 0.5, // mid-band jitter → jittered delay === base
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      // Backoff #1 === 1000.
      await vi.advanceTimersByTimeAsync(999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      // A graceful refresh BEFORE the stability window must NOT reset backoff.
      sockets[1]?.emitOpen();
      sockets[1]?.emitMessage({ type: "disconnect", reason: "refresh_requested" });
      await vi.waitFor(() => expect(sockets).toHaveLength(3));

      // So the next too_many backs off at 2000, not a reset-to-1000.
      sockets[2]?.emitOpen();
      sockets[2]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(sockets).toHaveLength(4));

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies band jitter to the reconnect delay via the injected RNG", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2"]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 1000, maxMs: 1000, stabilityMs: 60_000, jitterRatio: 0.2 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        random: () => 0, // low end of the band → delay === base * (1 - 0.2) === 800
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      // Un-jittered the delay would be 1000; jitter pulls it down to 800. Assert
      // hard at the boundary (no waitFor, which would auto-advance and mask it).
      await vi.advanceTimersByTimeAsync(799);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a wedged socket via the drain deadline when a recycled socket emits no close", async () => {
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
          const s = new FakeWebSocket();
          s.silentTerminate = true; // terminate() leaves the promise unsettled
          sockets.push(s);
          return s;
        },
        reconnect: { initialMs: 0, maxMs: 0, drainDeadlineMs: 2000 },
        heartbeat: { intervalMs: 1000, timeoutMs: 2000 },
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();

      // Silent peer → heartbeat recycles via terminate(), which emits no close.
      await vi.advanceTimersByTimeAsync(1000); // probe
      await vi.advanceTimersByTimeAsync(1000); // silence timeout → terminate (no close)
      expect(sockets[0]?.terminated).toBe(true);
      expect(sockets).toHaveLength(1); // would wedge here without the drain deadline

      await vi.advanceTimersByTimeAsync(2000); // drain deadline → force settle → reconnect
      await vi.waitFor(() => expect(sockets).toHaveLength(2));

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the degraded signal during the startup grace window but reports it once connected", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi(["wss://slack.test/1", "wss://slack.test/2", "wss://slack.test/3"]);
      const sockets: FakeWebSocket[] = [];
      const lost: string[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        reconnect: { initialMs: 1000, maxMs: 1000, startupGraceMs: 5000, stabilityMs: 60_000 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        onConnectionLost: (reason) => { lost.push(reason); },
        random: () => 0.5,
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      // A too_many BEFORE the first open, inside the grace window: a lingering
      // prior-process socket — retry quietly, do not flag degraded.
      sockets[0]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(lost).toEqual([]);

      // Once actually connected, a drop IS a real degradation.
      sockets[1]?.emitOpen();
      sockets[1]?.emitMessage({ type: "disconnect", reason: "too_many_websockets" });
      await vi.waitFor(() => expect(lost).toEqual(["too_many_websockets"]));

      controller.abort();
      await started;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate-limits graceful reconnects via the floor so a warning storm cannot busy-loop", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeSlackApi([
        "wss://slack.test/1", "wss://slack.test/2", "wss://slack.test/3",
      ]);
      const sockets: FakeWebSocket[] = [];
      const runner = new SlackSocketModeRunner({
        api,
        handler: { async handleEventCallback() {
          return { kind: "ignored", reason: "unsupported_event" };
        } },
        webSocketFactory: () => { const s = new FakeWebSocket(); sockets.push(s); return s; },
        // The graceful path normally reconnects immediately; the floor caps the rate
        // so an immediate-warning storm cannot spin at zero delay.
        reconnect: { initialMs: 0, maxMs: 0, gracefulReconnectFloorMs: 500 },
        heartbeat: { intervalMs: 0, timeoutMs: 0 },
        random: () => 0.5, // mid-band → floor delay === 500
      });
      const controller = new AbortController();

      const started = runner.start({ signal: controller.signal });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.emitOpen();
      sockets[0]?.emitMessage({ type: "disconnect", reason: "warning" });
      await vi.advanceTimersByTimeAsync(499);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);

      controller.abort();
      await started;
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

function handledResult(eventId: string): SlackEventHandlingResult {
  return {
    kind: "handled",
    eventId,
    channelId: "C1",
    action: "responded",
    trigger: "direct",
  };
}

function buildTestRunner(
  options: Omit<SlackSocketModeRunnerOptions, "api" | "webSocketFactory">,
  urls: readonly string[] = ["wss://slack.test/1"],
): {
  readonly runner: SlackSocketModeRunner;
  readonly sockets: FakeWebSocket[];
} {
  const sockets: FakeWebSocket[] = [];
  const runner = new SlackSocketModeRunner({
    api: new FakeSlackApi(urls),
    reconnect: { initialMs: 0, maxMs: 0, gracefulReconnectFloorMs: 0 },
    heartbeat: { intervalMs: 0, timeoutMs: 0 },
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { runner, sockets };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
