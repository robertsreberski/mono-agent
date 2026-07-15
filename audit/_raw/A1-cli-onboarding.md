# A1-cli-onboarding — agent-app CLI & onboarding

## 1 Verdict & maturity grade

**Grade: B**

This territory is functionally mature and unusually honest: the init/wizard/secret-persistence code goes to extraordinary lengths to never claim false readiness or clobber operator data (TOCTOU-safe file writes, atomic no-clobber promotion, live per-route readiness probing before ever calling an agent "ready"), and test coverage is very heavy (roughly 1:1 or better test-to-source LOC across `cli.ts`, `init.ts`, the wizard, and `project-skills.ts`). No P0 issues, no fake-success paths, no secrets found in source. The grade is capped at B rather than A because the "lean, understandable core" clause of the premise is meaningfully violated: `cli.ts` is 4,493 lines (nearly half of it one `init`/`auth` orchestration block), the interactive wizard state machine in `wizard/run.ts` is 1,916 lines, and there is a small amount of genuinely dead code and un-timelined legacy compatibility surface. The "agent in seconds-to-minutes" claim is literally true only for the non-interactive/flag path; the flagship interactive TTY wizard is deliberately a multi-minute, live-verification-heavy experience by design (a defensible honesty tradeoff, but a gap between marketing and the default first-run experience).

## 2 Findings

**F1 — P2 (legibility).** `packages/agent-app/src/cli.ts` is 4,493 lines. The `init`/`auth` orchestration alone (from `interface RunInitEnvironmentContext` to `shellCommandArgument`) spans `cli.ts:1429`–`cli.ts:3612` — ~2,183 lines, essentially half the file, inside one module. Within that, `runInit` (`cli.ts:1435`) is itself an ~870-line function containing a labelled `firstRun: for (;;)` loop with nested `readyAttempt:`, `interruptedRecoveryMenu:`, `sandboxRecoveryMenu:`, and `recoveryMenu:` labelled loops.
```
async function runInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext): Promise<number> {
```
A competent stranger cannot hold this function's state machine in their head; every earlier reviewer of this code needs the surrounding ~250 lines of comments to reconstruct control flow. Violates the "lean core... open to external plugins" premise clause, which presupposes the core is graspable.

**F2 — P2 (dead code).** `runModelRepairWizard` and its `ModelRepairOutcome` type are exported from the package's public wizard surface but have zero production callers anywhere in the repository.
```
wizard/run.ts:336: export async function runModelRepairWizard(
wizard/index.ts:36: export { runInitWizard, runModelRepairWizard } from "./run.js";
```
Repo-wide grep confirms the only references are the function's own definition, its re-export, and two test files (`wizard-run.test.ts`, `cli-first-run-state.test.ts`). The CLI's actual "edit model routes" recovery path calls the more general `runSetupRepairWizard({ initialStep: 1, ... })` instead (`cli.ts:2112`–`2135`). This is superseded code (per `git log`, `run.ts`'s current shape postdates several feature PRs) that nobody deleted — ~55 lines of orphaned production code plus its dedicated tests.

**F3 — P2 (correctness/maintainability risk, duplication).** Two independent, subtly different implementations of the same hard problem — atomic, TOCTOU-safe, no-clobber file replacement for security-sensitive files this process owns — exist side by side in this small package:
```
init.ts:1189:            async function atomicReplaceFile(options: AtomicReplaceOptions): Promise<void> {
project-skills.ts:487:   async function atomicWriteManagedExact(
```
`init.ts` builds its version on async `fs/promises` handles with fsync + rename-based commit + concurrent-writer backup/restore; `project-skills.ts` builds an independent version on sync `fs` calls (`openSync`/`fstatSync`/`renameSync`) with its own ownership/mode assertions. Both exist to solve "commit a file this process manages without clobbering a concurrent human/process edit," but a security fix or edge-case fix applied to one (e.g., a new TOCTOU window, a new symlink-race check) will not automatically propagate to the other. This doubles the audit surface for what should be one hardened primitive.

**F4 — P2 (premise fit / expectation gap).** The literal claim "agent in seconds-to-minutes from one config folder" is true for the non-interactive path (`--yes`/any flag/non-TTY: `composeWizardPlan` → `initMonoAgentFolder` → print, no network calls unless `--auth`, verified in `cli.ts:2231`–`2306`). It is **not** true of the flagship interactive `mono-agent init` on a TTY, which is the experience most first-time users hit: it performs live per-route model calls with per-route timeouts of "90s cloud / 240s local" (README:112), a sandbox install+preflight when selected, and possibly live provider OAuth — before it will ever write a file. This is a deliberate, well-reasoned safety tradeoff (never claim false readiness), not a bug, but the top-level premise language and this package's own README (`packages/agent-app/README.md:55`–`116`, one uninterrupted ~60-line paragraph) do not clearly set the expectation that the guided path is a multi-minute flow, not a "seconds" one.

**F5 — P3 (legibility, docs).** `packages/agent-app/README.md` lines 55–228 are a small number of extremely dense, jargon-dense paragraphs (e.g. the paragraph starting "Before the first macOS background launch..." at line 157 is one 24-line paragraph covering runtime snapshotting, launchd semantics, and background-snapshot keys in one breath). This is accurate and clearly written by someone who deeply understands the system, but it reads as compressed internal spec/changelog prose rather than onboarding documentation — a new external contributor evaluating "is this core lean and understandable" would struggle to extract the operating model from this file without already knowing it.

**F6 — P3 (minor, unused internal export).** `secretEnvLockPathFor` (`init.ts:845`) is exported from the module but is not re-exported from the package's public `index.ts`, and its only repo consumer is its own test (`secret-env.test.ts`). Low-severity — likely intended as a public API surface for future callers or debugging, but currently unreachable from any production code path in this repo.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
|---|---|---|---|
| `wizard/run.ts:108-118` (`ModelRepairOutcome`), `wizard/run.ts:336-388` (`runModelRepairWizard`) | Exported from `wizard/index.ts:35-36`; zero production callers repo-wide (only its own tests) | Delete the function, its type, and the two re-exports, and delete/fold the dedicated test blocks into `runSetupRepairWizard` coverage — or, if the intent was to keep a lighter "model-only repair" path for future API consumers, wire it into `cli.ts`'s `recovery === "model"` branch and delete the now-redundant `runSetupRepairWizard({ initialStep: 1 })` call instead | `grep -rln "runModelRepairWizard" .` (excluding `dist/`, `node_modules/`) returns only `wizard/run.ts`, `wizard/index.ts`, and two test files |
| `init.ts:845` (`secretEnvLockPathFor`) | Exported but not part of the package's public `index.ts` surface; only consumer is its own test | Low priority: either add it to `index.ts` if it is meant to be a public debugging/ops helper, or mark it internal (drop `export`) since nothing outside its test imports it | `grep -rln "secretEnvLockPathFor\b" packages/ ` (excluding dist) → `init.ts` + `secret-env.test.ts` only |

## 4 Deprecation & legacy

| Item | Evidence | Classification |
|---|---|---|
| `--recipe <id>` flag on `init`/`validate`, and the `mono-agent recipes` command name (alias for `presets`) | `cli.ts:166` "deprecated alias"; `cli.ts:3402-3424` and `cli.ts:3742-3763` both print `--recipe is deprecated; using preset ${preset.id}`; mapping table `RECIPE_TO_PRESET` in `wizard/presets.ts:106-110` | **Removable, but undated.** Fully superseded by `--preset`/`mono-agent presets`; every call site already prints a deprecation hint and is well tested. No removal milestone exists. Load-bearing only for operators who never updated old scripts/docs from the pre-preset era (config-consolidation PR, per project memory, already months old at v1 freeze) — safe to schedule for removal in a post-v1 minor, not blocking. |
| `--fallback-models <csv>` (legacy) vs `--fallback <ref> [--fallback-effort ...]` (canonical, repeatable) | `cli.ts:698-707` rejects mixing both; `wizard/answers.ts:270-293` converts the legacy CSV form into canonical `fallbacks[]`, inheriting the "legacy global effort"; `wizard/from-flags.ts:49-50` also guards against mixing both | **Load-bearing compatibility, removable eventually.** Both forms are actively supported and tested (not merely tolerated), so this is intentional back-compat, not neglect — but it is a second way to express the same concept with no stated sunset, adding a permanent branch to every code path that touches fallbacks (`answers.ts`, `from-flags.ts`, help text, arg parsing). |
| `LEGACY_TOOL_ALIASES` snake_case tool names (`modules/known-tools.ts:46-57`) | Explicit compatibility map (`slack_send_message` → `SlackSendMessage`, etc.) for the PascalCase tool rename noted in project memory (`init-wizard-capability-modules.md`) | **Load-bearing.** Existing fleet/user configs depend on these aliases continuing to validate; comment explicitly documents this is deliberate. Fine as-is; no action needed before freeze. |
| `mono-agent doctor` / `mono-agent setup` command aliases | `cli.ts:148-152`, `276-284`; no deprecation warning printed — these are treated as permanent friendly aliases, not legacy | **Not legacy** — included here only to distinguish from the `--recipe`/`recipes` case, which *is* explicitly marked deprecated. No action needed. |

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A1-1 | Decompose `cli.ts` (4,493 LOC) into focused modules | "lean, understandable core" — one file holding arg-parsing, help text, the entire init/auth wizard-orchestration state machine, validate/config rendering, and background lifecycle is not graspable by a new contributor | Extract, keeping `cli.ts` as a thin dispatcher: (1) `cli-args.ts` — `parseCliArgs`, `ParsedCliArgs`, `renderHelp`/`HELP_COMMANDS` (~800 lines, already has `cli-args.test.ts`); (2) `init-command.ts` — everything from `runInit` through the recovery-menu helpers (`cli.ts:1429`-`3612`, ~2,180 lines); (3) `background-command.ts` — `runStart`/`runForeground`/`runBackgroundCommand`/`printAppStatus`/`waitForShutdownSignal` (`cli.ts:4064`-`4478`); (4) `validate-config-command.ts` — `runValidate`/`runConfig`/preset rendering (`cli.ts:3658`-`3990`). Keep existing test files, just repoint imports | M | `wc -l cli.ts` drops below ~800; `pnpm --filter @mono-agent/agent-app run typecheck && test` green; `pnpm run check:architecture` green | n |
| A1-2 | Delete (or wire up) dead `runModelRepairWizard`/`ModelRepairOutcome` | Dead code — F2 | `grep -rln runModelRepairWizard .` to confirm no callers, then delete the function/type/exports in `wizard/run.ts` and `wizard/index.ts` plus its two test suites; or route `cli.ts`'s `recovery === "model"` branch through it instead of `runSetupRepairWizard({ initialStep: 1 })` | S | `grep -rln "runModelRepairWizard"` returns nothing (or, if kept, returns a real `cli.ts` call site); full test suite green | n |
| A1-3 | Consolidate the two atomic-secure-file-write implementations | F3 — one security-sensitive primitive implemented twice with different fault-injection seams and different sync/async styles increases the chance a hardening fix lands in only one copy | Extract a shared internal helper (e.g. `secure-file-replace.ts`) covering "compare-and-swap replace a file this process owns, refusing symlinks/foreign-owners/hard-links, with an injectable fault-seam," used by both `init.ts`'s `.env`/`.gitignore` merge and `project-skills.ts`'s managed-skill activation | L | Both `secret-env.test.ts` (777 lines) and `project-skills.test.ts` (191 lines) still pass unmodified against the shared implementation; no behavior change | n |
| A1-4 | Set (or execute) a removal timeline for `--recipe`/`mono-agent recipes` | Legacy surface with no sunset date — table in §4 | Pick a version (e.g. next minor after v1) to delete `RECIPE_TO_PRESET`, the `--recipe` flag, and the `recipes`→`presets` alias; until then, add the target version number to the existing deprecation hint strings so operators see a concrete deadline | S | Deprecation hint text names a version; tracking issue filed | n |
| A1-5 | Same for `--fallback-models` legacy CSV flag | Legacy surface — table in §4 | Same pattern as A1-4: pick and announce a removal version, or explicitly decide it stays forever (document why) and close the question | S | Decision recorded (issue or doc), hint text updated if removal is chosen | n |
| A1-6 | Make the wizard's real wall-clock cost explicit in `--help`/README | F4 — premise honesty: "seconds-to-minutes" should not silently mean "up to several minutes of live provider calls" for the default interactive path | Add one explicit sentence to `renderHelp()`'s `init` entry and the README's opening paragraph: the flag/non-TTY path is scaffold-only and fast; the interactive wizard runs real per-route model calls (state the 90s/240s timeouts) before it ever writes a file | S | `mono-agent init --help` and README both state the distinction in the first few lines, not buried mid-paragraph | n |

## 6 Skill-worthy flags

- No existing skill (verify-green, worktree-feature, fleet-deploy, live-smoke, release-lockstep, docs-sync, pi-upstream-recon, new-package) is a clean fit for "watch for duplicated hardened-primitive implementations" (F3) or "sweep for orphaned exports after a refactor" (F2/dead code). These read as generic code-review hygiene rather than a repeatable mono-agent-specific process gap, so no skill amendment is proposed here — flagging for the `code-review`/`simplify` general-purpose skills' existing "reuse/simplification" lens rather than a new dedicated skill.
- One recurring, mono-agent-specific pattern worth a **future** amendment to `new-package` or a new "deprecation-hygiene" note (not urgent for this audit): every deprecated flag/alias found in this territory (`--recipe`, `--fallback-models`, `LEGACY_TOOL_ALIASES`) was added with a clear in-code deprecation message but no removal version/date. If this pattern repeats elsewhere in the audit, it may be worth a one-line addition to `release-lockstep` ("when introducing a deprecation alias, record a target removal version in the same commit") rather than a standalone skill.

## 7 Coverage note

Every file in scope was read in full:

- `packages/agent-app/src/cli.ts` (4,493 lines, read start to finish across 12 windows)
- `packages/agent-app/src/init.ts` (1,760 lines, read start to finish across 2 windows)
- `packages/agent-app/src/ui.ts`
- `packages/agent-app/src/account-home.ts`
- `packages/agent-app/src/package-version.ts`
- `packages/agent-app/src/install-skill.ts`
- `packages/agent-app/src/project-skills.ts` (709 lines)
- `packages/agent-app/src/wizard/answers.ts`
- `packages/agent-app/src/wizard/from-flags.ts`
- `packages/agent-app/src/wizard/index.ts`
- `packages/agent-app/src/wizard/model-discovery.ts` (1,251 lines, read start to finish across 3 windows)
- `packages/agent-app/src/wizard/presets.ts`
- `packages/agent-app/src/wizard/prompts.ts`
- `packages/agent-app/src/wizard/run.ts` (1,917 lines, read start to finish across 5 windows)
- `packages/agent-app/src/modules/base.ts`
- `packages/agent-app/src/modules/catalog.ts` (567 lines)
- `packages/agent-app/src/modules/index.ts`
- `packages/agent-app/src/modules/known-tools.ts`
- `packages/agent-app/src/modules/types.ts`
- `packages/agent-app/README.md`

Tests were skimmed (not line-by-line audited) for coverage-adequacy judgment only:
`__tests__/init.test.ts`, `__tests__/secret-env.test.ts` (777 lines), `__tests__/cli-init-output.test.ts`, `__tests__/project-skills.test.ts`, `__tests__/wizard-compose.test.ts`, `__tests__/wizard-model-discovery.test.ts`, `__tests__/wizard-prompts.test.ts`, `__tests__/wizard-run.test.ts` (1,153 lines), `__tests__/cli-args.test.ts`, `__tests__/cli-audit-runs.test.ts`, `__tests__/cli-auth.test.ts`, `__tests__/cli-config.test.ts`, `__tests__/cli-first-run-state.test.ts` (1,435 lines), `__tests__/cli-foreground.test.ts`, `__tests__/cli-init-output.test.ts`, `__tests__/cli-memory.test.ts`, `__tests__/cli-metrics.test.ts`, `__tests__/cli-preflight.test.ts`, `__tests__/cli-presets.test.ts`, `__tests__/cli-sandbox.test.ts`, `__tests__/cli-status.test.ts`, `__tests__/cli-validate.test.ts`, `__tests__/modules.test.ts`, `__tests__/modules-catalog.test.ts`, `__tests__/install-skill.test.ts`.

No named in-scope file was missing.
