import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendBullet } from "../daily.js";
import { inspectCurateSource, proposeCurate, validateCurateProposal } from "../curate.js";
import { applyExplicitMemoryCurate, restoreExplicitMemoryCurate } from "../explicit-curate.js";
import { parseDailyFile } from "../grammar.js";
import { encodeMemoryLabel, labelsOf, type MemoryLabel } from "../labels.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import { initializeReplayProjection, readBujoCanonicalSourceFingerprint } from "../replay-projection.js";
import { fakeEmbeddings } from "./helpers.js";

const day = "2031-05-17";
const now = `${day}T12:00:00.000Z`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "semantic-fixture-")); roots.push(path); return path; };
describe("reviewed semantic curate", () => {
  it("retypes and reviews existing labels through prepare/apply/backup/restore without inventing attribution or dates", async () => {
    const path = root(); initializeReplayProjection(path);
    const text = "Avery reported a bicycle inspection.";
    const label: MemoryLabel = { v: 1, kind: "fact", entityId: "person:avery", attribution: "user-stated" };
    mkdirSync(join(path, "daily"), { recursive: true, mode: 0o700 });
    appendBullet(path, { id: "LEGACY", type: "note", status: "open", text, createdAt: now, salience: 0.7, isInsight: false, refs: [encodeMemoryLabel(label)] }, new Date(now));
    // Existing subject association is not needed for retaining (rather than inventing) a label.
    const { appendGraphBatch } = await import("../graph.js");
    appendGraphBatch(path, { entities: [{ id: "person:avery", name: "Avery", type: "person", createdAt: now }], relations: [], associations: [] });
    const embeddings = fakeEmbeddings(16); await safeRebuildMemoryIndex({ root: path, tier: "bujo", embeddings, dim: 16 });
    const before = readFileSync(join(path, `daily/${day}.md`));
    const snapshot = inspectCurateSource(path, 10, "oldest", true);
    let prompt = "";
    const result = await proposeCurate(snapshot, { id: "fictional-review", complete: async (value) => {
      prompt = value; return JSON.stringify([{ id: "LEGACY", action: "retype", type: "event", labels: [label] }]);
    } }, { semanticReview: true });
    expect(prompt).toContain("operations reports"); expect(result.discarded).toEqual([]);
    expect(result.proposals[0]).toMatchObject({ accepted: false, type: "event", labels: [label] });
    const rootFingerprint = createHash("sha256").update(realpathSync(path)).digest("hex");
    const applied = await applyExplicitMemoryCurate({ root: path, proposals: result.proposals.map((proposal) => ({ ...proposal, accepted: true })),
      expectedRootFingerprint: rootFingerprint, expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(path),
      planDigest: createHash("sha256").update("fictional-semantic-review").digest("hex"), embeddings, dimension: 16 });
    const [bullet] = parseDailyFile(readFileSync(join(path, `daily/${day}.md`), "utf8")).bullets;
    expect(bullet).toMatchObject({ type: "event", text, createdAt: now }); expect(labelsOf(bullet!)).toEqual([label]);
    await restoreExplicitMemoryCurate({ root: path, backupPath: applied.backupPath, expectedRootFingerprint: rootFingerprint });
    expect(readFileSync(join(path, `daily/${day}.md`))).toEqual(before);
    const proposal = result.proposals[0]!;
    expect(() => validateCurateProposal({ ...proposal, type: undefined } as unknown as typeof proposal)).toThrow();
    expect(() => validateCurateProposal({ ...proposal, type: "note" })).toThrow("memory_curate_retype_unchanged");
    expect(() => validateCurateProposal({ ...proposal, labels: [{ ...label, attribution: "unknown" }] })).toThrow();
    expect(() => validateCurateProposal({ ...proposal, labels: [] })).not.toThrow();
  });
});
