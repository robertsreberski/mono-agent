# Memory v2 — Phase 3: Rituals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Add the loops that run *between* captures — recency/salience **decay** (forgetting pressure), **reflection** (synthesize higher-level insights, surface due intentions), **migration** (the BuJo monthly ritual: per aging item promote / reschedule / cluster / forget), a **future-log** of scheduled intentions, and a living **index.md**. These are exposed as engine functions + `BujoMemoryStore.reflect()/migrate()` + CLI subcommands; P4 wires them to cron-as-markdown.

**Architecture:** `memory-store` gains pure-ish maintenance queries/mutations (`applyDecay`, `dueItems`, `agingOpen`, `topSalient`) — deterministic with the injected clock, no LLM. `memory-bujo` gains `reflect` (decay + LLM insight synthesis + due surfacing), `migrate` (LLM per-item BuJo decisions, writing a `monthly/<YYYY-MM>.md` record), `writeFutureLog`/`writeIndex` (canonical markdown projections), CLI `reflect`/`migrate`/`index`, and store methods. The LLM stays injected (`LlmComplete`); tests use `fakeLlm`. Canonical-markdown-first discipline (P2): every mutation edits the daily file via `rewriteBullet` then mirrors the index. Bi-temporal forgetting = status `dropped` + `valid_to`, never delete.

**Tech Stack:** TS ESM/NodeNext, strict TS, vitest. Builds on P1+P2 (`@mono-agent/memory-store`, `@mono-agent/memory-bujo`, branch `feat/memory-bujo`).

**Plan-code convention:** interfaces + test cases given in full; implementation guidance + key snippets; implementer completes to satisfy tests + self-review, following existing idioms (conditional spreads, `BigInt` vec rowids, markdown-first writes, never-throw LLM calls like distill/reconcile/entities).

---

## Task 1: `memory-store` — maintenance queries (`dueItems`, `agingOpen`, `topSalient`)

**Files:** Modify `db.ts`, `index.ts`; Test `src/__tests__/maintenance.test.ts`.

- [ ] **Step 1: implement (db.ts)**
```ts
/** Open memories with a due date at/under `now`, soonest first (the future-log queue). */
dueItems(now: Date, limit = 50): MemoryRecord[] {
  const rows = this.db.prepare(
    `SELECT * FROM memories WHERE status IN ('open','scheduled') AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT ?`,
  ).all(now.toISOString(), limit) as Record<string, unknown>[];
  return rows.map((r) => this.fromRow(r));
}

/** Live, low-salience, old, infrequently-accessed open memories — migration candidates. */
agingOpen(now: Date, opts: { olderThanDays?: number; maxSalience?: number; limit?: number } = {}): MemoryRecord[] {
  const olderThan = new Date(now.getTime() - (opts.olderThanDays ?? 30) * 86_400_000).toISOString();
  const rows = this.db.prepare(
    `SELECT * FROM memories WHERE status = 'open' AND created_at <= ? AND salience <= ? ORDER BY salience ASC, created_at ASC LIMIT ?`,
  ).all(olderThan, opts.maxSalience ?? 0.4, opts.limit ?? 50) as Record<string, unknown>[];
  return rows.map((r) => this.fromRow(r));
}

/** Highest-salience live memories (for promotion / always-in-context / index). */
topSalient(limit = 20): MemoryRecord[] {
  const rows = this.db.prepare(
    `SELECT * FROM memories WHERE status NOT IN ('invalidated','dropped') ORDER BY salience DESC, created_at DESC LIMIT ?`,
  ).all(limit) as Record<string, unknown>[];
  return rows.map((r) => this.fromRow(r));
}
```

- [ ] **Step 2: failing test `maintenance.test.ts`** — seed memories with varied salience/createdAt/dueAt/status; assert: `dueItems(now)` returns only open/scheduled with dueAt<=now soonest-first; `agingOpen(now,{olderThanDays:30,maxSalience:0.4})` returns only old low-salience open ones; `topSalient(2)` returns the two highest-salience live ones. Use a fixed `clock`. (Construct records via `db.upsert` with explicit createdAt/dueAt/salience.)
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-store): maintenance queries — dueItems, agingOpen, topSalient`.

---

## Task 2: `memory-store` — `applyDecay(now, opts)`

**Files:** Modify `db.ts`, `index.ts`; Test `src/__tests__/decay.test.ts`.

- [ ] **Step 1: implement.** Exponential decay toward a floor, anchored on recency (last_accessed_at ?? created_at):
```ts
/** Decay salience toward `floor` by time since last access (half-life in days). Returns count adjusted.
 *  Frequently-accessed memories (recent last_accessed_at) decay little; stale ones fade toward floor. */
applyDecay(now: Date, opts: { halfLifeDays?: number; floor?: number } = {}): { decayed: number } {
  const halfLife = opts.halfLifeDays ?? 30;
  const floor = opts.floor ?? 0.05;
  const rows = this.db.prepare(
    `SELECT id, salience, COALESCE(last_accessed_at, created_at) AS ref FROM memories WHERE status NOT IN ('invalidated','dropped')`,
  ).all() as { id: string; salience: number; ref: string }[];
  const stmt = this.db.prepare(`UPDATE memories SET salience = ? WHERE id = ?`);
  let decayed = 0;
  const tx = this.db.transaction(() => {
    for (const r of rows) {
      const days = Math.max(0, (now.getTime() - new Date(r.ref).getTime()) / 86_400_000);
      const factor = 0.5 ** (days / halfLife);
      const next = Math.max(floor, r.salience * factor);
      if (Math.abs(next - r.salience) > 1e-9) { stmt.run(next, r.id); decayed += 1; }
    }
  });
  tx();
  return { decayed };
}
```

- [ ] **Step 2: failing test `decay.test.ts`** — a fresh memory (ref==now) is unchanged; a memory whose ref is one half-life ago halves (toward floor); salience never drops below floor; invalidated/dropped untouched; deterministic with injected `now`.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-store): applyDecay (recency-anchored salience decay toward floor)`.

---

## Task 3: `memory-bujo` — `reflect(deps)` (nightly: decay + insight synthesis + due surfacing)

**Files:** Create `src/reflect.ts`; Test `src/__tests__/reflect.test.ts`.

- [ ] **Step 1: interfaces + flow.**
```ts
import type { MemoryDb, MemoryRecord } from "@mono-agent/memory-store";
import { appendBullet } from "./daily.js";
import { parseJsonLoose } from "./json.js";
import type { LlmComplete } from "./llm.js";
import type { Bullet } from "./types.js";

export interface ReflectDeps {
  readonly db: MemoryDb; readonly root: string; readonly llm: LlmComplete;
  readonly nextId: () => string; readonly now: () => Date;
  readonly halfLifeDays?: number; readonly floor?: number; readonly maxInsights?: number;
}
export interface ReflectResult { readonly decayed: number; readonly insights: number; readonly due: number; }

export async function reflect(deps: ReflectDeps): Promise<ReflectResult> {
  const now = deps.now();
  const { decayed } = deps.db.applyDecay(now, { ...(deps.halfLifeDays !== undefined && { halfLifeDays: deps.halfLifeDays }), ...(deps.floor !== undefined && { floor: deps.floor }) });
  const insights = await synthesizeInsights(deps, now);
  const due = deps.db.dueItems(now).length;
  return { decayed, insights, due };
}
```
`synthesizeInsights(deps, now)`: take the top-salient recent live memories (e.g. `db.topSalient(20)` filtered to non-insight); if fewer than 3, return 0; build a prompt listing them (id + text); ask the LLM for up to `maxInsights ?? 3` higher-level insights as JSON `[{"text":"...","sourceIds":["..."]}]`; for each valid insight: append a bullet (type=note, isInsight=true, salience ~0.7), `db.upsert`, and add `supports` edges from the insight to each valid sourceId (`db.addEdge(insightId, sourceId, "supports")`). Never-throw on LLM failure (guard `llm.complete`, return 0). Return count created.

- [ ] **Step 2: failing test `reflect.test.ts`** — seed ≥3 memories; `fakeLlm` returns one insight referencing two of them; assert: `reflect` returns `{decayed>=0, insights:1, due:N}`; the insight memory exists (isInsight true) and is recallable; `supports` edges exist from the insight to the two sources; a throwing LLM yields `insights:0` without throwing.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-bujo): reflect — decay + LLM insight synthesis + due surfacing`.

---

## Task 4: `memory-bujo` — `migrate(deps)` (monthly BuJo ritual)

**Files:** Create `src/migrate.ts`; Test `src/__tests__/migrate.test.ts`.

- [ ] **Step 1: flow.** `migrate(deps)`:
```ts
export interface MigrateDeps extends ReflectDeps {} // same shape; reuse
export interface MigrateResult { readonly promoted: number; readonly rescheduled: number; readonly clustered: number; readonly forgotten: number; readonly reviewed: number; }
export async function migrate(deps: MigrateDeps): Promise<MigrateResult>
```
1. `const aging = deps.db.agingOpen(deps.now(), { olderThanDays: 30, maxSalience: 0.4, limit: 50 })`.
2. For each item, ask the LLM (guarded; on failure skip the item) to decide JSON `{"action":"promote|reschedule|cluster|forget","dueAt":"<ISO, for reschedule>","collection":"<slug, for cluster>"}`. Per-item try/catch (isolation, like reconcile).
3. Apply (markdown-first then index):
   - **promote**: `rewriteBullet(root, item.source.file, id, { salience: min(1, item.salience + 0.3) })` + `db.upsert({...item, salience})`.
   - **reschedule**: `rewriteBullet(root, file, id, { status: "scheduled", dueAt })` + `db.upsert({...item, status:"scheduled", dueAt})`.
   - **cluster**: `db.upsert({...item, collection})` + ensure a collection entity (`db.upsertEntity({id:`collection:${slug}`,name:slug,type:"collection",createdAt:now})`) + `db.addEdge(id, `collection:${slug}`, "supports")`. (Markdown collection-membership is via the record's `collection`; a dedicated collections/*.md writer is deferred.)
   - **forget**: `rewriteBullet(root, file, id, { status: "dropped" })` + `db.upsert({...item, status:"dropped", validTo: now.toISOString()})`. (Never deletes.)
4. Write `monthly/<YYYY-MM>.md` (append a dated section listing each decision: `- <action> <id>: "<text>"`). Create dir if needed.
5. Return counts.

- [ ] **Step 2: failing test `migrate.test.ts`** — seed 4 aging low-salience memories on disk (append bullets + upsert with old createdAt + low salience); `fakeLlm` scripted to return one of each action (key on a stable migrate-prompt substring + maybe the item text/id to vary). Assert: promote raises salience (db + daily line), reschedule sets status scheduled + dueAt (db + daily line re-parses), cluster sets collection + collection entity + supports edge, forget sets status dropped + validTo + daily line struck; `monthly/<YYYY-MM>.md` exists and lists the actions; a throwing LLM on one item skips it without aborting.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-bujo): migrate — monthly BuJo ritual (promote/reschedule/cluster/forget)`.

---

## Task 5: `memory-bujo` — future-log + living index projections

**Files:** Create `src/projections.ts`; Test `src/__tests__/projections.test.ts`.

- [ ] **Step 1: implement.**
```ts
/** Write <root>/future-log.md: the due/scheduled intentions queue, soonest first. Returns count. */
export function writeFutureLog(root: string, db: MemoryDb, now: Date, horizonDays = 365): number {
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000);
  // scheduled/open items with a dueAt within the horizon (use a dedicated query or filter dueItems(horizon))
  const items = db.dueItems(horizon, 200);
  const body = ["# Future Log", "", ...items.map((m) => `- [<] ${m.text}  (due ${m.dueAt ?? "?"})  ^${m.id}`), ""].join("\n");
  writeFileSync(join(root, "future-log.md"), body, "utf8"); // mkdir root first
  return items.length;
}

/** Write <root>/index.md: a living table of contents — counts + top entities/collections + top-salient memories. */
export function writeIndex(root: string, db: MemoryDb, now: Date): void {
  // sections: ## Overview (counts via db.count/countEntities), ## Top memories (db.topSalient(15)),
  // ## Entities (a db.listEntities(limit) — add a small query if needed). Keep it deterministic & human-readable.
}
```
Add any tiny supporting query to `memory-store` if needed (e.g. `listEntities(limit)`); if so, add a focused test there too (or test via projections). Prefer reusing existing methods.

- [ ] **Step 2: failing test `projections.test.ts`** — seed memories (some scheduled with dueAt) + entities; `writeFutureLog` writes future-log.md containing the scheduled items soonest-first and returns the count; `writeIndex` writes index.md containing the counts and at least one top memory + entity. Assert file contents.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-bujo): future-log.md + living index.md projections`.

---

## Task 6: `memory-bujo` — `BujoMemoryStore.reflect()/migrate()` + CLI subcommands

**Files:** Modify `src/store.ts`, `src/cli.ts`, `src/index.ts`; Test extend `src/__tests__/store.test.ts`.

- [ ] **Step 1: store methods.** Add to `BujoMemoryStore` (require llm; return undefined without it, like `capture()`):
```ts
async reflect(): Promise<ReflectResult | undefined> { if (!this.llm) return undefined; const r = await reflect({db:this.db, root:this.root, llm:this.llm, nextId:this.nextId, now:this.clock}); writeFutureLog(this.root, this.db, this.clock()); writeIndex(this.root, this.db, this.clock()); return r; }
async migrate(): Promise<MigrateResult | undefined> { if (!this.llm) return undefined; const m = await migrate({db:this.db, root:this.root, llm:this.llm, nextId:this.nextId, now:this.clock}); writeFutureLog(this.root, this.db, this.clock()); return m; }
```

- [ ] **Step 2: CLI.** Extend `cli.ts` with `reflect <root>` and `migrate <root>` (and `index <root>` → writeIndex). They need an LLM for reflect/migrate — construct the Ollama embeddings provider (as today) AND require a chat-LLM. **Important:** P3 has NO real chat-LLM adapter yet (that's P4). So for `reflect`/`migrate` the CLI should error clearly ("reflect/migrate require an LLM; wire one via the host (P4) or set MONO_AGENT_OLLAMA_CHAT") UNLESS a simple Ollama chat adapter is trivially available. Keep it honest: implement `index <root>` fully (no LLM needed); for `reflect`/`migrate`, if no chat adapter is configured, print a clear "not yet wired — available via BujoMemoryStore with an injected llm (P4)" message and exit 2. Do NOT fake an LLM in the CLI. (The store methods + tests prove the logic with a fake llm; real wiring is P4.)

- [ ] **Step 3: tests** — extend store.test.ts: with `fakeLlm`, `store.reflect()` returns a result and writes future-log.md + index.md; `store.migrate()` returns counts; both return undefined without llm.
- [ ] **Step 4:** export `reflect`/`migrate`/`writeFutureLog`/`writeIndex` + result types from `index.ts`. test/typecheck/build green (dist/cli.js emitted); arch check. **Commit** `feat(memory-bujo): store reflect()/migrate() + CLI index/reflect/migrate`.

---

## Task 7: Phase-3 verification gate

- [ ] **Step 1:** `node scripts/check-package-architecture.mjs` → passed (still no runtime dep on memory-bujo).
- [ ] **Step 2:** build + typecheck both → clean; `dist/cli.js` present.
- [ ] **Step 3:** full suites both → green (note counts).
- [ ] **Step 4:** CLI smoke: `node packages/memory-bujo/dist/cli.js index ./.tmp-p3 && cat ./.tmp-p3/index.md` (after seeding nothing → empty-but-valid index); `node .../cli.js reflect ./.tmp-p3` → clear "requires an LLM (P4)" message + exit 2 (no crash). Clean up.
- [ ] **Step 5:** Commit any gate fixes.

---

## Self-Review (planning)
- Spec coverage: §9.2 reflection (AM priming via load() exists; PM/insight synthesis → Task 3), §9.3 migration nightly(decay+insights+due → Task 3)/monthly(ritual → Task 4), future-log + index (Task 5). Bi-temporal forgetting (status dropped + valid_to) in migrate. Markdown-first discipline throughout.
- Type consistency: `ReflectDeps`/`ReflectResult` (reflect.ts), `MigrateDeps`(=ReflectDeps)/`MigrateResult` (migrate.ts); reuse `MemoryDb` maintenance methods from Tasks 1-2.
- Boundary: LLM still injected; no runtime dep. CLI reflect/migrate honestly defer real-LLM wiring to P4 (no fake LLM in production code).
- Deferred to P4: real chat-LLM adapter, cron-as-markdown wiring of reflect/migrate, config/composer/validate surfacing, live rollout. AM session-aware priming (load() needs a query arg — a MemoryStore contract change) is noted for P4.
