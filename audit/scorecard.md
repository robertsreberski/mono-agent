# Scorecard — maturity by territory

Grades are the **verifier-adjusted** finals from `parts/*` (A = exemplary … F = failing). "Fit" = framework-fit grade for live instances. One-liners condense each part's verdict; full findings live in the linked docs.

## Framework code

| # | Territory | Grade | One-line verdict |
|---|---|---|---|
| [01](parts/01-cli-onboarding.md) | agent-app · CLI & onboarding | **B** | Mature, honest-by-design init/wizard path; held back by the 4,493-line `cli.ts` monolith, a dead wizard export, and undated deprecation shims. |
| [02](parts/02-diagnostics-provider.md) | agent-app · diagnostics & provider | **A-** | Exceptionally defensive credential/doctor code; two check-never-ran gaps (Supermemory liveness, readiness-worker coverage) and no provenance visibility line. |
| [03](parts/03-runtime-host.md) | agent-app · runtime host | **B+** | TOCTOU-hardened, honest lifecycle; strains "lean core" via a ~1,800-line god-controller and a 4×-duplicated lock primitive. |
| [04](parts/04-channels-io.md) | agent-app · channels & proactive IO | **B+** | Careful channel composition; PR #256 fix verified sound; a tested compaction routine was never wired in; #201 gap located. |
| [05](parts/05-continuations-sessions-runs.md) | agent-app · continuations & runs | **B+** | Durable continuations exceptionally engineered (fail-closed rollback guard verified); `restart --force` message is now a partial truth vs the durable history store (#203). |
| [06](parts/06-memory-surface-config.md) | agent-app · memory surface & config ref | **B+** | Memory preview CLI solid (a v1 DoD item, met); config-reference types inferred from field-name suffixes; two hand-rolled duplicates of existing primitives. |
| [07](parts/07-memory-capture-recall.md) | memory · capture & recall | **B** | Rigorous, honest durability engineering; real fence-tolerance gap on the flagship Ollama path; a sizeable never-fed capture subsystem ships as if first-class. |
| [08](parts/08-memory-graph-lifecycle.md) | memory · graph & lifecycle | **B+** | Crash-safe rebuild/replay/forget machinery, heavily tested; #231 perf regression open; hardening density vs "lean core" is a conscious tension. |
| [09](parts/09-memory-store-search.md) | memory · store & search | **B** | Correctness-solid SQLite/FTS/vector store; latent schema-migration gap; a dead, publicly-documented legacy vector API. |
| [10](parts/10-contracts-and-harness.md) | agent-contracts & agent-harness | **B** | Clean adapter-neutral contracts + crash-safe durable history; one real leak — a hardcoded telegram/slack allowlist gives WhatsApp (a shipped push channel) non-interactive framing; TUI impact cosmetic, OpenAI-API correctly request-driven. |
| [11](parts/11-runtime-adapter-vendored.md) | runtime-adapter & vendored runtime | **B** | Well-tested facade with a mechanically-enforced boundary; **license metadata contradiction is the audit's #1 blocker**; untested sandbox-override footgun. |
| [12](parts/12-observability.md) | observability | **B+** | 250/250 tests, honest failure derivation; crash-mid-run event loss; key-only redaction under `includeSensitiveData:true` needs honest docs. |
| [13](parts/13-tui-session-web.md) | tui & session-web | **B+** | Session/rollover legibility genuinely delivered (v1 DoD, met); webapp React trees untested; replay-detail degrades boundary events to raw JSON. |
| [14](parts/14-messaging-adapters.md) | telegram & slack adapters | **B+** | Mature, well-tested; the getUpdates loop is genuinely root-caused and fixed (PR #243 verified); shared disabled-channel validation bug in both. |
| [15](parts/15-ingress-adapters.md) | webhook, cron, openai-api, operator | **B-** | Four well-engineered adapters (82–90% real coverage, loopback-safe defaults); cron README flatly contradicts shipped overlap feature; operator `live/config.ts` untested incl. redaction. |
| [16](parts/16-config-scaffolding.md) | config, create-mono-agent, demo | **B+** | 368 tests, self-checking loader/view parity; demo onboarding template references deleted memory tools. |
| [17](parts/17-extras-plugins.md) | extras plugin tier | **B+** | All four extras genuinely prove the plugin seam; #248 idempotency work verified merged+sound; two small plugin-local defects. |
| [18](parts/18-docs-website.md) | docs & website | **B+** | Unusually thorough and mostly accurate; glossary self-contradiction on memory behavior; two shipped Slack/Telegram surfaces invisible in prose docs. |
| [19](parts/19-scripts-ci-release.md) | scripts, CI & release lane | **C+** | Rigorous fail-closed tooling — but the 7-day fleet-green DoD signal has **no running automation** (the audit's #2 blocker) and CI never runs the consumer contracts. |
| [20](parts/20-repo-governance-hygiene.md) | governance, dev tooling, git hygiene | **B-** | Dev tooling accurate and parity-checked; epic DoD text stale; #167's clean git state fully regressed (47 branches / 50 worktrees) with no automation to prevent recurrence. |
| [21](parts/21-composer-skill-stragglers.md) | bundled composer skill + stragglers | **C+** | The npm-shipped composer skill's "exhaustive" references are stale on ≥6 shipped features and its playbook teaches a superseded pattern — the single point of failure for every new user's composing agent. |

## Cross-cutting

| Doc | Grade | One-line verdict |
|---|---|---|
| [security.md](security.md) | **B** | Solid primitives (safe-bind, no shell injection, live secret hygiene); gitleaks empirically blind to Telegram-token shapes; no dependency-vuln scanning; license coherence is the freeze blocker. |
| [dead-code-ledger.md](dead-code-ledger.md) | — | 27+ grep-proven removable items; 61-file legacy ledger classified with zero dead code among the load-bearing compat surfaces; §D records refuted claims and re-confirmed-live candidates so nothing gets deleted on a stale hunch. |

## Live instances

| Doc | Maturity | Fit | One-line verdict |
|---|---|---|---|
| [personal-agent](live-instances/personal-agent.md) | **B+** | **B** | Genuinely mature flagship (fresh memory, disciplined PARA, active use) with quietly accumulated ops debt: 1.23 GB unrotated log, snapshot-vs-dist provenance split, dead heartbeat machinery. |
| [a8c-fleet](live-instances/a8c-fleet.md) | **B+** | **C+** | Meticulously engineered fleet that proves the primitives — but had to hand-build multi-agent delivery reliability, crash-loop protection, and shared knowledge, mapping the framework's post-v1 gaps. |

## Premise report card

| v1 premise clause | Verdict |
|---|---|
| Simple, quick agents from one config folder | **Delivered.** Consumer contracts + wizard are real; the interactive wizard's minutes-scale provider calls deserve upfront framing (AUD-112). |
| Crons, webhooks, channels easily | **Delivered**, with paper cuts (disabled-channel validation AUD-005, cron README AUD-025). |
| Bring any model | **Mostly delivered.** Failover verified; the flagship local-model memory path can silently dead-letter on fenced JSON (AUD-006). |
| Lean, understandable core | **The weakest clause.** Code is clean but concentration is real: 7 oversized files (AUD-073), 4× duplicated lock primitive (AUD-071), 21 packages vs the epic's stale "≤18" text (AUD-014). |
| Open to external plugins | **Technically proven** by 4 extras — **legally unproven** until AUD-001 (license coherence) lands. |
| Clean memory + preview | **Delivered** (DoD met); entity-noise and dormant capture-queue cleanups remain (AUD-104, AUD-077). |
| Legible sessions | **Delivered** (DoD met); replay-detail parity nit (AUD-064). |
| Honest ops | **Mostly delivered** — and the audit's sharpest lens: the remaining dishonesties are enumerated and small (doctor Supermemory `ok` without probe AUD-007, `restart --force` message AUD-058, observability "redacted" claim AUD-016, composer references AUD-012, fleet-green automation claim AUD-002). |
