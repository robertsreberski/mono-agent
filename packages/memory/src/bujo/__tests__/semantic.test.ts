import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import type { MemoryLabelHit } from "../../store/db-labels.js";
import { appendBullet, rewriteBullet } from "../daily.js";
import { inspectCurateSource, proposeCurate, validateCurateProposal } from "../curate.js";
import { applyExplicitMemoryCurate, restoreExplicitMemoryCurate } from "../explicit-curate.js";
import { parseDailyFile } from "../grammar.js";
import { encodeMemoryLabel, labelsOf, type MemoryLabel } from "../labels.js";
import { assertCanonicalGraphRepairBaseParity, safeRebuildMemoryIndex } from "../rebuild.js";
import { initializeReplayProjection, readBujoCanonicalSourceFingerprint } from "../replay-projection.js";
import { composeRecallBlock, selectPossiblyRelevantRecallHits } from "../recall.js";
import { reconcileBatch, type ReconcileDeps } from "../reconcile.js";
import { semanticRecallAuthorities } from "../semantic.js";
import { fakeEmbeddings } from "./helpers.js";

const day = "2031-05-17";
const now = `${day}T12:00:00.000Z`;
const roots: string[] = [];
const dbs: MemoryDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "semantic-fixture-")); roots.push(path); return path; };
const fact = (attribution: "user-stated" | "assistant-inferred" | "unknown" = "user-stated"): MemoryLabel =>
  ({ v: 1, kind: "fact", entityId: "person:owner", attribution });
const labelHit = (id: string, label = fact(), overrides: Partial<MemoryLabelHit> = {}): MemoryLabelHit =>
  ({ memoryId: id, ordinal: 0, label, text: id, status: "open", type: "note", active: true, conflict: false, createdAt: now, ...overrides });
const hit = (id: string, score = 0.9, type: "note" | "event" = "note") => ({ score, record: { id, text: id, type, status: "open" as const, createdAt: now } });

// Fictional annotations exercise production contracts, not real-model quality.
const durable = [
  ["Owner repairs bicycles.", "Owner prefers numbered instructions."],
  ["Właściciel naprawia rowery.", "Właściciel woli numerowane instrukcje."],
  ["Il proprietario ripara biciclette.", "Il proprietario preferisce istruzioni numerate."],
  ["La persona propietaria repara bicicletas.", "Prefiere instrucciones numeradas."],
];

describe("semantic eligibility and authority", () => {
  it("retains 8/8 multilingual annotated owner facts/preferences (baseline 8/8), never episodes or unknowns", () => {
    let baseline = 0; let semantic = 0;
    for (const [knowledge, preference] of durable) {
      const rows = [hit(knowledge!), hit(preference!, 0.89), hit("episode", 0.88, "event"), hit("unknown", 0.88)];
      const labels = [labelHit(knowledge!), labelHit(preference!, { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" }),
        labelHit("episode", fact(), { type: "event" }), labelHit("unknown", fact("unknown"))];
      const selected = selectPossiblyRelevantRecallHits(rows, { semanticAuthorities: semanticRecallAuthorities(labels, () => labels, day) });
      baseline += selectPossiblyRelevantRecallHits(rows).filter((row) => row.record.id === knowledge || row.record.id === preference).length;
      semantic += selected.filter((row) => row.record.id === knowledge || row.record.id === preference).length;
      expect(selected.map((row) => row.record.id)).toEqual([knowledge, preference]);
    }
    expect({ baseline, semantic, annotated: 8, yield: semantic / 8, delta: (semantic - baseline) / 8 }).toEqual({ baseline: 8, semantic: 8, annotated: 8, yield: 1, delta: 0 });
  });

  it("prefers user-stated only inside the existing score window; current labels/notes are required", () => {
    const rows = [hit("inferred", 0.92), hit("user", 0.91), hit("user-outside", 0.87)];
    const labels = [labelHit("inferred", fact("assistant-inferred")), labelHit("user"), labelHit("user-outside")];
    const semanticAuthorities = semanticRecallAuthorities(labels, () => [], day);
    expect(selectPossiblyRelevantRecallHits(rows, { semanticAuthorities, maxLines: 1 }).map((row) => row.record.id)).toEqual(["user"]);
    for (const override of [{ type: "event" }, { type: "task" }, { status: "done" }, { status: "scheduled" }, { status: "migrated" },
      { active: false }, { validTo: "2031-05-16" }, { supersededBy: "other" }] as Partial<MemoryLabelHit>[]) {
      expect(semanticRecallAuthorities([labelHit("ineligible", fact(), override)], () => [], day).size).toBe(0);
    }
    expect(semanticRecallAuthorities([labelHit("unverified", { v: 1, kind: "lesson", scope: "agent", verified: false })], () => [], day).size).toBe(0);
    expect(semanticRecallAuthorities([labelHit("verified", { v: 1, kind: "lesson", scope: "agent", verified: true })], () => [], day).has("verified")).toBe(true);
  });

  it("omits equal-authority structured conflicts, even beyond the score window, but does not erase a stronger owner anchor", () => {
    const property = (value: string, attribution: "user-stated" | "assistant-inferred" = "user-stated"): MemoryLabel =>
      ({ v: 1, kind: "fact", entityId: "person:owner", key: "preferred_name", value: { type: "text", text: value }, attribution });
    const a = labelHit("a", property("Avery")); const b = labelHit("b", property("Morgan"));
    expect(semanticRecallAuthorities([a], () => [a, b], day).size).toBe(0);
    const inferred = labelHit("b", property("Morgan", "assistant-inferred"));
    expect([...semanticRecallAuthorities([a, inferred], () => [a, inferred], day).keys()]).toEqual(["a"]);
    expect([...semanticRecallAuthorities([a], () => [a, { ...b, active: false }], day).keys()]).toEqual(["a"]);
    const future = labelHit("future", { ...property("Morgan"), validFrom: "2031-05-18" } as MemoryLabel);
    expect([...semanticRecallAuthorities([a], () => [a, future], day).keys()]).toEqual(["a"]);
  });

  it("measures candidate starvation without widening the fifty-hit budget or the reference score", () => {
    const notes = [hit("note-a", 0.89), hit("note-b", 0.88)];
    const labels = notes.map((row) => labelHit(row.record.id));
    const semanticAuthorities = semanticRecallAuthorities(labels, () => [], day);
    const noise = Array.from({ length: 50 }, (_, index) => hit(`event-${index}`, 0.9, "event"));
    const available = selectPossiblyRelevantRecallHits([...noise.slice(0, 48), ...notes].slice(0, 50), { semanticAuthorities });
    const starved = selectPossiblyRelevantRecallHits([...noise, ...notes].slice(0, 50), { semanticAuthorities });
    const outsideWindow = selectPossiblyRelevantRecallHits([hit("event", 0.95, "event"), ...notes], { semanticAuthorities });
    expect({ relevant: 2, available: available.length, lossWithinSuperset: 2 - available.length,
      lossOutsideFifty: 2 - starved.length, lossBelowWindow: 2 - outsideWindow.length })
      .toEqual({ relevant: 2, available: 2, lossWithinSuperset: 0, lossOutsideFifty: 2, lossBelowWindow: 2 });
  });

  it("standalone automatic composition filters events/unknowns but leaves raw deliberate hits intact", async () => {
    const rows = [hit("episode", 0.9, "event"), hit("knowledge", 0.89), hit("unknown", 0.88)];
    const labels = [labelHit("episode", fact(), { type: "event" }), labelHit("knowledge")];
    const requests: unknown[] = [];
    const db = { recallWithOutcome: async (_q: string, options: unknown) => { requests.push(options); return { retrievalMode: "hybrid", hits: rows }; },
      labelsForMemories: () => labels, labelsForEntity: () => labels, recordAccess: () => {} } as unknown as MemoryDb;
    const block = await composeRecallBlock(db, "fictional query", { semanticOnly: true, asOf: day });
    expect(block?.content).toContain("knowledge"); expect(block?.content).not.toMatch(/episode|unknown/u);
    expect(block?.traceContent).toBe(false); expect(rows).toHaveLength(3); expect(requests[0]).toMatchObject({ topK: 50 });
  });
});

async function authorityFixture() {
  const path = root(); const db = openMemoryDb({ path: join(path, "memory.db"), embeddings: fakeEmbeddings(16), dim: 16 }); dbs.push(db);
  const createdAt = "2031-05-16T12:00:00.000Z";
  const text = "Owner prefers numbered bicycle repair instructions.";
  const label: MemoryLabel = { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" };
  appendBullet(path, { id: "OLD", type: "note", status: "open", text, createdAt, salience: 0.8, isInsight: false, refs: [encodeMemoryLabel(label)] }, new Date(createdAt));
  const record: MemoryRecord = { id: "OLD", type: "note", status: "open", text, createdAt, salience: 0.8, isInsight: false, accessCount: 0, tags: [], source: { file: "daily/2031-05-16.md" } };
  await db.upsert(record); db.replaceMemoryLabels("OLD", [label]);
  db.findSimilarMany = async (texts) => texts.map(() => [{ record: db.get("OLD")!, distance: 0.1 }]);
  let next = 0; let prompt = "";
  const deps = (action: string, source: "user" | "assistant" = "assistant", semanticOnly = true): ReconcileDeps => ({
    root: path, db, semanticOnly, strictModelOutput: true, canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity, nextId: () => `NEW-${++next}`, now: () => new Date(now),
    captureSpeakerKind: "human-turn", captureEvidence: { ownerTurn: true, userText: "Owner prefers prose instructions.", toolOutcomes: [] },
    labelsForAction: (_action, candidate) => candidate.labels ?? [],
    llm: { id: "fictional-authority", complete: async (value) => { prompt = value; return JSON.stringify([{ index: 0, action, ...(action === "add" ? {} : { targetId: "OLD", text: "Owner prefers prose instructions." }) }]); } },
  });
  const candidate = (source: "user" | "assistant") => ({ type: "note" as const, text: "Owner prefers prose instructions.", source,
    salience: 0.8, isInsight: false, labels: [{ ...label, attribution: source === "user" ? "user-stated" as const : "assistant-inferred" as const }] });
  return { path, db, deps, candidate, prompt: () => prompt };
}

describe("host reconciliation authority", () => {
  it.each(["assistant", "tool", "document", "user", undefined] as const)("protects user-stated content against unaccepted source %s", async (source) => {
    const f = await authorityFixture();
    const proposed = { ...f.candidate("assistant"), ...(source === undefined ? { source: undefined } : { source }) };
    const { source: _source, ...withoutSource } = proposed;
    const candidate = source === undefined ? withoutSource : { ...withoutSource, source };
    const actions = await reconcileBatch([candidate], f.deps("update"));
    expect(actions[0]?.kind).toBe("add"); expect(f.db.get("OLD")?.status).toBe("open");
    expect(f.db.labelsForMemories(["NEW-1"])).toEqual([]);
  });

  it.each(durable)("protects multilingual owner content without grammar gates: %s", async (_fact, preference) => {
    const f = await authorityFixture(); const candidate = { ...f.candidate("assistant"), text: preference! };
    const actions = await reconcileBatch([candidate], f.deps("supersede"));
    expect(actions[0]?.kind).toBe("add"); expect(f.db.get("OLD")?.status).toBe("open");
  });

  it.each(["update", "supersede", "add"])("never lets inferred %s overwrite or automatically assert against owner content", async (action) => {
    const f = await authorityFixture(); const before = readFileSync(join(f.path, "daily/2031-05-16.md"));
    const actions = await reconcileBatch([f.candidate("assistant")], f.deps(action));
    expect(actions[0]?.kind).toBe("add"); expect(f.db.get("OLD")?.status).toBe("open");
    expect(readFileSync(join(f.path, "daily/2031-05-16.md"))).toEqual(before);
    expect(f.db.labelsForMemories(["NEW-1"])).toEqual([]);
    expect(f.prompt()).toContain('"attribution":"user-stated"'); expect(f.prompt()).toContain('"captureEvidence"');
  });

  it("protects user-stated coarse facts too, without suppressing genuinely novel inferred labels", async () => {
    const f = await authorityFixture(); const oldLabel = fact();
    rewriteBullet(f.path, "daily/2031-05-16.md", "OLD", { refs: [encodeMemoryLabel(oldLabel)] });
    f.db.replaceMemoryLabels("OLD", [oldLabel]);
    expect((await reconcileBatch([f.candidate("assistant")], f.deps("supersede")))[0]?.kind).toBe("add");
    expect(f.db.get("OLD")?.status).toBe("open");
    f.db.findSimilarMany = async () => [[{ record: f.db.get("OLD")!, distance: 0.9 }]];
    const novel = { ...f.candidate("assistant"), text: "Avery repairs pottery wheels.",
      labels: [{ v: 1 as const, kind: "fact" as const, entityId: "person:avery", attribution: "assistant-inferred" as const }] };
    expect((await reconcileBatch([novel], f.deps("add")))[0]?.kind).toBe("add");
    expect(f.db.labelsForMemories(["NEW-2"])[0]?.label).toEqual(novel.labels[0]);
  });

  it("allows a supported newer user supersession and keeps legacy flags-off mutation behavior", async () => {
    for (const enabled of [true, false]) {
      const f = await authorityFixture();
      const actions = await reconcileBatch([f.candidate(enabled ? "user" : "assistant")], f.deps(enabled ? "supersede" : "update", "user", enabled));
      expect(actions[0]?.kind).toBe(enabled ? "supersede" : "update");
      expect(f.db.get("OLD")?.status).toBe(enabled ? "invalidated" : "open");
    }
  });

  it("final classifier fallback ADD has no inferred semantic authority", async () => {
    const f = await authorityFixture(); const d = f.deps("add");
    await reconcileBatch([f.candidate("assistant")], { ...d, fallbackOnClassifierFailure: true, isFinalCaptureAttempt: true,
      llm: { id: "fictional-failure", complete: async () => { throw new Error("fictional failure"); } } });
    expect(f.db.get("NEW-1")?.text).toBe(f.candidate("assistant").text);
    expect(f.db.labelsForMemories(["NEW-1"])).toEqual([]); expect(f.db.get("OLD")?.status).toBe("open");
  });
});

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
