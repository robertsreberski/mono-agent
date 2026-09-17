---
name: changelog
description: File an Unreleased changelog entry for user-visible changes and cut release notes. Use when a PR changes shipped behavior or when cutting vX.Y.Z notes.
---

# Changelog entries and release notes

Every user-visible change files its own entry under `## Unreleased` in
`CHANGELOG.md`. The release PR moves those entries into a version section;
the tag workflow publishes that section as the GitHub Release body. CI
enforces all three steps — this skill tells an agent how to comply.

## What belongs in an entry

- The user-visible outcome: what a user of the packages gets, plus its
  boundary (limits, defaults, affected surfaces).
- Imperative voice: start bullets with `Add`, `Keep`, `Fix`, `Let`, `Remove`.
- Roughly 80-column wrap with two-space continuation lines.
- Inline code for config keys, tool names, flags, and commands.
- No PR numbers, issue links, or implementation narrative.

## What does not belong

- `chore(release)` version bumps and dependency-bump churn with no
  user-visible effect.
- CI-only, test-only, and docs-only changes.
- Internal refactors with no observable behavior change.

## Where it goes

Add bullets under `## Unreleased` at the top of `CHANGELOG.md`. One bullet
per user-visible change; aggregate related commits rather than transcribing
the log.

## Escape hatch (honest use only)

When the PR genuinely has no user-visible change, either carry the
`skip-changelog` label or put a `Changelog: none` line in the PR body. Never
use the hatch to skip documenting a user-visible change.

## Cutting release notes

Cut the accumulated entries before bumping any version:

```bash
node scripts/release/cut-changelog.mjs --version X.Y.Z --title "Short theme" --check
node scripts/release/cut-changelog.mjs --version X.Y.Z --title "Short theme"
pnpm run check:changelog
```

The script refuses an empty `Unreleased`, a duplicate or non-greater
version, a bad date, and a malformed file. It never edits older sections.

## Checks

- `pnpm run check:changelog` — structure, published-version coverage, and
  (in a PR context) the new-entry rule.
- `vitest run scripts/__tests__/check-changelog.test.mjs` when touching the
  check; the release-side file under `scripts/release/__tests__/` when
  touching the release scripts.
