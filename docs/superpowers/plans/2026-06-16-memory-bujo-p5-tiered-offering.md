# Memory v2 — Phase 5: Tiered Offering + Ritual Scheduler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Collapse the memory offering onto the single BuJo substrate as three tiers — `lite` (FTS recall, no external deps), `journal` (hybrid recall + decay, needs Ollama embeddings), `bujo` (full: LLM capture/reconcile + entities + reflection + migration + auto-scheduled rituals). Remove the superseded v1 packages (`memory-md` markdown store, `memory-journal`, `memory-graph`) — **no back-compat** — moving the `MemoryStore` contract into `memory-store`. Add an in-app **ritual scheduler** so `bujo` is self-maintaining at runtime. Update config, host, doctor, composer, docs. Open a PR.

**Architecture:** `memory-store`/`memory-bujo` gain an **optional-embeddings** path (FTS-only recall when no provider) so `lite` needs nothing external. `BujoMemoryStore` derives tier behavior from what's configured (no embeddings → lite; embeddings, no llm → journal; embeddings + llm → bujo) OR an explicit tier. `agent-host` routes ALL memory modes to `BujoMemoryStore` (the journal/markdown branches are deleted). The `MemoryStore` contract (`MemoryStore`/`MemoryBlock`/`MemoryWriteResult`) moves from `memory-md` to `memory-store`; consumers (`agent-harness`, `agent-host`, `memory-bujo`) re-point. `agent-app` gains `startMemoryRituals` (started for the `bujo` tier when reflection/migration cron is configured) using a cron primitive; doctor/validate reports it. Old packages are removed from the catalog, PACKAGES.md, root deps.

**Tech Stack:** TS ESM/NodeNext, strict TS, vitest. Builds on P1–P4 (branch `feat/memory-bujo`).

**Plan-code convention:** interfaces + behavior + test intent; implementers read the real code and adapt. Each task ends green (build/typecheck/test/arch) and commits. Removals are cascading — do them in the order below so the tree stays buildable between tasks.

---

## Task 1: `memory-store` — optional embeddings (FTS-only recall path)

**Files:** Modify `packages/memory-store/src/{types.ts,db.ts,index.ts}`; Test `src/__tests__/no-embeddings.test.ts`.

- [ ] **Step 1:** Make `MemoryDbOptions.embeddings` OPTIONAL (`embeddings?: EmbeddingProvider`) and `dim` optional (default 0 / unused when no embeddings). In `MemoryDb`:
  - constructor: only create `memories_vec` migration when embeddings present (or always create it but never write to it — simpler: always create with a default dim like 768, but skip vec writes when no provider). Recommend: keep the schema (vec table always created with dim from options or 768) but gate vec INSERT/MATCH on `this.embeddings !== undefined`.
  - `upsert`: if no embeddings, skip the embed + vec insert/delete (still write memories row + FTS).
  - `recall`: if no embeddings, skip `vectorCandidates`; fuse only the FTS list (RRF of one list still works) — so recall is keyword-only.
  - `findSimilar`: return `[]` when no embeddings (reconcile is a bujo-tier-only concern anyway).
- [ ] **Step 2: test `no-embeddings.test.ts`** — open a db with NO embeddings; upsert 3 memories; `recall("keyword")` returns the FTS match (keyword-only, no throw); `findSimilar` returns `[]`; `applyDecay`/`dueItems`/entities still work.
- [ ] **Step 3:** test/typecheck/build green. **Commit** `feat(memory-store): optional embeddings — FTS-only recall path for the lite tier`.

---

## Task 2: Move the `MemoryStore` contract into `memory-store`

**Files:** Create `packages/memory-store/src/contract.ts`; Modify `memory-store/src/index.ts`; Modify consumers (`memory-bujo`, `agent-harness`, `agent-host`) imports; Modify `memory-md` (re-export from memory-store OR delete in Task 9).

- [ ] **Step 1:** Move `MemoryStore`, `MemoryBlock`, `MemoryWriteResult` (and `MarkdownMemoryScope` if still needed — likely drop) into `packages/memory-store/src/contract.ts`; export from `memory-store/src/index.ts`.
- [ ] **Step 2:** Re-point imports: `memory-bujo/src/store.ts` (`import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-store"`), `memory-bujo/src/recall.ts` (`MemoryBlock`), `agent-harness` (wherever it imports `MemoryStore`), `agent-host`. Grep `from "@mono-agent/memory-md"` across packages and re-point the contract imports.
- [ ] **Step 3:** TEMP: make `memory-md` re-export the contract from `memory-store` (so it still builds until Task 9 deletes it): `export type { MemoryStore, MemoryBlock, MemoryWriteResult } from "@mono-agent/memory-store";` (memory-md must then depend on memory-store — add it; both `context`, allowed). This keeps the tree green mid-refactor.
- [ ] **Step 4:** `pnpm install`; typecheck/build/test the touched packages + arch check. **Commit** `refactor(memory): move MemoryStore contract into memory-store`.

---

## Task 3: `memory-bujo` — tier-aware store (lite / journal / bujo)

**Files:** Modify `packages/memory-bujo/src/{types.ts,store.ts,index.ts}`; Test extend `src/__tests__/store.test.ts`.

- [ ] **Step 1:** `BujoOptions.embeddings` becomes OPTIONAL; add an optional `tier?: "lite" | "journal" | "bujo"` (else derive: no embeddings → lite; embeddings + no llm → journal; embeddings + llm → bujo). Add a `tier()` getter. `BujoMemoryStore`:
  - constructor opens `openMemoryDb` with `embeddings` only if present (lite → no embeddings; dim default 768 when embeddings present).
  - `appendHostSummary`: unchanged (rapid-log) — works in all tiers.
  - `load`: unchanged (recall; FTS-only in lite).
  - `capture()`: returns undefined unless tier is `bujo` (needs llm) — already gated on `this.llm`.
  - add `decay()`: runs `db.applyDecay` (journal + bujo tiers; no LLM) — a cheap maintenance call usable by the scheduler/CLI for the journal tier.
- [ ] **Step 2: test** — a lite store (no embeddings) appendHostSummary + load works (keyword recall); a journal store (embeddings, no llm) recall is hybrid + `decay()` works + `capture()` returns undefined; a bujo store (embeddings+llm) capture works. `tier()` derivation correct.
- [ ] **Step 3:** export the tier type. test/typecheck/build green. **Commit** `feat(memory-bujo): tier-aware BujoMemoryStore (lite/journal/bujo) + decay()`.

---

## Task 4: `@mono-agent/config` — redefine `memory.mode` tiers + ritual cron

**Files:** Modify `packages/config/src/{types.ts,field-groups.ts,config.ts,json-source.ts,layered-loader.ts,index.ts}`; Tests.

- [ ] **Step 1:** `MemoryMode = "lite" | "journal" | "bujo"` (remove `"markdown"`; `journal` is redefined). Add `memory.reflection?: { enabled?: boolean; cron?: string }` and `memory.migration?: { enabled?: boolean; cron?: string }` (defaults `0 3 * * *` / `0 4 1 * *`). Keep `path`, `maxBytes`, `embeddings?`, `llm?`. (No `scope`/`writeMode`-markdown semantics needed — `writeMode` stays for rapid-log on/off.)
- [ ] **Step 2:** field-groups/config.ts/json-source/layered-loader: update the mode choice list to the three tiers; parse the reflection/migration cron blocks (JSON + env `MONO_AGENT_MEMORY_REFLECTION_CRON`/`_ENABLED`, `MONO_AGENT_MEMORY_MIGRATION_CRON`/`_ENABLED`).
- [ ] **Step 3:** tests cover the three tiers + cron parsing; update any existing tests that referenced `"markdown"` mode.
- [ ] **Step 4:** test/typecheck/build + arch. **Commit** `feat(config): tiered memory.mode (lite/journal/bujo) + reflection/migration cron`.

---

## Task 5: `agent-host` — route ALL modes to BujoMemoryStore; delete journal/markdown branches

**Files:** Modify `packages/agent-host/src/index.ts`, `package.json` (drop memory-journal/memory-graph/memory-md deps; keep memory-bujo/memory-search/memory-store); Tests.

- [ ] **Step 1:** Replace `createConfiguredMemory` body: for any `config.memory.mode` in {lite, journal, bujo}, build a `BujoMemoryStore`:
  - lite: no embeddings provider (FTS-only).
  - journal/bujo: build embeddings provider (default ollama nomic-embed-text:v1.5, dim 768).
  - bujo: also wire `createOllamaLlm` from `config.memory.llm`.
  Remove the `createJournalMemoryStore`/`createMarkdownMemoryStore`/`createEntityGraphStore` imports + branches and `resolveMemoryMcpMainPath` usage if it was journal-only (check `memoryMcpRuntimeOptions` — it's `mode === "journal"`-gated; update or remove since journal is now bujo-backed; for P5 keep MCP OFF for the new tiers unless trivially repointed — note as follow-up).
- [ ] **Step 2:** update agent-host tests (the bujo-memory test stays; remove/adjust any journal/markdown host tests). typecheck/build/test/arch.
- [ ] **Step 3:** **Commit** `feat(agent-host): route all memory tiers to BujoMemoryStore; drop journal/markdown branches`.

---

## Task 6: `agent-app` — ritual scheduler (`startMemoryRituals`) for the bujo tier

**Files:** Create `packages/agent-app/src/memory-rituals.ts`; wire into the app lifecycle (`app.ts`/`index.ts` where channels/cron start); Modify `doctor.ts` to report the schedule; Test.

- [ ] **Step 1:** READ `packages/cron-adapter/src/scheduler.ts` + `packages/agent-app/src/{app.ts,channels.ts}` to find the cron-scheduling primitive and the lifecycle start point. Determine whether `cron-adapter` exposes a reusable next-run/cron-tick utility; if not, implement a minimal cron-expression next-run calculator (support `m h dom mon dow`, the two default expressions) + `setTimeout` loop with skip-overlap.
- [ ] **Step 2:** `startMemoryRituals({ store, reflection, migration, logger, clock?, setTimer? }) → { stop(): void }` — when the memory is a `BujoMemoryStore` at the `bujo` tier and reflection/migration are enabled, schedule `store.reflect()`/`store.migrate()` on their cron cadence; skip-overlap (don't start a run while one is in flight); never throw (catch + log). Use injectable timer/clock for tests.
- [ ] **Step 3:** wire it into the app start (alongside channels): when `config.memory?.mode === "bujo"` and the constructed memory store has `reflect`/`migrate`, start the rituals; stop them on shutdown.
- [ ] **Step 4: doctor.ts** — in the bujo memory section, report the configured reflection/migration cadence (and whether the scheduler will run — i.e. tier is bujo with an llm).
- [ ] **Step 5: tests** — `memory-rituals.test.ts`: with an injected fake timer + clock + a fake store (records reflect/migrate calls), assert reflect fires at the reflection cron tick, migrate at the migration tick, skip-overlap holds, a throwing reflect doesn't crash the scheduler. Update doctor test for the cadence line.
- [ ] **Step 6:** typecheck/build/test/arch. **Commit** `feat(agent-app): in-app memory ritual scheduler (auto reflect/migrate for the bujo tier)`.

---

## Task 7: Retire superseded v1 packages — delete from repo AND remove from npm (no back-compat)

**Retire:** `memory-md`, `memory-journal`, `memory-graph`, `memory-mcp` (the MCP server only exposed the journal/graph tools, which are gone — a bujo MCP is a follow-up). **Keep:** `memory-search` (embedding providers used by `memory-store`).

**Files:** Delete the four `packages/*` dirs; update `scripts/package-catalog.mjs`, root `package.json` devDeps, `PACKAGES.md`; npm deprecate/unpublish.

- [ ] **Step 1:** Confirm no remaining runtime imports of the four packages outside themselves. Grep `@mono-agent/memory-md|memory-journal|memory-graph|memory-mcp` across `packages/*/src` + `demos/`. (After P5-5, agent-host no longer imports journal/graph/mcp; the contract is in memory-store.) Re-point any stragglers; if `memory-md`'s markdown store has no remaining consumers, it goes too.
- [ ] **Step 2:** Delete `packages/memory-md`, `packages/memory-journal`, `packages/memory-graph`, `packages/memory-mcp`. Remove their entries from `scripts/package-catalog.mjs`, root `package.json` devDependencies, and `PACKAGES.md` (regenerate the mermaid/table per the repo convention — check `scripts/`). Remove `resolveMemoryMcpMainPath`/`memoryMcpRuntimeOptions` + `MEMORY_RECALL_TOOLS` wiring from agent-host (done in P5-5; verify gone).
- [ ] **Step 3:** `pnpm install`; `node scripts/check-package-architecture.mjs` → passed (it scans for stale references — fix any). Whole-repo typecheck/build of the remaining touched packages. **Commit** `refactor(memory)!: retire v1 packages (memory-md/journal/graph/mcp) — bujo substrate is the single engine`.
- [ ] **Step 4: remove from npm.** Check auth: `npm whoami`. For each retired package `@mono-agent/<name>`:
  - `npm deprecate "@mono-agent/<name>" "Retired in Memory v2 — replaced by @mono-agent/memory-store + @mono-agent/memory-bujo (tiered lite/journal/bujo). Do not use."` (always works for the scope owner; reversible).
  - Attempt full removal where npm policy allows: `npm unpublish "@mono-agent/<name>" --force` (npm blocks unpublish of public packages >72h old or with dependents; if it fails, the deprecation stands as the retirement signal).
  If `npm whoami` fails (not authenticated in this environment), DO NOT guess credentials — output the exact deprecate/unpublish commands for the four packages so the user can run them with `! <cmd>`, and note this in the report. This is the one step that may need the human.

---

## Task 8: Docs + composer for the tiered offering

**Files:** `docs/memory.md`, `docs/feature-registry.md`, `packages/agent-app/skills/mono-agent-composer/` (rewrite the memory step around the three tiers).

- [ ] **Step 1: docs/memory.md** — rewrite "Memory Modes" as the three tiers (lite/journal/bujo) over one substrate, with the capability table, prerequisites per tier, the auto-scheduler (now real — reflection/migration cron config), and the CLI. Remove the old markdown/journal-v1 descriptions.
- [ ] **Step 2: feature-registry.md** — replace the markdown/journal rows with `memory.lite`/`memory.journal`/`memory.bujo` tier rows + the reflection/migration cron keys + the auto-scheduler; update the CLI row.
- [ ] **Step 3: composer skill** — rewrite the memory discovery step around the three tiers (lite = no setup; journal = +Ollama embeddings; bujo = +chat model + auto-rituals), the config blocks per tier, and the prerequisite/validate reminders.
- [ ] **Step 4:** arch check still green. **Commit** `docs(memory): tiered offering (lite/journal/bujo) + auto-scheduler in registry/guide/composer`.

---

## Task 9: Phase-5 gate + real e2e + PR

- [ ] **Step 1:** `node scripts/check-package-architecture.mjs` → passed.
- [ ] **Step 2:** Whole-repo build + typecheck (`pnpm -r --sort run build`/`typecheck` or the touched set) → clean. Full test suites for touched packages → green.
- [ ] **Step 3: real e2e (Ollama):** drive each tier in a tmp root: `lite` (no embeddings → keyword recall works), `journal` (embeddings → hybrid recall + decay), `bujo` (embeddings+llm → capture+reflect; and exercise `startMemoryRituals` with a near-immediate cron + injected fast timer to confirm a scheduled reflect actually runs).
- [ ] **Step 4: final holistic review** of P5 (cohesion of the tiers, contract move, scheduler, removals — nothing orphaned; the live-rollout config for the bujo tier is correct).
- [ ] **Step 5: Open the PR** with `gh pr create` from `feat/memory-bujo` → base `main`: title "Memory v2 — Bullet-Journal tiered memory (lite/journal/bujo) + rituals + scheduler"; body summarizing P1–P5 (substrate, capture intelligence, rituals, surfacing, tiered offering + auto-scheduler), the real-Ollama verification, the tier table, the breaking change (memory.mode values + removed packages — no back-compat), and the live-rollout steps. Do NOT push to main directly; do NOT auto-cutover the live service.
- [ ] **Step 6:** Report the PR URL.

---

## Self-Review (planning)
- Direction: tiered substrate, no back-compat (user-approved). lite/journal/bujo over `memory-store`+`memory-bujo`; v1 packages removed; contract relocated; rituals auto-scheduled (closes the P4 runtime gap).
- Risk/order: contract move (Task 2) keeps a temp re-export so the tree stays green until the v1 removal (Task 7). agent-host reroute (Task 5) must land before the removals. Embeddings-optional (Task 1) underpins the lite tier.
- Boundaries preserved: memory-store/memory-bujo stay `context`; the scheduler lives in agent-app (`app`), which may depend on everything; injected-LLM design intact.
- Watch-outs: memory-mcp cascade (Task 7 decision (a) vs (b)); PACKAGES.md regeneration; any test/demo referencing removed modes/packages.
