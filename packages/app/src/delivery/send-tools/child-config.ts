import type {
  AdapterSendToolsChildConfig,
  AdapterSendToolsChildContext,
  AdapterSendToolsInteractionEnv,
} from "./types.js";

export const ADAPTER_SEND_TOOLS_MCP_SERVER_NAME = "mono-agent-adapter-send";

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
    ...(context?.interactionConversationId === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_INTERACTION_CONVERSATION_ID: context.interactionConversationId }),
    ...(context?.runId === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_PRODUCING_RUN_ID: context.runId }),
    ...(context?.indexPath === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH: context.indexPath }),
    ...(context?.runOutputDir === undefined
      ? {}
      : { MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DIR: context.runOutputDir }),
    ...(context?.runOutputIdentity === undefined
      ? {}
      : {
          MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_DEV: String(context.runOutputIdentity.dev),
          MONO_AGENT_ADAPTER_TOOLS_RUN_OUTPUT_INO: String(context.runOutputIdentity.ino),
        }),
    // Reserved app-owned credentials must override inherited host environment.
    MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_URL: context?.deliveryHistory?.bridgeUrl ?? "",
    MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_TOKEN: context?.deliveryHistory?.bridgeToken ?? "",
    ...(interaction === undefined
      ? {}
      : {
          MONO_AGENT_INTERACTION_BRIDGE_URL: interaction.bridgeUrl,
          MONO_AGENT_INTERACTION_BRIDGE_TOKEN: interaction.bridgeToken,
          MONO_AGENT_ASK_USER_TIMEOUT_MS: interaction.timeoutMs === null ? "none" : String(interaction.timeoutMs),
        }),
  };
}

export function adapterSendToolsChildConfigFromEnv(env: Record<string, string | undefined>, cwd: string): AdapterSendToolsChildConfig {
  const configPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH);
  if (configPath === undefined) {
    throw new Error("adapter-send-tools: missing required environment (MONO_AGENT_ADAPTER_TOOLS_CONFIG_PATH).");
  }
  const conversationId = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_PRODUCING_CONVERSATION_ID);
  const indexPath = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_POST_INDEX_PATH);
  const historyBridgeUrl = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_URL);
  const historyBridgeToken = optionalString(env.MONO_AGENT_ADAPTER_TOOLS_HISTORY_BRIDGE_TOKEN);
  if ((historyBridgeUrl === undefined) !== (historyBridgeToken === undefined)) {
    throw new Error(
      "adapter-send-tools: delivery-history bridge URL and token must either both be present or both be absent.",
    );
  }
  // Both must be present to index; either alone is a misconfiguration we simply skip.
  const indexing = conversationId !== undefined && indexPath !== undefined ? { conversationId, indexPath } : undefined;
  return {
    input: { env, cwd, configPath },
    allowedTools: parseAllowedToolNames(env.MONO_AGENT_ADAPTER_TOOLS_ALLOWED_TOOLS),
    ...(indexing === undefined ? {} : { indexing }),
    ...(historyBridgeUrl === undefined || historyBridgeToken === undefined
      ? {}
      : { deliveryHistory: { bridgeUrl: historyBridgeUrl, bridgeToken: historyBridgeToken } }),
  };
}

export function optionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
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
