---
title: "Terminal renderer retirement"
description: "Migrate from the retired mono-agent terminal renderer to the web console and offline diagnostics."
sidebar:
  order: 4
---

The first-party terminal renderer is retired in the published `0.26.0` release. The `mono-agent tui` command, `mono-agent help tui`, standalone `mono-agent-tui` binary, and `@mono-agent/tui` package are no longer active product surfaces.

Retirement does not alter already installed releases or migrate consumer folders. The historical `@mono-agent/tui` package is deprecated on npm with a pointer to `mono-agent web` from `@mono-agent/app`, but remains installable. Keep the complete known-good version set you already operate until you are ready to migrate. See [Release status](/reference/release-status/) for the registry check date and published baseline.

## Migrate

| Previous use | Maintained replacement |
| --- | --- |
| Live terminal chat and operator controls | Use [`mono-agent web run --loopback`](/observability/web-console/) for the browser console. |
| Recorded-run browsing | Use `mono-agent runs list`, then `mono-agent runs show <run-id>` for bounded offline diagnostics. |
| Resolved configuration view | Use `mono-agent config` or `mono-agent config --json`. |
| Direct `@mono-agent/tui` imports or `mono-agent-tui` embedding | Remove them and compose against the maintained package that owns the required capability; no renderer compatibility exports were relocated. |

After updating scripts and imports, run `mono-agent validate` before restarting an agent. Upgrading does not automatically change consumer files or runtime data.

## Compatibility names that remain

The `tui.*` configuration keys, `MONO_AGENT_TUI_*` environment variables, `tui` channel/source identifiers, `metadata.channels.tui`, `/gui`, and the operator adapter's public wire names remain supported compatibility contracts. They identify the maintained local operator endpoint used by the web console, ACP bridge, jobs client, and proactive delivery; they do not indicate that the terminal renderer is still available.

See the [operator stream endpoint](/channels/tui/) for its current configuration and security boundary, or the [framework simplification migration](/reference/framework-simplification-migration/) for the source-upgrade checklist.
