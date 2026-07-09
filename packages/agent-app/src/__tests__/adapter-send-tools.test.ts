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
  createAdapterSendToolsRuntimeExtension,
  createAdapterSendToolsServer,
  isAdapterSendToolAllowed,
  resolveAdapterSendToolsSettings,
} from "../adapter-send-tools.js";
import type { AdapterSendToolsSettings } from "../adapter-send-tools.js";
import { lookupProducingConversation, resolvePostedMessageIndexPath } from "../posted-message-index.js";
import { startInteractionBridge } from "../interaction-bridge.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-adapter-send-tools-"));
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\nTest agent.\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isAdapterSendToolAllowed global allow-all", () => {
  it("allows an adapter send tool under the global '*' wildcard", () => {
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["*"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendMessage", { allowedTools: ["*"] })).toBe(true);
  });

  it("lets an explicit deny win over the global '*' wildcard", () => {
    expect(
      isAdapterSendToolAllowed("SlackSendMessage", {
        allowedTools: ["*"],
        disallowedTools: ["SlackSendMessage"],
      }),
    ).toBe(false);
  });

  it("still denies when neither the global '*' nor a matching entry is present", () => {
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: [] })).toBe(false);
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["Read"] })).toBe(false);
  });
});

describe("isAdapterSendToolAllowed legacy snake_case aliases", () => {
  it("accepts BOTH the new PascalCase name and its legacy snake_case alias", () => {
    // New canonical name.
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["SlackSendMessage"] })).toBe(true);
    // Legacy alias in an existing config still enables the renamed tool.
    expect(isAdapterSendToolAllowed("SlackSendMessage", { allowedTools: ["slack_send_message"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendMessage", { allowedTools: ["telegram_send_message"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramAskButtons", { allowedTools: ["telegram_ask"] })).toBe(true);
    expect(isAdapterSendToolAllowed("AskUser", { allowedTools: ["ask_user"] })).toBe(true);
  });

  it("maps BOTH legacy file-tool aliases onto the collapsed TelegramSendFile tool", () => {
    expect(isAdapterSendToolAllowed("TelegramSendFile", { allowedTools: ["TelegramSendFile"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendFile", { allowedTools: ["telegram_send_document"] })).toBe(true);
    expect(isAdapterSendToolAllowed("TelegramSendFile", { allowedTools: ["telegram_send_photo"] })).toBe(true);
  });

  it("honors a deny listing the legacy alias against a new-name allow (and vice versa)", () => {
    expect(
      isAdapterSendToolAllowed("SlackSendMessage", {
        allowedTools: ["SlackSendMessage"],
        disallowedTools: ["slack_send_message"],
      }),
    ).toBe(false);
    expect(
      isAdapterSendToolAllowed("TelegramSendFile", {
        allowedTools: ["telegram_send_photo"],
        disallowedTools: ["TelegramSendFile"],
      }),
    ).toBe(false);
  });
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
      { allowedTools: ["SlackSendMessage", "TelegramSendMessage"] },
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
        maxUploadBytes: 20 * 1024 * 1024,
        tools: { send: true, ask: false, file: false },
      },
    });
    expect(adapterSendToolNames(settings!)).toEqual(["SlackSendMessage", "TelegramSendMessage"]);
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
      { allowedTools: ["SlackSendMessage"], disallowedTools: ["SlackSendMessage"] },
    )).resolves.toBeUndefined();
    await expect(resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      {
        allowedTools: ["mcp__mono-agent-adapter-send__*"],
        disallowedTools: ["mcp__mono-agent-adapter-send__*"],
      },
    )).resolves.toBeUndefined();
  });

  it("exposes TelegramAskButtons (and not TelegramSendMessage) when only the ask tool is allowed", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["TelegramAskButtons"] },
    );

    expect(settings?.telegram).toMatchObject({ tools: { send: false, ask: true } });
    expect(adapterSendToolNames(settings!)).toEqual(["TelegramAskButtons"]);
  });

  it("resolves the collapsed TelegramSendFile tool from a legacy telegram_send_photo config entry", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["telegram_send_photo"] },
    );

    expect(settings?.telegram).toMatchObject({ tools: { send: false, ask: false, file: true } });
    expect(adapterSendToolNames(settings!)).toEqual(["TelegramSendFile"]);
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
        allowedTools: ["SlackSendMessage", "TelegramSendMessage"],
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
    const allowedTools = ["SlackSendMessage"];
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
    const allowedTools = ["SlackSendMessage"];
    const indexing = { conversationId: "scheduled-scan#2026-06-22", indexPath: "/agent/artifacts/posted-message-index.jsonl" };
    const env = adapterSendToolsMcpEnv("/agent/mono-agent.config.json", allowedTools, indexing);

    expect(env).toMatchObject({
      MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: indexing.conversationId,
      MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: indexing.indexPath,
    });
    expect(adapterSendToolsChildConfigFromEnv(env, "/agent").indexing).toEqual(indexing);
  });

  it("always forwards the producing conversation id so AskUser can target the conversation without indexing", async () => {
    const extension = createAdapterSendToolsRuntimeExtension("/agent/mono-agent.config.json", "/agent", ["AskUser"]);

    const result = await extension({ request: { conversationId: "telegram:42#2026-07-02" } });

    const spec = result.runtimeOptions.mcpServers[ADAPTER_SEND_TOOLS_MCP_SERVER_NAME] as {
      env: Record<string, string | undefined>;
    };
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID).toBe("telegram:42#2026-07-02");
    expect(spec.env.MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH).toBeUndefined();
  });
});

describe("adapter send MCP tools", () => {
  it("sends Slack and Telegram messages to allowed destinations", async () => {
    const slackCalls: SlackChatPostMessageParams[] = [];
    const telegramCalls: TelegramSendMessageParams[] = [];
    const settings = bothAdaptersSettings();
    const server = await createAdapterSendToolsServer(settings, {
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
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["SlackSendMessage", "TelegramSendMessage"]);

      const slackResult = await client.callTool({
        name: "SlackSendMessage",
        arguments: { channel: " C1 ", text: "hello", thread_ts: "171.1", unfurl_links: false },
      });
      expect(slackResult.structuredContent).toEqual({ ok: true, channel: "C1", ts: "171.123" });

      const telegramResult = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: -100, text: "hi", disable_web_page_preview: true },
      });
      expect(telegramResult.structuredContent).toEqual({ ok: true, chat_id: -100, message_id: 77 });
    });

    expect(slackCalls).toEqual([{ channel: "C1", text: "hello", thread_ts: "171.1", unfurl_links: false }]);
    expect(telegramCalls).toEqual([{ chat_id: -100, text: "hi", disable_web_page_preview: true }]);
  });

  it("TelegramAskButtons posts the question with an inline keyboard of callback options", async () => {
    const telegramCalls: TelegramSendMessageParams[] = [];
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: true, file: false },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: {
        async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
          telegramCalls.push(params);
          return { message_id: 88, chat: { id: params.chat_id }, text: params.text };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["TelegramAskButtons"]);

      const result = await client.callTool({
        name: "TelegramAskButtons",
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

  it("TelegramSendFile uploads base64 bytes with the given filename and caption", async () => {
    const docCalls: Array<{ chat_id: unknown; filename: string; bytes: number; caption?: string }> = [];
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: {
        sendMessage: vi.fn(),
        async sendDocument(params): Promise<TelegramSentMessage> {
          docCalls.push({
            chat_id: params.chat_id,
            filename: params.filename ?? "(none)",
            bytes: params.document instanceof Uint8Array ? params.document.byteLength : params.document.length,
            ...(params.caption === undefined ? {} : { caption: params.caption }),
          });
          return { message_id: 91, chat: { id: params.chat_id }, text: "" };
        },
      },
    });

    const data = Buffer.from("hello report").toString("base64");
    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["TelegramSendFile"]);

      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, data, filename: "report.txt", caption: "Daily report" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, chat_id: 42, message_id: 91, filename: "report.txt" });
    });

    expect(docCalls).toEqual([{ chat_id: 42, filename: "report.txt", bytes: "hello report".length, caption: "Daily report" }]);
  });

  it("TelegramSendFile rejects when neither data nor path is provided", async () => {
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: false, file: true },
      },
    };
    const sendDocument = vi.fn();
    const server = await createAdapterSendToolsServer(settings, { telegram: { sendMessage: vi.fn(), sendDocument } });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, filename: "x.txt" },
      });
      expect(result.isError).toBe(true);
    });

    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("TelegramAskButtons rejects a chat outside the adapter allowlist before calling the client", async () => {
    const telegram = { sendMessage: vi.fn() };
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: true, file: false },
      },
    };
    const server = await createAdapterSendToolsServer(settings, { telegram });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramAskButtons",
        arguments: { chat_id: 999, question: "Deploy?", options: ["Yes", "No"] },
      });
      expect(result.isError).toBe(true);
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects Slack and Telegram destinations outside the adapter allowlists before calling clients", async () => {
    const slack = { chatPostMessage: vi.fn() };
    const telegram = { sendMessage: vi.fn() };
    const server = await createAdapterSendToolsServer(bothAdaptersSettings(), { slack, telegram });

    await withMcpClient(server, async (client) => {
      const slackResult = await client.callTool({
        name: "SlackSendMessage",
        arguments: { channel: "C999", text: "blocked" },
      });
      expect(slackResult.isError).toBe(true);
      expect(slackResult.content).toEqual([
        { type: "text", text: "SlackSendMessage: channel is not allowed by Slack adapter config." },
      ]);

      const telegramResult = await client.callTool({
        name: "TelegramSendMessage",
        arguments: { chat_id: 999, text: "blocked" },
      });
      expect(telegramResult.isError).toBe(true);
      expect(telegramResult.content).toEqual([
        { type: "text", text: "TelegramSendMessage: chat_id is not allowed by Telegram adapter config." },
      ]);
    });

    expect(slack.chatPostMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe("adapter send tool posted-message indexing", () => {
  it("records a successful SlackSendMessage as (channel, ts) → producing conversation, de-bucketed", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const server = await createAdapterSendToolsServer(
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
      const result = await client.callTool({ name: "SlackSendMessage", arguments: { channel: "C1", text: "hello" } });
      expect(result.structuredContent).toMatchObject({ ok: true, channel: "C1", ts: "170.000100" });
    });

    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");
  });

  it("splits SlackSendMessage at Slack's 40,000-char limit and indexes every posted chunk", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);
    const postCalls: SlackChatPostMessageParams[] = [];
    let nextTs = 170;
    const server = await createAdapterSendToolsServer(
      bothAdaptersSettings(),
      {
        slack: {
          async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
            postCalls.push(params);
            return { ok: true, channel: params.channel, ts: `${nextTs++}.000100` };
          },
        },
      },
      { conversationId: "scheduled-scan#2026-06-22", indexPath },
    );
    const text = `${"x".repeat(40_000)}tail`;

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "SlackSendMessage",
        arguments: {
          channel: "C1",
          text,
          thread_ts: "169.000100",
          mrkdwn: false,
          unfurl_links: false,
          unfurl_media: false,
        },
      });
      expect(result.structuredContent).toMatchObject({
        ok: true,
        channel: "C1",
        ts: "170.000100",
        chunkCount: 2,
        chunks: [
          { channel: "C1", ts: "170.000100" },
          { channel: "C1", ts: "171.000100" },
        ],
      });
    });

    expect(postCalls.map((call) => call.text.length)).toEqual([40_000, 4]);
    expect(
      postCalls.every(
        (call) =>
          call.channel === "C1" &&
          call.thread_ts === "169.000100" &&
          call.mrkdwn === false &&
          call.unfurl_links === false &&
          call.unfurl_media === false,
      ),
    ).toBe(true);
    expect(await lookupProducingConversation(indexPath, "C1", "170.000100")).toBe("scheduled-scan");
    expect(await lookupProducingConversation(indexPath, "C1", "171.000100")).toBe("scheduled-scan");
  });

  it("end-to-end: a scan's SlackSendMessage post lets a later in-thread reply resume the scan conversation", async () => {
    const indexPath = resolvePostedMessageIndexPath(dir);

    // 1) Producer — the scheduled scan posts its summary via SlackSendMessage,
    //    running under the synthetic cron conversationId.
    const producer = await createAdapterSendToolsServer(
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
      await client.callTool({ name: "SlackSendMessage", arguments: { channel: "C1", text: "scheduled scan: suggested next step" } });
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
    const server = await createAdapterSendToolsServer(bothAdaptersSettings(), {
      slack: {
        async chatPostMessage(params: SlackChatPostMessageParams): Promise<SlackChatPostMessageResult> {
          return { ok: true, channel: params.channel, ts: "171.123" };
        },
      },
    });

    await withMcpClient(server, async (client) => {
      await client.callTool({ name: "SlackSendMessage", arguments: { channel: "C1", text: "hello" } });
    });

    expect(await lookupProducingConversation(indexPath, "C1", "171.123")).toBeUndefined();
  });
});

describe("adapter send tool app composition", () => {
  it("injects adapter send MCP server into app-served runtime requests", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      tools: { allowedTools: ["SlackSendMessage", "TelegramSendMessage"], disallowedTools: [] },
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
      MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(["SlackSendMessage", "TelegramSendMessage"]),
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
      tools: { send: true, ask: false, file: false },
    },
  };
}

async function withMcpClient<T>(
  server: Awaited<ReturnType<typeof createAdapterSendToolsServer>>,
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

describe("AskUser tool", () => {
  it("resolves askUser settings and the tool name when the policy allows AskUser and the bridge env is present", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings(
      {
        env: {
          MONO_AGENT_INTERACTION_BRIDGE_URL: "http://127.0.0.1:9999",
          MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "bridge-token",
          MONO_AGENT_ASK_USER_TIMEOUT_MS: "5000",
        },
        cwd: dir,
        configPath,
      },
      { allowedTools: ["AskUser"] },
    );

    expect(settings?.askUser).toEqual({
      bridgeUrl: "http://127.0.0.1:9999",
      bridgeToken: "bridge-token",
      timeoutMs: 5000,
    });
    expect(adapterSendToolNames(settings as AdapterSendToolsSettings)).toEqual(["AskUser"]);
  });

  it("omits askUser when the interaction bridge env is missing", async () => {
    const configPath = await writeConfig(baseConfig());

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["AskUser"] },
    );

    expect(settings).toBeUndefined();
  });

  it("is not registered without a producing conversation id (parent-process shape)", async () => {
    const server = await createAdapterSendToolsServer(
      {
        telegram: {
          botToken: "telegram-token",
          allowedChatIds: ["42"],
          allowAllChats: false,
          tools: { send: true, ask: false, file: false },
        },
        askUser: { bridgeUrl: "http://127.0.0.1:1", bridgeToken: "t", timeoutMs: 1_000 },
      },
      { telegram: { sendMessage: vi.fn() as never } },
    );
    await withMcpClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["TelegramSendMessage"]);
    });
  });

  it("blocks on the bridge until the user's reply resolves the ask", async () => {
    const bridge = await startInteractionBridge({ host: "127.0.0.1", port: 0, askTimeoutMs: 5_000 });
    const posts: string[] = [];
    bridge.registerSink("telegram", {
      postQuestion: async (_conversationId, text) => {
        posts.push(text);
      },
      postStatus: async () => {},
    });
    try {
      const server = await createAdapterSendToolsServer(
        {
          askUser: {
            bridgeUrl: bridge.url,
            bridgeToken: bridge.token,
            timeoutMs: 5_000,
            conversationId: "telegram:42#2026-07-02",
          },
        },
        {},
      );
      await withMcpClient(server, async (client) => {
        const pending = client.callTool({ name: "AskUser", arguments: { question: "Who is speaking?" } });
        await vi.waitFor(() => {
          expect(posts).toEqual(["Who is speaking?"]);
        });
        // The reply arrives on the BASE conversation id (bucket stripped by the bot).
        expect(bridge.tryResolveAsk("telegram:42", "Alice and Bob, Polish")).toBe(true);
        const result = await pending;
        expect(result.structuredContent).toMatchObject({ answered: true, answer: "Alice and Bob, Polish" });
        expect(JSON.stringify(result.content)).toContain("Alice and Bob, Polish");
      });
    } finally {
      await bridge.stop();
    }
  });

  it("reports an already-pending question instead of stacking a second ask", async () => {
    const bridge = await startInteractionBridge({ host: "127.0.0.1", port: 0, askTimeoutMs: 5_000 });
    bridge.registerSink("telegram", { postQuestion: async () => {}, postStatus: async () => {} });
    try {
      const first = await fetch(new URL("/v1/asks", bridge.url), {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "telegram:42", question: "first?" }),
      });
      expect(first.status).toBe(201);

      const server = await createAdapterSendToolsServer(
        {
          askUser: {
            bridgeUrl: bridge.url,
            bridgeToken: bridge.token,
            timeoutMs: 5_000,
            conversationId: "telegram:42",
          },
        },
        {},
      );
      await withMcpClient(server, async (client) => {
        const result = await client.callTool({ name: "AskUser", arguments: { question: "second?" } });
        expect(result.structuredContent).toMatchObject({ answered: false, reason: "already_pending" });
      });
    } finally {
      await bridge.stop();
    }
  });
});

describe("TelegramSendFile path upload", () => {
  it("uploads a workspace file by path, deriving the filename from the basename", async () => {
    const filePath = join(dir, "transcript.md");
    await writeFile(filePath, "# Transcript\n\nhello", "utf8");
    const sendDocument = vi.fn(async (params: { chat_id: unknown; filename: string }) => ({
      message_id: 90,
      chat: { id: params.chat_id },
    })) as never;
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        tools: { send: false, ask: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, path: filePath, caption: "your transcript" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, filename: "transcript.md" });
    });

    expect(sendDocument).toHaveBeenCalledTimes(1);
    const uploaded = (sendDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      document: Uint8Array;
      filename: string;
      caption?: string;
    };
    expect(uploaded.filename).toBe("transcript.md");
    expect(uploaded.caption).toBe("your transcript");
    expect(Buffer.from(uploaded.document).toString("utf8")).toBe("# Transcript\n\nhello");
  });
});

describe("self-hosted server send tools", () => {
  it("resolves apiRoot and maxUploadBytes from the telegram config", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: {
        enabled: true,
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        apiRoot: "http://127.0.0.1:8081",
        attachments: { maxUploadBytes: 1_048_576 },
      },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["TelegramSendFile"] },
    );

    expect(settings?.telegram).toMatchObject({
      apiRoot: "http://127.0.0.1:8081",
      maxUploadBytes: 1_048_576,
    });
  });

  it("defaults maxUploadBytes to the 20 MiB adapter cap when unset", async () => {
    const configPath = await writeConfig({
      ...baseConfig(),
      telegram: { enabled: true, botToken: "telegram-token", allowedChatIds: ["42"] },
    });

    const settings = await resolveAdapterSendToolsSettings(
      { env: {}, cwd: dir, configPath },
      { allowedTools: ["TelegramSendFile"] },
    );

    expect(settings?.telegram?.maxUploadBytes).toBe(20 * 1024 * 1024);
    expect(settings?.telegram?.apiRoot).toBeUndefined();
  });

  it("sends a path upload as a file:// URI when an apiRoot is configured (zero buffering)", async () => {
    const filePath = join(dir, "transcript.md");
    await writeFile(filePath, "# Big transcript", "utf8");
    const sendDocument = vi.fn(async (params: { chat_id: unknown }) => ({
      message_id: 91,
      chat: { id: params.chat_id },
    })) as never;
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        apiRoot: "http://127.0.0.1:8081",
        maxUploadBytes: 20 * 1024 * 1024,
        tools: { send: false, ask: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, path: filePath, caption: "your transcript" },
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
    });

    const uploaded = (sendDocument as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { document: unknown };
    expect(uploaded.document).toBe(`file://${filePath}`);
  });

  it("falls back to a buffered upload when the server rejects the file:// URI", async () => {
    const filePath = join(dir, "transcript.md");
    await writeFile(filePath, "# Fallback transcript", "utf8");
    const sendDocument = vi.fn() as ReturnType<typeof vi.fn>;
    sendDocument.mockRejectedValueOnce(Object.assign(new Error("Bad Request: wrong file identifier"), { kind: "telegram" }));
    sendDocument.mockResolvedValueOnce({ message_id: 92, chat: { id: 42 } });
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        apiRoot: "http://127.0.0.1:8081",
        maxUploadBytes: 20 * 1024 * 1024,
        tools: { send: false, ask: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument: sendDocument as never },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, path: filePath },
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
    });

    expect(sendDocument).toHaveBeenCalledTimes(2);
    const retried = sendDocument.mock.calls[1]?.[0] as { document: unknown; filename?: string };
    expect(Buffer.from(retried.document as Uint8Array).toString("utf8")).toBe("# Fallback transcript");
    expect(retried.filename).toBe("transcript.md");
  });

  it("honors the configured maxUploadBytes for buffered uploads", async () => {
    const settings: AdapterSendToolsSettings = {
      telegram: {
        botToken: "telegram-token",
        allowedChatIds: ["42"],
        allowAllChats: false,
        maxUploadBytes: 8,
        tools: { send: false, ask: false, file: true },
      },
    };
    const server = await createAdapterSendToolsServer(settings, {
      telegram: { sendMessage: vi.fn() as never, sendDocument: vi.fn() as never },
    });

    await withMcpClient(server, async (client) => {
      const result = await client.callTool({
        name: "TelegramSendFile",
        arguments: { kind: "document", chat_id: 42, data: Buffer.from("way more than eight bytes").toString("base64"), filename: "x.md" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("upload cap");
    });
  });
});
