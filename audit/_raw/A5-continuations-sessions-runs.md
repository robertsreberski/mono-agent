# A5-continuations-sessions-runs — agent-app continuations, sessions & run history

## 1 Verdict & maturity grade

**Grade: B+.** This is a source-only territory (no live-instance access in scope), so no separate Framework-fit grade is given.

The durable-continuation subsystem (`continuation-service.ts` + `continuation-store.ts`, ~3,600 lines combined) is the most rigorously engineered code I have read in this audit pass: content-addressed origin-context snapshots with HMAC domain-separated bindings, atomic per-record transactions with bounded recovery, a fail-closed v2→v3 rollback guard I independently verified against the actual v0.10.0 source (an old runtime's `loadRecordDirectory` throws on the unexpected guard-file entry), and a lease/settlement state machine that consistently refuses to guess at ambiguous outcomes (`delivery_unknown` rather than silently retrying a possibly-already-delivered message). Test coverage of this subsystem's hardest edges (crash mid-delivery, crash mid-synthesis, interrupted migration, SQLite owner-lock crash recovery, group-commit recovery) is excellent. `request-model-override.ts` and `run-history.ts` are similarly disciplined: the former's direct-OpenCode/Claude/sandbox interaction matrix is fully covered by tests, the latter treats its own tool output as untrusted-evidence and redacts credentials/system-prompt/reasoning leakage defensively.

The grade is not higher because of one concrete "honest ops" gap that lands squarely in this part's premise: `mono-agent restart --force` prints "Cleared persisted sessions" but does not clear the new v0.11.0 durable conversation-history store, so an operator's explicit reset is not what it claims to be (F1) — this is also the literal unmet acceptance bullet of open issue #203. Two files in this part (`continuation-service.ts` at 2,001 lines, `continuation-store.ts` at 1,615 lines) also strain the "lean, understandable core" premise purely by size, even though their internal documentation is unusually good. A thin test file for `runs-health.ts` (one test for 204 lines of branching "honest ops" status logic) rounds out the gaps.

## 2 Findings

**F1 — P1.** `mono-agent restart --force` claims to clear persisted sessions but leaves the new durable conversation-history store (added in v0.11.0) untouched, directly failing the explicit "clearing sessions/history must have an explicit operator command" requirement of open issue #203.
- `packages/agent-app/src/sessions.ts:26-42` — `purgeSessions()` resolves and deletes only `resolveAppSessionsRoot` (the pi-native `piSessionsRoot` JSONL store):
  ```ts
  export async function purgeSessions(input: MonoAgentAppConfigInput): Promise<PurgeSessionsResult> {
    const root = await resolveAppSessionsRoot(input);
  ```
- `packages/agent-app/src/cli.ts:4278-4281` — the only caller, printing an unqualified success message:
  ```ts
  const result = await purgeSessions({ env: environment, cwd: target.cwd, configPath: target.configPath });
  ...
  process.stdout.write(`${ui.badge("ok")}${ui.style.bold("Cleared persisted sessions")}${count}.\n`);
  ```
- `packages/agent-app/src/configured-agent.ts:430-431` (adjacent file, cited for evidence) shows the durable history store lives at an entirely separate root that `purgeSessions` never resolves:
  ```ts
  const historyStore = options.historyStore ?? createDurableHistoryStore({
    root: resolvePath(config.artifacts.dir, "..", "history"),
  ```
  I confirmed via `grep` across `packages/agent-app/src/*.ts` and `packages/agent-harness/src/*.ts` that no `purge`/`clear`/`reset` function exists anywhere for this store, and `docs/runtime/sessions-concurrency.md:31`'s boundary-rules table (which enumerates exactly what `restart --force` purges vs. what survives) does not mention the conversation-history store in either column — the table was not updated when the durable-history feature (CHANGELOG 0.11.0, commit `c2fccfe5`) landed. Per that changelog, this history store holds up to 64 messages per exact conversation id, disk-backed and restart-durable — precisely the kind of state an operator running `--force` to get a clean slate would expect wiped. **Why it matters**: violates "honest ops" (the CLI reports success at a task it did not fully perform) and is the literal unmet DoD bullet of issue #203, which otherwise appears to have been substantially delivered by the 0.11.0 durable-history work.

**F2 — P2.** Runs-health has almost no test coverage for a file that is the "honest ops" surface operators actually read (`mono-agent status`/doctor summaries).
- `packages/agent-app/src/runs-health.ts:1-204` implements stale-running detection, owner-gone detection, user-cancelled-vs-other-cancelled distinction, failure-kind histograms with human explanations, and relative-age formatting bucketed by second/minute/hour/day.
- `packages/agent-app/src/__tests__/runs-health.test.ts` contains exactly **one** test (the "user cancellation does not degrade health" case). None of `isStaleRunningRun`, `runningWhileOwnerGone`, the failure-kind histogram/description path, `formatRelativeAge`'s minute/hour/day boundaries, or the `hasWarnings` aggregation across multiple concurrent warning sources are exercised. **Why it matters**: this module decides whether an operator sees "ok" vs. "waiting" for their agent; an off-by-one in the stale-running threshold or the histogram sort would silently misreport health with no test to catch it — directly a "missing test coverage of load-bearing behavior" per the audit brief.

**F3 — P2 (cross-territory; flagging to answer the assigned focus question, likely primary ownership is the deployment/launchd audit part).** The framework has no bound on the raw process stderr/stdout stream that produces the reported 1.23 GB rotated err log; only recorded run artifacts are retention-bounded.
- `packages/agent-app/src/artifact-retention.ts:1-162` (fully in scope) only ever calls `pruneRunArtifacts` over `agent`/`memory` `RunArtifactScope`s — i.e., `*.summary.json`/`*.events.jsonl` files — with sane defaults (`DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS = 365`, `DEFAULT_ARTIFACT_RETENTION_MAX_COUNT = 50_000` in `packages/config/src/config.ts:99-102`). There is no code path in this file (or anywhere I found in `agent-app/src`) that bounds or rotates a raw log stream.
- `packages/agent-app/src/launchd.ts:132-135` (outside the exact SCOPE list, cited only as corroborating evidence) generates the launchd plist with `StandardOutPath`/`StandardErrorPath` pointed at plain files with no companion rotation (no `newsyslog.conf` entry, no internal size cap):
  ```xml
  <key>StandardOutPath</key>
  <string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.stderrPath)}</string>
  ```
- `packages/agent-app/src/doctor.ts` has no check for on-disk log size either (`grep` for `err.log`/`log size`/`StandardError` returns nothing there). **Conclusion for the focus question**: this is a genuine **framework gap**, not merely an instance misconfiguration — nothing in mono-agent bounds the one log surface (raw stderr) that is most likely to grow from provider-SDK noise, retries, and uncaught warnings, even though the framework already has a mature, tested bounding story for run artifacts. Recommend a follow-up issue owned by whichever territory covers `launchd.ts`/deployment.

**F4 — P3.** A fresh (never-migrated) continuation state directory still gets a legacy `records-v2` directory containing only the fail-closed rollback-guard file, which can read as a stale migration artifact to an operator inspecting state.
- `packages/agent-app/src/continuation-store.ts:299-303` unconditionally creates `legacyRecordsDir` on every open:
  ```ts
  const legacyRecordsDir = join(stateDir, LEGACY_RECORDS_DIRECTORY);
  await ensureOwnerOnlyDirectory(recordsDir);
  ...
  await ensureOwnerOnlyDirectory(legacyRecordsDir);
  ```
- `packages/agent-app/src/continuation-store.ts:332-350` then writes the `UPGRADED-TO-RECORDS-V3` guard into it whenever `!manifestExists` — true for a brand-new install as much as for a genuine v1/v2→v3 upgrade — even when `loadRecordDirectory(legacyRecordsDir, ...)` finds it empty. **Why it matters**: purely a legibility/dead-artifact nit (not a correctness bug — the guard is harmless on a directory that never had v2 records), but a new deployment now always has a `records-v2/` folder that exists only to hold one poison file for a migration that never happened, which can confuse anyone auditing `.mono-agent/continuations/` by hand.

**F5 — P3.** `ContinuationService` (2,001 lines, one class) and `continuation-store.ts` (1,615 lines) are large enough to strain "a lean, understandable core," despite unusually thorough inline documentation.
- `packages/agent-app/src/continuation-service.ts:236-1653` is a single class mixing HTTP routing (`handleRequest`), lease/dispatch scheduling (`startDueJobs`/`processOne`), origin-context settlement (`requiresOriginContext`/`finalizeOriginContext`/`activateOriginContext`/`abandonOriginContext`), and the full operator/detached/claim protocol surface.
- **Why it matters**: not a bug, but "a competent stranger must be able to understand the core" is harder to satisfy at this size; a future maintainer changing lease semantics has to hold the whole state machine (10 `ContinuationState` values × 3 origin-context policies × claim/detached/operator auth paths) in their head at once. Worth a post-freeze refactor into cohesive submodules (http-routes / dispatch-worker / origin-context / store), not a freeze blocker.

## 3 Dead code

- **`records-v2` legacy directory + guard file on fresh installs** (see F4) — not truly dead code, but a dead *artifact* created by live code on every fresh install. Disposition: guard the `ensureOwnerOnlyDirectory(legacyRecordsDir)` + guard-write path behind "legacy directory actually had entries" so a fresh install never creates it. Proof hint: `continuation-store.ts:299-350`; reproduce by `openContinuationStore` on an empty `stateDir` and observing `records-v2/UPGRADED-TO-RECORDS-V3` appear.
- No other dead code found in this part's scope. All exported constants/functions I spot-checked (`RUN_HISTORY_MCP_SERVER_WILDCARD`, `RUN_HISTORY_LEGACY_TOOL_NAME`, `CONTINUATION_STORE_SCHEMA_VERSION`, `ContinuationServiceHandle.capturedText`) are referenced either within the same module's alias/validation logic or from `app.ts`/`doctor.ts` outside this scope. No TODO/FIXME/HACK/XXX markers exist anywhere in the 13 scoped files (`grep` returned zero hits).

## 4 Deprecation & legacy

- **`run_history` legacy tool-name alias** (`packages/agent-app/src/run-history.ts:23-31`, `RUN_HISTORY_LEGACY_TOOL_NAME`): not marked `@deprecated` in code but is a known back-compat alias per the PascalCase tool-rename history (see memory: init-wizard-capability-modules PR #176). **Load-bearing** — still checked in `isRunHistoryToolAllowed`'s alias list so existing `allowedTools`/`disallowedTools` configs naming the old snake_case tool keep working. Do not remove before a deprecation-cycle announcement.
- **`records-v2`/`continuations-v1.json` legacy continuation stores** (`packages/agent-app/src/continuation-store.ts:39-53, 302-351`): explicitly retained by design ("v3 deliberately leaves the v2/v1 evidence untouched for audit and manual recovery" — verified in code, not just the changelog). **Load-bearing** for anyone rolling back to a pre-0.11 runtime or auditing a past migration; do not delete per the CHANGELOG's own instruction ("restore the complete pre-upgrade state directory for a runtime rollback").
- **`CONTINUATION_STORE_SCHEMA_VERSION = 1`** (`continuation-store.ts:36`): superseded by `CONTINUATION_RECORD_STORE_SCHEMA_VERSION = 3` as the active format, but still used to validate the legacy monolithic `continuations-v1.json` during migration and is imported by `doctor.ts`. **Load-bearing**, not removable while v1-store migration support exists.
- No `@deprecated`-tagged symbols exist anywhere in this scope (`grep` returned zero hits).

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| A5-1 | Make `mono-agent restart --force` (and `purgeSessions`) also clear the durable conversation-history store, or rename/qualify the CLI message so it stops claiming a complete clear | "Honest ops"; unmet DoD bullet of open issue #203 | Add a `purgeHistory`-style function alongside `purgeSessions` that removes `<artifacts.dir>/../history` (or thread `historyStore` in to expose a `clear()`), call it from `runForceRestart`, and update the printed message + `docs/runtime/sessions-concurrency.md:31` boundary table | S | `restart --force` on an agent with prior conversation turns leaves no replay of pre-restart messages in the next turn; docs table lists the history store's fate explicitly | y |
| A5-2 | Add focused tests for `runs-health.ts`'s stale-running, owner-gone, and failure-kind-histogram branches | Missing test coverage of load-bearing "honest ops" status logic | Add cases mirroring the existing fixture style in `runs-health.test.ts` for each branch already implemented in `runs-health.ts` | S | `runs-health.test.ts` covers stale-running, owner-gone, cancelled-vs-other-cancelled, and failure-kind description paths | n |
| A5-3 | File/confirm a framework-level log-rotation issue for launchd-redirected stderr/stdout (cross-reference with deployment/launchd audit part before duplicating) | "Honest ops"; likely root cause of the observed 1.23 GB rotated err log | Add a size- or age-bounded rotation for `StandardOutPath`/`StandardErrorPath` (e.g., an internal rotator, or generate a `newsyslog.conf` stanza at `launchd install` time), and/or surface log size in `doctor` | M | A long-running background agent's err/out logs stay bounded without manual intervention; `doctor` reports current log size | n |
| A5-4 | Skip creating `records-v2` + the rollback guard on a fresh (no prior state) continuation store open | Dead-artifact/legibility nit for `openContinuationStore` | Only run the legacy-migration branch (directory creation + guard write) when `legacyRecordsDir` or `legacyPath` already has content, or when `manifestExists` is false **and** a v1/v2 file is actually found | S | A brand-new `.mono-agent/continuations/` directory contains no `records-v2/` subdirectory | n |
| A5-5 | Split `ContinuationService` into cohesive submodules (http-routes / dispatch-worker / origin-context settlement / operator API) | "Lean, understandable core" premise; 2,001-line single class | Extract origin-context settlement (`requiresOriginContext`/`finalizeOriginContext`/`activateOriginContext`/`abandonOriginContext`) and HTTP routing into separate files sharing the store/lease primitives | L | Same test suite passes unchanged; no single file in the continuation subsystem exceeds ~600 lines | n |

## 6 Skill-worthy flags

- **docs-sync gap on cross-cutting operator tables.** `docs/runtime/sessions-concurrency.md`'s "boundary rules" table (row for `mono-agent restart --force` / explicit purge) was not updated when the v0.11.0 durable conversation-history feature landed (commit `c2fccfe5`), leaving both the docs and the actual CLI behavior silent about a whole new kind of durable state. Suggest amending the **docs-sync** skill to explicitly check any table/matrix that enumerates "what does X reset/purge/survive" whenever a PR introduces a new durable store, not just prose sections — a targeted grep for the feature's new root/store name across `docs/**/*.md` boundary tables before merging.
- **New durable-state checklist for release-lockstep / worktree-feature.** The specific process gap behind F1 is generalizable: whenever a PR adds a new "the app forgets X across restarts" durable store (session history, continuation ledger, memory index, etc.), there is no standing checklist item verifying that the existing "purge/reset/clear" operator surface (CLI command, docs boundary table, `doctor` status) is updated in the same PR. Consider adding this as an explicit checklist line to **worktree-feature** or **release-lockstep**: "If this PR adds a new on-disk store under `.mono-agent/`, does an existing purge/reset command need to cover it too?"

## 7 Coverage note

Source files read in full (all 13 files in the exact SCOPE list; all exist):
- `packages/agent-app/src/continuation-service.ts` (2,001 lines)
- `packages/agent-app/src/continuation-store.ts` (1,615 lines)
- `packages/agent-app/src/continuations.ts` (286 lines)
- `packages/agent-app/src/continuation-config.ts` (262 lines)
- `packages/agent-app/src/continuation-command.ts` (198 lines)
- `packages/agent-app/src/sessions.ts` (57 lines)
- `packages/agent-app/src/run-history.ts` (1,007 lines)
- `packages/agent-app/src/runs-health.ts` (204 lines)
- `packages/agent-app/src/audit-runs.ts` (88 lines)
- `packages/agent-app/src/artifact-retention.ts` (161 lines)
- `packages/agent-app/src/backfill.ts` (430 lines)
- `packages/agent-app/src/metrics.ts` (125 lines)
- `packages/agent-app/src/request-model-override.ts` (411 lines)

Test files skimmed for coverage adequacy (describe/it names, not line-by-line):
- `packages/agent-app/src/__tests__/continuation-service.test.ts` (68 KB, ~39 top-level `it` cases spot-checked)
- `packages/agent-app/src/__tests__/continuation-origin-store.test.ts` (read in full — small, high-value)
- `packages/agent-app/src/__tests__/continuation-config.test.ts`
- `packages/agent-app/src/__tests__/continuation-command.test.ts`
- `packages/agent-app/src/__tests__/sessions.test.ts` (read in full)
- `packages/agent-app/src/__tests__/run-history.test.ts` (read opening fixture in full + all describe/it names)
- `packages/agent-app/src/__tests__/runs-health.test.ts` (read in full — only 1 test)
- `packages/agent-app/src/__tests__/artifact-retention.test.ts`
- `packages/agent-app/src/__tests__/backfill.test.ts`
- `packages/agent-app/src/__tests__/cli-audit-runs.test.ts`
- `packages/agent-app/src/__tests__/cli-metrics.test.ts`
- `packages/agent-app/src/__tests__/request-model-override.test.ts`

Adjacent files/evidence consulted (outside the exact SCOPE list, cited only to answer the assigned focus questions or verify a cross-file claim, not separately audited):
- `packages/agent-app/src/configured-agent.ts` (durable-history-store wiring, lines 4, 103, 430-431)
- `packages/agent-app/src/cli.ts` (`purgeSessions` call site and CLI message, lines 102, 4272-4283)
- `packages/agent-app/src/launchd.ts` (StandardOutPath/StandardErrorPath, lines 125-140)
- `packages/agent-app/src/doctor.ts` (grepped for log-size/history-purge surfacing; spot-read lines 2160-2480 for continuation-store stats rendering)
- `packages/agent-harness/src/durable-history.ts` / `index.ts` (grepped only, to confirm no purge/reset export exists)
- `packages/config/src/config.ts` (artifact-retention default constants, lines 99-102, 460-505)
- `docs/runtime/sessions-concurrency.md` (sessions/boundary-rules tables, lines 1-40)
- `CHANGELOG.md` (0.11.0/0.11.1/0.11.2 entries, lines 1-122)
- GitHub issues #201 and #203 (`gh issue view`)
- `git show v0.10.0:packages/agent-app/src/continuation-store.ts` (independent verification of the fail-closed rollback-guard mechanism)
- `git log`/`git show` for commits `c2fccfe5`, `218ec3bd`, `f10b6292` (durable-continuations and session history history)
