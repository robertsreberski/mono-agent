import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import type {
  SlackChatPostMessageParams,
  SlackChatPostMessageResult,
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
