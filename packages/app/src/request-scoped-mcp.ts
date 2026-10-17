import { createHash } from "node:crypto";
import type { Server } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createLoopbackMcpEndpoint } from "./mcp/loopback-transport.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

/** Pi bounds MCP text content at 12,000 characters; leave framing headroom. */
const REQUEST_SCOPED_MCP_MODEL_TEXT_MAX_CHARS = 10_000;
const REQUEST_SCOPED_MCP_MAX_CURSOR_BYTES = 2_048;
const REQUEST_SCOPED_MCP_NESTED_RESULT_OMISSION =
  "[nested history-tool result omitted; inspect the referenced record directly]";

interface RequestScopedMcpEndpointOptions {
  readonly serverName: string;
  readonly startingMessage: string;
  /** A fresh server is required for every SDK-dispatched stateless HTTP request. */
  readonly createServer: (input: Parameters<RuntimeOptionsExtension>[0]) => McpServer;
  readonly onUnavailable?: (error: unknown) => void;
  /** Optional code-only refusal before SDK input diagnostics; advertised schemas stay strict. */
  readonly toolCallError?: (tool: string, args: unknown) => string | undefined;
  /** Test seam for simulating loopback startup failure. */
  readonly listen?: (server: Server) => Promise<void>;
}

/** Per-request tool adapter; startup failures omit only explicit tools. */
export function createRequestScopedMcpRuntimeExtension(options: RequestScopedMcpEndpointOptions): RuntimeOptionsExtension {
  return async (input) => {
    let startupCleanupSucceeded = false;
    try {
      const endpoint = await createLoopbackMcpEndpoint({
        createServer: () => options.createServer(input),
        onStartupFailure: () => { startupCleanupSucceeded = true; },
        startingResponse: { status: 503, message: options.startingMessage },
        bodyLimitMessage: "Request-scoped MCP body exceeds 1 MB.",
        unavailableTransportMessage: `${options.serverName} MCP transport is unavailable.`,
        ...(options.toolCallError === undefined ? {} : { toolCallError: options.toolCallError }),
        ...(options.listen === undefined ? {} : { listen: options.listen }),
      });
      return {
        runtimeOptions: { mcpServers: { [options.serverName]: { type: "http", url: endpoint.url } } },
        cleanup: endpoint.close,
      };
    } catch (error) {
      if (!startupCleanupSucceeded) throw error;
      try { options.onUnavailable?.(error); } catch { /* diagnostics are best-effort */ }
      return { runtimeOptions: { mcpServers: {} }, cleanup: async () => {} };
    }
  };
}

export function requestScopedCurrentRunBlocked(candidateRunId: string, currentRunId: string): boolean {
  return candidateRunId === currentRunId;
}

export function requestScopedConversationMatches(
  candidateConversationId: string,
  requestConversationId: string,
  rollover: "none" | "daily" | undefined,
): boolean {
  if (rollover !== "daily") return candidateConversationId === requestConversationId;
  const suffix = /#\d{4}-\d{2}-\d{2}$/u;
  return candidateConversationId.replace(suffix, "") === requestConversationId.replace(suffix, "");
}

export function requestScopedNestedResult(
  toolName: string,
  aliases: readonly string[],
  value: unknown,
  omission = REQUEST_SCOPED_MCP_NESTED_RESULT_OMISSION,
): unknown {
  return aliases.some((alias) => toolName === alias || toolName.endsWith(`__${alias}`))
    ? omission
    : value;
}

export function splitRequestScopedModelText(
  section: string,
): Array<{ readonly type: "text"; readonly text: string }> {
  if (section.length <= REQUEST_SCOPED_MCP_MODEL_TEXT_MAX_CHARS) return [{ type: "text", text: section }];
  const chunkChars = REQUEST_SCOPED_MCP_MODEL_TEXT_MAX_CHARS - 100;
  const chunks: string[] = [];
  for (let offset = 0; offset < section.length; offset += chunkChars) chunks.push(section.slice(offset, offset + chunkChars));
  return chunks.map((chunk, index) => ({
    type: "text" as const,
    text: `[continued section ${String(index + 1)} of ${String(chunks.length)}]\n${chunk}`,
  }));
}

/** Unsigned cursor, matching RunHistory: structure + binding digest provide validation. */
export function encodeRequestScopedCursor(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeRequestScopedCursor(cursor: string): Record<string, unknown> | undefined {
  if (
    cursor.length === 0
    || Buffer.byteLength(cursor, "utf8") > REQUEST_SCOPED_MCP_MAX_CURSOR_BYTES
    || !/^[a-z0-9_-]+$/iu.test(cursor)
  ) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function requestScopedCursorDigest(parts: readonly (string | number | boolean | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
