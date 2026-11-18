import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { renderContinuityPack, type ContinuityPack } from "../continuity/pack.js";
import { CONTINUITY_PACK_MAX_TOKENS, packTokens } from "../continuity/render-fit.js";
import { quote } from "../continuity/ledger.js";
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

// Current scoped History baseline: exact text, counts, tokens and record ids.
// Guidance and its byte accounting were rebaselined at the hard cutover.
function legacy(pack: ContinuityPack) {
  const { summarySelection: _selection, toolRecordIds, ...rest } = pack;
  return { ...rest, ...(toolRecordIds ? { toolRecordIds: [...toolRecordIds] } : {}) };
}
it.each([
  ["no-summary", [...owners, ...tools], "a92080dd7688b86276d57a8f8ca8924dadb4381f6286d0adb9bdb9cba16890cc"],
  ["summary", [summary, ...owners, ...tools], "2bbfbabfb9bf02be100afa49dbefc16fb11c0e3130ae3ca221da149e6737f5ce"],
  ["empty", [], "9a92695c44660dd7c21004b6f24583e8edabc5ac9d65179bbfb3277afcd50723"],
] as const)("pins current History pack bytes and all selection/budget accounting: %s", (_name, records, expected) => {
  const results = [], layouts = [];
  for (const budget of [0, 499, 500, 700, 1200, 1600, 8000, 9000]) {
    for (const guidance of [false, true]) for (const withLedger of [false, true]) {
      const snapshot = { records, omitted: 0, gaps: 0 };
      // Keep the historical 8k budget grid, rebaselined for scoped guidance.
      const pack = renderContinuityPack(snapshot, [], Math.min(budget, 8000), withLedger ? { generation: ledger, records } : undefined, false, { said: guidance, tools: false, runs: false });
      results.push(legacy(pack));
      layouts.push({ budget, guidance, withLedger, pack: legacy(pack) });
    }
  }
  expect(hash(JSON.stringify(results))).toBe(expected); // Current History guidance baseline; no change to stored evidence.
  expect(layouts).toMatchSnapshot(); // Byte-exact, with the differing layout/field visible.
});

it.each([
  ["no-summary", [...owners, ...tools]],
  ["summary", [summary, ...owners, ...tools]],
] as const)("raises only the ceiling above 8k, keeping whole entries, the 220-token marker reserve and the ledger prefix: %s", (_name, records) => {
  // Enough crowding to fill even the larger ceiling.
  const crowded = [...records, ...Array.from({ length: 96 }, (_, i) => record(i + 100, `Fictional later rule ${i}: keep cobalt. `.repeat(12), "owner"))];
  const snapshot = { records: crowded, omitted: 0, gaps: 0 };
  const at = (budget: number) => renderContinuityPack(snapshot, [], budget, { generation: ledger, records: crowded }, false, { said: true, tools: false, runs: false });
  const legacyCeiling = at(8000), raised = at(9000), ceiling = at(CONTINUITY_PACK_MAX_TOKENS);
  expect(CONTINUITY_PACK_MAX_TOKENS).toBe(16000);
  expect(legacyCeiling.tokens).toBeLessThanOrEqual(8000); expect(raised.tokens).toBeGreaterThan(8000); expect(raised.tokens).toBeLessThanOrEqual(9000);
  expect(ceiling.tokens).toBeGreaterThan(9000); expect(ceiling.tokens).toBeLessThanOrEqual(16000);
  expect(Buffer.byteLength(ceiling.text!)).toBeLessThanOrEqual(47952);
  // Default, explicit ceiling, any larger request and non-finite overrides all clamp to the same rendering.
  for (const budget of [16001, 32000, 1e9, Number.POSITIVE_INFINITY]) expect(at(budget)).toEqual(ceiling);
  expect(renderContinuityPack(snapshot, [], undefined, { generation: ledger, records: crowded }, false, { said: true, tools: false, runs: false })).toEqual(ceiling);
  for (const [budget, pack] of [[8000, legacyCeiling], [9000, raised], [16000, ceiling]] as const) {
    expect(pack.ledgerEntries).toBe(1); expect(pack.omitted).toBeGreaterThan(0);
    const body = pack.text!.slice(0, pack.text!.indexOf("Coverage: physical-bucket"));
    expect(packTokens(body) + 220).toBeLessThanOrEqual(budget);
    // Only complete JSON-quoted owner entries are rendered, never fragments.
    for (const line of pack.text!.split("\n").filter(line => line.startsWith("Historical owner request"))) {
      expect(crowded.some(r => line.endsWith(`: ${quote(r.text)}`))).toBe(true);
    }
  }
  expect(ceiling.counts.owner + ceiling.counts.tool).toBeGreaterThan(legacyCeiling.counts.owner + legacyCeiling.counts.tool);
  expect(ceiling.toolReserved).toBeGreaterThanOrEqual(legacyCeiling.toolReserved);
  // Pin the new layouts compactly: accounting plus exact text digest.
  expect([legacyCeiling, raised, ceiling].map(({ text, toolRecordIds, summarySelection: _s, ...rest }) => ({ ...rest, textSha256: hash(text!), tools: toolRecordIds?.size }))).toMatchSnapshot();
});
