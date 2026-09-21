---
title: "Release status"
description: "See which documented capabilities are in the current source but not yet in the latest published npm release, and how to run the source build instead."
sidebar:
  order: 8
---

This documentation and this repository describe the current `main` source. The published packages can lag behind it, so check this page before assuming a capability documented here is present in an npm install.

| | Version |
| --- | --- |
| Latest published npm release (registry rechecked 2026-09-21) | `create-mono-agent@0.22.0` and its lockstep `@mono-agent/*` release, published 2026-09-16 |
| Documented source revision | `main` (comparison audited at [`b8f9c081`](https://github.com/robertsreberski/mono-agent/commit/b8f9c081ddda009c1b1e61eb43c7a11d527c3e03)) |
| Minimum Node.js for both | `>=24.15.0` |

## Published baseline

An `npm i -g create-mono-agent` install currently gives you the 0.22.0 config-first CLI host, browser console, built-in message channels, memory tiers, native sandbox, local observability, console projects and tags, persistent subagents, and subscription-usage surfaces. The published release catalog contained 23 packages: 16 core packages, 6 optional plugins, and the unscoped installer alias. It still included `@mono-agent/memory-supermemory` and `@mono-agent/tui`; the current 21-package source catalog reflects later retirements and must not be projected backward onto 0.22.0.

The browser-first onboarding and safer console-network defaults also **shipped in 0.22.0**. Static inspection of the pinned published app tarball confirms:

- a custom `mono-agent init` starts with no channel, asks whether to add optional channels/memory/observability, and hands off to `mono-agent web run --loopback`; presets keep their explicitly selected channels;
- fresh foreground and managed consoles default to `127.0.0.1:5050`;
- foreground `web run` never manages a Tailscale Serve route;
- macOS managed `web start` / `restart` creates a mono-agent-owned route only with `--share-tailnet`, while an existing exact owned route can be re-verified; and
- bare `mono-agent web` is status/help, while `mono-agent web status --json` reports the listener and owned route separately.

:::caution[Trusted network, no application login]
Neither the 0.22.0 console nor the current source console has application login. Anyone who can reach it can operate discovered agents and complete provider sign-in. A loopback bind limits the listener, but it does not inspect or remove an existing Tailscale handler, reverse proxy, tunnel, or other route. Existing managed definitions can also preserve their configured host. Inspect `mono-agent web`, `mono-agent web status --json`, `tailscale serve status`, and any operator-managed proxies before treating a console as local-only. Widening the listener with `--host` or publishing a route with `--share-tailnet` is an explicit trust decision.
:::

## Source-only capability groups after 0.22.0

The current source contains the breaking simplification and retirement work below. It is not present in the published 0.22.0 tarballs.

| Capability group | Current source | Published 0.22.0 |
| --- | --- | --- |
| Framework contract simplification | Removes inert permission/recall settings, prose-triggered effort escalation, legacy flat runtime settings, process-global tool configuration, the legacy memory-write protocol, and the `mono-agent-memory-recall` compatibility binary. Direct runtime consumers use typed policy groups and explicit per-instance `ToolContext`. | Exports `configureToolRuntime`, `readToolRuntime`, `readRuntimeBrand`, and `resetToolRuntime`; the app still ships `mono-agent-memory-recall`. |
| Phoenix/OTLP retirement | Removes first-party exporter config/env/status, `mono-agent backfill`, `@mono-agent/observability/otel`, and `@mono-agent/observability/run-export`. Local JSONL recording, run history/audit/report, trace-source discovery, and provider-neutral exporter composition remain. | `@mono-agent/observability` exports `./otel` and `./run-export`, depends on OpenTelemetry packages, and the app exposes `backfill`. There is no separately published `@mono-agent/observability-phoenix@0.22.0` package to add as a migration shortcut. |
| Supermemory retirement | Removes first-party backend/config/env/setup behavior, automatic official MCP injection, and the `@mono-agent/memory-supermemory` workspace package. Generic `MemoryStore`, manually configured MCP servers, and local none/Lite/Journal/BuJo choices remain. | The 23-package release includes `@mono-agent/memory-supermemory@0.22.0` and app-owned Supermemory integration. |
| Terminal renderer retirement and offline diagnostics | Removes the first-party renderer package, `mono-agent tui`, and `mono-agent-tui`. `mono-agent runs list` and `runs show <run-id>` provide bounded, redacted, provider-free inspection; shared `tui.*` operator wire/config identifiers remain for web, ACP, jobs, and proactive delivery. | The app depends on `@mono-agent/tui@0.22.0`, and that package ships the standalone renderer binary and UI modules. `runs` supports report/audit, not the new list/show diagnostics. |

At the audited source revision above, package manifests still say `0.22.0` for lockstep development. That does **not** make the source changes part of the immutable npm release already published under that version. Source-built tarballs and release dry runs are source-candidate evidence, not registry publication evidence.

## Upgrade boundary

Do not mix current source packages with a published 0.22.0 dependency set. Keep the complete known-good version set an existing consumer already operates until its imports and configuration are ready for a future release.

The source retirements do not automatically choose a replacement memory backend, export Phoenix data, migrate or delete remote Supermemory data, rewrite consumer configuration, deprecate historical npm artifacts, or update installed agents. Active legacy intent fails with migration guidance; inert tombstones are accepted only where the migration guide says so. Read [Framework simplification migration](/reference/framework-simplification-migration/) and [Terminal renderer retirement](/observability/tui/) before evaluating an upgrade.

## Run the source build instead

If you need a source-only capability before the next release, build the workspace from a clone and run that CLI. The [unreleased-build instructions](/getting-started/install/#run-an-unreleased-build) cover the build, the exact `packages/agent-app/dist/cli.js` entry point, and the caveats. Treat a source build as an evaluation path: it is not the published, versioned artifact that other agents pin.

## How this page is kept honest

The boundary moves with every release, so registry truth and source truth are checked separately:

```bash
npm view create-mono-agent version engines time
npm view @mono-agent/agent-app@0.22.0 dependencies bin
npm pack --dry-run --json @mono-agent/agent-app@0.22.0
git log --oneline v0.22.0..main
```

For this update, registry metadata for every current catalog package plus the historical TUI package was read on 2026-09-21. Pinned 0.22.0 app, web, observability, Supermemory, TUI, and runtime tarballs were downloaded and unpacked without installing them or executing package scripts. Their manifests, compiled command/default markers, exports, binaries, and UI files were compared with tag `v0.22.0` (`2d433fa8505ceac0e21426696c476ee9a4ca792c`) and current source. The release tag's catalog contains 23 publishable packages; current source contains 21 after the two package retirements.

The offline documentation check keeps explicit active published-baseline references in the repository README, documentation home, and this page consistent. It deliberately does not compare them with source manifest versions and cannot prove live registry truth; a registry recheck remains required when the published baseline changes. Historical changelog/version citations are outside that consistency rule.

When a release moves the boundary, update this page together with the short release-status callouts on the [home page](/), in the [install guide](/getting-started/install/), and in the repository `README.md`.

## Related

- [Install & prerequisites](/getting-started/install/) — published install, source build, and updating.
- [Feature registry](/reference/feature-registry/) — the authoritative capability list this page reports release status against.
- [Always-on web console](/observability/web-console/) — the console features and security boundary named above.
