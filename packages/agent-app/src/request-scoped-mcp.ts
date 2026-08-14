import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";

/** Pi bounds MCP text content at 12,000 characters; leave framing headroom. */
export const REQUEST_SCOPED_MCP_MODEL_TEXT_MAX_CHARS = 10_000;
export const REQUEST_SCOPED_MCP_MAX_CURSOR_BYTES = 2_048;
export const REQUEST_SCOPED_MCP_NESTED_RESULT_OMISSION =
  "[nested history-tool result omitted; inspect the referenced record directly]";

export interface RequestScopedMcpEndpointOptions {
  readonly serverName: string;
  readonly startingMessage: string;
  /** A fresh server is required for every stateless HTTP request. */
  readonly createServer: (input: Parameters<RuntimeOptionsExtension>[0]) => McpServer;
  readonly onUnavailable?: (error: unknown) => void;
}

/**
 * Create one capability-path loopback endpoint per model request. Each HTTP
 * request gets a fresh MCP server and stateless transport so model failover may
 * initialize again without inheriting transport state.
 */
export function createRequestScopedMcpRuntimeExtension(
  options: RequestScopedMcpEndpointOptions,
): RuntimeOptionsExtension {
  return async (input) => {
    const path = `/mcp/${randomUUID()}`;
    let port: number | undefined;
    const http = createServer((incoming, response) => {
      if (incoming.url !== path || !isLoopbackHost(incoming.headers.host)) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (port === undefined) {
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        response.end(options.startingMessage);
        return;
      }
      const boundPort = port;
      void (async () => {
        const parsedBody = incoming.method === "POST" ? await readJsonBody(incoming) : undefined;
        const webRequest = nodeRequestAsWebRequest(incoming);
        const requestMcp = options.createServer(input);
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          allowedHosts: [`127.0.0.1:${boundPort}`],
          enableDnsRebindingProtection: true,
        });
        try {
          await requestMcp.connect(transport as never);
          const webResponse = await transport.handleRequest(webRequest, { parsedBody });
          if (webResponse === undefined) throw new Error(`${options.serverName} MCP transport is unavailable.`);
          await writeWebResponse(response, webResponse);
        } finally {
          await requestMcp.close().catch(() => undefined);
        }
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });

    try {
      await listenLoopback(http);
      const address = http.address() as AddressInfo;
      port = address.port;
      let closed = false;
      return {
        runtimeOptions: {
          mcpServers: {
            [options.serverName]: {
              type: "http",
              url: `http://127.0.0.1:${address.port}${path}`,
            },
          },
        },
        cleanup: async () => {
          if (closed) return;
          closed = true;
          await closeHttpServer(http);
        },
      };
    } catch (error) {
      await closeHttpServer(http);
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

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^127\.0\.0\.1:\d+$/u.test(host);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error("Request-scoped MCP body exceeds 1 MB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function nodeRequestAsWebRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${String(request.headers.host)}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
  });
}

async function writeWebResponse(response: import("node:http").ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(webResponse.status, headers);
  if (webResponse.body === null) { response.end(); return; }
  const reader = webResponse.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => { server.off("error", onError); resolve(); });
  });
}

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
