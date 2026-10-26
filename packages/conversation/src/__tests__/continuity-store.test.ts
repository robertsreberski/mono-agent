import { createUpkeepSchema } from "../continuity/admission.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ToolHistoryWriter, acquireToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId, retainContinuity } from "../tool-history/continuity-storage.js";
import { retainContinuityText } from "../tool-history/continuity-payload.js";
import { CONTINUITY_RECORD_MAX_BYTES, type ContinuityPreparation, type ContinuityRecordInput } from "../tool-history/continuity-contracts.js";

const roots: string[] = [];
const writers = new Set<ToolHistoryWriter>();
const scope = { logicalConversationId: "web:fiction", currentConversationId: "web:fiction", currentRunId: "run-current" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const dbPath = (root: string) => join(root, "tool-history", "tool-lifecycles.sqlite");
const row = (sourceId = "answer", text = "Morgan chose the cobalt design."): ContinuityRecordInput => ({
  recordId: continuityRecordId(scope.currentConversationId, sourceId), runId: "run-prior", kind: "assistant", sequence: 0,
  text, provenance: "assistant",
});
const preparation = (records: readonly ContinuityRecordInput[] = [row()], conversationId = scope.currentConversationId): ContinuityPreparation => ({
  generationId: continuityGenerationId(), logicalConversationId: scope.logicalConversationId, conversationId,
  beforeDigest: digest("before"), afterDigest: digest("after"), records,
});
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "continuity-test-")); await chmod(value, 0o700); roots.push(value); return value; }
async function open(path: string, enabled = true, maxBytes?: number): Promise<ToolHistoryWriter> {
  const writer = await ToolHistoryWriter.open({ root: path, continuityEnabled: enabled, ...(maxBytes === undefined ? {} : { retention: { maxBytes } }) });
  writers.add(writer); return writer;
}
async function close(writer: ToolHistoryWriter): Promise<void> { await writer.close(); writers.delete(writer); }
async function publish(writer: ToolHistoryWriter, input: ContinuityPreparation): Promise<void> {
  await writer.prepareContinuity(input); await writer.commitContinuity({ generationId: input.generationId, conversationId: input.conversationId, canonicalDigest: input.afterDigest });
}
afterEach(async () => { for (const writer of writers) await writer.close(); writers.clear(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("continuity migration and retained representation", () => {
  it("leaves the existing v2 representation byte-identical when disabled and reads without migration", async () => {
    const path = await root(); const writer = await open(path, false); await close(writer);
    const before = await readFile(dbPath(path));
    const reader = new ToolHistoryReader(path);
    expect(reader.searchContinuity(scope)).toEqual({ available: false, items: [] });
    expect(reader.getContinuity({ ...scope, recordId: row().recordId }).status).toBe("unavailable");
    const baseline = await ToolHistoryWriter.open({ root: path }); await baseline.close();
    const expected = await readFile(dbPath(path));
    await writeFile(dbPath(path), before);
    const off = await open(path, false);
    await expect(off.prepareContinuity(preparation())).rejects.toMatchObject({ code: "continuity_disabled" });
    await close(off);
    expect(await readFile(dbPath(path))).toEqual(expected);
    const database = new DatabaseSync(dbPath(path), { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'continuity_%'").all()).toEqual([]); database.close();
  });

  it("upgrades in place under the same worker owner and never downgrades v3 when disabled", async () => {
    const path = await root(); const writer = await open(path, false);
    await writer.enableContinuity(); await publish(writer, preparation()); await close(writer);
    const off = await open(path, false);
    await expect(off.prepareContinuity(preparation([row("new")]))).rejects.toMatchObject({ code: "continuity_disabled" });
    expect(new ToolHistoryReader(path).searchContinuity(scope).items).toHaveLength(1); await close(off);
    const database = new DatabaseSync(dbPath(path)); expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    database.exec("PRAGMA user_version=4"); database.close();
    await expect(open(path)).rejects.toMatchObject({ code: "history_schema_unsupported" });
    expect(() => new ToolHistoryReader(path).stats()).toThrow(/unsupported/u);
  });

  it("can positively enable a shared v2 writer without opening a second worker", async () => {
    const path = await root(); const off = await acquireToolHistoryWriter({ root: path });
    const on = await acquireToolHistoryWriter({ root: path, continuityEnabled: true });
    try { expect(on.writer).toBe(off.writer); await publish(on.writer, preparation()); }
    finally { await on.release(); await off.release(); }
    expect(new ToolHistoryReader(path).searchContinuity(scope).items).toHaveLength(1);
  });

  it("retains independently of the old 4 KiB projection, with truthful bounds, redaction and digests", () => {
    const long = "cobalt ".repeat(15_000);
    expect(retainContinuityText(long)).toEqual({ text: long, sha256: digest(long), originalBytes: Buffer.byteLength(long), retainedBytes: Buffer.byteLength(long), redacted: false, truncated: false });
    const exact = "x".repeat(CONTINUITY_RECORD_MAX_BYTES);
    expect(retainContinuityText(exact)).toMatchObject({ text: exact, truncated: false, redacted: false });
    expect(retainContinuityText(exact + "🦊")).toMatchObject({ originalBytes: CONTINUITY_RECORD_MAX_BYTES + 4, truncated: true, redacted: false });
    expect(retainContinuityText(exact + "🦊").text).not.toContain(exact);
    const secret = retainContinuityText(`${long} api_key=sk-fictional-secret`);
    expect(secret.redacted).toBe(true); expect(secret.truncated).toBe(false); expect(secret.text).not.toContain("sk-fictional-secret");
    const path = retainContinuityText("See /home/example/private.txt");
    expect(path.redacted).toBe(true); expect(path.text).not.toContain("/home/example");
  });
});

describe("continuity publication primitives (not canonical-store integration)", () => {
  it("hides preparations, binds idempotency, and commits only the exact canonical target", async () => {
    const path = await root(), writer = await open(path), input = preparation(), reader = new ToolHistoryReader(path);
    expect(await writer.prepareContinuity(input)).toMatchObject({ status: "prepared" });
    expect(reader.searchContinuity(scope).items).toEqual([]);
    expect(reader.getContinuity({ ...scope, recordId: row().recordId }).status).toBe("unavailable");
    expect(await writer.prepareContinuity(input)).toMatchObject({ status: "prepared" });
    await expect(writer.prepareContinuity({ ...input, records: [row("answer", "changed")] })).rejects.toMatchObject({ code: "continuity_conflict" });
    expect((await writer.stats()).idempotencyConflicts).toBe(1);
    await expect(writer.prepareContinuity(preparation([row("other")]))).rejects.toMatchObject({ code: "continuity_reconciliation_required" });
    await expect(writer.commitContinuity({ conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: digest("foreign") })).rejects.toMatchObject({ code: "continuity_publication_mismatch" });
    await writer.commitContinuity({ conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: input.afterDigest });
    expect(reader.getContinuity({ ...scope, recordId: row().recordId })).toMatchObject({ status: "available", chunk: row().text, record: { sha256: digest(row().text) } });
    expect(await writer.prepareContinuity(input)).toMatchObject({ status: "committed" });
  });

  it.each(["before", "after", "advanced"] as const)("reconciles an abruptly killed writer at %s without blocking non-authoritative evidence", async (point) => {
    const path = await root(), input = preparation();
    const childPath = join(path, "crash-fixture.mjs");
    await writeFile(childPath, `
      import { ToolHistoryWriter } from ${JSON.stringify(new URL("../../dist/tool-history/writer.js", import.meta.url).href)};
      const writer = await ToolHistoryWriter.open({root:process.argv[2],continuityEnabled:true});
      await writer.prepareContinuity(JSON.parse(process.argv[3]));
      process.kill(process.pid, 'SIGKILL');
    `);
    const child = spawnSync(process.execPath, [childPath, path, JSON.stringify(input)], { encoding: "utf8", timeout: 20_000 });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const writer = await open(path), reader = new ToolHistoryReader(path);
    expect(reader.searchContinuity(scope).items).toEqual([]);
    const request = { conversationId: input.conversationId, canonicalDigest: digest(point) };
    if (point === "advanced") {
      expect(await writer.reconcileContinuity(request)).toMatchObject({ status: "abandoned" });
      expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 0, retainedBytes: 0, coverageGaps: 1 });
      expect(reader.continuityGaps(scope.logicalConversationId)).toMatchObject({ total: 1, items: [{ generationId: input.generationId,
        beforeDigest: input.beforeDigest, afterDigest: input.afterDigest, observedDigest: digest(point), reason: "canonical_advanced_past_preparation" }] });
      expect(reader.continuityGaps("web:foreign")).toEqual({ total: 0, items: [] });
      expect(reader.getContinuity({ ...scope, recordId: row().recordId }).status).toBe("unavailable");
      await expect(writer.commitContinuity({ ...request, generationId: input.generationId, canonicalDigest: input.afterDigest })).rejects.toMatchObject({ code: "continuity_conflict" });
      await expect(writer.prepareContinuity(input)).rejects.toMatchObject({ code: "continuity_conflict" });
      await expect(writer.prepareContinuity(preparation([row("next")]))).resolves.toMatchObject({ status: "prepared" });
    } else {
      expect(await writer.reconcileContinuity(request)).toMatchObject({ status: point === "after" ? "committed" : "discarded" });
      expect(reader.searchContinuity(scope).items).toHaveLength(point === "after" ? 1 : 0);
      expect(await writer.reconcileContinuity(request)).toEqual({ status: "clean" });
    }
  });

  it("suppresses pending-purge evidence, restores an unpublished reset, and recovers a published reset even above quota", async () => {
    const path = await root(), initial = await open(path), input = preparation();
    await publish(initial, input);
    await initial.pinContinuity({ logicalConversationId: scope.logicalConversationId, recordId: row().recordId, ownerKind: "handoff", ownerId: "fictional-reference" });
    await close(initial);
    const writer = await open(path, true, 1), reader = new ToolHistoryReader(path);
    const reset = { ...preparation([]), action: "reset" as const, beforeDigest: input.afterDigest, afterDigest: digest("reset") };
    await writer.prepareContinuity(reset);
    expect(reader.getContinuity({ ...scope, recordId: row().recordId }).status).toBe("unavailable");
    expect(await writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: input.afterDigest })).toMatchObject({ status: "discarded" });
    expect(reader.getContinuity({ ...scope, recordId: row().recordId }).status).toBe("available");
    await writer.prepareContinuity({ ...reset, generationId: continuityGenerationId() });
    expect(await writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: reset.afterDigest })).toMatchObject({ status: "committed" });
    expect((await writer.stats()).continuity).toMatchObject({ records: 0, pins: 0, prepared: 0 });
    expect(reader.searchContinuity(scope).items).toEqual([]);
  });

  it("never promotes a pre-cut summary on canonical digest alone and requires exact native checkpoint proof", async () => {
    const path = await root(), writer = await open(path), reader = new ToolHistoryReader(path);
    const record: ContinuityRecordInput = { ...row("summary", "A completed portable summary."), kind: "summary", provenance: "generated",
      source: { journalId: "fiction-journal", operationId: "fiction-operation" },
      summary: { model: "faux:m", operationId: "fiction-operation", trigger: "manual", coverage: { sourceDigest: digest("coverage") } } };
    const input = { ...preparation([record]), action: "checkpoint" as const, beforeDigest: null, afterDigest: null, latestSummaryRecordId: record.recordId };
    await writer.prepareContinuity(input);
    await expect(writer.prepareContinuity({ ...input, generationId: continuityGenerationId(),
      records: [{ ...record, recordId: continuityRecordId(input.conversationId, "oversized-summary"), text: "x".repeat(1024 * 1024 + 1) }],
      latestSummaryRecordId: continuityRecordId(input.conversationId, "oversized-summary") })).rejects.toMatchObject({ code: "continuity_summary_unavailable" });
    expect(await writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: null })).toMatchObject({ status: "checkpoint_pending" });
    expect(reader.searchContinuity(scope).items).toEqual([]);
    await expect(writer.commitContinuity({ conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: null })).rejects.toMatchObject({ code: "continuity_publication_mismatch" });
    await expect(writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: null, checkpoint: { status: "published", journalId: "fiction-journal", operationId: "fiction-operation", sourceDigest: "invalid", summaryDigest: digest(record.text) } })).rejects.toMatchObject({ code: "continuity_invalid_preparation" });
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 1 });
    await expect(writer.commitContinuity({ conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: null,
      checkpoint: { status: "published", journalId: "fiction-journal", operationId: "fiction-operation", sourceDigest: digest("coverage"), summaryDigest: digest("different retained text") } })).rejects.toMatchObject({ code: "continuity_publication_mismatch" });
    expect(await writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: null,
      checkpoint: { status: "published", journalId: "fiction-journal", operationId: "fiction-operation", sourceDigest: digest("coverage"), summaryDigest: digest(record.text) } })).toMatchObject({ status: "committed" });
    expect(reader.latestContinuitySummary(scope)).toMatchObject({ recordId: record.recordId, summary: { trigger: "manual" } });
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, pins: 1 });
  });

  it("releases unpublished checkpoint preparation only after explicit absence evidence", async () => {
    const path = await root(), writer = await open(path);
    const record: ContinuityRecordInput = { ...row("summary"), kind: "summary", provenance: "generated",
      source: { journalId: "fiction-journal", operationId: "fiction-operation" },
      summary: { model: "faux:m", operationId: "fiction-operation", trigger: "pre-turn", coverage: { sourceDigest: digest("coverage") } } };
    const input = { ...preparation([record]), action: "checkpoint" as const, afterDigest: digest("before"), latestSummaryRecordId: record.recordId };
    await writer.prepareContinuity(input);
    expect(await writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: input.beforeDigest, checkpoint: { status: "absent" } })).toMatchObject({ status: "discarded" });
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 0, retainedBytes: 0 });
  });

  it("keeps a pending checkpoint intact across an unpublished purge and purges it only with canonical reset proof", async () => {
    const path = await root(), writer = await open(path), reader = new ToolHistoryReader(path);
    const record: ContinuityRecordInput = { ...row("summary"), kind: "summary", provenance: "generated",
      source: { journalId: "fiction-journal", operationId: "fiction-operation" },
      summary: { model: "faux:m", operationId: "fiction-operation", trigger: "manual", coverage: { sourceDigest: digest("coverage") } } };
    const cut = { ...preparation([record]), action: "checkpoint" as const, afterDigest: digest("before"), latestSummaryRecordId: record.recordId };
    await writer.prepareContinuity(cut);
    const purge = { ...preparation([]), action: "reset" as const, afterDigest: digest("reset") };
    await writer.prepareContinuity(purge);
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 2 });
    expect(await writer.reconcileContinuity({ conversationId: scope.currentConversationId, canonicalDigest: purge.beforeDigest })).toMatchObject({ status: "discarded", generationId: purge.generationId });
    expect(await writer.reconcileContinuity({ conversationId: scope.currentConversationId, canonicalDigest: cut.beforeDigest })).toMatchObject({ status: "checkpoint_pending", generationId: cut.generationId });
    const reset = { ...purge, generationId: continuityGenerationId() }; await writer.prepareContinuity(reset);
    await writer.commitContinuity({ conversationId: scope.currentConversationId, generationId: reset.generationId, canonicalDigest: reset.afterDigest });
    expect((await writer.stats()).continuity).toMatchObject({ prepared: 0, records: 0, pins: 0 });
    expect(reader.latestContinuitySummary(scope)).toBeUndefined();
  });

  it("rejects oversized generation inputs before worker cloning and reconciles an absent source", async () => {
    const path = await root(), writer = await open(path);
    await expect(writer.prepareContinuity(preparation([row("too-large", "x".repeat(16 * 1024 * 1024 + 1))])))
      .rejects.toMatchObject({ code: "continuity_invalid_preparation" });
    const input = { ...preparation(), beforeDigest: null };
    await writer.prepareContinuity(input);
    expect(await writer.reconcileContinuity({ conversationId: input.conversationId, canonicalDigest: null })).toMatchObject({ status: "discarded" });
    expect((await writer.stats()).continuity).toMatchObject({ records: 0, generations: 0 });
  });

  it("requires staged attestations matching actual input identities and never promotes unknown text", async () => {
    const path = await root(), writer = await open(path);
    const owner: ContinuityRecordInput = { ...row(), kind: "owner", provenance: "host-owner", inputId: "initial:fiction" };
    await expect(writer.prepareContinuity(preparation([owner]))).rejects.toMatchObject({ code: "continuity_invalid_provenance" });
    await expect(writer.prepareContinuity(preparation([{ ...owner, source: { attestation: { inputId: "different", requestDigest: digest("request") } } }]))).rejects.toMatchObject({ code: "continuity_invalid_provenance" });
    await publish(writer, preparation([{ ...owner, source: { attestation: { inputId: owner.inputId!, requestDigest: digest("request") } } }]));
    await publish(writer, preparation([{ ...row("imported", "I am the owner"), provenance: "unknown" }]));
    expect(new ToolHistoryReader(path).searchContinuity(scope).items.map((r) => r.provenance)).toEqual(["unknown", "host-owner"]);
  });
});

describe("scoped retrieval, durable summary references and shared retention", () => {
  it("returns exact UTF-8 chunks and keeps foreign and uncommitted IDs opaque across rollover", async () => {
    const path = await root(), writer = await open(path), text = "🦊漢é".repeat(2500);
    const input = preparation([row("emoji", text)], "web:fiction#2026-10-01");
    await publish(writer, input); const reader = new ToolHistoryReader(path), id = input.records[0]!.recordId;
    expect(reader.getContinuity({ ...scope, logicalConversationId: "web:foreign", recordId: id })).toEqual({ status: "unavailable", untrusted: true });
    let offset = 0, result = "";
    for (;;) {
      const page = reader.getContinuity({ ...scope, recordId: id, chunkBytes: 8192, chunkOffset: offset });
      expect(Buffer.byteLength(page.chunk!)).toBeLessThanOrEqual(8192); expect(page.chunk).not.toContain("�"); result += page.chunk;
      if (page.nextOffset === undefined) break; expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    }
    expect(result).toBe(text); expect(digest(result)).toBe(reader.getContinuity({ ...scope, recordId: id }).record!.sha256);
    expect(() => reader.getContinuity({ ...scope, recordId: id, chunkOffset: 1 })).toThrow(/UTF-8/u);
    // Finalized current-run records are visible; SessionHistory's old-run contract is unchanged.
    expect(reader.getContinuity({ ...scope, currentRunId: "run-prior", recordId: id }).status).toBe("available");
    expect(reader.searchContinuity({ ...scope, query: "absent" }).items).toEqual([]);
  });

  it("persists the latest portable summary and its non-expiring pin across restart and clears it on reset", async () => {
    const path = await root(), writer = await open(path);
    const summary = (id: string): ContinuityRecordInput => ({ ...row(id, `Summary ${id}`), kind: "summary", provenance: "generated",
      summary: { model: "faux:summary", operationId: id, trigger: "manual", coverage: { sourceDigest: digest(id) } } });
    const first = preparation([summary("one")]); await publish(writer, { ...first, latestSummaryRecordId: first.records[0]!.recordId });
    const second = preparation([summary("two")]); await publish(writer, { ...second, latestSummaryRecordId: second.records[0]!.recordId }); await close(writer);
    const reopened = await open(path, false), reader = new ToolHistoryReader(path);
    expect(reader.latestContinuitySummary(scope)).toMatchObject({ recordId: second.records[0]!.recordId, summary: { model: "faux:summary", trigger: "manual", operationId: "two" } });
    expect((await reopened.stats()).continuity).toMatchObject({ pins: 1, prepared: 0 });
    await reopened.resetConversation(scope.logicalConversationId);
    expect(reader.latestContinuitySummary(scope)).toBeUndefined(); expect(reader.searchContinuity(scope).items).toEqual([]);
    expect((await reopened.stats()).continuity).toMatchObject({ pins: 0, records: 0, generations: 0 });
  });

  it("never expires pins, reports quota degradation and provides tombstones only in scope", async () => {
    const path = await root(), writer = await open(path, true, 200);
    const input = preparation([row("pinned", "a".repeat(150))]); await publish(writer, input);
    const pin = { logicalConversationId: scope.logicalConversationId, recordId: input.records[0]!.recordId, ownerKind: "checkpoint" as const, ownerId: "checkpoint-one" };
    await writer.pinContinuity(pin);
    await expect(writer.pinContinuity({ ...pin, logicalConversationId: "web:foreign" })).rejects.toMatchObject({ code: "continuity_record_unavailable" });
    await expect(writer.prepareContinuity(preparation([row("overflow", "b".repeat(100))]))).rejects.toMatchObject({ code: "continuity_quota_exhausted" });
    expect((await writer.stats()).continuity).toMatchObject({ pins: 1, retainedBytes: 150, degraded: true }); await close(writer);
    const smaller = await open(path, true, 100), reader = new ToolHistoryReader(path);
    expect(reader.getContinuity({ ...scope, recordId: pin.recordId }).status).toBe("available");
    await smaller.unpinContinuity({ ...pin, logicalConversationId: "web:foreign" }); expect((await smaller.stats()).continuity!.pins).toBe(1);
    await smaller.unpinContinuity(pin); await close(smaller);
    const prune = await open(path, true, 100);
    expect(reader.getContinuity({ ...scope, recordId: pin.recordId })).toMatchObject({ status: "tombstoned", tombstone: { reason: "bytes" } });
    expect(reader.getContinuity({ ...scope, logicalConversationId: "web:foreign", recordId: pin.recordId }).status).toBe("unavailable");
    expect((await prune.stats()).continuity).toMatchObject({ retainedBytes: 0, tombstones: 1 });
  });

  it("reserves incoming text atomically by evicting only unpinned evidence", async () => {
    const path = await root(), writer = await open(path, true, 200);
    const first = preparation([row("old", "a".repeat(150))]); await publish(writer, first);
    const next = preparation([row("replacement", "b".repeat(150))]); await publish(writer, next);
    const reader = new ToolHistoryReader(path);
    expect(reader.getContinuity({ ...scope, recordId: first.records[0]!.recordId }).status).toBe("tombstoned");
    expect(reader.getContinuity({ ...scope, recordId: next.records[0]!.recordId }).status).toBe("available");
    expect((await writer.stats()).retainedBytes).toBe(150);
  });

  it("bounds zero-byte record metadata by count and preserves siblings during logical reset", async () => {
    const path = await root();
    const writer = await ToolHistoryWriter.open({ root: path, continuityEnabled: true, retention: { maxCompletedCalls: 2 } }); writers.add(writer);
    const first = preparation([row("one", "")]); await publish(writer, first);
    const second = preparation([row("two", "")]); await publish(writer, second);
    const third = preparation([row("three", "")]); await publish(writer, third);
    const reader = new ToolHistoryReader(path);
    expect(reader.getContinuity({ ...scope, recordId: first.records[0]!.recordId })).toMatchObject({ status: "tombstoned", tombstone: { reason: "count" } });
    await publish(writer, { ...preparation([row("sibling", "")], "web:sibling"), logicalConversationId: "web:sibling" });
    await writer.resetConversation(scope.logicalConversationId);
    expect(reader.searchContinuity(scope).items).toEqual([]);
    expect(reader.searchContinuity({ ...scope, logicalConversationId: "web:sibling" }).items).toHaveLength(1);
  });

  it("refuses damaged v3 tables without reconstructing them or mutating evidence", async () => {
    const path = await root(), writer = await open(path); await publish(writer, preparation()); await close(writer);
    const database = new DatabaseSync(dbPath(path)); database.exec("DROP TABLE continuity_pins"); database.close();
    const before = await readFile(dbPath(path));
    expect(() => new ToolHistoryReader(path).searchContinuity(scope)).toThrow(/damaged/u);
    await expect(open(path, false)).rejects.toMatchObject({ code: "history_integrity_failed" });
    expect(await readFile(dbPath(path))).toEqual(before);
  });

  it("accounts continuity and tool records against the same byte budget without changing SessionHistory visibility", async () => {
    const path = await root(), writer = await open(path, true, 300);
    const input = preparation([row("shared", "a".repeat(100))]); await publish(writer, input);
    const run = { conversationId: scope.currentConversationId, logicalConversationId: scope.logicalConversationId, runId: "tools", isolated: false };
    await writer.persist(run, { phase: "invocation", toolCallId: "call", toolName: "Read", arguments: {} });
    await writer.persist(run, { phase: "result", toolCallId: "call", state: "success", content: "b".repeat(250) });
    const stats = await writer.stats(); expect(stats.retainedBytes).toBeLessThanOrEqual(300);
    const reader = new ToolHistoryReader(path);
    expect(reader.search({ ...scope, currentConversationId: scope.currentConversationId }).items).toHaveLength(1);
    expect(reader.getContinuity({ ...scope, recordId: input.records[0]!.recordId }).status).toBe("tombstoned");
    expect(reader.stats()!.retainedBytes).toBe(stats.retainedBytes);
  });
});

it("leaves disabled P3b1 checkpoint metadata untouched during tombstoning and replays its commit", async () => {
  const path = await root(), writer = await open(path), reader = new ToolHistoryReader(path);
  const record: ContinuityRecordInput = { ...row("legacy-summary", "Completed fictional summary."), kind: "summary", provenance: "generated",
    source: { journalId: "fiction-journal", operationId: "fiction-operation" },
    summary: { model: "faux:m", operationId: "fiction-operation", trigger: "manual", coverage: { sourceDigest: digest("coverage") } } };
  const input = { ...preparation([record]), action: "checkpoint" as const, beforeDigest: null, afterDigest: null, latestSummaryRecordId: record.recordId };
  const publication = { conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: null,
    checkpoint: { status: "published" as const, journalId: "fiction-journal", operationId: "fiction-operation", sourceDigest: digest("coverage"), summaryDigest: digest(record.text) } };
  await writer.prepareContinuity(input); await writer.commitContinuity(publication);
  const db = new DatabaseSync(dbPath(path));
  try {
    createUpkeepSchema(db);
    db.exec("DROP TRIGGER continuity_upkeep_privacy_delete; DROP TRIGGER continuity_upkeep_privacy_update; DROP TRIGGER continuity_upkeep_privacy_tombstone; DROP TRIGGER continuity_upkeep_privacy_generation; DROP TABLE continuity_upkeep_offers; DROP TABLE continuity_upkeep_progress; DROP TABLE continuity_upkeep_migrations; DELETE FROM continuity_pins");
    const before = Number((db.prepare("SELECT total_changes() n").get() as any).n);
    retainContinuity(db, { ...reader.stats()!.limits, maxAgeMs: 1 }, Date.now() + 10000);
    expect(Number((db.prepare("SELECT total_changes() n").get() as any).n) - before).toBe(1);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get()).toBeUndefined();
    expect(db.prepare("SELECT retained_text,summary_json FROM continuity_records").get()).toMatchObject({ retained_text: null, summary_json: expect.any(String) });
    await expect(writer.commitContinuity(publication)).resolves.toBeUndefined();
    db.exec(`INSERT INTO continuity_upkeep_scopes VALUES ('legacy','legacy','legacy',0,'');
      INSERT INTO continuity_upkeep_admissions VALUES ('legacy','legacy','legacy','legacy');
      INSERT INTO continuity_upkeep_operations VALUES ('legacy','legacy','legacy','legacy',0,'','{}','legacy','bootstrap','terminal',NULL)`);
    retainContinuity(db, { ...reader.stats()!.limits, maxBytes: 1 }, Date.now());
    expect(db.prepare("SELECT count(*) n FROM continuity_upkeep_operations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT bootstrap_operation FROM continuity_upkeep_admissions").get()).toEqual({ bootstrap_operation: "legacy" });
    db.exec("UPDATE continuity_records SET summary_json=NULL");
    await expect(writer.commitContinuity(publication)).resolves.toBeUndefined();
  } finally { db.close(); }
});

it("replays an enabled committed checkpoint after retention erases its summary proof", async () => {
  const path = await root(), writer = await open(path), reader = new ToolHistoryReader(path);
  const record: ContinuityRecordInput = { ...row("enabled-summary", "Completed fictional summary."), kind: "summary", provenance: "generated",
    source: { journalId: "fiction-journal", operationId: "fiction-operation" },
    summary: { model: "faux:m", operationId: "fiction-operation", trigger: "manual", coverage: { sourceDigest: digest("coverage") } } };
  const input = { ...preparation([record]), action: "checkpoint" as const, beforeDigest: null, afterDigest: null, latestSummaryRecordId: record.recordId };
  const publication = { conversationId: input.conversationId, generationId: input.generationId, canonicalDigest: null,
    checkpoint: { status: "published" as const, journalId: "fiction-journal", operationId: "fiction-operation", sourceDigest: digest("coverage"), summaryDigest: digest(record.text) } };
  await writer.prepareContinuity(input); await writer.commitContinuity(publication);
  const db = new DatabaseSync(dbPath(path));
  try {
    createUpkeepSchema(db);
    db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?)").run(scope.logicalConversationId, scope.currentConversationId, "fixture", JSON.stringify({ ordinal: 1, offset: 0, digest: "", watermark: 1 }));
    db.exec("DELETE FROM continuity_pins");
    retainContinuity(db, { ...reader.stats()!.limits, maxAgeMs: 1 }, Date.now() + 10000);
    expect(db.prepare("SELECT retained_text,summary_json,text_sha256 FROM continuity_records").get()).toEqual({ retained_text: null, summary_json: null, text_sha256: "" });
    await expect(writer.commitContinuity(publication)).resolves.toBeUndefined();
  } finally { db.close(); }
});
