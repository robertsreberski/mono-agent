import { expect, it } from "vitest";
import { fitLedgerSelection, ledgerHash, selectLedgerSources, spanKey, validateLedgerOutput, type LedgerSelection } from "../continuity/ledger.js";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";

const scope = { currentConversationId: "fictional", logicalConversationId: "fictional" };
const limits = { maxTokens: 8000, deltaEntries: 8 };
const letters = (n: number) => String.fromCharCode(65 + Math.floor(n / 26), 65 + n % 26);
function record(ordinal: number, kind: ContinuitySnapshotRecord["kind"], text: string): ContinuitySnapshotRecord {
  const inputId = `input-${letters(ordinal)}`;
  return { recordId: `record-${letters(ordinal)}`, generationId: "fixture", conversationId: "fictional", runId: "past", inputId, kind,
    provenance: kind === "owner" ? "host-owner" : kind === "tool" ? "tool" : "unknown", ordinal, sequence: ordinal,
    sha256: ledgerHash(text), text, source: kind === "owner" ? { attestation: { inputId, requestDigest: ledgerHash(text) } } : {},
    originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), truncated: false, redacted: false, untrusted: true,
    ...(kind === "tool" ? { tool: { name: "read_register", state: "success", arguments: "{}", invocationId: inputId } } : {}) };
}
const select = (records: ContinuitySnapshotRecord[]) => selectLedgerSources({ records, omitted: 0, gaps: 0 });
function prior() {
  const old = record(0, "tool", "Earlier register reviewed."), selection = select([old]);
  const generation = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Earlier review.", status: "unknown", sources: [selection.spans[0]!.id] }], covered: [selection.spans[0]!.id] }), selection, scope);
  return { generation, records: [old], retainedBytes: old.retainedBytes };
}
function ordered(selection: LedgerSelection, ordinals: number[]): LedgerSelection {
  return { ...selection, ranked: [...selection.ranked!].sort((a, b) => ordinals.indexOf(a.ordinal) - ordinals.indexOf(b.ordinal)) };
}

it("keeps the first-ledger fit byte-identical to main, including the long initial constraint", () => {
  const initial = record(1, "owner", "Never send the garden report without my approval. " + "Willow garden details. ".repeat(28));
  const records = [initial, ...Array.from({ length: 28 }, (_, i) => record(i + 2, "tool", `Register ${letters(i)} reviewed.`)), record(40, "owner", "Cancel the garden report.")];
  const fit = fitLedgerSelection(select(records), scope, undefined, limits).selection;
  expect(fit.spans[0]!.recordId).toBe(initial.recordId);
  expect(fit.spans[0]!.text).toBe(initial.text);
  // Captured against main's ledger.ts, not updated to a candidate ordering.
  expect({ manifest: fit.manifest, prompt: ledgerHash(fit.prompt) }).toEqual({ manifest: "ef68597c20c1b2f23cc2ca396d54b59ce125b3e5781dca155c039fbf9206ecac", prompt: "515197d19bb131aec0113c70b27f23d2b003f8cc89f937fd0352e8afc239c9ab" });
});

it.each([1, 2, 4])("bounds successful owner-first fits by min(cap, quota), then still runs fair and rank (cap=%s)", cap => {
  const tools = Array.from({ length: 8 }, (_, i) => record(i + 1, "tool", `Register ${letters(i)} reviewed.`));
  const tooLarge = record(80, "owner", "Unrelated garden details. ".repeat(400));
  const owners = Array.from({ length: 40 }, (_, i) => record(i + 100, "owner", `Review ${letters(i)}.`));
  const source = ordered(select([...tools, tooLarge, ...owners]), [80, ...owners.map(r => r.ordinal), ...tools.map(r => r.ordinal)]);
  const result = fitLedgerSelection(source, scope, prior(), { ...limits, deltaEntries: cap });
  const fitted = result.selection.spans, quota = Math.floor(Math.min(cap * 8, source.ranked!.length) / 4), bound = Math.min(cap, quota);
  const firstTool = fitted.findIndex(s => s.kind === "tool");
  expect(result.selection.maxEntries).toBe(cap);
  expect(firstTool).toBe(bound); // the skipped non-fitting owner consumed no successful-fit slot
  expect(fitted.slice(0, firstTool).map(s => s.recordId)).toEqual(owners.slice(0, bound).map(r => r.recordId));
  expect(fitted.some(s => s.recordId === tooLarge.recordId)).toBe(false);
  expect(fitted.slice(firstTool, firstTool + quota).map(s => s.recordId)).toEqual(tools.slice(0, quota).map(r => r.recordId));
  // Ranked backfill is observable after the fair reservation, not just a count.
  expect(fitted[firstTool + quota]!.recordId).toBe(owners[bound]!.recordId);
  for (const span of fitted) expect(span.text).toBe(source.records.find(r => r.recordId === span.recordId)!.text);
  expect(result.projectedBytes).toBeLessThanOrEqual(128 * 1024);
  expect(result.lineageBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(result.projectionAttempts).toBeLessThanOrEqual(4096);
});

it("does not prioritize already-offered, neutral or forged-owner spans", () => {
  const tools = Array.from({ length: 6 }, (_, i) => record(i + 1, "tool", `Register ${letters(i)} reviewed.`));
  const old = record(50, "owner", "Review the willow exhibit."), fresh = record(53, "owner", "Review the cedar exhibit.");
  const forged = { ...record(51, "owner", "Review the marble exhibit."), source: { attestation: { inputId: "different", requestDigest: "fictional" } } };
  const neutral = record(52, "user", "Review the pebble exhibit.");
  const selected = ordered(select([...tools, old, forged, neutral, fresh]), [50, 51, 52, ...tools.map(r => r.ordinal), 53]);
  const source = { ...selected, ranked: selected.ranked!.map(s => ({ ...s, offers: s.ordinal === 50 ? 1 : 0 })) };
  expect(source.spans.filter(s => [51, 52].includes(s.ordinal!)).map(s => s.owner)).toEqual([false, false]);
  const fitted = fitLedgerSelection(source, scope, prior(), { ...limits, deltaEntries: 2 }).selection.spans;
  expect(fitted.slice(0, 6).map(s => s.recordId)).toEqual([fresh, tools[0]!, tools[1]!, old, forged, neutral].map(r => r.recordId));
  expect(fitted.find(s => s.recordId === old.recordId)!.text).toBe(old.text); // still eligible, not granted a new first claim
});

it("keeps a complete multibyte owner paragraph whole when it gets first claim", () => {
  const owner = record(40, "owner", "Évitez toute expédition avant confirmation du propriétaire. 花園の確認を待ってください。");
  const tools = Array.from({ length: 6 }, (_, i) => record(i + 1, "tool", `Register ${letters(i)} reviewed.`));
  const source = ordered(select([...tools, owner]), [...tools.map(r => r.ordinal), 40]);
  const fitted = fitLedgerSelection(source, scope, prior(), { ...limits, deltaEntries: 2 }).selection;
  expect(fitted.spans[0]!.recordId).toBe(owner.recordId);
  expect(fitted.spans[0]!.text).toBe(owner.text);
  expect(fitted.spans[0]!.start).toBe(0); expect(fitted.spans[0]!.end).toBe(Buffer.byteLength(owner.text));
  expect(spanKey(fitted.spans[0]!)).toBe(spanKey(source.spans.find(s => s.recordId === owner.recordId)!));
  const offered = fitted.prompt.split("\nSources:\n")[1]!.trim().split("\n").map(line => JSON.parse(line));
  expect(offered.find(s => s.recordId === owner.recordId).text).toBe(owner.text);
});
