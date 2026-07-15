# 08 · Memory bujo graph & lifecycle

**Scope:** the bujo memory tier's graph/rebuild/replay-projection/mutation-lock/explicit-forget/generations lifecycle machinery (17 files, ~14k LOC under `packages/memory/src/bujo/`).
**Maturity grade:** B+ (verifier-adjusted: all 5 findings CONFIRMED as originally rated; no severity changes). The subsystem is the most rigorously engineered code in the repo — fsync-ordered canonical writes, dev/ino/mtime/ctime identity pinning, symlink-attack defenses, and multi-phase crash-recoverable transactions are internally consistent and matched by heavy test suites, with live-instance evidence (`~/personal-agent/.mono-agent`) confirming the replay-projection sidecar, managed-generation manifest, and explicit-forget backup/restore are genuinely exercised in production. The grade is held back by one still-open tracked perf regression (#231) and a real premise tension between adversarial-grade hardening (appropriate for a multi-tenant server) and the v1 "lean, understandable core" goal, plus two small provably-dead methods.

## Findings

**F1 [P2] [verifier: CONFIRMED] — Issue #231 (constant-time non-BuJo replay guard) is still open and unfixed at HEAD.**
`packages/memory/src/bujo/mutation-lock.ts:171-176`
```
  } else {
    const replay = replayProjectionDbSnapshot(db);
    if (hasReplayProjectionState(replay)) {
```
`recoverDurableMutationState` runs on **every** `withSerializedBujoMutation` call (`mutation-lock.ts:89`); the non-bujo branch calls `replayProjectionDbSnapshot(db)` unconditionally, scanning every memory and edge row. This is invoked from the always-on per-turn write path for Lite/Journal (`store.ts:434-443`, via `runAdmittedMutation`). The issue's own benchmark (~70ms at 0 rows → 585ms at 1,000 rows vs. ~25-30ms constant pre-regression) is corroborated by the code path. `gh issue view 231` confirms `state: OPEN`, no linked fix. Premise-relevant because Lite/Journal are the "quick, no-LLM" tiers the v1 pitch relies on, and the cost grows with a personal-agent's memory as it naturally accumulates over months.

**F2 [P2] [verifier: CONFIRMED] — Dead production code: `BujoMemoryStore.reflect()`/`.decay()`.**
`packages/memory/src/bujo/store.ts:666-687` and `store.ts:816-823`, both marked `@deprecated`. Neither method appears on the `MemoryStore` contract (`packages/agent-contracts/src/memory.ts:49-76`), neither is called anywhere in `packages/agent-app/src`, and neither is referenced by any `~/personal-agent` or `~/a8c-agents/*` launchd plist or script — verifier re-ran the greps (incl. `--include=*.ts packages extras demos scripts website`, excluding `/dist/` and `.test.ts`) and got **zero** hits outside `store.test.ts`/`memory-health-audit.test.ts`. The CLI's `reflect` subcommand calls the standalone `reflect.ts` function, not this store method — a distinct, load-bearing surface (see Dead code section). Removable now.

**F3 [P3] [verifier: CONFIRMED] — Stale/contradictory comment about the dead `about` edge kind.**
`packages/memory/src/bujo/rebuild.ts:90-91`:
```
 * Note: memory↔entity `about` edges are NOT stored in markdown/graph.jsonl (P2 known lossiness)
 * and are intentionally NOT rebuilt here. This is documented and deferred to P3+.
```
vs. `packages/memory/src/store/db.ts:1277`: "graph `about` edges are intentionally empty in v1 and are retired together with...". No code path anywhere ever constructs an `"about"` edge (only defensive tolerance remains). The two comments describe the same fact with opposite framing — one implies unfinished future work, the other says permanently retired. For a frozen v1 using PR-based versioning, the phase-numbered comment is misleading residue and should be corrected to match `db.ts`'s "retired" framing.

**F4 [judgment, non-severity] [verifier: CONFIRMED] — Premise tension: disproportionate defensive-hardening density for a single local writer.**
Across this territory's 17 files, nearly every file operation is guarded by dev/ino/mtime/ctime/mode/nlink/uid identity pinning, symlink-attack rejection, and multi-round stability retries (e.g. `path-safety.ts:502-514`, `generations.ts:806-824`, `audit.ts:132-159` `MAX_STABILITY_ATTEMPTS=3`). `explicit-forget.ts` alone implements a 6-phase crash-recoverable transaction. This is the correct level of care for a multi-writer/multi-tenant server; for a single-process local personal-agent store it is a legibility tax that works against the "lean, understandable core… open to external plugins" premise. Verifier confirms this is a legitimate judgment call, not a defect — actionable as a documented, explicit freeze-time decision rather than silent acceptance.

**F5 [P3] [verifier: CONFIRMED] — `rebuildFromMarkdown` is public API with zero internal consumers.**
`packages/memory/src/bujo/rebuild.ts:93`, re-exported at `packages/memory/src/bujo/index.ts:13`. Verifier re-grepped (`packages extras demos scripts`, excluding `/dist/` and `.test.ts`) and found only the definition, the re-export, and one comment mention (`db.ts:1001`) — no real caller. The product rebuild path is `safeRebuildMemoryIndex`/`safeRebuildMemoryIndexForMaintenance`, which layers the managed-generation/rollback/replay-projection machinery this simpler function predates and does not participate in. Kept as public API it is not dangerous, but its docstring gives no pointer to the supported managed path, risking an external `@mono-agent/memory` consumer picking the wrong entry point and producing an unmanaged, un-rollback-able SQLite file.

No NEW findings from the verifier apply to this territory (verifier's NEW-1, on the dead-in-shipped-product capture queue, is explicitly B1-scoped — "enlarges B1-2/B1-3's cleanup scope" — and is covered in the B1 write-up, not here).

## Dead code & deprecation

**Proven dead (grep-verified by both auditor and verifier):**

| Path | Why dead | Proof |
|---|---|---|
| `store.ts:666-687` `BujoMemoryStore.reflect()` | Not on `MemoryStore` contract; no caller in `agent-app`; no live-instance/script reference | `grep -rn "\.reflect(" --include=*.ts packages extras demos scripts website \| grep -v /dist/ \| grep -v .test.ts` → 0 hits outside tests (re-run by verifier, confirmed) |
| `store.ts:816-823` `BujoMemoryStore.decay()` | Same as above; also no CLI wiring (`cli.ts` never calls `.decay()`) | Same grep; no `memory-bujo decay` subcommand exists |
| `rebuild.ts:93` `rebuildFromMarkdown` | Zero callers outside its own test; superseded product-wide by `safeRebuildMemoryIndex` | `grep -rn rebuildFromMarkdown --include=*.ts packages extras demos scripts \| grep -v /dist/ \| grep -v .test.ts` → def + re-export + one comment only (verifier re-ran) |
| `MemoryEdgeKind` value `"about"` (`store/types.ts:52`, `store/db.ts` schema/queries) | No writer anywhere ever constructs an `"about"` edge; only tolerated in comparisons | `grep -rn "'about'\|\"about\""` filtered to insert/values/push/write → no writer (verifier cross-checked against B3's independent finding, consistent) |

**Explicitly REFUTED-as-dead by the verifier (do not delete):** none in this territory — the verifier confirmed every dead-code claim the auditor made and did not overturn any.

**Suspected but load-bearing / keep (not dead, do not remove):**
- `reflect.ts` (standalone module function) — still wired into the published `memory-bujo` CLI binary as the `reflect` subcommand (`cli.ts:99-112`), documented across multiple docs pages as intentional legacy compatibility. A published `bin` contract; verifier confirms KEEP, distinct from the dead `store.ts` method wrappers (F2).
- `"legacy-*"` family (`ManagedGeneration.origin: "legacy-snapshot"`, `ReplayProjectionAuthorityKind: "legacy-adoption"`, `adoptLegacyRollback`, `legacyReplayProjectionFromDb`, `adoptLegacyReplayProjection`) — load-bearing one-time upgrade path from pre-managed/pre-replay-projection stores; live-instance manifest evidence shows this path was almost certainly exercised as recently as 2026-07-14. Verifier: keep, not re-derived but no contradiction found.
- `explicit-forget.ts` (#245) — actively load-bearing, wired to the documented `mono-agent memory forget prepare|apply|restore` CLI; live-instance backup manifest (`~/personal-agent/.mono-agent/.memory-forget-backup-*`) proves a real forget-and-restore cycle ran in production one day before the audit. Verifier: keep, not re-derived, no contradiction.

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
|---|---|---|---|---|---|---|
| B2-1 | Delete `BujoMemoryStore.reflect()` and `.decay()` dead methods | Dead-code hygiene / "lean core" premise; verifier-confirmed zero callers | Remove `store.ts:666-687,816-823`; drop now-unused `ReflectResult`/`reflectFn` imports if nothing else needs them; update the 2 test files that call them directly | S | `grep -rn "\.reflect(\|\.decay(" --include="*.ts" .` shows no `BujoMemoryStore` method call sites left; `pnpm --filter @mono-agent/memory test` green | n |
| B2-2 | Fix or explicitly re-triage issue #231 (constant-time non-BuJo replay guard) | Tracked, still-open perf regression on the hot Lite/Journal write path, verifier-confirmed present at HEAD | Replace `replayProjectionDbSnapshot(db)` in `mutation-lock.ts`'s non-bujo branch with a bounded `EXISTS … LIMIT 1` probe over `valid_to`/`superseded_by`/`superseded_at` and thread/supersedes edges, per the issue's acceptance criteria | M | Issue's own benchmark: recovery cost flat across 0/300/1,000 rows; full strict/rebuild/replay-adoption/capture suites green | n |
| B2-3 | Reconcile the contradictory "about" edge comments | Legibility — a frozen codebase should not carry a "deferred to P3+" comment for work that will never happen | Update `rebuild.ts:90-91` to state the edge kind is retired (matching `db.ts:1277`), or actually drop `"about"` from `MemoryEdgeKind` if a maintainer wants full removal | S | `grep -rn "deferred to P3" packages/memory/src` → 0 hits | n |
| B2-4 | Record an explicit rationale for this subsystem's crash/tamper-hardening posture | Premise tension (F4), verifier-confirmed as a legitimate judgment call, not a defect | Add a short section to `docs/memory/index.md` or a package-level README explaining the actual threat model (crash-mid-fsync, concurrent CLI-vs-running-agent collision — not multi-tenant/adversarial-network) | S | Doc merged; reviewed once by someone outside this subsystem for comprehension | n |
| B2-5 | Point `rebuildFromMarkdown`'s docstring at the supported managed path | API-surface hygiene for `@mono-agent/memory` external consumers | Add a `@see safeRebuildMemoryIndex` / "superseded for product use" note to its JSDoc, or mark `@internal` if no external consumer is confirmed | S | JSDoc updated; `pnpm --filter @mono-agent/memory build` green | n |

## Quarantine (refuted/unproven)

None. The verifier confirmed all 5 findings and both the "removable now" and "keep" dead-code/deprecation classifications for this territory exactly as originally rated — no auditor claim in B2 was refuted or left unproven. (For cross-artifact context: the cluster-wide "Confirmed freeze-blockers: None" verdict and the three rejected freeze-blockers in V3 all belong to B1/B3, not B2 — B2 never claimed a freeze-blocker.)
