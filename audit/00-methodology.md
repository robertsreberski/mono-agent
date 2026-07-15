# 00 · Methodology & coverage attestation

Full-repository audit of mono-agent at **v0.11.2 (HEAD `5f27a0ec`, 2026-07-15)** plus its two live deployments, performed 2026-07-15 ahead of the v1 freeze (epic #119). Audit-only: the engagement changed no source, config, or live instance — its outputs are these documents, the `v1-freeze` milestone issues, and new/amended engineering skills under `skills/`.

## Yardstick

Every judgment is scored against the v1 premise (epic #119):

> simple, quick agent instances from one config in a folder; crons, webhooks, and channels easily; bring any model; agents in seconds-to-minutes; a lean, understandable core open to external plugins — with clean memory (and a way to preview it), legible sessions, and honest ops.

…and the v1 Definition of Done (≤18-package lean core *(later amended)*, memory hygiene + preview, session legibility, proven failover, fully documented config, 7 consecutive fleet-green days).

## Process (multi-agent, adversarial)

| Phase | What ran | Models |
|---|---|---|
| 0 · Inventory | Authoritative manifests: 1,106 tracked repo files + depth-2 territory maps of `~/personal-agent` (7,300 files) and `~/a8c-agents` (275) — `_raw/manifest-*.txt` | main loop |
| 1 · Audit fan-out | **23 scoped auditors** read their territory in full (every non-test `.ts` in every package, all 77 docs pages, all scripts/workflows, dev tooling, git state, security sweep, both live instances). Each produced `_raw/<part>.md`: findings with file:line evidence, maturity grade, dead-code entries, deprecation classification, actionable steps, skill-worthy flags | Sonnet |
| 1b · Gap-fill | Coverage critic found 13 unread files (the npm-shipped `mono-agent-composer` skill + 5 stragglers) → targeted auditor **G1** + verifier **V10** closed the gap | Sonnet + Opus |
| 2 · Adversarial verification | **9 refuter clusters + 1 coverage critic**. Refuters re-opened every cited line, re-graded severities, ran independent proof-of-death greps (repo + demos + scripts + website + both live instances) for every dead-code claim, and applied a **two-key rule** to freeze-blockers (auditor proposes, verifier confirms). Refuted findings are preserved in per-part quarantine appendices | Opus |
| 3 · Synthesis | 25 writers converted verified findings into `parts/*`, `security.md`, `dead-code-ledger.md`, `live-instances/*`; two consolidators normalized all actions (issue-filing table) and the skill backlog | Sonnet + Opus |
| 3b · Skills | Accepted skill-backlog entries implemented under `skills/` (Claude + Codex discoverable), gated by `check:codex-discoverability` | Opus |
| 4 · Final read | One end-to-end adversarial read of the assembled audit (go/no-go) | Opus |

Verification statistics: **155 raw findings → 141 survived** (Phase-2 verdicts: ~124 confirmed, ~31 amended — severity corrections in both directions, 2 refuted outright, several downgraded to unproven); **48 dead-code claims → 27+ grep-proven; 4 refuted as live, plus ~10 adjacent candidates the verifiers proactively re-confirmed live** (see `dead-code-ledger.md` §D); **10 proposed freeze-blockers → 2 confirmed** under the two-key rule.

## Coverage attestation

The independent coverage critic verified **100% of `packages/*/src` non-test TypeScript at file granularity** against the auditors' coverage notes, plus all docs, scripts, workflows, dev tooling, and both live instances. One hard gap (the 8-file bundled composer skill) and 5 minor stragglers were found and closed by G1/V10 — coverage is now **PASS** overall. Full territory table: [`_raw/coverage-attestation.md`](_raw/coverage-attestation.md).

| Territory | Part(s) | Verdict |
|---|---|---|
| agent-app (86 src files, 6 sub-territories) | 01–06 | PASS |
| memory (bujo / store / search) | 07–09 | PASS |
| agent-contracts + agent-harness | 10 | PASS |
| runtime-adapter + vendored agent-runtime (boundary) | 11 | PASS¹ |
| observability | 12 | PASS |
| tui + session-web (incl. webapp) | 13 | PASS |
| telegram + slack adapters | 14 | PASS |
| webhook + cron + openai-api + operator adapters | 15 | PASS |
| config + create-mono-agent + demos/final-agent | 16 | PASS |
| extras: a2a, whatsapp, memory-supermemory, agent-orchestrator | 17 | PASS |
| docs (77 pages) + website | 18 | PASS |
| scripts + scripts/release + CI workflows + githooks | 19 | PASS |
| agents/ + skills/ dev tooling + root meta + git hygiene | 20 | PASS |
| security & deprecation sweep (cross-cutting) | security.md | PASS |
| bundled composer skill + stragglers (gap-fill) | 21 | PASS |
| live: ~/personal-agent | live-instances/personal-agent.md | PASS |
| live: ~/a8c-agents | live-instances/a8c-fleet.md | PASS |

¹ Vendored `agent-runtime` prebuilt `.js` (~115 files) deliberately audited at boundary level only (exports map, types, ARCHITECTURE/MIGRATION docs, spot-checked entrypoints) — line-level audit of vendored upstream code was out of scope.

## Provenance

Raw per-auditor artifacts and verifier verdict files are preserved under [`_raw/`](_raw/) — every finding in the final documents traces to a raw artifact and a verifier verdict. Nothing refuted was silently deleted; quarantine appendices keep the record.
