---
name: verify-green
description: Select and run the smallest risk-based verification lane that proves a mono-agent change. Use before claiming a change works, before committing or opening a PR, or when asked to verify, run the gate, make it green, or check architecture.
---

# Verify green

Verification is selected from the diff, not accumulated from every available
workflow. Run focused checks while iterating, then execute the chosen lane once
before shipping. Do not repeat a passing broad gate at the same SHA.

## 1. Classify the change

Choose the highest applicable lane:

| Lane | Typical diff | Required proof |
|---|---|---|
| Process | `AGENTS.md`, `skills/`, agent metadata, internal docs | Relevant contract tests, discoverability, OSS hygiene, whitespace |
| Package | Ordinary implementation within existing package boundaries | Dependency-closure build, focused tests, package typecheck, one broad CI gate |
| High risk | Security/sandbox, storage or migration, lifecycle, provider routing, delivery, public package boundaries | Focused checks, one local `verify:all`, CI, one matching live smoke |
| Release | Mechanical lockstep version/publish work | Use `release-lockstep`; do not add deployment or consumer checks here |

A mixed diff uses the highest lane. Explain the classification in the final
evidence so reviewers can challenge it.

## 1a. Cross-process contract changes

A **wire contract** is any value this repo emits that a different process parses
later: `callback_data` protocols, event and tool names, on-disk state shapes,
notification payloads, CLI JSON. Renaming or retiring one is always **high
risk**, however small the diff, because in-repo tests cannot observe the other
side. Green tests are the expected result of this break, not evidence against it.

Before merging such a diff:

```bash
# in-repo consumers
grep -rn "<old protocol literal>" packages/*/src extras/*/src --include="*.ts"
# out-of-repo consumers — the fleet parses these contracts too
grep -rn "<old protocol literal>" ~/personal-agent ~/agents/*/ ~/a8c-agents/*/ \
  --include="*.mjs" --include="*.ts" --include="*.md" 2>/dev/null \
  | grep -v node_modules | grep -v "/dist/"
```

Then require the matching `live-smoke` round-trip: emit the new contract and
confirm the far side acts on it. A unit test asserting a **literal** (`["ask:0",
"ask:1"]`) proves only that the literal is unchanged — derive the expectation
from the exported builder instead, so retiring the protocol fails the test that
pins it.

PR #527 renamed the Telegram button protocol `ask:<index>` → `reply:v1:<0-7>`
with every gate green. Personal Agent heartbeat cards kept emitting the old
payload for a week; taps did nothing, and a test pinning the literal stayed green
throughout.

## 2. Process lane

Do not build packages, run live smoke, inspect the fleet, or run release checks
for a docs/skills/process-only diff. Select tests that cover the edited contract.
For the engineering-skill surface, use:

```bash
pnpm exec vitest run \
  scripts/__tests__/check-codex-discoverability.test.mjs \
  scripts/__tests__/repo-hygiene-skills.test.mjs \
  scripts/release/__tests__/package-count-drift.test.mjs
pnpm run check:codex-discoverability
pnpm run check:oss-hygiene
git diff --check
```

Run the website build only when `docs/`, `website/`, or published-site inputs
changed; use `docs-sync` to choose that surface.

## 3. Package lane

While iterating on package X:

```bash
pnpm --filter @mono-agent/<X>... run build
pnpm --filter @mono-agent/<X> test
pnpm --filter @mono-agent/<X> run typecheck
```

Add focused dependent-package checks when the changed public behavior crosses a
package boundary. Before merge, rely on one successful hosted CI run for the
exact head SHA. If Actions is unavailable, run `pnpm run verify:all` once under
a supported Node runtime and record why CI could not provide the broad gate.

## 4. High-risk lane

Run the focused package checks above, then:

```bash
pnpm run verify:all
```

Require hosted CI for the exact head SHA and select exactly one scenario from
`live-smoke` that exercises the risky boundary. Add a second scenario only when
the diff independently changes a second live surface.

Provider-backed smoke is reserved for provider behavior. UI, worker transport,
and lifecycle changes should use their narrower local scenarios instead of paid
model calls.

## Worktree dist rule

Cross-package imports resolve through built `dist/`. After editing package A,
rebuild A before testing or typechecking a dependent package. A process-only
change does not exercise package resolution and needs no dist baseline. See
`worktree-feature` for diff-aware worktree setup.

## Failure handling

- Diagnose the first stable failure; do not rerun an unchanged failing broad gate.
- When a failure may pre-exist, compare against the exact base SHA in a detached worktree.
- If hosted CI fails immediately for an account or billing condition, stop polling and report that external blocker.
- Never replace a failed stated check with a different check without naming the substitution.

## Report format

State the lane, exact commands, SHA, and pass/fail result. For failures, name the
failing test or gate. A green claim without command evidence is not complete.
