import { randomUUID } from "node:crypto";
import { createServer,type IncomingMessage,type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

interface LoopbackMcpEndpointOptions {
  /** A fresh server for every stateless HTTP dispatch, including failover initialize. */
  readonly createServer: () => McpServer;
  readonly startingResponse: { readonly status: 404 | 503; readonly message: string };
  readonly bodyLimitMessage: string;
  readonly unavailableTransportMessage: string;
  readonly toolCallError?: (tool: string, args: unknown) => string | undefined;
  readonly listen?: (server: Server) => Promise<void>;
  /** Endpoint lifetime, not dispatch lifetime. Also runs after failed startup/close. */
  readonly onRelease?: () => void | Promise<void>;
  /** Runs only after failed-startup cleanup succeeds, before propagating its error. */
  readonly onStartupFailure?: () => void;
}

/** Capability-path loopback dispatch; callers own tool, runtime-spec and failure policy. */
export async function createLoopbackMcpEndpoint(options: LoopbackMcpEndpointOptions): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const path = `/mcp/${randomUUID()}`;
  let port: number | undefined;
  const http = createServer((incoming, response) => {
    if (incoming.url !== path || !isLoopbackHost(incoming.headers.host)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (port === undefined) {
      response.writeHead(options.startingResponse.status, { "content-type": "text/plain; charset=utf-8" });
      response.end(options.startingResponse.message);
      return;
    }
    const boundPort = port;
    void (async () => {
      const parsedBody = incoming.method === "POST" ? await readJsonBody(incoming, options.bodyLimitMessage) : undefined;
      if (options.toolCallError !== undefined) {
        const request = JSONRPCRequestSchema.safeParse(parsedBody);
        if (request.success && request.data.method === "tools/call" && typeof request.data.params?.name === "string") {
          const refusal = options.toolCallError(request.data.params.name, request.data.params.arguments);
          if (refusal !== undefined) {
            const code = /^[a-z_]{1,64}$/u.test(refusal) ? refusal : "invalid_tool_call";
            await writeWebResponse(response, new Response(JSON.stringify({ jsonrpc: "2.0", id: request.data.id,
              result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] },
            }), { headers: { "content-type": "application/json" } }));
            return;
          }
        }
      }
      const webRequest = nodeRequestAsWebRequest(incoming);
      const requestMcp = options.createServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        allowedHosts: [`127.0.0.1:${boundPort}`],
        enableDnsRebindingProtection: true,
      });
      try {
        await requestMcp.connect(transport as never);
        const webResponse = await transport.handleRequest(webRequest, { parsedBody });
        if (webResponse === undefined) throw new Error(options.unavailableTransportMessage);
        await writeWebResponse(response, webResponse);
      } finally {
        await requestMcp.close().catch(() => undefined);
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await closeHttpServer(http);
    } finally {
      await options.onRelease?.();
    }
  };
  try {
    await (options.listen ?? listenLoopback)(http);
    const address = http.address() as AddressInfo;
    port = address.port;
    return { url: `http://127.0.0.1:${address.port}${path}`, close };
  } catch (error) {
    await close();
    options.onStartupFailure?.();
    throw error;
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && /^127\.0\.0\.1:\d+$/u.test(host);
}

async function readJsonBody(request: IncomingMessage, limitMessage: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_000_000) throw new Error(limitMessage);
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
