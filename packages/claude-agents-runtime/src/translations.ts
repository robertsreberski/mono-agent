import { parseMcpServers } from "@mono-agent/runtime-adapter";
import type { NormalizedMcpServer, RuntimeEventLike } from "@mono-agent/runtime-adapter";

export interface ClaudeSDKMessageLike {
  readonly type?: string;
  readonly subtype?: string;
  readonly [key: string]: unknown;
}

export function translateClaudeMessageToEvent(message: ClaudeSDKMessageLike): RuntimeEventLike | undefined {
  if (!isObject(message) || typeof message.type !== "string") {
    return undefined;
  }
  return { ...message };
}

export function extractAssistantTextDelta(message: ClaudeSDKMessageLike): string {
  if (message.type !== "assistant") {
    return "";
  }
  const inner = (message as { message?: unknown }).message;
  if (!isObject(inner)) {
    return "";
  }
  const content = (inner as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (isObject(block) && block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      text += (block as { text: string }).text;
    }
  }
  return text;
}

/**
 * Projects the canonical MCP model onto the Claude Agent SDK shape:
 * `mcpServers?: Record<string, McpServerConfig>` (see
 * @anthropic-ai/claude-agent-sdk sdk.d.ts:1498). Each named server maps to its
 * OWN key in a single record — NOT an array of records. Returns undefined when
 * the projected record is empty so callers can omit the field entirely.
 */
export function translateMcpServers(
  mcpServers: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  for (const server of parseMcpServers(mcpServers)) {
    out[server.name] = projectClaudeMcpConfig(server);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function projectClaudeMcpConfig(server: NormalizedMcpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      ...(server.command === undefined ? {} : { command: server.command }),
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    };
  }
  if (server.transport === "sse") {
    return {
      type: "sse",
      ...(server.url === undefined ? {} : { url: server.url }),
      ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    };
  }
  return {
    type: "http",
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
