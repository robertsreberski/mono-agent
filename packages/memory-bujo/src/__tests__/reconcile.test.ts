import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "@mono-agent/memory-store";
import { afterEach, describe, expect, it } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { createIdFactory } from "../ids.js";
import { reconcile, type ReconcileDeps } from "../reconcile.js";
import type { Bullet, CandidateMemory } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2026-06-15T12:00:00.000Z");

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-reconcile-"));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

/** Seed an existing memory: append a bullet to the daily file AND upsert the index record. */
async function seed(
  db: MemoryDb,
  root: string,
  id: string,
  text: string,
  opts: { type?: Bullet["type"]; salience?: number; isInsight?: boolean } = {},
): Promise<void> {
  const type = opts.type ?? "note";
  const bullet: Bullet = {
    id,
    type,
    status: "open",
    text,
    salience: opts.salience ?? 0.5,
    isInsight: opts.isInsight ?? false,
    createdAt: FIXED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  const record: MemoryRecord = {
    id,
    type,
    status: "open",
    text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, FIXED)) },
  };
  await db.upsert(record);
}

function makeDeps(
  db: MemoryDb,
  root: string,
  llm: ReconcileDeps["llm"],
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  return {
    db,
    root,
    llm,
    nextId: createIdFactory({ clock: () => FIXED, random: () => 0 }),
    now: () => FIXED,
    ...overrides,
  };
}

function dailyContent(root: string): string {
  return readFileSync(dailyFilePath(root, FIXED), "utf8");
}

describe("reconcile", () => {
  it("case 1 — novel candidate (no similar) → ADD", async () => {
    const root = newRoot();
    const db = openDb(root);
    // Seed one unrelated memory so the db is non-empty but dissimilar to the candidate.
    await seed(db, root, "SEED1", "the cat slept on the warm windowsill");

    // An LLM that would say "noop" if ever consulted — proves the ADD path skips the LLM.
    const llm = fakeLlm([["CLASSIFY", '{"action":"noop","targetId":"SEED1"}']]);
    const candidate: CandidateMemory = {
      type: "task",
      // Shares no tokens with the seed → nearest distance comfortably above dupThreshold → ADD, no LLM.
      text: "deploy quarterly revenue forecast spreadsheet",
      salience: 0.8,
      isInsight: false,
    };
    const before = db.count();
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("add");
    const newId = actions[0]?.kind === "add" ? actions[0].id : "";
    expect(newId).not.toBe("");
    expect(db.count()).toBe(before + 1);

    const added = db.get(newId);
    expect(added?.status).toBe("open");
    expect(added?.text).toBe(candidate.text);
    expect(added?.type).toBe("task");

    // Recallable.
    const hits = await db.recall("quarterly revenue forecast", { topK: 5 });
    expect(hits.some((h) => h.record.id === newId)).toBe(true);

    // Daily file contains the new bullet line.
    const parsed = parseDailyFile(dailyContent(root));
    expect(parsed.bullets.some((b) => b.id === newId && b.text === candidate.text)).toBe(true);
  });

  it("case 2 — duplicate candidate + LLM says noop → no write", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "DUP1", "ship the phase two reconcile engine across markdown and index");

    const llm = fakeLlm([["CLASSIFY", '{"action":"noop","targetId":"DUP1"}']]);
    const candidate: CandidateMemory = {
      type: "task",
      // Shares most tokens with DUP1 → close under fakeEmbeddings → triggers LLM path.
      text: "ship the phase two reconcile engine across markdown and index now",
      salience: 0.6,
      isInsight: false,
    };
    const before = db.count();
    // Distance ~0.04 (shares nearly all tokens with DUP1) → well under the default dupThreshold → LLM path.
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toEqual([{ kind: "noop", id: "DUP1" }]);
    expect(db.count()).toBe(before); // no new memory
    // The seeded memory is untouched.
    expect(db.get("DUP1")?.status).toBe("open");
    // No second bullet was appended for this text.
    const parsed = parseDailyFile(dailyContent(root));
    expect(parsed.bullets).toHaveLength(1);
  });

  it("case 3 — contradicting candidate + LLM says supersede → old invalidated, new added", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "OLD1", "the launch date is scheduled for july fifteenth this year");

    const newText = "the launch date moved to august first this year";
    const llm = fakeLlm([["CLASSIFY", `{"action":"supersede","targetId":"OLD1","text":"${newText}"}`]]);
    const candidate: CandidateMemory = {
      type: "note",
      text: "the launch date is now august first this year not july",
      salience: 0.7,
      isInsight: false,
    };
    // Distance ~0.25 to OLD1 → under the default dupThreshold → LLM path.
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.kind).toBe("supersede");
    const newId = action?.kind === "supersede" ? action.newId : "";
    expect(action?.kind === "supersede" ? action.oldId : "").toBe("OLD1");

    // Old invalidated in the index.
    expect(db.get("OLD1")?.status).toBe("invalidated");
    expect(db.get("OLD1")?.supersededBy).toBe(newId);

    // New memory added & open.
    const added = db.get(newId);
    expect(added?.status).toBe("open");
    expect(added?.text).toBe(newText);

    // A supersedes edge exists (OLD1 -> newId).
    const edges = db.edges("OLD1");
    expect(edges.some((e) => e.kind === "supersedes" && e.dst === newId)).toBe(true);

    // Old's daily line re-parses as invalidated status.
    const parsed = parseDailyFile(dailyContent(root));
    const oldBullet = parsed.bullets.find((b) => b.id === "OLD1");
    expect(oldBullet?.status).toBe("invalidated");
    // New bullet present too.
    expect(parsed.bullets.some((b) => b.id === newId && b.text === newText)).toBe(true);
  });

  it("case 4 — refinement candidate + LLM says update → target text merged, count unchanged", async () => {
    const root = newRoot();
    const db = openDb(root);
    await seed(db, root, "UPD1", "morgan prefers opt in memory capture");

    const merged = "morgan prefers opt in memory capture with manual review";
    const llm = fakeLlm([["CLASSIFY", `{"action":"update","targetId":"UPD1","text":"${merged}"}`]]);
    const candidate: CandidateMemory = {
      type: "note",
      text: "morgan prefers opt in memory capture and manual review",
      salience: 0.6,
      isInsight: false,
    };
    const before = db.count();
    // Distance ~0.18 to UPD1 → under the default dupThreshold → LLM path.
    const actions = await reconcile([candidate], makeDeps(db, root, llm));

    expect(actions).toEqual([{ kind: "update", id: "UPD1" }]);
    expect(db.count()).toBe(before); // no new memory
    expect(db.get("UPD1")?.text).toBe(merged);
    expect(db.get("UPD1")?.status).toBe("open"); // still open
    // Re-embedded: recall on the merged-only tokens finds it.
    const hits = await db.recall("manual review", { topK: 5 });
    expect(hits.some((h) => h.record.id === "UPD1")).toBe(true);

    // Target's daily line re-parses with merged text.
    const parsed = parseDailyFile(dailyContent(root));
    expect(parsed.bullets.find((b) => b.id === "UPD1")?.text).toBe(merged);
  });

  it("case 5 — per-candidate isolation: a candidate whose write throws is skipped, others proceed", async () => {
    const root = newRoot();
    const db = openDb(root);
    // Index record whose canonical daily file is MISSING (simulated index/markdown divergence).
    await db.upsert({
      id: "GHOST", type: "note", status: "open", text: "morgan prefers opt in memory capture",
      salience: 0.5, isInsight: false, createdAt: FIXED.toISOString(), accessCount: 0, tags: [],
      source: { file: "daily/2099-01-01.md" },
    });
    // First candidate is similar to GHOST; LLM says "update" → rewriteBullet reads the missing file → throws.
    // Second candidate is novel → must still be ADDed despite the first failing.
    const llm = fakeLlm([["CLASSIFY", '{"action":"update","targetId":"GHOST","text":"merged text here"}']]);
    const failing: CandidateMemory = { type: "note", text: "morgan prefers opt in memory capture and review", salience: 0.6, isInsight: false };
    const novel: CandidateMemory = { type: "task", text: "schedule the offsite logistics budget", salience: 0.7, isInsight: false };

    const actions = await reconcile([failing, novel], makeDeps(db, root, llm));

    // The failing candidate produced no action; the novel one was added — and reconcile did not throw.
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("add");
    const newId = actions[0]?.kind === "add" ? actions[0].id : "";
    expect(db.get(newId)?.text).toBe(novel.text);
    // GHOST was not partially mutated by the failed update (rewriteBullet threw before the index write).
    expect(db.get("GHOST")?.status).toBe("open");
  });

  it("case 6 — surfaces an embedding-model failure (findSimilar throws) instead of isolating it", async () => {
    const root = newRoot();
    const db = openDb(root);
    // Simulate the embedding model being down: findSimilar embeds the query, so it throws for EVERY
    // candidate. That is a systemic model outage, not a per-item data problem — it must surface, not
    // be swallowed by per-candidate isolation (which would make a dead embedder look like a no-op).
    db.findSimilar = async () => { throw new Error("ollama embeddings 500"); };
    const candidate: CandidateMemory = { type: "note", text: "anything worth remembering", salience: 0.5, isInsight: false };
    await expect(reconcile([candidate], makeDeps(db, root, fakeLlm([])))).rejects.toThrow(/embedding/i);
  });

  it("case 7 — surfaces an LLM failure from classify instead of silently falling back to ADD", async () => {
    const root = newRoot();
    const db = openDb(root);
    // A near-duplicate forces the LLM classify path; a thrown error there must surface, not degrade
    // to a silent ADD that hides a dead model.
    await seed(db, root, "DUP1", "ship the phase two reconcile engine across markdown and index");
    const throwingLlm = { id: "throws", complete: async () => { throw new Error("ollama 500"); } };
    const candidate: CandidateMemory = {
      type: "task",
      text: "ship the phase two reconcile engine across markdown and index now",
      salience: 0.6,
      isInsight: false,
    };
    await expect(reconcile([candidate], makeDeps(db, root, throwingLlm))).rejects.toThrow(/classif/i);
  });
});
