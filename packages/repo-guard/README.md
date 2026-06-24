# @mono-agent/repo-guard

## Category

Category: `core`

## Responsibility

Provides local-only denylist loading, recursive payload scanning, loud guard
errors, and audit helpers for repository-visible output such as GitHub issue and
pull request metadata. It is intended for planner, implementer, reviewer, and
coordinator scripts that write to GitHub or create branch/task metadata.

## Install / Usage

```bash
pnpm --filter @mono-agent/repo-guard run build
```

```ts
import {
  guardRepoVisiblePayload,
  loadRepoVisibleDenylist,
  sanitizeRepoVisibleString,
} from "@mono-agent/repo-guard";

const denylist = await loadRepoVisibleDenylist();

const branchName = sanitizeRepoVisibleString("dogfood/100-local-agent-alpha", {
  denylist,
  replacement: "redacted",
});

guardRepoVisiblePayload(
  {
    title: "Fix metadata guard",
    body: "Ready for review.",
    branchName,
  },
  { denylist, surface: "github_pr" },
);
```

The default local file is `.mono-agent/repo-visible-denylist.jsonl` when present.
That directory is ignored by the repository. Set
`MONO_AGENT_REPO_VISIBLE_DENYLIST_FILE` to require a specific file, or
`MONO_AGENT_REPO_VISIBLE_DENYLIST` for smoke tests and CI.

## Public API

- `loadRepoVisibleDenylist`, `loadRepoVisibleDenylistSync`
- `createRepoVisibleDenylist`
- `scanRepoVisibleValue`, `guardRepoVisiblePayload`
- `sanitizeRepoVisibleString`, `repoVisibleSlugVariant`
- `scanLocalRepoFiles`, `scanGitHubRepoMetadata`
- `RepoVisibleGuardError`
- `RepoVisibleDenylist`, `RepoVisibleDenylistEntry`,
  `RepoVisibleFinding`, `RepoVisibleScanResult`,
  `RepoVisibleCommandRunner`

## Dependency Boundary

This package has no runtime npm dependencies. It uses Node filesystem and child
process APIs, and an injectable command runner for `git`/`gh` so tests and
private dogfood scripts can keep scan behavior deterministic.

## What This Package Does Not Own

It does not own the private dogfood role scripts that actually call `gh`; those
scripts must import this package or call the CLI before writing GitHub-visible
content. It does not store operator denylist values in the repository and does
not attempt fuzzy identity detection. Protection is exact-match plus generated
slug variants from configured local values.

## Verification

```bash
pnpm --filter @mono-agent/repo-guard run build
pnpm --filter @mono-agent/repo-guard run typecheck
pnpm --filter @mono-agent/repo-guard run test
```
