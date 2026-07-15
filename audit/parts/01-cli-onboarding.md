# 01 · CLI & onboarding

**Scope:** `packages/agent-app` — `cli.ts`, `init.ts`, the interactive wizard (`wizard/*`), `project-skills.ts`, `modules/*`, and the package README. **Maturity grade:** B (verifier-adjusted, unchanged from auditor). This territory is functionally mature and unusually honest — TOCTOU-safe atomic file writes, no-clobber promotion, live per-route readiness probing before ever declaring an agent "ready," heavy test coverage, no secrets in source, and zero verifier refutations in this part. The grade stays capped at B because the "lean, understandable core" premise clause is genuinely violated (a 4,493-line `cli.ts`, a 1,916-line wizard state machine) and because one hardened security primitive is independently hand-rolled twice in the same small package. No item in this territory was found to block the v1 freeze.

## Findings

**F1 — [P2] [verifier: CONFIRMED]** — `packages/agent-app/src/cli.ts:1429`–`3612`. The file is 4,493 lines total; the `init`/`auth` orchestration block alone (`RunInitEnvironmentContext` through `shellCommandArgument`) is ~2,183 lines, essentially half the file, and `runInit` (`cli.ts:1435`) is an ~870-line function containing a labelled `firstRun: for (;;)` loop nesting `readyAttempt:`, `interruptedRecoveryMenu:`, `sandboxRecoveryMenu:`, and `recoveryMenu:` labelled loops. Violates the "lean, understandable core" premise clause — a competent stranger cannot hold this state machine in their head without the surrounding ~250 lines of comments. Verifier re-opened every cited line and confirmed the LOC counts; a genuine premise hit, not style noise.
```
async function runInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext): Promise<number> {
```

**F2 — [P2] [verifier: CONFIRMED, dead code proven]** — `wizard/run.ts:336` (`runModelRepairWizard`), `wizard/run.ts:108`–`118` (`ModelRepairOutcome`), re-exported at `wizard/index.ts:36`. Repo-wide grep (excluding `dist/`/`node_modules`) turns up only the definition, the re-export, and two test files; zero production callers, zero hits in either live instance (`~/personal-agent`, `~/a8c-agents`). The CLI's actual "edit model routes" recovery path calls `runSetupRepairWizard({ initialStep: 1, ... })` instead (`cli.ts:2112`–`2135`). The verifier additionally confirms (via NEW-1) that the package's `exports` map exposes only `.`, and `wizard/index.ts` is not re-exported from the top-level `index.ts` — so this is unreachable by external npm consumers too, not just internally. Cleanly deletable, no published-API-break risk.
```
wizard/run.ts:336: export async function runModelRepairWizard(
wizard/index.ts:36: export { runInitWizard, runModelRepairWizard } from "./run.js";
```

**F3 — [P2] [verifier: CONFIRMED]** — `init.ts:1189` (`atomicReplaceFile`) vs `project-skills.ts:487` (`atomicWriteManagedExact`). Two independent implementations of the same hard problem — atomic, TOCTOU-safe, no-clobber replacement of a security-sensitive file this process owns — exist side by side: `init.ts` uses async `fs/promises` with fsync + rename-based commit + concurrent-writer backup/restore, `project-skills.ts` uses sync `fs` (`openSync`/`fstatSync`/`renameSync`) with its own ownership/mode assertions. Verifier confirms both exist with independent TOCTOU seams; a security or edge-case fix (new symlink-race check, new TOCTOU window) applied to one will not automatically propagate to the other. This doubles the audit surface for a hardened primitive, and is part of a cross-territory pattern (matched by A2 F3's redaction duplication and A3 F4's 4x hand-rolled lock primitive) — the verifier's synthesis note flags this as one cross-cutting anti-pattern: this package repeatedly hand-rolls hardened filesystem/security primitives instead of sharing them.
```
init.ts:1189:            async function atomicReplaceFile(options: AtomicReplaceOptions): Promise<void> {
project-skills.ts:487:   async function atomicWriteManagedExact(
```

**F4 — [P3, amended from P2] [verifier: AMENDED]** — `packages/agent-app/README.md:112` documents the 90s cloud / 240s local per-route timeouts. The auditor's original framing (P2, "seconds-to-minutes" claim not met by the flagship interactive wizard) is downgraded by the verifier: the timeouts ARE disclosed at README:112, so this is a *prominence* nit (buried mid-paragraph, not front-loaded in the opening) rather than a missing disclosure or premise violation — "seconds-to-minutes" literally encompasses a multi-minute wizard. The underlying behavior (live per-route model calls, possible sandbox install+preflight, possible live OAuth, all before any file is written) is a deliberate, well-reasoned safety tradeoff, not a bug. Cheap fix remains valid (A1-6).

**F5 — [P3] [verifier: CONFIRMED]** — `packages/agent-app/README.md:55`–`228`. A small number of extremely dense, jargon-heavy paragraphs — e.g. the 24-line paragraph starting "Before the first macOS background launch..." at line 157 covers runtime snapshotting, launchd semantics, and background-snapshot keys in one breath. Accurate but reads as compressed internal spec/changelog prose rather than onboarding documentation; a new external contributor evaluating "is this core lean and understandable" would struggle to extract the operating model without already knowing it. Verifier confirmed the line-count/paragraph density; kept at P3 as borderline style but bearing on the "understandable core" clause.

**F6 — [P3] [verifier: CONFIRMED, dead-ish, proven]** — `init.ts:845` (`secretEnvLockPathFor`). Exported from the module but not re-exported from the package's public `index.ts`; only consumer repo-wide is its own test (`secret-env.test.ts`). Verifier confirms zero hits in either live instance and, per NEW-1, that it is unreachable from the `exports` map as well — currently unreachable from any production code path or external consumer.

## Dead code & deprecation

**Proven dead:**

- `wizard/run.ts:108`–`118` (`ModelRepairOutcome`) and `wizard/run.ts:336`–`388` (`runModelRepairWizard`), re-exported at `wizard/index.ts:35`–`36`. Proof: `grep -rln "runModelRepairWizard" . --include=*.ts --include=*.js --include=*.md | grep -v node_modules | grep -v /dist/` → only the definition, re-export, `wizard-run.test.ts`, `cli-first-run-state.test.ts`. Zero hits in `~/personal-agent`/`~/a8c-agents`. Verifier confirms externally unreachable too (exports map exposes only `.`) — the "keep as external API" hedge is moot.
- `init.ts:845` (`secretEnvLockPathFor`). Proof: `grep -rln "secretEnvLockPathFor" . | grep -v node_modules | grep -v /dist/` → `init.ts` + `secret-env.test.ts` only. Zero hits live. Same externally-unreachable conclusion applies.

**Nothing in this territory was refuted as dead** by the verifier (the one refutation in cluster V1, `attestManagedBackgroundRuntime`, belongs to A3, not A1 — noted here so nobody incorrectly folds it into this part's dead-code list).

**Deprecated / legacy (load-bearing unless noted):**

| Item | Evidence | Classification |
|---|---|---|
| `--recipe <id>` flag, `mono-agent recipes` alias | `cli.ts:166,3402-3424,3742-3763`; `RECIPE_TO_PRESET` at `wizard/presets.ts:106-110` | Removable, undated. Fully superseded by `--preset`/`mono-agent presets`, every call site prints a deprecation hint. No removal milestone. Safe to schedule post-v1, not blocking. |
| `--fallback-models <csv>` vs `--fallback <ref>` | `cli.ts:698-707`; `wizard/answers.ts:270-293`; `wizard/from-flags.ts:49-50` | Load-bearing, actively supported and tested back-compat. Permanent branch with no stated sunset. |
| `LEGACY_TOOL_ALIASES` snake_case tool names | `modules/known-tools.ts:46-57` | Load-bearing. Existing fleet/user configs depend on it. No action needed. |
| `mono-agent doctor` / `mono-agent setup` aliases | `cli.ts:148-152,276-284` | Not legacy — permanent friendly aliases, no deprecation warning. Listed only to distinguish from `--recipe`. |

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A1-1 | Decompose `cli.ts` (4,493 LOC) into focused modules | F1 — "lean, understandable core" premise clause | Extract, keeping `cli.ts` as a thin dispatcher: `cli-args.ts` (parse/help, ~800 lines, has tests), `init-command.ts` (`runInit` through recovery-menu helpers, `cli.ts:1429`-`3612`, ~2,180 lines), `background-command.ts` (`runStart`/`runForeground`/`runBackgroundCommand`/`printAppStatus`/`waitForShutdownSignal`, `cli.ts:4064`-`4478`), `validate-config-command.ts` (`runValidate`/`runConfig`/preset rendering, `cli.ts:3658`-`3990`). Keep existing test files, repoint imports | M | `wc -l cli.ts` drops below ~800; `pnpm --filter @mono-agent/agent-app run typecheck && test` green; `pnpm run check:architecture` green | n |
| A1-2 | Delete dead `runModelRepairWizard`/`ModelRepairOutcome` | F2 — proven dead, and per verifier NEW-1 unreachable externally too, so delete (not wire-up) is the correct disposition | Delete the function/type/exports in `wizard/run.ts` and `wizard/index.ts` plus its two test suites | S | `grep -rln "runModelRepairWizard"` returns nothing; full test suite green | n |
| A1-3 | Consolidate the two atomic-secure-file-write implementations | F3 — one security-sensitive primitive implemented twice with different fault-injection seams and sync/async styles; part of the cross-artifact duplication theme (A1 F3 / A2 F3 / A3 F4) | Extract a shared internal helper (e.g. `secure-file-replace.ts`) covering "compare-and-swap replace a file this process owns, refusing symlinks/foreign-owners/hard-links, with an injectable fault-seam," used by both `init.ts`'s `.env`/`.gitignore` merge and `project-skills.ts`'s managed-skill activation | L | `secret-env.test.ts` (777 lines) and `project-skills.test.ts` (191 lines) still pass unmodified against the shared implementation; no behavior change | n |
| A1-4 | Set (or execute) a removal timeline for `--recipe`/`mono-agent recipes` | Legacy surface with no sunset date | Pick a version (e.g. next minor after v1) to delete `RECIPE_TO_PRESET`, the `--recipe` flag, and the `recipes`→`presets` alias; until then, add the target version to the existing deprecation hint strings | S | Deprecation hint text names a version; tracking issue filed | n |
| A1-5 | Same for `--fallback-models` legacy CSV flag | Legacy surface | Same pattern as A1-4: pick and announce a removal version, or explicitly decide it stays forever (document why) and close the question | S | Decision recorded (issue or doc), hint text updated if removal is chosen | n |
| A1-6 | Make the wizard's real wall-clock cost explicit and front-loaded in `--help`/README | F4 — timeouts are disclosed (README:112) but not prominent; verifier confirms this is a prominence fix, not a disclosure gap | Add one explicit sentence to `renderHelp()`'s `init` entry and the README's opening paragraph: the flag/non-TTY path is scaffold-only and fast; the interactive wizard runs real per-route model calls (state the 90s/240s timeouts) before it ever writes a file | S | `mono-agent init --help` and README both state the distinction in the first few lines, not buried mid-paragraph | n |

## Quarantine (refuted/unproven)

No findings, dead-code claims, or actions specific to this part (A1) were refuted or found unproven by the verifier. (For completeness: the verifier's sole refutation in cluster V1 — A3 F2, `attestManagedBackgroundRuntime` incorrectly flagged as dead product code, actually live via `scripts/managed-runtime-attestation-probe.mjs` / `fleet-green-check.mjs` — belongs to part A3, not this one.) The verifier also rejected all three proposed freeze-blockers in the wider V1 cluster, but none of those three (A2-1 Supermemory liveness, A2-2 readiness-probe-worker test coverage, A3-1 `preserveMcpServersUnderOverride` test coverage) originate from this A1 territory.
