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
// Frozen from the pre-contract selector/fitter; no ranking or eligibility change.
const baseline = [
  {
    "upkeep": false,
    "inputTokens": 64000,
    "manifest": "0fe2091eb610ccfad5278502b56f145d10dc7bca465a3c590545f003cfe48bf0",
    "prompt": "8816bbc9af47ec47d50e693e82e8f8299bb3ba00fb6274ea7c6c04b218ccd05a",
    "count": 78,
    "fittedManifest": "e5a5b09f45002e9af50ad249505be8eff8ea8b3ff6fc5fa172a6acea8f54a0ed",
    "fittedPrompt": "51286d0d683c9bb752c2d1273d3c9e8b6821396b8d2029b38721c1b41d96be2c",
    "fittedCount": 32,
    "cap": 8
  },
  {
    "upkeep": false,
    "inputTokens": 128000,
    "manifest": "6061e517162654d06941e1025a594aa2e63ed63e996192774a86b18eccd6c489",
    "prompt": "79b978854229d8c4f08c69502868d886f8a37e82bb672edf83aebb541bbdac70",
    "count": 101,
    "fittedManifest": "617c5bb0d70f8e7d5d4f0f8a9edf72ba3f53983e360ec881cb22810f856d84fc",
    "fittedPrompt": "012fd52aca1077d67ef187025f047b531991288486a5bb74d8ce23a2b1aecf77",
    "fittedCount": 36,
    "cap": 8
  },
  {
    "upkeep": true,
    "inputTokens": 64000,
    "manifest": "8a884f40a7c14bc291d854c099e105ae835addbf6fa8209ec11fa86c1fa211ba",
    "prompt": "3c9083156bb47eda4560db6772e9275417e17e87203ef66908e747ae2d520c3f",
    "count": 39,
    "fittedManifest": "8a884f40a7c14bc291d854c099e105ae835addbf6fa8209ec11fa86c1fa211ba",
    "fittedPrompt": "4b61a7c58a5f7984d4f8d16d563765c19d47ea26d1bbf96cae355796084b8fa5",
    "fittedCount": 39,
    "cap": 8
  },
  {
    "upkeep": true,
    "inputTokens": 128000,
    "manifest": "cf6fc61983377c4833340b65c2bfc2e22173a34cb3a9609d85993b4c5e511d09",
    "prompt": "5ca8d2ef017082a8f6e387eb356ad25ee7e20ee3f3f105142478f4a73f4dc34e",
    "count": 64,
    "fittedManifest": "83390abcc770b168a1033df6390ee323daf9ca093b8d1d169d7bf2165c5f6da8",
    "fittedPrompt": "c4af7234a5215c7bfce2682d13fad6673a1d3595eba777b119c84264632b7de0",
    "fittedCount": 46,
    "cap": 8
  }
];
it.each([false, true])("keeps ordinary selection, fitting, prompts and manifests unchanged (upkeep=%s)", upkeep => {
  for (const inputTokens of [64000, 128000] as const) {
    const snapshot = { records, omitted: 0, gaps: 0, ...(upkeep ? { upkeep: { watermark: 80, excluded: [] } } : {}) };
    const selected = selectLedgerSources(snapshot, undefined, inputTokens);
    const fitted = fitLedgerSelection(selected, { currentConversationId: "fictional", logicalConversationId: "fictional" }, undefined, { maxTokens: 8000, deltaEntries: 8 });
    expect({ upkeep, inputTokens, manifest: selected.manifest, prompt: ledgerHash(selected.prompt), count: selected.spans.length, fittedManifest: fitted.selection.manifest, fittedPrompt: ledgerHash(fitted.selection.prompt), fittedCount: fitted.selection.spans.length, cap: fitted.selection.maxEntries }).toEqual(baseline.find(row => row.upkeep === upkeep && row.inputTokens === inputTokens));
  }
});
