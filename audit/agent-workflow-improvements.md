# Agent workflow improvements — making agents work better on this repo

This repo is built almost entirely by AI agents in goal loops. The audit therefore treated *recurring failure shapes* as first-class findings: 24 auditors flagged 61 skill-worthy observations, consolidated and dispositioned in [`_raw/skill-backlog.md`](_raw/skill-backlog.md) — every flag assigned to exactly one home. This doc is the synthesis: what actually goes wrong in agent-driven development here, and what now exists to stop it.

## The six recurring failure shapes

1. **Tested-but-never-wired.** Good TDD discipline produces a fully-tested function that no production path calls (`compactPostedMessageIndex`, the entire best-effort capture queue, `check-getting-started-version-pins.mjs`). Green tests read as "done"; reachability was never checked.
2. **Docs drift behind exports.** README "Public API" lists, MIGRATION counts, and seed templates (`IDENTITY.example.md`, the bundled composer references) fall behind `src/index.ts` because nothing diffs prose against exports (5+ packages affected; the composer skill drifted through ≥3 feature PRs).
3. **Dead code survives refactors.** When a shared/pooled mechanism supersedes a per-request one, the old exports linger (`createMemoryRecallRuntimeExtension`); 27+ dead symbols accumulated with zero unused-code signal (`noUnusedLocals` off, no ESLint).
4. **Duplicated hardened primitives.** Instead of grepping for an existing implementation, agents re-derive it: atomic-secure-write ×2, secret redaction ×2 (drifted apart across a trust boundary), owner-private lock ×4, cron parsing ×2 (losing timezone support).
5. **Hygiene regresses without automation.** #167 verified 2 branches / 3 worktrees; 8 days of goal-loop velocity later: 47 / 50. `delete_branch_on_merge` was off; no skill owned the sweep.
6. **Ops honesty decays silently.** A 1.23 GB log, ~4,500 channel-restart cycles, a 108× crash loop, and a "nightly tracker" that was uninstalled — all invisible because deploy checks stop at "process loaded" and no standing discipline reads the logs.

## What ships with this audit

### Three new engineering skills (`skills/`)

| Skill | Fixes shape | Core content |
|---|---|---|
| **`dead-code-audit`** | 1, 3, 4 | Whole-monorepo dead-export grep; maintenance-routine (`compact*/prune*/gc*`) call-site check; orphaned-wiring sweep after "shared/pooled" refactors; duplicated-primitive grep before hand-rolling; the **5-step deprecation-removability protocol** (app/cli → scripts/demos → live instances + plists → docs → published `bin`) that correctly split `reflect.ts` (keep) from `store.ts` methods (remove); read-only live-manifest ground-truthing. |
| **`repo-hygiene-gc`** | 5 | One-time `delete_branch_on_merge=true`; merged-branch sweep; worktree sweep + prune; the post-merge protocol; double-digit-count trigger cadence. |
| **`ops-log-hygiene`** | 6 | Log-size caps at every deploy (+ pinned-snapshot wrapper verification); post-restart crash-loop tail that **fails the deploy** on N identical errors; degraded-channel churn detection over the last hour of logs. |

### 39 amendments across all 8 existing skills

Full seed text in [`_raw/skill-backlog.md`](_raw/skill-backlog.md) §2. Highlights: **verify-green** gains a "co-located proof" review checklist (redaction reuse, security-comment⇒security-test, enabled-early-out ordering, live↔replay parity), the phantom-gate rule, the corrected verify-all≠CI statement, a DDL-migration guard, and a periodic gitleaks self-test; **docs-sync** gains README↔index parity, rename-grep, config-reference→feature-registry diffing, and explicit scope over seed templates + composer references; **new-package** gains whole-core adapter-neutrality, harness channel-classification, singleton-lock reuse, sibling-test parity, MCP cleanup ordering; **release-lockstep** gains `--provenance`, root-pin spot-checks, `_VERSION`-literal greps, deprecation sunset dating; **fleet-deploy** gains verify-the-automation-actually-exists and credential validate-after-write; **worktree-feature** gains the durable-state purge checklist and the post-merge cleanup step; **pi-upstream-recon** generalizes native-first beyond pi and adds the cross-boundary license check; **live-smoke** gains a real `worker_threads` scenario.

### Not skills — CI tripwires and protocol changes (filed as actions)

- **Composer-skill freshness tripwire**: fail CI when feature-registry gains a config row absent from the composer references (part of AUD-012's acceptance).
- **Dev-tooling consistency check**: extend the drift guard to skills/agents prose (AUD-038, AUD-037).
- **`noUnusedLocals`/ESLint evaluation** (AUD-080) — the systemic fix for shape 3.
- **Goal-loop protocol amendment**: when a DoD line is corrected mid-epic, *edit the issue body*, don't just comment (the "≤18 packages" line stayed wrong for 10 days; AUD-014).

## The deeper lesson

The audit's grade distribution tells one story: **code the agents wrote is B+/A-; everything that requires remembering to look again is C+.** Agents here are excellent at hardening what's in front of them and poor at noticing what's absent — the uninstalled tracker, the unwired function, the stale reference table, the growing log. Every improvement above converts an "absence" into a **presence** an agent can be told to check: a named gate, a grep with an expected count, a table that must stay in sync, a deploy step that fails loudly. That's the pattern to keep: when a process depends on someone noticing something, turn it into a check that fails.
