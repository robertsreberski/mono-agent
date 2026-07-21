# mono-agent v1-freeze audit — 2026-07-15

> **Historical snapshot:** This audit records the repository and live instances as they existed on 2026-07-15. Its package counts, grades, blockers, and operational state are evidence for that review, not current framework documentation. Use the root [README](../README.md), [package directory](../PACKAGES.md), and [published documentation](https://mono-agent-docs.vercel.app/) for the current system.

**Verdict: CONDITIONALLY FREEZE-READY.** The premise is delivered and the code is genuinely mature — 141 adversarially-verified findings across 126k LOC and two live deployments produced **zero correctness catastrophes and exactly two freeze blockers**, neither of them code: a license-coherence decision (AUD-001) and the never-restarted 7-day fleet-green window (AUD-002). Land those two, sweep the 59-item pre-freeze hygiene bucket, close epic #119, tag v1, freeze with confidence.

Audited at **v0.11.2, HEAD `5f27a0ec`**. Process: 24 Sonnet auditors → 10 Opus adversarial verifiers (every cited line re-opened, every dead-code claim grep-proven, freeze-blockers two-key confirmed) → coverage-critic attestation (**PASS, 100% of territories**) → this synthesis. Method details: [00-methodology.md](00-methodology.md).

## The story in five sentences

The framework does what it promises: one config folder genuinely yields a working agent, the memory/preview and session-legibility DoD items are met and verified, failover is real, and the four extras prove the plugin seam technically. Code quality is unusually high — near-zero debt markers, 0.85 test ratio, no fake-success paths found by 10 adversarial verifiers hunting for exactly that. The weaknesses concentrate not in code but in *what nobody re-checked*: an uninstalled DoD tracker, stale reference tables shipped to every new user, 27+ dead exports, a regressed git tree, and an unlicensed wrapper around a GPL kernel. The two live instances prove maturity (flagship B+) and simultaneously map the post-v1 roadmap (the a8c fleet had to hand-build delivery reliability, crash-loop protection, and shared knowledge — framework-fit C+). Every surviving action is filed as an issue in the **`v1-freeze` milestone** (five cross-referenced to already-open issues instead of re-filed), and the recurring failure shapes are codified into three new engineering skills plus 39 skill amendments so the same problems stop recurring.

## v1 Definition of Done — final status

| DoD clause | Status |
|---|---|
| Lean core, plugin seam documented | ✅ met in substance; epic text stale ("≤18" vs the deliberate 16+4+1=21) — AUD-014 fixes the text |
| Memory hygiene + `mono-agent memory` preview | ✅ met (verified working; preview honest) |
| Session boundaries visible in TUI + web + status | ✅ met (one replay-detail parity nit, AUD-064) |
| Failover proven; proactive failures alert | ✅ met (fail-closed rollback guard independently verified) |
| Every config key documented + unknown keys warned | ✅ met (registry governance real; 3 prose gaps found → AUD-010/011/012) |
| **Fleet green 7 consecutive days on the v1 build** | ❌ **unmet — the only original blocker.** Tracker uninstalled 07-13; clock never restarted (AUD-002) |
| *(new, found by audit)* License coherence | ❌ **blocker** — GPL-3.0 kernel, UNLICENSED everything else, no root LICENSE (AUD-001) |

## Top actions (full plan: [v1-freeze-action-plan.md](v1-freeze-action-plan.md))

1. **AUD-001** — decide the license, add root LICENSE, make 21 package fields coherent. *(S after the decision)*
2. **AUD-002** — redeploy fleet to the freeze sha, reinstall the nightly `fleet-green-check` LaunchAgent, run 7 unattended green days.
3. **AUD-003** — fix the harness's hardcoded telegram/slack "human attached" allowlist (WhatsApp — a real push channel — gets non-interactive framing; TUI impact is cosmetic, OpenAI-API is correctly request-driven).
4. **AUD-012** — reconcile the npm-shipped composer skill's stale reference tables (every new user's composing agent reads these).
5. **AUD-005/006/007** — the three P1 correctness/honesty paper cuts (disabled-channel validation, capture fence tolerance, Supermemory doctor probe).
6. **AUD-013** — CI never runs the consumer contracts; wire `verify:consumers` in.
7. **AUD-053–056** — delete the 27+ grep-proven dead exports/files ([dead-code-ledger.md](dead-code-ledger.md)).
8. **AUD-036** — git hygiene: sweep 47 branches/50 worktrees, enable `delete_branch_on_merge`.
9. **AUD-046/047** — flagship ops debt: log rotation + pin `bin/*` to the runtime snapshot.
10. **AUD-034/035** — close the two security-tooling gaps (gitleaks Telegram-token rule; dependency-vuln scanning).

## Grades at a glance (details: [scorecard.md](scorecard.md))

**Framework:** agent-app A-/B+ band across six territories · memory B/B+ · contracts+harness B · vendored-runtime boundary B · observability B+ · tui/session-web B+ · messaging B+ · ingress B- · config B+ · extras B+ · docs B+ · **scripts/CI C+** · governance B- · **bundled composer skill C+**. **Security posture:** B. **Live:** personal-agent B+ (fit B) · a8c-fleet B+ (fit C+).

The pattern: **what agents built is B+/A-; what required re-checking later is C+.** That asymmetry is the audit's central finding, and the skills below are the structural answer.

## Agent leverage ([agent-workflow-improvements.md](agent-workflow-improvements.md))

Six recurring failure shapes were identified (tested-but-never-wired, docs-drift-behind-exports, dead-code-after-refactor, duplicated primitives, hygiene regression, silent ops decay). Shipping with this audit: **three new engineering skills** — `dead-code-audit`, `repo-hygiene-gc`, `ops-log-hygiene` — plus **39 amendments** across all 8 existing skills, each seeded with the exact commands and gotchas the audit proved out.

## Navigation

- [00-methodology.md](00-methodology.md) — process, verification stats, coverage attestation
- [scorecard.md](scorecard.md) — full maturity matrix + premise report card
- [parts/](parts/) — 21 per-territory audits (findings → actions each)
- [security.md](security.md) · [dead-code-ledger.md](dead-code-ledger.md)
- [live-instances/](live-instances/) — personal-agent + a8c-fleet deep evaluations *(the a8c fleet
  was retired 2026-07-20 and replaced by the single-instance `~/agents/a8c-assistant`; its audit is
  kept as a point-in-time record — see the banner in its file)*
- [v1-freeze-action-plan.md](v1-freeze-action-plan.md) — the master plan (118 actions, 3 buckets, issue links)
- [agent-workflow-improvements.md](agent-workflow-improvements.md) — skills + workflow synthesis
- [_raw/](_raw/) — full provenance: auditor artifacts, verifier verdicts, consolidated tables
