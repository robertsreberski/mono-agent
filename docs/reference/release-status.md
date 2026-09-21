---
title: "Release status"
description: "See which documented capabilities are in the current source but not yet in the latest published npm release, and how to run the source build instead."
sidebar:
  order: 8
---

This documentation and this repository describe the current `main` source. The published packages lag behind it, so a handful of documented capabilities are **source-only** today: they exist in this repository and in a source build, but not in an install from npm.

| | Version |
| --- | --- |
| Latest published npm release (rechecked 2026-09-15) | `create-mono-agent@0.21.1` and the `@mono-agent/*` lockstep release, published 2026-09-10 |
| Documented source revision | `main` |
| Minimum Node.js for both | `>=24.15.0` |

## Published baseline

An `npm i -g create-mono-agent` install gives you the config-first CLI host, the browser console with persistent conversations, the built-in message channels, the memory tiers, the native sandbox, and local observability — everything that shipped up to 0.21.1. The [Getting Started](/getting-started/) path in these docs works on that release; the steps do not depend on source-only features.

## Source-only capability groups

The groups below are documented in this repository but are not in 0.21.1. Each one is a user-visible capability, not a packaging detail.

| Capability group | What it adds | 0.21.1 |
| --- | --- | --- |
| Console projects | Conversation containers with injected context, membership history, and console project tools | Not included |
| Conversation tags | Agent-scoped tags for filtering and grouping conversations | Not included |
| Durable subagents | Persistent subagent instances, detached background sessions, durable `AskParent` dialogue, and call-time model/effort selection | Not included |
| Subscription usage meters | Provider-reported quota meters in Agent settings, and the `ProviderUsage` tool that reports supported quotas | Not included |
| Console dashboard refresh | The dashboard layout that replaced the earlier agent rail and conversation sidebar, plus mobile and PWA refinements | Earlier layout |
| Linux service hardening | systemd session-environment attestation and published dotenv snapshots | Not included |
| Browser-first guided setup | The shorter wizard: name/Role, provider routes, an optional-capabilities gate for channels/memory (default No), tools, and sandbox, with the browser handoff instead of a terminal-first continuation | Earlier wizard; still writes the webhook smoke channel by default |
| Loopback console default | Fresh CLI console installs bind `127.0.0.1:5050`; `--host <addr>` widens explicitly | Managed installs bind `0.0.0.0:5050` |
| Explicit `--share-tailnet` | macOS managed start/restart publishes a mono-agent-owned Tailscale Serve route only on request; an existing exact owned route is re-verified, and `web status --json` reports the listener and owned route separately | Managed macOS start claims a Serve route automatically |
| Report-ready `web status --json` | Machine-readable listener/service/owned-route split | Not included |

:::note
A usage meter reports the quota a provider is willing to expose for an activated provider route. It is not a readiness check: no meter, or a missing credential, does not by itself say whether a model turn will succeed. See [Provider authentication](/observability/web-console/#provider-authentication).
:::

:::caution[Released console network defaults differ]
`create-mono-agent@0.21.1` still binds a **managed** console to `0.0.0.0:5050` and its macOS managed `start`/`restart` claims a Tailscale Serve HTTPS route automatically. The loopback fresh default, `--share-tailnet`, and `web status --json` described in these docs are source-only until the next release. On 0.21.1 the compatible local-first path is the foreground `mono-agent web run --loopback`, which never configures Serve and never removes a route that already exists — inspect `tailscale serve status` and your own proxies before treating it as local-only. A source build is required for the new flags.
:::

## Run the source build instead

If you need a source-only capability before the next release, build the workspace from a clone and run that CLI — the [unreleased-build instructions](/getting-started/install/#run-an-unreleased-build) cover the build, the aliases, and the caveats. Treat a source build as an evaluation path: it is not the published, versioned artifact that other agents pin.

## How this page is kept honest

The boundary moves with every release, so this page is updated when packages are published. The check is mechanical and repeatable:

```bash
npm view create-mono-agent version engines   # latest published version and engine range
git log --oneline v0.21.1..main              # every source change since the release tag
```

For the rows above, the published `0.21.1` tarballs were inspected for the modules and identifiers those capabilities add (console project and tag operations, provider-usage and subagent modules, and the dashboard surface) and the source commits that introduce them were confirmed to be after the `v0.21.1` tag. Tarballs were only unpacked and searched; no package script was executed.

When a release moves the boundary, update this page together with the short release-status callouts on the [home page](/), in the [install guide](/getting-started/install/), and in the repository `README.md` — they each name the currently published version or point here. A quick check for stale mentions is a repository-wide search for the previous version string.

## Related

- [Install & prerequisites](/getting-started/install/) — published install, source build, and updating.
- [Feature registry](/reference/feature-registry/) — the authoritative capability list this page reports release status against.
- [Always-on web console](/observability/web-console/) — the console features named in the table above.
