# A6-memory-surface-config — agent-app memory surface & config reference

## 1 Verdict & maturity grade

**Grade: B+**

This territory is unusually mature for a v1 freeze candidate. `memory-command.ts` (the `mono-agent memory` preview/ops CLI) is a genuinely serious piece of engineering: stats/today/show/search/top, a metadata-only audit plus a "strict" health gate with real exit codes, intake inspect/retry/resolve, rebuild/rollback, legacy-replay adoption, and a full GDPR-style forget prepare→apply→restore workflow with cryptographic plan digests, atomic private-file writes, and live-agent liveness checks that refuse destructive mutation while the configured agent is running. `first-run-managed-memory.ts` applies TOCTOU-hardened, symlink-resistant, crash-safe atomic publication for the first-run memory scaffold. `configuration-proposal-tool.ts` layers real secret-pattern scanning and bidi/control-character screening onto its propose-only MCP tool. `consumer-contract.ts` is a well-built golden-fixture drift detector against two real downstream configs. All in-scope test suites are green (133 tests across the 8 files with dedicated specs). Nothing here is a fake-success path or a P0.

The grade is held to B+ rather than A by three recurring themes: (1) duplicate/hand-rolled logic that already exists elsewhere in the workspace (a second 5-field cron calculator in `memory-rituals.ts` when `@mono-agent/cron-adapter` — already a direct dependency — exports a `cron-parser`-backed `validateCronExpression`; a second `resolveMemoryRecallSettings`-equivalent in `memory-command.ts`); (2) one clearly orphaned production code path (`createMemoryRecallRuntimeExtension` + its two supporting helpers in `memory-recall.ts`, superseded by `memory-retrieval.ts`'s shared in-process extension but never deleted); (3) the config-reference JSON Schema is generated entirely from a hand-maintained, suffix-based naming heuristic (`inferType`) rather than derived from any canonical schema — it works today only because every existing field was hand-tuned to match, and a new field with an unusual name has no `pi-upstream-recon`-style structural guardrail against silently getting the wrong JSON-Schema type. None of these are correctness catastrophes; they are exactly the kind of "lean, understandable core" erosion the freeze should clean up before the surface calcifies.

## 2 Findings

### F1 (P2) — `memory-rituals.ts` reimplements a cron next-run calculator that already exists as a workspace dependency, and drops timezone support in the process
`packages/agent-app/src/memory-rituals.ts:5-7,174-215`
```
 * Schedules lightweight `store.consolidate()` on its configured cron cadence
 * (default: every two hours). Uses a hand-rolled minimal cron next-run calculator
 * (5-field `m h dom mon dow`); avoids adding `cron-parser` as a direct dep of
```
`packages/agent-app` already declares `"@mono-agent/cron-adapter": "workspace:0.11.2"` as a direct dependency (`packages/agent-app/package.json:43`), and `cron-adapter` already depends on `cron-parser` and exports a public, tested `validateCronExpression(expression, { currentDate, timezone })` (`packages/cron-adapter/src/cron-expression.ts:18-33`, re-exported from `packages/cron-adapter/src/index.ts:18`) that returns the exact next-occurrence `Date` the main cron channel relies on. The comment's stated reason for hand-rolling ("avoids adding `cron-parser` as a direct dep of this package") is moot — the dependency is already present transitively and could be imported directly. The hand-rolled version also always computes in UTC with no timezone parameter, unlike `validateCronExpression`, which accepts `timezone` (the main `cron.jobs` channel honors `cron.timezone`). This is a real behavioral gap: two independent 5-field cron matchers now exist in the same app with different feature sets and different edge-case behavior (DOM/DOW OR-logic, step handling), which is exactly the kind of duplicate-maintenance risk that erodes "a lean, understandable core."
Premise clause: "a lean, understandable core."

### F2 (P2) — Dead runtime-extension path: `createMemoryRecallRuntimeExtension` (+ its two exclusive helpers) is exported, documented, and tested, but never wired into the live app
`packages/agent-app/src/memory-recall.ts:386-398`
```
export function createMemoryRecallRuntimeExtension(
  settings: MemoryRecallSettings,
  cwd: string,
): () => Promise<MemoryRecallRuntimeExtension> {
```
Repo-wide search (excluding `dist/` and this function's own test file) shows `createMemoryRecallRuntimeExtension`, `memoryRecallMcpServerSpec`, and `memoryRecallMcpEnv` are referenced only inside `memory-recall.ts` itself and `memory-recall.test.ts`. The actual production wiring point, `configured-agent.ts:53,394`, imports and calls `createSharedMemoryRecallRuntimeExtension` from `memory-retrieval.ts` — the newer in-process, per-turn-cached, loopback-HTTP design — exclusively. The stdio-child variant these three symbols build appears to be a leftover from before the shared-retrieval-service refactor. (The standalone `mono-agent-memory-recall` bin itself, built from `memory-recall-main.ts`, IS legitimately published and load-bearing for external MCP clients — only the in-app runtime-extension wrapper around it is orphaned.)
Premise clause: "a lean, understandable core" / dead code.

### F3 (P2) — `mono-agent memory search`'s FTS-fallback heuristic can silently relabel an unrelated bug as "semantic embeddings unavailable"
`packages/agent-app/src/memory-command.ts:1534-1551`
```
  const name = error instanceof Error ? error.name : "";
  const message = reasonOf(error).toLocaleLowerCase("en-US");
  return name === "AbortError" ||
    name === "TypeError" ||
    message.includes("fetch failed") ||
```
`isFtsFallbackEligible` treats *any* `TypeError` thrown anywhere in the recall path (embedding request, response parsing, graph expansion) as evidence of "embeddings unavailable," triggers a silent fallback to FTS-only, and reports it to the operator as `Semantic embeddings unavailable (${reasonOf(error)}); showing FTS-only results.` `TypeError` is Node's generic error for null/undefined-property access and other programming-logic bugs, not solely for `fetch` connection failures (undici *also* throws `TypeError` for genuine connection failures, which is presumably why this was added — but the check is not scoped to that). A real bug in the recall/graph-expansion code would therefore present to the operator as a network/embedding degradation rather than a defect, directly touching the audit's "dishonest fallback" concern, specifically on the "clean memory + preview" CLI surface called out in the brief.
Premise clause: "clean memory + preview," "honest ops."

### F4 (P3) — Two independent, drift-prone implementations of "resolve `MemoryRecallSettings` from `config.memory`"
`packages/agent-app/src/memory-command.ts:1461-1498` (`previewRecallSettings`) duplicates `packages/agent-app/src/memory-recall.ts:162-208` (`resolveMemoryRecallSettings`) field-for-field, differing only in that the preview path omits the `memory.recallTool?.enabled === false` early-return (intentional — preview should still search even when the live tool is disabled). Because the duplication is field-by-field rather than a shared "resolve minus the enabled gate" helper, every future field added to `MemoryRecallEmbeddings`/`MemoryRecallSupermemory` has to be updated in two places by hand or the CLI preview and the live recall tool quietly diverge on what they see.
Premise clause: "a lean, understandable core."

### F5 (P2) — `config-reference.ts`'s JSON-Schema types are inferred from field-name suffixes, not derived from any canonical schema, so a new field's type/shape has no structural check beyond an alert human noticing a schema diff
`packages/agent-app/src/config-reference.ts:886-903`
```
function inferType(id: string): ConfigReferenceType {
  if (id === "runtime.fallbacks") { return "array"; }
  if (id.endsWith("Models") || id.endsWith("Tools") || ... ) { return "string[]"; }
  if (id.endsWith("enabled") || id.endsWith("allowAllChats") || ... ) { return "boolean"; }
```
`CONFIG_ENV_KEYS` (`packages/config/src/config-view.ts:66-154`), the single registry `config-reference.ts` iterates to build both the published `mono-agent.config.schema.json` and `docs/config/reference.md`, is only a `Record<jsonPath, envVarName>` — it carries no type information at all. The generated JSON Schema's `type`/`enum`/`default` for every core field is reconstructed purely from string-matching the field-id's suffix (`Ms`, `Bytes`, `Count`, `enabled`, …) plus a per-field override list. There is no independent zod/runtime schema in `@mono-agent/config` (`packages/config/src/config.ts` hand-validates without zod) that this generator cross-checks against — the generated schema and the actual loader-side parsing logic (`layered-loader.ts`) are two independently hand-maintained sources of truth. The committed-file snapshot test (`config-reference.test.ts:94-98,200-204`) catches *drift from the last commit*, but does not catch a genuinely wrong type for a *newly added* field whose name doesn't happen to match one of the existing suffix patterns (e.g., a new boolean not ending in "enabled"/"dryRun"/etc. would silently schema as `"string"`). This is exactly the "config-reference generation fidelity vs actual schema" risk called out in the brief — today's fields all happen to be correctly classified (verified against the committed schema and `MEMORY_*`/`SANDBOX_*`/`EFFORT_LEVELS` shared enum constants), but the mechanism has no structural guarantee going forward.
Premise clause: "a lean, understandable core" / legible config surface.

### F6 (P3) — `memory-rituals.ts` fails open (permanently disables consolidation) on a bad cron string with no doctor-side pre-flight validation
`packages/agent-app/src/memory-rituals.ts:86-93`
```
      } catch (err) {
        logger?.warn(
          `Memory consolidation has an invalid cron expression "${cronExpr}": ${...}. Consolidation disabled.`,
        );
        return;
      }
```
An invalid `memory.consolidation.cron` string is only discovered at runtime, via a single `logger.warn` at startup, after which the scheduler simply never re-arms (verified: `schedule()` returns without setting `handles`/`currentHandle`, so `stop()` has nothing to clear and no further attempt is made). `doctor.ts` (out of scope for this part, but the only other place this value is surfaced) merely echoes the configured cron string in its status details without validating it (`packages/agent-app/src/doctor.ts:1452-1454`) — it does not call `memory-rituals.ts`'s parser or `cron-adapter`'s `validateCronExpression` to catch this at `mono-agent validate`/doctor time. An operator who mistypes their custom consolidation cadence gets silent, permanent loss of consolidation with no operator-facing signal outside the process log. This is a small but real "honest ops" gap on a feature that is otherwise well-guarded (skip-overlap, never-throws, injectable clock).
Premise clause: "honest ops."

### F7 (P3) — `first-run-managed-memory.ts`'s TOCTOU-hardened atomic-publish machinery (~350 of its 719 lines) reimplements a *second*, differently-shaped "atomically publish a generation" primitive alongside the one `@mono-agent/memory/bujo`'s `rebuild.ts` already owns
`packages/agent-app/src/first-run-managed-memory.ts:271-412` (`linkStagedFile`, `promoteManagedIndex`) hand-rolls a hard-link-based, no-replace, fsync-heavy directory-tree publication scheme, independent from and structurally different to the generation/rename-based atomic publish machinery already implemented in `packages/memory/src/bujo/rebuild.ts` (`fsyncFile`/`fsyncDirectory`, generation-directory rename). The justification is legitimate — `rebuild.ts`'s routine assumes its target root is already safely claimed, whereas first-run has to independently establish agent-root confinement and win an exclusive claim on a not-yet-existing root before it can hand off to the package — but the result is two independently-reasoned-about atomic-durability implementations using two different techniques (hard-link vs rename) for conceptually the same problem ("never leave a memory generation half-written"). For a "lean, understandable core," a shared, well-documented "claim + atomically publish a directory tree" primitive that both call into would halve the audit surface and remove one plausible source of future divergent bugs. Not urgent (both paths are tested — 16 first-run tests, and `rebuild.ts`'s own suite), but worth flagging for post-freeze consolidation given how disproportionate 700 lines of TOCTOU defense is relative to the underlying task ("write an initial empty BuJo/Journal store once").
Premise clause: "a lean, understandable core."

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
| --- | --- | --- | --- |
| `packages/agent-app/src/memory-recall.ts:386-398` `createMemoryRecallRuntimeExtension` | Never imported/called outside its own file and its own test file, anywhere in the repo (checked outside `dist/`); production wiring (`configured-agent.ts`) exclusively uses `createSharedMemoryRecallRuntimeExtension` from `memory-retrieval.ts` instead. | Remove, or fold into a documented "legacy stdio-child recall wiring, intentionally unused, kept only as a reference implementation for external hosts" comment if there is a real external-consumer reason to keep it. | `grep -rn "createMemoryRecallRuntimeExtension" --include="*.ts" .` (excluding `dist/`) returns only its definition + its test. |
| `packages/agent-app/src/memory-recall.ts:330-370,372-380` `memoryRecallMcpEnv` / `memoryRecallMcpServerSpec` | Exist solely to serve the dead `createMemoryRecallRuntimeExtension` above (plus direct unit tests of the two functions themselves); not called from `configured-agent.ts` or any other production path. | Remove alongside F2, or keep only if the stdio-child spec-building logic is intentionally retained as a documented compatibility helper for third-party MCP host configs (in which case say so explicitly in the module doc, since the current doc comment already gestures at "standalone/compatibility surface" but conflates the *standalone bin* — which is legitimately used — with this *in-app spec builder* — which is not). | Same grep; also compare against `memory-recall-main.ts`'s genuinely-used `memoryRecallSettingsFromEnv`/`createRecallStore`, which the published `mono-agent-memory-recall` bin (`package.json:22`) does depend on. |

No other dead code found in scope. The rest of the surface (memory-command.ts's full subcommand set, first-run-managed-memory.ts's atomic-publish machinery, configuration-proposal-tool.ts, consumer-contract.ts, memory-embedding-service.ts) is exercised by production wiring and/or dedicated tests.

## 4 Deprecation & legacy

No `@deprecated` JSDoc tags exist in any in-scope file. Legacy-adjacent surfaces found are all load-bearing, not removable:

- **`memory-command.ts`'s `adopt-replay` subcommand** (`:263-357`) — migrates a pre-v2 "legacy replay projection" into the current BuJo authority format. This is explicitly a one-time migration path for older installs (referenced in memory: "Memory v2 (BuJo tiered memory)" retired v1 journal/graph/search/md packages), still load-bearing for any instance that hasn't yet run it. Correctly gated behind `hasLiveConfiguredAgent` checks (twice, to close a lazy-import race) and returns a closed, non-leaky error-code contract (`ReplayAdoptionFailureCode`) rather than surfacing raw package/native errors that "may contain paths, record ids, marker bytes, or model-owned text" (comment at `:298-300`) — a genuinely good privacy-conscious design.
- **`memory-retrieval.ts:84-89`** — "Preserve capability detection: stores without the strong method leave this property absent so the harness takes its legacy fallback." This documents an intentional structural-typing capability probe (older/external stores that don't implement `persistCompletedTurn`), not deprecated code to remove.
- **`consumer-contract.ts:46-48,337-351`** (`forbiddenMcpMemoryPattern`, `retiredMcpMemorySurfaceIssues`) — actively *guards against the reintroduction* of the retired `@mono-agent/memory-mcp` package and `memory_note`/`memory_recall` tool surfaces (retired per v3 memory simplification, PR #26). This is a regression-prevention fixture check, not legacy code itself; it should stay exactly as-is through freeze.
- **`memory-command.ts`'s "legacy-source" fields** (`:1103-1104,1921-1922,1940-1941`) — these are generation-metadata *labels* reported from the rebuild/rollback output (`skippedLegacySourceRecords`, `legacySourceLocations`), describing legacy-format lines encountered *during* a rebuild of someone else's store; not deprecated code in this package.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| A6-1 | Replace `memory-rituals.ts`'s hand-rolled cron calculator with `@mono-agent/cron-adapter`'s `validateCronExpression` (already a workspace dependency) | Removes duplicate cron logic, adds timezone support, matches "lean core" | Import `validateCronExpression` from `@mono-agent/cron-adapter` in `nextCronDelayMs`'s call site; pass through `memory.consolidation.timezone` if one gets added, else keep implicit UTC but via the shared parser | S | `memory-rituals.test.ts` still green; new test confirms identical next-run vs. the old hand-rolled calculator for the default `0 */2 * * *` expression | n |
| A6-2 | Delete (or explicitly re-justify in a doc comment) `createMemoryRecallRuntimeExtension`, `memoryRecallMcpServerSpec`, `memoryRecallMcpEnv` in `memory-recall.ts` | Dead in-app code path superseded by `memory-retrieval.ts`'s shared extension (F2) | `grep` confirms no other caller; remove the three functions + their now-unused test block, or add a one-line "intentionally unused, kept as X" doc note if there's a reason to keep them | S | `grep -rn "createMemoryRecallRuntimeExtension"` returns nothing (or only the retained doc-justified definition); build/tests green | n |
| A6-3 | Tighten `isFtsFallbackEligible`'s error classification in `memory-command.ts` so a bare `TypeError` unrelated to network/fetch doesn't get silently relabeled as "embeddings unavailable" | Preview-CLI honesty (F3) — a real bug should not present as a network degradation | Scope the `name === "TypeError"` branch to also require a fetch/network-shaped message (e.g. combine with the existing message checks via `&&` instead of `||`), or inspect `error.cause` for undici's connection-refused shape | S | New unit test: a synthetic non-network `TypeError` thrown by the store is NOT treated as fallback-eligible and surfaces as a hard `memory search failed:` error instead of a degraded result | n |
| A6-4 | Extract the shared "resolve `MemoryRecallSettings` from `config.memory`" logic in `memory-command.ts`'s `previewRecallSettings` and `memory-recall.ts`'s `resolveMemoryRecallSettings` into one function parameterized by whether the `recallTool.enabled` gate applies | Removes drift risk between preview and live recall (F4) | Add an `options.ignoreRecallToolGate` (or similar) param to `resolveMemoryRecallSettings`; have `previewRecallSettings` call it | S | Existing tests for both call sites stay green; a new embeddings field added once instead of twice in a follow-up diff | n |
| A6-5 | Add an explicit config-reference "fidelity" test that walks every `CONFIG_ENV_KEYS` id and asserts its inferred JSON-Schema type against an independently hand-written expected-type table (not just a snapshot of the generator's own prior output) | Config-reference fidelity (F5) — catches a new field silently mis-typed by `inferType`'s suffix heuristics | Add a `Record<ConfigViewFieldId, ConfigReferenceType>` fixture in the test file; assert `schemaForField(...).type` matches it per id, and force a fixture update (not just a schema-snapshot update) whenever a field is added | M | New test fails if a future field's inferred type is missing/wrong; passes cleanly today | n |
| A6-6 | Have `doctor.ts`'s memory section (or `mono-agent validate`) actually call `cron-adapter`'s `validateCronExpression` (post A6-1) against `memory.consolidation.cron` and surface an error status if invalid | Honest ops (F6) — a mistyped consolidation cadence should be visible before deploy, not silently discovered via logs | In doctor's memory section, validate the configured (or default) cron string and downgrade status to `error`/`degraded` with a clear message on failure | S | `mono-agent doctor`/`validate` reports a failing memory section for a deliberately malformed `memory.consolidation.cron` in a test fixture | n |
| A6-7 | Post-freeze: consolidate `first-run-managed-memory.ts`'s hard-link atomic-publish routine with `@mono-agent/memory/bujo`'s rename-based generation publish into one shared, documented "claim-and-publish" primitive | Lean core (F7) — two independent atomic-durability implementations for one conceptual problem | Design doc first (this is nontrivial — the two callers have different preconditions); extract a shared low-level primitive package/module both call into | L | Both first-run and rebuild/rollback continue to pass their full existing suites against the shared primitive | n |

## 6 Skill-worthy flags

- **Duplicate-implementation check before hand-rolling.** `memory-rituals.ts`'s cron parser (F1) is a textbook case the existing `pi-upstream-recon` skill doesn't cover (that skill is about *external* pi APIs) — there is no equivalent nudge for *internal* workspace packages. Worth an amendment to `new-package` or `verify-green`: before implementing any non-trivial parser/algorithm inside a package, `grep` the monorepo (`packages/*/src`) for an existing implementation of the same primitive, especially among packages already listed as direct dependencies in that package's `package.json`. Seed command: `grep -rln "<primitive-name>" packages/*/src --include="*.ts" | grep -v __tests__` before writing a new one from scratch.
- **Orphaned-wiring detection after a "shared service" refactor.** F2's dead `createMemoryRecallRuntimeExtension` is the shape of bug that follows *every* "introduce a shared/cached service to replace a per-call spawn" refactor (the comment history — "Runtime live-sessions redesign," "Agent-runtime kernel redesign," etc. — shows this pattern recurs in this repo). Worth a `worktree-feature`/`finishing-a-development-branch` amendment: when a refactor introduces a new "shared"/"pooled" version of an existing per-request mechanism, explicitly grep for and remove (or justify keeping) the old mechanism's exports in the same PR, rather than leaving both live.

## 7 Coverage note

Files read in full (production source, all lines):
- `packages/agent-app/src/memory-command.ts` (2080 lines)
- `packages/agent-app/src/memory-recall.ts` (568 lines)
- `packages/agent-app/src/memory-recall-main.ts` (32 lines)
- `packages/agent-app/src/memory-retrieval.ts` (407 lines)
- `packages/agent-app/src/memory-rituals.ts` (305 lines)
- `packages/agent-app/src/memory-embedding-service.ts` (261 lines)
- `packages/agent-app/src/first-run-managed-memory.ts` (719 lines)
- `packages/agent-app/src/config-reference.ts` (1093 lines)
- `packages/agent-app/src/consumer-contract.ts` (432 lines)
- `packages/agent-app/src/configuration-proposal-tool.ts` (243 lines)
- `packages/agent-app/src/configuration-proposal-main.ts` (18 lines)

All 11 files named in scope exist; none were missing.

Supporting files read (partial, for cross-reference/verification, not part of the audited scope itself):
- `packages/agent-app/src/__tests__/config-reference.test.ts` (full)
- `packages/agent-app/src/__tests__/consumer-contract.test.ts` (skimmed for coverage adequacy)
- `packages/agent-app/src/__tests__/cli-memory.test.ts` (grepped for subcommand coverage: stats/today/show/search/top/audit/inspect/retry/resolve/rebuild/rollback/adopt-replay/forget all present)
- `packages/config/src/config-view.ts` (`CONFIG_ENV_KEYS` registry, lines 1-170)
- `packages/cron-adapter/src/cron-expression.ts` (lines 1-60, confirms `validateCronExpression` exists and is exported)
- `packages/cron-adapter/src/index.ts` (grep confirming public export)
- `packages/cron-adapter/package.json`, `packages/agent-app/package.json` (dependency graph confirming `cron-parser` is already reachable from agent-app)
- `packages/memory/src/bujo/daily.ts`, `packages/memory/src/bujo/rebuild.ts` (grepped, to confirm date-key convention consistency and cross-reference the parallel atomic-publish primitive)
- `packages/agent-app/src/doctor.ts` (grepped around consolidation-cron reporting; NOT in scope, cited only to support F6)
- `packages/agent-app/src/cli.ts` (grepped for `memory-command.ts` wiring)
- `packages/agent-app/src/local-configuration.ts`, `packages/agent-app/src/__tests__/local-configuration.test.ts`, `packages/agent-app/src/__tests__/agent-host.test.ts`, `packages/agent-app/src/__tests__/first-run-readiness.test.ts`, `packages/agent-app/src/__tests__/project-skills.test.ts` (grepped, to verify `configuration-proposal-tool.ts` consumption and test coverage)

Verification run (read-only): `pnpm --filter @mono-agent/agent-app exec vitest run` against `memory-recall.test.ts`, `memory-retrieval.test.ts`, `memory-rituals.test.ts`, `memory-embedding-service.test.ts`, `config-reference.test.ts`, `consumer-contract.test.ts`, `first-run-managed-memory.test.ts`, `cli-memory.test.ts` — all green, 133 tests total across 8 files.
