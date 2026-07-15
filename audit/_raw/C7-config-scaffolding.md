# C7-config-scaffolding — config package, create-mono-agent & demo

## 1 Verdict & maturity grade

**Grade: B+**

`@mono-agent/config` (packages/config/src) is the strongest piece of this territory: 368 tests across 6 suites, a self-checking parity test (`config-view-parity.test.ts`) that fails the build if the loader and the config-view registry ever drift, exhaustive strict-parsing behavior (unknown keys inside `MONO_AGENT_FALLBACKS_JSON` entries are rejected outright, path values are trimmed/validated, observability endpoints are scanned for embedded credentials), and honest error messages that always name the offending env var or JSON path. `create-mono-agent` is a minimal, well-tested delegating shim (8/8 tests green) that correctly solves a real npm-registry naming collision. `demos/final-agent` is intentionally not a package (documented, not an oversight) and its own compositional code is current with the 0.11 channel surface (telegram/a2a/webhook/openai-api/cron, `degraded` status, config-reload semantics) — full demo suite (18/18) and root `typecheck:demo`/`test:demo` pass clean as run during this audit. The grade is held below A by two concrete gaps: a stale example onboarding doc that tells a new agent to call memory tools that were deleted in the Memory v2 v3 simplification, and a completely untested CLI-arg parser (`deploy-cli.ts`) sitting right next to a sibling that is fully tested. Neither is close to freeze-blocking; both are cheap, mechanical fixes.

No live-instance surface is in this part's scope (pure static/source audit), so no separate Framework-fit grade applies.

## 2 Findings

**F1 — P2 — `demos/final-agent/IDENTITY.example.md:9-11`** — stale tool names in agent onboarding template
```
- **Journal what matters.** ... record it with the `journal_append` tool.
- **Recall older context with tools, not by guessing.** ... use `memory_search` first ..., then `entity_get` ..., or `memory_read_day` / `memory_list_days`
```
These five tool names (`journal_append`, `memory_search`, `entity_get`, `memory_read_day`, `memory_list_days`) do not exist anywhere in the current source tree. Grepping the whole repo for them returns zero hits outside this file. The Memory v2 "v3 simplification" (per prior audit memory, PR #26/commit `9af1bbe`) deleted the `memory-mcp` package and collapsed the tool surface to a single auto-provisioned `memory_recall` tool (`packages/agent-app/src/modules/known-tools.ts:54`, `memory_recall: "MemoryRecall"`). Anyone who copies `IDENTITY.example.md` into a real `IDENTITY.md` (which is exactly what the file's own header tells them to do, and what the demo README says at line 376: `IDENTITY.example.md` includes a *Memory discipline* section ... copy it into your `IDENTITY.md`) configures a bujo agent that will try to call five tools that do not exist, producing confusing tool-not-found failures at runtime instead of the smooth memory experience the premise promises ("clean memory (+ a way to preview it)"). This is pure content drift — no code path is affected — but it directly misleads the target user of the one file in this repo whose entire job is onboarding.

**F2 — P2 — `demos/final-agent/src/deploy-cli.ts` (whole file, 215 lines)** — zero test coverage for load-bearing CLI parsing
```
export function parseDeployCliArgs(argv: readonly string[]): DeployCliArgs {
```
No test file in the repo imports `deploy-cli.ts` or `parseDeployCliArgs` (`grep -rln "deploy-cli\|parseDeployCliArgs" demos/final-agent/src/__tests__/` returns nothing). This function is exported specifically to be testable, parses `--model`, `--ollama-url`, `--config`, `--a2a-port` (with a hand-rolled numeric-port validator bounding 0–65535), `--no-start`, and `-h/--help`, and throws on unknown arguments — the same shape of logic as `cli-args.ts`, which by contrast has full coverage in `cli-args.test.ts` (happy path, `--` separator, unknown-arg rejection). `deploy-cli.ts` backs the `pnpm run deploy:final` entry point documented as the primary "deploy with Ollama Gemma 4" path in the demo README. A regression in the port-range check or the arg-consuming loop (e.g. an off-by-one on `i += 1`) would only surface when a user runs the real command, not in CI.

**F3 — P2 — `packages/config/README.md:59-61`** — "ultra" effort value documented without its runtime-inversion caveat
```
Effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, subject
to the selected model's supported subset.
```
`EFFORT_LEVELS` (`packages/config/src/enums.ts:10`) accepts `"ultra"` as a valid value for `runtime.effort` / `MONO_AGENT_EFFORT`, and `effortRank()` (`packages/config/src/effort-keywords.ts:54-57`) deliberately ranks it *above* `"max"`. The in-code comment is candid about why: `"nothing should ever EMIT it — the pi runtime maps `ultra` to low thinking"` (confirmed live in `packages/agent-runtime/src/ai/providers/pi-native.js` / `turn-runner.js`, which define `thinkingLevelForEffort`). So an operator who reads only the public config README and sets `runtime.effort: "ultra"` expecting "more than max" reasoning silently gets *low* thinking instead — the exact "dishonest ops" shape the audit yardstick flags, and it happens through the package whose whole job is to document config keys honestly. The escalation-keyword path (`effort-keywords.ts`) already avoids ever emitting `ultra`; the raw config-loading path has no equivalent guard or warning, and the README carries no caveat.

**F4 — P3 — `packages/config/src/config.ts:91-98` vs `packages/config/src/layered-loader.ts:532-539`** — duplicated `MEMORY_LLM_ENV_KEYS` literal
```
const MEMORY_LLM_ENV_KEYS = [
  "MONO_AGENT_MEMORY_LLM_PROVIDER",
  "MONO_AGENT_MEMORY_LLM_MODEL",
  ...
```
The identical six-entry array (order differs trivially, same members) is independently defined and maintained in two files instead of being exported once and shared. Today they agree; if a future memory-LLM field is added and only one copy is updated, `hasMemoryLlmConfig` (config.ts) and `envCapabilityActivator`/`jsonEmbeddingsCredentialPath`-adjacent logic (layered-loader.ts) would silently disagree about which env vars "activate" the memory.llm block. The `config-view-parity.test.ts` self-check only verifies that every `MONO_AGENT_*` literal appearing in either file has a `CONFIG_ENV_KEYS` registry entry — it does not (and cannot) catch two independently-hand-maintained arrays going out of sync with each other.

**F5 — P3 — `packages/config/src/config.ts` / `index.ts`** — four exported constants with zero consumers
```
export const DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS = 365;
export const DEFAULT_ARTIFACT_RETENTION_MAX_COUNT = 50_000;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS = 7;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT = 5_000;
```
All four are re-exported from `index.ts` as public API, but `grep -rl` across every package's `src/` (outside `packages/config` itself) finds no importer anywhere in the repo — not even in `agent-app`'s doctor/wizard/CLI surfaces that would be the natural place to display "what's the default retention." They are exercised only inside `config.ts`'s own defaulting logic. Not harmful, but unused public surface adds to what a newcomer must scan to understand the package's real API — a small tax against the "lean, understandable core" premise.

## 3 Dead code

- `packages/config/src/config.ts:99-102` (`DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS`, `DEFAULT_ARTIFACT_RETENTION_MAX_COUNT`, `DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS`, `DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT`) — exported from the package's public `index.ts` but never imported by any other package or the CLI. **Disposition**: either wire them into `agent-app`'s doctor/config-reference output (their apparent intended use) or stop exporting them from `index.ts` and keep them package-private. **Proof**: `grep -rln "DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS\|DEFAULT_ARTIFACT_RETENTION_MAX_COUNT\|DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS\|DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT" --include="*.ts" .` (excluding node_modules/dist) returns only `packages/config/src/index.ts` and `packages/config/src/config.ts`.
- No unreachable code, no orphaned files, and no unused exports found in `create-mono-agent` or `demos/final-agent` — both are small and every exported symbol is exercised by their own tests or by the sibling entry point.

## 4 Deprecation & legacy

No `@deprecated` JSDoc tags exist anywhere in this scope (`grep -rn "@deprecated"` → 0 hits), but several items are informally legacy-marked in comments/code and are worth classifying:

| Item | Where | Classification | Evidence |
|---|---|---|---|
| `RETIRED_MEMORY_ENV_KEYS` (7 pre-v2 memory env vars: `MONO_AGENT_MEMORY_GRAPH_PATH`, `_SCOPE`, `_TOOLS_ENABLED`, `_REFLECTION_ENABLED`, `_REFLECTION_CRON`, `_MIGRATION_ENABLED`, `_MIGRATION_CRON`) | `config.ts:670-690` | **Load-bearing (for now)**: tolerated + warned (never thrown), explicitly to prevent a stale pre-Memory-v2 config from silently doing nothing. Safe to delete post-v1 once the fleet and any external consumers are confirmed off these keys. | Comment: "Pre-v2 memory keys the loader still tolerates ... Surfaced as a one-line deprecation warning ... so a stale config doesn't look like it is taking effect." |
| `memory.reflection` / `memory.migration` JSON blocks | `json-source.ts:161-164`, warned in `config-view.ts:1092-1116` | **Load-bearing (for now)**: kept typed solely so old JSON files don't hard-fail; actively ignored at runtime and flagged via `findRemovedConfigWarnings`. | `/** Removed and ignored; retained so stale JSON stays typed/tolerated. */` |
| `runtime.fallbackModels` / `MONO_AGENT_FALLBACK_MODELS` | `README.md:38-41`, `types.ts:181`, `config.ts:299-313` | **Load-bearing compatibility surface, not slated for removal**: README explicitly says "remain compatibility surfaces and retain their historical inheritance from `runtime.effort`" alongside the canonical `runtime.fallbacks`. Both are still fully validated (mutual-exclusion enforced in `assertUniqueFallbackRoutes` / `readFallbacks`), so this is a deliberate dual API, not rot. | README §"Agent Identity and Runtime Routes" |
| `"ultra"` in `EFFORT_LEVELS` | `enums.ts:10`, `effort-keywords.ts:47-57` | **Load-bearing but under-documented** (see F3) — kept so an explicitly-configured `ultra` isn't clobbered by keyword escalation, but the config package's own README doesn't carry the runtime-inversion caveat that the source comments do. | See F3 above. |

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A1-1 | Rewrite `demos/final-agent/IDENTITY.example.md`'s memory-discipline section to reference only the current `memory_recall` tool (and the `##Memory` context-injection behavior), dropping `journal_append`/`memory_search`/`entity_get`/`memory_read_day`/`memory_list_days` | "clean memory + preview" premise; the demo is the repo's onboarding template and currently ships dead tool names | Edit the markdown; cross-check against `docs/memory/index.md`'s current tool list (or whatever the agent-app memory docs now say) before wording it | S | Manually diff the new file against `packages/agent-app/src/modules/known-tools.ts`'s memory entries; grep confirms no retired tool name remains | n |
| A1-2 | Add a `deploy-cli.test.ts` covering `parseDeployCliArgs` (happy path, `--` separator, `--a2a-port` bounds 0/65535/negative/non-numeric, unknown-arg rejection, `--no-start`) mirroring `cli-args.test.ts` | "missing test coverage of load-bearing behavior" — `deploy:final` is a documented primary path and its parser is currently untested | Extract/test the exported `parseDeployCliArgs`; no source change needed, purely additive test file | S | `pnpm --filter` (root) `vitest run demos/final-agent/src/__tests__/deploy-cli.test.ts` green; coverage includes at least one failure-path assertion per flag | n |
| A1-3 | Add a one-line caveat to `packages/config/README.md`'s effort-values list: `ultra` ranks above `max` for escalation purposes only — pi maps it to LOW thinking, so do not configure it expecting stronger reasoning | "honest ops" — a config value whose plain name currently implies the opposite of its effect, undocumented in the operator-facing README | Add a sentence next to the existing effort-levels list; optionally add a `console.warn` in `readEffort`/`loadMonoAgentConfig` when `effort === "ultra"` is explicitly configured (not derived from escalation) | S | README diff reviewed; if a warning is added, a `config.test.ts` case asserts it fires only for direct config, never for keyword-escalated turns | n |
| A1-4 | Deduplicate `MEMORY_LLM_ENV_KEYS` into one exported constant (e.g. from `config.ts`, imported by `layered-loader.ts`) instead of two hand-maintained literals | "lean, understandable core" — avoid future silent drift between the loader's activation check and the layered-loader's JSON-vs-env precedence logic | Export the array from `config.ts` (or a shared internal module), import it in `layered-loader.ts`, delete the duplicate | S | `pnpm --filter @mono-agent/config run test` stays green (368/368); grep confirms only one array literal remains | n |
| A1-5 | Either wire the four unused `DEFAULT_*_RETENTION_*` exports into an agent-app consumer (doctor output / config-reference generator) or drop them from `index.ts`'s public export list | "lean core" — unused public API surface | Small edit to `index.ts` (stop re-exporting) or to `packages/agent-app` doctor/config-reference to consume them | S | `pnpm run check:architecture` and `pnpm run typecheck` stay green; grep for the four names outside `packages/config` still returns the (now updated) single expected usage or none | n |

## 6 Skill-worthy flags

- **docs-sync**: the same "example onboarding doc lags a tool-surface simplification" pattern that produced F1 is exactly what `docs-sync` is meant to catch across `docs/` — but `demos/final-agent/IDENTITY.example.md` and `SOUL.example.md` are **not** under `docs/`, so a docs-sync pass keyed only on the `docs/` tree would miss it. Recommend amending `docs-sync`'s file list (or its invocation instructions) to explicitly include `demos/*/IDENTITY.example.md`, `demos/*/SOUL.example.md`, and any other `*.example.md` seed files whenever a memory/tool-surface PR lands — these are copy-paste templates, not descriptive prose, so a stale one actively breaks a fresh agent rather than just reading wrong.
- **new-package** (amendment candidate): this audit had to manually verify that `demos/final-agent`'s absence of a `package.json` was intentional (confirmed only by reading `demos/final-agent/README.md:3` and the root README's package table) rather than an oversight. Worth a one-line addition to whichever skill covers "is this dead/incomplete" triage: a directory under `demos/` with no `package.json` is expected — check its own README before flagging it as a liability.
- No other recurring process-shaped issues found in this territory; the parity-test pattern in `config-view-parity.test.ts` (regex-extract every `MONO_AGENT_*` literal from the loader source and assert it against the view registry, in both directions) is itself a good pattern other packages with a similar "two surfaces must agree" shape (e.g. any future settings-UI package) could reuse — worth mentioning as a positive convention if a "config-view parity" skill/snippet is ever templated out.

## 7 Coverage note

Source files read in full:
- `packages/config/src/config.ts`
- `packages/config/src/config-view.ts`
- `packages/config/src/layered-loader.ts`
- `packages/config/src/json-source.ts`
- `packages/config/src/types.ts`
- `packages/config/src/enums.ts`
- `packages/config/src/effort-keywords.ts`
- `packages/config/src/index.ts`
- `packages/config/README.md`
- `packages/config/package.json`
- `packages/create-mono-agent/src/bin/mono-agent.ts`
- `packages/create-mono-agent/src/delegate.ts`
- `packages/create-mono-agent/src/resolve-agent-app-cli.ts`
- `packages/create-mono-agent/src/__tests__/delegate.test.ts`
- `packages/create-mono-agent/src/__tests__/resolve-agent-app-cli.test.ts`
- `packages/create-mono-agent/README.md`
- `packages/create-mono-agent/package.json`
- `demos/final-agent/src/cli.ts`
- `demos/final-agent/src/cli-args.ts`
- `demos/final-agent/src/final-demo.ts`
- `demos/final-agent/src/configuration.ts`
- `demos/final-agent/src/deployment.ts`
- `demos/final-agent/src/deploy-cli.ts`
- `demos/final-agent/src/__tests__/cli-args.test.ts`
- `demos/final-agent/README.md`
- `demos/final-agent/IDENTITY.example.md`
- `demos/final-agent/SOUL.example.md`
- `demos/final-agent/tsconfig.json`, `tsconfig.build.json`
- `packages/create-mono-agent/tsconfig.json`, `tsconfig.build.json`

Test/config files skimmed (structure and describe/it names only, per instructions — not line-by-line) to judge coverage adequacy:
- `packages/config/src/__tests__/config.test.ts` (2145 lines, 134 tests)
- `packages/config/src/__tests__/layered-loader.test.ts` (2474 lines, 184 tests)
- `packages/config/src/__tests__/config-view.test.ts` (417 lines, 24 tests — read in full, it is the parity/warnings surface)
- `packages/config/src/__tests__/config-view-parity.test.ts` (96 lines, 3 tests — read in full)
- `packages/config/src/__tests__/json-source.test.ts` (152 lines, 11 tests — read in full)
- `packages/config/src/__tests__/effort-keywords.test.ts` (78 lines, 12 tests)
- `demos/final-agent/src/__tests__/deployment.test.ts` (283 lines, 4 tests)
- `demos/final-agent/src/__tests__/final-demo.test.ts` (965 lines, 11 tests)

Not read (does not exist / out of declared scope):
- `demos/final-agent/package.json` — confirmed absent from disk and from `git ls-files`; confirmed intentional via `demos/final-agent/README.md:3` ("intentionally not an npm package") and root `README.md:161` ("demos/final-agent (not a workspace package)"). Not a gap.
- `demos/final-agent/dist/**` — skimmed only for staleness; not git-tracked in any of the three targets in this scope (`git ls-files` returns empty for all three `dist/` trees), so dist is pure disposable build output regenerated by `pnpm run build`/`typecheck`/`test` — confirmed regenerated cleanly during this audit (`pnpm run typecheck:demo`, `pnpm run test:demo` both green; `pnpm --filter @mono-agent/config run typecheck`/`test` 368/368 green; `pnpm --filter create-mono-agent run typecheck`/`test` 8/8 green).

Adjacent files consulted (outside strict scope) only to verify or falsify a specific claim, not audited line-by-line: `packages/runtime-adapter/src/sandbox.ts` (SANDBOX_NETWORK_MODES enum, to confirm config correctly delegates "all"-mode rejection rather than silently accepting it); `packages/agent-runtime/src/ai/providers/pi-native.js` / `pi-native/turn-runner.js` (confirmed `thinkingLevelForEffort` exists and the "ultra→low thinking" comment in `effort-keywords.ts` is accurate, not stale); `packages/agent-app/src/modules/known-tools.ts` (confirmed the current, single `memory_recall` tool surface referenced in F1); `packages/agent-app/schema/mono-agent.config.schema.json` (confirmed strict `additionalProperties: false` at 59 nesting points, which satisfies the v1 DoD "unknown keys warned" requirement at the agent-app layer — so this was deliberately **not** raised as a gap in packages/config itself); GitHub issue #119 (v1 epic, for the exact DoD wording "Every config key documented + unknown keys warned") and issue #133 / PR #155 (confirmed the unknown-key-warning feature was built and merged, living in `packages/agent-app`, outside this part's scope).