import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolHistoryReader, ToolHistoryWriter, continuityGenerationId, continuityRecordId, type ContinuityPreparation } from "@mono-agent/conversation";
import { afterEach, describe, expect, it } from "vitest";
import { createConversationHistoryRuntimeExtension, handleConversationHistoryRequest, isConversationHistoryToolAllowed, CONVERSATION_HISTORY_MCP_SERVER_NAME, CONVERSATION_HISTORY_TOOL_NAME } from "../request-tools/conversation-history.js";
import { handleSessionHistoryRequest } from "../request-tools/session-history.js";

const roots: string[] = [], writers = new Set<ToolHistoryWriter>(), clients: Array<() => Promise<void>> = [];
const logicalId = "web:fiction", conversationId = `${logicalId}#2026-05-17`, runId = "fiction-current";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => { for (const close of clients.splice(0)) await close(); for (const writer of writers) await writer.close(); writers.clear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(maxBytes?: number, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "conversation-history-")); roots.push(root);
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: enabled, ...(maxBytes === undefined ? {} : { retention: { maxBytes } }) }); writers.add(writer);
  const reader = new ToolHistoryReader(root);
  return { root, writer, reader, binding: { reader, logicalConversationId: logicalId, conversationId, runId } };
}
function preparation(texts: string[], physical = conversationId, logical = logicalId): ContinuityPreparation {
  const generationId = continuityGenerationId();
  return { generationId, conversationId: physical, logicalConversationId: logical, beforeDigest: null, afterDigest: sha(generationId),
    records: texts.map((text, sequence) => ({ text, sequence, recordId: continuityRecordId(physical, `${generationId}:${sequence}`), runId, kind: "assistant", provenance: "assistant" })) };
}
async function publish(writer: ToolHistoryWriter, input: ContinuityPreparation) {
  await writer.prepareContinuity(input); await writer.commitContinuity({ generationId: input.generationId, conversationId: input.conversationId, canonicalDigest: input.afterDigest });
}
function body(result: unknown): any { return (result as { structuredContent: unknown }).structuredContent; }
function alter(cursor: string, patch: Record<string, unknown>): string { return Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), ...patch })).toString("base64url"); }

const aliases = ["ConversationHistory", "conversation_history", `mcp__${CONVERSATION_HISTORY_MCP_SERVER_NAME}__ConversationHistory`, `mcp__${CONVERSATION_HISTORY_MCP_SERVER_NAME}__*`, "*"];
describe("ConversationHistory policy", () => {
  it.each(aliases)("allows %s and lets every explicit deny spelling win", (allow) => {
    expect(isConversationHistoryToolAllowed({ allowedTools: [allow], disallowedTools: [] })).toBe(true);
    for (const deny of aliases) expect(isConversationHistoryToolAllowed({ allowedTools: [allow], disallowedTools: [deny] })).toBe(false);
  });
  it("does not widen absent or narrow allow lists", () => {
    expect(isConversationHistoryToolAllowed(undefined)).toBe(false);
    expect(isConversationHistoryToolAllowed({ allowedTools: ["Read", "SessionHistory"], disallowedTools: [] })).toBe(false);
  });
});

describe("ConversationHistory scoped evidence", () => {
  it("exposes only committed evidence, includes finalized current-run records and preserves SessionHistory's exclusion", async () => {
    const f = await fixture(), input = preparation(["Morgan chose cobalt."]);
    await f.writer.prepareContinuity(input);
    expect(body(handleConversationHistoryRequest(f.binding, {}))).toMatchObject({ available: true, items: [], coverage: { complete: false } });
    expect(body(handleConversationHistoryRequest(f.binding, { action: "get", recordId: input.records[0]!.recordId })).status).toBe("unavailable");
    await f.writer.commitContinuity({ conversationId, generationId: input.generationId, canonicalDigest: input.afterDigest });
    expect(body(handleConversationHistoryRequest(f.binding, {})).items[0]).toMatchObject({ runId, provenance: "assistant", untrusted: true });
    const binding = { conversationId, logicalConversationId: logicalId, runId, isolated: false };
    const invocation = await f.writer.persist(binding, { phase: "invocation", toolCallId: "fixture-call", toolName: "Read", arguments: {} });
    await f.writer.persist(binding, { phase: "result", toolCallId: "fixture-call", state: "success", content: "Fictional observed result." });
    expect(body(handleSessionHistoryRequest(f.binding, { action: "get", recordId: invocation.recordId! }))).toMatchObject({ error: { code: "record_unavailable" } });
    const foreign = preparation(["A separate fictional conversation."], "web:foreign", "web:foreign"); await publish(f.writer, foreign);
    expect(body(handleConversationHistoryRequest(f.binding, {})).items).toHaveLength(1);
    expect(body(handleConversationHistoryRequest(f.binding, { action: "get", recordId: foreign.records[0]!.recordId })).status).toBe("unavailable");
  });

  it("navigates byte-verifiable UTF-8 chunks across rollover and binds get cursors to scope, digest, size and offset", async () => {
    const f = await fixture(), text = "Cobalt 🔷 rectangle. ".repeat(1200), input = preparation([text]); await publish(f.writer, input);
    const binding = { ...f.binding, conversationId: `${logicalId}#2026-05-18` };
    let result = body(handleConversationHistoryRequest(binding, { action: "get", recordId: input.records[0]!.recordId, chunkBytes: 8191 }));
    const cursor = result.nextCursor;
    for (const patch of [{ offset: 2 }, { sha256: sha("wrong") }, { generationId: "wrong" }, { chunkBytes: 4 }]) {
      expect(body(handleConversationHistoryRequest(binding, { action: "get", cursor: alter(cursor, patch) })).error.code).toBe("invalid_cursor");
    }
    expect(body(handleConversationHistoryRequest({ ...binding, runId: "other-run" }, { action: "get", cursor })).error.code).toBe("invalid_cursor");
    expect(body(handleConversationHistoryRequest({ ...binding, logicalConversationId: "web:foreign" }, { action: "get", cursor })).error.code).toBe("invalid_cursor");
    expect(body(handleConversationHistoryRequest(binding, { action: "get", cursor, chunkBytes: 4 })).error.code).toBe("invalid_cursor");
    let recovered = "";
    for (let count = 0; count < 20; count += 1) {
      expect(Buffer.byteLength(result.chunk, "utf8")).toBeLessThanOrEqual(8191); expect(result.chunk).not.toContain("�"); recovered += result.chunk;
      if (!result.nextCursor) break;
      result = body(handleConversationHistoryRequest(binding, result.navigation.nextActions[0].arguments));
    }
    expect(recovered).toBe(text); expect(sha(recovered)).toBe(result.record.sha256); expect(result.nextCursor).toBeUndefined();
    expect(result.record).toMatchObject({ retainedBytes: Buffer.byteLength(text), redacted: false, truncated: false });
  });

  it.each([16381, 16384])("discloses UTF-8 chunk boundary limits in a three-round two-record traversal (%s bytes)", async size => {
    const f = await fixture();
    // Byte 8192 lies inside a four-byte character: first safe end is 8189.
    const text = "a".repeat(8189) + "🔷" + "b".repeat(size - 8193);
    await publish(f.writer, preparation([text, text]));
    const searched = body(handleConversationHistoryRequest(f.binding, { query: "🔷", limit: 5 }));
    const actions = searched.navigation.nextActions.filter((a: any) => a.kind === "get_record"); expect(actions).toHaveLength(2);
    const recovered = actions.map((action: any) => {
      const first = body(handleConversationHistoryRequest(f.binding, action.arguments));
      expect(Buffer.byteLength(first.chunk)).toBe(8189);
      const second = body(handleConversationHistoryRequest(f.binding, first.navigation.nextActions[0].arguments));
      expect(first.chunk + second.chunk).not.toContain("�");
      if (size === 16381) {
        expect(second.nextCursor).toBeUndefined(); expect(sha(first.chunk + second.chunk)).toBe(second.record.sha256);
        return first.chunk + second.chunk;
      }
      // R=3 ends here, with honest remaining cursors, not completed recovery.
      expect(second.nextCursor).toBeDefined(); expect(sha(first.chunk + second.chunk)).not.toBe(second.record.sha256);
      const third = body(handleConversationHistoryRequest(f.binding, second.navigation.nextActions[0].arguments));
      expect(third.nextCursor).toBeUndefined(); expect(Buffer.byteLength(third.chunk)).toBe(3);
      expect(sha(first.chunk + second.chunk + third.chunk)).toBe(third.record.sha256);
      return first.chunk + second.chunk + third.chunk;
    });
    expect(recovered).toEqual([text, text]);
  });

  it("paginates search with validated anchors and rejects changed filters, run scope and arbitrary input fields", async () => {
    const f = await fixture(), input = preparation(Array.from({ length: 5 }, (_, i) => `Fictional cobalt entry ${i}.`)); await publish(f.writer, input);
    const first = body(handleConversationHistoryRequest(f.binding, { query: "cobalt", limit: 2 }));
    expect(first.items).toHaveLength(2); expect(first.hasMore).toBe(true);
    const second = body(handleConversationHistoryRequest(f.binding, first.navigation.nextActions.find((a: any) => a.kind === "next_search_page").arguments));
    expect(second.items).toHaveLength(2); expect(new Set([...first.items, ...second.items].map((r) => r.recordId)).size).toBe(4);
    for (const args of [{ query: "entry", limit: 2, cursor: first.nextCursor }, { query: "cobalt", limit: 3, cursor: first.nextCursor },
      { query: "cobalt", limit: 2, cursor: alter(first.nextCursor, { ordinal: 1 }) }]) {
      expect(body(handleConversationHistoryRequest(f.binding, args)).error.code).toBe("invalid_cursor");
    }
    expect(body(handleConversationHistoryRequest({ ...f.binding, runId: "new-run" }, { query: "cobalt", limit: 2, cursor: first.nextCursor })).error.code).toBe("invalid_cursor");
    expect(body(handleConversationHistoryRequest(f.binding, { action: "search", conversationId: "web:foreign" } as never)).error.code).toBe("invalid_request");
    for (const input of [{ query: "x".repeat(513) }, { limit: 11 }, { action: "get", recordId: "guess" }, { action: "get", recordId: first.items[0].recordId, chunkBytes: 3 }]) {
      expect(body(handleConversationHistoryRequest(f.binding, input as never)).error).toBeDefined();
    }
  });

  it("keeps issued v1 lexical cursors chronological while new queries use v2 relevance/literal discovery", async () => {
    const f = await fixture(); await publish(f.writer, preparation(["Cobalt observatory old.", "cobalt", "Cobalt observatory new.", 'A literal " quote.']));
    const legacy = body(handleConversationHistoryRequest(f.binding, { query: "cobalt", mode: "chronological", limit: 1 }));
    expect(JSON.parse(Buffer.from(legacy.nextCursor, "base64url").toString()).version).toBe(1);
    expect(body(handleConversationHistoryRequest(f.binding, { query: "cobalt", limit: 1, cursor: legacy.nextCursor })).items[0].preview).toBe("cobalt");
    const ranked = body(handleConversationHistoryRequest(f.binding, { query: "cobalt observatory", limit: 1 }));
    expect(ranked).toMatchObject({ mode: "relevance", scan: { complete: true, records: 4 } });
    expect(JSON.parse(Buffer.from(ranked.nextCursor, "base64url").toString()).version).toBe(2);
    for (const patch of [{ rankingVersion: 2 }, { watermark: 0 }, { manifest: sha("wrong") }, { anchor: { recordId: ranked.items[0].recordId, score: 0, ordinal: 1 } }]) {
      expect(body(handleConversationHistoryRequest(f.binding, { query: "cobalt observatory", limit: 1, cursor: alter(ranked.nextCursor, patch) })).error.code).toBe("invalid_cursor");
    }
    const literal = body(handleConversationHistoryRequest(f.binding, { query: '"' }));
    expect(literal.mode).toBe("literal"); expect(literal.items).toHaveLength(1);
    await f.writer.close(); writers.delete(f.writer);
    const restarted = { ...f.binding, reader: new ToolHistoryReader(f.root) };
    expect(body(handleConversationHistoryRequest(restarted, { query: "cobalt observatory", limit: 1, cursor: ranked.nextCursor })).items).toHaveLength(1);
    expect(body(handleConversationHistoryRequest(restarted, { action: "search", mode: "relevance" })).error.code).toBe("invalid_query");
  });

  it("discloses scan exhaustion and offers explicit browsing, never a purported no-match ranked page", async () => {
    const f = await fixture();
    const reader = { ...f.reader,
      searchContinuity: () => ({ available: true, items: [], mode: "relevance" as const, degradedReason: "scan_capacity" as const,
        scan: { complete: false, records: 31, bytes: 8192, elapsedMs: 5001, maxBatchMs: 20, metadataPages: 1, textBatches: 1 } }),
      getContinuity: f.reader.getContinuity.bind(f.reader), continuityGaps: f.reader.continuityGaps.bind(f.reader), latestContinuitySummary: f.reader.latestContinuitySummary.bind(f.reader) };
    const result = handleConversationHistoryRequest({ ...f.binding, reader }, { query: "cobalt" });
    expect(body(result)).toMatchObject({ items: [], degradedReason: "scan_capacity", scan: { complete: false, records: 31 } });
    expect(result.content[0]!.text).toContain("no complete ranked page");
    expect(body(result).navigation.nextActions[0].arguments).toEqual({ action: "search", mode: "chronological", limit: 5 });
  });

  it("searches Unicode case-insensitively and leads escaped multi-block evidence with exact model-visible navigation", async () => {
    const f = await fixture(), input = preparation(["ŻÓŁTY prostokąt.", '\"\n'.repeat(5000)]); await publish(f.writer, input);
    const found = body(handleConversationHistoryRequest(f.binding, { query: "żółty" }));
    expect(found.items.map((r: any) => r.recordId)).toEqual([input.records[0]!.recordId]);
    const result = handleConversationHistoryRequest(f.binding, { action: "get", recordId: input.records[1]!.recordId });
    expect(result.content[0]!.text).toContain(body(result).nextCursor);
    expect(result.content[0]!.text).toContain("Exact arguments:");
    expect(result.content.length).toBeGreaterThan(2);
    expect(result.content.every(({ text }) => text.length <= 10000)).toBe(true);
  });

  it("reports scoped tombstones, invalidates removed search anchors and never upgrades a legacy reader", async () => {
    const f = await fixture(800), old = preparation(["a".repeat(300), "c".repeat(300)]); await publish(f.writer, old);
    const first = body(handleConversationHistoryRequest(f.binding, { action: "get", recordId: old.records[0]!.recordId, chunkBytes: 4 }));
    const searchPage = body(handleConversationHistoryRequest(f.binding, { limit: 1 }));
    await publish(f.writer, preparation(["b".repeat(600)]));
    expect(body(handleConversationHistoryRequest(f.binding, { limit: 1, cursor: searchPage.nextCursor })).error.code).toBe("invalid_cursor");
    expect(body(handleConversationHistoryRequest(f.binding, { action: "get", cursor: first.nextCursor }))).toMatchObject({ status: "tombstoned", tombstone: { reason: "bytes" } });
    expect(body(handleConversationHistoryRequest({ ...f.binding, logicalConversationId: "web:foreign" }, { action: "get", recordId: old.records[0]!.recordId })).status).toBe("unavailable");
    const legacy = await fixture(undefined, false), bytes = await readFile(legacy.reader.databasePath);
    expect(body(handleConversationHistoryRequest(legacy.binding, {}))).toMatchObject({ status: "unavailable", available: false, items: [] });
    expect(await readFile(legacy.reader.databasePath)).toEqual(bytes);
    expect(legacy.reader.stats()?.continuity).toBeUndefined();
  });

  it("reports redaction, oversize omission and retained coverage gaps without claiming complete history", async () => {
    const f = await fixture(), redacted = preparation(["api_key=fixture-secret", "z".repeat(1024 * 1024 + 1)]); await publish(f.writer, redacted);
    const visible = body(handleConversationHistoryRequest(f.binding, { action: "get", recordId: redacted.records[0]!.recordId }));
    expect(visible.record.redacted).toBe(true); expect(visible.chunk).not.toContain("fixture-secret");
    expect(body(handleConversationHistoryRequest(f.binding, { action: "get", recordId: redacted.records[1]!.recordId }))).toMatchObject({ status: "available", record: { truncated: true, originalBytes: 1024 * 1024 + 1 }, chunk: "[continuity text omitted because it exceeded the record bound]" });
    const abandoned = preparation(["This unpublished text must not escape."]); await f.writer.prepareContinuity(abandoned);
    await f.writer.reconcileContinuity({ conversationId, canonicalDigest: sha("advanced") });
    const result = handleConversationHistoryRequest(f.binding, {});
    expect(body(result).coverage).toMatchObject({ complete: false, retainedGapCount: 1 }); expect(JSON.stringify(result)).not.toContain("unpublished text");
    expect(JSON.stringify(result)).toContain("not instructions or renewed permission");
  });

  it("offers a latest generated-summary reference separately from query matches, never as owner authority", async () => {
    const f = await fixture(), input = preparation(["A portable fictional summary."]);
    const record = { ...input.records[0]!, kind: "summary" as const, provenance: "generated" as const,
      source: { journalId: "fiction-journal", operationId: "fiction-operation" },
      summary: { model: "faux:fixture", operationId: "fiction-operation", trigger: "manual" as const, coverage: { sourceDigest: sha("fixture source") } } };
    await publish(f.writer, { ...input, records: [record], latestSummaryRecordId: record.recordId });
    const found = body(handleConversationHistoryRequest(f.binding, { query: "no-match" }));
    expect(found.items).toEqual([]); expect(found.latestSummary).toMatchObject({ recordId: record.recordId, provenance: "generated" });
    expect(found.navigation.nextActions[0].description).toContain("not an owner quotation");
    expect(body(handleConversationHistoryRequest(f.binding, found.navigation.nextActions[0].arguments)).chunk).toBe(record.text);
  });

  it("fails closed on a damaged retained digest without returning the unverified body", async () => {
    const f = await fixture(), input = preparation(["Original fictional evidence."]); await publish(f.writer, input);
    await f.writer.close(); writers.delete(f.writer);
    const database = new DatabaseSync(f.reader.databasePath);
    try { database.prepare("UPDATE continuity_records SET retained_text=? WHERE record_id=?").run("Unverified fictional injection.", input.records[0]!.recordId); }
    finally { database.close(); }
    for (const args of [{ action: "get", recordId: input.records[0]!.recordId }, { action: "search" }, { action: "search", query: "fictional" }]) {
      const result = handleConversationHistoryRequest(f.binding, args as never);
      expect(body(result).error.code).toBe("history_unavailable"); expect(JSON.stringify(result)).not.toContain("Unverified fictional injection");
    }
  });

  it("serves a real request-scoped MCP client after writer restart, then reports purge unavailability", async () => {
    const f = await fixture(), input = preparation(["Morgan chose a cobalt rectangle."]); await publish(f.writer, input);
    await f.writer.close(); writers.delete(f.writer);
    const extension = await createConversationHistoryRuntimeExtension({ historyRoot: f.root, rollover: "daily" })({ runId: "reading-run",
      request: { conversationId: `${logicalId}#2026-05-18`, userMessage: "Retrieve fictional evidence.", abortSignal: new AbortController().signal }, context: {} as never });
    const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)[CONVERSATION_HISTORY_MCP_SERVER_NAME]!;
    const client = new Client({ name: "fictional-history-client", version: "1.0.0" }); await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    clients.push(async () => { await client.close(); await extension.cleanup?.(); });
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([CONVERSATION_HISTORY_TOOL_NAME]);
    const found = body(await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: {} }));
    const result = await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: found.navigation.nextActions[0].arguments });
    expect(body(result)).toMatchObject({ status: "available", chunk: "Morgan chose a cobalt rectangle." });
    expect(JSON.stringify((result as any).content)).toContain("nextActions");
    const reopened = await ToolHistoryWriter.open({ root: f.root, continuityEnabled: true }); writers.add(reopened); await reopened.resetConversation(logicalId);
    expect(body(await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: { action: "get", recordId: input.records[0]!.recordId } })).status).toBe("unavailable");
    expect((await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: { action: "search", logicalConversationId: "web:foreign" } })).isError).toBe(true);
  });
});

it("gets the id parsed from an available rendered pack, rejecting invocation and projection ids", async () => {
  const f = await fixture();
  const binding = { conversationId, logicalConversationId: logicalId, runId: "fictional-old", isolated: false,
    continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "fictional-call", toolName: "Read", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "fictional-call", state: "success", content: "Fictional cobalt retained value." });
  await f.writer.finishRun(binding, "completed");
  // Exercise the built renderer used by the app, without widening a package API
  // solely for this integration proof. The app closure is built before testing.
  const { renderContinuityPack } = await import(new URL("../../../conversation/dist/continuity/pack.js", import.meta.url).href) as typeof import("../../../conversation/dist/continuity/pack.js");
  const { prepareToolHistoryProjection, renderToolHistoryProjection } = await import(new URL("../../../conversation/dist/tool-history/projection.js", import.meta.url).href) as typeof import("../../../conversation/dist/tool-history/projection.js");
  const snapshot = f.reader.snapshotContinuity({ logicalConversationId: logicalId, currentConversationId: conversationId, currentRunId: runId });
  const pack = renderContinuityPack(snapshot, [], 8000, undefined, false, true);
  expect(pack.text).toContain("Get the record before guessing exact values");
  const entry = /Tool evidence id=("chr1_[A-Za-z0-9_-]{43}") invocation_id=("sth1_[A-Za-z0-9_-]+")/u.exec(pack.text!)!;
  expect(entry).not.toBeNull();
  const recordId = JSON.parse(entry[1]!) as string, invocationId = JSON.parse(entry[2]!) as string;
  const projection = renderToolHistoryProjection(prepareToolHistoryProjection(f.reader, logicalId, conversationId, runId),
    { conversationHistory: true, sessionHistory: true })!;
  const projectedId = /<tool_record id="(sth1_[A-Za-z0-9_-]+)"/u.exec(projection.text)![1]!;
  const extension = await createConversationHistoryRuntimeExtension({ historyRoot: f.root, rollover: "daily" })({ runId,
    request: { conversationId, userMessage: "Retrieve fictional evidence", abortSignal: new AbortController().signal }, context: {} as never });
  const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)[CONVERSATION_HISTORY_MCP_SERVER_NAME]!;
  const client = new Client({ name: "fictional-packed-id-client", version: "1.0.0" });
  clients.push(async () => { await client.close(); await extension.cleanup?.(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
  const get = async (recordId: string) => body(await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: { action: "get", recordId } }));
  expect(await get(recordId)).toMatchObject({ status: "available", chunk: "Fictional cobalt retained value." });
  for (const invalidId of [invocationId, projectedId]) {
    expect(invalidId).toMatch(/^sth1_/u);
    expect(await get(invalidId)).toMatchObject({ error: { code: "invalid_record" } });
  }
});
