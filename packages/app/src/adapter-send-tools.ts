import { ALLOW_ALL_TOOLS } from "@mono-agent/config";

import { ADAPTER_SEND_TOOLS_MCP_SERVER_NAME, optionalString } from "./delivery/send-tools/child-config.js";
import { loadSlackModule, loadTelegramModule, normalizeSlackChannelId } from "./delivery/send-tools/clients.js";
import { parseFileIdentity } from "./delivery/send-tools/file-identity.js";
import type {
  AdapterSendToolsSettings,
  AdapterSendToolsResolveOptions,
  AdapterSendToolsInteractionEnv,
  AskUserToolSettings,
  SlackSendToolSettings,
  TelegramSendToolSettings,
} from "./delivery/send-tools/types.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { LEGACY_TOOL_ALIASES } from "./modules/known-tools.js";

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

export async function resolveAdapterSendToolsSettings(
  input: MonoAgentAppConfigInput,
  options: AdapterSendToolsResolveOptions = {},
): Promise<AdapterSendToolsSettings | undefined> {
  const telegramSendAllowed = isAdapterToolAllowed("TelegramSendMessage", options);
  const telegramFileAllowed = isAdapterToolAllowed("TelegramSendFile", options);
  const telegramAnyAllowed = telegramSendAllowed || telegramFileAllowed;
  const [slack, telegram] = await Promise.all([
    isAdapterToolAllowed("SlackSendMessage", options)
      ? resolveSlackSendToolSettings(input, options)
      : undefined,
    telegramAnyAllowed
        ? resolveTelegramSendToolSettings(input, options, {
          send: telegramSendAllowed,
          file: telegramFileAllowed,
        })
      : undefined,
  ]);
  const askUser = options.suppressInteractionTools !== true && isAdapterToolAllowed("AskUser", options)
    ? resolveAskUserToolSettings(input.env, options.interaction)
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
function resolveAskUserToolSettings(
  env: Record<string, string | undefined>,
  interaction?: AdapterSendToolsInteractionEnv,
): AskUserToolSettings | undefined {
  const bridgeUrl = interaction?.bridgeUrl ?? optionalString(env.MONO_AGENT_INTERACTION_BRIDGE_URL);
  const bridgeToken = interaction?.bridgeToken ?? optionalString(env.MONO_AGENT_INTERACTION_BRIDGE_TOKEN);
  if (bridgeUrl === undefined || bridgeToken === undefined) {
    return undefined;
  }
  const timeoutValue = optionalString(env.MONO_AGENT_ASK_USER_TIMEOUT_MS);
  const timeoutRaw = Number(timeoutValue);
  const timeoutMs = interaction?.timeoutMs !== undefined
    ? interaction.timeoutMs
    : timeoutValue === "none"
      ? null
      : Number.isFinite(timeoutRaw) && timeoutRaw >= 1000 ? timeoutRaw : 600_000;
  const producerConversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  const interactionConversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_INTERACTION_CONVERSATION_ID);
  const runId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_RUN_ID);
  return {
    bridgeUrl,
    bridgeToken,
    timeoutMs,
    ...(producerConversationId === undefined ? {} : { producerConversationId }),
    ...(interactionConversationId === undefined ? {} : { interactionConversationId }),
    ...(runId === undefined ? {} : { runId }),
  };
}

/**
 * Restriction-only per-request marker retained for older Web builds and host
 * continuations. Current Web restart recovery waits for explicit user input.
 * `metadata.web.suppressInteractionTools` can only remove AskUser, never add tools.
 */
export function requestSuppressesInteractionTools(metadata: Record<string, unknown> | undefined): boolean {
  const web = metadata?.web;
  return typeof web === "object" && web !== null && (web as Record<string, unknown>).suppressInteractionTools === true;
}

export function adapterSendToolNames(settings: AdapterSendToolsSettings): readonly string[] {
  const names: string[] = [];
  // AskUser leads the list: it is a decision tool the model should reach for
  // before doing work, not the last entry in a row of channel utilities.
  if (settings.askUser !== undefined) {
    names.push("AskUser");
  }
  if (settings.slack !== undefined) {
    names.push("SlackSendMessage");
  }
  if (settings.telegram?.tools.send === true) {
    names.push("TelegramSendMessage");
  }
  if (settings.telegram?.tools.file === true) {
    names.push("TelegramSendFile");
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
): Promise<TelegramSendToolSettings | undefined> {
  try {
    const adapter = await loadTelegramModule();
    const config = await adapter.loadTelegramAdapterConfig({ env: input.env, jsonPath: input.configPath });
    if (!config.enabled) {
      return undefined;
    }
    const producingConversationId = optionalString(input.env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
    const runOutputDir = optionalString(input.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DIR);
    const runOutputIdentity = parseFileIdentity(
      input.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DEV,
      input.env.MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_INO,
    );
    return {
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      allowAllChats: config.allowAllChats,
      ...(config.apiRoot === undefined ? {} : { apiRoot: config.apiRoot }),
      maxUploadBytes: config.attachments?.maxUploadBytes ?? adapter.DEFAULT_ATTACHMENT_MAX_BYTES,
      tools,
      ...(config.sendTools === undefined ? {} : { sendTools: config.sendTools }),
      ...(producingConversationId === undefined ? {} : { producingConversationId }),
      ...(runOutputDir === undefined ? {} : { runOutputDir }),
      ...(runOutputIdentity === undefined ? {} : { runOutputIdentity }),
      ...(config.projects?.enabled === true ? { projects: true } : {}),
    };
  } catch (error) {
    options.logger?.warn?.("Telegram send tool skipped because Telegram adapter config is unavailable.", {
      reason: reasonOf(error),
    });
    return undefined;
  }
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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
