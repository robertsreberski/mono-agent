# 16 · Config, scaffolding & demo

**Scope:** `@mono-agent/config` (packages/config/src), `create-mono-agent`, and `demos/final-agent`.
**Maturity grade:** B+ (verifier-adjusted, unchanged). One-paragraph verdict: this is the strongest territory in the audit — `@mono-agent/config` has 368 tests across 6 suites, a self-checking parity test that fails the build if the loader and config-view registry drift, exhaustive strict-parsing (unknown keys rejected, paths validated, observability endpoints scanned for embedded credentials), and honest error messages naming the offending env var or JSON path; `create-mono-agent` is a minimal, fully-tested delegating shim; `demos/final-agent` is intentionally not a package (documented, not an oversight) and its own code is current with the 0.11 channel surface. The verifier confirmed all 5 findings as-stated with no severity changes and no refutations, adding two minor corrective nits to F1 and one reframing nit (NEW-1) that belongs to the C6 territory, not this one. Nothing here is freeze-blocking; the two P2 gaps (stale onboarding doc, untested CLI parser) are cheap and mechanical.

## Findings

**F1 — [P2] [verifier: CONFIRMED, with 2 minor corrective nits] — `demos/final-agent/IDENTITY.example.md:9-11`** — stale tool names in agent onboarding template
The example file tells a new agent to call `journal_append`, `memory_search`, `entity_get`, `memory_read_day`, and `memory_list_days` — five tool names retired by the Memory v2 "v3 simplification" (PR #26/commit `9af1bbe`), which collapsed the tool surface to a single auto-provisioned `memory_recall` (`packages/agent-app/src/modules/known-tools.ts:54`). Anyone who copies this file into a real `IDENTITY.md` (exactly what the file's header and the demo README at line 376 instruct) configures a bujo agent that will try to call tools that do not exist. Verifier confirmed the grep and additionally checked both live fleet instances: the retired names are **absent from `~/personal-agent` and `~/a8c-agents`** — the fleet has already migrated, so this is pure documentation drift, not a live-instance defect. Verifier also flagged two corrective nits (NEW-2, NEW-3): the claim "zero hits outside this file" is slightly imprecise — `packages/config/src/types.ts:261` has a JSDoc comment referencing `memory_search` conceptually (not a tool invocation, doesn't break anything, but is a second textual hit). This does not change F1's validity; the example file's tool names are genuinely retired and should be fixed.
```
- **Journal what matters.** ... record it with the `journal_append` tool.
- **Recall older context with tools, not by guessing.** ... use `memory_search` first ..., then `entity_get` ..., or `memory_read_day` / `memory_list_days`
```

**F2 — [P2] [verifier: CONFIRMED] — `demos/final-agent/src/deploy-cli.ts` (whole file, 215 lines)** — zero test coverage for load-bearing CLI parsing
`parseDeployCliArgs` parses `--model`, `--ollama-url`, `--config`, `--a2a-port` (hand-rolled 0–65535 validator), `--no-start`, and `-h/--help`, throwing on unknown args — the same shape as `cli-args.ts`, which has full coverage (`cli-args.test.ts`). No test file imports `deploy-cli.ts` or `parseDeployCliArgs`. It backs `pnpm run deploy:final`, documented as the primary Ollama Gemma 4 deploy path. Verifier confirmed the grep and additionally noted this is demo-scoped (not a published npm package), giving it lower blast radius than a package-level parser — P2 is defensible but borderline P3.
```
export function parseDeployCliArgs(argv: readonly string[]): DeployCliArgs {
```

**F3 — [P2] [verifier: CONFIRMED] — `packages/config/README.md:59-61`** — "ultra" effort value documented without its runtime-inversion caveat
`EFFORT_LEVELS` accepts `"ultra"` and `effortRank()` ranks it above `"max"`, but `thinkingLevelForEffort` (verified live by the verifier at `turn-runner.js:147-155`) falls through to `return "low"` for `ultra` — the same low thinking as `minimal`/`low`. An operator reading only the public README and setting `runtime.effort: "ultra"` expecting stronger reasoning silently gets low thinking instead: a genuine "dishonest ops" gap in the one package whose job is to document config keys honestly. The escalation-keyword path already avoids ever emitting `ultra`; the raw config-loading path and README carry no equivalent guard or caveat.
```
Effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`, subject
to the selected model's supported subset.
```

**F4 — [P3] [verifier: CONFIRMED] — `packages/config/src/config.ts:91-98` vs `packages/config/src/layered-loader.ts:532-539`** — duplicated `MEMORY_LLM_ENV_KEYS` literal
The identical six-entry array is independently defined and maintained in two files instead of being exported once and shared. Verifier confirmed both definitions by line (`config.ts:91`, read at `:1088`; `layered-loader.ts:532`, read at `:570`). If a future memory-LLM field is added and only one copy updated, `hasMemoryLlmConfig` and the layered-loader's precedence logic could silently disagree about which env vars activate the memory.llm block; the parity test cannot catch two independently hand-maintained arrays drifting from each other.
```
const MEMORY_LLM_ENV_KEYS = [
  "MONO_AGENT_MEMORY_LLM_PROVIDER",
  "MONO_AGENT_MEMORY_LLM_MODEL",
  ...
```

**F5 — [P3] [verifier: CONFIRMED] — `packages/config/src/config.ts` / `index.ts`** — four exported constants with zero external consumers
`DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS`, `DEFAULT_ARTIFACT_RETENTION_MAX_COUNT`, `DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS`, `DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT` are all re-exported from `index.ts` as public API but have no importer anywhere in the repo outside `packages/config` itself. Verifier confirmed the framing is accurate: these are not truly dead code — they are used internally in `config.ts`'s own defaulting logic (`:465-500`) — dead only as *public exports*. Unused public surface adds to what a newcomer must scan against the "lean, understandable core" premise.
```
export const DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS = 365;
export const DEFAULT_ARTIFACT_RETENTION_MAX_COUNT = 50_000;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS = 7;
export const DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT = 5_000;
```

## Dead code & deprecation

**Proven dead (public-export-only, not internally dead):**
- `DEFAULT_ARTIFACT_RETENTION_MAX_AGE_DAYS` / `DEFAULT_ARTIFACT_RETENTION_MAX_COUNT` / `DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_AGE_DAYS` / `DEFAULT_MEMORY_ARTIFACT_RETENTION_MAX_COUNT` (`packages/config/src/config.ts:99-102`, re-exported from `packages/config/src/index.ts`) — proven dead as public API only. **Proof (verifier-independently re-run):** `grep -rn` the 4 names across `packages extras demos scripts website` (excl. node_modules/dist) returns only `config/src/index.ts` (re-export) and `config/src/config.ts` (definition + internal use at `:465-500`). No importer anywhere else. **Disposition:** wire into `agent-app`'s doctor/config-reference output, or stop re-exporting from `index.ts` and keep package-private. **Verifier note:** they are actively used *internally* — do not delete the constants themselves, only reconsider the public export.

No other dead code found in `create-mono-agent` or `demos/final-agent` — both are small and every exported symbol is exercised by their own tests or the sibling entry point (verifier did not dispute this).

**Deprecation/legacy classifications (verifier: all 4 CONFIRMED reasonable, load-bearing):**

| Item | Where | Classification | Evidence |
|---|---|---|---|
| `RETIRED_MEMORY_ENV_KEYS` (7 pre-v2 memory env vars) | `config.ts:670-690` | Load-bearing (for now): tolerated + warned, never thrown, to prevent stale pre-Memory-v2 config from silently doing nothing. Safe to delete post-v1 once fleet/external consumers confirmed off these keys. | Comment: "Pre-v2 memory keys the loader still tolerates ... Surfaced as a one-line deprecation warning" |
| `memory.reflection` / `memory.migration` JSON blocks | `json-source.ts:161-164`, `config-view.ts:1092-1116` | Load-bearing (for now): kept typed solely so old JSON files don't hard-fail; actively ignored at runtime, flagged via `findRemovedConfigWarnings`. | `/** Removed and ignored; retained so stale JSON stays typed/tolerated. */` |
| `runtime.fallbackModels` / `MONO_AGENT_FALLBACK_MODELS` | `README.md:38-41`, `types.ts:181`, `config.ts:299-313` | Load-bearing compatibility surface, not slated for removal — deliberate dual API with `runtime.fallbacks`, both fully validated. | README §"Agent Identity and Runtime Routes" |
| `"ultra"` in `EFFORT_LEVELS` | `enums.ts:10`, `effort-keywords.ts:47-57` | Load-bearing but under-documented (see F3) — kept so an explicitly-configured `ultra` isn't clobbered by keyword escalation, but the README lacks the runtime-inversion caveat the source comments carry. | See F3 above. |

No `@deprecated` JSDoc tags exist anywhere in this scope (0 hits).

## Actionable steps

| ID | What | Why | How | Effort (S/M/L) | Acceptance check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A1-1 | Rewrite `demos/final-agent/IDENTITY.example.md`'s memory-discipline section to reference only the current `memory_recall` tool, dropping the 5 retired tool names | Onboarding template ships dead tool names; premise "clean memory + preview" | Edit the markdown; cross-check against `known-tools.ts`'s memory entries before wording it; also nudge the `memory_search` JSDoc phrase at `types.ts:261` while touching this area (NEW-2/NEW-3) | S | Manually diff against `known-tools.ts` memory entries; grep confirms no retired tool name remains in the example file | n |
| A1-2 | Add `deploy-cli.test.ts` covering `parseDeployCliArgs` (happy path, `--` separator, `--a2a-port` bounds 0/65535/negative/non-numeric, unknown-arg rejection, `--no-start`) mirroring `cli-args.test.ts` | Load-bearing, currently-untested CLI parser behind a documented primary deploy path | Extract/test the exported `parseDeployCliArgs`; purely additive test file, no source change | S | `vitest run demos/final-agent/src/__tests__/deploy-cli.test.ts` green; at least one failure-path assertion per flag | n |
| A1-3 | Add a one-line caveat to `packages/config/README.md`'s effort-values list: `ultra` ranks above `max` for escalation purposes only — pi maps it to LOW thinking, so do not configure it expecting stronger reasoning | Honest-ops: a config value whose name implies the opposite of its effect, undocumented in the operator-facing README | Add a sentence next to the effort-levels list; optionally add a `console.warn` in `readEffort`/`loadMonoAgentConfig` guarded to fire only when `ultra` is directly configured (not derived from keyword escalation) | S | README diff reviewed; if a warning is added, a test asserts it fires only for direct config, never for keyword-escalated turns | n |
| A1-4 | Deduplicate `MEMORY_LLM_ENV_KEYS` into one exported constant, imported by `layered-loader.ts` | Avoid future silent drift between the loader's activation check and the layered-loader's JSON-vs-env precedence logic | Export the array from `config.ts` (or a shared internal module), import it in `layered-loader.ts`, delete the duplicate | S | `@mono-agent/config` tests stay green (368/368); grep confirms only one array literal remains | n |
| A1-5 | Either wire the four unused `DEFAULT_*_RETENTION_*` exports into an agent-app consumer (doctor/config-reference output), or drop them from `index.ts`'s public export list | Lean core — unused public API surface (constants themselves stay, only public export is in question) | Small edit to `index.ts` (stop re-exporting) or to `packages/agent-app` doctor/config-reference to consume them | S | `check:architecture` and `typecheck` stay green; grep for the four names outside `packages/config` returns the (now updated) expected usage or none | n |

## Quarantine (refuted/unproven)

None. The verifier confirmed all 5 findings and the 1 dead-code claim in this territory with no refutations. No freeze-blocker was proposed for this part (all 3 proposed freeze-blockers across the V5 cluster belonged to C5/C6, not C7, and all 3 were rejected there).
