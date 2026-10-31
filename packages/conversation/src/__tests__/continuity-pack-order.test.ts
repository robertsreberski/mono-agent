import { expect, it } from "vitest";
import { renderContinuityPack } from "../continuity/pack.js";
import { ledgerHash, type LedgerGeneration } from "../continuity/ledger.js";
import { fitsLedgerPrefix, PACK_HEADER } from "../continuity/render-fit.js";
import { CONTINUITY_REDACTION_OMISSION } from "../tool-history/continuity-payload.js";
import { bindContinuityQuotation } from "../tool-history/continuity-input.js";
import type { ContinuitySnapshot, ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";

// Fictional, letters-only pressure fixtures for ledger-aware owner selection.
const WORDS = ["garden", "lantern", "meadow", "harbor", "willow", "pebble", "orchard", "ribbon", "cedar", "marble", "thistle", "copper"];
const filler = (seed: number, words: number) => Array.from({ length: words }, (_, i) => WORDS[(seed * 7 + i * 5) % WORDS.length]).join(" ");
function owner(ordinal: number, text: string, recordId = `owner-${ordinal}`): ContinuitySnapshotRecord {
  const inputId = `input-${recordId}`;
  return { recordId, generationId: "gen", conversationId: "fictional", runId: `run-${recordId}`, inputId, kind: "owner", provenance: "host-owner", sequence: 0, ordinal,
    sha256: ledgerHash(text), originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), truncated: false, redacted: false,
    source: { attestation: { inputId, requestDigest: "digest" } }, untrusted: true, text };
}
function tool(ordinal: number, name: string, text: string): ContinuitySnapshotRecord {
  return { ...owner(ordinal, text, `tool-${ordinal}`), kind: "tool", provenance: "tool", inputId: undefined as never, source: {},
    tool: { name, state: "success", arguments: "{}", invocationId: `call-${ordinal}`, resultId: `result-${ordinal}` } };
}
/** Derived entries cite only the given record (by default a read tool), so no owner is quoted or demoted. */
function ledger(records: readonly ContinuitySnapshotRecord[], entries: number, valueWords: number, cite = records.find(r => r.kind === "tool")!, status = "unknown"): { generation: LedgerGeneration; records: readonly ContinuitySnapshotRecord[] } {
  const span = { id: "pcited", recordId: cite.recordId, sha256: cite.sha256, start: 0, end: Buffer.byteLength(cite.text), digest: ledgerHash(cite.text), owner: cite.kind === "owner", kind: cite.kind, ordinal: cite.ordinal };
  return { records, generation: { id: "generation", parent: null, conversationId: "fictional", logicalId: "fictional", manifest: "m", inputs: [], coveredOwners: [], uncovered: 0, spans: [span],
    entries: Array.from({ length: entries }, (_, i) => ({ kind: "artifact", value: `Fictional derived note ${WORDS[i % WORDS.length]} ${filler(i, valueWords)}`, status, sources: ["pcited"] })) } };
}
const ownerLine = (text: string) => `: ${JSON.stringify(text)}\n`;
const shownOwners = (text: string | undefined, records: readonly ContinuitySnapshotRecord[]) => records.filter(r => r.kind === "owner" && text?.includes(`Historical owner request id=${JSON.stringify(r.recordId)}`)).map(r => r.ordinal);

const EARLY = "Never share the guest list outside the planning circle.";
const LATE = "Correction: the picnic moves to the orchard, not the meadow.";
function displacementFixture() {
  // Heterogeneous owner sizes; everything fits without a ledger.
  const records: ContinuitySnapshotRecord[] = [owner(1, EARLY)];
  for (let i = 2; i < 48; i++) records.push(owner(i, `Planning note ${WORDS[i % WORDS.length]}: ${filler(i, 8 + (i * 13) % 50)}.`));
  records.push(tool(48, "mail_send", "Delivery report\n\nQueued for the planning circle."), tool(49, "read_calendar", "Calendar view\n\nNo conflicts found."));
  records.push(owner(50, LATE));
  return { records, snapshot: { records, omitted: 0, gaps: 0 } satisfies ContinuitySnapshot };
}

it("keeps the early owner rule AND the late owner correction the no-ledger pack shows, charging the ledger to middle history", () => {
  const { records, snapshot } = displacementFixture(), withLedger = ledger(records, 14, 70);
  const plain = renderContinuityPack(snapshot, []), pack = renderContinuityPack(snapshot, [], 8000, withLedger);
  expect(plain.text).toContain(ownerLine(LATE)); expect(shownOwners(plain.text, records)).toHaveLength(48); // genuine no-ledger backbone: every owner
  expect(pack.text).toBeTruthy(); expect(pack.ledgerEntries).toBe(14); expect(pack.toolReserved).toBeGreaterThan(0);
  expect(pack.text).toContain("### Continuity ledger"); expect(fitsLedgerPrefix(pack.text!.slice(PACK_HEADER.length, pack.text!.indexOf("Historical owner request")), 8000)).toBe(true);
  expect(pack.text).toContain(`Historical owner request id="owner-1" (past, not renewed approval)${ownerLine(EARLY)}`);
  expect(pack.text).toContain(`Historical owner request id="owner-50" (past, not renewed approval)${ownerLine(LATE)}`);
  const kept = shownOwners(pack.text, records);
  // Displacement is real and lands strictly inside the history, never at either end.
  expect(kept.length).toBeLessThan(48); expect(kept[0]).toBe(1); expect(kept.at(-1)).toBe(50);
  const missing = records.filter(r => r.kind === "owner" && !kept.includes(r.ordinal)).map(r => r.ordinal);
  expect(Math.min(...missing)).toBeGreaterThan(1); expect(Math.max(...missing)).toBeLessThan(50);
  expect(pack.tokens).toBeLessThanOrEqual(8000); expect(pack.text).toContain(`omitted=${missing.length}`);
  // Layout is unchanged: owner requests stay in host order before tool evidence; owner paragraphs are complete.
  const positions = kept.map(n => pack.text!.indexOf(`id="owner-${n}"`)); expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(pack.text!.indexOf("Tool evidence")).toBeGreaterThan(positions.at(-1)!);
  for (const n of kept) expect(pack.text).toContain(ownerLine(records.find(r => r.ordinal === n)!.text));
  expect(pack.text).toContain('name="mail_send"');
});

it("accepted limitation: a middle owner withdrawal the no-ledger pack shows can be dropped when the ledger cites none of it", () => {
  // Early permission, middle withdrawal pending confirmation, later unrelated notes; the
  // ledger interprets only a tool read. P4 keeps both ends; middle history pays.
  const records: ContinuitySnapshotRecord[] = [owner(1, "You may send the weekly report to the garden club.")];
  for (let i = 2; i < 24; i++) records.push(owner(i, `Earlier note ${WORDS[i % WORDS.length]}: ${filler(i, 40)}.`));
  const WITHDRAWAL = `Hold the weekly report; do not send it until the treasurer confirms the figures. ${filler(24, 44)}.`;
  records.push(owner(24, WITHDRAWAL));
  for (let i = 25; i < 48; i++) records.push(owner(i, `Unrelated note ${WORDS[i % WORDS.length]}: ${filler(i, 40)}.`));
  records.push(tool(48, "read_calendar", "Calendar view\n\nNo conflicts found."));
  const snapshot = { records, omitted: 0, gaps: 0 };
  const plain = renderContinuityPack(snapshot, []);
  expect(plain.text).toContain(ownerLine(WITHDRAWAL)); expect(shownOwners(plain.text, records)).toHaveLength(47);
  const pack = renderContinuityPack(snapshot, [], 8000, ledger(records, 14, 70));
  expect(pack.ledgerEntries).toBe(14); expect(pack.text).toContain(ownerLine(records[0]!.text)); expect(pack.text).toContain(ownerLine(records.at(-2)!.text));
  expect(pack.text).not.toContain(ownerLine(WITHDRAWAL)); // documented trade-off, not a guarantee
  expect(pack.text).toMatch(/omitted=[1-9]/u);
});

it("is deterministic for shuffled snapshots and equal ordinals", () => {
  const { records } = displacementFixture(), twins = [...records, owner(30, "Twin note about the willow fence.", "owner-30b")];
  const withLedger = ledger(twins, 14, 70), shuffled = [...twins].reverse();
  for (let i = 0; i < shuffled.length; i += 3) shuffled.push(shuffled.splice(i, 1)[0]!);
  const a = renderContinuityPack({ records: twins, omitted: 0, gaps: 0 }, [], 8000, withLedger);
  expect(renderContinuityPack({ records: shuffled, omitted: 0, gaps: 0 }, [], 8000, withLedger)).toEqual(a);
  expect(renderContinuityPack({ records: shuffled, omitted: 0, gaps: 0 }, [])).toEqual(renderContinuityPack({ records: twins, omitted: 0, gaps: 0 }, []));
});

it("keeps history dedup, ledger-quoted demotion, contentFreeRead and the headroom fallback in ledger packs", () => {
  const { records } = displacementFixture();
  const empty = tool(46, "read_vault", CONTINUITY_REDACTION_OMISSION);
  const all = [...records.filter(r => r.ordinal !== 46), empty];
  const replayed = { role: "user" as const, content: "Decorated replay of the second note." };
  bindContinuityQuotation(replayed, { inputId: "input-owner-2", requestDigest: "digest" });
  const active = ledger(all, 3, 10, all.find(r => r.ordinal === 3)!, "active");
  const pack = renderContinuityPack({ records: all, omitted: 0, gaps: 0 }, [replayed], 8000, active);
  expect(pack.ledgerEntries).toBe(3); expect(pack.ownerDeduped).toBe(1); expect(pack.text).not.toContain('id="owner-2"');
  expect(pack.text).toContain(`Historical owner paragraph (not renewed approval): ${JSON.stringify(all.find(r => r.ordinal === 3)!.text)}`);
  // The quoted owner stays demoted below every other section (it only backfills).
  expect(pack.text!.indexOf('Historical owner request id="owner-3"')).toBeGreaterThan(pack.text!.indexOf("Tool evidence"));
  expect(pack.text!.indexOf('Historical owner request id="owner-4"')).toBeLessThan(pack.text!.indexOf("Tool evidence"));
  expect(pack.text).not.toContain('name="read_vault"');
  expect(renderContinuityPack({ records: all, omitted: 0, gaps: 0 }, [], 0, active)).toMatchObject({ tokens: 0, degradedReason: "headroom", ledgerEntries: 0 });
});

it("renders no-ledger packs exactly as before and ignores an empty ledger", () => {
  const { records, snapshot } = displacementFixture();
  const plain = renderContinuityPack(snapshot, []);
  expect(renderContinuityPack(snapshot, [], 8000, { ...ledger(records, 1, 4), generation: { ...ledger(records, 1, 4).generation, entries: [] } })).toEqual(plain);
  expect(plain.text!.startsWith(PACK_HEADER + "Historical owner request")).toBe(true);
  expect(plain.ledgerEntries).toBe(0);
});

it("discloses an oversized ledger without admitting it, demoting owners or reordering owners", () => {
  const records = [owner(1, EARLY), owner(2, LATE), tool(3, "read_calendar", "Calendar view\n\nNo conflicts found.")];
  const huge = ledger(records, 60, 80, records[0]!, "active"), snapshot = { records, omitted: 0, gaps: 0 };
  const pack = renderContinuityPack(snapshot, [], 8000, huge), plain = renderContinuityPack(snapshot, []);
  expect(pack.ledgerEntries).toBe(0); expect(pack.text).not.toContain("### Continuity ledger");
  const disclosure = "Continuity ledger omitted: 60 derived entries exceed the ledger space; omission is not supersession.\n";
  expect(pack.text).toBe(PACK_HEADER + disclosure + plain.text!.slice(PACK_HEADER.length));
  expect(pack.counts).toEqual(plain.counts); expect(pack.degradedReason).toBe(plain.degradedReason);
  // The disclosure never creates a pack by itself.
  expect(renderContinuityPack({ records: [], omitted: 0, gaps: 0 }, [], 8000, huge)).toMatchObject({ tokens: 0, ledgerEntries: 0 });
  expect(renderContinuityPack({ records: [], omitted: 0, gaps: 0 }, [], 8000, huge).text).toBeUndefined();
});
