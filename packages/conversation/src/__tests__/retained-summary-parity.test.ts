import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderContinuityPack, type ContinuityPack } from "../continuity/pack.js";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";
import type { LedgerGeneration } from "../continuity/ledger.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function record(ordinal: number, text: string, kind: ContinuitySnapshotRecord["kind"]): ContinuitySnapshotRecord {
  return { recordId: `fiction-${ordinal}`, generationId: "fiction-generation", conversationId: "fiction", runId: `run-${ordinal}`,
    inputId: `input-${ordinal}`, kind, sequence: 0, ordinal, sha256: hash(text), originalBytes: Buffer.byteLength(text),
    retainedBytes: Buffer.byteLength(text), redacted: false, truncated: false, provenance: kind === "owner" ? "host-owner" : "generated",
    source: { attestation: { inputId: `input-${ordinal}`, requestDigest: hash("request") } }, untrusted: true, text };
}
const summary = record(1, "Morgan chose <cobalt> 🦊. ".repeat(70), "summary");
const owners = Array.from({ length: 32 }, (_, i) => record(i + 2, `Fictional rule ${i}: do not send. `.repeat(10), "owner"));
const tools = Array.from({ length: 24 }, (_, i) => ({ ...record(i + 40, "Fictional completed result.\n\n".repeat(30), "tool"),
  tool: { name: i % 2 ? "mail_send" : "mail_read", state: "success", arguments: '{"draft":"DRAFT-42"}', invocationId: `invocation-${i}` } }));
const ledger: LedgerGeneration = { id: "fiction-ledger", parent: null, conversationId: "fiction", logicalId: "fiction", manifest: "fixture",
  inputs: [], spans: [], coveredOwners: [], uncovered: 0, entries: [{ kind: "artifact", value: "Derived fictional detail. ".repeat(8), status: "unknown", sources: [] }] };

// Baseline fingerprints cover every pre-existing return field, including exact
// text, order, reservations, tokens and rendered tool identities. Captured from
// the unchanged renderer, not a new implementation of its selection algorithm.
function legacy(pack: ContinuityPack) {
  const { summarySelection: _selection, toolRecordIds, ...rest } = pack;
  return { ...rest, ...(toolRecordIds ? { toolRecordIds: [...toolRecordIds] } : {}) };
}
it.each([
  ["no-summary", [...owners, ...tools], "c060983c63d3ea572ad0130786464d84b769f55271a4aca0fd539f3c27923110"],
  ["summary", [summary, ...owners, ...tools], "c0783055e1b264ba0d53ab4ca2330ba16f6cb8c00b1ae98bbfbfc112e1f07166"],
  ["empty", [], "0049612bfb60a721956604bf4751c0dab27f083f2ad17c9f9679729e8f8916bd"],
] as const)("keeps baseline pack bytes and all selection/budget accounting: %s", (_name, records, expected) => {
  const results = [];
  for (const budget of [0, 499, 500, 700, 1200, 1600, 8000, 9000]) {
    for (const guidance of [false, true]) for (const withLedger of [false, true]) {
      const snapshot = { records, omitted: 0, gaps: 0 };
      const pack = renderContinuityPack(snapshot, [], budget, withLedger ? { generation: ledger, records } : undefined, false, guidance);
      results.push(legacy(pack));
    }
  }
  expect(hash(JSON.stringify(results))).toBe(expected);
});
