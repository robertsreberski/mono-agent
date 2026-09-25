import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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
  it("allows 8192 selected lines but refuses 8193", () => {
    const path = root();
    expect(inspectCurateSource(path, 8192).lines).toEqual([]);
    expect(() => inspectCurateSource(path, 8193)).toThrow(/invalid limit/u);
  });
  it("reads bounded canonical live lines in order and estimates without a model call", () => {
    const path = root(); seed(path, "fictional-a", "Morgan completed the example."); seed(path, "fictional-b", "The demo status is transient.");
    const snapshot = inspectCurateSource(path, 1);
    expect(snapshot.lines.map(({ id }) => id)).toEqual(["fictional-a"]);
    expect(curateEstimate(snapshot)).toMatchObject({ lines: 1, calls: 1, cost: "unknown" });
    const expanded = { ...snapshot, entityNames: [{ id: "person:morgan", name: "Morgan Example Name" }] };
    expect(curateEstimate(expanded, { focus: "Skip transient fictional status updates." }).inputTokens)
      .toBeGreaterThan(curateEstimate(snapshot).inputTokens);
  });
  it("excludes rebuild-skipped canonical records before the selection limit and reports counts", () => {
    const path = root();
    seed(path, "fictional-raw", "Host-observed completed turn. Fictional audit envelope.");
    seed(path, "fictional-live", "Morgan completed a fictional task.");
    appendFileSync(join(path, "daily/2026-07-12.md"), [
      "- ◦ Unstructured fictional note.",
      "- – Fictional missing identity.  <!--mem type=note status=open salience=0.6 isInsight=0 created=2026-07-12T09:00:00.000Z refs=-->",
      "",
    ].join("\n"));
    const snapshot = inspectCurateSource(path, 1);
    expect(snapshot.lines.map(({ id }) => id)).toEqual(["fictional-live"]);
    expect(snapshot.skipped).toMatchObject({ raw: 1, unstructured: 1, missingIdentity: 1 });
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
  it("passes a bounded strict schema and preserves dated fictional facts in the prompt", async () => {
    const path = root(); seed(path, "fictional-a", "Morgan reported a balance of 42 on 2026-07-12.");
    const snapshot = inspectCurateSource(path);
    const result = await proposeCurate(snapshot, { id: "fake", complete: async (prompt, opts) => {
      expect(prompt).toContain("Dated amounts");
      expect(prompt).toContain("session exhaust");
      expect(prompt).toContain("tool-progress");
      expect(opts?.structuredResultKey).toBe("proposals");
      expect(opts?.outputSchema).toMatchObject({ required: ["proposals"], properties: { proposals: { minItems: 1, maxItems: 1 } } });
      return JSON.stringify([{ id: "fictional-a", action: "keep" }]);
    } });
    expect(result.proposals).toHaveLength(1);
    const textOnly = await proposeCurate(snapshot, { id: "text-only", complete: async () =>
      JSON.stringify({ proposals: [{ id: "fictional-a", action: "keep" }] }) });
    expect(textOnly.proposals).toHaveLength(1);
  });
  it("retries individual failed batches once and records safe bounded reasons", async () => {
    const path = root();
    for (let index = 0; index < 25; index++) seed(path, `fictional-${index}`, "Morgan recorded a fictional note.");
    const snapshot = inspectCurateSource(path);
    let calls = 0;
    const result = await proposeCurate(snapshot, { id: "fake", complete: async (prompt) => {
      calls++;
      if (calls === 2 || calls === 3) throw new Error("transport unavailable");
      return JSON.stringify((JSON.parse(prompt) as { lines: { id: string }[] }).lines.map(({ id }) => ({ id, action: "keep" })));
    } });
    expect(calls).toBe(4);
    expect(result.discarded).toHaveLength(12);
    expect(result.discarded.every(({ reason }) => reason === "model-error")).toBe(true);
    expect(result.proposals).toHaveLength(13);
    let unavailableCalls = 0;
    await expect(proposeCurate(snapshot, { id: "fake", complete: async () => {
      unavailableCalls++; throw new Error("fetch failed");
    } })).rejects.toThrow("memory-curate: model unavailable");
    expect(unavailableCalls).toBe(2);
    // After one batch succeeded, later outages keep the paid work: failed batches are discarded, not fatal.
    let consecutiveCalls = 0;
    const partial = await proposeCurate({ ...snapshot, lines: [...snapshot.lines, ...snapshot.lines.slice(0, 12)] },
      { id: "fake", complete: async (prompt) => {
        consecutiveCalls++;
        if (consecutiveCalls > 1) throw new Error("model endpoint unavailable");
        return JSON.stringify((JSON.parse(prompt) as { lines: { id: string }[] }).lines.map(({ id }) => ({ id, action: "keep" })));
      } });
    expect(partial.proposals.length).toBeGreaterThan(0);
    expect(partial.discarded.some(({ reason }) => reason === "model-error")).toBe(true);
    await expect(proposeCurate(snapshot, { id: "fake", complete: async () => { throw new Error("unauthorized"); } })).rejects.toThrow("unauthorized");
    let invalidCalls = 0;
    const invalid = await proposeCurate({ ...snapshot, lines: snapshot.lines.slice(0, 1) }, { id: "fake", complete: async () => {
      invalidCalls++; return "not JSON";
    } });
    expect(invalidCalls).toBe(2);
    expect(invalid.discarded).toEqual([{ id: "fictional-0", reason: "invalid-response" }]);
  });
  it("reports validation reason categories without exposing model text", async () => {
    const path = root(); seed(path, "fictional-a", "Morgan made a fictional note.");
    const result = await proposeCurate(inspectCurateSource(path), { id: "fake", complete: async () => JSON.stringify([
      { id: "fictional-a", action: "rewrite", text: "Bad\ntext" },
    ]) });
    expect(result.discarded).toEqual([{ id: "fictional-a", reason: "invalid-text" }]);
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
  it("refuses a canonical but unindexed proposal before backup and retains the original failure after recovery", async () => {
    const { createHash } = await import("node:crypto");
    const { mkdirSync, realpathSync, readdirSync } = await import("node:fs");
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-live", "Morgan finished a fictional task.");
    seed(path, "fictional-raw", "Host-observed completed turn. Fictional audit envelope.");
    const embeddings = fakeEmbeddings(16);
    const rebuilt = await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    expect(rebuilt.skippedRawRecords).toBe(1);
    const fingerprint = createHash("sha256").update(realpathSync(path)).digest("hex");
    const source = { ...inspectCurateSource(path).lines[0]!, id: "fictional-raw",
      text: "Host-observed completed turn. Fictional audit envelope.",
      textHash: createHash("sha256").update("Host-observed completed turn. Fictional audit envelope.").digest("hex") };
    // Use the actual canonical line location, not the index (which correctly omits it).
    const { parseDailyFile } = await import("../grammar.js");
    const { readFileSync } = await import("node:fs");
    const raw = parseDailyFile(readFileSync(join(path, "daily/2026-07-12.md"), "utf8")).lines.find((line) => line.bullet?.id === "fictional-raw")!;
    const proposal = { source: { ...source, line: raw.lineNumber }, action: "drop" as const, reason: "generic-advice" as const, accepted: true };
    const base = { root: path, proposals: [proposal], expectedRootFingerprint: fingerprint,
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("fictional-unindexed").digest("hex"), embeddings, dimension: 16 };
    await expect(applyExplicitMemoryCurate(base)).rejects.toMatchObject({ code: "apply_failed",
      cause: expect.objectContaining({ message: "memory-curate: selected id is not in the active index" }) });
    expect(readdirSync(parent).filter((name) => name.includes("curate-backup"))).toEqual([]);
    const live = inspectCurateSource(path).lines[0]!;
    const failure = new Error("memory-curate: source changed");
    await expect(applyExplicitMemoryCurate({ ...base, proposals: [{ source: live, action: "drop", reason: "generic-advice", accepted: true }],
      hooks: { afterTransactionDurable: () => { throw failure; } } })).rejects.toMatchObject({
      code: "apply_failed_recovered", cause: failure, backupPath: expect.any(String),
    });
  });
  it("accepts unrelated live captures and status changes but rejects changed selected lines before backup", async () => {
    const { mkdirSync, realpathSync, readdirSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { rewriteBullet, readBullet } = await import("../daily.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-a", "Generic example advice.");
    seed(path, "fictional-b", "Morgan wrote a demo note.");
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const originalFingerprint = readBujoCanonicalSourceFingerprint(path);
    const source = inspectCurateSource(path).lines[0]!;
    const proposals = [{ source, action: "drop" as const, reason: "generic-advice" as const, accepted: true }];
    const options = { root: path, proposals, expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
      expectedSourceFingerprint: originalFingerprint, planDigest: createHash("sha256").update("stale-unrelated-plan").digest("hex"),
      embeddings, dimension: 16 };
    rewriteBullet(path, "daily/2026-07-12.md", "fictional-b", { status: "done" });
    seed(path, "fictional-c", "An unrelated later capture.");
    const liveFingerprint = readBujoCanonicalSourceFingerprint(path);
    expect(liveFingerprint).not.toBe(originalFingerprint);
    rewriteBullet(path, source.file, source.id, { status: "done" });
    await expect(applyExplicitMemoryCurate(options)).rejects.toMatchObject({ code: "apply_failed" });
    expect(readdirSync(parent).filter((name) => name.includes("curate-backup"))).toEqual([]);
    rewriteBullet(path, source.file, source.id, { status: "open" });
    expect(readBujoCanonicalSourceFingerprint(path)).toBe(liveFingerprint);
    const applied = await applyExplicitMemoryCurate(options);
    expect(applied.status).toBe("applied");
    const { readDurableRootSwapBackup, MEMORY_CURATE_SWAP_OPERATION } = await import("../durable-root-swap.js");
    expect(readDurableRootSwapBackup(applied.backupPath, MEMORY_CURATE_SWAP_OPERATION).manifest.sourceFingerprint).toBe(liveFingerprint);
    expect(readBullet(path, "daily/2026-07-12.md", "fictional-b")?.status).toBe("done");
    expect(readBullet(path, "daily/2026-07-12.md", "fictional-c")?.text).toBe("An unrelated later capture.");
  });
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

describe("operator entity merges", { timeout: 20_000 }, () => {
  // Fictional: Morgan was captured as two person ids and one concept id.
  const at = "2026-07-12T10:00:00.000Z";
  const morganGraph = {
    entities: [
      { id: "person:morgan", name: "Morgan", type: "person", createdAt: at },
      { id: "person:the-user", name: "the user", type: "person", createdAt: at },
      { id: "concept:morgan", name: "Morgan", type: "concept", createdAt: at },
      { id: "project:maple", name: "Maple", type: "project", createdAt: at },
    ],
    relations: [{ src: "person:the-user", dst: "project:maple", relation: "works on", createdAt: at }],
  };
  const merge = (from: string, to: string, allowCrossType = false) => ({ from, to, allowCrossType, accepted: true });

  it("parses from=to specs, skips comments and refuses malformed or repeated sources", async () => {
    const { parseCurateOperatorMerges } = await import("../curate.js");
    expect(parseCurateOperatorMerges(["# owner", "", "person:the-user=person:morgan", " concept:morgan = person:morgan "], true))
      .toEqual([merge("person:the-user", "person:morgan", true), merge("concept:morgan", "person:morgan", true)]);
    expect(() => parseCurateOperatorMerges(["person:morgan"], false)).toThrow(/invalid operator merge/u);
    expect(() => parseCurateOperatorMerges(["person:morgan=person:morgan"], false)).toThrow(/invalid operator merge/u);
    expect(() => parseCurateOperatorMerges(["a:b=c:d", "a:b=e:f"], false)).toThrow(/conflicting/u);
  });

  it("joins different names, needs explicit cross-type consent and refuses chains, unknown ids and self-relations", async () => {
    const { appendGraphBatch } = await import("../graph.js");
    const { previewCurateMutations } = await import("../curate.js");
    const path = root(); seed(path, "fictional-a", "The user planned the Maple project.");
    appendGraphBatch(path, morganGraph);
    // Different names, same type: the operator's decision is enough; many-to-one is fine.
    expect(() => previewCurateMutations(path, [], undefined, [merge("person:the-user", "person:morgan")])).not.toThrow();
    expect(() => previewCurateMutations(path, [], undefined, [merge("concept:morgan", "person:morgan")]))
      .toThrow(/cross-type merge requires --allow-cross-type/u);
    expect(() => previewCurateMutations(path, [], undefined, [merge("person:the-user", "person:morgan"), merge("concept:morgan", "person:morgan", true)]))
      .not.toThrow();
    expect(() => previewCurateMutations(path, [], undefined, [merge("person:absent", "person:morgan")])).toThrow(/unknown entity/u);
    expect(() => previewCurateMutations(path, [], undefined, [merge("person:the-user", "person:morgan"), merge("person:morgan", "concept:morgan", true)]))
      .toThrow(/conflicting/u);
    // A rejected operator merge is inert.
    expect(() => previewCurateMutations(path, [], undefined, [{ ...merge("person:absent", "person:morgan"), accepted: false }])).not.toThrow();
    expect(() => previewCurateMutations(path, [], undefined, [merge("person:the-user", "project:maple", true)])).toThrow(/self-relation/u);
  });

  it("applies through the root-swap transaction and rebuilds with graph parity", async () => {
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
    const { encodeMemoryLabel, labelsOf } = await import("../labels.js");
    const { rewriteBullet } = await import("../daily.js");
    const parent = root(); const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
    initializeReplayProjection(path);
    seed(path, "fictional-a", "The user was born on 1990-05-17.");
    seed(path, "fictional-b", "Morgan likes the Maple project.");
    const line = inspectCurateSource(path).lines[0]!;
    rewriteBullet(path, line.file, line.id, { refs: [encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:the-user",
      key: "birth_date", value: { type: "date", date: "1990-05-17" }, attribution: "unknown" })] });
    appendGraphBatch(path, { ...morganGraph, associations: [
      { memoryId: "fictional-a", entityId: "person:the-user", provenance: "capture", createdAt: at },
      { memoryId: "fictional-b", entityId: "concept:morgan", provenance: "capture", createdAt: at },
      { memoryId: "fictional-b", entityId: "person:morgan", provenance: "capture", createdAt: at },
    ] });
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const applied = await applyExplicitMemoryCurate({ root: path, proposals: [],
      operatorMerges: [merge("person:the-user", "person:morgan"), merge("concept:morgan", "person:morgan", true)],
      expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path), planDigest: createHash("sha256").update("operator-plan").digest("hex"),
      embeddings, dimension: 16 });
    expect(applied).toMatchObject({ status: "applied", changed: 2 });
    const graph = readCanonicalGraphStrictSnapshot(path).records;
    expect(new Set(graph.entities.map(({ id }) => id))).toEqual(new Set(["person:morgan", "project:maple"]));
    expect(graph.associations.map(({ memoryId, entityId }) => `${memoryId}>${entityId}`).sort())
      .toEqual(["fictional-a>person:morgan", "fictional-b>person:morgan"]);
    expect(graph.relations).toEqual([expect.objectContaining({ src: "person:morgan", dst: "project:maple" })]);
    const bullet = inspectCurateSource(path).lines.find(({ id }) => id === "fictional-a")!;
    expect(labelsOf(bullet as never)).toEqual([expect.objectContaining({ entityId: "person:morgan", key: "birth_date" })]);
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try { expect(auditCanonicalGraphParity(path, db).status).toBe("match"); } finally { db.close(); }
  });
});
