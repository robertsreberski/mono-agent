import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  appendFactLines, deriveFactId, FACT_LEDGER_FILE, FACT_MARKER_FILE,
  MAX_FACT_LINE_BYTES, MAX_FACT_LEDGER_BYTES, parseFactLedger, readFactLedgerStrict, type FactClaim, type FactSource, type FactSupersede,
} from "../fact-ledger.js";
import { readBujoCanonicalSourceFingerprint } from "../replay-projection.js";
import { createBujoMemoryStore } from "../store.js";

function root(): string { return mkdtempSync(join(tmpdir(), "facts-ledger-")); }
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
function claim(overrides: Partial<FactClaim> = {}): FactClaim {
  const parts = {
    v: 1 as const, kind: "fact" as const, factId: "", runId: "run-1", candidateIndex: 0, factOrdinal: 0,
    entityId: "person:alice", key: "birth_date", value: { type: "date" as const, date: "2000-02-29" },
    attribution: "user-stated" as const, sourceMemoryId: "B-1", sourceTextSha256: hash("Alice was born on 2000-02-29."),
    recordedAt: "2026-09-24T12:00:00.000Z", ...overrides,
  };
  return { ...parts, factId: deriveFactId(parts) };
}
const wire = (line: unknown): string => `${JSON.stringify(line)}\n`;

function marker(rootPath: string, ledger: string): void {
  writeFileSync(join(rootPath, FACT_MARKER_FILE), JSON.stringify({ schemaVersion: 1,
    ledgerBytes: Buffer.byteLength(ledger), ledgerSha256: hash(ledger) }), { mode: 0o600 });
}

describe("strict canonical facts ledger", () => {
  it("preserves the byte-identical fingerprint of legacy trees without a ledger", () => {
    const path = root();
    expect(readFactLedgerStrict(path)).toMatchObject({ present: false, lines: [], bytes: 0, sha256: hash("") });
    expect(readBujoCanonicalSourceFingerprint(path)).toBe(hash(""));
    writeFileSync(join(path, "graph.jsonl"), "legacy-graph-bytes", { mode: 0o600 });
    const name = "graph.jsonl";
    expect(readBujoCanonicalSourceFingerprint(path)).toBe(hash(`${Buffer.byteLength(name)}\0${name}\0${Buffer.byteLength("legacy-graph-bytes")}\0legacy-graph-bytes`));
  });

  it("validates claims, independently attributable sources and correction history", () => {
    const first = claim();
    const corrected = claim({ runId: "run-corrected", value: { type: "date", date: "2001-02-28" } });
    const source: FactSource = { v: 1, kind: "fact-source", factId: first.factId, sourceMemoryId: "B-2",
      sourceTextSha256: hash("second source"), attribution: "document", recordedAt: "2026-09-24T12:00:00.000Z" };
    const edge: FactSupersede = { v: 1, kind: "fact-supersede", oldFactId: first.factId,
      newFactId: corrected.factId, at: "2026-09-24T12:00:00.000Z" };
    expect(parseFactLedger([first, corrected, source, edge].map(wire).join(""))).toEqual([first, corrected, source, edge]);
    expect(claim({ runId: "run-reverted" }).factId).not.toBe(first.factId);
    expect(() => parseFactLedger(wire({ ...first, candidateIndex: 1 }))).toThrow(/invalid factId/);
    expect(() => parseFactLedger(wire({ ...first, factOrdinal: 1 }))).toThrow(/invalid factId/);
    expect(() => parseFactLedger(wire(claim({ candidateIndex: 8 })))).toThrow(/invalid claim fields/);
    expect(() => parseFactLedger(wire(claim({ factOrdinal: 4 })))).toThrow(/invalid claim fields/);
    expect(() => parseFactLedger([first, claim({ sourceMemoryId: "B-other" })].map(wire).join("")))
      .toThrow(/candidate fact position/);
    expect(() => parseFactLedger(wire({ ...source, factId: hash("orphan") }))).toThrow(/invalid fact source/);
    expect(() => parseFactLedger([first, corrected, edge, { ...edge, oldFactId: corrected.factId, newFactId: first.factId }]
      .map(wire).join(""))).toThrow(/cycle/);
    const third = claim({ runId: "run-third", value: { type: "date", date: "2002-03-01" } });
    expect(() => parseFactLedger([first, corrected, third, edge,
      { ...edge, oldFactId: third.factId }].map(wire).join(""))).toThrow(/orphan or divergent supersession/);
    expect(() => parseFactLedger([first, corrected, source, { ...source, attribution: "unknown" }]
      .map(wire).join(""))).toThrow(/divergent source/);
    expect(() => parseFactLedger([first, { ...first, value: { type: "date", date: "2001-01-01" } }]
      .map(wire).join(""))).toThrow(/invalid factId/);
  });

  it("rejects bounds, invalid encodings, unknown fields/kinds, dates and JSON duplicates", () => {
    const item = claim();
    for (const invalid of [wire({ ...item, v: 2 }), wire({ ...item, extra: 1 }),
      wire({ ...item, kind: "alias" }), wire({ ...item, attribution: "first-party" }),
      wire({ ...item, value: { type: "date", date: "2001-02-29" } }),
      wire({ ...item, key: "other:bad-" }), wire({ ...item, qualifier: " hello" }),
      wire({ ...item, recordedAt: "2026-09-24" }), wire({ ...item, validFrom: "2026-12-01", validTo: "2026-01-01" }),
      `${JSON.stringify(item).slice(0, -1)},"kind":"fact"}\n`, `${JSON.stringify(item)} `,
      JSON.stringify(item), `${" ".repeat(MAX_FACT_LINE_BYTES)}\n`]) {
      expect(() => parseFactLedger(invalid)).toThrow();
    }
    expect(() => parseFactLedger(" ".repeat(MAX_FACT_LEDGER_BYTES + 1))).toThrow(/byte limit/);
    const path = root();
    writeFileSync(join(path, FACT_LEDGER_FILE), Buffer.from([0xff, 0x0a]), { mode: 0o600 });
    marker(path, "\ufffd\n");
    expect(() => readFactLedgerStrict(path)).toThrow();
  });

  it("opens a legacy store with zero facts and blocks unsupported nonempty ledgers", async () => {
    const path = root();
    const store = createBujoMemoryStore({ root: path, tier: "lite" });
    await store.close();
    const oldFingerprint = readBujoCanonicalSourceFingerprint(path);
    expect(readFactLedgerStrict(path).lines).toEqual([]);
    expect(readBujoCanonicalSourceFingerprint(path)).toBe(oldFingerprint);
    appendFactLines(path, [claim()]);
    expect(() => createBujoMemoryStore({ root: path, tier: "lite" })).toThrow(/requires BuJo fact projection/);
  });

  it("fails closed on orphan marker, orphan ledger, extra/truncated bytes and symlinks", () => {
    const first = claim();
    const path = root();
    const ledger = wire(first);
    marker(path, ledger);
    expect(() => readFactLedgerStrict(path)).toThrow(/not both present/);
    writeFileSync(join(path, FACT_LEDGER_FILE), ledger, { mode: 0o600 });
    expect(readFactLedgerStrict(path).lines).toEqual([first]);
    appendFileSync(join(path, FACT_LEDGER_FILE), " ");
    expect(() => readFactLedgerStrict(path)).toThrow(/do not match/);
    expect(() => createBujoMemoryStore({ root: path, tier: "lite" })).toThrow(/marker/);
    writeFileSync(join(path, FACT_LEDGER_FILE), ledger.slice(0, -2));
    expect(() => readFactLedgerStrict(path)).toThrow(/do not match/);
  });

  it("appends and fsyncs before marker rename, failing safely if interrupted at either boundary", () => {
    const path = root();
    const first = claim();
    const second = claim({ runId: "run-2" });
    expect(() => appendFactLines(path, [first], { afterLedgerAppend: () => { throw new Error("crash-before-marker"); } }))
      .toThrow(/crash-before-marker/);
    expect(() => readFactLedgerStrict(path)).toThrow(/not both present/);
    const recovered = root();
    expect(() => appendFactLines(recovered, [first], { afterMarkerRename: () => { throw new Error("crash-after-marker"); } }))
      .toThrow(/crash-after-marker/);
    const stable = readFactLedgerStrict(recovered);
    expect(stable.lines).toEqual([first]);
    expect(appendFactLines(recovered, [first])).toEqual(stable);
    const pending = root();
    appendFactLines(pending, [first]);
    expect(() => appendFactLines(pending, [second], { afterLedgerAppend: () => { throw new Error("crash-after-second-append"); } }))
      .toThrow(/crash-after-second-append/);
    expect(() => readFactLedgerStrict(pending)).toThrow(/do not match/);
    const next = appendFactLines(recovered, [second]);
    expect(next.lines).toEqual([first, second]);
    expect(next.bytes).toBe(Buffer.byteLength(wire(first) + wire(second)));
    expect(readFileSync(join(recovered, FACT_MARKER_FILE), "utf8")).toContain(next.sha256);
    expect(readBujoCanonicalSourceFingerprint(recovered)).not.toBe(hash(""));
  });
});
