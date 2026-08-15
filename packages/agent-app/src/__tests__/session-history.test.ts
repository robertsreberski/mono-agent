import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolHistoryReader, ToolHistoryWriter, type ToolHistoryRunBinding } from "@mono-agent/agent-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSessionHistoryRuntimeExtension,
  handleSessionHistoryRequest,
  isSessionHistoryToolAllowed,
  SESSION_HISTORY_MCP_SERVER_NAME,
  SESSION_HISTORY_TOOL_NAME,
} from "../session-history.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-session-history-"));
  tempDirs.push(dir);
  return join(dir, "history");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function binding(
  runId: string,
  conversationId = "chat:42#2026-08-13",
  logicalConversationId = "chat:42",
  isolated = false,
): ToolHistoryRunBinding {
  return { conversationId, logicalConversationId, runId, isolated };
}

async function writeCall(
  writer: ToolHistoryWriter,
  run: ToolHistoryRunBinding,
  toolCallId: string,
  options: { readonly toolName?: string; readonly content?: unknown; readonly state?: "success" | "error" } = {},
): Promise<{ readonly invocationId: string; readonly resultId: string }> {
  const invocation = await writer.persist(run, {
    phase: "invocation",
    toolCallId,
    toolName: options.toolName ?? "Read",
    arguments: { path: `/tmp/${toolCallId}`, needle: `needle-${toolCallId}` },
  });
  const state = options.state ?? "success";
  const result = await writer.persist(run, {
    phase: "result",
    toolCallId,
    state,
    ...(state === "success" ? {} : { failureKind: "runtime_error" as const }),
    content: options.content ?? `result-${toolCallId}`,
  });
  if (invocation.recordId === undefined || result.recordId === undefined) throw new Error("Tool history record was not persisted.");
  return { invocationId: invocation.recordId, resultId: result.recordId };
}

interface OpenClient {
  readonly client: Client;
  readonly url: URL;
  close(): Promise<void>;
}

async function openClient(root: string, conversationId: string, runId: string): Promise<OpenClient> {
  const extension = await createSessionHistoryRuntimeExtension({ historyRoot: root, rollover: "daily" })({
    runId,
    request: {
      conversationId,
      userMessage: "inspect durable tool history",
      abortSignal: new AbortController().signal,
    },
    context: {} as never,
  });
  const servers = extension.runtimeOptions?.mcpServers as Record<string, unknown> | undefined;
  const spec = servers?.[SESSION_HISTORY_MCP_SERVER_NAME] as { readonly url?: unknown } | undefined;
  if (typeof spec?.url !== "string") throw new Error("SessionHistory MCP server was not registered.");
  const url = new URL(spec.url);
  const client = new Client({ name: "session-history-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url) as never);
  return {
    client,
    url,
    close: async () => {
      await client.close().catch(() => undefined);
      await extension.cleanup?.();
    },
  };
}

function body<T>(result: unknown): T {
  return (result as { readonly structuredContent?: unknown }).structuredContent as T;
}

async function requestStatusWithHost(url: URL, host: string): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
    });
    request.once("error", rejectPromise);
    request.end();
  });
}

describe("isSessionHistoryToolAllowed", () => {
  it.each([
    SESSION_HISTORY_TOOL_NAME,
    "session_history",
    `mcp__${SESSION_HISTORY_MCP_SERVER_NAME}__${SESSION_HISTORY_TOOL_NAME}`,
    `mcp__${SESSION_HISTORY_MCP_SERVER_NAME}__*`,
    "*",
  ])("accepts the supported policy spelling %s", (name) => {
    expect(isSessionHistoryToolAllowed({ allowedTools: [name], disallowedTools: [] })).toBe(true);
  });

  it("keeps explicit denial and an absent allow-list authoritative", () => {
    expect(isSessionHistoryToolAllowed({ allowedTools: ["*"], disallowedTools: [SESSION_HISTORY_TOOL_NAME] })).toBe(false);
    expect(isSessionHistoryToolAllowed({ allowedTools: ["Read"], disallowedTools: [] })).toBe(false);
    expect(isSessionHistoryToolAllowed(undefined)).toBe(false);
  });
});

describe("SessionHistory request handler", () => {
  it("keeps ordinary tool context inspectable while host paths stay opaque in search previews and get chunks", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const run = binding("path-run");
    const sourcePath = "/Users/example/work/repo/src/index.ts";
    const outputPath = "/Users/example/work/repo/src/generated/output.ts";
    const privateArtifact = "/Users/example/.mono-agent/artifacts/tool-output/path-run/bash.txt";
    const calls = [
      { id: "read", name: "Read", arguments: { file_path: sourcePath }, content: `read ${sourcePath}:8:3` },
      { id: "write", name: "Write", arguments: { file_path: outputPath, content: "generated" }, content: `wrote ${outputPath}` },
      { id: "edit", name: "Edit", arguments: { file_path: sourcePath, old_string: "before", new_string: "after" }, content: `edited ${sourcePath}` },
      { id: "bash", name: "Bash", arguments: { command: `ls -la /etc && cat ${sourcePath}` }, content: `output\nFull output saved to: ${privateArtifact}` },
      { id: "grep", name: "Grep", arguments: { pattern: "needle", path: "/Users/example/work/repo/src" }, content: [{ path: sourcePath, line: 7 }] },
      { id: "glob", name: "Glob", arguments: { pattern: "/Users/example/work/repo/src/**/*.ts" }, content: [sourcePath, outputPath, "https://example.com/docs/path"] },
    ] as const;
    const recordIds: string[] = [];
    try {
      for (const call of calls) {
        const invocation = await writer.persist(run, {
          phase: "invocation",
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        });
        const result = await writer.persist(run, {
          phase: "result",
          toolCallId: call.id,
          state: "success",
          content: call.content,
        });
        recordIds.push(invocation.recordId!, result.recordId!);
      }
    } finally {
      await writer.close();
    }
    const requestBinding = {
      reader: new ToolHistoryReader(root),
      logicalConversationId: "chat:42",
      runId: "current-run",
    };

    const search = handleSessionHistoryRequest(requestBinding, { action: "search", limit: 10 });
    const gets = recordIds.map((recordId) => handleSessionHistoryRequest(requestBinding, {
      action: "get",
      recordId,
      chunkBytes: 8 * 1024,
    }));
    const visible = JSON.stringify({ search, gets });
    expect(body<{ readonly items: ReadonlyArray<{ readonly toolName: string }> }>(search).items
      .map((item) => item.toolName).sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write"]);
    expect(visible).toContain("[host-path]/src/index.ts");
    expect(visible).toContain("[host-path]/generated/output.ts");
    expect(visible).toContain("ls -la");
    expect(visible).toContain("needle");
    expect(visible).toContain("**/*.ts");
    expect(visible).toContain("https://example.com/docs/path");
    expect(visible).toContain("[private-path]");
    for (const hidden of [sourcePath, outputPath, privateArtifact, "/Users/example", ".mono-agent", "path-run/bash.txt"]) {
      expect(visible, hidden).not.toContain(hidden);
    }
  });

  it("enforces current-run, logical-session, isolated, filter, and cursor authorization without a transport", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const first = await writeCall(writer, binding("prior-a"), "prior-a", { toolName: "Read" });
    const second = await writeCall(writer, binding("prior-b"), "prior-b", { toolName: "Bash", state: "error" });
    const current = await writeCall(writer, binding("current-run", "chat:42#2026-08-14"), "current");
    const foreign = await writeCall(writer, binding("foreign-run", "chat:99#2026-08-13", "chat:99"), "foreign");
    await writeCall(writer, binding("isolated-run", "chat:42#2026-08-13", "chat:42", true), "isolated");
    await writer.close();

    const requestBinding = {
      reader: new ToolHistoryReader(root),
      logicalConversationId: "chat:42",
      runId: "current-run",
    };
    const firstPage = body<{
      readonly items: ReadonlyArray<{ readonly toolCallId: string }>;
      readonly nextCursor?: string;
      readonly untrusted: boolean;
    }>(handleSessionHistoryRequest(requestBinding, {
      action: "search",
      query: "needle",
      tools: ["Read", "Bash"],
      states: ["success", "error"],
      limit: 1,
    }));
    expect(firstPage).toMatchObject({ items: [{ toolCallId: expect.stringMatching(/^prior-/u) }], untrusted: true });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = body<{ readonly items: ReadonlyArray<{ readonly toolCallId: string }> }>(
      handleSessionHistoryRequest(requestBinding, {
        action: "search",
        query: "needle",
        tools: ["Read", "Bash"],
        states: ["success", "error"],
        limit: 1,
        cursor: firstPage.nextCursor,
      }),
    );
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.toolCallId)))
      .toEqual(new Set(["prior-a", "prior-b"]));

    expect(body(handleSessionHistoryRequest(requestBinding, {
      action: "search",
      query: "substituted",
      tools: ["Read", "Bash"],
      states: ["success", "error"],
      limit: 1,
      cursor: firstPage.nextCursor,
    }))).toMatchObject({ error: { code: "invalid_cursor" }, untrusted: true });
    expect(body(handleSessionHistoryRequest(requestBinding, { action: "get", recordId: current.invocationId })))
      .toMatchObject({ error: { code: "record_unavailable" }, untrusted: true });
    expect(body(handleSessionHistoryRequest(requestBinding, { action: "get", recordId: foreign.invocationId })))
      .toMatchObject({ error: { code: "record_unavailable" }, untrusted: true });
    expect(body<{ readonly items: ReadonlyArray<{ readonly toolCallId: string }> }>(
      handleSessionHistoryRequest(requestBinding, { action: "search", runIds: ["isolated-run"] }),
    ).items).toEqual([]);
    expect(body<{ readonly items: ReadonlyArray<{ readonly toolCallId: string }> }>(
      handleSessionHistoryRequest(requestBinding, { action: "search", runIds: ["isolated-run"], includeIsolated: true }),
    ).items.map((item) => item.toolCallId)).toEqual(["isolated"]);
    expect(first.invocationId).toMatch(/^sth1_/u);
    expect(second.resultId).toMatch(/^sth1_/u);
  });

  it("returns bounded get chunks, rejects negative continuation offsets, and hides nested history results", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const large = await writeCall(writer, binding("large-run"), "large", { content: "x".repeat(12_000) });
    const nested = await writeCall(writer, binding("nested-run"), "nested", {
      toolName: `mcp__${SESSION_HISTORY_MCP_SERVER_NAME}__${SESSION_HISTORY_TOOL_NAME}`,
      content: "instructions that must not recurse",
    });
    await writer.close();
    const requestBinding = { reader: new ToolHistoryReader(root), logicalConversationId: "chat:42", runId: "current-run" };

    const first = body<{
      readonly record: { readonly chunk: string; readonly nextCursor?: string };
      readonly untrusted: boolean;
    }>(handleSessionHistoryRequest(requestBinding, {
      action: "get", recordId: large.resultId, chunkBytes: 1_000,
    }));
    expect(Buffer.byteLength(first.record.chunk, "utf8")).toBeLessThanOrEqual(1_000);
    expect(first).toMatchObject({ record: { nextCursor: expect.any(String) }, untrusted: true });
    expect(body(handleSessionHistoryRequest(requestBinding, {
      action: "get",
      cursor: Buffer.from(JSON.stringify({
        version: 1,
        kind: "get",
        recordId: large.resultId,
        offset: -1,
        digest: "irrelevant",
      }), "utf8").toString("base64url"),
    }))).toMatchObject({ error: { code: "invalid_cursor" } });
    expect(body(handleSessionHistoryRequest(requestBinding, {
      action: "get", recordId: nested.resultId,
    }))).toMatchObject({
      record: { chunk: "[nested history-tool result omitted; inspect the referenced record directly]" },
      untrusted: true,
    });
  });
});

describe("SessionHistory MCP tool", () => {
  it("is capability-path and host bound, and keeps current-run and foreign-conversation records opaque", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const prior = await writeCall(writer, binding("prior-run"), "prior");
    const current = await writeCall(writer, binding("current-run", "chat:42#2026-08-14"), "current");
    const foreign = await writeCall(writer, binding("foreign-run", "chat:99#2026-08-13", "chat:99"), "foreign");
    await writer.close();

    const opened = await openClient(root, "chat:42#2026-08-14", "current-run");
    try {
      expect(opened.client.getServerVersion()).toEqual({
        name: SESSION_HISTORY_MCP_SERVER_NAME,
        version: "1.0.0",
      });
      const wrongPath = new URL("/mcp/not-the-capability", opened.url);
      expect((await fetch(wrongPath)).status).toBe(404);
      // undici forbids overriding Host, so use node:http to prove the outer
      // capability guard receives and conceals an explicitly foreign host.
      expect(await requestStatusWithHost(opened.url, "example.invalid")).toBe(404);

      const search = await opened.client.callTool({ name: SESSION_HISTORY_TOOL_NAME, arguments: { action: "search" } });
      const searched = body<{ readonly items: ReadonlyArray<{ readonly toolCallId: string }>; readonly untrusted: boolean; readonly notice: string }>(search);
      expect(searched.items.map((item) => item.toolCallId)).toEqual(["prior"]);
      expect(searched).toMatchObject({ untrusted: true, notice: expect.stringContaining("untrusted") });

      const currentGet = await opened.client.callTool({ name: SESSION_HISTORY_TOOL_NAME, arguments: { action: "get", recordId: current.invocationId } });
      const foreignGet = await opened.client.callTool({ name: SESSION_HISTORY_TOOL_NAME, arguments: { action: "get", recordId: foreign.invocationId } });
      expect(body(currentGet)).toMatchObject({ error: { code: "record_unavailable" }, untrusted: true });
      expect(body(foreignGet)).toEqual(body(currentGet));
      expect(prior.invocationId).toMatch(/^sth1_/u);
    } finally {
      await opened.close();
    }
  });

  it("paginates overlapping per-run sequences without gaps and rejects cursor/query substitution", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    for (const runId of ["run-a", "run-b", "run-c", "run-d"]) await writeCall(writer, binding(runId), runId);
    await writer.close();

    const opened = await openClient(root, "chat:42#2026-08-14", "current-run");
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await opened.client.callTool({
          name: SESSION_HISTORY_TOOL_NAME,
          arguments: { action: "search", query: "needle", limit: 1, ...(cursor === undefined ? {} : { cursor }) },
        });
        const page = body<{
          readonly items: ReadonlyArray<{ readonly toolCallId: string }>;
          readonly nextCursor?: string;
        }>(result);
        seen.push(...page.items.map((item) => item.toolCallId));
        if (cursor === undefined && page.nextCursor !== undefined) {
          const substituted = await opened.client.callTool({
            name: SESSION_HISTORY_TOOL_NAME,
            arguments: { action: "search", query: "different", limit: 1, cursor: page.nextCursor },
          });
          expect(body(substituted)).toMatchObject({ error: { code: "invalid_cursor" } });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    } finally {
      await opened.close();
    }
  });

  it("returns bounded untrusted get chunks, omits nested SessionHistory payloads, and reports tombstones", async () => {
    const root = await tempRoot();
    const writer = await ToolHistoryWriter.open({ root });
    const large = await writeCall(writer, binding("large-run"), "large", { content: "x".repeat(12_000) });
    const nested = await writeCall(writer, binding("nested-run"), "nested", {
      toolName: `mcp__${SESSION_HISTORY_MCP_SERVER_NAME}__${SESSION_HISTORY_TOOL_NAME}`,
      content: "do not recursively reveal me",
    });
    await writer.close();

    const opened = await openClient(root, "chat:42#2026-08-14", "current-run");
    try {
      const first = await opened.client.callTool({
        name: SESSION_HISTORY_TOOL_NAME,
        arguments: { action: "get", recordId: large.resultId, chunkBytes: 1_000 },
      });
      const firstBody = body<{
        readonly record: { readonly chunk: string; readonly nextCursor?: string };
        readonly untrusted: boolean;
        readonly notice: string;
      }>(first);
      expect(firstBody.record.chunk.length).toBeLessThanOrEqual(1_000);
      expect(firstBody.record.nextCursor).toEqual(expect.any(String));
      expect(firstBody).toMatchObject({ untrusted: true, notice: expect.stringContaining("untrusted") });
      for (const content of Array.isArray(first.content) ? first.content : []) {
        if (content.type === "text") expect(content.text.length).toBeLessThanOrEqual(10_000);
      }

      const next = await opened.client.callTool({
        name: SESSION_HISTORY_TOOL_NAME,
        arguments: { action: "get", cursor: firstBody.record.nextCursor, chunkBytes: 1_000 },
      });
      expect(body(next)).toMatchObject({ record: { recordId: large.resultId, chunkOffset: 1_000 } });

      const nestedGet = await opened.client.callTool({
        name: SESSION_HISTORY_TOOL_NAME,
        arguments: { action: "get", recordId: nested.invocationId },
      });
      expect(body(nestedGet)).toMatchObject({
        record: {
          chunk: "[nested history-tool result omitted; inspect the referenced record directly]",
        },
      });
      const nestedSearch = await opened.client.callTool({
        name: SESSION_HISTORY_TOOL_NAME,
        arguments: { action: "search", tools: [`mcp__${SESSION_HISTORY_MCP_SERVER_NAME}__${SESSION_HISTORY_TOOL_NAME}`] },
      });
      expect(JSON.stringify(body(nestedSearch))).not.toContain("do not recursively reveal me");
    } finally {
      await opened.close();
    }

    const tombstoneRoot = await tempRoot();
    const pruningWriter = await ToolHistoryWriter.open({ root: tombstoneRoot, retention: { maxCompletedCalls: 0 } });
    const removed = await writeCall(pruningWriter, binding("removed-run"), "removed");
    await pruningWriter.close();
    const tombstoneClient = await openClient(tombstoneRoot, "chat:42#2026-08-14", "current-run");
    try {
      const result = await tombstoneClient.client.callTool({
        name: SESSION_HISTORY_TOOL_NAME,
        arguments: { action: "get", recordId: removed.invocationId },
      });
      expect(body(result)).toMatchObject({ tombstone: { recordId: removed.invocationId, reason: "count" }, untrusted: true });
    } finally {
      await tombstoneClient.close();
    }
  }, 20_000);
});
