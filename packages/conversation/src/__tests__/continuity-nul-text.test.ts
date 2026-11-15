import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";
import { progressSource } from "../continuity/frontier.js";
import { continuityRecordColumns } from "../tool-history/sqlite-text.js";
import { selectLedgerSources, validateLedgerOutput, type LedgerSelection } from "../continuity/ledger.js";

// node:sqlite in Node 24.15 (the supported floor) decoded TEXT result columns
// and user-function arguments only up to the first U+0000, although SQLite
// stores every byte. Retained text is arbitrary tool/user content, so every
// digest-checked read must round-trip embedded NULs on every supported Node.
const scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "current" };
const TEXT = "Morgan noted\u0000the cobalt plan.\u0000\u0000\n\nKeep the trailing evidence.";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
afterEach(async () => { for (const f of resources.splice(0)) { await f.writer.close(); await rm(f.root, { recursive: true, force: true }); } });

async function fixture(text = TEXT) {
  const root = await mkdtemp(join(tmpdir(), "continuity-nul-"));
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true, persistenceCeilingMs: 5000 });
  resources.push({ root, writer });
  const generationId = continuityGenerationId(), digest = sha256(generationId), inputId = `${generationId}-0`;
  const recordId = continuityRecordId("fictional", inputId);
  await writer.prepareContinuity({ generationId, conversationId: "fictional", logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
    records: [{ recordId, runId: generationId, inputId, kind: "owner", provenance: "host-owner", sequence: 0, text,
      source: { attestation: { inputId, requestDigest: digest } } }] });
  await writer.commitContinuity({ generationId, conversationId: "fictional", canonicalDigest: digest });
  return { writer, reader: new ToolHistoryReader(root), recordId };
}

describe("retained continuity text with embedded NUL characters", () => {
  it("stores every byte and returns the exact digest-matching text from each read path", async () => {
    const { reader, recordId } = await fixture();
    const db = new DatabaseSync(reader.databasePath, { readOnly: true });
    try {
      const stored = db.prepare("SELECT hex(retained_text) hex,text_sha256 FROM continuity_records WHERE record_id=?").get(recordId) as { hex: string; text_sha256: string };
      expect(stored).toEqual({ hex: Buffer.from(TEXT).toString("hex").toUpperCase(), text_sha256: sha256(TEXT) });
      const source = progressSource(db, "fictional", "fictional", 1, false);
      expect(source.retained_text).toBe(TEXT);
    } finally { db.close(); }

    expect(reader.getContinuity({ ...scope, recordId })).toMatchObject({ status: "available", chunk: TEXT, record: { sha256: sha256(TEXT) } });
    const snapshot = reader.snapshotContinuity(scope);
    expect(snapshot.degradedReason).toBeUndefined();
    expect(snapshot.records.map(record => record.text)).toEqual([TEXT]);
    const upkeep = reader.snapshotContinuity({ ...scope, selection: "upkeep" });
    expect(upkeep.degradedReason).toBeUndefined();
    expect(upkeep.records.map(record => record.text)).toEqual([TEXT]);
  });

  it("matches terms after a NUL in chronological and relevance search and discloses the full preview", async () => {
    const { reader, recordId } = await fixture();
    const chronological = reader.searchContinuity({ ...scope, query: "COBALT" });
    expect(chronological).toMatchObject({ available: true, items: [{ recordId, preview: TEXT }] });
    const relevance = reader.searchContinuity({ ...scope, query: "cobalt", mode: "relevance" });
    expect(relevance.degradedReason).toBeUndefined();
    expect(relevance.items.map(item => item.recordId)).toEqual([recordId]);
    expect(relevance.items[0]!.preview).toContain("cobalt");
  });

  it("publishes and re-reads a ledger whose source text contains NUL", async () => {
    const { writer, reader } = await fixture();
    const selection = selectLedgerSources(reader.snapshotContinuity(scope));
    const output = (s: LedgerSelection) => JSON.stringify({ entries: [{ kind: "open_work", value: "Derived fictional state.", status: "unknown", sources: [s.spans[0]!.id] }], covered: s.spans.map(span => span.id) });
    const generation = validateLedgerOutput(output(selection), selection, scope);
    await writer.publishLedger(generation);
    expect(reader.ledger(scope)?.records.map(record => record.text)).toEqual([TEXT]);
  });
  it("selects exactly the continuity_records columns that r.* would", async () => {
    const { reader } = await fixture();
    const db = new DatabaseSync(reader.databasePath, { readOnly: true });
    try {
      const columns = (db.prepare("PRAGMA table_info(continuity_records)").all() as { name: string }[]).map(column => column.name);
      expect(continuityRecordColumns().split(",").map(column => column.split(/[ .]/u).at(-1))).toEqual(columns);
    } finally { db.close(); }
  });
});
