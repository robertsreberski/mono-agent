import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBullet, rewriteBullet } from "../daily.js";
import { inspectCurateSource, previewCurateMutations } from "../curate.js";
import { ownerAssociationReason, proposeOwnerAssociations, validateCurateOwnerAssociation } from "../curate-owner.js";
import { appendGraphBatch, readCanonicalGraphStrictSnapshot } from "../graph.js";
import { encodeMemoryLabel } from "../labels.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = "2026-07-12T10:00:00.000Z";
function memoryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "curate-owner-fixture-")); roots.push(parent);
  const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
  return path;
}
function seed(path: string, id: string, text: string, status: "open" | "done" = "open") {
  appendBullet(path, { id, text, type: "note", status, salience: 0.5, isInsight: false, createdAt: at, refs: [] }, new Date(at));
}

describe("owner association backfill", () => {
  it("uses explicit owner labels regardless of language, never prose or pronouns", () => {
    const reason = (text: string, refs: string[] = []) => ownerAssociationReason({ text, refs });
    const ownerFact = encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" });
    const agentPreference = encodeMemoryLabel({ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" });
    const guestPreference = encodeMemoryLabel({ v: 1, kind: "preference", scope: "conversation:guest-room", attribution: "user-stated" });
    for (const text of ["The user prefers short replies.", "User moved to Example City.",
      "Mi casa está en la ciudad.", "Mój dom jest w mieście.", "Morgan told the user about Maple."]) {
      expect(reason(text)).toBeUndefined();
      expect(reason(text, [ownerFact])).toBe("owner-label");
    }
    expect(reason("Risposte brevi.", [agentPreference])).toBe("owner-label");
    expect(reason("Risposte brevi.", [guestPreference])).toBeUndefined();
  });

  it("proposes only unlinked live owner-labelled lines and reports counts", () => {
    const path = memoryRoot();
    const ownerFact = encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" });
    seed(path, "fictional-a", "The user prefers short replies.");
    seed(path, "fictional-b", "Mi casa está en la ciudad.");
    appendBullet(path, { id: "fictional-c", text: "The user was born on 1990-05-17.", type: "note", status: "open",
      salience: 0.5, isInsight: false, createdAt: at, refs: [ownerFact] }, new Date(at));
    seed(path, "fictional-d", "Morgan likes Maple.");
    // The labelled text may be in any language.
    appendBullet(path, { id: "fictional-e", text: "Mój dom jest w mieście.", type: "note", status: "open",
      salience: 0.5, isInsight: false, createdAt: at, refs: [ownerFact] }, new Date(at));
    appendGraphBatch(path, { entities: [{ id: "person:owner", name: "Owner", type: "person", createdAt: at }],
      associations: [{ memoryId: "fictional-c", entityId: "person:owner", provenance: "capture", createdAt: at }] });
    const scan = proposeOwnerAssociations(path);
    expect(scan.associations.map(({ id, reason, accepted }) => ({ id, reason, accepted }))).toEqual([
      { id: "fictional-e", reason: "owner-label", accepted: true },
    ]);
    expect(scan.counts).toEqual({ live: 5, alreadyLinked: 1, notProven: 0, proposed: 1, bare: 0 });
    for (const association of scan.associations) expect(() => validateCurateOwnerAssociation(association)).not.toThrow();
  });

  it("refuses stale, dropped and re-qualified owner labels before backup", () => {
    const path = memoryRoot();
    const ownerFact = encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" });
    appendBullet(path, { id: "fictional-a", text: "Data: 1990-05-17.", type: "note", status: "open",
      salience: 0.5, isInsight: false, createdAt: at, refs: [ownerFact] }, new Date(at));
    const [association] = proposeOwnerAssociations(path).associations;
    expect(previewCurateMutations(path, [], undefined, [], [association!])).toEqual(["fictional-a"]);
    expect(() => validateCurateOwnerAssociation({ ...association!, reason: "invalid" as "owner-label" }))
      .toThrow(/invalid owner association/u);
    expect(previewCurateMutations(path, [], undefined, [], [{ ...association!, accepted: false }])).toEqual([]);
    const source = inspectCurateSource(path).lines[0]!;
    expect(() => previewCurateMutations(path, [{ source, action: "drop", reason: "focus-noise", accepted: true }], undefined, [], [association!]))
      .toThrow(/conflicting owner association/u);
    expect(() => previewCurateMutations(path, [], undefined, [], [{ ...association!, reason: "owner-text" }])).toThrow(/stale owner association/u);
    const rewrite = { source, action: "rewrite" as const, text: "Morgan likes Maple.", accepted: true };
    expect(() => previewCurateMutations(path, [rewrite], undefined, [], [association!])).toThrow(/rewrite invalidates owner association/u);
    expect(previewCurateMutations(path, [rewrite], undefined, [], [{ ...association!, accepted: false }])).toEqual([]);
    expect(previewCurateMutations(path, [{ ...rewrite, text: "Fecha: 1990-05-17." }], undefined, [], [association!]))
      .toEqual(["fictional-a"]);
    rewriteBullet(path, source.file, source.id, { text: "Otra ciudad." });
    expect(() => previewCurateMutations(path, [], undefined, [], [association!])).toThrow(/stale owner association/u);
  });

  it("applies through the root-swap, keeps name-derived links and rebuilds with graph parity", async () => {
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate, restoreExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { auditCanonicalGraphParity } = await import("../graph-parity.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const { resolveActiveMemoryDbPath } = await import("../generations.js");
    const path = memoryRoot();
    initializeReplayProjection(path);
    const ownerFact = encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" });
    appendBullet(path, { id: "fictional-a", text: "The user planned the Maple project.", type: "note", status: "open",
      salience: 0.5, isInsight: false, createdAt: at, refs: [ownerFact] }, new Date(at));
    seed(path, "fictional-b", "Morgan likes the Maple project.");
    // No owner id yet: apply creates it. Maple is linked to both lines by name only.
    appendGraphBatch(path, { entities: [{ id: "project:maple", name: "Maple", type: "project", createdAt: at }] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const rootFingerprint = createHash("sha256").update(realpathSync(path)).digest("hex");
    const { associations } = proposeOwnerAssociations(path);
    expect(associations.map(({ id }) => id)).toEqual(["fictional-a"]);
    const applied = await applyExplicitMemoryCurate({ root: path, proposals: [], ownerAssociations: associations,
      expectedRootFingerprint: rootFingerprint, expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("owner-plan").digest("hex"), embeddings, dimension: 16 });
    expect(applied).toMatchObject({ status: "applied", changed: 1 });
    const graph = readCanonicalGraphStrictSnapshot(path).records;
    expect(graph.entities.map(({ id }) => id).sort()).toEqual(["person:owner", "project:maple"]);
    expect(graph.associations.map(({ memoryId, entityId, provenance }) => `${memoryId}>${entityId}>${provenance}`).sort())
      .toEqual(["fictional-a>person:owner>capture", "fictional-a>project:maple>legacy-name-match"]);
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try {
      expect(auditCanonicalGraphParity(path, db).status).toBe("match");
      expect(db.associationsForMemory("fictional-a").map(({ entityId }) => entityId).sort()).toEqual(["person:owner", "project:maple"]);
      expect(db.associationsForMemory("fictional-b").map(({ entityId }) => entityId)).toEqual(["project:maple"]);
    } finally { db.close(); }
    // A second backfill proposes nothing; restore returns the original graph.
    expect(proposeOwnerAssociations(path).associations).toEqual([]);
    await restoreExplicitMemoryCurate({ root: path, backupPath: applied.backupPath, expectedRootFingerprint: rootFingerprint });
    expect(readCanonicalGraphStrictSnapshot(path).records.associations).toEqual([]);
  });
});
