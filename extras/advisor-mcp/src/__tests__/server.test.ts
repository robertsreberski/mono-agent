import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADVISOR_MAX_REQUEST_BYTES, loadAdvisorConfig, type AdvisorConfig } from "../config.js";
import { advisorMcpPackageVersion } from "../package-version.js";
import { REVIEW_ITERATION_TOOL_NAME } from "../protocol.js";
import type { AdvisorRunFactory, AdvisorRunResult, AdvisorStopReason } from "../run.js";
import {
  assertAdvisorBoundAddress,
  constantTimeBearerMatches,
  startAdvisorServer,
  type RunningAdvisorServer,
} from "../server.js";

const servers: RunningAdvisorServer[] = [];
const clients: Client[] = [];
const ROUTER_METACHARACTER_PATHS = [
  "/mcp/:id",
  "/mcp*",
  "/mcp(",
  "/mcp)",
  "/mcp{segment",
  "/mcp}",
  "/mcp?",
  "/mcp+",
  "/mcp[",
  "/mcp]",
  "/mcp!",
  String.raw`/mcp\literal`,
] as const;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => await client.close()));
  await Promise.allSettled(servers.splice(0).map(async (server) => await server.stop()));
});

async function activeConfig(overrides: Record<string, string> = {}): Promise<AdvisorConfig> {
  return await loadAdvisorConfig({
    env: {
      MONO_AGENT_ADVISOR_ENABLED: "true",
      MONO_AGENT_ADVISOR_HOST: "127.0.0.1",
      MONO_AGENT_ADVISOR_PORT: "0",
      MONO_AGENT_ADVISOR_MODEL: "claude:claude-opus-test",
      MONO_AGENT_ADVISOR_EFFORT: "xhigh",
      ...overrides,
    },
    json: {},
  });
}

function successfulFactory(text = "No blocking findings."): AdvisorRunFactory {
  return {
    async start() {
      return {
        result: Promise.resolve({ text }),
        async stop() {},
        async drain() {},
      };
    },
  };
}

async function start(config: AdvisorConfig, runFactory = successfulFactory()): Promise<RunningAdvisorServer> {
  const server = await startAdvisorServer({ config, runFactory });
  servers.push(server);
  return server;
}

async function openClient(server: RunningAdvisorServer, token?: string): Promise<Client> {
  const client = new Client({ name: "advisor-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    ...(token === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  });
  await client.connect(transport as never);
  clients.push(client);
  return client;
}

const argumentsFixture = {
  session_key: "iteration-session",
  intent: "Review this change.",
  patch: "diff --git a/a.ts b/a.ts",
  verification: "focused tests passed",
};

describe("Advisor Streamable HTTP MCP", () => {
  it("serves one stateless public tool through a real loopback round trip", async () => {
    const server = await start(await activeConfig());
    const client = await openClient(server);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([REVIEW_ITERATION_TOOL_NAME]);
    const result = await client.callTool({ name: REVIEW_ITERATION_TOOL_NAME, arguments: argumentsFixture });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schema: "mono-agent.advisor.v1",
      status: "succeeded",
      code: "ok",
      model: "claude:claude-opus-test",
      effort: "xhigh",
      review: "No blocking findings.",
    });

    const initialize = await rawRequest(server.url, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "raw-test", version: "1.0.0" },
        },
      }),
      headers: mcpHeaders(),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers["mcp-session-id"]).toBeUndefined();
    expect(JSON.parse(initialize.body)).toMatchObject({
      result: {
        serverInfo: {
          name: "mono-agent-advisor",
          version: advisorMcpPackageVersion(),
        },
      },
    });
  });

  it.each(ROUTER_METACHARACTER_PATHS)(
    "rejects router metacharacter path %j with an Advisor configuration error before startup",
    async (path) => {
      const config = { ...await activeConfig(), path };

      await expect(startAdvisorServer({ config, runFactory: successfulFactory() })).rejects.toMatchObject({
        code: "invalid_config",
        message: expect.stringContaining("MONO_AGENT_ADVISOR_PATH"),
      });
    },
  );

  it("rejects unknown tool input keys over the real protocol", async () => {
    const client = await openClient(await start(await activeConfig()));
    const privateKey = `private-${"x".repeat(10_000)}`;
    const result = await client.callTool({
      name: REVIEW_ITERATION_TOOL_NAME,
      arguments: { ...argumentsFixture, [privateKey]: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("MCP error -32602: Input validation error");
    expect(JSON.stringify(result.content)).toContain("unknown");
    expect(JSON.stringify(result).length).toBeLessThan(4_096);
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it("enforces host, origin, and bearer policies before parsing the body", async () => {
    const token = "constant-time-test-token";
    const server = await start(await activeConfig({
      MONO_AGENT_ADVISOR_REQUIRE_BEARER: "true",
      MONO_AGENT_ADVISOR_BEARER_TOKEN: token,
      MONO_AGENT_ADVISOR_ALLOWED_ORIGINS: "https://trusted.example",
    }));
    const body = "not-json";
    const badHost = await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), Host: "attacker.example", Authorization: `Bearer ${token}` },
    });
    expect(badHost.status).toBe(403);
    const userInfoHost = await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), Host: "attacker@127.0.0.1", Authorization: `Bearer ${token}` },
    });
    expect(userInfoHost.status).toBe(403);
    const missingAuth = await rawRequest(server.url, { method: "POST", body, headers: mcpHeaders() });
    expect(missingAuth.status).toBe(401);
    const wrongAuth = await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), Authorization: "Bearer wrong" },
    });
    expect(wrongAuth.status).toBe(401);
    const badOrigin = await rawRequest(server.url, {
      method: "POST",
      body,
      headers: {
        ...mcpHeaders(),
        Authorization: `Bearer ${token}`,
        Origin: "https://attacker.example",
      },
    });
    expect(badOrigin.status).toBe(403);
    const accepted = await rawRequest(server.url, {
      method: "POST",
      body,
      headers: {
        ...mcpHeaders(),
        Authorization: `Bearer ${token}`,
        Origin: "https://trusted.example",
      },
    });
    expect(accepted.status).toBe(400);
    expect(accepted.headers["access-control-allow-origin"]).toBe("https://trusted.example");
  });

  it("uses constant-length digest comparison for bearer values", () => {
    expect(constantTimeBearerMatches("short", ["Bearer short"])).toBe(true);
    expect(constantTimeBearerMatches("short", ["Bearer a-much-longer-wrong-token"])).toBe(false);
    expect(constantTimeBearerMatches("short", [])).toBe(false);
    expect(constantTimeBearerMatches("short", ["Bearer short", "Bearer short"])).toBe(false);
    expect(constantTimeBearerMatches("short", ["Basic short"])).toBe(false);
  });

  it("rejects unsafe resolved bind addresses before advertising the endpoint", async () => {
    const config = await activeConfig();
    expect(() => assertAdvisorBoundAddress(config, { address: "127.0.0.2" })).not.toThrow();
    expect(() => assertAdvisorBoundAddress(config, { address: "203.0.113.10" })).toThrow(
      expect.objectContaining({ code: "unsafe_host" }),
    );
    expect(() => assertAdvisorBoundAddress({
      ...config,
      allowNonLoopback: true,
      bearerToken: "required-token",
      allowedHosts: ["advisor.example.test"],
    }, { address: "0.0.0.0" })).not.toThrow();
  });

  it("enforces content negotiation, protocol, and stateless headers", async () => {
    const server = await start(await activeConfig());
    const body = initializeBody();
    expect((await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), "Content-Type": "text/plain" },
    })).status).toBe(415);
    expect((await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), Accept: "application/json" },
    })).status).toBe(406);
    const unsupported = await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), "Mcp-Protocol-Version": "private-version-value" },
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).not.toContain("private-version-value");
    expect((await rawRequest(server.url, {
      method: "POST",
      body,
      headers: { ...mcpHeaders(), "Mcp-Session-Id": "stateful-session" },
    })).status).toBe(400);
  });

  it("accepts exactly 4 MiB at the parser boundary and rejects one byte more", async () => {
    const server = await start(await activeConfig());
    const exact = jsonBodyOfSize(ADVISOR_MAX_REQUEST_BYTES);
    const accepted = await rawRequest(server.url, {
      method: "POST",
      body: exact,
      headers: mcpHeaders(),
    });
    expect(accepted.status).not.toBe(413);
    const rejected = await rawRequest(server.url, {
      method: "POST",
      body: `${exact} `,
      headers: mcpHeaders(),
    });
    expect(rejected.status).toBe(413);
  }, 20_000);

  it("rejects ambiguous Content-Length plus Transfer-Encoding framing", async () => {
    const server = await start(await activeConfig());
    const target = new URL(server.url);
    const response = await rawSocketRequest(target, [
      `POST ${target.pathname} HTTP/1.1`,
      `Host: ${target.hostname}`,
      "Accept: application/json, text/event-stream",
      "Content-Type: application/json",
      "Content-Length: 2",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      "0",
      "",
      "",
    ].join("\r\n"));
    expect(response).toMatch(/^HTTP\/1\.1 400 /u);
  });

  it("returns bounded redacted model output", async () => {
    const review = [
      "Authorization: Bearer super-secret-value",
      "api_key=do-not-print",
      "OPENAI_API_KEY='environment-secret-value'",
      "sk-1234567890abcdefghijkl",
      "https://private-user:private-password@example.test/path",
      "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
      "/Users/example/private/repository/file.ts",
      "'/Users/example/private folder/file.ts'",
      "/root/private/repository/file.ts",
      "/tmp/private-review/file.ts",
      "/var/tmp/private-review/file.ts",
      "/private/var/folders/aa/private/file",
      "C:\\Users\\example\\private\\file.ts",
    ].join("\n");
    const client = await openClient(await start(await activeConfig(), successfulFactory(review)));
    const result = await client.callTool({ name: REVIEW_ITERATION_TOOL_NAME, arguments: argumentsFixture });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/super-secret|do-not-print|environment-secret|private-password|private-key-material|sk-123|\/Users\/example|\/root\/private|\/tmp\/private|\/var\/tmp\/private|\/private\/var\/folders|C:\\\\Users/u);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("<private-path>");
  });

  it("bounds concurrent runs and never starts a fallback run", async () => {
    const run = pendingRunFactory();
    const server = await start(await activeConfig({ MONO_AGENT_ADVISOR_MAX_CONCURRENT_REVIEWS: "1" }), run.factory);
    const firstClient = await openClient(server);
    const secondClient = await openClient(server);
    const firstCall = firstClient.callTool({ name: REVIEW_ITERATION_TOOL_NAME, arguments: argumentsFixture });
    await run.started;
    const second = await secondClient.callTool({
      name: REVIEW_ITERATION_TOOL_NAME,
      arguments: { ...argumentsFixture, session_key: "other-session" },
    });
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({ status: "busy", code: "advisor_busy" });
    expect(run.start).toHaveBeenCalledTimes(1);
    await firstClient.close();
    await firstCall.catch(() => undefined);
    await waitFor(() => run.stop.mock.calls.length === 1);
    expect(run.drain).toHaveBeenCalledTimes(1);
  });

  it("maps response close to exact-once stop and drain", async () => {
    const run = pendingRunFactory();
    const server = await start(await activeConfig(), run.factory);
    const call = openRawToolCall(server.url);
    await run.started;
    call.destroy();
    await waitFor(() => run.stop.mock.calls.length === 1);
    expect(run.stop.mock.calls[0]?.[0]).toBe("client_disconnected");
    expect(run.drain).toHaveBeenCalledTimes(1);
    await call.completed.catch(() => undefined);
  });

  it("stops and drains active runs exactly once during server shutdown", async () => {
    const run = pendingRunFactory();
    const server = await start(await activeConfig(), run.factory);
    const call = openRawToolCall(server.url);
    await run.started;
    await server.stop();
    expect(run.stop).toHaveBeenCalledTimes(1);
    expect(run.stop).toHaveBeenCalledWith("server_shutdown");
    expect(run.drain).toHaveBeenCalledTimes(1);
    await call.completed.catch(() => undefined);
  });

  it("allows only POST plus origin preflight on the endpoint", async () => {
    const server = await start(await activeConfig({
      MONO_AGENT_ADVISOR_ALLOWED_ORIGINS: "https://trusted.example",
    }));
    expect((await rawRequest(server.url, { method: "GET" })).status).toBe(405);
    expect((await rawRequest(server.url, { method: "DELETE" })).status).toBe(405);
    const preflight = await rawRequest(server.url, {
      method: "OPTIONS",
      headers: { Origin: "https://trusted.example" },
    });
    expect(preflight.status).toBe(204);
  });
});

function pendingRunFactory() {
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolvePromise) => {
    notifyStarted = resolvePromise;
  });
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<AdvisorRunResult>((_resolve, reject) => {
    rejectResult = reject;
  });
  const order: string[] = [];
  const stop = vi.fn(async (reason: AdvisorStopReason) => {
    order.push(`stop:${reason}`);
    rejectResult(new Error("stopped"));
  });
  const drain = vi.fn(async () => {
    order.push("drain");
    await result.catch(() => undefined);
  });
  const start = vi.fn(async () => {
    notifyStarted();
    return { result, stop, drain };
  });
  return { factory: { start } satisfies AdvisorRunFactory, start, started, stop, drain, order };
}

function mcpHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": LATEST_PROTOCOL_VERSION,
  };
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "raw-test", version: "1.0.0" },
    },
  });
}

function jsonBodyOfSize(bytes: number): string {
  const prefix = '{"padding":"';
  const suffix = '"}';
  return `${prefix}${"x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function rawRequest(
  url: string,
  options: { readonly method: string; readonly body?: string; readonly headers?: Record<string, string> },
): Promise<RawResponse> {
  const target = new URL(url);
  const body = options.body ?? "";
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: options.method,
      headers: {
        ...(body.length === 0 ? {} : { "Content-Length": Buffer.byteLength(body) }),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", rejectPromise);
    request.end(body);
  });
}

function rawSocketRequest(target: URL, payload: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = netConnect({ host: target.hostname, port: Number(target.port) });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("end", () => resolvePromise(response));
    socket.once("error", rejectPromise);
  });
}

function openRawToolCall(url: string): { readonly destroy: () => void; readonly completed: Promise<void> } {
  const target = new URL(url);
  let request: ReturnType<typeof httpRequest>;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: REVIEW_ITERATION_TOOL_NAME, arguments: argumentsFixture },
  });
  const completed = new Promise<void>((resolvePromise, rejectPromise) => {
    request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { ...mcpHeaders(), "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.once("end", resolvePromise);
    });
    request.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
        resolvePromise();
      } else {
        rejectPromise(error);
      }
    });
    request.end(body);
  });
  return {
    destroy: () => request.destroy(),
    completed,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for advisor test condition.");
}
