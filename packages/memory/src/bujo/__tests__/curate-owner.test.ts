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
  it("links only lines whose own text or owner label proves the owner is the subject", () => {
    const reason = (text: string, refs: string[] = []) => ownerAssociationReason({ text, refs });
    // The owner is the grammatical subject: "The user" + verb (optionally after one adverb).
    expect(reason("The user prefers short replies.")).toBe("owner-text");
    expect(reason("The user asked for a Maple summary.")).toBe("owner-text");
    expect(reason("The user was born on 1990-05-17.")).toBe("owner-text");
    expect(reason("The user also bought a zorbel.")).toBe("owner-text");
    expect(reason("User moved to Example City in 2026.")).toBe("owner-bare");
    // "The user's <owner property>" from capture's finite owner-property grammar.
    expect(reason("The user’s home is in Example City.")).toBe("owner-text");
    expect(reason("The user's full name is Morgan Example.")).toBe("owner-text");
    expect(reason("The user's birthday is 1990-05-17.")).toBe("owner-text");
    expect(reason("User's preferred name is Morgan.")).toBe("owner-bare");
    // Any other possessive names something else as the subject and is not proposed.
    expect(reason("The user's zorbel lives in Example City.")).toBeUndefined();
    expect(reason("The user’s quellin starts school in 2027.")).toBeUndefined();
    expect(reason("User's vantry reviewed the draft.")).toBeUndefined();
    expect(reason("The user's homework is due.")).toBeUndefined();
    // "The user" not followed by a verb does not prove the subject.
    expect(reason("The user and Morgan planned the Maple trip.")).toBeUndefined();
    // Not a subject: pasted log envelopes, mid-sentence mentions, other subjects.
    expect(reason("User: remind me tomorrow")).toBeUndefined();
    expect(reason("Morgan told the user about the Maple project.")).toBeUndefined();
    expect(reason("Users of the Maple app reported an outage.")).toBeUndefined();
    const ownerFact = encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" });
    expect(reason("Born on 1990-05-17.", [ownerFact])).toBe("owner-label");
    const agentPreference = encodeMemoryLabel({ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" });
    expect(reason("Reply in plain English.", [agentPreference])).toBe("owner-label");
    const conversationPreference = encodeMemoryLabel({ v: 1, kind: "preference", scope: "conversation:guest-room", attribution: "user-stated" });
    expect(reason("Reply in plain English.", [conversationPreference])).toBeUndefined();
  });

  it("proposes unlinked live lines, skips linked and unproven lines, and reports counts", () => {
    const path = memoryRoot();
    seed(path, "fictional-a", "The user prefers short replies.");
    seed(path, "fictional-b", "The user's zorbel lives in Example City.");
    seed(path, "fictional-c", "The user was born on 1990-05-17.");
    seed(path, "fictional-d", "Morgan likes the Maple project.");
    seed(path, "fictional-e", "The user finished the Maple draft.", "done");
    seed(path, "fictional-f", "User asked for a Maple summary.");
    appendGraphBatch(path, { entities: [{ id: "person:owner", name: "Owner", type: "person", createdAt: at }],
      associations: [{ memoryId: "fictional-c", entityId: "person:owner", provenance: "capture", createdAt: at }] });
    const scan = proposeOwnerAssociations(path);
    expect(scan.associations.map(({ id, reason, accepted }) => ({ id, reason, accepted }))).toEqual([
      { id: "fictional-a", reason: "owner-text", accepted: true },
      { id: "fictional-e", reason: "owner-text", accepted: true },
      // Bare "User ..." is proposed but the operator must opt in.
      { id: "fictional-f", reason: "owner-bare", accepted: false },
    ]);
    expect(scan.counts).toEqual({ live: 6, alreadyLinked: 1, notProven: 1, proposed: 3, bare: 1 });
    for (const association of scan.associations) expect(() => validateCurateOwnerAssociation(association)).not.toThrow();
    expect(() => validateCurateOwnerAssociation({ ...scan.associations[0]!, reason: "guess" as never })).toThrow(/invalid owner association/u);
  });

  it("refuses stale, dropped-in-the-same-plan or re-qualified lines before any backup", () => {
    const path = memoryRoot();
    seed(path, "fictional-a", "The user prefers short replies.");
    const [association] = proposeOwnerAssociations(path).associations;
    expect(previewCurateMutations(path, [], undefined, [], [association!])).toEqual(["fictional-a"]);
    expect(previewCurateMutations(path, [], undefined, [], [{ ...association!, accepted: false }])).toEqual([]);
    const source = inspectCurateSource(path).lines[0]!;
    expect(() => previewCurateMutations(path, [{ source, action: "drop", reason: "focus-noise", accepted: true }], undefined, [], [association!]))
      .toThrow(/conflicting owner association/u);
    expect(() => previewCurateMutations(path, [], undefined, [], [{ ...association!, reason: "owner-label" }])).toThrow(/stale owner association/u);
    // The same plan may not rewrite the line into one about someone else.
    const rewrite = { source, action: "rewrite" as const, text: "The user's zorbel prefers short replies.", accepted: true };
    expect(() => previewCurateMutations(path, [rewrite], undefined, [], [association!])).toThrow(/rewrite invalidates owner association/u);
    expect(previewCurateMutations(path, [{ ...rewrite, text: "The user prefers very short replies." }], undefined, [], [association!]))
      .toEqual(["fictional-a"]);
    // A rejected association does not constrain the rewrite.
    expect(previewCurateMutations(path, [rewrite], undefined, [], [{ ...association!, accepted: false }])).toEqual([]);
    rewriteBullet(path, source.file, source.id, { text: "The user's zorbel prefers short replies." });
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
    seed(path, "fictional-a", "The user planned the Maple project.");
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
