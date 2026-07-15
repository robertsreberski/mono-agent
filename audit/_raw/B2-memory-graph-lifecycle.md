# B2-memory-graph-lifecycle — memory bujo graph & lifecycle

## 1 Verdict & maturity grade

**Grade: B+**

This is the most rigorously engineered subsystem I have seen in the repo: every canonical write is fsync-ordered, compare-and-swapped against dev/ino/mtime/ctime identity, and proved against a strict replay-authority sidecar before and after mutation. Correctness discipline is exceptional — three-round stability retries, symlink-attack defenses, and multi-phase crash-recoverable transactions (rebuild/rollback, capture-outbox replay, explicit-forget backup/restore) are all internally consistent and (where checked) matched by heavy test suites (`safe-rebuild.test.ts` 2,442 lines/80 cases, `capture-outbox.test.ts` 1,556 lines, `store.test.ts` 1,776 lines, `replay-adoption.test.ts` 1,002 lines). Live-instance evidence (`~/personal-agent/.mono-agent`) confirms the replay-projection sidecar, managed-generation manifest, runtime snapshot, and the explicit-forget backup/restore feature are all genuinely exercised in production, not merely theoretical.

The grade is not higher because (a) one previously-filed, still-open perf regression (#231) remains unfixed at HEAD, verified present in the exact file/line the issue describes, and (b) the sheer density of adversarial-grade crash/tamper hardening — appropriate for a multi-tenant server, applied here to a single local writer process — sits in real tension with the v1 premise's "lean, understandable core." A competent stranger extending this code has to internalize an enormous amount of invariant machinery before touching any one of these 17 files safely. Two small, cleanly provable pieces of dead code (`BujoMemoryStore.reflect()`/`.decay()`) round out the deductions.

This is a code-only territory (no live-instance operational audit requested beyond the deprecation-removability check), so no separate Framework-fit grade is given.

## 2 Findings

**F1 [P2] — Issue #231 (constant-time non-BuJo replay guard) is still open and unfixed at HEAD.**
`packages/memory/src/bujo/mutation-lock.ts:171-176`
```
  } else {
    const replay = replayProjectionDbSnapshot(db);
    if (hasReplayProjectionState(replay)) {
```
`replayProjectionDbSnapshot` (`replay-projection.ts:360-361`) calls `readRawDbSnapshot(db)` → `db.replayProjectionSnapshot()`, which selects and maps **every** memory and edge row. This runs inside `recoverDurableMutationState`, which is invoked from `withSerializedBujoMutation` on **every** Lite/Journal `appendHostSummary` call — the always-on per-turn write path (`store.ts:434-443`: `return this._tier === "bujo" ? ... : await this.runAdmittedMutation(...)`). The issue's own benchmark (300 recovery checks: ~70ms at 0 rows → 585ms at 1,000 rows vs. ~25-30ms constant pre-regression) is corroborated by the code path read here. GitHub confirms the issue is still `state: OPEN` with no linked fix commit. This is premise-relevant because Lite/Journal are the two "quick, no-LLM" tiers the v1 pitch leans on for "seconds-to-minutes" setup, and the regression grows quadratically in aggregate as a personal-agent's memory naturally accumulates over months.

**F2 [P2] — Dead production code: `BujoMemoryStore.reflect()`/`.decay()`.**
`packages/memory/src/bujo/store.ts:666-687` and `store.ts:816-823`, both marked `@deprecated`. Neither method appears on the `MemoryStore` contract (`packages/agent-contracts/src/memory.ts:49-76` lists only `load`/`appendHostSummary`/`persistCompletedTurn`/`scheduleCapture`/`flush`/`releaseTurn`), neither is called anywhere in `packages/agent-app/src` (verified by repo-wide grep), and neither is referenced by any `~/personal-agent` or `~/a8c-agents/*` launchd plist or script. Only `store.test.ts` and `memory-health-audit.test.ts` call `.reflect()`/`.decay()` directly on a `BujoMemoryStore` instance. See Section 4 for why this is narrower than "remove the whole `reflect` surface."

**F3 [P3] — Stale/contradictory comment about the dead `about` edge kind.**
`packages/memory/src/bujo/rebuild.ts:90-91`:
```
 * Note: memory↔entity `about` edges are NOT stored in markdown/graph.jsonl (P2 known lossiness)
 * and are intentionally NOT rebuilt here. This is documented and deferred to P3+.
```
vs. `packages/memory/src/store/db.ts:1277`:
```
   * graph `about` edges are intentionally empty in v1 and are retired together with
```
These describe the same fact (no code path anywhere in `packages/memory/src` ever constructs an `"about"` edge — confirmed by repo-wide grep; only defensive *tolerance* of the value remains at `rebuild.ts:1426`, `rebuild.ts:2291`, `replay-projection.ts:880`) with opposite framing: one implies unfinished future work ("deferred to P3+"), the other says it is permanently retired. For a frozen v1 using PR-based versioning, the phase-numbered comment is misleading residue from an earlier roadmap era and should be corrected to match `db.ts`'s "retired" framing.

**F4 [P2] — Premise tension: disproportionate defensive-hardening density for a single local writer.**
Across this territory's 17 files (~14k LOC), nearly every file operation is guarded by dev/ino/mtime/ctime/mode/nlink/uid identity pinning (e.g. `path-safety.ts:502-514`, `generations.ts:806-824`, `explicit-forget.ts:913-933`), symlink-attack rejection (`path-safety.ts:545-558`, `generations.ts:571-587`), and multi-round stability retries (`audit.ts:132-159` `MAX_STABILITY_ATTEMPTS=3`, `graph-parity.ts:22` `MAX_AUDIT_ATTEMPTS=3`). `explicit-forget.ts` alone implements a 6-phase crash-recoverable transaction (`applying → restore-prepared → quarantine-intent → root-quarantined → activation-intent → root-activated`, lines 60-66). This is the correct level of care for a multi-writer/multi-tenant server; for a single-process local personal-agent store it is a legibility tax that directly works against the v1 premise's "lean, understandable core… open to external plugins." Not a bug — a maturity/scope judgment call worth an explicit freeze-time decision rather than silent acceptance.

**F5 [P3] — `rebuildFromMarkdown` is public API with zero internal consumers.**
`packages/memory/src/bujo/rebuild.ts:93`, re-exported at `packages/memory/src/bujo/index.ts:13`. Repo-wide grep of `packages/agent-app/src` finds no caller; the real product rebuild path is `safeRebuildMemoryIndex`/`safeRebuildMemoryIndexForMaintenance`, which layers the entire managed-generation/rollback/replay-projection machinery this simpler function predates and does not participate in. It is exercised only by its own unit test (`rebuild.test.ts`, 140 lines). Kept as public API it is not dangerous, but its docstring gives no pointer to the supported managed path, risking a future external consumer of `@mono-agent/memory` picking the wrong entry point and producing an unmanaged, un-rollback-able SQLite file.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
|---|---|---|---|
| `store.ts:666-687` `BujoMemoryStore.reflect()` | Not on `MemoryStore` contract; no caller in `agent-app`; no live-instance/script reference | Remove now | `grep -rn "\.reflect(" packages/agent-app/src` → 0 hits; `grep -rn "\.reflect(" --include="*.ts" .` → only `store.test.ts`/`memory-health-audit.test.ts` |
| `store.ts:816-823` `BujoMemoryStore.decay()` | Same as above; also no CLI wiring at all (`cli.ts` never calls `.decay()`) | Remove now | Same grep; no `memory-bujo decay` subcommand exists in `cli.ts` |
| `MemoryEdgeKind` value `"about"` (`store/types.ts:52`, `store/db.ts` schema/queries) | No writer anywhere ever constructs an `"about"` edge; only tolerated in comparisons | Low priority: either drop the value from the union + validators, or leave as explicitly-retired (already the case per `db.ts:1277`) — just fix F3's comment drift | `grep -rn '"about"'` across `packages/memory/src` shows only type unions and read-side tolerance, never a write |
| `rebuild.ts:93` `rebuildFromMarkdown` | Zero callers outside its own test; superseded product-wide by `safeRebuildMemoryIndex` | Keep as documented low-level public utility, or mark `@deprecated`/`@internal` if no external consumer is known | `grep -rn "rebuildFromMarkdown" packages/agent-app/src` → 0 hits |

## 4 Deprecation & legacy

- **`reflect.ts` (standalone function) — load-bearing, NOT removable now.** `@deprecated Reflection is a compatibility/read-only status probe in v1` (`reflect.ts:24`). Still wired into the published `memory-bujo` CLI binary (`packages/memory/package.json:26` → `dist/bujo/cli.js`) as the `reflect` subcommand (`cli.ts:99-112`), and explicitly documented across `docs/memory/index.md`, `docs/memory/rituals.md`, `docs/memory/validation-and-cli.md`, `docs/config/env-vars.md`, `docs/observability/phoenix-and-backfill.md` as an intentional legacy compatibility surface "for old-store maintenance." Grep across `~/personal-agent`, `~/a8c-agents/*`, and every launchd plist under `~/Library/LaunchAgents` finds **zero** invocations of `memory-bujo reflect` or `memory-bujo migrate` in Robert's own fleet — but `@mono-agent/memory` is a published npm package (v0.3.0+) with external consumers potentially still holding pre-replay-projection stores, and removing a documented CLI subcommand is a breaking change to that published contract. **Verdict: keep for now; candidate for a deliberate v2 breaking-change removal, not a silent v1-freeze deletion.**

- **`store.ts`'s `.reflect()`/`.decay()` method wrappers — removable now.** See F2. These are a *thinner* deprecation than the module-level function: they exist only as `MemoryStore`-shaped conveniences on the class, are not part of the exported contract, and have no CLI or app-level caller at all (unlike `reflect.ts`, which is still reachable from the CLI). Distinct disposition from the CLI-level `reflect`/`migrate` surface above.

- **`"legacy-*"` family (`ManagedGeneration.origin: "legacy-snapshot"`, `ReplayProjectionAuthorityKind: "legacy-adoption"`, `adoptLegacyRollback`, `legacyReplayProjectionFromDb`, `adoptLegacyReplayProjection`) — load-bearing, NOT removable.** These implement the one-time upgrade path from a pre-managed / pre-replay-projection SQLite database into the current schema. `replay-projection.ts` itself landed only in PR #219 (`86241c0a`, 2026-07-12 — three days before this audit), and `~/personal-agent/.mono-agent/memory/.index/manifest.json` shows the live store's active generation was created 2026-07-14, i.e. *after* that PR — meaning this exact legacy-adoption code path was almost certainly exercised very recently as part of the framework's own evolution, not stale relic code. Keep.

- **`explicit-forget.ts` (#245, "reversible explicit forget plans") — NOT deprecated, actively load-bearing, reversibility CONFIRMED.** Wired to the documented, config-aware `mono-agent memory forget prepare|apply|restore` CLI (`packages/agent-app/src/cli.ts:235-241,978-988`, `packages/agent-app/src/memory-command.ts`). Live-instance proof: `~/personal-agent/.mono-agent/.memory-forget-backup-01e5da2d0738871a9bf58a6c/manifest.json` shows a real backup with `"status": "applied"`, `createdAt: 2026-07-14T20:48:08Z` — i.e. this exact forget operation was run in production one day before this audit, and the pre-forget tree remains durably backed up on disk for `restoreExplicitMemoryForget` to reverse. This directly answers the focus question: reversibility is real and proven, not just designed-on-paper.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| B2-1 | Delete `BujoMemoryStore.reflect()` and `.decay()` dead methods | Dead-code hygiene / "lean core" premise | Remove `store.ts:666-687,816-823`; drop now-unused `ReflectResult`/`reflectFn` imports if nothing else needs them; update the 2 test files that call them directly | S | `grep -rn "\.reflect(\|\.decay(" --include="*.ts" .` shows no `BujoMemoryStore` method call sites left; `pnpm --filter @mono-agent/memory test` green | n |
| B2-2 | Fix or explicitly re-triage issue #231 (constant-time non-BuJo replay guard) | Tracked, still-open perf regression on the hot Lite/Journal write path; its own DoD is unmet | Replace `replayProjectionDbSnapshot(db)` in `mutation-lock.ts`'s non-bujo branch with a bounded `EXISTS … LIMIT 1` probe over `valid_to`/`superseded_by`/`superseded_at` and thread/supersedes edges, per the issue's acceptance criteria | M | Issue's own benchmark: recovery cost flat across 0/300/1,000 rows; full strict/rebuild/replay-adoption/capture suites green | n (repo's own gate already deemed it non-blocking, but should not remain open indefinitely post-freeze) |
| B2-3 | Reconcile the contradictory "about" edge comments | Legibility — a frozen codebase should not carry a "deferred to P3+" comment for work that will never happen | Update `rebuild.ts:90-91` to state the edge kind is retired (matching `db.ts:1277`), or actually drop `"about"` from `MemoryEdgeKind` if a maintainer wants full removal | S | `grep -rn "deferred to P3" packages/memory/src` → 0 hits | n |
| B2-4 | Record an explicit rationale for this subsystem's crash/tamper-hardening posture | Premise tension (F4) — prevents a future contributor from either (a) copying this density into a lower-stakes file, or (b) "simplifying" away a safety property they don't understand | Add a short section to `docs/memory/index.md` or a package-level README explaining the actual threat model (crash-mid-fsync, concurrent CLI-vs-running-agent collision — not multi-tenant/adversarial-network) | S | Doc merged; reviewed once by someone outside this subsystem for comprehension | n |
| B2-5 | Point `rebuildFromMarkdown`'s docstring at the supported managed path | API-surface hygiene for `@mono-agent/memory` external consumers | Add a `@see safeRebuildMemoryIndex` / "superseded for product use" note to its JSDoc, or mark `@internal` if no external consumer is confirmed | S | JSDoc updated; `pnpm --filter @mono-agent/memory build` green | n |

## 6 Skill-worthy flags

- **Deprecation-removability protocol.** This territory's "prove or disprove removable now" question required a specific multi-step grep discipline: (1) grep the symbol across all non-test app/cli source, (2) grep demos/scripts, (3) grep both live-instance directories *and every launchd plist*, (4) grep docs for whether the surface is *documented* as intentionally-retained legacy vs. accidentally-orphaned, (5) where a CLI binary is involved, check `package.json`'s `bin` field to see if it's a *published* contract (raising the bar for removal beyond "no current caller"). This produced two different verdicts for what looked like the same deprecation (`reflect.ts` function = keep, `store.ts` methods = remove) — a shallower check would likely have lumped them together. Worth writing up as an amendment to an existing skill (closest fit: `verify-green` or a new `deprecation-sweep` skill) so other auditors/agents doing this kind of "is X still needed" triage follow the same 5-step protocol instead of a single grep.
- **Live-instance JSON artifacts as ground truth.** Reading `~/personal-agent/.mono-agent/memory/.index/{manifest.json,runtime.json}` and the `.memory-forget-backup-*/manifest.json` sidecar directly (read-only) turned two "is this feature actually used" questions from speculative into proven-with-a-timestamp. This pairs well with the existing `fleet-deploy`/`live-smoke` skills' "verify against the real instance" ethos — worth a one-line addition to whichever skill covers audit/health-check methodology: "for content-addressed/manifest-based subsystems, read the live manifest/runtime sidecar files directly (mode=ro, no writes) before declaring a code path exercised or unused."

## 7 Coverage note

Files read in full (primary scope, all 17 named files):
- `packages/memory/src/bujo/rebuild.ts` (2,537 lines, read in 5 sequential chunks)
- `packages/memory/src/bujo/graph.ts` (738 lines)
- `packages/memory/src/bujo/graph-parity.ts` (448 lines)
- `packages/memory/src/bujo/reconcile.ts` (725 lines)
- `packages/memory/src/bujo/replay-projection.ts` (1,097 lines)
- `packages/memory/src/bujo/replay-adoption.ts` (470 lines)
- `packages/memory/src/bujo/generations.ts` (846 lines)
- `packages/memory/src/bujo/migrate.ts` (1,022 lines)
- `packages/memory/src/bujo/explicit-forget.ts` (950 lines)
- `packages/memory/src/bujo/audit.ts` (786 lines)
- `packages/memory/src/bujo/maintenance.ts` (200 lines)
- `packages/memory/src/bujo/mutation-lock.ts` (208 lines)
- `packages/memory/src/bujo/path-safety.ts` (641 lines)
- `packages/memory/src/bujo/runtime-snapshot.ts` (220 lines)
- `packages/memory/src/bujo/capture-outbox.ts` (1,615 lines, read in 2 chunks)
- `packages/memory/src/bujo/reflect.ts` (32 lines)
- `packages/memory/src/bujo/store.ts` (1,356 lines)

Catch-all file read (not in B1's named list, no explicit B2 assignment either — ambiguous `llm*` wildcard match, flagged for the parent so it isn't silently dropped from either auditor's coverage):
- `packages/memory/src/bujo/ollama-llm.ts` (45 lines) — a small, clean Ollama HTTP client; no graph/lifecycle relevance found, thematically belongs with B1's LLM group.

Supporting reads for cross-verification (not audited line-by-line, used to confirm findings):
- `packages/agent-contracts/src/memory.ts` (`MemoryStore` interface, ~90 lines) — confirmed `reflect`/`decay`/`migrate`/`consolidate` are not part of the contract
- `packages/agent-app/src/memory-rituals.ts` (306 lines, full) — confirmed `consolidate()` is the only in-app-scheduled ritual; `migrate()`/`reflect()`/`decay()` are not
- `packages/memory/src/store/db.ts` (targeted `sed`/grep excerpts around `"about"` edges and `replaceCanonicalGraphProjection`)
- `packages/memory/package.json` (`bin` field)
- `docs/memory/{index.md,rituals.md,validation-and-cli.md,capture-and-recall.md,backends-comparison.md}` and `docs/config/env-vars.md`, `docs/observability/phoenix-and-backfill.md`, `docs/reference/{feature-matrix.md,feature-registry.md,glossary.md}` (grep excerpts) — deprecation/documentation cross-check
- `packages/agent-app/src/cli.ts` (grep excerpts around `forget`/`reflect`/`migrate` subcommands)
- Test files (`describe`/`it` listings and line counts only, not line-by-line audited): `rebuild.test.ts` (full skim, 140 lines), `safe-rebuild.test.ts` (2,442 lines / 80 cases), `memory-health-audit.test.ts` (1,679 lines), `explicit-forget.test.ts` (506 lines / 18 cases), `store.test.ts` (describe/it grep for mutation-lock coverage), `graph.test.ts`, `graph-parity.test.ts`, `reconcile.test.ts`, `replay-projection.test.ts`, `replay-adoption.test.ts`, `migrate.test.ts`, `path-safety.test.ts`, `runtime-snapshot.test.ts`, `capture-outbox.test.ts`, `reflect.test.ts` (line counts only)
- GitHub issues: `gh issue view 231`, `gh issue view 245` (full)
- Live-instance artifacts (read-only): `~/personal-agent/.mono-agent/memory/.index/{manifest.json,runtime.json}`, `~/personal-agent/.mono-agent/.memory-forget-backup-01e5da2d0738871a9bf58a6c/manifest.json`; directory listings of `~/a8c-agents/*` (no comparable bujo memory root found there to inspect)
- `git log` on `replay-projection.ts` to date PR #219's introduction

No named scope file was missing.
