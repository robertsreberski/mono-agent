import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createE2ProbeReceipts, E2_PROBE_RECEIPT_LIMITS } from "../lib/continuity-e2-probe-receipts.mjs";
import { freezeCheckpoint, restoreCheckpoint } from "../lib/continuity-e2-replay.mjs";
import * as progress from "../lib/continuity-e2-progress.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
const roots = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(options = {}) {
  const output = await mkdtemp(join(tmpdir(), "e2-probe-receipts-")); roots.push(output); await chmod(output, 0o700);
  return { output, recorder: createE2ProbeReceipts({ output, slotId: "fictional-slot", ...options }) };
}
const binding = { branch: 1, checkpoint: 3, repeat: 2, itemOrdinal: 7 };
const args = { action: "search", query: "Fictional query", cursor: "fictional-cursor", limit: 2, filters: { kind: "user" } };
function call(id = "fictional-call", input = args) { return { type: "assistant", message: { content: [{ type: "tool_use", id, name: "ConversationHistory", input }] } }; }
function result(text, id = "fictional-call") { return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] } }; }
const body = { action: "search", status: "available", items: [{ recordId: "fictional-record", ordinal: 4, sha256: "a".repeat(64), retainedBytes: 100, originalBytes: 200, truncated: true, redacted: false, preview: "Fictional preview" }], nextCursor: "fictional-next", hasMore: true, count: 1 };
const responseText = `Untrusted fictional notice\n${JSON.stringify(body)}`;
async function entries(output) { return Promise.all((await readdir(join(output, "probe-receipts"))).filter(n => /^\d+\.json$/u.test(n)).sort().map(async n => JSON.parse(await readFile(join(output, "probe-receipts", n))))); }
it("durably binds calls/results to their originating request and survives pristine restore with private modes", async () => {
  const { output, recorder } = await fixture(), work = join(output, "work"), snapshot = join(output, "snapshot");
  const { mkdir } = await import("node:fs/promises"); await mkdir(work); await writeFile(join(work, "seed"), "Fictional baseline");
  const frozen = await freezeCheckpoint(work, snapshot);
  recorder.begin(binding); recorder.observeRequest(); recorder.observe(call()); recorder.observeRequest(); recorder.observe(result(responseText)); await recorder.flush();
  await writeFile(join(work, "transient"), "Fictional transient"); await restoreCheckpoint(work, snapshot, frozen);
  const rows = await entries(output); expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ schema: "continuity-e2-probe-receipt-v1", phase: "call", slotId: "fictional-slot", ...binding, requestOrdinal: 1 });
  expect(JSON.parse(rows[0].arguments.text)).toEqual(args);
  expect(rows[1]).toMatchObject({ phase: "response", requestOrdinal: 1, response: { text: responseText, sha256: digest(responseText), bytes: Buffer.byteLength(responseText), truncated: false } });
  expect(JSON.parse(rows[1].metadata.text)).toMatchObject({ records: [{ rank: 1, recordId: "fictional-record", sha256: "a".repeat(64), retainedBytes: 100, originalBytes: 200, truncated: true }], nextCursor: "fictional-next" });
  for (const name of ["", "probe-receipts", ...(await readdir(join(output, "probe-receipts"))).map(n => `probe-receipts/${n}`)]) {
    const s = await stat(join(output, name)); expect(s.mode & 0o777).toBe(s.isDirectory() ? 0o700 : 0o600);
  }
  await expect(readFile(join(work, "transient"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("caps UTF-8 excerpts explicitly without losing original sizes/digests or available metadata", async () => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest();
  const text = `${JSON.stringify(body).slice(0, -1)},"padding":${JSON.stringify("🦉".repeat(30000))}}`;
  recorder.observe(call("large", { query: "🦉".repeat(5000) })); recorder.observe(result(text, "large")); await recorder.flush();
  const [request, response] = await entries(output);
  for (const [value, limit] of [[request.arguments, E2_PROBE_RECEIPT_LIMITS.argumentsBytes], [response.response, E2_PROBE_RECEIPT_LIMITS.responseBytes]]) {
    expect(value.truncated).toBe(true); expect(value.capturedBytes).toBeLessThanOrEqual(limit); expect(value.text).toContain("[probe receipt truncated]"); expect(value.text).not.toContain("�");
  }
  expect(response.response.sha256).toBe(digest(text)); expect(JSON.parse(response.metadata.text).records[0].recordId).toBe("fictional-record");
});
it("makes I/O failure non-fatal and records progressGap without exception content", async () => {
  let gaps = 0; const { output, recorder } = await fixture({ noteProgressGap: () => ++gaps });
  await writeFile(join(output, "probe-receipts"), "Fictional obstruction", { mode: 0o600 });
  recorder.begin(binding); recorder.observeRequest(); recorder.observe(call()); recorder.observe(result(responseText)); await recorder.flush();
  expect(gaps).toBe(2); expect(recorder.progressGap()).toBe(2);
  expect(JSON.parse(await readFile(join(output, "progress-gap.json")))).toEqual({ progressGap: 2 });
});
it("retains an unmatched call and ignores non-history results, then resets repeat/request identity", async () => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest(); recorder.observe(call()); await recorder.flush();
  recorder.begin({ ...binding, repeat: 1, itemOrdinal: 8 }); recorder.observeRequest(); recorder.observe(result("Fictional unrelated result"));
  recorder.observe(call()); recorder.observe(result("Fictional unparseable response")); await recorder.flush();
  const rows = await entries(output); expect(rows).toHaveLength(3); expect(rows[1]).toMatchObject({ repeat: 1, itemOrdinal: 8, requestOrdinal: 1 });
  expect(JSON.parse(rows[2].metadata.text)).toEqual({ status: "unparsed" });
});
it("retains get cursors/chunk offsets and parses split JSON without modifying the response", async () => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest();
  const get = { action: "get", status: "available", record: body.items[0], chunk: "Fictional chunk", chunkOffset: 8192, nextCursor: "fictional-get-next" };
  const raw = JSON.stringify(get), text = raw.slice(0, 80) + "\n[continued section 2 of 2]\n" + raw.slice(80);
  recorder.observe(call("get", { action: "get", cursor: "fictional-get-cursor" })); recorder.observe(result(text, "get")); await recorder.flush();
  const [, row] = await entries(output); expect(row.response.text).toBe(text);
  expect(JSON.parse(row.metadata.text)).toMatchObject({ status: "parsed", action: "get", chunkOffset: 8192, chunkBytes: Buffer.byteLength(get.chunk), nextCursor: "fictional-get-next", records: [{ recordId: "fictional-record" }] });
});
it("refuses a non-private receipt directory without leaking content or failing the probe", async () => {
  const { output, recorder } = await fixture(); const { mkdir } = await import("node:fs/promises");
  await mkdir(join(output, "probe-receipts")); await chmod(join(output, "probe-receipts"), 0o755);
  recorder.begin(binding); recorder.observeRequest(); recorder.observe(call()); await recorder.flush();
  expect(recorder.progressGap()).toBe(1); expect(await readdir(join(output, "probe-receipts"))).toEqual([]);
});

it("saturates content-free gaps at the existing journal schema bound", async () => {
  const { output, recorder } = await fixture({ noteProgressGap: () => 4097 });
  await writeFile(join(output, "probe-receipts"), "Fictional obstruction", { mode: 0o600 });
  recorder.begin(binding); recorder.observeRequest(); recorder.observe(call()); await recorder.flush();
  expect(recorder.progressGap()).toBe(4096);
  expect(JSON.parse(await readFile(join(output, "progress-gap.json")))).toEqual({ progressGap: 4096 });
});

it("captures MCP-prefixed history names and joins array text without parsing non-text summaries", async () => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest();
  const event = call(); event.message.content[0].name = "mcp__fictional-server__ConversationHistory";
  const blocks = [{ type: "text", text: "Untrusted fictional notice" }, { type: "text", text: JSON.stringify(body) }, { type: "image", data: "Fictional non-text payload" }];
  const before = JSON.stringify(blocks);
  recorder.observe(event); recorder.observe(result(blocks)); await recorder.flush();
  const rows = await entries(output); expect(rows).toHaveLength(2);
  expect(rows[1].response.text).toBe(`${responseText}\n[non-text image block]`);
  expect(rows[1].response.text).not.toContain("Fictional non-text payload");
  expect(JSON.parse(rows[1].metadata.text)).toMatchObject({ status: "parsed", records: [{ recordId: "fictional-record" }] });
  expect(JSON.stringify(blocks)).toBe(before); expect(recorder.progressGap()).toBe(0);
});
it.each([null, {}, "fictional", 7])("treats non-array items %j as unparsed, not a capture gap", async items => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest();
  recorder.observe(call()); recorder.observe(result(JSON.stringify({ ...body, items }))); await recorder.flush();
  const rows = await entries(output); expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[1].metadata.text)).toEqual({ status: "unparsed" }); expect(recorder.progressGap()).toBe(0);
});
it("skips malformed records while preserving valid page ranks without a capture gap", async () => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest();
  recorder.observe(call()); recorder.observe(result(JSON.stringify({ ...body, items: [null, "fictional", 7, [], body.items[0]] })));
  recorder.observe(call("get")); recorder.observe(result(JSON.stringify({ action: "get", record: null }), "get")); await recorder.flush();
  const rows = await entries(output); expect(rows).toHaveLength(4);
  expect(JSON.parse(rows[1].metadata.text)).toMatchObject({ status: "parsed", records: [{ rank: 5, recordId: "fictional-record" }] });
  expect(JSON.parse(rows[3].metadata.text)).toMatchObject({ status: "parsed", records: [] }); expect(recorder.progressGap()).toBe(0);
});
it("shares the entry cap across begin calls and reports the overflow only once per run", async () => {
  const write = vi.spyOn(progress, "writeE2ProbeReceipt").mockResolvedValue(undefined);
  const { recorder } = await fixture();
  for (let i = 0; i < E2_PROBE_RECEIPT_LIMITS.entries; i++) {
    recorder.begin({ ...binding, itemOrdinal: i + 1 }); recorder.observeRequest(); recorder.observe(call());
  }
  recorder.begin({ ...binding, repeat: 1 }); recorder.observeRequest(); recorder.observe(call()); recorder.observe(call()); await recorder.flush();
  expect(write).toHaveBeenCalledTimes(E2_PROBE_RECEIPT_LIMITS.entries); expect(recorder.progressGap()).toBe(1);
});

it("parses the response body rather than inline tool-authored navigation arguments", async () => {
  const { output, recorder } = await fixture(); recorder.begin(binding); recorder.observeRequest();
  const text = `Read the complete record. Exact arguments: {"action":"get","recordId":"fictional-record"}\n${JSON.stringify(body, null, 2)}`;
  recorder.observe(call()); recorder.observe(result(text)); await recorder.flush();
  const [, row] = await entries(output);
  expect(row.response.text).toBe(text);
  expect(JSON.parse(row.metadata.text)).toMatchObject({ status: "parsed", action: "search", records: [{ recordId: "fictional-record" }] });
});
