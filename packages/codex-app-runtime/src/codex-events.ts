// Ported from worklab/packages/agent-runtime/src/ai/streaming/codex-events.js
// (verbatim translation to TypeScript; preserves behavior of normalizeCodexItemEvent).

import type { RuntimeEventLike } from "@mono-agent/runtime-adapter";

const CODEX_ITEM_EVENTS = new Set(["item.started", "item.completed"]);

interface CodexRawNotification {
  readonly type?: string;
  readonly item?: CodexItem;
}

interface CodexItem {
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly text?: string;
  readonly error?: unknown;
  readonly exit_code?: number;
  readonly exitCode?: number;
  readonly server?: string;
  readonly tool?: string;
  readonly command?: string;
  readonly aggregated_output?: string;
  readonly aggregatedOutput?: string;
  readonly output?: string;
  readonly arguments?: unknown;
  readonly result?: CodexResultPayload;
  readonly changes?: unknown;
  readonly summary?: string;
}

interface CodexResultPayload {
  readonly structuredContent?: unknown;
  readonly structured_content?: unknown;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

export interface NormalizeCodexItemContext {
  readonly fileChangePayload?: (raw: CodexRawNotification, item: CodexItem) => unknown;
}

export function normalizeCodexItemType(type: string | undefined): string {
  if (type === "commandExecution") return "command_execution";
  if (type === "mcpToolCall") return "mcp_tool_call";
  if (type === "fileChange") return "file_change";
  if (type === "agentMessage") return "agent_message";
  return type ?? "";
}

function isCompleted(raw: CodexRawNotification): boolean {
  return raw.type === "item.completed";
}

function itemId(item: CodexItem | undefined, fallback: string): string {
  return item?.id !== undefined && item.id.length > 0 ? item.id : fallback;
}

function itemStatus(item: CodexItem | undefined, raw: CodexRawNotification): string {
  return item?.status !== undefined && item.status.length > 0
    ? item.status
    : isCompleted(raw)
      ? "completed"
      : "in_progress";
}

function itemFailed(item: CodexItem): boolean {
  const status = String(item.status ?? "").toLowerCase();
  const exitCode = item.exit_code ?? item.exitCode;
  return Boolean(
    item.error ||
      status === "failed" ||
      status === "errored" ||
      status === "error" ||
      (typeof exitCode === "number" && exitCode !== 0),
  );
}

function commandOutput(item: CodexItem): string {
  return item.aggregated_output ?? item.aggregatedOutput ?? item.output ?? "";
}

function mcpToolName(item: CodexItem): string {
  return item.server !== undefined && item.tool !== undefined
    ? `mcp__${item.server}__${item.tool}`
    : item.tool ?? "mcp_tool_call";
}

function mcpResultContent(item: CodexItem): unknown {
  if (item.error) return item.error;
  if (item.result?.structuredContent != null) return item.result.structuredContent;
  if (item.result?.structured_content != null) return item.result.structured_content;
  if (item.result?.content != null) return item.result.content;
  return item.result ?? "";
}

function fileChangePayload(
  raw: CodexRawNotification,
  item: CodexItem,
  context: NormalizeCodexItemContext,
): unknown {
  if (typeof context.fileChangePayload === "function") {
    const payload = context.fileChangePayload(raw, item);
    if (payload !== undefined && payload !== null) return payload;
  }
  return {
    changes: Array.isArray(item.changes) ? item.changes : [],
    status: itemStatus(item, raw),
    ...(item.summary !== undefined && item.summary.length > 0 ? { summary: item.summary } : {}),
  };
}

export function normalizeCodexItemEvent(
  raw: CodexRawNotification | undefined,
  context: NormalizeCodexItemContext = {},
): RuntimeEventLike | null {
  if (!raw || typeof raw.type !== "string" || !CODEX_ITEM_EVENTS.has(raw.type) || !raw.item) {
    return null;
  }
  const item = raw.item;
  const type = normalizeCodexItemType(item.type);

  if (type === "file_change") {
    const id = itemId(item, "file_change");
    const payload = fileChangePayload(raw, item, context);
    if (!isCompleted(raw)) {
      return {
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: "file_edit", input: payload }] },
      };
    }
    return {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: item.error ?? payload,
            is_error: itemFailed(item),
          },
        ],
      },
    };
  }

  if (type === "mcp_tool_call") {
    const id = itemId(item, `${item.server ?? "mcp"}:${item.tool ?? "tool"}`);
    if (!isCompleted(raw)) {
      return {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id, name: mcpToolName(item), input: item.arguments ?? {} },
          ],
        },
      };
    }
    return {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: mcpResultContent(item),
            is_error: itemFailed(item),
          },
        ],
      },
    };
  }

  if (type === "command_execution") {
    const id = itemId(item, item.command ?? "command_execution");
    if (!isCompleted(raw)) {
      return {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id, name: "command_execution", input: { command: item.command ?? "" } },
          ],
        },
      };
    }
    return {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            content: commandOutput(item),
            is_error: itemFailed(item),
          },
        ],
      },
    };
  }

  if (type === "agent_message" && isCompleted(raw) && typeof item.text === "string") {
    return { type: "assistant", message: { content: [{ type: "text", text: item.text }] } };
  }

  return null;
}
