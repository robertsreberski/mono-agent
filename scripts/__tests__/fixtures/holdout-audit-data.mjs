// Synthetic native-shaped audit material. No provider, auth or genuine corpus access.
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ledgerHash, spanKey, normalizeLedger } from "../../../packages/conversation/dist/continuity/ledger.js";
// Live controller polling can briefly hold a reader lock during fixture publication.
export function fixtureDatabase(path) {
  const db = new DatabaseSync(path); db.exec("PRAGMA busy_timeout=5000"); return db;
}
export async function auditCheckpoint(output, traceId, repeat) {
  const scope = `synthetic-${traceId}-r${repeat}`, directory = join(output, `work/cp-${traceId}_ledger-continuity-ledger-cold-r${repeat}/work/history/tool-history`);
  await mkdir(directory, { recursive: true }); await mkdir(join(output, "upkeep-output"), { recursive: true });
  const texts = ["Please inspect the fictional component.", "Fictional ticket SYNTH-42 still awaits component inspection."];
  const spans = texts.map((text, i) => ({ id: `s${i}`, recordId: `record-${i}`, ordinal: i + 1, sha256: ledgerHash(text), digest: ledgerHash(text), start: 0, end: Buffer.byteLength(text), owner: i === 0, kind: i === 0 ? "owner" : "tool" }));
  const first = { id: "entry-a", kind: "artifact", value: "Inspection request for the fictional component.", status: "unknown", sources: ["s0"], decisionRelabelled: true, outcomeUnverified: true };
  const generation = (id, parent, full) => normalizeLedger({ id, parent, conversationId: scope, logicalId: scope,
    manifest: ledgerHash(JSON.stringify(full ? spans : spans.slice(0, 1))), inputs: (full ? spans : spans.slice(0, 1)).map(s => ({ recordId: s.recordId, sha256: s.sha256 })),
    spans: full ? spans : spans.slice(0, 1), coveredSpans: [], coveredOwners: ["s0"], uncovered: 0,
    entries: [first, ...(full ? [{ id: "entry-b", kind: "artifact", value: "The fictional component has an inspection request.", status: "unknown", sources: ["s0"] },
      { id: "entry-c", kind: "identifier", value: "SYNTH-42", status: "unknown", sources: ["s1"] }] : [])] });
  const initial = generation(`${scope}-generation-1`, null, false), final = generation(`${scope}-generation-3`, initial.id, true);
  const receipts = Array.from({ length: 3 }, (_, i) => ({ operationId: `operation-${i}`, providerInvoked: true,
    status: i === 1 ? "skipped" : "valid", reason: i === 1 ? "output_overrun" : "completed",
    ...(i !== 1 ? { generationId: i === 0 ? initial.id : final.id } : { outputOverrun: true }),
    decisionRelabels: i === 0 ? 1 : 0, outcomeDowngrades: i === 0 ? 1 : 0,
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 }));
  const db = fixtureDatabase(join(directory, "tool-lifecycles.sqlite"));
  db.exec(`CREATE TABLE continuity_generations(generation_id TEXT,conversation_id TEXT,logical_id TEXT,state TEXT);
    CREATE TABLE continuity_records(record_id TEXT,generation_id TEXT,run_id TEXT,input_id TEXT,kind TEXT,provenance TEXT,source_json TEXT,ordinal INTEGER,seq INTEGER,retained_text TEXT,text_sha256 TEXT,finalized INTEGER);
    CREATE TABLE tool_calls(run_id TEXT,tool_call_id TEXT,tool_name TEXT,conversation_id TEXT);
    CREATE TABLE continuity_ledger(conversation_id TEXT,logical_id TEXT,payload TEXT,payload_sha256 TEXT);
    CREATE TABLE continuity_upkeep_operations(operation_id TEXT,reservation TEXT,outcome TEXT,state TEXT)`);
  db.prepare("INSERT INTO continuity_generations VALUES (?,?,?,?)").run("sources", scope, scope, "committed");
  db.prepare("INSERT INTO tool_calls VALUES (?,?,?,?)").run("run", "call", "synthetic_fetch", scope);
  for (let i = 0; i < texts.length; i++) db.prepare("INSERT INTO continuity_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(`record-${i}`, "sources", "run", i === 0 ? "input" : null,
    i === 0 ? "owner" : "tool", i === 0 ? "host-owner" : "tool", JSON.stringify(i === 0 ? { attestation: { inputId: "input", requestDigest: ledgerHash(texts[i]) } } : { operationId: `tool:${ledgerHash(JSON.stringify([scope, "run", "call"]))}` }),
    i + 1, i + 1, texts[i], ledgerHash(texts[i]), 1);
  db.prepare("INSERT INTO continuity_ledger VALUES (?,?,?,?)").run(scope, scope, JSON.stringify(final), ledgerHash(JSON.stringify(final)));
  for (const [i, receipt] of receipts.entries()) db.prepare("INSERT INTO continuity_upkeep_operations VALUES (?,?,?,?)").run(receipt.operationId, JSON.stringify({ budget: i === 0 ? "bootstrap" : "incremental" }), JSON.stringify({ ...receipt, generationId: undefined }), "terminal");
  db.close();
  for (let i = 0; i < 3; i++) await writeFile(join(output, "upkeep-output", `r${repeat}-${traceId}-p${i + 1}.json`), JSON.stringify({ status: receipts[i].status, ledger: i === 2 ? final : initial }));
  const steps = receipts.map((receipt, i) => {
    const rows = receipts.slice(0, i + 1).map((r, j) => ({ operationId: r.operationId, budget: j === 0 ? "bootstrap" : "incremental", state: "terminal", selection: [spanKey(spans[j % 2])] }));
    return { pid: i + 1, valid: true, preserved: true, boundary: { verified: true }, receipt,
      journal: { rows, operations: rows.length, bootstrap: 1, reserved: 0, released: 0, operationId: receipt.operationId, budget: i === 0 ? "bootstrap" : "incremental", state: "terminal" } };
  });
  return { conversationId: scope, upkeep: { valid: true, expectedEntries: final.entries.length, preparations: steps } };
}
