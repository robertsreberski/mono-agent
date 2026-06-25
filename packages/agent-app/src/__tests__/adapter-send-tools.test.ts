import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { SlackAdapter } from "@mono-agent/slack-adapter";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
  SlackChatUpdateParams,
  SlackEventCallback,
  SlackWebApi,
} from "@mono-agent/slack-adapter";
import type {
  TelegramSendMessageParams,
  TelegramSentMessage,
} from "@mono-agent/telegram-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelDriver } from "../channels.js";
import { startMonoAgentApp } from "../app.js";
import {
  ADAPTER_SEND_TOOLS_MCP_SERVER_NAME,
  adapterSendToolsChildConfigFromEnv,
  adapterSendToolNames,
  adapterSendToolsMcpEnv,
  adapterSendToolsMcpServerSpec,
  createAdapterSendToolsServer,
  resolveAdapterSendToolsSettings,
} from "../adapter-send-tools.js";
import type { AdapterSendToolsSettings } from "../adapter-send-tools.js";
import { lookupProducingConversation, resolvePostedMessageIndexPath } from "../posted-message-index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-adapter-send-tools-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\nTest agent.\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveAdapterSendToolsSettings", () => {
  it("returns undefined when Slack and Telegram are disabled", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings({ env: {}, cwd: dir, configPath });

    expect(settings).toBeUndefined();
  });

  it("returns enabled Slack and Telegram send tool settings when the tool policy allows them", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        allowedChannelIds: ["C1", "D2"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42", "-100"],
      },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["slack_send_message", "telegram_send_message"] },
    );

    expect(settings).toEqual({
      slack: {
        botToken: "xoxb-slack",
        allowedChannelIds: ["c1", "d2"],
        allowAllChannels: false,
      },
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42", "-100"],
        allowAllChats: false,
        tools: { send: true, ask: false, document: false, photo: false },
      },
    });
    expect(adapterSendToolNames(settings!)).toEqual(["slack_send_message", "telegram_send_message"]);
  });

  it("does not expose send tools unless tool policy explicitly allows them", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        allowedChannelIds: ["C1"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
      },
    });

    await expect(resolveAdapterSendToolsSettings({ env: {}, cwd: dir, configPath })).resolves.toBeUndefined();
    await expect(resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["slack_send_message"], disallowedTools: ["slack_send_message"] },
    )).resolves.toBeUndefined();
    await expect(resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      {
        allowedTools: ["mcp__mono-agent-adapter-send__*"],
        disallowedTools: ["mcp__mono-agent-adapter-send__*"],
      },
    )).resolves.toBeUndefined();
  });

  it("exposes telegram_ask (and not telegram_send_message) when only the ask tool is allowed", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["telegram_ask"] },
    );

    expect(settings?.telegram).toMatchObject({ tools: { send: false, ask: true } });
    expect(adapterSendToolNames(settings!)).toEqual(["telegram_ask"]);
  });

  it("skips an invalid enabled adapter without exposing a partial broken tool", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      slack: { enabled: true, botToken: "xoxb-slack", appToken: "xapp-slack" },
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });
    const warnings: string[] = [];

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      {
        allowedTools: ["slack_send_message", "telegram_send_message"],
        logger: { warn: (message) => { warnings.push(message); } },
      },
    );

    expect(settings?.slack).toBeUndefined();
    expect(settings?.telegram).toMatchObject({ botToken: "telegram-token", allowedChatIds: ["42"] });
    expect(warnings).toEqual(["Slack send tool skipped because Slack adapter config is unavailable."]);
  });
});

describe("adapter send tools MCP spec/env", () => {
  it("passes only the config path through child-process env and points at the adapter-send entrypoint", () => {
    const allowedTools = ["slack_send_message"];
    const env = adapterSendToolsMcpEnv("/agent/mono-agent.config.json", allowedTools);
    const spec = adapterSendToolsMcpServerSpec("/agent/mono-agent.config.json", "/agent", allowedTools);

    expect(adapterSendToolsChildConfigFromEnv(env, "/agent")).toEqual({
      input: {
        env,
        cwd: "/agent",
        configPath: "/agent/mono-agent.config.json",
      },
      allowedTools,
    });
    expect(spec.type).toBe("stdio");
    expect(spec.command).toBe(process.execPath);
    expect(spec.cwd).toBe("/agent");
    expect(String((spec.args as string[])[0])).toMatch(/adapter-send-tools-main\.js$/u);
    expect(spec.env).toEqual({
      MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: "/agent/mono-agent.config.json",
      MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(allowedTools),
    });
    expect(JSON.stringify(spec.env)).not.toContain("xoxb-slack");
    expect(JSON.stringify(spec.env)).not.toContain("telegram-token");
    expect(String((spec.args as string[])[0])).not.toContain("xoxb-slack");
    expect(String((spec.args as string[])[0])).not.toContain("telegram-token");
  });

  it("forwards the producing conversation id and index path when indexing is configured, and parses them back", () => {
    const allowedTools = ["slack_send_message"];
    const indexing = { conversationId: "scheduled-scan#2026-06-22", indexPath: "/agent/artifacts/posted-message-index.jsonl" };
    const env = adapterSendToolsMcpEnv("/agent/mono-agent.config.json", allowedTools, indexing);

    expect(env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: indexing.conversationId,
      MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: indexing.indexPath,
    });
    expect(adapterSendToolsChildConfigFromEnv(env, "/agent").indexing).toEqual(indexing);
  });
});

describe("adapter send MCP tools", () => {
  it("sends Slack and Telegram messages to allowed destinations", async () => {
    const slackCalls: SlackChatPostMessageParams[] = [];
    const telegramCalls: TelegramSendMessageParams[] = [];
    const settings = bothAdaptersSettings();
    const server = createAdapterSendToolsServer(settings, {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          slackCalls.push(params);
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
      telegram: {
        async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
          telegramCalls.push(params);
          return { message_id: 77, chat: { id: params.chat_id }, text: params.text };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["slack_send_message", "telegram_send_message"]);

      const slackResult = await client.callTool({
        name: "slack_send_message",
        arguments: { channel: " C1 ", text: "hello", thread_ts: "171.1", unfurl_links: false },
      });
      expect(slackResult.structuredContent).toEqual({ ok: true, channel: "C1", ts: "171.123" });

      const telegramResult = await client.callTool({
        name: "telegram_send_message",
        arguments: { chat_id: -100, text: "hi", disable_web_page_preview: true },
      });
      expect(telegramResult.structuredContent).toEqual({ ok: true, chat_id: -100, message_id: 77 });
    });

    expect(slackCalls).toEqual([{ channel: "C1", text: "hello", thread_ts: "171.1", unfurl_links: false }]);
    expect(telegramCalls).toEqual([{ chat_id: -100, text: "hi", disable_web_page_preview: true }]);
  });

  it("telegram_ask posts the question with an inline keyboard of callback options", async () => {
    const telegramCalls: TelegramSendMessageParams[] = [];
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: true, document: false, photo: false },
      },
    };
    const server = createAdapterSendToolsServer(settings, {
      telegram: {
        async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
          telegramCalls.push(params);
          return { message_id: 88, chat: { id: params.chat_id }, text: params.text };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["telegram_ask"]);

      const result = await client.callTool({
        name: "telegram_ask",
        arguments: { chat_id: 42, question: "Deploy now?", options: ["Approve", "Reject"] },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, chat_id: 42, message_id: 88 });
    });

    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0]?.text).toBe("Deploy now?");
    expect(telegramCalls[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Approve", callback_data: "ask:0" }],
        [{ text: "Reject", callback_data: "ask:1" }],
      ],
    });
  });

  it("telegram_send_document uploads base64 bytes with the given filename and caption", async () => {
    const docCalls: Array<{ chat_id: unknown; filename: string; bytes: number; caption?: string }> = [];
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: false, document: true, photo: false },
      },
    };
    const server = createAdapterSendToolsServer(settings, {
      telegram: {
        sendMessage: vi.fn(),
        async sendDocument(params): Promise<TelegramSentMessage> {
          docCalls.push({
            chat_id: params.chat_id,
            filename: params.filename,
            bytes: params.document.byteLength,
            ...(params.caption === undefined ? {} : { caption: params.caption }),
          });
          return { message_id: 91, chat: { id: params.chat_id }, text: "" };
        },
      },
    });

    const data = Buffer.from("hello report").toString("base64");
    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["telegram_send_document"]);

      const result = await client.callTool({
        name: "telegram_send_document",
        arguments: { chat_id: 42, data, filename: "report.txt", caption: "Daily report" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, chat_id: 42, message_id: 91, filename: "report.txt" });
    });

    expect(docCalls).toEqual([{ chat_id: 42, filename: "report.txt", bytes: "hello report".length, caption: "Daily report" }]);
  });

  it("telegram_send_document rejects when neither data nor path is provided", async () => {
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: false, document: true, photo: false },
      },
    };
    const sendDocument = vi.fn();
    const server = createAdapterSendToolsServer(settings, { telegram: { sendMessage: vi.fn(), sendDocument } });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "telegram_send_document",
        arguments: { chat_id: 42, filename: "x.txt" },
      });
      expect(result.isError).toBe(true);
    });

    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("telegram_ask rejects a chat outside the adapter allowlist before calling the client", async () => {
    const telegram = { sendMessage: vi.fn() };
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: true, document: false, photo: false },
      },
    };
    const server = createAdapterSendToolsServer(settings, { telegram });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "telegram_ask",
        arguments: { chat_id: 999, question: "Deploy?", options: ["Yes", "No"] },
      });
      expect(result.isError).toBe(true);
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects Slack and Telegram destinations outside the adapter allowlists before calling clients", async () => {
    const slack = { chatPostMessage: vi.fn() };
    const telegram = { sendMessage: vi.fn() };
    const server = createAdapterSendToolsServer(bothAdaptersSettings(), { slack, telegram });

    await withMcpClient(server, async (client) => {
      const slackResult = await client.callTool({
        name: "slack_send_message",
        arguments: { channel: "C999", text: "blocked" },
      });
      expect(slackResult.isError).toBe(true);
      expect(slackResult.content).toEqual([
        { type: "text", text: "slack_send_message: channel is not allowed by Slack adapter config." },
      ]);

      const telegramResult = await client.callTool({
        name: "telegram_send_message",
        arguments: { chat_id: 999, text: "blocked" },
      });
      expect(telegramResult.isError).toBe(true);
      expect(telegramResult.content).toEqual([
        { type: "text", text: "telegram_send_message: chat_id is not allowed by Telegram adapter config." },
      ]);
    });

    expect(slack.chatPostMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe("adapter send tool posted-message indexing", () => {
  it("records a successful slack_send_message as (channel, ts) → producing conversation, de-bucketed", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const server = createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            return { ok: true, channel: params.channel, ts: "170.000100" };
          },
        },
      },
      { conversationId: "scheduled-scan#2026-06-22", indexPath },
    );

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({ name: "slack_send_message", arguments: { channel: "C1", text: "hello" } });
      expect(result.structuredContent).toMatchObject({ ok: true, channel: "C1", ts: "170.000100" });
    });

    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");
  });

  it("end-to-end: a scan's slack_send_message post lets a later in-thread reply resume the scan conversation", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);

    // 1) Producer — the scheduled scan posts its summary via slack_send_message,
    //    running under the synthetic cron conversationId.
    const producer = createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            return { ok: true, channel: params.channel, ts: "170.000100" };
          },
        },
      },
      { conversationId: "scheduled-scan#2026-06-22", indexPath },
    );
    await withMcpClient(producer, async (client) => {
      await client.callTool({ name: "slack_send_message", arguments: { channel: "C1", text: "scheduled scan: suggested next step" } });
    });
    // Sanity: the producer wrote the linkage.
    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");

    // 2) Consumer — the Slack adapter, wired exactly like the channel driver, with a
    //    reply arriving in that thread.
    let captured: { conversationId?: string } | undefined;
    const adapter = new SlackAdapter({
      api: new MinimalSlackApi() as unknown as SlackWebApi,
      allowAllChannels: true,
      responder: {
        respond: async (request) => {
          captured = request;
          return { text: "Added to Todoist." };
        },
      },
      resolvePostIndex: (channelId, ts) => lookupProducingConversation(indexPath, channelId, ts),
    });

    await adapter.handleEventCallback(
      threadedDmReply({ channel: "C1", threadTs: "170.000100", ts: "171.000001", text: "follow-up reply in the scan thread" }),
    );

    // The reply resumes the scan conversation instead of a fresh, history-less thread.
    expect(captured?.conversationId).toBe("scheduled-scan");
  });

  it("writes no index entry when indexing is not configured", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const server = createAdapterSendToolsServer(bothAdaptersSettings(), {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      await client.callTool({ name: "slack_send_message", arguments: { channel: "C1", text: "hello" } });
    });

    expect(await lookupProducingConversation(indexPath, "C1", "171.123")).toBeUndefined();
  });
});

describe("adapter send tool app composition", () => {
  it("injects adapter send MCP server into app-served runtime requests", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      tools: { allowedTools: ["slack_send_message", "telegram_send_message"], disallowedTools: [] },
      webhook: { enabled: true },
      slack: {
        enabled: true,
        botToken: "xoxb-slack",
        appToken: "xapp-slack",
        allowedChannelIds: ["C1"],
      },
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
      },
    });
    const fake = createFakeRuntime(async () => ({ text: "ok" }));
    let responder: AgentResponder | undefined;
    const driver: ChannelDriver = {
      id: "webhook",
      label: "Test",
      async loadConfig() {
        return { enabled: true };
      },
      isConfigError() {
        return false;
      },
      async start(input) {
        responder = input.responder;
        return { summary: {}, stop: async () => undefined };
      },
    };

    const app = await startMonoAgentApp({
      cwd: dir,
      configPath,
      env: {},
      drivers: [driver],
      runtime: fake.runtime,
    });
    await responder?.respond(
      { conversationId: "c", text: "hi", abortSignal: new AbortController().signal },
      { append: async () => undefined },
    );

    const server = fake.calls[0]?.options.mcpServers?.[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as { env?: Record<string, string> } | undefined;
    expect(server).toMatchObject({ type: "stdio", command: process.execPath, cwd: dir });
    expect(server?.env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: configPath,
      MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(["slack_send_message", "telegram_send_message"]),
    });
    expect(JSON.stringify(server?.env)).not.toContain("xoxb-slack");
    expect(JSON.stringify(server?.env)).not.toContain("telegram-token");

    await app.stop();
  });
});

async function writeConfig(json: Record<string, unknown>): Promise<string> {
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return configPath;
}

function baseConfig(): Record<string, unknown> {
  return {
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
    context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: "./artifacts" },
    traceability: { registryDir: "./trace-sources", sourceId: "adapter-send-test", sourceLabel: "Adapter Send Test" },
  };
}

function bothAdaptersSettings(): AdapterSendToolsSettings {
  return {
    slack: {
      botToken: "xoxb-slack",
      allowedChannelIds: ["c1"],
      allowAllChannels: false,
    },
    telegram: {
      botToken: "telegram-token",
      allowedChatIds: ["42", "-100"],
      allowAllChats: false,
      tools: { send: true, ask: false, document: false, photo: false },
    },
  };
}

async function withMcpClient<T>(
  server: ReturnType<typeof createAdapterSendToolsServer>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "adapter-send-tools-test", version: "0.1.0" }, { capabilities: {} });
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

/** Minimal SlackWebApi for driving the adapter's reply path in a test. */
class MinimalSlackApi {
  async authTest() {
    return { ok: true as const };
  }
  async appsConnectionsOpen() {
    return { ok: true as const, url: "wss://slack.test/socket" };
  }
  async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
    return { ok: true, channel: params.channel, ts: "172.000001" };
  }
  async chatUpdate(params: SlackChatUpdateParams) {
    return { ok: true as const, channel: params.channel, ts: params.ts, text: params.text };
  }
  async downloadFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

function threadedDmReply(options: { channel: string; threadTs: string; ts: string; text: string }): SlackEventCallback {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev-reply",
    event_time: 172,
    event: {
      type: "message",
      channel: options.channel,
      user: "UUSER1",
      text: options.text,
      ts: options.ts,
      event_ts: options.ts,
      thread_ts: options.threadTs,
      channel_type: "im",
    },
  };
}

function createFakeRuntime(run: (prompt: string, options: RuntimeRunOptions) => Promise<RuntimeResult>) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  const fake = {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return run(prompt, options);
      },
      disposeAllSessions: vi.fn(async () => undefined),
    },
  };
  return fake;
}
