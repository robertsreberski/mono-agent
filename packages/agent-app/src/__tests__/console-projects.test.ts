import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE_PROJECT_SCHEMAS, createConsoleProjectsRuntimeExtension, isConsoleProjectToolAllowed } from "../console-projects.js";

const request = (): AgentHarnessRuntimeOptionsInput => ({
  request: { conversationId: "web:thread", userMessage: "Organize", abortSignal: new AbortController().signal,
    metadata: { source: "web", web: { threadId: "thread", turnId: "turn", ownerText: "Organize", consoleProjects: { schema: 1 } } } },
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
    const forged = request();
    for (const input of [request(), { ...forged, request: { ...forged.request, conversationId: "web:other" } }, { ...forged, request: { ...forged.request, metadata: { source: "cron" } } }]) {
      const bound = await extension(input);
      const servers = bound.runtimeOptions?.mcpServers as Record<string, { url: string }>;
      const client = new Client({ name: "console-refusal", version: "1.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(servers["mono-agent-console-projects"]!.url)) as never);
        expect((await client.listTools()).tools).toHaveLength(Object.keys(CONSOLE_PROJECT_SCHEMAS).length);
        const result = await client.callTool({ name: "CreateProject", arguments: { name: "Refused" } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
      } finally { await client.close(); await bound.cleanup?.(); }
    }
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
    call.mockResolvedValueOnce({ conversationId: "thread", readRevision: 3 });
    expect((await client.callTool({ name: "MarkConversationRead", arguments: {} })).structuredContent)
      .toEqual({ conversationId: "thread", readRevision: 3 });
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ tool: "MarkConversationRead", args: {} }));
  } finally { await client.close(); await bound.cleanup?.(); }
});


it("registers strict conversation-only wake tools and gives safe, actionable wake errors", async () => {
  const schemas = CONSOLE_PROJECT_SCHEMAS;
  expect(schemas.GetWakeSchedule.safeParse({}).success).toBe(true);
  for (const name of ["GetWakeSchedule", "SetWakeSchedule", "ClearWakeSchedule"] as const) {
    expect(schemas[name].safeParse({ conversationId: "other" }).success).toBe(false);
    expect(isConsoleProjectToolAllowed(name, { allowedTools: [name] })).toBe(true);
  }
  const once = { kind: "once", timezone: "UTC", localAt: "2030-01-01T09:00" };
  const weekly = { kind: "weekly", timezone: "UTC", days: [1], times: ["09:00"] };
  expect(schemas.SetWakeSchedule.safeParse(once).success).toBe(true);
  expect(schemas.SetWakeSchedule.safeParse({ ...once, expectedRevision: 1, compactFirst: true }).success).toBe(true);
  expect(schemas.SetWakeSchedule.safeParse(weekly).success).toBe(true);
  // Kind-specific combinations are rejected by the shared web parser, not by
  // this SDK-compatible, top-level-object transport schema.
  for (const bad of [{ ...once, compactFirst: "true" }, { ...weekly, times: Array(9).fill("09:00") },
    { ...once, message: "é".repeat(501) }, { ...once, expectedRevision: 0 }, { ...once, sourceId: "another" }]) {
    expect(schemas.SetWakeSchedule.safeParse(bad).success).toBe(false);
  }
  expect(schemas.ClearWakeSchedule.safeParse({ expectedRevision: 2 }).success).toBe(true);
  expect(schemas.ClearWakeSchedule.safeParse({}).success).toBe(false);
  const call = vi.fn().mockRejectedValue({ code: "wake_lead_time", message: "http://secret/token" });
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", policy: { allowedTools: ["*"], disallowedTools: [] }, createClient: vi.fn().mockResolvedValue(call) })(request());
  const client = new Client({ name: "wake-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    const listed = (await client.listTools()).tools;
    expect(listed.map((tool) => tool.name)).toEqual(expect.arrayContaining(["GetWakeSchedule", "SetWakeSchedule", "ClearWakeSchedule"]));
    const schema = listed.find((tool) => tool.name === "SetWakeSchedule")!.inputSchema;
    expect(schema).toMatchObject({ type: "object", additionalProperties: false,
      properties: { kind: { enum: ["once", "weekly"] }, timezone: expect.any(Object), localAt: expect.any(Object),
        days: expect.any(Object), times: expect.any(Object), message: expect.any(Object), expectedRevision: expect.any(Object) },
    });
    expect(schema.required).toEqual(expect.arrayContaining(["kind", "timezone"]));
    expect(schema.required).toHaveLength(2);
    const refused = await client.callTool({ name: "SetWakeSchedule", arguments: once });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("five minutes");
    expect(JSON.stringify(refused)).not.toContain("secret");
  } finally { await client.close(); await bound.cleanup?.(); }
});

it("declares MarkConversationRead with strict optional conversation identity and tool policy", () => {
  const schemas = CONSOLE_PROJECT_SCHEMAS;
  expect(schemas.MarkConversationRead.safeParse({}).success).toBe(true);
  expect(schemas.MarkConversationRead.safeParse({ conversationId: "conversation" }).success).toBe(true);
  for (const args of [{ conversationId: "" }, { conversationId: null }, { all: true }, { sourceId: "foreign" }]) {
    expect(schemas.MarkConversationRead.safeParse(args).success).toBe(false);
  }
  expect(isConsoleProjectToolAllowed("MarkConversationRead", { allowedTools: ["MarkConversationRead"] })).toBe(true);
  expect(isConsoleProjectToolAllowed("MarkConversationRead", { allowedTools: ["*"], disallowedTools: ["MarkConversationRead"] })).toBe(false);
});


it.each([false, true])("gates rich search with host opt-in (%s), not model arguments or metadata", async (enabled) => {
  const call = vi.fn().mockResolvedValue({ conversations: [], truncated: false });
  const createClient = vi.fn().mockResolvedValue(call);
  const input = request();
  input.request.metadata!.web = { ...(input.request.metadata!.web as object), datedSnippets: true, ownerText: "Organize" };
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", datedSnippets: enabled,
    policy: { allowedTools: ["SearchConversations"] }, createClient })(input);
  const client = new Client({ name: "dated-search-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    const tools = (await client.listTools()).tools;
    expect(tools[0]?.description).toMatch(/historical untrusted evidence/u);
    expect(createClient).toHaveBeenCalledWith({ sourceId: "configured", threadId: "thread", turnId: "turn", ...(enabled ? { datedSnippets: true } : {}) });
    const legacy = await client.callTool({ name: "SearchConversations", arguments: { query: "pottery" } });
    expect(legacy.structuredContent).toEqual({ conversations: [], truncated: false });
    const rich = await client.callTool({ name: "SearchConversations", arguments: { query: "pottery", after: "2001-01-01", role: "user" } });
    if (enabled) {
      expect(rich.structuredContent).toEqual({ conversations: [], truncated: false });
      expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ args: { query: "pottery", after: "2001-01-01", role: "user" } }));
      call.mockRejectedValueOnce(new Error("fictional record diagnostics"));
      const failure = await client.callTool({ name: "SearchConversations", arguments: { query: "pottery", dated: true } });
      expect(failure.content).toEqual([{ type: "text", text: JSON.stringify({ error: "conversation_search_failed" }) }]);
    } else {
      expect(rich.content).toEqual([{ type: "text", text: JSON.stringify({ error: "conversation_search_unavailable" }) }]);
      expect(call).toHaveBeenCalledTimes(1);
    }
  } finally { await client.close(); await bound.cleanup?.(); }
});

it("refuses rich search when owner capability authentication fails", async () => {
  const createClient = vi.fn().mockRejectedValue(new Error("fictional diagnostics"));
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", datedSnippets: true,
    policy: { allowedTools: ["SearchConversations"] }, createClient })(request());
  const client = new Client({ name: "unverified-search-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    const result = await client.callTool({ name: "SearchConversations", arguments: { query: "pottery", dated: true } });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: "conversation_search_unavailable" }) }]);
  } finally { await client.close(); await bound.cleanup?.(); }
});


it("keeps legacy console tools on assistant-only wakes when dated search is enabled", async () => {
  const input = request();
  delete (input.request.metadata!.web as Record<string, unknown>).ownerText;
  const call = vi.fn().mockResolvedValue({ conversations: [], truncated: false });
  const createClient = vi.fn().mockResolvedValue(call);
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", datedSnippets: true,
    policy: { allowedTools: ["SearchConversations"] }, createClient })(input);
  const client = new Client({ name: "wake-search-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    expect(createClient).toHaveBeenCalledWith({ sourceId: "configured", threadId: "thread", turnId: "turn" });
    expect((await client.callTool({ name: "SearchConversations", arguments: { query: "pottery" } })).structuredContent)
      .toEqual({ conversations: [], truncated: false });
    expect((await client.callTool({ name: "SearchConversations", arguments: { query: "pottery", dated: true } })).content)
      .toEqual([{ type: "text", text: JSON.stringify({ error: "conversation_search_unavailable" }) }]);
    expect(call).toHaveBeenCalledTimes(1);
  } finally { await client.close(); await bound.cleanup?.(); }
});


it.each(["owner", "flag-off", "unverified"] as const)("sanitizes SearchConversations input failures at MCP dispatch (%s)", async (surface) => {
  const call = vi.fn().mockResolvedValue({ conversations: [], truncated: false });
  const createClient = surface === "unverified" ? vi.fn().mockRejectedValue(new Error("fictional diagnostics")) : vi.fn().mockResolvedValue(call);
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", datedSnippets: surface !== "flag-off",
    policy: { allowedTools: ["SearchConversations"] }, createClient })(request());
  const client = new Client({ name: "search-validation-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    const listed = (await client.listTools()).tools;
    expect(listed[0]?.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["query"],
      properties: { dated: { type: "boolean" }, after: { type: "string", format: "date" }, before: { type: "string", format: "date" }, role: { enum: ["user", "assistant"] } },
    });
    for (const args of [
      { query: "pottery", dated: true, after: "2001-02-30" }, { query: "pottery", dated: true, before: "fictional-calendar" },
      { query: "pottery", dated: true, role: "system" }, { query: "pottery", dated: "true" },
      { query: "pottery", dated: true, after: 2001 }, { query: 7, dated: true },
      { query: "pottery", dated: true, role: ["user"] }, { query: "pottery", dated: true, limit: "ten" },
      { query: "pottery", dated: true, extra: "fictional" },
    ]) {
      const result = await client.callTool({ name: "SearchConversations", arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: surface === "owner" ? "invalid_conversation_search" : "conversation_search_unavailable" }) }]);
    }
    // Containers without rich fields are sanitized only on active owner rich scope.
    if (surface === "owner") {
      for (const args of [null, [], "fictional", 7, undefined]) {
        const result = await client.callTool({ name: "SearchConversations", arguments: args as never });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: "invalid_conversation_search" }) }]);
      }
    }
    expect(call).not.toHaveBeenCalled();
    if (surface !== "unverified") {
      expect((await client.callTool({ name: "SearchConversations", arguments: { query: "pottery" } })).structuredContent)
        .toEqual({ conversations: [], truncated: false });
      expect(call).toHaveBeenCalledTimes(1);
    }
  } finally { await client.close(); await bound.cleanup?.(); }
});


it("preserves flag-off malformed legacy search results byte-for-byte with the SDK", async () => {
  const call = vi.fn();
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", datedSnippets: false,
    policy: { allowedTools: ["SearchConversations"] }, createClient: vi.fn().mockResolvedValue(call) })(request());
  const client = new Client({ name: "flag-off-legacy-test", version: "1" });
  const controlClient = new Client({ name: "legacy-sdk-control", version: "1" });
  const control = new McpServer({ name: "legacy-sdk-control", version: "1" });
  const controlCall = vi.fn(async () => ({ content: [] }));
  control.registerTool("SearchConversations", {
    inputSchema: CONSOLE_PROJECT_SCHEMAS.SearchConversations.pick({ query: true, limit: true }),
  }, controlCall);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    await control.connect(serverTransport);
    await controlClient.connect(clientTransport);
    const args = { query: "p" };
    const expected = await controlClient.callTool({ name: "SearchConversations", arguments: args });
    const actual = await client.callTool({ name: "SearchConversations", arguments: args });
    expect(expected.isError).toBe(true);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(call).not.toHaveBeenCalled();
    expect(controlCall).not.toHaveBeenCalled();
  } finally { await client.close(); await controlClient.close(); await control.close(); await bound.cleanup?.(); }
});

it("returns unavailable for flag-off malformed search only when a rich field is present", async () => {
  const call = vi.fn();
  const bound = await createConsoleProjectsRuntimeExtension({ sourceId: "configured", datedSnippets: false,
    policy: { allowedTools: ["SearchConversations"] }, createClient: vi.fn().mockResolvedValue(call) })(request());
  const client = new Client({ name: "flag-off-rich-test", version: "1" });
  try {
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-console-projects"]!;
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    for (const rich of [{ dated: false }, { after: "2001-01-01" }, { before: "2001-01-01" }, { role: "user" }]) {
      const result = await client.callTool({ name: "SearchConversations", arguments: { query: "p", ...rich } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: "conversation_search_unavailable" }) }]);
    }
    expect(call).not.toHaveBeenCalled();
  } finally { await client.close(); await bound.cleanup?.(); }
});
