import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolHistoryReader, ToolHistoryWriter, continuityGenerationId, continuityRecordId } from "@mono-agent/conversation";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import { afterEach, expect, it } from "vitest";
import { createHistoryServer, createHistoryRuntimeExtension, handleHistoryRequest, historyDescription } from "../request-tools/history.js";
import { HISTORY_SCOPES, HISTORY_SCOPE_ALIASES, HISTORY_MCP_SERVER_NAME, historyPolicyAliases, resolveHistoryScopes, unifiedHistoryAvailability } from "../request-tools/history-policy.js";
import { handleConversationHistoryRequest, historyToolAvailabilityForRuntime } from "../request-tools/conversation-history.js";
import { handleSessionHistoryRequest } from "../request-tools/session-history.js";
import { appOwnedMcpServerSpec } from "../mcp/app-owned-tool-policy.js";

const { createMcpToolPolicyGuard } = await import(new URL("../../../turn/dist/tools/mcp/tool-policy.js", import.meta.url).href) as typeof import("../../../turn/dist/tools/mcp/tool-policy.js");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const conversationId = "web:fictional";
const input = () => ({ request: { conversationId, userMessage: "Fictional recovery.", abortSignal: new AbortController().signal }, runId: "current", context: {} as never });
const body = (result: unknown): any => (result as any).structuredContent;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "unified-history-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const reader = new ToolHistoryReader(join(root, "history"));
  const binding = { reader, artifactDir: join(root, "artifacts"), conversationId, logicalConversationId: conversationId, runId: "current", scopes: HISTORY_SCOPES };
  return { root, reader, binding };
}

const unifiedNames = ["History", "mcp__mono-agent-history__History", "mcp__mono-agent-history__*", "*"];
it.each(unifiedNames)("%s grants all scopes and its deny removes everything", name => {
  expect(resolveHistoryScopes({ allowedTools: [name] })).toEqual(HISTORY_SCOPES);
  expect(resolveHistoryScopes({ allowedTools: ["*"], disallowedTools: [name] })).toEqual([]);
});
for (const scope of HISTORY_SCOPES) {
  it.each(HISTORY_SCOPE_ALIASES[scope])("old policy alias %s grants/denies only its scope", name => {
    expect(resolveHistoryScopes({ allowedTools: [name] })).toEqual([scope]);
    expect(resolveHistoryScopes({ allowedTools: ["History"], disallowedTools: [name] })).toEqual(HISTORY_SCOPES.filter(s => s !== scope));
  });
}
it("said requires continuity; tools/runs do not", () => {
  expect(resolveHistoryScopes({ allowedTools: ["History"] }, { said: false, tools: true, runs: true })).toEqual(["tools", "runs"]);
  expect(resolveHistoryScopes({ allowedTools: [] })).toEqual([]);
  expect(historyDescription(["runs"])).not.toMatch(/scope said:|scope tools:/u);
  expect(historyDescription(HISTORY_SCOPES)).toMatch(/Search, then get.*batch two records.*8192-byte/u);
});

const allDenies = [...unifiedNames, ...HISTORY_SCOPES.flatMap(s => HISTORY_SCOPE_ALIASES[s])];
it.each(allDenies)("late deny %s matches Pi and removes all advertising", deny => {
  const spec = appOwnedMcpServerSpec(HISTORY_MCP_SERVER_NAME, {}, { History: historyPolicyAliases(HISTORY_SCOPES) });
  const runtime = { allowedTools: ["History"], disallowedTools: [deny], mcpServers: { [HISTORY_MCP_SERVER_NAME]: structuredClone(spec) } };
  expect(createMcpToolPolicyGuard(runtime.mcpServers[HISTORY_MCP_SERVER_NAME], HISTORY_MCP_SERVER_NAME, runtime.allowedTools, runtime.disallowedTools)("History")).toBe(false);
  expect(unifiedHistoryAvailability(runtime)).toEqual({ conversationHistory: false, sessionHistory: false, history: { said: false, tools: false, runs: false } });
});
it("config-denied aliases are excluded from the frozen Pi/advertising snapshot", async () => {
  const f = await fixture();
  const allowedTools = ["*"], disallowedTools = ["SessionHistory"];
  const extension = createHistoryRuntimeExtension({ historyRoot: join(f.root, "history"), artifactDir: f.binding.artifactDir, policy: { allowedTools, disallowedTools }, capabilities: { said: true, tools: true, runs: true } })!;
  allowedTools.length = 0; disallowedTools.push("History");
  const result = await extension(input()); cleanup.push(() => result.cleanup?.());
  const servers = result.runtimeOptions!.mcpServers as Record<string, any>;
  const spec = servers[HISTORY_MCP_SERVER_NAME];
  expect(Object.isFrozen(spec.appOwnedTools.aliases.History)).toBe(true);
  expect(spec.appOwnedTools.aliases.History).not.toContain("SessionHistory");
  const runtime = { allowedTools: ["*"], disallowedTools: ["SessionHistory"], mcpServers: servers };
  expect(createMcpToolPolicyGuard(structuredClone(spec), HISTORY_MCP_SERVER_NAME, runtime.allowedTools, runtime.disallowedTools)("History")).toBe(true);
  expect(historyToolAvailabilityForRuntime(runtime, true).history).toEqual({ said: true, tools: false, runs: true });
  expect(historyToolAvailabilityForRuntime({ allowedTools: ["*"], mcpServers: {} }, true).history).toEqual({ said: false, tools: false, runs: false });
});

it.each([undefined, "bogus", "", "SAID", "tools"])("real MCP tools/call returns invalid_scope for %s, not SDK diagnostics", async scope => {
  const f = await fixture();
  const server = createHistoryServer({ ...f.binding, scopes: ["said"] });
  const client = new Client({ name: "fictional", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); cleanup.push(() => server.close()); cleanup.push(() => client.close());
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toEqual(["History"]);
  expect(tools[0]!.inputSchema.required).toContain("scope");
  expect(tools[0]!.inputSchema.properties!.scope).not.toHaveProperty("enum");
  const result = await client.callTool({ name: "History", arguments: scope === undefined ? {} : { scope } });
  expect(result.isError).toBe(true);
  expect(body(result).error).toEqual({ code: "invalid_scope", message: "Choose one of the permitted scopes.", permittedScopes: ["said"] });
});
it.each([
  { scope: "said", runId: "old" }, { scope: "said", includeIsolated: true }, { scope: "tools", mode: "chronological" },
  { scope: "tools", runId: "old" }, { scope: "runs", recordId: "record" }, { scope: "runs", run_id: "old" },
  { scope: "runs", action: "inspect" }, { scope: "runs", chunkBytes: 8192 },
])("rejects mixed/legacy fields: %j", async args => {
  expect(body(await handleHistoryRequest((await fixture()).binding, args)).error.code).toBe("invalid_request");
});
it("wraps all readers without changing their evidence/error contracts", async () => {
  const f = await fixture();
  for (const [scope, legacy] of [["said", handleConversationHistoryRequest(f.binding, { action: "get" })], ["tools", handleSessionHistoryRequest(f.binding, { action: "get" })]] as const) {
    const result = await handleHistoryRequest(f.binding, { scope, action: "get" });
    expect(body(result).error).toEqual(body(legacy).error);
    expect(body(result).scope).toBe(scope);
  }
  const result = await handleHistoryRequest(f.binding, { scope: "runs" });
  expect(body(result)).toMatchObject({ scope: "runs", count: 0, runs: [] });
});

it("recovers two frozen records in search/get/continuation rounds, preserving UTF-8 and digests", async () => {
  const f = await fixture(), root = join(f.root, "history");
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
  const generationId = continuityGenerationId(), texts = ["Fictional cobalt "+"é".repeat(7000), "Fictional amber "+"λ".repeat(7000)];
  const records = texts.map((text, sequence) => ({ text, sequence, recordId: continuityRecordId(conversationId, `frozen-${sequence}`), runId: "old", kind: "assistant" as const, provenance: "assistant" as const }));
  try {
    await writer.prepareContinuity({ generationId, conversationId, logicalConversationId: conversationId, beforeDigest: null, afterDigest: "a".repeat(64), records });
    await writer.commitContinuity({ generationId, conversationId, canonicalDigest: "a".repeat(64) });
  } finally { await writer.close(); }
  const search = body(await handleHistoryRequest(f.binding, { scope: "said", action: "search" }));
  expect(search.items).toHaveLength(2);
  const gets = await Promise.all(search.navigation.nextActions.filter((a: any) => a.kind === "get_record").map((a: any) => handleHistoryRequest(f.binding, a.arguments)));
  expect(gets).toHaveLength(2);
  for (const first of gets) {
    expect(body(first).scope).toBe("said"); expect(Buffer.byteLength(body(first).chunk)).toBeLessThanOrEqual(8192);
    const next = body(first).navigation.nextActions[0].arguments;
    expect(next.scope).toBe("said");
    const second = body(await handleHistoryRequest(f.binding, next));
    expect(second.nextCursor).toBeUndefined();
    const text = body(first).chunk + second.chunk;
    expect(texts).toContain(text);
    expect(createHash("sha256").update(text).digest("hex")).toBe(second.record.sha256);
    for (const other of ["tools", "runs"]) expect(body(await handleHistoryRequest(f.binding, { scope: other, action: other === "runs" ? "search" : "get", cursor: next.cursor })).error.code).toBe("invalid_cursor");
  }
  expect(Buffer.byteLength(JSON.stringify((await handleHistoryRequest(f.binding, { scope: "said", action: "search" })).content))).toBeLessThanOrEqual(65536);
});

it.each(["absent", "damaged"])("runs → tools recovers isolated mixed-state cancelled evidence with %s continuity", async state => {
  const f = await fixture();
  const writer = await ToolHistoryWriter.open({ root: join(f.root, "history") });
  const old = { conversationId, logicalConversationId: conversationId, runId: "cancelled-fiction", isolated: true };
  try {
    for (const [toolCallId, terminal] of [["finished", "success"], ["cancelled", "cancelled"]] as const) {
      await writer.persist(old, { phase: "invocation", toolCallId, toolName: "Read", arguments: { file_path: "fiction.txt" } });
      await writer.persist(old, { phase: "result", toolCallId, state: terminal, content: `Fictional ${terminal} result.` });
    }
    await writer.finishRun(old, "completed");
  } finally { await writer.close(); }
  if (state === "damaged") {
    await writeFile(join(f.root, "history", `.continuity-purge-${"a".repeat(64)}.json`), "malformed", { mode: 0o600 });
    expect(f.reader.continuityPurgeStatus().invalid).toBe(1);
    expect(body(await handleHistoryRequest(f.binding, { scope: "said" })).available).toBe(false);
  }
  const recorder = createJsonlRunRecorder({ artifactDir: f.binding.artifactDir, conversationId, runId: old.runId, userInput: "Fictional interrupted work." });
  await recorder.finish({ failureKind: "cancelled_user", cancelled: true, error: "Fictional cancellation." });
  const discovery = body(await handleHistoryRequest(f.binding, { scope: "runs" }));
  expect(discovery.runs).toHaveLength(1);
  const overview = body(await handleHistoryRequest(f.binding, { scope: "runs", action: "get", runId: old.runId }));
  const handoff = overview.navigation.nextActions.find((a: any) => a.arguments.scope === "tools");
  expect(handoff.arguments).toEqual({ scope: "tools", action: "search", runIds: [old.runId], includeIsolated: true });
  const search = body(await handleHistoryRequest(f.binding, handoff.arguments));
  expect(search.count).toBe(2); expect(new Set(search.items.map((item: any) => item.state))).toEqual(new Set(["success", "cancelled"]));
  for (const action of search.navigation.nextActions) {
    expect(action.arguments).toMatchObject({ scope: "tools", chunkBytes: 8192, includeIsolated: true });
    expect(body(await handleHistoryRequest(f.binding, action.arguments)).record).toBeDefined();
  }
  const restricted = body(await handleHistoryRequest({ ...f.binding, scopes: ["runs"] }, { scope: "runs", action: "get", runId: old.runId }));
  expect(JSON.stringify(restricted.navigation)).not.toMatch(/SessionHistory|scope.*tools/u);
});

it("uses the actual stateless HTTP MCP boundary for invalid scopes", async () => {
  const f = await fixture();
  const extension = await createHistoryRuntimeExtension({ historyRoot: join(f.root, "history"), artifactDir: f.binding.artifactDir,
    policy: { allowedTools: ["RunHistory"] }, capabilities: { said: false, tools: true, runs: true } })!(input());
  cleanup.push(() => extension.cleanup?.());
  const client = new Client({ name: "fictional-http", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL((extension.runtimeOptions!.mcpServers as any)[HISTORY_MCP_SERVER_NAME].url)) as never);
  cleanup.push(() => client.close());
  const result = await client.callTool({ name: "History", arguments: { scope: "said" } });
  expect(body(result).error).toMatchObject({ code: "invalid_scope", permittedScopes: ["runs"] });
  expect(body(await client.callTool({ name: "History", arguments: { scope: "runs" } })).scope).toBe("runs");
});


it("does not infer unified ownership from an external History server name in legacy mode", () => {
  expect(historyToolAvailabilityForRuntime({ allowedTools: ["*"], mcpServers: { "mono-agent-history": { url: "http://127.0.0.1/fictional" }, "mono-agent-conversation-history": {} } }))
    .toEqual({ conversationHistory: true, sessionHistory: false });
});
