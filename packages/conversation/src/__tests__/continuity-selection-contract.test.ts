import { renderContinuityPack } from "../continuity/pack.js";
import { expect, it } from "vitest";
import { ledgerHash, selectLedgerSources, fitLedgerSelection } from "../continuity/ledger.js";
import { continuityRecordId } from "../tool-history/continuity-storage.js";
import type { ContinuitySnapshotRecord } from "../tool-history/continuity-contracts.js";

const records: ContinuitySnapshotRecord[] = Array.from({ length: 80 }, (_, i) => {
  const kind = i % 4 === 0 ? "owner" : i % 4 === 1 ? "tool" : "user";
  const text = kind === "owner" ? "Never repeat actions without approval.\n\nUse the team mailbox."
    : kind === "tool" ? "Header DEMO-7.\n\n" + "Ω notes ".repeat(2200) + "\n\nRequest pending." : "Neutral archival text.";
  return { recordId: continuityRecordId("fictional", `record-${i}`), generationId: "fixture", conversationId: "fictional", runId: "past", inputId: `input-${i}`,
    kind, provenance: kind === "owner" ? "host-owner" : kind === "tool" ? "tool" : "unknown", ordinal: i + 1, sequence: i,
    sha256: ledgerHash(text), text, source: kind === "owner" ? { attestation: { inputId: `input-${i}`, requestDigest: "a".repeat(64) } } : {},
    originalBytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), redacted: false, truncated: false, untrusted: true,
    ...(kind === "tool" ? { tool: { name: "read_notes", state: "success", arguments: "{}", invocationId: `call-${i}` } } : {}) };
});
// The disabled deterministic pack is the unchanged legacy surface. The enabled
// extractor intentionally has a new clean, generic-ranked baseline in this PR.
it.each([4000, 8000])("keeps the disabled deterministic pack frozen (headroom=%s)", maxTokens => {
  const pack = renderContinuityPack({ records, omitted: 0, gaps: 0 }, [], maxTokens);
  expect({ hash: ledgerHash(pack.text ?? ""), tokens: pack.tokens, counts: pack.counts, omitted: pack.omitted }).toMatchSnapshot();
});
it.each([64000, 128000] as const)("freezes clean ranked selection and bounded greedy fitting (input=%s)", inputTokens => {
  const snapshot = { records, omitted: 0, gaps: 0, upkeep: { watermark: 80, excluded: [] } };
  const selected = selectLedgerSources(snapshot, undefined, inputTokens);
  const fitted = fitLedgerSelection(selected, { currentConversationId: "fictional", logicalConversationId: "fictional" }, undefined, { maxTokens: 8000, deltaEntries: 8 }).selection;
  expect({ sourceManifest: selected.manifest, fittedManifest: fitted.manifest, prompt: ledgerHash(fitted.prompt), count: fitted.spans.length, cap: fitted.maxEntries }).toMatchSnapshot();
  expect(fitted.spans.length).toBeLessThanOrEqual(8 * fitted.maxEntries!);
  expect((Math.ceil(Buffer.byteLength(fitted.prompt) / 2) + 16) * 1.25).toBeLessThanOrEqual(inputTokens - 2048);
});

it("pins the compact extraction contract without changing schema or caps", () => {
  const { prompt } = selectLedgerSources({ records: [], omitted: 0, gaps: 0 });
  for (const clause of [
    "never restate unchanged prior entries. Changed state is a new fact",
    "Preserve explicit cancellation, rejection and completion",
    "artifact transitions (approve, void, file, send)",
    "Distinguish suggestion, agreement, obligation, report and verified outcome",
    "never promote an unagreed suggestion",
    "Keep prose concise and self-contained",
    "Keep each identifier tied to its role in cited context; never substitute a nearby identifier",
    "Reconcile earlier and later retained evidence by source order even when discovered in reverse extraction-pass order",
  ]) expect(prompt).toContain(clause);
});
