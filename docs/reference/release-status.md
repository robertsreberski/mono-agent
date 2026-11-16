---
title: "Release status"
description: "Check the latest published npm release, its upgrade boundary, and any changes available only from source."
sidebar:
  order: 8
---

This documentation follows the current `main` source. Published packages can lag behind it; this page records the checked release boundary rather than inferring publication from source versions.

| | Version |
| --- | --- |
| Latest published npm release (registry rechecked 2026-11-16) | `create-mono-agent@0.27.1` and all 19 current `@mono-agent/*` catalog packages, published 2026-11-16 |
| Published-baseline source audit | Tag `v0.27.1` ([`3e298145`](https://github.com/robertsreberski/mono-agent/commit/3e2981459ab38b1c99648ad5543a443249b877db)); current `main` includes the unreleased changes below |
| Minimum Node.js for both | `>=24.15.0` |

## Published baseline

All 20 packages in the current release catalog have npm `latest` set to `0.27.1`. Install the CLI with `npm i -g create-mono-agent`; the installer delegates to `@mono-agent/app`.

The published release includes the owned Pi harness, renamed packages, framework contract simplification, and the Phoenix/OTLP, Supermemory, and terminal-renderer retirements. Those retirements are no longer source-only. Local memory tiers, local JSONL observability, the browser console, and bounded `runs list` / `runs show` diagnostics remain available. See the [v0.26.0 release notes](https://github.com/robertsreberski/mono-agent/releases/tag/v0.26.0) for those breaking changes and upgrade notes, and the [v0.27.1 release notes](https://github.com/robertsreberski/mono-agent/releases/tag/v0.27.1) and `CHANGELOG.md` 0.27.0 section for what 0.27.x adds. 0.27.0 was staged but never promoted to `latest`; install 0.27.1.

Browser-first onboarding and the safer console-network defaults are also in the published release:

- fresh foreground and managed consoles default to `127.0.0.1:5050`;
- foreground `web run` never manages a Tailscale Serve route;
- macOS managed `web start` / `restart` creates a mono-agent-owned route only with `--share-tailnet`, while an existing exact owned route can be re-verified; and
- bare `mono-agent web` is status/help, while `mono-agent web status --json` reports the listener and owned route separately.

:::caution[Trusted network, no application login]
Neither the 0.27.1 console nor the current source console has application login. Anyone who can reach it can operate discovered agents and complete provider sign-in. A loopback bind limits the listener, but it does not inspect or remove an existing Tailscale handler, reverse proxy, tunnel, or other route. Existing managed definitions can also preserve their configured host. Inspect `mono-agent web`, `mono-agent web status --json`, `tailscale serve status`, and any operator-managed proxies before treating a console as local-only. Widening the listener with `--host` or publishing a route with `--share-tailnet` is an explicit trust decision.
:::

## Source-only delta

Current `main` carries unreleased changes after `v0.27.1`: console usage analytics with on-demand subscription quota history, a fix for long manual compactions disconnecting before their deadline, and a reported-token-model fix for cost-only follow-ups. None of these is in published 0.27.1. See `CHANGELOG.md` `## Unreleased` for the exact list.

The previous delta is now published: the early Node-version guard, `mono-agent preflight`, the Capabilities page with its Enable actions, write-only credential fields and one-level Undo, the optional console handoff after guided `init`, and the operator API-key removal all shipped in 0.27.0 and are included in 0.27.1. The Node requirement itself remains `>=24.15.0`; the guard improves early diagnostics.

A source-built console connected to a 0.26.0 agent shows that the agent does not report capabilities. The [tutorial](/getting-started/tutorial/#run-this-tutorial-from-source) shows how to run the whole path from a source build, and the [feature tour](/getting-started/feature-tour/) marks which features the console can turn on.

The shell installer is served from the site, not npm, and installs the published CLI; its deployment does not mean the source-only changes above have shipped. See [Install & prerequisites](/getting-started/install/) for the private runtime and legacy-preflight warning.

Post-release tooling also deprecated 32 retired npm names. The registry now marks those names deprecated with migration pointers; their published versions remain installable. Deprecation does not update installed agents or migrate consumer configuration.

## Upgrade boundary: 0.25.x → 0.26.0

Upgrade the complete lockstep dependency set together. The package renames have **no compatibility aliases**: update imports, dependencies, and `channels.plugins[].package` using the [rename table in the v0.26.0 notes](https://github.com/robertsreberski/mono-agent/blob/v0.26.0/CHANGELOG.md#0260--owned-pi-harness-renamed-packages-and-core-cleanup-2026-10-20). For example, `@mono-agent/agent-app` becomes `@mono-agent/app`, `agent-harness` becomes `conversation`, `agent-runtime` becomes `turn`, and `runtime-adapter` is folded into the `turn` host subpaths. Old npm names are deprecated, not removed; installing one does not select its replacement automatically.

Direct API consumers should read the [turn migration guide](https://github.com/robertsreberski/mono-agent/blob/v0.26.0/packages/turn/MIGRATION.md). Cost totals can now be unknown (`null`): upgrade agent and web binaries together, and do not run older binaries against upgraded state. Rollback requires a pre-upgrade backup.

For consumers skipping earlier releases, read [Framework simplification migration](/reference/framework-simplification-migration/) and [Terminal renderer retirement](/observability/tui/). The retirements do not automatically choose a replacement memory backend, export Phoenix data, migrate or delete remote Supermemory data, rewrite consumer configuration, or update installed agents. Active legacy intent fails with migration guidance; inert tombstones are accepted only where the migration guide says so.

## Run a source build

The published-baseline capabilities above do not require a source build. To evaluate the unreleased changes above before the next package release, use a source build for both the agent and the console. The [unreleased-build instructions](/getting-started/install/#run-an-unreleased-build) cover the build, the exact `packages/app/dist/cli.js` entry point, and the caveats. A source build is not the published, versioned artifact that other agents pin.

## How this page is kept honest

Registry truth and source truth are checked separately:

```bash
NPM_CONFIG_USERCONFIG=/dev/null npm view create-mono-agent dist-tags engines time --json --registry https://registry.npmjs.org/
NPM_CONFIG_USERCONFIG=/dev/null npm view @mono-agent/app@0.27.1 dependencies bin --json --registry https://registry.npmjs.org/
NPM_CONFIG_USERCONFIG=/dev/null npm view @mono-agent/agent-app deprecated --registry https://registry.npmjs.org/
NPM_CONFIG_USERCONFIG=/dev/null npm view @mono-agent/tui deprecated --registry https://registry.npmjs.org/
git log --oneline v0.27.1..main
```

For this update, npm metadata for all 20 current catalog packages and all 32 retired names was read on 2026-11-16 from the public registry. Every current package reported `latest: 0.27.1`; every retired name reported a deprecation message. Release contents were checked against tag `v0.27.1` (`3e2981459ab38b1c99648ad5543a443249b877db`), its changelog, and the post-tag source log. No published tarballs were inspected for this update.

The offline documentation check keeps explicit active published-baseline references in the repository README, documentation home, and this page consistent. It deliberately does not compare them with source manifest versions and cannot prove live registry truth; a registry recheck remains required when the published baseline changes. Historical changelog/version citations are outside that consistency rule.

When a release moves the boundary, update this page together with the short release-status callouts on the [home page](/), in [Getting started](/getting-started/), in the [install guide](/getting-started/install/), and in the repository `README.md`.

## Related

- [Install & prerequisites](/getting-started/install/) — published install, source build, and updating.
- [Feature registry](/reference/feature-registry/) — the authoritative capability list this page reports release status against.
- [Always-on web console](/observability/web-console/) — the console features and security boundary named above.
