import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBullet, rewriteBullet } from "../daily.js";
import { inspectCurateSource, parseCurateOperatorMerges, previewCurateMutations, proposePersonAssociations } from "../curate.js";
import { validateCuratePersonAssociation } from "../curate-people.js";
import { appendGraphBatch, readCanonicalGraphStrictSnapshot } from "../graph.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = "2026-07-12T10:00:00.000Z";
function memoryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "curate-people-fixture-")); roots.push(parent);
  const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
  return path;
}
function seed(path: string, id: string, text: string, type: "note" | "event" | "task" = "note") {
  appendBullet(path, { id, text, type, status: "open", salience: 0.5, isInsight: false, createdAt: at, refs: [] }, new Date(at));
}
const person = (id: string, name: string) => ({ id: `person:${id}`, name, type: "person", createdAt: at });
const links = (path: string, merges: string[] = []) => proposePersonAssociations(path, parseCurateOperatorMerges(merges, false))
  .associations.map(({ id, entityId, reason, accepted }) => `${id}>${entityId}>${reason}>${accepted}`);

describe("person link backfill", () => {
  it("links a line to each person whose full proper name it contains", () => {
    const path = memoryRoot();
    seed(path, "fictional-a", "Zorbel and Ottrin booked the Maple trip.");
    seed(path, "fictional-b", "The user met Zorbel Quint at the Maple office.");
    seed(path, "fictional-c", "Quill and Zorbel Quint planned a picnic.");
    seed(path, "fictional-d", "Quillon and quill are not the same word.");
    seed(path, "fictional-e", "The user's vexlo repaired the canoe.");
    seed(path, "fictional-f", "Vantry: the Maple draft is ready.");
    seed(path, "fictional-g", "Call Quill about the Maple invoice.", "task");
    seed(path, "fictional-h", "Quill shared the Maple password: hunter2.");
    seed(path, "fictional-i", "Vantry: Vantry reviewed the Maple draft.");
    appendGraphBatch(path, { entities: [person("zorbel-quint", "Zorbel Quint"), person("quill", "Quill"),
      person("vexlo", "vexlo"), person("vantry", "Vantry"), person("owner", "Ottrin"),
      { id: "project:maple", name: "Maple", type: "project", createdAt: at }] });
    // A first name alone, a lower-case name, a leading speaker label and the owner's own name never link.
    expect(links(path)).toEqual([
      "fictional-b>person:zorbel-quint>person-name>true",
      "fictional-c>person:quill>person-name>true",
      "fictional-c>person:zorbel-quint>person-name>true",
      "fictional-i>person:vantry>person-name>true",
    ]);
    const scan = proposePersonAssociations(path);
    // Tasks and credential contexts are not examined.
    expect(scan.counts).toEqual({ live: 7, linkedBefore: 0, alreadyLinked: 0, proposed: 4, newlyLinkedLines: 3,
      ambiguousNames: 0, ambiguousLines: 0, more: false });
    for (const association of scan.associations) expect(() => validateCuratePersonAssociation(association)).not.toThrow();
    expect(() => validateCuratePersonAssociation({ ...scan.associations[0]!, entityId: "project:maple" })).toThrow(/invalid person association/u);
    expect(() => validateCuratePersonAssociation({ ...scan.associations[0]!, entityId: "person:owner" })).toThrow(/invalid person association/u);
    expect(() => validateCuratePersonAssociation({ ...scan.associations[0]!, reason: "owner-name" as "person-name" }))
      .toThrow(/invalid person association/u);
  });

  it("never links a name that maps to more than one person after the plan's merges", () => {
    const path = memoryRoot();
    seed(path, "fictional-a", "Wexa planned the Maple trip.");
    seed(path, "fictional-b", "Quill Zorbel planned the Maple trip.");
    seed(path, "fictional-c", "Wexa and Brenn discussed the canoe.");
    appendGraphBatch(path, { entities: [person("quill-zorbel", "Quill Zorbel"), person("brenn", "Brenn"),
      person("wexa", "Wexa"), person("wexa-2", "Wexa")] });
    // A name held by two person ids is skipped; other names on the same line still link.
    expect(links(path)).toEqual(["fictional-b>person:quill-zorbel>person-name>true", "fictional-c>person:brenn>person-name>true"]);
    expect(proposePersonAssociations(path).counts).toMatchObject({ ambiguousNames: 1, ambiguousLines: 2, proposed: 2 });
    // Merging the two ids in the same plan makes the name unique.
    expect(links(path, ["person:wexa-2=person:wexa"])).toEqual(["fictional-a>person:wexa>person-name>true",
      "fictional-b>person:quill-zorbel>person-name>true", "fictional-c>person:brenn>person-name>true",
      "fictional-c>person:wexa>person-name>true"]);
  });

  it("never links the owner, even through a name merged into it", () => {
    const path = memoryRoot();
    seed(path, "fictional-a", "Ottrin asked for a Maple summary.");
    seed(path, "fictional-b", "Quill told Ottrin about the canoe.");
    appendGraphBatch(path, { entities: [{ id: "person:owner", name: "Owner", type: "person", createdAt: at },
      person("ottrin", "Ottrin"), person("quill", "Quill")] });
    expect(links(path)).toEqual([
      "fictional-a>person:ottrin>person-name>true",
      "fictional-b>person:ottrin>person-name>true",
      "fictional-b>person:quill>person-name>true",
    ]);
    expect(links(path, ["person:ottrin=person:owner"])).toEqual(["fictional-b>person:quill>person-name>true"]);
  });

  it("refuses stale, dropped, rewritten or merge-dependent links before any backup", () => {
    const path = memoryRoot();
    seed(path, "fictional-a", "Quill booked the Maple trip.");
    appendGraphBatch(path, { entities: [person("quill", "Quill"), person("wexa", "Wexa")] });
    const [association] = proposePersonAssociations(path).associations;
    expect(previewCurateMutations(path, [], undefined, [], [], [association!])).toEqual(["fictional-a"]);
    expect(previewCurateMutations(path, [], undefined, [], [], [{ ...association!, accepted: false }])).toEqual([]);
    expect(() => previewCurateMutations(path, [], undefined, [], [], [association!, association!])).toThrow(/conflicting person association/u);
    const source = inspectCurateSource(path).lines[0]!;
    expect(() => previewCurateMutations(path, [{ source, action: "drop", reason: "focus-noise", accepted: true }], undefined, [], [], [association!]))
      .toThrow(/conflicting person association/u);
    expect(() => previewCurateMutations(path, [], undefined, [], [], [{ ...association!, entityId: "person:wexa" }]))
      .toThrow(/stale person association/u);
    const rewrite = { source, action: "rewrite" as const, text: "Wexa booked the Maple trip.", accepted: true };
    expect(() => previewCurateMutations(path, [rewrite], undefined, [], [], [association!])).toThrow(/rewrite invalidates person association/u);
    // An operator merge in the same plan moves the name to another person.
    expect(() => previewCurateMutations(path, [], undefined, parseCurateOperatorMerges(["person:quill=person:wexa"], false), [], [association!]))
      .toThrow(/stale person association/u);
    rewriteBullet(path, source.file, source.id, { text: "Quill booked the Maple trip twice." });
    expect(() => previewCurateMutations(path, [], undefined, [], [], [association!])).toThrow(/stale person association/u);
  });

  it("bounds each pass and continues where the last one stopped", async () => {
    const { scanPersonAssociations } = await import("../curate-people.js");
    const path = memoryRoot();
    for (const id of ["a", "b", "c"]) seed(path, `fictional-${id}`, `Quill and Wexa reviewed draft ${id}.`);
    appendGraphBatch(path, { entities: [person("quill", "Quill"), person("wexa", "Wexa")],
      associations: [{ memoryId: "fictional-a", entityId: "person:quill", provenance: "capture", createdAt: at }] });
    // A line's links stay together: the second line would exceed the bound.
    const first = scanPersonAssociations(path, new Map(), 2);
    expect(first.associations.map(({ id, entityId }) => `${id}>${entityId}`)).toEqual(["fictional-a>person:wexa"]);
    expect(first.counts).toMatchObject({ linkedBefore: 1, alreadyLinked: 1, proposed: 1, newlyLinkedLines: 0, more: true });
    expect(() => scanPersonAssociations(path, new Map(), 0)).toThrow(/invalid limit/u);
  });

  it("splits a line that names more people than one pass allows", async () => {
    const { scanPersonAssociations } = await import("../curate-people.js");
    const path = memoryRoot();
    seed(path, "fictional-a", "Brenn, Quill, Vantry and Wexa reviewed the Maple draft.");
    seed(path, "fictional-b", "Quill filed the Maple draft.");
    appendGraphBatch(path, { entities: ["brenn", "quill", "vantry", "wexa"].map((id) => person(id, id[0]!.toUpperCase() + id.slice(1))) });
    const pass = (linked: readonly { memoryId: string; entityId: string }[]) => {
      if (linked.length > 0) appendGraphBatch(path, { associations: linked.map(({ memoryId, entityId }) => ({ memoryId, entityId, provenance: "capture" as const, createdAt: at })) });
      const scan = scanPersonAssociations(path, new Map(), 3);
      return { scan, ids: scan.associations.map(({ id, entityId }) => `${id}>${entityId}`) };
    };
    // The first line alone exceeds the bound, so it gets what fits and the pass stops.
    const first = pass([]);
    expect(first.ids).toEqual(["fictional-a>person:brenn", "fictional-a>person:quill", "fictional-a>person:vantry"]);
    expect(first.scan.counts).toMatchObject({ proposed: 3, newlyLinkedLines: 1, more: true });
    // Once those are applied, the next pass continues with the rest of that line.
    const second = pass(first.scan.associations.map(({ id, entityId }) => ({ memoryId: id, entityId })));
    expect(second.ids).toEqual(["fictional-a>person:wexa", "fictional-b>person:quill"]);
    expect(second.scan.counts).toMatchObject({ alreadyLinked: 3, proposed: 2, more: false });
  });

  it("refuses at apply a link whose line the same plan rewrites into a credential context", async () => {
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const path = memoryRoot();
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Quill booked the Maple trip.");
    appendGraphBatch(path, { entities: [person("quill", "Quill")] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const { associations } = proposePersonAssociations(path);
    const source = inspectCurateSource(path).lines[0]!;
    // The rewritten line still names Quill, but it is no longer eligible for a person link.
    const rewrite = { source, action: "rewrite" as const, text: "Quill booked the Maple trip; password is in the vault.", accepted: true };
    const before = readCanonicalGraphStrictSnapshot(path).records;
    await expect(applyExplicitMemoryCurate({ root: path, proposals: [rewrite], personAssociations: associations,
      expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("people-plan").digest("hex"), embeddings, dimension: 16 }))
      // Refused before any backup is taken.
      .rejects.toMatchObject({ code: "apply_failed", backupPath: undefined,
        cause: expect.objectContaining({ message: "memory-curate: rewrite invalidates person association" }) });
    expect(readCanonicalGraphStrictSnapshot(path).records).toEqual(before);
    expect(inspectCurateSource(path).lines[0]!.text).toBe("Quill booked the Maple trip.");
    // The same rewrite without the credential context passes the check.
    expect(previewCurateMutations(path, [{ ...rewrite, text: "Quill booked the Maple trip again." }], undefined, [], [], associations))
      .toEqual(["fictional-a"]);
    expect(() => previewCurateMutations(path, [rewrite], undefined, [], [], associations)).toThrow(/rewrite invalidates person association/u);
  });

  it("applies through the root-swap and is not proposed again", async () => {
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate, restoreExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { auditCanonicalGraphParity } = await import("../graph-parity.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const { resolveActiveMemoryDbPath } = await import("../generations.js");
    const path = memoryRoot();
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Quill booked the Maple trip.");
    seed(path, "fictional-b", "Wexa likes the Maple project.");
    appendGraphBatch(path, { entities: [person("quill", "Quill"), person("wexa", "Wexa")] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const rootFingerprint = createHash("sha256").update(realpathSync(path)).digest("hex");
    const { associations } = proposePersonAssociations(path);
    // The operator rejected the second link in review.
    const reviewed = associations.map((association) => association.id === "fictional-b" ? { ...association, accepted: false } : association);
    const applied = await applyExplicitMemoryCurate({ root: path, proposals: [], personAssociations: reviewed,
      expectedRootFingerprint: rootFingerprint, expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("people-plan").digest("hex"), embeddings, dimension: 16 });
    expect(applied).toMatchObject({ status: "applied", changed: 1 });
    const graph = readCanonicalGraphStrictSnapshot(path).records;
    expect(graph.associations.filter(({ provenance }) => provenance === "capture").map(({ memoryId, entityId }) => `${memoryId}>${entityId}`))
      .toEqual(["fictional-a>person:quill"]);
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try {
      expect(auditCanonicalGraphParity(path, db).status).toBe("match");
      expect(db.associationsForMemory("fictional-a").map(({ entityId }) => entityId)).toContain("person:quill");
    } finally { db.close(); }
    // Idempotent: only the rejected link is proposed again.
    expect(links(path)).toEqual(["fictional-b>person:wexa>person-name>true"]);
    expect(proposePersonAssociations(path).counts).toMatchObject({ alreadyLinked: 1, proposed: 1 });
    await restoreExplicitMemoryCurate({ root: path, backupPath: applied.backupPath, expectedRootFingerprint: rootFingerprint });
    expect(links(path)).toHaveLength(2);
  });
});
