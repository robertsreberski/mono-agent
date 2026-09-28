import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADAPTER_SEND_TOOLS_MCP_SERVER_NAME,
  adapterSendToolNames,
  createAdapterSendToolsRuntimeExtension,
  createAdapterSendToolsServer,
  resolveAdapterSendToolsSettings,
  type AdapterSendToolsSettings,
} from "../adapter-send-tools.js";
import { startInteractionBridge, type InteractionBridgeHandle } from "../interaction-bridge.js";
import {
  openTelegramTopicDirectory,
  resolveTelegramTopicDirectoryRoot,
  type TelegramTopicDirectoryStore,
} from "../telegram-topic-directory.js";

const SCHEDULE_TOOLS = ["TelegramListSchedules", "TelegramCreateSchedule", "TelegramUpdateSchedule", "TelegramDeleteSchedule"];
const HUMAN_REQUEST = {
  conversationId: "telegram:-1001",
  captureSpeakerKind: "human-turn",
  metadata: { telegram: { message: { id: 55 }, from: { id: 7 } } },
};
const SCHEDULED_REQUEST = {
  conversationId: "telegram:-1001:77",
  metadata: { telegram: { message: { id: 0 } }, channelSchedule: { scheduleId: "sch_1" } },
};

let dir: string;
let directory: TelegramTopicDirectoryStore | undefined;
const bridges: InteractionBridgeHandle[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tg-topic-tools-"));
});
afterEach(async () => {
  directory?.close();
  directory = undefined;
  await Promise.all(bridges.splice(0).map(async (bridge) => await bridge.stop()));
  await rm(dir, { recursive: true, force: true });
});

function issuer() {
  const released: string[] = [];
  const issued: Array<{ runId: string; producerConversationId: string; mutate: boolean }> = [];
  return {
    released,
    issued,
    issueDeliveryHistoryCapability: () => ({ url: "http://127.0.0.1:1", token: "history", release: () => {} }),
    issueScheduleCapability(input: { runId: string; producerConversationId: string; mutate: boolean }) {
      issued.push(input);
      return { url: "http://127.0.0.1:2", token: `schedule-${input.runId}`, release: () => released.push(input.runId) };
    },
  };
}

function childEnv(result: Awaited<ReturnType<ReturnType<typeof createAdapterSendToolsRuntimeExtension>>>) {
  const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as { env: Record<string, string> };
  return spec.env;
}

describe("schedule tool capability per request", () => {
  const tools = ["TelegramSendMessage", "TelegramListTopics", ...SCHEDULE_TOOLS];

  it("grants mutation only to a human Telegram turn", async () => {
    const bridge = issuer();
    const extension = createAdapterSendToolsRuntimeExtension(
      "/agent/mono-agent.config.json", "/agent", tools, undefined, undefined, undefined, bridge, "/agent/.mono-agent/telegram-topics-v1",
    );

    const human = await extension({ runId: "run-human", request: HUMAN_REQUEST });
    const humanEnv = childEnv(human);
    expect(JSON.parse(humanEnv.MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS!)).toEqual(tools);
    expect(humanEnv.MONO_AGENT_ADAPTER_TOOLS_SCHEDULE_BRIDGE_TOKEN).toBe("schedule-run-human");
    expect(humanEnv.MONO_AGENT_ADAPTER_TOOLS_TOPIC_DIRECTORY).toBe("/agent/.mono-agent/telegram-topics-v1");

    const scheduled = await extension({ runId: "run-scheduled", request: SCHEDULED_REQUEST });
    expect(JSON.parse(childEnv(scheduled).MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS!)).toEqual([
      "TelegramSendMessage",
      "TelegramListTopics",
      "TelegramListSchedules",
    ]);
    expect(bridge.issued).toEqual([
      { runId: "run-human", producerConversationId: "telegram:-1001", mutate: true },
      { runId: "run-scheduled", producerConversationId: "telegram:-1001:77", mutate: false },
    ]);

    await human.cleanup();
    await scheduled.cleanup();
    expect(bridge.released).toEqual(["run-human", "run-scheduled"]);
  });

  it("drops schedule tools when no capability can be issued", async () => {
    const extension = createAdapterSendToolsRuntimeExtension("/agent/mono-agent.config.json", "/agent", SCHEDULE_TOOLS);
    const result = await extension({ runId: "run-1", request: HUMAN_REQUEST });
    expect(result.runtimeOptions.mcpServers).toEqual({});
  });
});

describe("topic and schedule tool settings", () => {
  async function config(telegram: Record<string, unknown>): Promise<string> {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({
      telegram: { enabled: true, botToken: "123456:secret", allowedChatIds: ["-1001"], ...telegram },
    }), "utf8");
    return configPath;
  }

  it("exposes the new tools only when the feature and the policy both allow them", async () => {
    const allowedTools = ["TelegramSendMessage", "TelegramListTopics", ...SCHEDULE_TOOLS];
    const off = await resolveAdapterSendToolsSettings({ env: {}, cwd: dir, configPath: await config({}) }, { allowedTools });
    expect(off?.telegram?.tools).toEqual({ send: true, file: false });
    expect(off?.telegram?.topicDirectory).toBeUndefined();

    const on = await resolveAdapterSendToolsSettings({
      env: {},
      cwd: dir,
      configPath: await config({ topicDirectory: { enabled: true }, schedules: { enabled: true } }),
    }, { allowedTools });
    expect(adapterSendToolNames(on!)).toEqual(["TelegramSendMessage", "TelegramListTopics", ...SCHEDULE_TOOLS]);
    expect(on?.telegram?.topicDirectory).toEqual({ root: resolveTelegramTopicDirectoryRoot(dir), botId: "123456" });

    const listOnly = await resolveAdapterSendToolsSettings({
      env: {},
      cwd: dir,
      configPath: await config({ topicDirectory: { enabled: true }, schedules: { enabled: true } }),
    }, { allowedTools: ["TelegramListSchedules"], disallowedTools: ["TelegramCreateSchedule"] });
    expect(adapterSendToolNames(listOnly!)).toEqual(["TelegramListSchedules"]);
  });
});

describe("name-addressed Telegram tools", () => {
  async function seededSettings(): Promise<AdapterSendToolsSettings> {
    directory = await openTelegramTopicDirectory({ cwd: dir, botId: "123456" });
    directory.observe({
      chatId: -1001,
      chatTitle: "Trips",
      topic: { messageThreadId: 77, nameRecord: { name: "Flights", source: "created", messageId: 77 } },
    });
    directory.observe({ chatId: -1001, topic: { messageThreadId: 78 } });
    return {
      telegram: {
        botToken: "123456:secret",
        allowedChatIds: ["-1001"],
        allowAllChats: false,
        tools: { send: true, file: false, listTopics: true },
        topicDirectory: { root: resolveTelegramTopicDirectoryRoot(dir), botId: "123456" },
        producingConversationId: "telegram:-1001",
      },
    };
  }

  async function withClient<T>(settings: AdapterSendToolsSettings, sendMessage: ReturnType<typeof vi.fn>, fn: (client: Client) => Promise<T>) {
    const server = await createAdapterSendToolsServer(settings, { telegram: { sendMessage } });
    const client = new Client({ name: "topic-tools-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("lists known topics by name and status without ids", async () => {
    const settings = await seededSettings();
    await withClient(settings, vi.fn(), async (client) => {
      const result = await client.callTool({ name: "TelegramListTopics", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        chat_title: "Trips",
        topics: [{ name: "Flights", status: "open" }],
        unnamed_topics_seen: 1,
        incomplete: true,
      });
      expect(JSON.stringify(result)).not.toMatch(/\b7[78]\b/u);
      const other = await client.callTool({ name: "TelegramListTopics", arguments: { chat_id: "-2002" } });
      expect(other.isError).toBe(true);
    });
  });

  it("sends into a topic by name and never echoes its id", async () => {
    const settings = await seededSettings();
    const sendMessage = vi.fn(async (params: Record<string, unknown>) => ({
      message_id: 900,
      date: 0,
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: params.message_thread_id,
      is_topic_message: true,
    }));
    await withClient(settings, sendMessage, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: "-1001", text: "Fares are down.", topic_name: "flights" },
      });
      expect(result.isError).not.toBe(true);
      expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ message_thread_id: 77 });
      expect(result.structuredContent).toMatchObject({ topic_name: "Flights" });
      expect(result.structuredContent).not.toHaveProperty("message_thread_id");
      expect(JSON.stringify(result.content)).not.toMatch(/\b77\b/u);
    });
  });

  it("fails without falling back to General when the name is unknown or conflicting", async () => {
    const settings = await seededSettings();
    const sendMessage = vi.fn();
    await withClient(settings, sendMessage, async (client) => {
      const unknown = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: "-1001", text: "x", topic_name: "Trains" },
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain("Flights");
      expect(JSON.stringify(unknown.content)).toContain("send any message in that topic");
      const both = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: "-1001", text: "x", topic_name: "Flights", message_thread_id: 77 },
      });
      expect(both.isError).toBe(true);
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the original send schema when the directory is off", async () => {
    const settings: AdapterSendToolsSettings = {
      telegram: { botToken: "123456:secret", allowedChatIds: ["-1001"], allowAllChats: false, tools: { send: true, file: false } },
    };
    await withClient(settings, vi.fn(), async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["TelegramSendMessage"]);
      expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).not.toContain("topic_name");
    });
  });
});

describe("schedule tools over the bridge", () => {
  it("forwards arguments with the host-issued bearer and surfaces host errors", async () => {
    const bridge = await startInteractionBridge();
    bridges.push(bridge);
    const calls: unknown[] = [];
    bridge.registerScheduleHandler(async (operation, args, context) => {
      calls.push({ operation, args, context });
      return operation === "delete"
        ? { ok: false, code: "revision_conflict", error: "The schedule changed; list schedules again." }
        : { ok: true, result: { schedule: { id: "sch_1", revision: 1 } } };
    });
    const capability = bridge.issueScheduleCapability({ runId: "run-1", producerConversationId: "telegram:-1001", mutate: true });
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "123456:secret",
        allowedChatIds: ["-1001"],
        allowAllChats: false,
        tools: { send: false, file: false, createSchedule: true, deleteSchedule: true },
        scheduleBridge: { bridgeUrl: capability.url, bridgeToken: capability.token },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {});
    const client = new Client({ name: "schedule-tools-test", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["TelegramCreateSchedule", "TelegramDeleteSchedule"]);
      const args = {
        name: "Daily flight check",
        prompt: "Check fares.",
        destination: { topic_name: "Flights" },
        schedule: { kind: "cron", expression: "0 8 * * *", timezone: "Europe/Budapest" },
      };
      const created = await client.callTool({ name: "TelegramCreateSchedule", arguments: args });
      expect(created.structuredContent).toEqual({ schedule: { id: "sch_1", revision: 1 } });
      const deleted = await client.callTool({ name: "TelegramDeleteSchedule", arguments: { id: "sch_1", expectedRevision: 1 } });
      expect(deleted.isError).toBe(true);
      expect(JSON.stringify(deleted.content)).toContain("list schedules again");
      expect(calls[0]).toEqual({
        operation: "create",
        args,
        context: { runId: "run-1", producerConversationId: "telegram:-1001", mutate: true },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
