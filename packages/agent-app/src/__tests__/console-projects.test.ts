import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE_PROJECT_SCHEMAS, createConsoleProjectsRuntimeExtension, isConsoleProjectToolAllowed } from "../console-projects.js";

const request = (): AgentHarnessRuntimeOptionsInput => ({
  request: { conversationId: "web:thread", userMessage: "Organize", abortSignal: new AbortController().signal,
    metadata: { source: "web", web: { threadId: "thread", turnId: "turn", consoleProjects: { schema: 1 } } } },
  runId: "run", context: {} as never,
});

describe("console project tools", () => {
  for (const name of Object.keys(CONSOLE_PROJECT_SCHEMAS) as Array<keyof typeof CONSOLE_PROJECT_SCHEMAS>) {
    it(`honors every policy spelling and deny for ${name}`, () => {
      for (const alias of [name, `mcp__mono-agent-console-projects__${name}`, "mcp__mono-agent-console-projects__*", "*"]) {
        expect(isConsoleProjectToolAllowed(name, { allowedTools: [alias], disallowedTools: [] })).toBe(true);
        expect(isConsoleProjectToolAllowed(name, { allowedTools: ["*"], disallowedTools: [alias] })).toBe(false);
      }
      expect(isConsoleProjectToolAllowed(name, { allowedTools: ["Read"], disallowedTools: [] })).toBe(false);
    });
  }
  it("exposes only allowed tools, returns real callback results, and gives independent calls distinct identities", async () => {
    const call = vi.fn().mockResolvedValue({ projectId: "created", disposition: "pending" });
    const createClient = vi.fn().mockResolvedValue(call);
    const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured-source", policy: { allowedTools: ["CreateProject"], disallowedTools: [] }, createClient })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    const client = new Client({ name: "test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["CreateProject"]);
      expect(JSON.stringify(listed)).not.toMatch(/authorization|capability|endpoint|token|sourceId/u);
      const first = await client.callTool({ name: "CreateProject", arguments: { name: "Project", attachCurrentConversation: true } });
      const second = await client.callTool({ name: "CreateProject", arguments: { name: "Project", attachCurrentConversation: true } });
      expect(first.structuredContent).toEqual({ projectId: "created", disposition: "pending" });
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(createClient).toHaveBeenCalledWith({ sourceId: "configured-source", threadId: "thread", turnId: "turn" });
      expect(call.mock.calls[0]![0].operationId).not.toBe(call.mock.calls[1]![0].operationId);
      const invalid = await client.callTool({ name: "CreateProject", arguments: { name: "P", endpoint: "http://foreign" } });
      expect(invalid.isError).toBe(true);
      expect(call).toHaveBeenCalledTimes(2);
      call.mockRejectedValueOnce({ code: "console_tool_delivery_unknown", message: "http://secret/token" });
      const failed = await client.callTool({ name: "CreateProject", arguments: { name: "P" } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toContain("secret");
      expect(call).toHaveBeenCalledTimes(3);
    } finally { await client.close(); await bound.cleanup?.(); }
  });
  it("does not authorize metadata without owner authentication or a writable interactive source", async () => {
    const createClient = vi.fn().mockRejectedValue(new Error("unavailable"));
    const extension = createConsoleProjectsRuntimeExtension({ sourceId: "configured", policy: { allowedTools: ["*"], disallowedTools: [] }, createClient });
    expect((await extension(request())).runtimeOptions).toEqual({});
    const forged = request();
    expect((await extension({ ...forged, request: { ...forged.request, conversationId: "web:other" } })).runtimeOptions).toEqual({});
    expect((await extension({ ...forged, request: { ...forged.request, metadata: { source: "cron" } } })).runtimeOptions).toEqual({});
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
