import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import * as z from "zod/v4";

import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

export const SET_CONVERSATION_TITLE_MCP_SERVER_NAME = "mono-agent-conversation-title";
export const SET_CONVERSATION_TITLE_TOOL_NAME = "SetConversationTitle";
export const SET_CONVERSATION_TITLE_MAX_CHARACTERS = 80;

const SET_CONVERSATION_TITLE_INPUT = z.object({
  title: z.string()
    .trim()
    .min(1)
    .max(SET_CONVERSATION_TITLE_MAX_CHARACTERS)
    .refine(
      (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      "title contains unsupported control characters",
    ),
}).strict();

type SetConversationTitleInput = z.infer<typeof SET_CONVERSATION_TITLE_INPUT>;
type ConversationTitlePolicy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;

const SET_CONVERSATION_TITLE_POLICY_NAMES = [
  SET_CONVERSATION_TITLE_TOOL_NAME,
  `mcp__${SET_CONVERSATION_TITLE_MCP_SERVER_NAME}__${SET_CONVERSATION_TITLE_TOOL_NAME}`,
  `mcp__${SET_CONVERSATION_TITLE_MCP_SERVER_NAME}__*`,
] as const;

/** The console title tool follows the normal app-owned allow/deny boundary. */
export function isSetConversationTitleToolAllowed(policy: ConversationTitlePolicy | undefined): boolean {
  const allowed = policy?.allowedTools ?? [];
  const denied = policy?.disallowedTools ?? [];
  if (denied.includes("*") || SET_CONVERSATION_TITLE_POLICY_NAMES.some((name) => denied.includes(name))) {
    return false;
  }
  return allowed.includes("*") || SET_CONVERSATION_TITLE_POLICY_NAMES.some((name) => allowed.includes(name));
}

/** One stateless tool whose structured result is applied by the originating web console. */
export function createSetConversationTitleServer(): McpServer {
  const server = new McpServer({
    name: SET_CONVERSATION_TITLE_MCP_SERVER_NAME,
    version: "1.0.0",
  });
  server.registerTool(
    SET_CONVERSATION_TITLE_TOOL_NAME,
    {
      title: "Set conversation title",
      description: "Set a short semantic title for the current web-console conversation. Call this after you understand the initial topic, then call it again only when the conversation materially changes topic. Prefer a stable 3–8 word topic label over copying the user's message, progress text, or a generic label. The user can permanently lock a title by renaming it manually.",
      inputSchema: SET_CONVERSATION_TITLE_INPUT,
    },
    async (input: SetConversationTitleInput) => {
      const title = normalizeConversationTitle(input.title);
      return {
        content: [{ type: "text" as const, text: `Conversation title proposed: ${title}` }],
        structuredContent: { schema: 1, title },
      };
    },
  );
  return server;
}

/** Inject the capability only for an exact writable interactive web turn. */
export function createSetConversationTitleRuntimeExtension(): RuntimeOptionsExtension {
  const extension = createRequestScopedMcpRuntimeExtension({
    serverName: SET_CONVERSATION_TITLE_MCP_SERVER_NAME,
    startingMessage: "Conversation title tool is starting",
    createServer: () => createSetConversationTitleServer(),
  });
  return async (input) => {
    if (!isWritableWebConversationTitleRequest(input.request)) {
      return { runtimeOptions: {}, cleanup: async () => {} };
    }
    return await extension(input);
  };
}

function isWritableWebConversationTitleRequest(request: {
  readonly conversationId: string;
  readonly metadata?: Record<string, unknown>;
}): boolean {
  const metadata = request.metadata;
  if (metadata?.source !== "web") return false;
  const web = record(metadata.web);
  const capability = record(web?.conversationTitle);
  if (
    capability?.schema !== 1
    || capability.writable !== true
    || typeof web?.threadId !== "string"
    || typeof web.turnId !== "string"
    || web.threadId.length === 0
    || web.turnId.length === 0
    || web.trigger !== undefined
  ) return false;
  const logicalConversationId = request.conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "");
  return logicalConversationId === `web:${web.threadId}`;
}

function normalizeConversationTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
