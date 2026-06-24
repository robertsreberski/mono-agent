import { describe, expect, it } from "vitest";

import { createNotifyToolsRuntimeExtension } from "../notify-runtime.js";
import { NOTIFY_TOOLS_MCP_SERVER_NAME } from "../notify-tool.js";

const ext = createNotifyToolsRuntimeExtension({ url: "http://127.0.0.1:1/mcp", token: "tok" });

describe("createNotifyToolsRuntimeExtension", () => {
  it("injects the notify MCP server on cron trigger turns", async () => {
    const result = await ext({ request: { metadata: { cron: { jobId: "morning" } } } });
    expect(result.runtimeOptions.mcpServers?.[NOTIFY_TOOLS_MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("does NOT inject notify tools on cron turns with native notification enabled", async () => {
    const result = await ext({
      request: {
        metadata: {
          cron: {
            jobId: "morning",
            nativeNotify: { enabled: true, conversationId: "telegram:42" },
          },
        },
      },
    });
    expect(result.runtimeOptions.mcpServers).toBeUndefined();
  });

  it("injects the notify MCP server on webhook trigger turns", async () => {
    const result = await ext({ request: { metadata: { webhook: { endpoint: "deploy-callback" } } } });
    expect(result.runtimeOptions.mcpServers?.[NOTIFY_TOOLS_MCP_SERVER_NAME]).toBeDefined();
  });

  it("does NOT inject notify tools on webhook turns with native notification enabled", async () => {
    const result = await ext({
      request: {
        metadata: {
          webhook: {
            endpointName: "deploy-callback",
            nativeNotify: { enabled: true, conversationId: "telegram:42" },
          },
        },
      },
    });
    expect(result.runtimeOptions.mcpServers).toBeUndefined();
  });

  it("does NOT inject on live channel turns (telegram metadata)", async () => {
    const result = await ext({ request: { metadata: { telegram: { chat: { id: 42 } } } } });
    expect(result.runtimeOptions.mcpServers).toBeUndefined();
  });

  it("does NOT inject when the request carries no metadata", async () => {
    const result = await ext({ request: {} });
    expect(result.runtimeOptions.mcpServers).toBeUndefined();
  });
});
