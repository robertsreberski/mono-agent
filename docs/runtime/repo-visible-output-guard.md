---
title: "Repo-visible output guard"
sidebar:
  order: 7
---

# Repo-visible output guard

Agent-generated GitHub content is repo-visible metadata. Treat downstream agent
instance names, local paths, usernames, host/workspace names, provider account
labels, and secrets as PII by default when generating issue or pull request
titles, bodies, comments, reviews, branch names, and task metadata.

The shared guard lives in `@mono-agent/repo-guard`. Dogfood planner,
implementer, reviewer, and coordinator scripts should run
`guardRepoVisiblePayload` immediately before every GitHub write and after any
branch/task metadata is generated.

## Local denylist

Keep exact local strings in ignored local config. The default file is:

```text
.mono-agent/repo-visible-denylist.jsonl
```

`.mono-agent/` is ignored by git, so operator-specific values stay local. Use
JSONL entries with labels; labels are what scan output prints.

```json
{"label":"operator-name","value":"Example Operator"}
{"label":"agent-alpha","value":"local-agent-alpha"}
{"label":"workspace","value":"/Users/example/sentinel-workspace"}
{"label":"provider-account","value":"provider-account-alpha"}
```

You can also point at another local file:

```bash
MONO_AGENT_REPO_VISIBLE_DENYLIST_FILE=.mono-agent/repo-visible-denylist.jsonl
```

For tests and smoke checks, `MONO_AGENT_REPO_VISIBLE_DENYLIST` accepts a JSON
array:

```bash
MONO_AGENT_REPO_VISIBLE_DENYLIST='[{"label":"agent-alpha","value":"local-agent-alpha"}]'
```

Configured values are matched exactly. The guard also derives common generated
variants, including lowercase, slug, underscore, and path-basename forms, so a
display value can still block branch names such as `local-agent-alpha`.

## Programmatic guard

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
    title: "Add guardrails",
    body: "Ready for review.",
    branchName,
    task: { metadata: { owner: "repo-safe" } },
  },
  { denylist, surface: "github_pr" },
);
```

If a configured value is present, `guardRepoVisiblePayload` throws a typed error
with the surface, field path, and local denylist label. It does not include the
matched raw string in findings.

## Maintainer scan

Run the local tracked-file audit:

```bash
mono-agent repo-guard scan
```

Include untracked files:

```bash
mono-agent repo-guard scan --include-untracked
```

Scan GitHub metadata through `gh`:

```bash
mono-agent repo-guard scan --github --repo owner/name
```

The GitHub scan reads issue/PR titles and bodies, PR branch refs, comments,
pull request review bodies, and inline review comments. It is read-only.
Findings include the surface, identifier, field path, and denylist label, never
the raw matched value. The command exits nonzero when findings exist.

## Boundaries

This is a local exact-match guard, not automatic identity inference. Add every
operator-specific display value and important generated form to the denylist.
Do not paste real findings into PR descriptions, issue comments, or committed
before/after tables; use labels and field paths only.
