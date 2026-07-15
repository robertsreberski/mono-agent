# 06 · Memory surface & config reference

**Scope:** agent-app memory surface (memory-command.ts, memory-recall.ts, memory-recall-main.ts, memory-retrieval.ts, memory-rituals.ts, memory-embedding-service.ts, first-run-managed-memory.ts) and config-reference generation/consumer-contract surface (config-reference.ts, consumer-contract.ts, configuration-proposal-tool.ts, configuration-proposal-main.ts). **Maturity grade: B+ (verifier-adjusted).** This is a mature territory with no freeze-blockers and no fake-success paths: the `mono-agent memory` CLI (stats/audit/health-gate/intake/rebuild/rollback/forget with crypto plan digests and liveness checks), the TOCTOU-hardened first-run scaffold publisher, and the config-reference/consumer-contract drift guards are all genuinely solid, test-backed engineering. The grade is held below A by a consistent "erosion of the lean core" theme — two internal duplicate implementations of logic that already exists elsewhere in the workspace (cron next-run calc, MemoryRecallSettings resolution), one clean orphaned dead-code path, a config-schema generator whose type inference has no structural cross-check against a canonical schema (verified latent-risk, not an active defect), and a silent-fail-open cron path with no doctor pre-flight. All findings verified CONFIRMED against source; one (F5) had its severity amended upward.

## Findings

### F1 [P2] [verifier: CONFIRMED] — `memory-rituals.ts` reimplements a cron next-run calculator that already exists as a workspace dependency, and drops timezone support
`packages/agent-app/src/memory-rituals.ts:5-7,174-215`
`packages/agent-app` already declares `"@mono-agent/cron-adapter": "workspace:0.11.2"` as a direct dependency, which exports a public, tested `validateCronExpression(expression, { currentDate, timezone })`. The hand-rolled calculator always computes in UTC with no timezone parameter, unlike the shared one (which the main `cron.jobs` channel uses via `cron.timezone`). Verifier confirmed: `cron-adapter` is a direct dep, `memory-rituals.ts` does not import it (grep clean), and the stated rationale for hand-rolling ("avoids adding cron-parser as a direct dep") is moot since the dependency is already reachable.
```
 * Uses a hand-rolled minimal cron next-run calculator
 * (5-field `m h dom mon dow`); avoids adding `cron-parser` as a direct dep
```
Premise clause: "a lean, understandable core."

### F2 [P2] [verifier: CONFIRMED dead] — Dead runtime-extension path: `createMemoryRecallRuntimeExtension` (+ its two exclusive helpers) is exported, documented, and tested, but never wired into the live app
`packages/agent-app/src/memory-recall.ts:386-398`
Production wiring (`configured-agent.ts:53,394`) exclusively uses `createSharedMemoryRecallRuntimeExtension` from `memory-retrieval.ts` — the newer in-process, per-turn-cached, loopback-HTTP design. Verifier's repo-wide grep (excluding `dist/`, across packages/extras/demos/scripts/website/docs, plus read-only greps of the live `~/personal-agent` and `~/a8c-agents` instances) found `createMemoryRecallRuntimeExtension` referenced **only** at its own definition line — not even in its own test file, making it deader than the raw audit claimed. The two helper symbols (`memoryRecallMcpServerSpec`, `memoryRecallMcpEnv`) are called only by this dead function plus isolated unit tests. Not re-exported from `index.ts`. The standalone `mono-agent-memory-recall` bin (built from `memory-recall-main.ts`) is separately and legitimately load-bearing for external MCP clients — only the in-app wrapper is orphaned.
```
export function createMemoryRecallRuntimeExtension(
  settings: MemoryRecallSettings,
  cwd: string,
): () => Promise<MemoryRecallRuntimeExtension> {
```
Premise clause: "a lean, understandable core" / dead code.

### F3 [P2] [verifier: CONFIRMED] — `mono-agent memory search`'s FTS-fallback heuristic can silently relabel an unrelated bug as "semantic embeddings unavailable"
`packages/agent-app/src/memory-command.ts:1534-1551`
`isFtsFallbackEligible` treats *any* `TypeError` thrown anywhere in the recall path (embedding request, response parsing, graph expansion) as evidence of "embeddings unavailable," silently falls back to FTS-only, and reports `Semantic embeddings unavailable (${reasonOf(error)}); showing FTS-only results.` to the operator. `TypeError` is Node's generic error for null/undefined-property access and other programming-logic bugs, not exclusively fetch-connection failures. Verifier confirmed the `name === "TypeError"` check sits in an `||` chain (not scoped to a network shape), so a genuine defect in recall/graph-expansion code presents to the operator as a network/embedding degradation rather than a bug — a direct "dishonest fallback" on the memory-preview CLI surface.
```
const name = error instanceof Error ? error.name : "";
const message = reasonOf(error).toLocaleLowerCase("en-US");
return name === "AbortError" ||
  name === "TypeError" ||
```
Premise clause: "clean memory + preview," "honest ops."

### F4 [P3] [verifier: CONFIRMED] — Two independent, drift-prone implementations of "resolve `MemoryRecallSettings` from `config.memory`"
`packages/agent-app/src/memory-command.ts:1461-1498` (`previewRecallSettings`) duplicates `packages/agent-app/src/memory-recall.ts:162-208` (`resolveMemoryRecallSettings`) field-for-field, differing only in that the preview path intentionally omits the `memory.recallTool?.enabled === false` early-return. Because the duplication is field-by-field rather than a shared "resolve minus the enabled gate" helper, every future field added to `MemoryRecallEmbeddings`/`MemoryRecallSupermemory` has to be updated in two places by hand or the CLI preview and the live recall tool quietly diverge. Verifier confirmed both functions exist as described and the drift-risk framing is the natural shared-helper seam.
Premise clause: "a lean, understandable core."

### F5 [P2, amended from P3] [verifier: AMENDED] — `config-reference.ts`'s JSON-Schema types are inferred from field-name suffixes, not derived from any canonical schema, so a new field's type/shape has no structural check beyond a human noticing a schema diff
`packages/agent-app/src/config-reference.ts:886-903`
`CONFIG_ENV_KEYS` (`packages/config/src/config-view.ts:66-154`) — the single registry `config-reference.ts` iterates to build both the published JSON Schema and `docs/config/reference.md` — is only a `Record<jsonPath, envVarName>` with no type information. The generated JSON Schema's `type`/`enum`/`default` for every field is reconstructed purely from string-matching the field-id's suffix plus a per-field override list; there is no zod or other canonical runtime schema in `@mono-agent/config` to cross-check against (verifier confirmed grep-clean for zod in `packages/config/src`). The committed-file snapshot test catches drift from the last commit but not a genuinely wrong type for a *newly added* field. **Verifier amendment:** the severity is raised from P3 to P2 (latent) because the `inferType` regex (`:896`) is case-insensitive over bare suffixes (e.g. `port$`, `dim$`), so the failure mode for a new field is not merely "unusual name defaults to string" but potentially **silently-wrong-integer** typing — a stronger structural gap than the raw audit characterized, though verified as a latent forward-risk with no current field mis-classified.
```
function inferType(id: string): ConfigReferenceType {
  if (id === "runtime.fallbacks") { return "array"; }
  if (id.endsWith("Models") || id.endsWith("Tools") || ... ) { return "string[]"; }
```
Premise clause: "a lean, understandable core" / legible config surface.

### F6 [P3] [verifier: CONFIRMED] — `memory-rituals.ts` fails open (permanently disables consolidation) on a bad cron string with no doctor-side pre-flight validation
`packages/agent-app/src/memory-rituals.ts:86-93`
An invalid `memory.consolidation.cron` string is only discovered at runtime via a single `logger.warn` at startup, after which the scheduler never re-arms (verifier confirmed `schedule()` returns without setting `handles`/`currentHandle`). `doctor.ts` merely echoes the configured cron string without validating it — it never calls `memory-rituals.ts`'s parser or `cron-adapter`'s `validateCronExpression`. An operator who mistypes their consolidation cadence gets silent, permanent loss of consolidation with no operator-facing signal outside the process log.
```
} catch (err) {
  logger?.warn(
    `Memory consolidation has an invalid cron expression "${cronExpr}": ...`,
  );
  return;
}
```
Premise clause: "honest ops."

### F7 [P3] [verifier: CONFIRMED] — `first-run-managed-memory.ts`'s TOCTOU-hardened atomic-publish machinery reimplements a second, differently-shaped "atomically publish a generation" primitive alongside the one `@mono-agent/memory/bujo`'s `rebuild.ts` already owns
`packages/agent-app/src/first-run-managed-memory.ts:271-412` (`linkStagedFile`, `promoteManagedIndex`) hand-rolls a hard-link-based, no-replace, fsync-heavy publication scheme, structurally different from the generation/rename-based atomic publish machinery in `packages/memory/src/bujo/rebuild.ts` (`fsyncFile`/`fsyncDirectory`, generation-directory rename). Verifier confirmed both techniques exist as described and accepts the auditor's framing that the divergence has a legitimate justification (first-run must independently establish agent-root confinement before handoff) but is still a lean-core consolidation candidate given ~350 of 719 lines of TOCTOU defense for what is conceptually "write an initial empty store once." Both paths are fully tested.
Premise clause: "a lean, understandable core."

No standalone NEW findings were raised by the verifier for this part. The verifier's NEW-1 note (case-insensitive suffix regex risk) is folded into F5 above, not a separate defect.

## Dead code & deprecation

**Proven dead:**

| Path | Why dead | Proof |
| --- | --- | --- |
| `packages/agent-app/src/memory-recall.ts:386-398` `createMemoryRecallRuntimeExtension` | Never imported/called outside its own file, anywhere in the repo, and not even referenced in its own test file. Production wiring (`configured-agent.ts`) exclusively uses `createSharedMemoryRecallRuntimeExtension` from `memory-retrieval.ts`. | Verifier grep: `grep -rn createMemoryRecallRuntimeExtension --include=*.ts packages extras demos scripts website docs` (excl. `dist/`, `node_modules`) → only the definition line. Read-only greps of live `~/personal-agent` and `~/a8c-agents` instances also returned zero hits. |
| `packages/agent-app/src/memory-recall.ts:330-370,372-380` `memoryRecallMcpEnv` / `memoryRecallMcpServerSpec` | Exist solely to serve the dead `createMemoryRecallRuntimeExtension` above, plus direct unit tests of the two functions themselves; not called from `configured-agent.ts` or any other production path. | Same grep; not re-exported from `index.ts`. |

No other dead code found in scope; the rest of the surface is exercised by production wiring and/or dedicated tests.

**Explicitly not dead (verifier-confirmed load-bearing — do not delete):**

- `memory-command.ts`'s `adopt-replay` subcommand (`:263-357`) — live one-time migration path for pre-v2 legacy-replay projections; correctly gated and returns a closed error-code contract.
- `memory-retrieval.ts:84-89` — intentional structural-typing capability probe for stores lacking `persistCompletedTurn`.
- `consumer-contract.ts:46-48,337-351` (`forbiddenMcpMemoryPattern`, `retiredMcpMemorySurfaceIssues`) — actively guards against reintroduction of the retired `@mono-agent/memory-mcp` package and `memory_note`/`memory_recall` tool surfaces. Keep exactly as-is through freeze.
- `memory-command.ts`'s "legacy-source" fields (`:1103-1104,1921-1922,1940-1941`) — generation-metadata labels describing legacy-format lines encountered during a rebuild; not deprecated code.

**Suspected (unproven):** none in this part.

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| A6-1 | Replace `memory-rituals.ts`'s hand-rolled cron calculator with `@mono-agent/cron-adapter`'s `validateCronExpression` (already a workspace dependency) | Removes duplicate cron logic, adds timezone support (F1) | Import `validateCronExpression` from `@mono-agent/cron-adapter` at `nextCronDelayMs`'s call site; pass through `memory.consolidation.timezone` if added, else keep implicit UTC via the shared parser | S | `memory-rituals.test.ts` stays green; new test confirms identical next-run vs. the old hand-rolled calculator for the default `0 */2 * * *` expression | n |
| A6-2 | Delete (or explicitly re-justify in a doc comment) `createMemoryRecallRuntimeExtension`, `memoryRecallMcpServerSpec`, `memoryRecallMcpEnv` in `memory-recall.ts` | Dead in-app code path superseded by `memory-retrieval.ts`'s shared extension (F2) | `grep` confirms no other caller; remove the three functions + their now-unused test block, or add a one-line "intentionally unused, kept as X" doc note if there's a reason to keep them | S | `grep -rn "createMemoryRecallRuntimeExtension"` returns nothing (or only a retained doc-justified definition); build/tests green | n |
| A6-3 | Tighten `isFtsFallbackEligible`'s error classification in `memory-command.ts` so a bare `TypeError` unrelated to network/fetch doesn't get silently relabeled as "embeddings unavailable" | Preview-CLI honesty (F3) — a real bug should not present as a network degradation | Scope the `name === "TypeError"` branch to also require a fetch/network-shaped message (combine with existing message checks via `&&` instead of `||`), or inspect `error.cause` for undici's connection-refused shape | S | New unit test: a synthetic non-network `TypeError` thrown by the store is NOT treated as fallback-eligible and surfaces as a hard `memory search failed:` error instead of a degraded result | n |
| A6-4 | Extract the shared "resolve `MemoryRecallSettings` from `config.memory`" logic in `memory-command.ts`'s `previewRecallSettings` and `memory-recall.ts`'s `resolveMemoryRecallSettings` into one function parameterized by whether the `recallTool.enabled` gate applies | Removes drift risk between preview and live recall (F4) | Add an `options.ignoreRecallToolGate` (or similar) param to `resolveMemoryRecallSettings`; have `previewRecallSettings` call it | S | Existing tests for both call sites stay green; a new embeddings field added once instead of twice in a follow-up diff | n |
| A6-5 | Add an explicit config-reference "fidelity" test that walks every `CONFIG_ENV_KEYS` id and asserts its inferred JSON-Schema type against an independently hand-written expected-type table (not just a snapshot of the generator's own prior output) | Config-reference fidelity (F5, verifier-amended to P2) — catches a new field silently mis-typed by `inferType`'s case-insensitive suffix heuristics (verifier flagged this can silently produce a wrong *integer* type, not just a wrong string default) | Add a `Record<ConfigViewFieldId, ConfigReferenceType>` fixture in the test file; assert `schemaForField(...).type` matches it per id, and force a fixture update (not just a schema-snapshot update) whenever a field is added | M | New test fails if a future field's inferred type is missing/wrong; passes cleanly today | n |
| A6-6 | Have `doctor.ts`'s memory section (or `mono-agent validate`) actually call `cron-adapter`'s `validateCronExpression` (post A6-1) against `memory.consolidation.cron` and surface an error status if invalid | Honest ops (F6) — a mistyped consolidation cadence should be visible before deploy, not silently discovered via logs | In doctor's memory section, validate the configured (or default) cron string and downgrade status to `error`/`degraded` with a clear message on failure | S | `mono-agent doctor`/`validate` reports a failing memory section for a deliberately malformed `memory.consolidation.cron` in a test fixture | n |
| A6-7 | Post-freeze: consolidate `first-run-managed-memory.ts`'s hard-link atomic-publish routine with `@mono-agent/memory/bujo`'s rename-based generation publish into one shared, documented "claim-and-publish" primitive | Lean core (F7) — two independent atomic-durability implementations for one conceptual problem | Design doc first (the two callers have different preconditions); extract a shared low-level primitive both call into | L | Both first-run and rebuild/rollback continue to pass their full existing suites against the shared primitive | n |

No item in this part clears the freeze-blocking bar; the verifier's cluster-wide conclusion states no confirmed freeze-blocker exists across A4/A5/A6.

## Quarantine (refuted/unproven)

None. Every finding in this part (F1–F7) was verifier-CONFIRMED (with F5 amended upward in severity, not refuted), and both dead-code entries were verifier-CONFIRMED dead with proof. No entries in this part were refuted or left unproven.
