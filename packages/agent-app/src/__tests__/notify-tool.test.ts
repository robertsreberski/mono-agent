import { afterEach, describe, expect, it, vi } from "vitest";

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startNotifyToolsServer, type NotifyToolsServer } from "../notify-tool.js";

const servers: NotifyToolsServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function start(deps: Parameters<typeof startNotifyToolsServer>[0]): Promise<NotifyToolsServer> {
  const server = await startNotifyToolsServer(deps);
  servers.push(server);
  return server;
}

async function connect(server: NotifyToolsServer, token = server.token): Promise<McpClient> {
  const client = new McpClient({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe("notify tools server", () => {
  it("notify_conversation routes to the deliver hook and returns its structured result", async () => {
    const deliver = vi.fn(async () => ({ delivered: true as const }));
    const server = await start({ deliver, listDestinations: async () => [] });
    const client = await connect(server);

    const result = await client.callTool({
      name: "notify_conversation",
      arguments: { conversationId: "telegram:42", text: "deploy finished" },
    });

    expect(deliver).toHaveBeenCalledWith("telegram:42", "deploy finished");
    expect(result.structuredContent).toEqual({ delivered: true });
  });

  it("surfaces a not-delivered result with its reason", async () => {
    const server = await start({
      deliver: async () => ({ delivered: false, reason: "telegram chat is not in the adapter allowlist" }),
      listDestinations: async () => [],
    });
    const client = await connect(server);

    const result = await client.callTool({
      name: "notify_conversation",
      arguments: { conversationId: "telegram:999", text: "x" },
    });

    expect(result.structuredContent).toEqual({
      delivered: false,
      reason: "telegram chat is not in the adapter allowlist",
    });
  });

  it("list_notify_destinations returns the candidate conversations", async () => {
    const server = await start({
      deliver: async () => ({ delivered: false }),
      listDestinations: async () => [
        { conversationId: "telegram:42", channelId: "telegram", lastSeen: "2026-06-20T10:00:00Z" },
        { conversationId: "slack:C1", channelId: "slack", fromAllowlist: true },
      ],
    });
    const client = await connect(server);

    const result = await client.callTool({ name: "list_notify_destinations", arguments: {} });

    expect(result.structuredContent).toEqual({
      destinations: [
        { conversationId: "telegram:42", channelId: "telegram", lastSeen: "2026-06-20T10:00:00Z" },
        { conversationId: "slack:C1", channelId: "slack", fromAllowlist: true },
      ],
    });
  });

  it("rejects a request without the bearer token", async () => {
    const server = await start({ deliver: async () => ({ delivered: false }), listDestinations: async () => [] });
    const client = new McpClient({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
