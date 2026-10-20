---
title: "Release status"
description: "Check the latest published npm release, its upgrade boundary, and any changes available only from source."
sidebar:
  order: 8
---

This documentation follows the current `main` source. Published packages can lag behind it; this page records the checked release boundary rather than inferring publication from source versions.

| | Version |
| --- | --- |
| Latest published npm release (registry rechecked 2026-10-20) | `create-mono-agent@0.26.0` and all 19 current `@mono-agent/*` catalog packages, published 2026-10-20 |
| Documented source revision | `main` (comparison audited at [`4f9b7650`](https://github.com/robertsreberski/mono-agent/commit/4f9b765048fc0c0f6b837bd28fd918f905f773ed)) |
| Minimum Node.js for both | `>=24.15.0` |

## Published baseline

All 20 packages in the current release catalog have npm `latest` set to `0.26.0`. Install the CLI with `npm i -g create-mono-agent`; the installer delegates to `@mono-agent/app`.

The published release includes the owned Pi harness, renamed packages, framework contract simplification, and the Phoenix/OTLP, Supermemory, and terminal-renderer retirements. Those retirements are no longer source-only. Local memory tiers, local JSONL observability, the browser console, and bounded `runs list` / `runs show` diagnostics remain available. See the [v0.26.0 release notes](https://github.com/robertsreberski/mono-agent/releases/tag/v0.26.0) for the breaking changes and complete upgrade notes.

Browser-first onboarding and the safer console-network defaults are also in the published release:

- fresh foreground and managed consoles default to `127.0.0.1:5050`;
- foreground `web run` never manages a Tailscale Serve route;
- macOS managed `web start` / `restart` creates a mono-agent-owned route only with `--share-tailnet`, while an existing exact owned route can be re-verified; and
- bare `mono-agent web` is status/help, while `mono-agent web status --json` reports the listener and owned route separately.

:::caution[Trusted network, no application login]
Neither the 0.26.0 console nor the current source console has application login. Anyone who can reach it can operate discovered agents and complete provider sign-in. A loopback bind limits the listener, but it does not inspect or remove an existing Tailscale handler, reverse proxy, tunnel, or other route. Existing managed definitions can also preserve their configured host. Inspect `mono-agent web`, `mono-agent web status --json`, `tailscale serve status`, and any operator-managed proxies before treating a console as local-only. Widening the listener with `--host` or publishing a route with `--share-tailnet` is an explicit trust decision.
:::

## Source-only delta

At the audited revision, there is no package-behavior delta after `v0.26.0`. The only post-release source change adds release tooling to deprecate 32 retired npm names. The registry now marks those names deprecated with migration pointers; their published versions remain installable. Deprecation does not update installed agents or migrate consumer configuration.

## Upgrade boundary: 0.25.x → 0.26.0

Upgrade the complete lockstep dependency set together. The package renames have **no compatibility aliases**: update imports, dependencies, and `channels.plugins[].package` using the [rename table in the v0.26.0 notes](https://github.com/robertsreberski/mono-agent/blob/v0.26.0/CHANGELOG.md#0260--owned-pi-harness-renamed-packages-and-core-cleanup-2026-10-20). For example, `@mono-agent/agent-app` becomes `@mono-agent/app`, `agent-harness` becomes `conversation`, `agent-runtime` becomes `turn`, and `runtime-adapter` is folded into the `turn` host subpaths. Old npm names are deprecated, not removed; installing one does not select its replacement automatically.

Direct API consumers should read the [turn migration guide](https://github.com/robertsreberski/mono-agent/blob/v0.26.0/packages/turn/MIGRATION.md). Cost totals can now be unknown (`null`): upgrade agent and web binaries together, and do not run older binaries against upgraded state. Rollback requires a pre-upgrade backup.

For consumers skipping earlier releases, read [Framework simplification migration](/reference/framework-simplification-migration/) and [Terminal renderer retirement](/observability/tui/). The retirements do not automatically choose a replacement memory backend, export Phoenix data, migrate or delete remote Supermemory data, rewrite consumer configuration, or update installed agents. Active legacy intent fails with migration guidance; inert tombstones are accepted only where the migration guide says so.

## Run a source build

A source build is an evaluation path for later unreleased work, not a requirement for the capabilities above. The [unreleased-build instructions](/getting-started/install/#run-an-unreleased-build) cover the build, the exact `packages/app/dist/cli.js` entry point, and the caveats. A source build is not the published, versioned artifact that other agents pin.

## How this page is kept honest

Registry truth and source truth are checked separately:

```bash
NPM_CONFIG_USERCONFIG=/dev/null npm view create-mono-agent dist-tags engines time --json --registry https://registry.npmjs.org/
NPM_CONFIG_USERCONFIG=/dev/null npm view @mono-agent/app@0.26.0 dependencies bin --json --registry https://registry.npmjs.org/
NPM_CONFIG_USERCONFIG=/dev/null npm view @mono-agent/agent-app deprecated --registry https://registry.npmjs.org/
NPM_CONFIG_USERCONFIG=/dev/null npm view @mono-agent/tui deprecated --registry https://registry.npmjs.org/
git log --oneline v0.26.0..main
```

For this update, npm metadata for all 20 current catalog packages and all 32 retired names was read on 2026-10-20 from the public registry. Every current package reported `latest: 0.26.0`; every retired name reported a deprecation message. Release contents were checked against tag `v0.26.0` (`be4e4061ac7b2372dd20bd5836b0fe882d92e111`), its changelog, and the post-tag source log. No published tarballs were inspected for this update.

The offline documentation check keeps explicit active published-baseline references in the repository README, documentation home, and this page consistent. It deliberately does not compare them with source manifest versions and cannot prove live registry truth; a registry recheck remains required when the published baseline changes. Historical changelog/version citations are outside that consistency rule.

When a release moves the boundary, update this page together with the short release-status callouts on the [home page](/), in [Getting started](/getting-started/), in the [install guide](/getting-started/install/), and in the repository `README.md`.

## Related

- [Install & prerequisites](/getting-started/install/) — published install, source build, and updating.
- [Feature registry](/reference/feature-registry/) — the authoritative capability list this page reports release status against.
- [Always-on web console](/observability/web-console/) — the console features and security boundary named above.
