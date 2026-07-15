# Coverage Attestation — v1-freeze audit

Cross-referenced 23 auditor coverage notes (A1–A6, B1–B3, C1–C7, D1, E1–E4, F1–F2)
against `manifest-repo.txt` (1106 tracked files), `manifest-personal-agent.txt`, and
`manifest-a8c-agents.txt`. Worked at directory granularity; spot-checked every
`packages/*/src` non-test `.ts` file individually.

Method: enumerated each package's `src/**` non-test source set from the manifest and
diffed it against the "read in full" list in the owning auditor's §7 coverage note.
`PASS` = every load-bearing source file in the territory appears in some auditor's
read-in-full list (tests skimmed-only is acceptable per the audit method).

## Territory table

| Territory | Primary part(s) | Verdict |
|---|---|---|
| **packages/agent-app** — cli/onboarding (cli.ts, init.ts, ui.ts, account-home, package-version, install-skill, project-skills, wizard/*, modules/*) | A1 | PASS |
| packages/agent-app — diagnostics/provider (doctor, readiness-probe*, first-run-readiness, provider-setup, pi-oauth*, pi-auth-store-inspection, managed-runtime-packages) | A2 | PASS |
| packages/agent-app — runtime host (app, configured-agent, app-config, local-configuration, background*, process-incarnation, sandbox-manager, launchd, runtime-option-extensions, runtime-routes, index) | A3 | PASS |
| packages/agent-app — channels/IO (channels, channel-*, adapter-send-*, interaction-bridge, broadcast-recorder, notify-destinations, proactive-notify, seen-conversations, posted-message-index, web-command, tui-command, supermemory-plugin, trigger-overrides) | A4 | PASS |
| packages/agent-app — continuations/sessions/runs (continuation-*, sessions, run-history, runs-health, audit-runs, artifact-retention, backfill, metrics, request-model-override) | A5 | PASS |
| packages/agent-app — memory-surface/config (memory-command, memory-recall*, memory-retrieval, memory-rituals, memory-embedding-service, first-run-managed-memory, config-reference, consumer-contract, configuration-proposal-*) | A6 | PASS |
| packages/agent-app — bundled composer skill (skills/mono-agent-composer/**) | — (unclaimed) | **GAP** |
| packages/agent-app — resources/srt/package.json (bundled resource manifest) | — | GAP (minor) |
| **packages/agent-contracts** (15 src files + README) | C1 | PASS |
| **packages/agent-harness** (26 src files incl. context/*, skills/*, tool-policy/* + README) | C1 | PASS |
| **packages/agent-runtime** — vendored boundary (package.json, README, ARCHITECTURE, MIGRATION, index/runtime/ai/agent entrypoints + sandbox-seam grep) | C2 | PASS (boundary; ~115 impl `.js` deliberately excluded) |
| **packages/runtime-adapter** (10 src files + README) | C2 | PASS |
| **packages/memory** — bujo/* capture-recall group (21 files) + README | B1 | PASS |
| packages/memory — bujo/* graph-lifecycle group (17 files) | B2 | PASS |
| packages/memory — store/* + search/* (14 files) | B3 | PASS |
| **packages/observability** (30 src files incl. otel/* + README) | C3 | PASS |
| **packages/tui** (24 src files + README) | C4 | PASS |
| **packages/session-web** (7 backend src + webapp/src/** React app + README) | C4 | PASS |
| **packages/telegram-adapter** (13 src files + README) | C5 | PASS |
| **packages/slack-adapter** (9 src files + README) | C5 | PASS |
| **packages/webhook-adapter** (4 src files + README) | C6 | PASS |
| **packages/cron-adapter** (5 src files + README) | C6 | PASS |
| **packages/openai-api-adapter** (5 src files + README) | C6 | PASS |
| **packages/operator-adapter** (11 src files, live/* + tui/* + README) | C6 | PASS |
| **packages/config** (8 src files + README) | C7 | PASS |
| **packages/create-mono-agent** (3 src files + README) | C7 | PASS |
| **extras/a2a-adapter** (8 src files + README) | D1 | PASS |
| **extras/whatsapp-adapter** (10 src files + README) | D1 | PASS |
| **extras/memory-supermemory** (4 src files + README) | D1 | PASS |
| **extras/agent-orchestrator** (1 src file + README) | D1 | PASS |
| **demos/final-agent** (6 src files + README + IDENTITY/SOUL examples + tsconfig; no package.json intentional) | C7 | PASS |
| **docs/** (all 77 `.md` files, read in full) | E1 | PASS |
| **website/** (astro.config, vercel.json, content.config.ts, scripts/*.mjs, README, tsconfig, package.json) | E1 | PASS (generated `src/content/docs/**` mirror + `.astro/*` spot-checked) |
| **scripts/*.mjs** (verify-all, check-*, generate-config-reference, node-version, package-catalog, verify-consumers, verify-deep-imports, build-*-provenance, managed-runtime-attestation-probe, memory-benchmark, memory-capture-baseline-probe, fleet-green-check) | E2 | PASS |
| scripts/lib/*.mjs (build-provenance, memory-cleanup-calibration) | E2 | GAP (minor — existence/relevance confirmed, not full-read) |
| **scripts/release/** (validate/pack/publish/verify-release, package-graph, verify-packed-consumer + fixtures) | E2 | PASS |
| **.github/workflows/** (ci.yml, npm-release.yml) | E2, E4, E1 | PASS |
| **agents/** (5 agents × {.md,.toml} + README) | E3 | PASS |
| **skills/** (8 skills × {SKILL.md, agents/openai.yaml} + README) | E3 | PASS |
| **root meta files** (README, PACKAGES, AGENTS, CHANGELOG, package.json, pnpm-workspace.yaml, .gitignore, .nvmrc, .gitleaks.toml, tsconfig.base.json, .githooks/pre-commit) | E2, E3, E4, E1 | PASS |
| root vitest.config.mjs | E2 | GAP (minor — not explicitly read) |
| discoverability symlinks (.claude/{agents,skills}, .codex/agents, .agents/skills) | E3 | PASS (symlinks → already-audited agents/ + skills/) |
| **git hygiene** (branches, worktrees, merged/unmerged, PR state, ignored-file mechanism) | E3 | PASS |
| **security sweep** (gitleaks config + CI wiring, check-secrets, host-safety, live-config shape/permissions, token-detection empirical test) | E4, E2 | PASS |
| **deprecation ledger** (@deprecated markers, legacy `reflect`/`migrate`/`decay` paths, retired dirs, dead scripts/packages) | E4, E2, E3 | PASS |
| **~/personal-agent** (config, IDENTITY/AGENTS/README, 7 cron, 3 webhook, 24 skill headers, bin/* + bin/lib/*, launchd plists, memory samples) | F1 | PASS (live instance; areas/projects/resources bodies + some bin/* sampled, memory beyond-samples excluded) |
| **~/a8c-agents** (fleet config, 5 workers, bin/agents, scripts/*, skills-shared, docs, packages boundary, retired dirs, data/backups metadata) | F2 | PASS (live instance; several ops scripts + `.ultrawork/` + retired-dir bodies sampled/metadata-only) |

## Gaps

Hard gap (shipped, user-facing, unaudited content):

- `packages/agent-app/skills/mono-agent-composer/SKILL.md`
- `packages/agent-app/skills/mono-agent-composer/agents/openai.yaml`
- `packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md`
- `packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md`
- `packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md`
- `packages/agent-app/skills/mono-agent-composer/references/package-map.md`
- `packages/agent-app/skills/mono-agent-composer/references/playbooks.md`
- `packages/agent-app/skills/mono-agent-composer/references/validation.md`

These 8 files are the `mono-agent-composer` skill bundled inside the `@mono-agent/agent-app`
npm package and copied into user agents by `install-skill.ts` (`COMPOSER_SKILL_NAME`,
`BUNDLED_SKILL_DIR`). A1 audited the installer *code* but not the skill's *content*; no
auditor read these files (grep for `mono-agent-composer` across all 23 artifacts = 0 hits;
the only "composer" mentions are incidental — A3's `composeRuntimeOptionExtensions`, E1's
passing "composer skill references updated if needed"). SHOULD have been covered by **A1**
(owns `install-skill.ts` + agent-app onboarding); **E1**/**E3** are alternates (shipped docs
/ skills-governance content). Recommend a follow-up spot-read for content accuracy/staleness.

Minor gaps (within a claimed territory; low load-bearing weight, noted for completeness):

- `packages/agent-app/resources/srt/package.json` — bundled SRT resource dependency manifest, not audited by A1 (its `package-lock.json` sibling is a lockfile, deliberately excluded). SHOULD be A1.
- `scripts/lib/build-provenance.mjs`, `scripts/lib/memory-cleanup-calibration.mjs` — E2 confirmed existence/relevance but did not full-read. SHOULD be E2.
- `vitest.config.mjs` (root) — root test-runner config, not explicitly read by any part. SHOULD be E2.
- `website/pnpm-workspace.yaml` — trivial one-line workspace declaration, not explicitly read. SHOULD be E1.

Live-instance sampled-not-exhaustive (acceptable per the deliberate live-instance exclusion,
recorded here for transparency, not counted as framework gaps):

- `~/a8c-agents/.ultrawork/**` (36 files, orchestration scratch/tooling) — not sampled by F2.
- `~/a8c-agents/scripts/{preserve-brain-state,slack-approval-driver,trigger-steward,v2-migration-snapshot,verify-slack-continuation-canary,verify-gws-readiness,attention-collector-runtime-digest}.mjs` + `run-{proactive,control-broker,attention-collector}.sh` — directory-listed only (F2 time-budget triage).
- `~/a8c-agents/{activity-digest,slack-sweep,p2-watcher}/**` — confirmed-retired dir bodies not opened (F2).
- `~/personal-agent` remaining top-level `bin/*` scripts, `bin/lib/*` not-fully-read, and `areas/**` `projects/**` `resources/*.md` bodies — grepped-for-secrets/sampled only (F1).

## Gap-fill addendum

The **straggler cluster G1** (`audit/_raw/G1-composer-skill-stragglers.md`, adversarially verified in
`verified/V10.md` at HEAD 5f27a0ec) was created specifically to close the gaps recorded above. G1 read every
previously-unaudited file in full and produced findings; V10 independently re-verified them (every cited
file:line reproduced, the SRT lock hash recomputed byte-for-byte, both `scripts/lib` "not dead" claims
confirmed live-wired).

**Hard gap — now COVERED** (the 8-file `mono-agent-composer` bundled skill):

- `packages/agent-app/skills/mono-agent-composer/SKILL.md` — covered (G1 §2/§7; V10 F1/F3 premise checks)
- `packages/agent-app/skills/mono-agent-composer/agents/openai.yaml` — covered (G1 §7 read-in-full; no findings)
- `packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md` — covered (G1 F1/F3/F6)
- `packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md` — covered (G1 §7 read-in-full; no findings)
- `packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md` — covered (G1 F1/F3/F4/F5)
- `packages/agent-app/skills/mono-agent-composer/references/package-map.md` — covered (G1 F4/F5)
- `packages/agent-app/skills/mono-agent-composer/references/playbooks.md` — covered (G1 F2/F5)
- `packages/agent-app/skills/mono-agent-composer/references/validation.md` — covered (G1 §7 read-in-full; no findings)

**Minor gaps — now COVERED:**

- `packages/agent-app/resources/srt/package.json` — covered (V10 re-verified `@mono-agent/managed-srt` pin + `MANAGED_SRT_LOCK_SHA256` byte-for-byte)
- `scripts/lib/build-provenance.mjs` — covered (V10 confirmed live: imported by build/probe/publish + own test; backs root `build`)
- `scripts/lib/memory-cleanup-calibration.mjs` — covered (V10 confirmed live but dev-only: sole importer `memory-benchmark.mjs`, 0 CI hits)
- `vitest.config.mjs` (root) — covered (V10 confirmed worktree-exclude rationale)
- `website/pnpm-workspace.yaml` — covered (V10 confirmed `packages: []` self-contained Vercel app)

Note: `discovery-questions.md`, `validation.md`, and `agents/openai.yaml` carried no findings, so V10 relied
on G1's read-in-full attestation for them rather than a second independent full read this pass.

**Coverage verdict: PASS overall.** With G1/V10, every previously-flagged hard and minor gap file is now
audited. The only remaining unaudited content is the deliberately-excluded live-instance sampled bodies
listed above (not counted as framework gaps) and the intentionally-excluded vendored `agent-runtime` impl
`.js` and lockfiles.
