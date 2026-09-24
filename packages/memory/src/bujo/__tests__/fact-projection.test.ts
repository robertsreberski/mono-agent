import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";

import { openMemoryDb } from "../../store/index.js";
import { rewriteBullet } from "../daily.js";
import { rootFingerprint } from "../durable-root-swap.js";
import { applyExplicitMemoryForget, restoreExplicitMemoryForget } from "../explicit-forget.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { createBujoMemoryStore } from "../store.js";
import { appendFactLines, deriveFactId, FACT_LEDGER_FILE, FACT_MARKER_FILE, readFactLedgerStrict, type FactClaim, type FactSource, type FactSupersede } from "../fact-ledger.js";
import { readManagedIndexManifest, resolveActiveMemoryDbPath } from "../generations.js";
import { rollbackMemoryIndex, safeRebuildMemoryIndex } from "../rebuild.js";
import { readBujoCanonicalSourceFingerprint } from "../replay-projection.js";
import { cleanupBujoFixtures, createBujoFixture } from "./bundle-fixtures.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const FIRST = "Alice was born on 2000-02-29.";
const SECOND = "Alice's birth date is 2000-02-29.";
const OTHER = "Alice was born on 2001-02-28.";

function claim(id: string, text: string, date: string, runId: string): FactClaim {
  const parts = { v: 1 as const, kind: "fact" as const, runId, candidateIndex: 0, factOrdinal: 0,
    entityId: "person:alice", key: "birth_date", value: { type: "date" as const, date },
    attribution: "user-stated" as const, sourceMemoryId: id, sourceTextSha256: hash(text),
    recordedAt: "2026-09-24T00:00:00.000Z" };
  return { ...parts, factId: deriveFactId(parts) };
}

afterEach(cleanupBujoFixtures);

describe("offline typed fact projection", () => {
  it("opens pre-facts managed BuJo generations read-only and writable without changing their fingerprint", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-pre-upgrade", bullets: [{ id: "B-1", text: FIRST }] });
    const fingerprint = readBujoCanonicalSourceFingerprint(fixture.root);
    const raw = new BetterSqlite3(resolveActiveMemoryDbPath(fixture.root));
    try { raw.exec("DROP TABLE entity_fact_supersedes; DROP TABLE entity_fact_sources; DROP TABLE entity_facts"); }
    finally { raw.close(); }
    const readOnly = createBujoMemoryStore({ root: fixture.root, tier: "bujo", readOnly: true,
      embeddings: fixture.embeddings, dim: fixture.dim });
    await readOnly.close();
    expect(readBujoCanonicalSourceFingerprint(fixture.root)).toBe(fingerprint);
    const writable = createBujoMemoryStore({ root: fixture.root, tier: "bujo",
      embeddings: fixture.embeddings, dim: fixture.dim,
      llm: { id: "must-not-call", complete: async () => { throw new Error("no model"); } } });
    await writable.close();
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try { expect(db.factProjection()).toEqual({ claims: [], sources: [], supersedes: [] }); }
    finally { db.close(); }
    expect(readBujoCanonicalSourceFingerprint(fixture.root)).toBe(fingerprint);
    expect(readFactLedgerStrict(fixture.root).present).toBe(false);
  });

  it("keeps byte-sorted mixed-case source IDs in exact SQLite parity", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-binary-order", bullets: [
      { id: "B-a", text: FIRST }, { id: "B-Z", text: SECOND },
    ], entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: "2026-07-30T00:00:00.000Z" }] });
    const first = claim("B-a", FIRST, "2000-02-29", "run-mixed");
    appendFactLines(fixture.root, [first, { v: 1, kind: "fact-source", factId: first.factId,
      sourceMemoryId: "B-Z", sourceTextSha256: hash(SECOND), attribution: "document", recordedAt: first.recordedAt }]);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try {
      expect(db.factProjection().sources.map((source) => source.memoryId)).toEqual(["B-Z", "B-a"]);
      expect(auditCanonicalGraphParity(fixture.root, db)).toMatchObject({ status: "match", facts: { matched: 3 } });
    } finally { db.close(); }
    const store = createBujoMemoryStore({ root: fixture.root, tier: "bujo",
      embeddings: fixture.embeddings, dim: fixture.dim,
      llm: { id: "must-not-call", complete: async () => { throw new Error("no model"); } } });
    await store.close();
  });

  it("classifies only singleton and overlapping location values as conflicts, preserving dated history", async () => {
    const specs = [
      ["birth_date", { type: "date", date: "2000-02-29" }],
      ["birth_date", { type: "date", date: "2001-02-28" }],
      ["full_name", { type: "text", text: "Alice Smith" }],
      ["full_name", { type: "text", text: "Alice Jones" }],
      ["preferred_name", { type: "text", text: "Alice" }],
      ["preferred_name", { type: "text", text: "Ali" }],
      ["home_location", { type: "text", text: "Berlin" }],
      ["home_location", { type: "text", text: "Paris" }],
      ["work_location", { type: "text", text: "Rome" }],
      ["work_location", { type: "text", text: "Milan" }],
      ["relationship", { type: "relationship", role: "friend", targetEntityId: "person:bob" }],
      ["relationship", { type: "relationship", role: "friend", targetEntityId: "person:charlie" }],
      ["other:language", { type: "text", text: "English" }],
      ["other:language", { type: "text", text: "French" }],
      ["home_location", { type: "text", text: "Oslo" }],
      ["home_location", { type: "text", text: "Bern" }],
    ] as const;
    const fixture = await createBujoFixture({ prefix: "fact-conflict-classes",
      bullets: specs.map((_, index) => ({ id: `B-${index}`, text: FIRST, ...(index === 0 ? { status: "done" as const } : {}) })),
      entities: ["alice", "bob", "charlie"].map((id) => ({ id: `person:${id}`, name: id,
        type: "person" as const, createdAt: "2026-07-30T00:00:00.000Z" })) });
    const lines: FactClaim[] = specs.map(([key, value], index) => {
      const base = claim(`B-${index}`, FIRST, "2000-02-29", `run-${index}`);
      const interval = index === 6 ? { validFrom: "2020-01-01", validTo: "2021-12-31" }
        : index === 7 ? { validFrom: "2022-01-01", validTo: "2023-12-31" }
          : index === 8 ? { validFrom: "2020-01-01", validTo: "2024-12-31" }
            : index === 9 ? { validFrom: "2024-01-01", validTo: "2025-12-31" } : {};
      const parts = { ...base, key, value, ...interval,
        ...(index >= 14 ? { entityId: "person:bob" } : {}) } as FactClaim;
      return { ...parts, factId: deriveFactId(parts) };
    });
    appendFactLines(fixture.root, lines);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try {
      const indexed = new Map(db.activeFactClaims("2024-06-01").map((fact) => [fact.factId, fact]));
      const flags = lines.map((line) => indexed.get(line.factId)?.conflict);
      expect(flags).toEqual([true, true, true, true, true, true, false, false, true, true,
        false, false, false, false, true, true]);
      expect(indexed.get(lines[0]!.factId)).toMatchObject({ active: true, currentAt: true }); // done is live
      expect(indexed.get(lines[6]!.factId)).toMatchObject({ active: true, currentAt: false });
      expect(indexed.get(lines[8]!.factId)).toMatchObject({ active: true, currentAt: true });
      expect(indexed.get(lines[9]!.factId)).toMatchObject({ active: true, currentAt: true });
      expect(() => db.activeFactClaims("2023-02-29")).toThrow(/real ISO civil date/);
    } finally { db.close(); }
  });

  it("refuses a retained non-BuJo rollback after a fact ledger appears", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-rollback-guard", bullets: [{ id: "B-1", text: FIRST }],
      entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: "2026-07-30T00:00:00.000Z" }] });
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "journal", embeddings: fixture.embeddings, dim: fixture.dim });
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    expect(readManagedIndexManifest(fixture.root)?.rollback?.tier).toBe("journal");
    appendFactLines(fixture.root, [claim("B-1", FIRST, "2000-02-29", "rollback-guard")]);
    await expect(rollbackMemoryIndex({ root: fixture.root, tier: "journal", embeddings: fixture.embeddings,
      dim: fixture.dim })).rejects.toThrow(/non-BuJo rollback refused/);
    expect(readManagedIndexManifest(fixture.root)?.active.tier).toBe("bujo");
  });

  it("keeps the ledger and marker through stopped-store forget backups", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-forget-backup", bullets: [
      { id: "B-1", text: FIRST }, { id: "B-2", text: SECOND },
    ], entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: "2026-07-30T00:00:00.000Z" }] });
    const first = claim("B-1", FIRST, "2000-02-29", "forget-run");
    appendFactLines(fixture.root, [first, { v: 1, kind: "fact-source", factId: first.factId,
      sourceMemoryId: "B-2", sourceTextSha256: hash(SECOND), attribution: "document", recordedAt: first.recordedAt }]);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const originalLedger = readFileSync(join(fixture.root, FACT_LEDGER_FILE));
    const originalMarker = readFileSync(join(fixture.root, FACT_MARKER_FILE));
    let lastBackup: string | undefined;
    for (const [id, supported] of [["B-1", true], ["B-2", false]] as const) {
      const result = await applyExplicitMemoryForget({ root: fixture.root, ids: [id],
        expectedRootFingerprint: rootFingerprint(realpathSync(fixture.root)),
        expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(fixture.root),
        planDigest: hash(`forget:${id}`), embeddings: fixture.embeddings, dimension: fixture.dim });
      lastBackup = result.backupPath;
      expect(readFactLedgerStrict(join(result.backupPath, "snapshot")).lines).toHaveLength(2);
      expect(readFactLedgerStrict(fixture.root).lines).toHaveLength(2);
      const db = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
      try { expect(db.activeFactClaims()[0]).toMatchObject({ active: supported }); }
      finally { db.close(); }
    }
    expect(lastBackup).toBeDefined();
    const restored = await restoreExplicitMemoryForget({ root: fixture.root, backupPath: lastBackup!,
      expectedRootFingerprint: rootFingerprint(realpathSync(fixture.root)) });
    expect(restored.status).toBe("restored");
    expect(readFileSync(join(fixture.root, FACT_LEDGER_FILE))).toEqual(originalLedger);
    expect(readFileSync(join(fixture.root, FACT_MARKER_FILE))).toEqual(originalMarker);
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try { expect(db.activeFactClaims()[0]).toMatchObject({ active: true, supportingMemoryIds: ["B-2"] }); }
    finally { db.close(); }
  });

  it("detects missing/extra SQLite rows without trusting the index and rebuilds offline", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-parity", bullets: [{ id: "B-1", text: FIRST }],
      entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: "2026-07-30T00:00:00.000Z" }] });
    appendFactLines(fixture.root, [claim("B-1", FIRST, "2000-02-29", "parity")]);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const path = resolveActiveMemoryDbPath(fixture.root);
    const db = openMemoryDb({ path, embeddings: fixture.embeddings, dim: fixture.dim });
    try {
      expect(auditCanonicalGraphParity(fixture.root, db).status).toBe("match");
      const expected = db.factProjection();
      db.replaceFactProjection({ ...expected,
        claims: [...expected.claims, { ...expected.claims[0]!, factId: `f:${hash("extra")}` }] });
      expect(auditCanonicalGraphParity(fixture.root, db)).toMatchObject({ status: "mismatch", facts: { extra: 1 } });
      db.replaceFactProjection({ claims: [], sources: [], supersedes: [] });
      expect(auditCanonicalGraphParity(fixture.root, db)).toMatchObject({ status: "mismatch", facts: { missing: 2 } });
    } finally { db.close(); }
    expect(() => createBujoMemoryStore({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings,
      dim: fixture.dim, llm: { id: "must-not-call", complete: async () => { throw new Error("no model"); } } }))
      .toThrow(/canonical memory, graph|SQLite fact projection|parity/);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const recovered = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try { expect(auditCanonicalGraphParity(fixture.root, recovered).status).toBe("match"); }
    finally { recovered.close(); }
    const store = createBujoMemoryStore({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings,
      dim: fixture.dim, llm: { id: "must-not-call", complete: async () => { throw new Error("no model"); } } });
    await store.close();
  });

  it("retains history and derives support from live bullet status/digest after forgetting each source", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-support", bullets: [
      { id: "B-1", text: FIRST }, { id: "B-2", text: SECOND },
    ], entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: "2026-07-30T00:00:00.000Z" }] });
    const first = claim("B-1", FIRST, "2000-02-29", "run-first");
    if (readManagedIndexManifest(fixture.root)?.rollback === undefined) {
      await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    }
    expect(readManagedIndexManifest(fixture.root)?.rollback).toBeDefined();
    const source: FactSource = { v: 1, kind: "fact-source", factId: first.factId,
      sourceMemoryId: "B-2", sourceTextSha256: hash(SECOND), attribution: "document", recordedAt: first.recordedAt };
    appendFactLines(fixture.root, [first, source]);
    expect(readManagedIndexManifest(fixture.root)?.rollback).toBeUndefined();
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    const immutable = db.factProjection();
    expect(immutable.sources.map((item) => item.attribution)).toEqual(["user-stated", "document"]);
    try {
      expect(db.activeFactClaims()).toMatchObject([{
        factId: first.factId, active: true, conflict: false, supportingMemoryIds: ["B-1", "B-2"],
      }]);
    } finally { db.close(); }
    rewriteBullet(fixture.root, "daily/2026-07-30.md", "B-1", { status: "dropped" });
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const afterOne = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try {
      expect(afterOne.activeFactClaims()[0]).toMatchObject({ active: true, supportingMemoryIds: ["B-2"] });
      expect(afterOne.factProjection()).toEqual(immutable);
    }
    finally { afterOne.close(); }
    rewriteBullet(fixture.root, "daily/2026-07-30.md", "B-2", { status: "dropped" });
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const afterLast = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try {
      expect(afterLast.activeFactClaims()[0]).toMatchObject({ active: false, supportingMemoryIds: [] });
      expect(afterLast.factProjection().claims).toHaveLength(1);
    } finally { afterLast.close(); }
    rewriteBullet(fixture.root, "daily/2026-07-30.md", "B-2", { status: "open", text: "Alice's report changed." });
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const afterTextChange = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try { expect(afterTextChange.activeFactClaims()[0]).toMatchObject({ active: false, supportingMemoryIds: [] }); }
    finally { afterTextChange.close(); }
    const staleSupported = createBujoMemoryStore({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings,
      dim: fixture.dim, llm: { id: "must-not-call", complete: async () => { throw new Error("no model"); } } });
    await staleSupported.close();
  });

  it("keeps competing birth dates as conflicts and explicit correction as immutable history", async () => {
    const fixture = await createBujoFixture({ prefix: "fact-conflict", bullets: [
      { id: "B-1", text: FIRST }, { id: "B-2", text: OTHER },
    ], entities: [{ id: "person:alice", name: "Alice", type: "person", createdAt: "2026-07-30T00:00:00.000Z" }] });
    const old = claim("B-1", FIRST, "2000-02-29", "run-old");
    const latest = claim("B-2", OTHER, "2001-02-28", "run-new");
    appendFactLines(fixture.root, [old, latest]);
    const fingerprint = readBujoCanonicalSourceFingerprint(fixture.root);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    expect(readBujoCanonicalSourceFingerprint(fixture.root)).toBe(fingerprint);
    const conflict = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try { expect(conflict.activeFactClaims().map((fact) => fact.conflict)).toEqual([true, true]); }
    finally { conflict.close(); }
    const edge: FactSupersede = { v: 1, kind: "fact-supersede", oldFactId: old.factId,
      newFactId: latest.factId, at: "2026-09-24T01:00:00.000Z" };
    appendFactLines(fixture.root, [edge]);
    await safeRebuildMemoryIndex({ root: fixture.root, tier: "bujo", embeddings: fixture.embeddings, dim: fixture.dim });
    const corrected = openMemoryDb({ path: resolveActiveMemoryDbPath(fixture.root), readOnly: true });
    try {
      expect(corrected.activeFactClaims()).toMatchObject([
        { factId: old.factId, active: false, conflict: false },
        { factId: latest.factId, active: true, conflict: false },
      ].sort((a, b) => a.factId.localeCompare(b.factId)));
      expect(corrected.factProjection().supersedes).toHaveLength(1);
    } finally { corrected.close(); }
  });
});
