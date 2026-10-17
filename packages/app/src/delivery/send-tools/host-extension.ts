import process from "node:process";
import { fileURLToPath } from "node:url";

import { adapterSendToolsMcpEnv, ADAPTER_SEND_TOOLS_MCP_SERVER_NAME } from "./child-config.js";
import { ensureAdapterRunOutputDir, removeOwnedDirectory } from "./run-output.js";
import type {
  AdapterSendToolsChildContext,
  AdapterSendToolsDeliveryHistoryCapabilityIssuer,
  AdapterSendToolsInteractionEnv,
  AdapterSendToolsRequestInput,
  AdapterSendToolsRuntimeExtension,
} from "./types.js";

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
  runOutputRoot?: string,
  deliveryHistoryCapabilityIssuer?: AdapterSendToolsDeliveryHistoryCapabilityIssuer,
  /** `telegram.projects`: the file tool also needs the bridge to resolve `projectId`. */
  telegramProjects = false,
): (input: AdapterSendToolsRequestInput) => Promise<AdapterSendToolsRuntimeExtension> {
  return async (input) => {
    const conversationId = input?.request?.conversationId;
    const interactionConversationId = input?.request?.replyTo?.conversationId ?? conversationId;
    const runId = input?.runId;
    const hasConversation = typeof conversationId === "string" && conversationId.trim().length > 0;
    const hasRunId = typeof runId === "string" && runId.trim().length > 0;
    const runOutput = runOutputRoot === undefined || !hasRunId
      ? undefined
      : await ensureAdapterRunOutputDir(runOutputRoot, runId);
    const deliveryHistoryChannels = [
      ...(allowedTools.includes("SlackSendMessage") ? ["slack" as const] : []),
      ...(allowedTools.includes("TelegramSendMessage")
        || (telegramProjects && allowedTools.includes("TelegramSendFile")) ? ["telegram" as const] : []),
    ];
    const deliveryHistory = !hasRunId
      || !hasConversation
      || deliveryHistoryCapabilityIssuer === undefined
      || deliveryHistoryChannels.length === 0
      ? undefined
      : deliveryHistoryCapabilityIssuer.issueDeliveryHistoryCapability({
          runId,
          producerConversationId: conversationId as string,
          allowedChannels: deliveryHistoryChannels,
        });
    // The conversation id is forwarded whenever known — AskUser targets it even
    // without indexing; the index path additionally enables posted-message links.
    const context: AdapterSendToolsChildContext | undefined = hasConversation || hasRunId
      ? {
          ...(hasConversation ? { conversationId } : {}),
          ...(typeof interactionConversationId === "string" && interactionConversationId.trim().length > 0
            ? { interactionConversationId }
            : {}),
          ...(hasRunId ? { runId } : {}),
          ...(indexPath === undefined ? {} : { indexPath }),
          ...(runOutput === undefined
            ? {}
            : { runOutputDir: runOutput.path, runOutputIdentity: runOutput.identity }),
          ...(deliveryHistory === undefined
            ? {}
            : {
                deliveryHistory: {
                  bridgeUrl: deliveryHistory.url,
                  bridgeToken: deliveryHistory.token,
                },
              }),
        }
      : undefined;
    return {
      runtimeOptions: {
        ...(allowedTools.includes("AskUser") ? { hostCapabilities: { AskUser: {
          available: hasConversation && Boolean(context?.interactionConversationId) && Boolean(interaction),
          ...(!hasConversation || !context?.interactionConversationId || !interaction ? { reason: "bridge_or_target_unavailable" } : {}),
          limits: { timeoutMs: interaction?.timeoutMs ?? null },
        } } } : {}),
        ...(interaction?.timeoutMs === null && allowedTools.includes("AskUser")
          ? { mcpCallNoTotalTimeoutTools: [`${ADAPTER_SEND_TOOLS_MCP_SERVER_NAME}:AskUser`] }
          : {}),
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
      cleanup: async () => {
        deliveryHistory?.release();
      },
      settleCleanup: async () => {
        if (runOutput !== undefined) {
          await removeOwnedDirectory(runOutput.path, runOutput.identity);
        }
      },
    };
  };
}
