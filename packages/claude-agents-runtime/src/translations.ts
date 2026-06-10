import type { RuntimeEventLike } from "@mono-agent/runtime-adapter";

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

export function translateMcpServers(
  mcpServers: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (mcpServers === undefined || Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  return [normalizeMcpServerRecord(mcpServers)];
}

function normalizeMcpServerRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !isObject(value)) {
      continue;
    }
    out[name] = { ...value };
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
