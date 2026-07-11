import { readFile, stat } from "node:fs/promises";
import { basename, resolve as resolvePath } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { splitTextByCodePoints } from "@mono-agent/agent-contracts";
import { ALLOW_ALL_TOOLS } from "@mono-agent/config";
import type {
  SlackChatPostMessageResult,
  SlackWebApi,
} from "@mono-agent/slack-adapter";
import type {
  TelegramChatId,
  TelegramMessageSender,
  TelegramSentMessage,
} from "@mono-agent/telegram-adapter";
import * as z from "zod/v4";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { LEGACY_TOOL_ALIASES } from "./modules/known-tools.js";
import { appendPostedMessage } from "./posted-message-index.js";

// Lazy per module (mirrors channels.ts): a config without slack/telegram
// send-tool policy never pulls either SDK in.
type SlackAdapterModule = typeof import("@mono-agent/slack-adapter");
type TelegramAdapterModule = typeof import("@mono-agent/telegram-adapter");
let slackModule: SlackAdapterModule | undefined;
let telegramModule: TelegramAdapterModule | undefined;
const loadSlackModule = async (): Promise<SlackAdapterModule> =>
  (slackModule ??= await import("@mono-agent/slack-adapter"));
const loadTelegramModule = async (): Promise<TelegramAdapterModule> =>
  (telegramModule ??= await import("@mono-agent/telegram-adapter"));
const SLACK_SEND_MESSAGE_MAX_CHARS = 40_000;
/** Keep cancellation responsive even when the loopback bridge is wedged. */
const ASK_BRIDGE_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Model-visible send tools for explicitly allowed, already-enabled communication adapters.
 *
 * This mirrors `MemoryRecall`: agent-app injects a stdio MCP server through
 * per-request runtime options. The adapter config remains the source of truth:
 * if Slack or Telegram is disabled, invalid, blocked by tool policy, or lacks an
 * allowed destination policy, the corresponding send tool is not exposed. When
 * exposed, each tool enforces the same adapter allowlist before calling the
 * adapter-owned sender.
 */

export const ADAPTER_SEND_TOOLS_MCP_SERVER_NAME = "mono-agent-adapter-send";

export interface SlackSendToolSettings {
  readonly botToken: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowAllChannels: boolean;
}

export interface TelegramSendToolSettings {
  readonly botToken: string;
  readonly allowedChatIds: readonly string[];
  readonly allowAllChats: boolean;
  /** Self-hosted Bot API server base URL (also unlocks file:// path uploads). */
  readonly apiRoot?: string;
  /** Upload cap for the TelegramSendFile tool; the resolver fills the 20 MiB default. */
  readonly maxUploadBytes?: number;
  /** Which telegram tools the policy permits (the adapter config gates the rest). */
  readonly tools: {
    readonly send: boolean;
    readonly ask: boolean;
    /** The single TelegramSendFile tool (document + photo via a `kind` param). */
    readonly file: boolean;
  };
  readonly askBridge?: AskUserToolSettings;
}

/**
 * Blocking ask-the-user tool, backed by the app's interaction bridge. Channel
 * agnostic: the tool only talks to the bridge; the bridge posts the question
 * through whichever channel sink owns the conversation. `conversationId` is
 * present only in the spawned child (from the per-request env) — without it the
 * tool has no target and is not registered.
 */
export interface AskUserToolSettings {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly timeoutMs: number;
  readonly conversationId?: string;
}

export interface AdapterSendToolsSettings {
  readonly slack?: SlackSendToolSettings;
  readonly telegram?: TelegramSendToolSettings;
  readonly askUser?: AskUserToolSettings;
}

export interface AdapterSendToolsClients {
  readonly slack?: Pick<SlackWebApi, "chatPostMessage">;
  readonly telegram?: Pick<TelegramMessageSender, "sendMessage" | "sendDocument" | "sendPhoto">;
}

export interface AdapterSendToolsHttpOptions {
  readonly fetchImpl?: typeof fetch;
}

export interface AdapterSendToolsRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

/**
 * Where a posted message should be linked back to its producing conversation.
 * Forwarded to the stdio child so `SlackSendMessage` can record
 * `(channel, ts) → conversationId` — see {@link appendPostedMessage}.
 */
export interface AdapterSendToolsIndexing {
  readonly conversationId: string;
  readonly indexPath: string;
}

/** Minimal shape of the per-request runtime-options input we read (the producing conversationId). */
interface AdapterSendToolsRequestInput {
  readonly request?: { readonly conversationId?: string };
}

export interface AdapterSendToolsResolveOptions {
  readonly allowedTools?: readonly string[] | undefined;
  readonly disallowedTools?: readonly string[] | undefined;
  readonly logger?: {
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
  } | undefined;
  /** Suppress bridge-backed AskUser/TelegramAskButtons for MCP-incompatible routes. */
  readonly suppressInteractionTools?: boolean | undefined;
}

export async function resolveAdapterSendToolsSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions = {},
): Promise<AdapterSendToolsSettings | undefined> {
  const telegramSendAllowed = isAdapterToolAllowed("TelegramSendMessage", options);
  const telegramAskAllowed = options.suppressInteractionTools !== true
    && isAdapterToolAllowed("TelegramAskButtons", options);
  const telegramFileAllowed = isAdapterToolAllowed("TelegramSendFile", options);
  const telegramAnyAllowed = telegramSendAllowed || telegramAskAllowed || telegramFileAllowed;
  const telegramAskBridge = telegramAskAllowed ? resolveAskUserToolSettings(input.env) : undefined;
  const [slack, telegram] = await Promise.all([
    isAdapterToolAllowed("SlackSendMessage", options)
      ? resolveSlackSendToolSettings(input, options)
      : undefined,
    telegramAnyAllowed
      ? resolveTelegramSendToolSettings(input, options, {
          send: telegramSendAllowed,
          ask: telegramAskAllowed,
          file: telegramFileAllowed,
        }, telegramAskBridge)
      : undefined,
  ]);
  const askUser = options.suppressInteractionTools !== true && isAdapterToolAllowed("AskUser", options)
    ? resolveAskUserToolSettings(input.env)
    : undefined;
  if (slack === undefined && telegram === undefined && askUser === undefined) {
    return undefined;
  }
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
    ...(askUser === undefined ? {} : { askUser }),
  };
}

/**
 * AskUser is available only when the app exported a live interaction bridge
 * into the environment (URL + bearer token). The producing conversation id is
 * per-request env, present in the spawned child.
 */
function resolveAskUserToolSettings(env: Record<string, string | undefined>): AskUserToolSettings | undefined {
  const bridgeUrl = optionalString(env.MONO_AGENT_INTERACTION_BRIDGE_URL);
  const bridgeToken = optionalString(env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN);
  if (bridgeUrl === undefined || bridgeToken === undefined) {
    return undefined;
  }
  const timeoutRaw = Number(optionalString(env.MONO_AGENT_ASK_USER_TIMEOUT_MS));
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 ? timeoutRaw : 600_000;
  const conversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  return {
    bridgeUrl,
    bridgeToken,
    timeoutMs,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

export function adapterSendToolNames(settings: AdapterSendToolsSettings): readonly string[] {
  const names: string[] = [];
  if (settings.slack !== undefined) {
    names.push("SlackSendMessage");
  }
  if (settings.telegram?.tools.send === true) {
    names.push("TelegramSendMessage");
  }
  if (settings.telegram?.tools.ask === true) {
    names.push("TelegramAskButtons");
  }
  if (settings.telegram?.tools.file === true) {
    names.push("TelegramSendFile");
  }
  if (settings.askUser !== undefined) {
    names.push("AskUser");
  }
  return names;
}

/**
 * Public re-export of the per-tool allow check so callers (e.g. the Telegram
 * channel driver) can gate behavior on whether a specific adapter send tool is
 * permitted by `tools.allowedTools`/`disallowedTools`, matching this module's policy.
 */
export function isAdapterSendToolAllowed(
  name: string,
  policy: { readonly allowedTools?: readonly string[]; readonly disallowedTools?: readonly string[] },
): boolean {
  return isAdapterToolAllowed(name, policy);
}

/**
 * Per-request context forwarded to the stdio child. `conversationId` alone
 * targets AskUser at the producing conversation; `indexPath` additionally
 * enables the posted-message index (Slack reply continuity).
 */
export interface AdapterSendToolsChildContext {
  readonly conversationId?: string;
  readonly indexPath?: string;
}

export interface AdapterSendToolsInteractionEnv {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly timeoutMs: number;
}

export function adapterSendToolsMcpEnv(
  configPath: string,
  allowedTools: readonly string[],
  context?: AdapterSendToolsChildContext,
  interaction?: AdapterSendToolsInteractionEnv,
): Record<string, string> {
  return {
    MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH: configPath,
    MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS: JSON.stringify(allowedTools),
    ...(context?.conversationId === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID: context.conversationId }),
    ...(context?.indexPath === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: context.indexPath }),
    ...(interaction === undefined
      ? {}
      : {
          MONO_AGENT_INTERACTION_BRIDGE_URL: interaction.bridgeUrl,
          MONO_AGENT_INTERACTION_BRIDGE_TOKEN: interaction.bridgeToken,
          MONO_AGENT_ASK_USER_TIMEOUT_MS: String(interaction.timeoutMs),
        }),
  };
}

export interface AdapterSendToolsChildConfig {
  readonly input: MonoAgentAppConfigInput;
  readonly allowedTools: readonly string[];
  readonly indexing?: AdapterSendToolsIndexing;
}

export function adapterSendToolsChildConfigFromEnv(env: Record<string, string | undefined>, cwd: string): AdapterSendToolsChildConfig {
  const configPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH);
  if (configPath === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH).");
  }
  const conversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  const indexPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH);
  // Both must be present to index; either alone is a misconfiguration we simply skip.
  const indexing = conversationId !== undefined && indexPath !== undefined ? { conversationId, indexPath } : undefined;
  return {
    input: { env, cwd, configPath },
    allowedTools: parseAllowedToolNames(env.MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS),
    ...(indexing === undefined ? {} : { indexing }),
  };
}

export function adapterSendToolsMcpServerSpec(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  context?: AdapterSendToolsChildContext,
  interaction?: AdapterSendToolsInteractionEnv,
): Record<string, unknown> {
  const spec: Record<string | symbol, unknown> = {
    type: "stdio",
    command: process.execPath,
    // Node 24 on macOS defaults to the system trust store, whose trustd access
    // is intentionally unavailable inside strict SRT. Force Node's bundled CA
    // set for this child while still honoring NODE_EXTRA_CA_CERTS when SRT TLS
    // termination or an operator supplies an additional root.
    args: ["--use-bundled-ca", fileURLToPath(new URL("./adapter-send-tools-main.js", import.meta.url))],
    cwd,
    env: adapterSendToolsMcpEnv(configPath, allowedTools, context, interaction),
  };
  // Only the trusted app-owned adapter child receives SRT's coarse loopback
  // capability. A symbol cannot be supplied by JSON MCP config and disappears
  // from serialized provider/tool metadata, so ordinary Bash/project MCP
  // processes keep the stricter no-bind allowlist policy.
  Object.defineProperty(spec, Symbol.for("@mono-agent/app-owned-local-binding"), {
    value: true,
    enumerable: false,
  });
  return spec;
}

/**
 * Per-request runtime extension that injects the adapter-send stdio MCP server. It
 * reads the request's producing conversationId and, when an `indexPath` is
 * configured, forwards both to the child so a `SlackSendMessage` post is linked
 * back to this conversation (so a later in-thread reply resumes it).
 */
export function createAdapterSendToolsRuntimeExtension(
  configPath: string,
  cwd: string,
  allowedTools: readonly string[],
  indexPath?: string,
  interaction?: AdapterSendToolsInteractionEnv,
): (input: AdapterSendToolsRequestInput) => Promise<AdapterSendToolsRuntimeExtension> {
  return async (input) => {
    const conversationId = input?.request?.conversationId;
    const hasConversation = typeof conversationId === "string" && conversationId.trim().length > 0;
    // The conversation id is forwarded whenever known — AskUser targets it even
    // without indexing; the index path additionally enables posted-message links.
    const context: AdapterSendToolsChildContext | undefined = hasConversation
      ? { conversationId, ...(indexPath === undefined ? {} : { indexPath }) }
      : undefined;
    return {
      runtimeOptions: {
        mcpServers: {
          [ADAPTER_SEND_TOOLS_MCP_SERVER_NAME]: adapterSendToolsMcpServerSpec(
            configPath,
            cwd,
            allowedTools,
            context,
            interaction,
          ),
        },
      },
      cleanup: async () => {},
    };
  };
}

export async function createAdapterSendToolsClients(
  settings: AdapterSendToolsSettings,
  options: AdapterSendToolsHttpOptions = {},
): Promise<AdapterSendToolsClients> {
  const slack =
    settings.slack === undefined
      ? undefined
      : new (await loadSlackModule()).SlackWebApiClient({
          botToken: settings.slack.botToken,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
  const telegram =
    settings.telegram === undefined
      ? undefined
      : (await loadTelegramModule()).createTelegramMessageSender(settings.telegram.botToken, {
          ...(settings.telegram.apiRoot === undefined ? {} : { apiRoot: settings.telegram.apiRoot }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
  return {
    ...(slack === undefined ? {} : { slack }),
    ...(telegram === undefined ? {} : { telegram }),
  };
}

export async function createAdapterSendToolsServer(
  settings: AdapterSendToolsSettings,
  clients: AdapterSendToolsClients,
  indexing?: AdapterSendToolsIndexing,
  options: AdapterSendToolsHttpOptions = {},
): Promise<McpServer> {
  const server = new McpServer({ name: "agent-adapter-send-tools", version: "0.3.0" });

  if (settings.slack !== undefined && clients.slack !== undefined) {
    const adapter = await loadSlackModule();
    registerSlackSendTool(server, settings.slack, clients.slack, adapter.formatMarkdownForSlack, indexing);
  }
  if (settings.telegram !== undefined && clients.telegram !== undefined) {
    // Loaded once here (not per-register-call) because registerTelegramAskTool
    // needs TELEGRAM_ASK_MAX_OPTIONS synchronously while building its zod
    // schema, at registration time — not deferred into the request handler.
    const adapter = await loadTelegramModule();
    if (settings.telegram.tools.send) {
      registerTelegramSendTool(server, settings.telegram, clients.telegram);
    }
    if (settings.telegram.tools.ask) {
      registerTelegramAskTool(server, settings.telegram, clients.telegram, adapter, options.fetchImpl ?? globalThis.fetch);
    }
    if (settings.telegram.tools.file) {
      registerTelegramSendFileTool(server, settings.telegram, clients.telegram, adapter);
    }
  }
  // AskUser needs a target conversation; the parent app process resolves the
  // settings without one (for tool-name gating) and must not register the tool.
  if (settings.askUser?.conversationId !== undefined) {
    registerAskUserTool(
      server,
      { ...settings.askUser, conversationId: settings.askUser.conversationId },
      options.fetchImpl ?? globalThis.fetch,
    );
  }

  return server;
}

/** Long-poll wait per bridge request; the overall wait is bounded server-side by the ask's timeout. */
const ASK_USER_POLL_WAIT_MS = 20_000;

function registerAskUserTool(
  server: McpServer,
  settings: AskUserToolSettings & { readonly conversationId: string },
  fetchImpl: typeof fetch,
): void {
  server.registerTool(
    "AskUser",
    {
      title: "Ask the user and wait",
      description:
        "Ask the user ONE consolidated free-text question on the current conversation and WAIT for their reply (blocking, up to the configured timeout — default 10 minutes). Returns the user's answer text. Consolidate everything you need into a single question — a second concurrent ask fails. If the wait times out, the tool returns without an answer and the user's late reply will arrive as their next message: finish the turn gracefully (proceed with sensible defaults and say what you assumed).",
      inputSchema: {
        question: z.string().min(1).describe("The full question to show the user (plain text, no markdown)."),
      },
    },
    async (args, extra) => {
      const created = await askBridgeRequest(settings, fetchImpl, "POST", "/v1/asks", {
        conversationId: settings.conversationId,
        question: args.question,
        timeoutMs: settings.timeoutMs,
      }, extra.signal);
      if (created.status === 409) {
        return askToolResult(
          "A question is already pending for the user. Wait for its answer instead of asking again.",
          { answered: false, reason: "already_pending" },
        );
      }
      if (created.status === 501) {
        return askToolResult(
          "This conversation's channel does not support interactive asks. Ask your question in your final reply instead.",
          { answered: false, reason: "unsupported_channel" },
        );
      }
      if (created.status !== 201 || typeof created.body.askId !== "string") {
        throw new Error(`AskUser: the interaction bridge rejected the ask (HTTP ${String(created.status)}).`);
      }
      return await awaitBridgeAsk(settings, created.body.askId, "AskUser", extra, fetchImpl, extra.signal);
    },
  );
}

function askToolResult(
  text: string,
  structured: { answered: boolean; answer?: string; reason?: string },
  extraStructured: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, ...extraStructured, ...structured },
  };
}

async function awaitBridgeAsk(
  settings: AskUserToolSettings,
  askId: string,
  toolName: "AskUser" | "TelegramAskButtons",
  extra: unknown,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  extraStructured: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }> {
  const startedMs = Date.now();
  try {
    for (;;) {
      const poll = await askBridgeRequest(
        settings,
        fetchImpl,
        "GET",
        `/v1/asks/${encodeURIComponent(askId)}?waitMs=${String(ASK_USER_POLL_WAIT_MS)}`,
        undefined,
        signal,
      );
      if (poll.status !== 200) {
        throw new Error(`${toolName}: lost the pending ask (HTTP ${String(poll.status)}).`);
      }
      // Keep-alive: progress notifications reset the runtime's MCP inactivity
      // timeout so a long human wait cannot kill the tool call.
      await sendAskProgress(extra, Math.round((Date.now() - startedMs) / 1000));
      const status = poll.body.status;
      if (status === "answered" && typeof poll.body.answer === "string") {
        const answeredText =
          toolName === "TelegramAskButtons"
            ? `The user tapped:\n${poll.body.answer}`
            : `The user answered:\n${poll.body.answer}`;
        return askToolResult(answeredText, { answered: true, answer: poll.body.answer }, extraStructured);
      }
      if (status === "expired") {
        return askToolResult(
          "The user did not answer within the wait window. Their reply will arrive as their next message — wrap up this turn gracefully (proceed with sensible defaults and say what you assumed).",
          { answered: false, reason: "timeout" },
          extraStructured,
        );
      }
      if (status === "cancelled") {
        return askToolResult("The user cancelled the current run. Stop this task.", {
          answered: false,
          reason: "cancelled",
        }, extraStructured);
      }
    }
  } catch (error) {
    // A cancelled MCP call must not leave a bridge ask pending until its full
    // human timeout. Cleanup gets its own bounded signal (not the aborted call
    // signal), and its failure must never replace the primary tool failure.
    await cleanupBridgeAskBestEffort(settings, fetchImpl, askId);
    throw error;
  }
}

async function cleanupBridgeAskBestEffort(
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
  askId: string,
): Promise<void> {
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new Error("interaction bridge ask cleanup timed out"));
      resolve();
    }, ASK_BRIDGE_CLEANUP_TIMEOUT_MS);
    deadlineTimer.unref?.();
  });
  // Attach the rejection handler before racing. If a test seam or nonstandard
  // fetch ignores abort and rejects later, it cannot become an unhandled error.
  const cleanup = askBridgeRequest(
    settings,
    fetchImpl,
    "DELETE",
    `/v1/asks/${encodeURIComponent(askId)}`,
    undefined,
    controller.signal,
  ).then(() => undefined, () => undefined);
  try {
    await Promise.race([cleanup, deadline]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}

async function askBridgeRequest(
  settings: AskUserToolSettings,
  fetchImpl: typeof fetch,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(new URL(path, settings.bridgeUrl), {
    method,
    headers: {
      authorization: `Bearer ${settings.bridgeToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    body: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
  };
}

async function sendAskProgress(extra: unknown, elapsedSeconds: number): Promise<void> {
  const handler = extra as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: unknown) => Promise<void>;
  };
  const progressToken = handler._meta?.progressToken;
  if (progressToken === undefined || handler.sendNotification === undefined) {
    return;
  }
  try {
    await handler.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsedSeconds,
        message: `waiting for the user's reply (${String(elapsedSeconds)}s)`,
      },
    });
  } catch {
    // Keep-alive only; a lost notification must never fail the ask.
  }
}

function registerSlackSendTool(
  server: McpServer,
  settings: SlackSendToolSettings,
  client: Pick<SlackWebApi, "chatPostMessage">,
  formatMarkdownForSlack: (text: string) => string,
  indexing?: AdapterSendToolsIndexing,
): void {
  server.registerTool(
    "SlackSendMessage",
    {
      title: "Send Slack message",
      description: "Send a message to an allowed Slack channel or DM ID using the configured Slack adapter bot token.",
      inputSchema: {
        channel: z.string().min(1).describe("Slack channel or DM ID, e.g. C123456 or D123456."),
        text: z.string().min(1).describe("Message text to send. Defaults to standard Markdown converted to Slack mrkdwn."),
        thread_ts: z.string().min(1).optional().describe("Optional Slack thread timestamp to reply in."),
        mrkdwn: z.boolean().optional().describe("Whether Slack mrkdwn formatting is enabled. Defaults to true; set false to send plain text unchanged."),
        unfurl_links: z.boolean().optional().describe("Whether Slack should unfurl links."),
        unfurl_media: z.boolean().optional().describe("Whether Slack should unfurl media."),
      },
    },
    async (args, extra) => {
      assertSlackChannelAllowed(settings, args.channel);
      const mrkdwn = args.mrkdwn ?? true;
      const text = mrkdwn ? formatMarkdownForSlack(args.text) : args.text;
      const chunks = splitTextByCodePoints(text, SLACK_SEND_MESSAGE_MAX_CHARS);
      const results: SlackChatPostMessageResult[] = [];
      for (const chunk of chunks) {
        const result: SlackChatPostMessageResult = await client.chatPostMessage(
          {
            channel: args.channel.trim(),
            text: chunk,
            ...(args.thread_ts === undefined ? {} : { thread_ts: args.thread_ts }),
            mrkdwn,
            ...(args.unfurl_links === undefined ? {} : { unfurl_links: args.unfurl_links }),
            ...(args.unfurl_media === undefined ? {} : { unfurl_media: args.unfurl_media }),
          },
          { signal: extra.signal },
        );
        results.push(result);
        // Link every posted chunk back to this conversation so an in-thread reply can
        // resume it. Best-effort: appendPostedMessage never throws, so a failed index
        // write can never fail the send.
        if (indexing !== undefined) {
          await appendPostedMessage(indexing.indexPath, {
            channelId: result.channel,
            ts: result.ts,
            conversationId: indexing.conversationId,
          });
        }
      }
      const [firstResult] = results;
      if (firstResult === undefined) {
        throw new Error("SlackSendMessage: no message chunks were produced.");
      }
      const chunkRefs = results.map((result) => ({ channel: result.channel, ts: result.ts }));
      const message =
        results.length === 1
          ? `Sent Slack message to ${firstResult.channel} at ${firstResult.ts}.`
          : `Sent ${String(results.length)} Slack messages to ${firstResult.channel} starting at ${firstResult.ts}.`;
      return {
        content: [{ type: "text", text: message }],
        structuredContent:
          results.length === 1
            ? { ok: true, channel: firstResult.channel, ts: firstResult.ts }
            : {
                ok: true,
                channel: firstResult.channel,
                ts: firstResult.ts,
                chunkCount: results.length,
                chunks: chunkRefs,
              },
      };
    },
  );
}

function registerTelegramSendTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendMessage">,
): void {
  server.registerTool(
    "TelegramSendMessage",
    {
      title: "Send Telegram message",
      description: "Send a message to an allowed Telegram chat using the configured Telegram adapter bot token.",
      inputSchema: {
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        text: z.string().min(1).describe("Message text to send."),
        parse_mode: z.string().min(1).optional().describe("Optional Telegram parse mode, e.g. MarkdownV2 or HTML."),
        reply_to_message_id: z.number().int().optional().describe("Optional message id to reply to."),
        disable_web_page_preview: z.boolean().optional().describe("Disable Telegram link previews."),
      },
    },
    async (args, extra) => {
      assertTelegramChatAllowed(settings, args.chat_id);
      const result: TelegramSentMessage = await client.sendMessage(
        {
          chat_id: args.chat_id,
          text: args.text,
          ...(args.parse_mode === undefined ? {} : { parse_mode: args.parse_mode }),
          ...(args.reply_to_message_id === undefined ? {} : { reply_to_message_id: args.reply_to_message_id }),
          ...(args.disable_web_page_preview === undefined ? {} : { disable_web_page_preview: args.disable_web_page_preview }),
        },
        { signal: extra.signal },
      );
      return {
        content: [{ type: "text", text: `Sent Telegram message ${result.message_id} to ${String(result.chat.id)}.` }],
        structuredContent: { ok: true, chat_id: result.chat.id, message_id: result.message_id },
      };
    },
  );
}

function registerTelegramAskTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendMessage">,
  adapter: TelegramAdapterModule,
  fetchImpl: typeof fetch,
): void {
  server.registerTool(
    "TelegramAskButtons",
    {
      title: "Ask via Telegram buttons",
      description:
        "Ask the owner a question in an allowed Telegram chat with tappable inline-keyboard buttons (e.g. a confirmation or a multiple-choice) and WAIT for their tap. Returns the tapped label. A second concurrent ask in the same chat fails.",
      inputSchema: {
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        question: z.string().min(1).describe("The question to show above the buttons."),
        options: z
          .array(z.string().min(1).max(100))
          .min(2)
          .max(adapter.TELEGRAM_ASK_MAX_OPTIONS)
          .describe("Button labels (2–8). The label the user taps is echoed back as a new message."),
        note: z.string().min(1).optional().describe("Optional extra context shown beneath the question."),
      },
    },
    async (args, extra) => {
      assertTelegramChatAllowed(settings, args.chat_id);
      const bridge = settings.askBridge;
      if (bridge === undefined) {
        return askToolResult("TelegramAskButtons requires a live interaction bridge, but none is configured.", {
          answered: false,
          reason: "unsupported_channel",
        });
      }
      const inlineKeyboard = args.options.map((label, index) => [
        { text: label, callback_data: adapter.telegramAskCallbackData(index) },
      ]);
      const text = args.note === undefined ? args.question : `${args.question}\n\n${args.note}`;
      const conversationId = `telegram:${String(args.chat_id)}`;
      const created = await askBridgeRequest(bridge, fetchImpl, "POST", "/v1/asks", {
        conversationId,
        question: text,
        timeoutMs: bridge.timeoutMs,
        postQuestion: false,
        answerKind: "callback",
      }, extra.signal);
      if (created.status === 409) {
        return askToolResult(
          "A question is already pending for this Telegram chat. Wait for its answer instead of asking again.",
          { answered: false, reason: "already_pending" },
          { chat_id: args.chat_id },
        );
      }
      if (created.status === 501) {
        return askToolResult(
          "This Telegram chat is not registered with the interaction bridge. Ask your question in your final reply instead.",
          { answered: false, reason: "unsupported_channel" },
          { chat_id: args.chat_id },
        );
      }
      if (created.status !== 201 || typeof created.body.askId !== "string") {
        throw new Error(`TelegramAskButtons: the interaction bridge rejected the ask (HTTP ${String(created.status)}).`);
      }
      const askId = created.body.askId;
      let result: TelegramSentMessage;
      try {
        result = await client.sendMessage(
          {
            chat_id: args.chat_id,
            text,
            reply_markup: { inline_keyboard: inlineKeyboard },
          },
          { signal: extra.signal },
        );
      } catch (error) {
        await cleanupBridgeAskBestEffort(bridge, fetchImpl, askId);
        throw error;
      }
      return await awaitBridgeAsk(bridge, askId, "TelegramAskButtons", extra, fetchImpl, extra.signal, {
        chat_id: result.chat.id,
        message_id: result.message_id,
        options: args.options,
      });
    },
  );
}

/**
 * Register the single `TelegramSendFile` tool. A required `kind` param selects
 * `"document"` (any file, shown as a downloadable document) or `"photo"` (an image
 * shown inline). Both accept the file as base64 `data` (with a `filename`) OR a
 * workspace `path` (filename derived from the basename), enforce the adapter
 * allowlist, and bound the size to the adapter's inbound cap before uploading via
 * the adapter-owned sender.
 */
function registerTelegramSendFileTool(
  server: McpServer,
  settings: TelegramSendToolSettings,
  client: Pick<TelegramMessageSender, "sendDocument" | "sendPhoto">,
  adapter: TelegramAdapterModule,
): void {
  server.registerTool(
    "TelegramSendFile",
    {
      title: "Send Telegram file",
      description:
        "Upload and send a file to an allowed Telegram chat. Set `kind:\"document\"` to send any file (shown as a downloadable document) or `kind:\"photo\"` to send an image inline. Provide the bytes as base64 `data` (with a `filename` — required for a document), or a workspace `path` (preferred — with a self-hosted Bot API server a `path` upload streams from disk with no size buffering, up to the configured cap).",
      inputSchema: {
        kind: z.enum(["document", "photo"]).describe("`document` for any file (downloadable), `photo` for an image shown inline."),
        chat_id: z.union([z.string().min(1), z.number().int()]).describe("Telegram chat id from the adapter allowlist."),
        data: z.string().min(1).optional().describe("Base64-encoded file bytes. Provide this or `path`."),
        path: z.string().min(1).optional().describe("Path to a file to upload (resolved against the agent working dir). Provide this or `data`."),
        filename: z.string().min(1).optional().describe("Filename to present. Required with `data` for a document; derived from `path` otherwise."),
        caption: z.string().min(1).optional().describe("Optional caption shown with the file."),
      },
    },
    async (args, extra) => {
      extra.signal.throwIfAborted();
      const kind = args.kind;
      assertTelegramChatAllowed(settings, args.chat_id);
      const maxUploadBytes = settings.maxUploadBytes ?? adapter.DEFAULT_ATTACHMENT_MAX_BYTES;
      // file:// fast path: a --local self-hosted server reads the file straight
      // from disk, so a path upload needs no buffering at any size — only a
      // stat-level cap check. Falls back once to the buffered path when the
      // server rejects the URI (e.g. a non---local self-hosted root).
      if (kind === "document" && settings.apiRoot !== undefined && args.path !== undefined && args.data === undefined) {
        const resolved = resolvePath(process.cwd(), args.path);
        const info = await stat(resolved);
        if (!info.isFile() || info.size === 0) {
          throw new Error("file is empty or not a regular file.");
        }
        if (info.size > maxUploadBytes) {
          throw new Error(`file exceeds the ${String(maxUploadBytes)}-byte upload cap.`);
        }
        try {
          const sent: TelegramSentMessage = await client.sendDocument!(
            {
              chat_id: args.chat_id,
              document: pathToFileURL(resolved).href,
              ...(args.caption === undefined ? {} : { caption: args.caption }),
            },
            { signal: extra.signal },
          );
          const name = basename(resolved);
          return {
            content: [{ type: "text", text: `Sent ${kind} ${sent.message_id} (${name}) to ${String(sent.chat.id)}.` }],
            structuredContent: { ok: true, chat_id: sent.chat.id, message_id: sent.message_id, filename: name },
          };
        } catch (error) {
          // Retry buffered exactly once; rethrow anything that isn't a server-side rejection.
          if ((error as { kind?: string }).kind !== "telegram") {
            throw error;
          }
        }
      }
      const { bytes, filename } = await resolveTelegramFileBytes({
        data: args.data,
        path: args.path,
        filename: args.filename,
        requireFilename: kind === "document",
        maxBytes: maxUploadBytes,
        signal: extra.signal,
      });
      const result: TelegramSentMessage =
        kind === "document"
          ? await client.sendDocument!(
              {
                chat_id: args.chat_id,
                document: bytes,
                filename,
                ...(args.caption === undefined ? {} : { caption: args.caption }),
              },
              { signal: extra.signal },
            )
          : await client.sendPhoto!(
              {
                chat_id: args.chat_id,
                photo: bytes,
                filename,
                ...(args.caption === undefined ? {} : { caption: args.caption }),
              },
              { signal: extra.signal },
            );
      return {
        content: [{ type: "text", text: `Sent ${kind} ${result.message_id} (${filename}) to ${String(result.chat.id)}.` }],
        structuredContent: { ok: true, chat_id: result.chat.id, message_id: result.message_id, filename },
      };
    },
  );
}

/** Resolve the upload bytes + filename from exactly one of base64 `data` or a `path`. */
async function resolveTelegramFileBytes(input: {
  data: string | undefined;
  path: string | undefined;
  filename: string | undefined;
  requireFilename: boolean;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<{ bytes: Uint8Array; filename: string }> {
  const hasData = input.data !== undefined;
  const hasPath = input.path !== undefined;
  if (hasData === hasPath) {
    throw new Error("provide exactly one of `data` (base64) or `path`.");
  }
  let bytes: Uint8Array;
  let filename: string;
  if (hasData) {
    bytes = new Uint8Array(Buffer.from(input.data!, "base64"));
    if (input.filename === undefined) {
      if (input.requireFilename) {
        throw new Error("`filename` is required when sending a document by `data`.");
      }
      filename = "image";
    } else {
      filename = input.filename;
    }
  } else {
    const resolved = resolvePath(process.cwd(), input.path!);
    bytes = new Uint8Array(await readFile(resolved, { signal: input.signal }));
    filename = input.filename ?? basename(resolved);
  }
  if (bytes.byteLength === 0) {
    throw new Error("file is empty.");
  }
  if (bytes.byteLength > input.maxBytes) {
    throw new Error(`file exceeds the ${String(input.maxBytes)}-byte upload cap.`);
  }
  return { bytes, filename };
}

async function resolveSlackSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
): Promise<SlackSendToolSettings | undefined> {
  try {
    const adapter = await loadSlackModule();
    const config = await adapter.loadSlackAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    return {
      botToken: config.botToken,
      allowedChannelIds: config.allowedChannelIds.map(normalizeSlackChannelId),
      allowAllChannels: config.allowAllChannels,
    };
  } catch (error) {
    options.logger?.warn?.("Slack send tool skipped because Slack adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
}

async function resolveTelegramSendToolSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions,
  tools: TelegramSendToolSettings["tools"],
  askBridge: AskUserToolSettings | undefined,
): Promise<TelegramSendToolSettings | undefined> {
  try {
    const adapter = await loadTelegramModule();
    const config = await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    return {
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      allowAllChats: config.allowAllChats,
      ...(config.apiRoot === undefined ? {} : { apiRoot: config.apiRoot }),
      maxUploadBytes: config.attachments?.maxUploadBytes ?? adapter.DEFAULT_ATTACHMENT_MAX_BYTES,
      tools,
      ...(askBridge === undefined ? {} : { askBridge }),
    };
  } catch (error) {
    options.logger?.warn?.("Telegram send tool skipped because Telegram adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
}

function assertSlackChannelAllowed(settings: SlackSendToolSettings, channel: string): void {
  if (settings.allowAllChannels || settings.allowedChannelIds.includes(normalizeSlackChannelId(channel))) {
    return;
  }
  throw new Error("SlackSendMessage: channel is not allowed by Slack adapter config.");
}

function assertTelegramChatAllowed(settings: TelegramSendToolSettings, chatId: TelegramChatId): void {
  const normalized = String(chatId);
  if (settings.allowAllChats || settings.allowedChatIds.includes(normalized)) {
    return;
  }
  throw new Error("TelegramSendMessage: chat_id is not allowed by Telegram adapter config.");
}

function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function normalizeSlackChannelId(value: string): string {
  return value.trim().toLowerCase();
}

/** The legacy snake_case names that alias to the canonical new `name` (may be empty). */
function legacyAliasesFor(name: string): readonly string[] {
  return Object.keys(LEGACY_TOOL_ALIASES).filter((legacy) => LEGACY_TOOL_ALIASES[legacy] === name);
}

function isAdapterToolAllowed(name: string, options: AdapterSendToolsResolveOptions): boolean {
  const wildcard = `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__*`;
  // Match the canonical new name AND every legacy snake_case alias that maps to it.
  // A pre-rename config listing e.g. the `telegram_send_photo` alias still enables
  // the collapsed `TelegramSendFile` tool; each is matched bare + mcp-prefixed.
  const matchNames = [name, ...legacyAliasesFor(name)];
  const aliases = matchNames.flatMap((matchName) => [
    matchName,
    `mcp__${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}__${matchName}`,
  ]);
  const allowed = options.allowedTools ?? [];
  const disallowed = options.disallowedTools ?? [];
  if (disallowed.includes(wildcard) || aliases.some((alias) => disallowed.includes(alias))) {
    return false;
  }
  if (aliases.some((alias) => allowed.includes(alias))) {
    return true;
  }
  if (allowed.includes(wildcard)) {
    return true;
  }
  return allowed.includes(ALLOW_ALL_TOOLS); // global allow-all (deny check above still wins)
}

function parseAllowedToolNames(raw: string | undefined): readonly string[] {
  const value = optionalString(raw);
  if (value === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("adapter-send-tools: invalid MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS (expected a JSON string array).");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("adapter-send-tools: invalid MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS (expected a JSON string array).");
  }
  return parsed;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
