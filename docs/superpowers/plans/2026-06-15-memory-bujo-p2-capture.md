# Memory v2 — Phase 2: Capture Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the LLM-backed write path — distill turn text into atomic typed memories, reconcile them against existing memories (ADD / UPDATE / SUPERSEDE / NOOP, mem0-style), thread them to neighbors, and extract typed entities into a canonical `graph.jsonl` that the index mirrors and `rebuildFromMarkdown` ingests.

**Architecture:** The LLM is an **injected `LlmComplete` interface** (text-in/text-out), so `memory-bujo` stays `context`-category and runtime-agnostic (P4 wires a real runtime adapter; tests use a deterministic `FakeLlm`). `memory-store` gains `findSimilar` (vector KNN for dedup) and entity-repository methods over the `entities`/`entity_relations` tables that already exist in the P1 schema. `memory-bujo` gains `distill`, `reconcile`, `extractEntities`, a `graph.jsonl` reader/writer, a markdown bullet-rewrite helper (UPDATE/SUPERSEDE must edit canonical daily files), and a `captureTurn` orchestrator; `BujoMemoryStore` gains an optional `llm` and a `capture()` method. Canonical-markdown invariant is preserved: every memory mutation edits the daily file AND the index; entities live canonically in `graph.jsonl`.

**Tech Stack:** TypeScript ESM/NodeNext, strict TS, vitest. Builds on P1 packages `@mono-agent/memory-store` and `@mono-agent/memory-bujo` (branch `feat/memory-bujo`).

**Plan-code convention:** interfaces and test cases are given in full (they define behavior and are the acceptance contract). Implementations show the key logic; the implementer completes them to satisfy the tests + the per-task self-review, following the existing code's idioms (conditional spreads for `exactOptionalPropertyTypes`, `BigInt` vec rowids, no async inside `db.transaction`).

---

## Task 1: `memory-store` — `findSimilar(text, k)` for reconciliation

**Files:** Modify `packages/memory-store/src/{db.ts,types.ts,index.ts}`; Test `packages/memory-store/src/__tests__/similar.test.ts`.

- [ ] **Step 1: add `SimilarHit` to `types.ts`**
```ts
export interface SimilarHit {
  readonly record: MemoryRecord;
  readonly distance: number; // cosine distance from sqlite-vec (0 = identical)
}
```

- [ ] **Step 2: failing test `similar.test.ts`**
```ts
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {}, ...over };
}

describe("findSimilar", () => {
  it("returns nearest live memories by vector distance, closest first", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "robert lives in lisbon"));
    await db.upsert(note("b", "the weather is sunny today"));
    await db.upsert(note("c", "robert moved to lisbon last year"));
    const hits = await db.findSimilar("robert lisbon home", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(["a", "c"]).toContain(hits[0]?.record.id); // a robert/lisbon memory is nearest
    expect(hits[0]?.distance).toBeLessThanOrEqual(hits[hits.length - 1]?.distance ?? 1);
    db.close();
  });

  it("excludes invalidated/dropped memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("old", "robert lisbon", { status: "invalidated" }));
    await db.upsert(note("live", "robert lisbon"));
    const hits = await db.findSimilar("robert lisbon", 5);
    expect(hits.map((h) => h.record.id)).toEqual(["live"]);
    db.close();
  });
});
```

- [ ] **Step 3: implement `findSimilar` in `db.ts`** (embed the text as a *document* — same space as stored docs — then vec KNN, join records, drop invalidated/dropped):
```ts
async findSimilar(text: string, k = 5): Promise<SimilarHit[]> {
  const [vector] = await this.embeddings.embed([`search_document: ${text}`]);
  if (vector === undefined) return [];
  const rows = this.db
    .prepare(`SELECT m.id AS id, v.distance AS distance FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`)
    .all(toBlob(vector), k + 8) as { id: string; distance: number }[]; // over-fetch, filter, then trim
  const out: SimilarHit[] = [];
  for (const row of rows) {
    const record = this.get(row.id);
    if (record === undefined) continue;
    if (record.status === "invalidated" || record.status === "dropped") continue;
    out.push({ record, distance: row.distance });
    if (out.length >= k) break;
  }
  return out;
}
```

- [ ] **Step 4: export `SimilarHit`** from `index.ts`. Run `pnpm --filter @mono-agent/memory-store run test` (all pass), typecheck, build.
- [ ] **Step 5: Commit** `feat(memory-store): findSimilar (vector KNN) for dedup/reconciliation`.

---

## Task 2: `memory-store` — entity repository

**Files:** Modify `packages/memory-store/src/{db.ts,types.ts,index.ts}`; Test `packages/memory-store/src/__tests__/entities.test.ts`.

- [ ] **Step 1: add to `types.ts`**
```ts
export interface EntityRecord {
  readonly id: string;          // slug, e.g. "person:robert"
  readonly name: string;
  readonly type?: string;       // person | project | org | concept | ...
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}
export interface EntityRelationRecord {
  readonly src: string; readonly dst: string; readonly relation: string; readonly createdAt: string;
}
```

- [ ] **Step 2: failing test `entities.test.ts`** — upsert entity (idempotent, updates summary/updatedAt), getEntity, addEntityRelation, relationsFor(src), and `linkMemoryToEntity` via an `about` edge surfaced by `expand`:
```ts
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("entity repository", () => {
  it("upserts entities idempotently and reads them back", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:robert", name: "Robert", type: "person", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "person:robert", name: "Robert", type: "person", summary: "prefers opt-in memory", createdAt: "2026-06-15T09:00:00.000Z", updatedAt: "2026-06-16T00:00:00.000Z" });
    expect(db.getEntity("person:robert")).toMatchObject({ name: "Robert", type: "person", summary: "prefers opt-in memory" });
    expect(db.countEntities()).toBe(1);
    db.close();
  });

  it("stores entity relations and lists them by src", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    db.upsertEntity({ id: "person:robert", name: "Robert", createdAt: "2026-06-15T09:00:00.000Z" });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", createdAt: "2026-06-15T09:00:00.000Z" });
    db.addEntityRelation("person:robert", "project:mono-agent", "maintains");
    expect(db.relationsFor("person:robert")).toContainEqual(expect.objectContaining({ dst: "project:mono-agent", relation: "maintains" }));
    db.close();
  });
});
```

- [ ] **Step 3: implement** `upsertEntity` (INSERT…ON CONFLICT(id) DO UPDATE name/type/summary/updated_at), `getEntity`, `countEntities`, `addEntityRelation` (INSERT OR IGNORE), `relationsFor(src)` in `db.ts`. Use `this.clock()` only where a timestamp isn't supplied. Export the two new types from `index.ts`.
- [ ] **Step 4:** test/typecheck/build green. **Commit** `feat(memory-store): entity + relation repository over the entities tables`.

---

## Task 3: `memory-bujo` — `LlmComplete` interface, `FakeLlm` helper, JSON parsing util

**Files:** Create `packages/memory-bujo/src/llm.ts`, `src/json.ts`; Modify `src/__tests__/helpers.ts` (add `fakeLlm`); Test `src/__tests__/json.test.ts`.

- [ ] **Step 1: `src/llm.ts`**
```ts
/** Minimal injected LLM completion surface. Implementations adapt the host runtime (P4); tests use a fake. */
export interface LlmComplete {
  readonly id: string;
  /** Returns the model's text completion for the prompt. */
  complete(prompt: string): Promise<string>;
}
```

- [ ] **Step 2: `src/json.ts`** — defensive JSON extraction (LLMs wrap JSON in prose/```fences```):
```ts
/** Extract the first top-level JSON value (object or array) from an LLM completion, tolerating prose/code fences. */
export function parseJsonLoose<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const body = fenced?.[1] ?? text;
  const start = body.search(/[[{]/u);
  if (start === -1) return undefined;
  // Walk to the matching close bracket from `start`.
  const open = body[start]; const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === open) depth += 1; else if (ch === close) { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return undefined;
  try { return JSON.parse(body.slice(start, end + 1)) as T; } catch { return undefined; }
}
```

- [ ] **Step 3: add `fakeLlm` to `src/__tests__/helpers.ts`** — maps prompt substrings → canned completions, so distill/reconcile/entity tests are deterministic:
```ts
import type { LlmComplete } from "../llm.js";
/** Deterministic fake LLM: returns the first canned response whose key substring appears in the prompt. */
export function fakeLlm(responses: ReadonlyArray<readonly [match: string, reply: string]>): LlmComplete {
  return {
    id: "fake-llm",
    complete: async (prompt: string) => {
      for (const [match, reply] of responses) if (prompt.includes(match)) return reply;
      return "[]";
    },
  };
}
```

- [ ] **Step 4: failing test `json.test.ts`** — parses bare JSON, fenced JSON, JSON-with-prose; returns undefined on garbage:
```ts
import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "../json.js";
describe("parseJsonLoose", () => {
  it("parses a bare array", () => expect(parseJsonLoose('[{"a":1}]')).toEqual([{ a: 1 }]));
  it("parses fenced json with prose", () => expect(parseJsonLoose('Sure!\n```json\n{"x":[1,2]}\n```\nDone')).toEqual({ x: [1, 2] }));
  it("parses an object embedded in prose with braces inside strings", () => expect(parseJsonLoose('result: {"t":"a } b"} ok')).toEqual({ t: "a } b" }));
  it("returns undefined for non-json", () => expect(parseJsonLoose("no json here")).toBeUndefined());
});
```

- [ ] **Step 5:** test/typecheck/build green. **Commit** `feat(memory-bujo): LlmComplete interface + loose JSON parser + fakeLlm helper`.

---

## Task 4: `memory-bujo` — rewrite a bullet inside its daily file

UPDATE/SUPERSEDE must edit the canonical daily markdown, not just the index.

**Files:** Modify `packages/memory-bujo/src/daily.ts`; Test `src/__tests__/rewrite.test.ts`.

- [ ] **Step 1: failing test `rewrite.test.ts`** — given a daily file containing a bullet with id X, `rewriteBullet(root, file, id, patch)` replaces that bullet's fields (text/status/salience), preserves all other lines verbatim, and the result re-parses with the patched values:
```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteBullet } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

describe("rewriteBullet", () => {
  it("patches a bullet's status/text in place, preserving other lines", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    const file = "daily/2026-06-15.md";
    writeFileSync(join(root, file), [
      "# 2026-06-15", "",
      "- [ ] task one  <!--mem id=01A type=task status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "prose line",
      "- – note two  <!--mem id=01B type=note status=open salience=0.5 isInsight=0 created=2026-06-15T09:00:00.000Z refs=-->",
      "",
    ].join("\n"));
    const ok = rewriteBullet(root, file, "01A", { status: "done", text: "task one (done)" });
    expect(ok).toBe(true);
    const parsed = parseDailyFile(readFileSync(join(root, file), "utf8"));
    const a = parsed.bullets.find((b) => b.id === "01A");
    expect(a).toMatchObject({ status: "done", text: "task one (done)" });
    expect(parsed.bullets.find((b) => b.id === "01B")?.text).toBe("note two"); // untouched
    expect(readFileSync(join(root, file), "utf8")).toContain("prose line"); // prose preserved
  });

  it("returns false when the id is not present", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rw-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily/2026-06-15.md"), "# 2026-06-15\n");
    expect(rewriteBullet(root, "daily/2026-06-15.md", "nope", { status: "done" })).toBe(false);
  });
});
```

- [ ] **Step 2: implement `rewriteBullet`** in `daily.ts` — read file, `parseDailyFile`, find the line whose `bullet.id === id`, apply patch fields onto that `Bullet`, re-`serializeDailyFile`, write back. Return whether a bullet was found/changed. Patch type: `Partial<Pick<Bullet, "text" | "status" | "salience" | "isInsight" | "dueAt" | "refs">>`.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-bujo): rewriteBullet — in-place canonical daily-file edit`.

---

## Task 5: `memory-bujo` — `distill(text, llm)` → atomic candidate memories

**Files:** Create `packages/memory-bujo/src/distill.ts`; Test `src/__tests__/distill.test.ts`.

- [ ] **Step 1: types + prompt.** In `distill.ts`:
```ts
import type { MemoryType } from "@mono-agent/memory-store";
import type { LlmComplete } from "./llm.js";
import { parseJsonLoose } from "./json.js";

export interface CandidateMemory {
  readonly type: MemoryType;          // task | event | note
  readonly text: string;              // one atomic sentence
  readonly salience: number;          // 0..1
  readonly isInsight: boolean;
}

const PROMPT = (text: string) => `Extract durable memories from the text below as a JSON array.
Each item: {"type":"task|event|note","text":"<one atomic sentence>","salience":0..1,"isInsight":true|false}.
Rules: one fact per item; <=160 chars; omit chit-chat; salience reflects long-term importance; isInsight=true only for synthesized higher-level conclusions. Return ONLY the JSON array.

TEXT:
${text}`;

export async function distill(text: string, llm: LlmComplete): Promise<CandidateMemory[]> {
  if (text.trim().length === 0) return [];
  const raw = await llm.complete(PROMPT(text));
  const parsed = parseJsonLoose<unknown[]>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((it) => normalizeCandidate(it));
}
```
`normalizeCandidate(it)`: validate shape; coerce `type` to one of task/event/note (default note), clamp salience to [0,1] (default 0.5), boolean isInsight (default false), require non-empty trimmed text (<=280 chars) else drop the item (return []).

- [ ] **Step 2: failing test `distill.test.ts`** (fake llm returns canned JSON):
```ts
import { describe, expect, it } from "vitest";
import { distill } from "../distill.js";
import { fakeLlm } from "./helpers.js";

describe("distill", () => {
  it("parses well-formed candidates and normalizes/clamps fields", async () => {
    const llm = fakeLlm([["TEXT:", '```json\n[{"type":"note","text":"Robert prefers opt-in memory","salience":1.4,"isInsight":true},{"type":"task","text":"ship P2","salience":-1,"isInsight":false}]\n```']]);
    const out = await distill("the team discussed memory", llm);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "note", isInsight: true });
    expect(out[0]?.salience).toBeLessThanOrEqual(1);
    expect(out[1]?.salience).toBeGreaterThanOrEqual(0);
  });
  it("drops malformed items and returns [] on non-array/empty", async () => {
    expect(await distill("", fakeLlm([]))).toEqual([]);
    const llm = fakeLlm([["TEXT:", '[{"text":""},{"type":"note","text":"valid one","salience":0.5,"isInsight":false}]']]);
    expect((await distill("x", llm)).map((c) => c.text)).toEqual(["valid one"]);
  });
});
```

- [ ] **Step 3:** implement `normalizeCandidate`; test/typecheck/build green. **Commit** `feat(memory-bujo): distill turn text into atomic candidate memories`.

---

## Task 6: `memory-bujo` — `reconcile` (ADD / UPDATE / SUPERSEDE / NOOP)

**Files:** Create `packages/memory-bujo/src/reconcile.ts`; Test `src/__tests__/reconcile.test.ts`.

- [ ] **Step 1: interfaces + logic.** In `reconcile.ts`:
```ts
import { join } from "node:path";
import type { MemoryDb, MemoryRecord } from "@mono-agent/memory-store";
import { appendBullet, dailyFilePath, rewriteBullet } from "./daily.js";
import { parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import type { Bullet, CandidateMemory } from "./types.js"; // re-export CandidateMemory from distill via types if convenient

export type ReconcileAction =
  | { readonly kind: "add"; readonly id: string }
  | { readonly kind: "update"; readonly id: string }
  | { readonly kind: "supersede"; readonly oldId: string; readonly newId: string }
  | { readonly kind: "noop"; readonly id: string };

export interface ReconcileDeps {
  readonly db: MemoryDb;
  readonly root: string;
  readonly llm: LlmComplete;
  readonly nextId: () => string;
  readonly now: () => Date;
  readonly threadThreshold?: number; // distance below which to add a thread edge (default 0.35)
  readonly dupThreshold?: number;    // distance below which we ask the LLM to classify (default 0.5); above → ADD outright
}

export async function reconcile(candidates: readonly CandidateMemory[], deps: ReconcileDeps): Promise<ReconcileAction[]> { ... }
```
Per candidate `c`:
1. `similar = await db.findSimilar(c.text, 5)`.
2. If `similar.length === 0` or `similar[0].distance > dupThreshold` → **ADD** (no LLM needed).
3. Else ask LLM to classify against the nearest few (prompt includes `c` + the candidate set `similar` with ids/text). Parse `{action:"add|update|supersede|noop","targetId":"..","text":".."}` via `parseJsonLoose`; if unparseable/invalid target → fall back to **ADD**.
4. Apply:
   - **ADD**: `id=nextId()`; build `Bullet`; `appendBullet(root, bullet, now())`; build `MemoryRecord` (source.file = `relative(root, dailyFilePath(...))`, line omitted/0); `await db.upsert(record)`; add `thread` edges to each `similar` hit with `distance <= threadThreshold` (`db.addEdge(id, hit.id, "thread", 1 - distance)`).
   - **UPDATE(targetId, mergedText)**: `rewriteBullet(root, target.source.file, targetId, { text: mergedText })`; re-upsert the target record with new text (re-embeds); keep id.
   - **SUPERSEDE(targetId, newText)**: `id=nextId()`; append new bullet; build new record; `await db.supersede(targetId, newRecord)`; also `rewriteBullet(root, oldTarget.source.file, targetId, { status: "invalidated" })` so the canonical markdown reflects the strike.
   - **NOOP**: no write (optionally bump access via a recall — skip for determinism).
Return the action list.

- [ ] **Step 2: failing test `reconcile.test.ts`** (deterministic via fakeLlm + fakeEmbeddings; use a real on-disk root via mkdtemp so daily files + db both exist). Cover:
  - novel candidate (no similar) → ADD, recallable, daily bullet present.
  - duplicate candidate + fakeLlm says `noop` → no new memory (count unchanged).
  - contradicting candidate + fakeLlm says `supersede` → old becomes invalidated (db.get old.status), new added, old's daily line shows `[~]`/invalidated, supersedes edge present.
  - update candidate + fakeLlm says `update` → target text changed in daily file + recall returns updated text, count unchanged.
```ts
// (full test body: seed memories via store.appendHostSummary or db.upsert+appendBullet; then reconcile candidates with a fakeLlm scripted per case; assert db state + file state)
```
The implementer writes the full test per these four cases, using `fakeLlm([["classify", '<json>']])` keyed on a stable substring in the classify prompt.

- [ ] **Step 3:** implement; test/typecheck/build green. **Commit** `feat(memory-bujo): reconcile candidates (ADD/UPDATE/SUPERSEDE/NOOP) across markdown + index`.

---

## Task 7: `memory-bujo` — entity extraction → `graph.jsonl` + index mirror + `about` edges

**Files:** Create `packages/memory-bujo/src/graph.ts` (canonical graph.jsonl read/write), `src/entities.ts` (LLM extraction); Test `src/__tests__/graph.test.ts`, `src/__tests__/entities.test.ts`.

- [ ] **Step 1: `graph.ts`** — canonical JSONL at `<root>/graph.jsonl`, one record per line: `{"kind":"entity",...}` or `{"kind":"relation",...}`. Functions: `readGraph(root): {entities: EntityRecord[]; relations: EntityRelationRecord[]}` (missing file → empty), `appendEntity(root, EntityRecord)`, `appendRelation(root, EntityRelationRecord)` (append-only; dedupe on read by id/triple keeping last). Test round-trip + dedupe.

- [ ] **Step 2: `entities.ts`** — `extractEntities(text, llm)`:
```ts
export interface ExtractedEntity { readonly id: string; readonly name: string; readonly type?: string; }
export interface ExtractedRelation { readonly src: string; readonly dst: string; readonly relation: string; }
export interface Extraction { readonly entities: ExtractedEntity[]; readonly relations: ExtractedRelation[]; }
export async function extractEntities(text: string, llm: LlmComplete): Promise<Extraction>
```
Prompt asks for JSON `{entities:[{id,name,type}], relations:[{src,dst,relation}]}` where `id` is a slug `type:name-kebab`. Parse loosely; normalize (drop entries missing id/name; relations must reference present entity ids or be dropped).

- [ ] **Step 3:** test `entities.test.ts` with fakeLlm canned extraction → asserts normalized entities/relations, drops malformed.
- [ ] **Step 4:** test/typecheck/build green. **Commit** `feat(memory-bujo): canonical graph.jsonl + LLM entity/relation extraction`.

---

## Task 8: `memory-bujo` — `captureTurn` orchestrator + rebuild ingests `graph.jsonl`

**Files:** Create `packages/memory-bujo/src/capture.ts`; Modify `src/rebuild.ts`, `src/index.ts`; Test `src/__tests__/capture.test.ts`, extend `src/__tests__/rebuild.test.ts`.

- [ ] **Step 1: `capture.ts`** — `captureTurn(text, deps)`: `distill(text, llm)` → `reconcile(candidates, deps)`; then `extractEntities(text, llm)` → for each entity `db.upsertEntity` + `appendEntity(root,...)`; for each relation `db.addEntityRelation` + `appendRelation`; link the turn's ADDed memories to extracted entities via `db.addEdge(memoryId, entityId, "about")`. Returns `{ actions: ReconcileAction[]; entities: number; relations: number }`.
- [ ] **Step 2: extend `rebuild.ts`** — after indexing bullets, read `graph.jsonl` and mirror entities/relations into the db (`upsertEntity`/`addEntityRelation`), so a rebuilt index includes the entity graph with NO LLM. (Memory↔entity `about` edges are NOT in markdown/graph.jsonl in P2 — note this as a known rebuild-lossy edge type, consistent with P1's edge lossiness; deferred.) Update the rebuild determinism expectation.
- [ ] **Step 3: tests** — `capture.test.ts`: a full turn with scripted fakeLlm (distill → 2 candidates, reconcile → ADD both, extract → 1 entity + 1 relation) produces: 2 recallable memories, 1 entity in db + graph.jsonl, 1 relation, `about` edges from memories to the entity. `rebuild.test.ts` extension: write daily bullets + a graph.jsonl, delete db, `rebuildFromMarkdown` → entities present in db, no LLM called.
- [ ] **Step 4:** export `captureTurn`, `distill`, `reconcile`, `extractEntities`, `readGraph` and types from `index.ts`. test/typecheck/build green. **Commit** `feat(memory-bujo): captureTurn pipeline + rebuild ingests graph.jsonl`.

---

## Task 9: `memory-bujo` — wire optional `llm` into `BujoMemoryStore.capture()`

**Files:** Modify `packages/memory-bujo/src/{types.ts,store.ts}`; Test extend `src/__tests__/store.test.ts`.

- [ ] **Step 1:** add `readonly llm?: LlmComplete;` to `BujoOptions`. In `BujoMemoryStore`, store `this.llm`. Add:
```ts
/** LLM-backed capture: distill+reconcile+extract. Throws if no llm was configured. No-op-safe for empty text. */
async capture(conversationId: string, text: string): Promise<{ actions: number; entities: number } | undefined> {
  if (this.llm === undefined) return undefined;
  const res = await captureTurn(text, { db: this.db, root: this.root, llm: this.llm, nextId: this.nextId, now: this.clock });
  return { actions: res.actions.length, entities: res.entities };
}
```
`appendHostSummary` stays the deterministic P1 rapid-log (cheap, always-on). `capture()` is the intelligent path (P3 reflection/cron invoke it). Document this split.

- [ ] **Step 2: test** — `createBujoMemoryStore({..., llm: fakeLlm([...])})`; `await store.capture("s1", "...")` → memories recallable, entity present; and `capture` returns `undefined` when no llm configured.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-bujo): BujoMemoryStore.capture() optional LLM write path`.

---

## Task 10: Phase-2 verification gate

- [ ] **Step 1:** `node scripts/check-package-architecture.mjs` → passed (memory-bujo still `context`; no runtime dep added — `LlmComplete` is injected).
- [ ] **Step 2:** build + typecheck both packages → clean.
- [ ] **Step 3:** full test suites both packages → green (note new counts).
- [ ] **Step 4:** confirm `memory-bujo` package.json gained NO new `@mono-agent/runtime*` dependency (capture is LLM-agnostic via injection).
- [ ] **Step 5:** (optional, if Ollama+a local chat model available) a guarded real-LLM capture smoke is NOT required for P2 — the real-LLM wiring is P4. Skip.
- [ ] **Step 6:** Commit any gate fixes.

---

## Self-Review (planning)
- Spec coverage: §3 (write-time reconciliation, entities) and §9.1 (distill pipeline) → Tasks 5-9; bi-temporal supersede reuses P1. Markdown-canonical preserved via `rewriteBullet` + `graph.jsonl`; rebuild ingests graph.jsonl (Task 8) — closing part of P1's noted rebuild-lossiness (entities now rebuildable; `about` edges still deferred — flagged).
- Type consistency: `CandidateMemory` defined in `distill.ts` (re-export through `types.ts` or import directly — implementer keeps one source). `LlmComplete` single-sourced in `llm.ts`. `EntityRecord`/`EntityRelationRecord`/`SimilarHit` single-sourced in `memory-store/types.ts`.
- Boundary: no runtime dep; LLM injected. Confirmed against the architecture check in Task 10.
- Deferred to P3/P4: reflection/migration cron (P3), real-runtime LLM adapter + config/composer/validate surfacing (P4).
