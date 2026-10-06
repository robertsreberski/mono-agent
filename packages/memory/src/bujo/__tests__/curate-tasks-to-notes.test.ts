import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBullet } from "../daily.js";
import { previewCurateMutations, proposeCurate, proposeTasksToNotes, validateCurateProposal, type CurateProposal } from "../curate.js";
import { parseDailyFile } from "../grammar.js";
import { encodeMemoryLabel } from "../labels.js";
import type { Bullet } from "../types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const july = "2026-07-12T10:00:00.000Z";
const september = "2026-09-20T10:00:00.000Z";
const fact = encodeMemoryLabel({ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" });

function memoryRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "curate-tasks-fixture-")); roots.push(parent);
  const path = join(parent, "memory"); mkdirSync(path, { mode: 0o700 });
  return path;
}
function seed(path: string, id: string, text: string, type: Bullet["type"], status: Bullet["status"], createdAt = july,
  refs: string[] = []): void {
  appendBullet(path, { id, text, type, status, salience: 0.6, isInsight: false, createdAt, refs }, new Date(createdAt));
}
function bullets(path: string, day = "2026-07-12"): Bullet[] {
  return parseDailyFile(readFileSync(join(path, "daily", `${day}.md`), "utf8")).bullets;
}

describe("curate --tasks-to-notes", () => {
  it("proposes only open task lines, in any language, and never done, dropped or superseded ones", () => {
    const path = memoryRoot();
    seed(path, "C-open-en", "Renew the Maple lease for Morgan.", "task", "open", july, [fact]);
    seed(path, "C-open-pl", "Odnowić umowę Maple.", "task", "open");
    seed(path, "C-open-es", "Renovar el contrato de Maple.", "task", "open");
    seed(path, "C-done", "Water the Maple garden.", "task", "done");
    seed(path, "C-dropped", "Call the Maple office.", "task", "dropped");
    seed(path, "C-superseded", "Book the Maple room.", "task", "invalidated");
    seed(path, "C-note", "Morgan was born 2000-01-01.", "note", "open");
    seed(path, "C-event", "Morgan moved into the Maple flat.", "event", "open");
    const scan = proposeTasksToNotes(path);
    expect(scan.proposals.map(({ source }) => source.id)).toEqual(["C-open-en", "C-open-pl", "C-open-es"]);
    expect(scan.counts).toEqual({ openTasks: 3, proposed: 3, outsideWindow: 0, notCapture: 0 });
    for (const proposal of scan.proposals) {
      expect(proposal).toMatchObject({ action: "retype", accepted: false });
      expect(proposal.reason ?? proposal.text ?? proposal.labels).toBeUndefined();
    }
    expect(() => previewCurateMutations(path, scan.proposals)).not.toThrow();
  });

  it("limits the window by creation date and to automatic-capture ids", () => {
    const path = memoryRoot();
    seed(path, "C-old", "Renew the Maple lease.", "task", "open", july);
    seed(path, "C-new", "Renew the Maple insurance.", "task", "open", september);
    seed(path, "OPERATOR-1", "Pay the Maple invoice.", "task", "open", july);
    const scan = proposeTasksToNotes(path, { before: new Date("2026-09-01"), captureOnly: true });
    expect(scan.proposals.map(({ source }) => source.id)).toEqual(["C-old"]);
    expect(scan.counts).toEqual({ openTasks: 3, proposed: 1, outsideWindow: 1, notCapture: 1 });
    expect(() => proposeTasksToNotes(path, { before: new Date("not a date") })).toThrow(/before/u);
  });

  it("rejects a retype that is not an open task and any second proposal for the same id", () => {
    const path = memoryRoot();
    seed(path, "C-task", "Renew the Maple lease.", "task", "open");
    seed(path, "C-note", "Morgan likes the Maple flat.", "note", "open");
    const [retype] = proposeTasksToNotes(path).proposals;
    const drop: CurateProposal = { ...retype!, action: "drop", reason: "transient-status" };
    expect(() => previewCurateMutations(path, [retype!, drop])).toThrow(/duplicate/u);
    expect(() => previewCurateMutations(path, [drop, retype!])).toThrow(/duplicate/u);
    const noteSource = { ...retype!.source, id: "C-note", line: retype!.source.line + 2, text: "Morgan likes the Maple flat.",
      textHash: createHash("sha256").update("Morgan likes the Maple flat.").digest("hex") };
    expect(() => previewCurateMutations(path, [{ source: noteSource, action: "retype", accepted: true }])).toThrow(/open task/u);
    expect(() => validateCurateProposal({ ...retype!, source: { ...retype!.source, status: "done" } })).toThrow(/invalid proposal/u);
    expect(() => validateCurateProposal({ ...retype!, reason: "duplicate" })).toThrow(/invalid proposal/u);
  });

  it("never lets a curate model propose a retype", async () => {
    const path = memoryRoot();
    seed(path, "C-task", "Renew the Maple lease.", "task", "open");
    const { inspectCurateSource } = await import("../curate.js");
    const snapshot = inspectCurateSource(path, 10);
    let schema: unknown;
    const result = await proposeCurate(snapshot, { id: "fictional-curate", complete: async (_prompt, options) => {
      schema = options?.outputSchema;
      return JSON.stringify([{ id: "C-task", action: "retype" }]);
    } });
    expect(result.proposals).toEqual([]);
    expect(result.discarded).toEqual([{ id: "C-task", reason: "invalid-action" }]);
    expect(JSON.stringify(schema)).not.toContain("retype");
  });

  it("applies through the root-swap keeping id, text, date and labels, and restores", async () => {
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate, restoreExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const { resolveActiveMemoryDbPath } = await import("../generations.js");
    const path = memoryRoot();
    initializeReplayProjection(path);
    seed(path, "C-task", "Renew the Maple lease for Morgan.", "task", "open", july, [fact]);
    seed(path, "C-done", "Water the Maple garden.", "task", "done");
    const before = bullets(path);
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const rootFingerprint = createHash("sha256").update(realpathSync(path)).digest("hex");
    const proposals = proposeTasksToNotes(path).proposals.map((proposal) => ({ ...proposal, accepted: true }));
    const applied = await applyExplicitMemoryCurate({ root: path, proposals,
      expectedRootFingerprint: rootFingerprint, expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("tasks-to-notes-plan").digest("hex"), embeddings, dimension: 16 });
    expect(applied).toMatchObject({ status: "applied", changed: 1 });
    const after = bullets(path);
    expect(after.find(({ id }) => id === "C-task")).toEqual({ ...before.find(({ id }) => id === "C-task"), type: "note" });
    expect(after.find(({ id }) => id === "C-done")).toEqual(before.find(({ id }) => id === "C-done"));
    expect(readFileSync(join(path, "daily", "2026-07-12.md"), "utf8")).toContain("- – Renew the Maple lease for Morgan.");
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), readOnly: true, dim: 16 });
    try {
      expect(db.get("C-task")).toMatchObject({ type: "note", status: "open", text: "Renew the Maple lease for Morgan.", createdAt: july });
      expect(db.labelsForEntity("person:morgan").map(({ memoryId }) => memoryId)).toEqual(["C-task"]);
    } finally { db.close(); }
    expect(proposeTasksToNotes(path).proposals).toEqual([]);
    await restoreExplicitMemoryCurate({ root: path, backupPath: applied.backupPath, expectedRootFingerprint: rootFingerprint });
    expect(bullets(path)).toEqual(before);
  });

  it("keeps a retyped line searchable by recall after the post-apply rebuild", async () => {
    const { initializeReplayProjection, readBujoCanonicalSourceFingerprint } = await import("../replay-projection.js");
    const { safeRebuildMemoryIndex } = await import("../rebuild.js");
    const { fakeEmbeddings } = await import("./helpers.js");
    const { applyExplicitMemoryCurate } = await import("../explicit-curate.js");
    const { openMemoryDb } = await import("../../store/index.js");
    const { resolveActiveMemoryDbPath } = await import("../generations.js");
    const path = memoryRoot();
    initializeReplayProjection(path);
    seed(path, "C-task", "Renew the Maple lease for Morgan.", "task", "open");
    seed(path, "C-note", "Morgan was born 2000-01-01.", "note", "open");
    const embeddings = fakeEmbeddings(16);
    await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const proposals = proposeTasksToNotes(path).proposals.map((proposal) => ({ ...proposal, accepted: true }));
    await applyExplicitMemoryCurate({ root: path, proposals,
      expectedRootFingerprint: createHash("sha256").update(realpathSync(path)).digest("hex"),
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("tasks-to-notes-recall").digest("hex"), embeddings, dimension: 16 });
    const db = openMemoryDb({ path: resolveActiveMemoryDbPath(path), embeddings, dim: 16 });
    try {
      const hits = await db.recall("Renew the Maple lease for Morgan.", { topK: 5 });
      expect(hits[0]?.record).toMatchObject({ id: "C-task", type: "note", status: "open" });
    } finally { db.close(); }
  });
});
