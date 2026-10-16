import { request, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { createLoopbackMcpEndpoint } from "../mcp/loopback-transport.js";
import { createRequestScopedMcpRuntimeExtension } from "../request-scoped-mcp.js";

const token = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), randomUUID: () => token }));

function options() {
  return {
    createServer: () => {
      const server = new McpServer({ name: "loopback-test", version: "1" });
      server.registerTool("Echo", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ready" }] }));
      return server;
    },
    startingResponse: { status: 503 as const, message: "starting" },
    bodyLimitMessage: "bounded body",
    unavailableTransportMessage: "transport unavailable",
  };
}
async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
}
async function raw(url: string, body?: string, host?: string, headers: Readonly<Record<string, string>> = {}): Promise<{ status: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { method: body === undefined ? "GET" : "POST", headers: { ...(host === undefined ? {} : { host }), "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("loopback MCP transport", () => {
  it("mints a fresh stateless dispatch for reinitialization after failover", async () => {
    const base = options();
    const createServer = vi.fn(base.createServer);
    const release = vi.fn();
    const endpoint = await createLoopbackMcpEndpoint({ ...base, createServer, onRelease: release });
    try {
      for (let i = 0; i < 2; i += 1) {
        const client = new Client({ name: "loopback-client", version: "1" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)) as never);
          expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("Echo");
          expect((await client.callTool({ name: "Echo", arguments: {} })).content).toEqual([{ type: "text", text: "ready" }]);
        } finally { await client.close(); }
      }
      expect(createServer.mock.calls.length).toBeGreaterThanOrEqual(6);
      expect(release).not.toHaveBeenCalled();
    } finally { await endpoint.close(); }
    await endpoint.close();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves path/Host denial and malformed body responses", async () => {
    const endpoint = await createLoopbackMcpEndpoint(options());
    try {
      expect(await raw(new URL("/other", endpoint.url).href)).toEqual({ status: 404, text: "Not found" });
      expect(await raw(endpoint.url, undefined, "localhost:1234")).toEqual({ status: 404, text: "Not found" });
      expect((await raw(endpoint.url, "{")).status).toBe(500);
    } finally { await endpoint.close(); }
  });

  it("accepts valid MCP at the byte limit and rejects one byte over with the exact size error", async () => {
    const base = options();
    const createServer = vi.fn(base.createServer);
    const endpoint = await createLoopbackMcpEndpoint({ ...base, createServer });
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "byte-limit-test", version: "1" },
    } };
    const json = JSON.stringify(initialize);
    const atLimit = json + " ".repeat(1_000_000 - Buffer.byteLength(json));
    const overLimit = `${atLimit} `;
    const headers = { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" };
    expect(Buffer.byteLength(atLimit)).toBe(1_000_000);
    expect(Buffer.byteLength(overLimit)).toBe(1_000_001);
    expect(JSON.parse(overLimit)).toEqual(initialize);
    try {
      const accepted = await raw(endpoint.url, atLimit, undefined, headers);
      expect(accepted.status).toBe(200);
      expect(JSON.parse(accepted.text)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "loopback-test" } } });
      expect(createServer).toHaveBeenCalledOnce();
      // HTTP intentionally redacts internal errors to an empty 500. Observe
      // the real constructor to pin the caller's error label without exposing it.
      const error = vi.spyOn(globalThis, "Error");
      try {
        expect(await raw(endpoint.url, overLimit, undefined, headers)).toEqual({ status: 500, text: "" });
        expect(error).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith("bounded body");
        expect(createServer).toHaveBeenCalledOnce();
      } finally { error.mockRestore(); }
    } finally { await endpoint.close(); }
  });

  it.each([503, 404] as const)("keeps the caller's %s starting policy", async (status) => {
    const endpoint = await createLoopbackMcpEndpoint({ ...options(), startingResponse: { status, message: status === 404 ? "Not found" : "starting" }, listen: async (server) => {
      await listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing address");
      expect(await raw(`http://127.0.0.1:${address.port}/mcp/${token}`)).toEqual({ status, text: status === 404 ? "Not found" : "starting" });
    } });
    try { expect(await raw(new URL("/wrong", endpoint.url).href)).toEqual({ status: 404, text: "Not found" }); }
    finally { await endpoint.close(); }
  });

  it("runs code-only refusal before allocating an SDK dispatch", async () => {
    const createServer = vi.fn(options().createServer);
    const endpoint = await createLoopbackMcpEndpoint({ ...options(), createServer, toolCallError: () => "not_allowed" });
    try {
      const response = await raw(endpoint.url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "Echo", arguments: {} } }));
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).result).toMatchObject({ isError: true, content: [{ text: '{"error":"not_allowed"}' }] });
      expect(createServer).not.toHaveBeenCalled();
    } finally { await endpoint.close(); }
  });

  it("closes each failed SDK dispatch without releasing the endpoint", async () => {
    const server = options().createServer();
    const close = vi.spyOn(server, "close");
    vi.spyOn(server, "connect").mockRejectedValue(new Error("connect failed"));
    const release = vi.fn();
    const endpoint = await createLoopbackMcpEndpoint({ ...options(), createServer: () => server, onRelease: release });
    try {
      expect((await raw(endpoint.url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))).status).toBe(500);
      expect(close).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
    } finally { await endpoint.close(); }
    expect(release).toHaveBeenCalledOnce();
  });

  it("closes after an unavailable SDK response and swallows SDK close failure", async () => {
    const server = options().createServer();
    const close = vi.spyOn(server, "close").mockRejectedValue(new Error("SDK close failed"));
    const handle = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest").mockResolvedValue(undefined as unknown as Response); // Simulate an unavailable SDK response.
    const endpoint = await createLoopbackMcpEndpoint({ ...options(), createServer: () => server });
    try {
      expect((await raw(endpoint.url, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))).status).toBe(500);
      expect(close).toHaveBeenCalledOnce();
    } finally { handle.mockRestore(); close.mockRestore(); await server.close(); await endpoint.close(); }
  });

  it("releases once on failed startup even when HTTP close itself throws", async () => {
    const release = vi.fn();
    const failedStartup = vi.fn();
    await expect(createLoopbackMcpEndpoint({ ...options(), onRelease: release, onStartupFailure: failedStartup, listen: async (server) => {
      server.closeAllConnections = () => { throw new Error("close failed"); };
      throw new Error("listen failed");
    } })).rejects.toThrow("close failed");
    expect(release).toHaveBeenCalledOnce();
    expect(failedStartup).not.toHaveBeenCalled();
  });
});

it("omits request tools after clean startup failure but propagates failed startup cleanup", async () => {
  const diagnostic = vi.fn(() => { throw new Error("diagnostic failed"); });
  const config = { serverName: "test", startingMessage: "starting", createServer: options().createServer, onUnavailable: diagnostic };
  const omitted = await createRequestScopedMcpRuntimeExtension({ ...config, listen: async () => { throw new Error("startup failed"); } })({} as never);
  expect(omitted.runtimeOptions?.mcpServers).toEqual({});
  expect(diagnostic).toHaveBeenCalledOnce();
  await omitted.cleanup?.();
  diagnostic.mockClear();
  await expect(createRequestScopedMcpRuntimeExtension({ ...config, listen: async (server) => {
    server.closeAllConnections = () => { throw new Error("close failed"); };
    throw new Error("startup failed");
  } })({} as never)).rejects.toThrow("close failed");
  expect(diagnostic).not.toHaveBeenCalled();
});
