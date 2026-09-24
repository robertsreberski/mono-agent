import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBullet } from "../daily.js";
import { curateEstimate, inspectCurateSource, proposeCurate, validateCurateProposal } from "../curate.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), "curate-fixture-")); roots.push(path); return path; }
function seed(path: string, id: string, text: string) {
  appendBullet(path, { id, text, type: "note", status: "open", salience: 0.5, isInsight: false,
    createdAt: "2026-07-12T10:00:00.000Z", refs: [] }, new Date("2026-07-12T10:00:00.000Z"));
}
describe("curation preparation", () => {
  it("reads bounded canonical live lines in order and estimates without a model call", () => {
    const path = root(); seed(path, "fictional-a", "Morgan completed the example."); seed(path, "fictional-b", "The demo status is transient.");
    const snapshot = inspectCurateSource(path, 1);
    expect(snapshot.lines.map(({ id }) => id)).toEqual(["fictional-a"]);
    expect(curateEstimate(snapshot)).toMatchObject({ lines: 1, calls: 1, cost: "unknown" });
    const expanded = { ...snapshot, entityNames: [{ id: "person:morgan", name: "Morgan Example Name" }] };
    expect(curateEstimate(expanded, { focus: "Skip transient fictional status updates." }).inputTokens)
      .toBeGreaterThan(curateEstimate(snapshot).inputTokens);
  });
  it("rejects unsupported legacy label authority and invalid rewrites", async () => {
    const path = root(); seed(path, "fictional-a", "Morgan completed the example.");
    const source = inspectCurateSource(path).lines[0]!;
    expect(() => validateCurateProposal({ source, action: "label", accepted: true, labels: [{ v: 1, kind: "lesson", scope: "agent", verified: true }] })).toThrow();
    expect(() => validateCurateProposal({ source, action: "label", accepted: true, labels: [{ v: 1, kind: "lesson", scope: "agent", verified: false }] })).toThrow();
    expect(() => validateCurateProposal({ source, action: "label", accepted: true, labels: [{ v: 1, kind: "fact", entityId: "person:maple", key: "preferred_name", value: { type: "text", text: "Morgan" }, attribution: "unknown" }] })).toThrow();
    expect(() => validateCurateProposal({ source, action: "label", accepted: true, labels: [{ v: 1, kind: "fact", entityId: "person:morgan", key: "preferred_name", value: { type: "text", text: "Morgan" }, attribution: "user-stated" }] })).toThrow();
    expect(() => validateCurateProposal({ source, action: "rewrite", text: "Unsafe\ntext", accepted: true })).toThrow();
    seed(path, "fictional-b", "Morgan visited yesterday.");
    const dated = inspectCurateSource(path).lines.find(({ id }) => id === "fictional-b")!;
    const { previewCurateMutations } = await import("../curate.js");
    expect(() => previewCurateMutations(path, [{ source: dated, action: "rewrite", text: "Morgan visited on 2026-07-10.", accepted: true }]))
      .toThrow(/unsupported date/u);
  });
  it("batches fake-model proposals and fails closed on unknown IDs", async () => {
    const path = root(); seed(path, "fictional-a", "Generic demo advice."); seed(path, "fictional-b", "Morgan completed the example.");
    const snapshot = inspectCurateSource(path);
    let calls = 0;
    const proposals = await proposeCurate(snapshot, { id: "fake", complete: async () => {
      calls++;
      return JSON.stringify([{ id: "fictional-a", action: "drop", reason: "generic-advice" }, { id: "fictional-b", action: "keep" }]);
    } });
    expect(calls).toBe(1);
    expect(proposals.proposals).toHaveLength(2);
    expect(proposals.proposals[0]).toMatchObject({ accepted: false, reason: "generic-advice" });
    const partlyInvalid = await proposeCurate(snapshot, { id: "fake", complete: async () => JSON.stringify([{ id: "outside", action: "keep" }, { id: "fictional-b", action: "keep" }]) });
    expect(partlyInvalid.proposals.map(({ source }) => source.id)).toEqual(["fictional-b"]);
    expect(partlyInvalid.discarded).toEqual([{ id: "unbound", reason: "unknown-id" }, { id: "fictional-a", reason: "missing-proposal" }]);
    const shortened = await proposeCurate(snapshot, { id: "fake", complete: async () => JSON.stringify([{ id: "fictional-a", action: "keep" }]) });
    expect(shortened.proposals).toHaveLength(1);
    expect(shortened.discarded).toEqual([{ id: "fictional-b", reason: "missing-proposal" }]);
    const labelled = await proposeCurate(snapshot, { id: "fake", complete: async () => JSON.stringify([
      { id: "fictional-a", action: "keep" }, { id: "fictional-b", action: "label", labels: [{ v: 1, kind: "fact", entityId: "person:morgan",
        key: "preferred_name", value: { type: "text", text: "Morgan" }, attribution: "document" }] },
    ]) });
    expect(labelled.proposals[1]?.labels?.[0]).toMatchObject({ attribution: "assistant-inferred" });
    const factLabel = labelled.proposals[1]!.labels![0]!;
    if (factLabel.kind !== "fact") throw new Error("expected fact label");
    expect(() => validateCurateProposal({ ...labelled.proposals[1]!, labels: [{ ...factLabel, attribution: "document" }] })).toThrow();
  });
});

describe("durable curation apply", { timeout: 20_000 }, () => {
  it("rewrites, adds labels and restores the verified backup", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, realpathSync } = await import("node:fs");
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate, restoreExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { resolveActiveMemoryDbPath, acquireMemoryWriterLease } = await import("../generations.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Morgan's alias is Maple.");
    const { appendGraphBatch } = await import("../graph.js");
    appendGraphBatch(path, { entities: [{ id: "person:morgan", name: "Morgan", type: "person", createdAt: "2026-07-12T10:00:00.000Z" }] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const source = inspectCurateSource(path).lines[0]!;
    const fingerprint = createHash("sha256").update(realpathSync(path)).digest("hex");
    const proposals = [{ source, action: "label" as const, accepted: true, labels: [{ v: 1 as const, kind: "fact" as const,
      entityId: "person:morgan", key: "preferred_name", value: { type: "text" as const, text: "Maple" }, attribution: "unknown" as const }] }];
    const competing = acquireMemoryWriterLease(path);
    try {
      await expect(applyExplicitMemoryCurate({ root: path, proposals, expectedRootFingerprint: fingerprint,
        expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path), planDigest: createHash("sha256").update("competing-plan").digest("hex"),
        embeddings, dimension: 16 })).rejects.toMatchObject({ code: "apply_failed" });
    } finally { competing.release(); }
    const applied = await applyExplicitMemoryCurate({ root: path, proposals, expectedRootFingerprint: fingerprint,
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path), planDigest: createHash("sha256").update("fictional-plan").digest("hex"),
      embeddings, dimension: 16 });
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try { expect(db.get("fictional-a")?.text).toBe(source.text); } finally { db.close(); }
    expect(applied.status).toBe("applied");
    expect(await restoreExplicitMemoryCurate({ root: path, backupPath: applied.backupPath, expectedRootFingerprint: fingerprint })).toMatchObject({ status: "restored" });
    expect(inspectCurateSource(path).lines[0]?.refs).toEqual([]);
  });
});

describe("curate canonical rewrites", { timeout: 20_000 }, () => {
  it("merges graph references and fact-label entity IDs with rebuild parity", async () => {
    const { mkdirSync, realpathSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { appendGraphBatch, readCanonicalGraphStrictSnapshot } = await import("../graph.js");
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { auditCanonicalGraphParity } = await import("../graph-parity.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const { resolveActiveMemoryDbPath } = await import("../generations.js");
    const { encodeMemoryLabel } = await import("../labels.js");
    const { rewriteBullet } = await import("../daily.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Morgan uses Maple as an example alias.");
    const line = inspectCurateSource(path).lines[0]!;
    rewriteBullet(path, line.file, line.id, { refs: [encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:morgan-duplicate",
      key: "preferred_name", value: { type: "text", text: "Maple" }, attribution: "unknown" })] });
    const at = "2026-07-12T10:00:00.000Z";
    appendGraphBatch(path, { entities: [
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: at },
      { id: "person:morgan-duplicate", name: "Morgan", type: "person", createdAt: at },
      { id: "project:demo", name: "Demo", type: "project", createdAt: at },
    ], relations: [{ src: "person:morgan-duplicate", dst: "project:demo", relation: "works on", createdAt: at }],
    associations: [{ memoryId: "fictional-a", entityId: "person:morgan-duplicate", provenance: "capture", createdAt: at }] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const source = inspectCurateSource(path).lines[0]!;
    const applied = await applyExplicitMemoryCurate({ root: path, proposals: [{ source, action: "merge", accepted: true,
      mergeEntity: { from: "person:morgan-duplicate", to: "person:morgan" } }],
      expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path), planDigest: createHash("sha256").update("graph-plan").digest("hex"),
      embeddings, dimension: 16 });
    expect(applied.status).toBe("applied");
    const graph = readCanonicalGraphStrictSnapshot(path).records;
    expect(graph.entities.map(({ id }) => id)).not.toContain("person:morgan-duplicate");
    expect(graph.associations).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: "person:morgan" })]));
    expect(inspectCurateSource(path).lines[0]?.refs.join(" ")).not.toContain("morgan-duplicate");
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try { expect(auditCanonicalGraphParity(path, db).status).toBe("match"); } finally { db.close(); }
  });
});

describe("curate selection", { timeout: 20_000 }, () => {
  it("forgets selected lines and rewrites date only from the recorded source date", async () => {
    const { mkdirSync, realpathSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const { resolveActiveMemoryDbPath } = await import("../generations.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Generic advice to be removed.");
    seed(path, "fictional-b", "Morgan visited yesterday.");
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const [first, second] = inspectCurateSource(path).lines;
    const applied = await applyExplicitMemoryCurate({ root: path, proposals: [
      { source: first!, action: "drop", reason: "generic-advice", accepted: true },
      { source: second!, action: "rewrite", text: "Morgan visited on 2026-07-11.", accepted: true },
    ], expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
    expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path), planDigest: createHash("sha256").update("drop-plan").digest("hex"),
    embeddings, dimension: 16 });
    expect(applied.changed).toBe(2);
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try { expect(db.get("fictional-a")?.status).toBe("dropped"); expect(db.get("fictional-b")?.text).toBe("Morgan visited on 2026-07-11."); }
    finally { db.close(); }
  });
});

describe("retrospective label support", { timeout: 20_000 }, () => {
  it("keeps only facts still supported after an accepted rewrite", async () => {
    const { mkdirSync, realpathSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { encodeMemoryLabel, labelsOf } = await import("../labels.js");
    const { rewriteBullet, readBullet } = await import("../daily.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Morgan used Maple and Brook as example names.");
    const first = inspectCurateSource(path).lines[0]!;
    rewriteBullet(path, first.file, first.id, { refs: [
      encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:morgan", key: "preferred_name",
        value: { type: "text", text: "Maple" }, attribution: "unknown" }),
      encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:morgan", key: "other:alias",
        value: { type: "text", text: "Brook" }, attribution: "unknown" }),
    ] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const source = inspectCurateSource(path).lines[0]!;
    await applyExplicitMemoryCurate({ root: path, proposals: [{ source, action: "rewrite", accepted: true,
      text: "Morgan used Maple as an example name." }],
    expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
    expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path), planDigest: createHash("sha256").update("retained-fact").digest("hex"),
    embeddings, dimension: 16 });
    expect(labelsOf(readBullet(path, source.file, source.id)!)).toMatchObject([{ kind: "fact", key: "preferred_name" }]);
  });
});

describe("curate preview label capacity", () => {
  it("rejects duplicate or ninth label before mutation or backup", async () => {
    const { rewriteBullet } = await import("../daily.js");
    const { encodeMemoryLabel } = await import("../labels.js");
    const { previewCurateMutations } = await import("../curate.js");
    const path = root(); seed(path, "fictional-a", "Morgan used Maple as an alias.");
    const source = inspectCurateSource(path).lines[0]!;
    const label = { v: 1 as const, kind: "fact" as const, entityId: "person:morgan", key: "preferred_name",
      value: { type: "text" as const, text: "Maple" }, attribution: "unknown" as const };
    rewriteBullet(path, source.file, source.id, { refs: [encodeMemoryLabel(label)] });
    const current = inspectCurateSource(path).lines[0]!;
    expect(() => previewCurateMutations(path, [{ source: current, action: "label", labels: [label], accepted: true }])).toThrow();
    const eight = Array.from({ length: 8 }, (_, index) => encodeMemoryLabel({ ...label, key: `other:alias${index}` }));
    rewriteBullet(path, source.file, source.id, { refs: eight });
    const full = inspectCurateSource(path).lines[0]!;
    expect(() => previewCurateMutations(path, [{ source: full, action: "label", labels: [label], accepted: true }])).toThrow();
  });
});

describe("curate merge identity safety", () => {
  it("treats repeated confirmation of one exact merge as a no-op, but rejects conflicting targets", async () => {
    const { appendGraphBatch } = await import("../graph.js");
    const { previewCurateMutations } = await import("../curate.js");
    const path = root(); seed(path, "fictional-a", "Morgan used an alias."); seed(path, "fictional-b", "Morgan used an alias again.");
    const at = "2026-07-12T10:00:00.000Z";
    appendGraphBatch(path, { entities: [
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: at },
      { id: "person:morgan-alias", name: "Morgan", type: "person", createdAt: at },
      { id: "person:morgan-other", name: "Morgan", type: "person", createdAt: at },
    ] });
    const [first, second] = inspectCurateSource(path).lines;
    const pair = { from: "person:morgan-alias", to: "person:morgan" };
    const a = { source: first!, action: "merge" as const, accepted: true, mergeEntity: pair };
    const b = { source: second!, action: "merge" as const, accepted: true, mergeEntity: pair };
    expect(() => previewCurateMutations(path, [a, b])).not.toThrow();
    expect(() => previewCurateMutations(path, [a, { ...b, mergeEntity: { ...pair, to: "person:morgan-other" } }])).toThrow(/conflicting/u);
  });
  it("rejects same-prefix cross-type identities and self-relations before backup", async () => {
    const { appendGraphBatch } = await import("../graph.js");
    const { previewCurateMutations } = await import("../curate.js");
    const at = "2026-07-12T10:00:00.000Z";
    const path = root(); seed(path, "fictional-a", "Morgan used a fictional alias.");
    appendGraphBatch(path, { entities: [
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: at },
      { id: "person:morgan-alias", name: "Morgan", type: "project", createdAt: at },
    ] });
    const source = inspectCurateSource(path).lines[0]!;
    const proposal = { source, action: "merge" as const, accepted: true,
      mergeEntity: { from: "person:morgan-alias", to: "person:morgan" } };
    expect(() => previewCurateMutations(path, [proposal])).toThrow(/ambiguous entity merge/u);
    appendGraphBatch(path, { entities: [{ id: "person:morgan-alias", name: "Morgan", type: "person", createdAt: at }],
      relations: [{ src: "person:morgan", dst: "person:morgan-alias", relation: "collaborates", createdAt: at }] });
    expect(() => previewCurateMutations(path, [proposal])).toThrow(/self-relation/u);
  });
  it("tolerates a self-relation that already exists in the legacy graph", async () => {
    const { appendGraphBatch } = await import("../graph.js");
    const { previewCurateMutations } = await import("../curate.js");
    const at = "2026-07-12T10:00:00.000Z";
    const path = root(); seed(path, "fictional-a", "Morgan reviewed the fictional plan.");
    appendGraphBatch(path, { entities: [
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: at },
      { id: "person:morgan-dup", name: "Morgan", type: "person", createdAt: at },
    ], relations: [{ src: "person:morgan", dst: "person:morgan", relation: "mentions", createdAt: at }] });
    expect(() => previewCurateMutations(path, [])).not.toThrow();
    const source = inspectCurateSource(path).lines[0]!;
    expect(() => previewCurateMutations(path, [{ source, action: "merge", accepted: true,
      mergeEntity: { from: "person:morgan-dup", to: "person:morgan" } }])).not.toThrow();
  });
});
