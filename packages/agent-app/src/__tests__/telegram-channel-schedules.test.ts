import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelegramChannelDriver, type ChannelStartInput } from "../channels.js";
import { startInteractionBridge, type InteractionBridgeHandle } from "../interaction-bridge.js";

const CONFIG = {
  enabled: true,
  botToken: "123456:secret",
  allowedChatIds: ["-1001"],
  allowAllChats: false,
  topicDirectory: { enabled: true },
  schedules: { enabled: true, maxSchedules: 20, minIntervalMinutes: 15 },
};

describe("Telegram driver topic directory and schedules", () => {
  let dir: string;
  let bridge: InteractionBridgeHandle;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tg-driver-schedules-"));
    bridge = await startInteractionBridge();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  });

  function startInput(config: Record<string, unknown>): ChannelStartInput<never> {
    return {
      config: config as never,
      coreConfig: {
        runtime: { model: { provider: "openai-codex", model: "gpt-5.5", reference: "openai-codex:gpt-5.5" } },
        tools: { allowedTools: [], disallowedTools: [] },
      } as never,
      responder: {} as never,
      cwd: dir,
      interaction: bridge,
      onFailure: vi.fn(),
    };
  }

  function driver(notify: ReturnType<typeof vi.fn>, captured: Array<Record<string, unknown>>) {
    return createTelegramChannelDriver({
      startAdapter: async (options) => {
        captured.push(options as unknown as Record<string, unknown>);
        return { stop: async () => undefined, notify, presentAsk: vi.fn(), updateAsk: vi.fn(), postStatus: vi.fn() } as never;
      },
    });
  }

  async function callSchedules(token: string, operation: string, args: unknown) {
    const response = await fetch(new URL("/v1/telegram-schedules", bridge.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation, args }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("persists observations, runs a due schedule in its topic, and releases everything on stop", async () => {
    const notify = vi.fn(async () => ({ delivered: true }));
    const captured: Array<Record<string, unknown>> = [];
    const first = await driver(notify, captured).start(startInput(CONFIG));
    expect(first.summary).toEqual({ topicDirectory: "on", schedules: "running" });
    expect(captured[0]?.knownTopicNames).toEqual([]);
    const observe = captured[0]?.onChatObserved as (observation: unknown) => void;
    observe({
      chatId: -1001,
      chatTitle: "Trips",
      topic: { messageThreadId: 77, nameRecord: { name: "Flights", source: "created", messageId: 77 } },
    });

    const capability = bridge.issueScheduleCapability({ runId: "run-1", producerConversationId: "telegram:-1001", mutate: true });
    const at = new Date(Date.now() + 5 * 60_000);
    const created = await callSchedules(capability.token, "create", {
      name: "Flight check",
      prompt: "Check BUD-LIS fares and report.",
      destination: { topic_name: "Flights" },
      schedule: { kind: "once", at: at.toISOString() },
    });
    expect(created.body).toMatchObject({ ok: true, result: { schedule: { destination: "Trips › Flights" } } });
    await first.stop();
    expect((await callSchedules(capability.token, "list", {})).status).toBe(503);

    // Restart 30 seconds after the due time: within the grace window, so it fires once.
    vi.useFakeTimers({ toFake: ["Date"], now: at.getTime() + 30_000 });
    const second = await driver(notify, captured).start(startInput(CONFIG));
    expect(captured[1]?.knownTopicNames).toEqual([
      { chatId: "-1001", messageThreadId: 77, nameRecord: { name: "Flights", source: "created", messageId: 77 } },
    ]);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const [destination, prompt, options] = notify.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
    expect(destination).toEqual({ chatId: -1001, messageThreadId: 77 });
    expect(prompt).toContain("Check BUD-LIS fares and report.");
    expect(options).toMatchObject({
      finalAnswerOnly: true,
      requestMetadata: { channelSchedule: { nativeNotify: { enabled: true } } },
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    await second.stop();
  });

  it("keeps Telegram running with schedules unavailable when the bridge is missing", async () => {
    const running = await createTelegramChannelDriver({
      startAdapter: async () => ({ stop: async () => undefined, notify: vi.fn() }) as never,
    }).start({ ...startInput(CONFIG), interaction: undefined } as never);
    expect(running.summary).toEqual({
      topicDirectory: "on",
      schedules: "unavailable: the interaction bridge is not running",
    });
    await running.stop();
  });

  it("leaves existing configs untouched", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const running = await driver(vi.fn(), captured).start(startInput({
      enabled: true,
      botToken: "123456:secret",
      allowedChatIds: ["-1001"],
      allowAllChats: false,
    }));
    expect(running.summary).toEqual({});
    expect(captured[0]).not.toHaveProperty("knownTopicNames");
    expect(captured[0]).not.toHaveProperty("onChatObserved");
    await running.stop();
  });
});
