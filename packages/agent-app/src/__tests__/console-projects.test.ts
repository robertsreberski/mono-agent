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

it("registers the five strict tag schemas and validates the independent palette and additive arguments", async () => {
  const schemas = CONSOLE_PROJECT_SCHEMAS;
  const tagTools = ["ListTags", "CreateTag", "UpdateTag", "DeleteTag", "UpdateConversationTags"] as const;
  expect(tagTools.every((name) => name in schemas)).toBe(true);
  expect(schemas.CreateTag.safeParse({ name: "planning", color: "green" }).success).toBe(true);
  expect(schemas.CreateProject.safeParse({ name: "P", color: "green" }).success).toBe(false);
  expect(schemas.UpdateTag.safeParse({ tagId: "tag" }).success).toBe(false);
  expect(schemas.UpdateConversationTags.safeParse({}).success).toBe(false);
  expect(schemas.UpdateConversationTags.safeParse({ add: [], remove: [] }).success).toBe(true);
  for (const key of ["add", "remove"] as const) {
    expect(schemas.UpdateConversationTags.safeParse({ [key]: Array.from({ length: 20 }, (_, i) => `tag-${String(i)}`) }).success).toBe(true);
    expect(schemas.UpdateConversationTags.safeParse({ [key]: Array.from({ length: 21 }, (_, i) => `tag-${String(i)}`) }).success).toBe(false);
  }
  expect(schemas.CreateTag.safeParse({ name: `  ${"x".repeat(120)}  ` }).success).toBe(true);
  for (const separator of ["\u0085", "\u2028", "\u2029"]) {
    expect(schemas.CreateTag.safeParse({ name: `a${separator}b` }).success).toBe(false);
  }
  expect(schemas.ListConversations.safeParse({ tagId: "tag" }).success).toBe(true);
  for (const name of tagTools) expect(schemas[name].safeParse({ name: "x", tagId: "tag", add: [], sourceId: "forged" }).success).toBe(false);
  const call = vi.fn().mockResolvedValue({ tags: [] });
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", policy: { allowedTools: ["mcp__mono-agent-console-projects__*"], disallowedTools: [] }, createClient: vi.fn().mockResolvedValue(call) })(request());
  const client = new Client({ name: "tags-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(Object.keys(schemas).sort());
    expect((await client.callTool({ name: "ListTags", arguments: {} })).structuredContent).toEqual({ tags: [] });
    expect((await client.callTool({ name: "UpdateConversationTags", arguments: { tagIds: ["x"] } })).isError).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await bound.cleanup?.(); }
});
