import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import type { ToolHistoryRunBinding } from "../tool-history/contracts.js";

const roots: string[] = [], writers = new Set<ToolHistoryWriter>();
afterEach(async () => { for (const writer of writers) await writer.close(); writers.clear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const binding: ToolHistoryRunBinding = { conversationId: "web:fiction", logicalConversationId: "web:fiction", runId: "actual-fixture-run", isolated: false, continuityEnabled: true, finalizedContinuity: true };
const scope = { logicalConversationId: binding.logicalConversationId, currentConversationId: binding.conversationId, currentRunId: binding.runId };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(enabled = true, maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "continuity-tool-")); roots.push(root);
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: enabled, ...(maxBytes === undefined ? {} : { retention: { maxBytes } }) }); writers.add(writer);
  return { root, writer, reader: new ToolHistoryReader(root) };
}
async function result(writer: ToolHistoryWriter, text: string, callId = "fiction-call", run = binding) {
  return await writer.persist(run, { phase: "result", toolCallId: callId, toolName: "Read", state: "success", content: [{ type: "text", text }] });
}

it("publishes only a finalized full text result before run completion, independently of lifecycle JSON clipping", async () => {
  const f = await fixture(), text = "Fictional cobalt 🔷. ".repeat(3000);
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "fiction-call", toolName: "Read", arguments: {} });
  expect(f.reader.searchContinuity(scope).items).toEqual([]);
  const stored = await result(f.writer, text); expect(stored.persistence).toBe("persisted");
  const found = f.reader.searchContinuity(scope).items; expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ kind: "tool", provenance: "tool", runId: binding.runId, sha256: sha(text), originalBytes: Buffer.byteLength(text), truncated: false });
  const legacy = f.reader.get({ ...scope, currentRunId: "later-reader", recordId: stored.recordId! }); expect(legacy.record?.truncated).toBe(true);
  let actual = "", offset: number | undefined;
  do { const page = f.reader.getContinuity({ ...scope, recordId: found[0]!.recordId, ...(offset === undefined ? {} : { chunkOffset: offset }) }); actual += page.chunk; offset = page.nextOffset; } while (offset !== undefined);
  expect(actual).toBe(text);
  await result(f.writer, text); expect(f.reader.stats()?.continuity?.records).toBe(1);
});

it("refuses a changed tail hidden by the legacy JSON projection and durably counts the identity conflict", async () => {
  const f = await fixture(), prefix = "a".repeat(20_000);
  await result(f.writer, prefix + "cobalt");
  expect(await result(f.writer, prefix + "violet")).toMatchObject({ persistence: "failed", errorCode: "history_idempotency_conflict" });
  expect((await f.writer.stats()).idempotencyConflicts).toBeGreaterThan(0);
  const record = f.reader.searchContinuity(scope).items[0]!;
  expect(record.sha256).toBe(sha(prefix + "cobalt"));
});

it("keeps full lifecycle identity after legacy rows have expired, including the tool name", async () => {
  const f = await fixture(); await result(f.writer, "Fictional identity-bound output.");
  const database = new DatabaseSync(f.reader.databasePath);
  try { database.exec("DELETE FROM tool_records; DELETE FROM tool_calls;"); } finally { database.close(); }
  expect(await f.writer.persist(binding, { phase: "result", toolCallId: "fiction-call", toolName: "Bash", state: "success", content: [{ type: "text", text: "Fictional identity-bound output." }] }))
    .toMatchObject({ persistence: "failed", errorCode: "history_idempotency_conflict" });
  expect((await f.writer.stats()).calls).toBe(0); expect((await f.writer.stats()).idempotencyConflicts).toBeGreaterThan(0);
  expect(f.reader.searchContinuity(scope).items).toHaveLength(1);
});

it("captures plain strings and joins all plain text blocks in order with truthful UTF-8 bytes", async () => {
  const f = await fixture();
  await f.writer.persist(binding, { phase: "result", toolCallId: "plain-string", toolName: "Read", state: "success", content: "Fictional plain string." });
  await f.writer.persist(binding, { phase: "result", toolCallId: "plain-blocks", toolName: "Read", state: "success", content: [{ type: "text", text: "alpha" }, { type: "text", text: "β" }] });
  const found = f.reader.searchContinuity(scope).items;
  expect(found).toHaveLength(2); expect(found[0]).toMatchObject({ preview: "alpha\nβ", originalBytes: 8, sha256: sha("alpha\nβ") });
  expect(found[1]!.preview).toBe("Fictional plain string.");
});

it("sanitizes complete text and reports oversize omission with truthful multi-block byte counts", async () => {
  const f = await fixture();
  await result(f.writer, "api_key=fictional_fixture_secret_1234567890", "redacted");
  const huge = "z".repeat(700_000);
  await f.writer.persist(binding, { phase: "result", toolCallId: "oversized", toolName: "Read", state: "success", content: [{ type: "text", text: huge }, { type: "text", text: huge }] });
  const found = f.reader.searchContinuity(scope).items;
  expect(found.find(r => r.redacted)?.preview).not.toContain("fictional_fixture_secret");
  expect(found.find(r => r.truncated)).toMatchObject({ originalBytes: 1_400_001, truncated: true });
  expect(found.find(r => r.truncated)?.preview).toContain("exceeded the record bound");
});

it("does not infer positive capture from the shared writer and never upgrades an OFF writer", async () => {
  const f = await fixture();
  const { continuityEnabled: _flag, ...off } = binding;
  await result(f.writer, "Fictional legacy body", "legacy", off);
  const { finalizedContinuity: _owned, ...unowned } = binding;
  await result(f.writer, "Fictional unowned body", "unowned", unowned);
  expect(f.reader.searchContinuity(scope).items).toEqual([]);
  const disabled = await fixture(false); await result(disabled.writer, "Fictional disabled body");
  const database = new DatabaseSync(disabled.reader.databasePath, { readOnly: true });
  try { expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2); } finally { database.close(); } expect(disabled.reader.searchContinuity(scope).available).toBe(false);
});

it("skips isolated, interrupted, nested, opaque and mixed-content results without manufacturing recovery evidence", async () => {
  const f = await fixture();
  await result(f.writer, "Fictional isolated body", "isolated", { ...binding, isolated: true });
  for (const [id, state, content, toolName] of [
    ["nested", "success", [{ type: "text", text: "Nested historical evidence" }], "ConversationHistory"],
    ["partial", "interrupted", [{ type: "text", text: "Partial output" }], "Read"],
    ["image", "success", [{ type: "text", text: "Text subset" }, { type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], "Read"],
    ["signed", "success", [{ type: "text", text: "Signed text", signature: "fictional" }], "Read"],
  ] as const) await f.writer.persist(binding, { phase: "result", toolCallId: id, state, content, toolName });
  await f.writer.persist(binding, { phase: "result", toolCallId: "unnamed", state: "success", content: "Unidentifiable tool output." });
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "unfinished", toolName: "Read", arguments: {} });
  await f.writer.finishRun(binding, "cancelled");
  expect(f.reader.searchContinuity(scope).items).toEqual([]);
});

it("degrades full capture on quota without rejecting the actual tool result", async () => {
  const f = await fixture(true, 1000);
  expect(await result(f.writer, "Fictional output. ".repeat(1000))).toMatchObject({ persistence: "persisted" });
  expect(f.reader.stats()?.continuity).toMatchObject({ records: 0, degraded: true });
});

it("does not displace a pending canonical publication when independent finalized evidence commits", async () => {
  const f = await fixture();
  await f.writer.prepareContinuity({ generationId: "chg1_" + "a".repeat(32), conversationId: binding.conversationId,
    logicalConversationId: binding.logicalConversationId, beforeDigest: null, afterDigest: sha("fictional target"), records: [] });
  await result(f.writer, "Independent finalized fictional evidence.");
  expect(f.reader.stats()?.continuity).toMatchObject({ records: 1, prepared: 1 });
  expect(f.reader.searchContinuity(scope).items).toHaveLength(1);
  expect(await f.writer.reconcileContinuity({ conversationId: binding.conversationId, canonicalDigest: null })).toMatchObject({ status: "discarded" });
  expect(f.reader.searchContinuity(scope).items).toHaveLength(1);
});

it("keeps the same finalized bytes across process death without finishing the run and purges them on reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-tool-crash-")); roots.push(root);
  const script = join(root, "producer.mjs"), text = "Fictional durable cobalt output. ".repeat(1000);
  await writeFile(script, `import { ToolHistoryWriter } from ${JSON.stringify(pathToFileURL(resolve("dist/tool-history/writer.js")).href)};
const writer = await ToolHistoryWriter.open({ root: ${JSON.stringify(root)}, continuityEnabled: true });
await writer.persist(${JSON.stringify(binding)}, ${JSON.stringify({ phase: "result", toolCallId: "fiction-call", toolName: "Read", state: "success", content: [{ type: "text", text }] })});
process.stdout.write('READY\\n'); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((yes, no) => { const timer = setTimeout(() => no(new Error("Fixture producer did not become ready")), 10_000);
      child.once("error", error => { clearTimeout(timer); no(error); }); child.once("exit", () => { clearTimeout(timer); no(new Error("Fixture producer exited early")); });
      child.stdout.on("data", chunk => { if (String(chunk).includes("READY")) { clearTimeout(timer); yes(); } }); });
  } finally { child.kill("SIGKILL"); await new Promise(yes => child.once("close", yes)); }
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true }); writers.add(writer);
  const reader = new ToolHistoryReader(root), records = reader.searchContinuity(scope).items;
  expect(records).toHaveLength(1); expect(records[0]!.sha256).toBe(sha(text));
  expect((await writer.stats()).idempotencyConflicts).toBe(0);
  await writer.resetConversation(binding.logicalConversationId); expect(reader.stats()?.continuity?.records).toBe(0);
});
