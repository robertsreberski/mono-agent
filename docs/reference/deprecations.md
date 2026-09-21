---
title: "Deprecations & compatibility decisions"
description: "Track scheduled removals and intentionally permanent compatibility behavior across mono-agent releases."
sidebar:
  order: 9
---

This page is the canonical removal tracker for deprecated mono-agent surfaces.
Every scheduled removal names the first version where the old spelling stops
working. Compatibility paths retained indefinitely are recorded here too, so a
future cleanup does not mistake deliberate upgrade handling for dead code.

Recording a target here does not cut or publish that release. When a target
release is prepared, its removal PR must delete the implementation, tests, and
documentation together, then remove the completed row from this table.

## Scheduled removals

No deprecated surface currently has a scheduled removal.

## Removed surfaces

These surfaces were removed outright as part of pre-1.0 curation. CLI spellings
that still have a useful replacement fail with an explicit pointer; package and
programmatic surfaces are simply no longer exported.

| Removed surface | Replacement |
| --- | --- |
| `mono-agent restart --force` | `mono-agent restart --clear-sessions` (same effect) |
| `mono-agent metrics` | `mono-agent runs` (equivalently `mono-agent runs report`) |
| `mono-agent audit-runs` and its `--artifact-dir` flag | `mono-agent runs audit --artifacts <path>` |
| `mono-agent recipes list \| show <id>` | `mono-agent presets list \| show <id>` |
| `mono-agent init --recipe <id>` and `mono-agent validate --recipe <id>` | `--preset <id>` |
| `mono-agent sessions` (Session Recorder launcher) | `mono-agent runs list` / `mono-agent runs show` (recorded-run diagnostics) or `mono-agent web` (live console) |
| `@mono-agent/session-web`, `live.*` config/env, and the read-only live-event relay APIs | `mono-agent runs list` / `mono-agent runs show` for recorded-run diagnostics or `mono-agent web` for live conversations |
| `mono-agent tui` and `mono-agent help tui` | `mono-agent web` for live operation, `mono-agent runs list` / `mono-agent runs show` for bounded prior-run diagnostics, and `mono-agent config` for resolved configuration |
| `mono-agent-tui` and direct `@mono-agent/tui` imports | Remove the renderer integration and compose against the maintained package that owns the required capability; no compatibility exports were relocated |
| CLI flag `--fallback-models <csv>` | Repeat `--fallback <ref>` and, when needed, `--fallback-effort <level>` |
| `memory-bujo` standalone CLI bin | `mono-agent memory <subcommand>` from the agent folder |
| Runtime compatibility exports `./ai/backend.js`, `./ai/registry.js`, `findProviderForModel`, `listProviders`, and backend capability/provider constants | `resolveRuntimeBridge` and `listRuntimeBridges` |
| Memory helpers `reflect`, `ReflectDeps`, `ReflectResult`, and no-op `applyDecay` | Supported capture, consolidate, reconcile, and store APIs |
| First-party Phoenix/OTLP package, `observability.exporters`, `MONO_AGENT_OBSERVABILITY_EXPORTERS`, `mono-agent backfill`, exporter status/probing, and `@mono-agent/observability/run-export` | Bounded local JSONL artifacts, `mono-agent runs` / `runs audit` / `runs report`, trace-source discovery, and provider-neutral `RunExporter` composition. Perform any final legacy export before upgrading with the complete working version set already in use. |

First-party Phoenix/OTLP support is removed without an automatic replacement.
Active legacy JSON/env values fail with fixed secret-safe guidance; absent, blank,
and structurally empty tombstones are accepted only to avoid breaking consumers
that had already disabled export. The upgrade does not export, rewrite, convert,
or delete local artifacts and does not delete remote traces. The public registry
does not provide a separately published Phoenix plugin, so retain only a complete
currently working version set already in use when a final pre-upgrade export is
required.

The three run/lifecycle compatibility spellings were removed in v0.14.0 after
their scheduled sunset. `--force` on `install-skill` and `web reset` is a
separate, non-deprecated flag.

The Session Recorder package, its read-only event relay, and the `live.*`
configuration/env surface were removed together after repository-wide
reachability checks found no supported caller. Unknown `live` config now fails
strict validation instead of being ignored. `MONO_AGENT_WEB_AUTH_TOKEN` is no
longer read by any code; its only reader was the removed `sessions` command.

The terminal-renderer removal is current unreleased source truth. It does not
change already installed releases, migrate consumer folders, or deprecate or
remove the historical package from npm. Version `0.22.0` still contains the
renderer. Direct package/bin consumers must keep a complete known-good version
set until they remove that integration. The `tui.*`, `MONO_AGENT_TUI_*`,
`metadata.channels.tui`, channel/source id, `/gui`, and public operator wire
names remain maintained compatibility contracts for web, ACP, and jobs clients.

`runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` were **retired** in
0.21.0 and are now rejected at load with the replacement named; the CLI CSV flag
`--fallback-models` was already removed. Convert the JSON key by hand to
`runtime.fallbacks: [{ "model": "..." }]`; the load error names that replacement.
A value that lives solely in `MONO_AGENT_FALLBACK_MODELS` (or a `.env` file) is
not covered by any config edit and has to be removed by hand and re-expressed as
`MONO_AGENT_FALLBACKS_JSON`; the load error for the variable names *that* repair,
not the JSON key, because an operator whose chain lives only in `.env` has no
`runtime.fallbackModels` key to rewrite. The retired
recipe → preset mapping is recorded as static documentation in
[Presets & capability modules](/reference/presets/#deprecations). The
`memory-bujo` bin entry and its error-deflector were removed; use
`mono-agent memory <subcommand>` instead.

Every retired environment variable (`MONO_AGENT_EXECUTION_MODE`,
`MONO_AGENT_ROUTE_SAFETY`, `MONO_AGENT_FALLBACK_MODELS`,
`memory.llm.executionMode`) fails config load when it carries a
value, naming the exact repair in environment terms. All of them that are set are
reported in a single load, not one per run. An empty assignment (`KEY=`) is still
treated as unset — an inert leftover line in a deployed `.env` does not break
startup.

Retired JSON keys behave the same way: a config carrying several of them reports
all of them in one message. The load still stops at the first failing *class*
(retired JSON keys, then unknown JSON keys, then retired environment variables,
then model references, then the remaining shape checks), so a migration is
usually a few `mono-agent validate` passes rather than one.

A rejected model reference names its concrete replacement in the message
`doctor`, `mono-agent validate`, `mono-agent config` and the startup error all
print — for example `` runtime.model `codex:gpt-5.6-terra` is not a valid
runtime model reference: codex is no longer a runtime backend; use
openai-codex:gpt-5.6-terra ``. See
[the runtime migration guide](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-runtime/MIGRATION.md)
for the full per-agent checklist.

## Permanent compatibility

| Compatibility path | Decision and rationale |
| --- | --- |
| `LEGACY_TOOL_ALIASES` snake_case names in `tools.allowedTools` / `tools.disallowedTools` | **Retain indefinitely.** Existing hand-written policy lists cannot be migrated automatically. Removing an alias could deny a tool an old allow-list intended to enable or, more seriously, stop an old deny-list entry from matching the canonical tool and broaden access. New configs emit only PascalCase names; the aliases are accepted as input but are never registered, emitted, or recommended. |
| Managed-SRT schema-v1 install-lock reader | **Retain indefinitely.** `v0.9.0` and later write the v2 directory owner record with process incarnation identity, but a user may skip releases and encounter an owner-only v1 file left by a crashed v0.8-or-earlier installer. The legacy reader is bounded and fail-closed; new writes never use it. |
| Lifecycle-lock owner record without process incarnation | **Retain indefinitely.** `v0.9.0` and later write incarnation identity. A skipped-version upgrade can still encounter older crash debris, so the conservative PID-only liveness fallback remains as a permanent reader while every new record takes the stronger path. |

These readers and aliases are compatibility decisions, not pending removals.
Their code comments repeat the provenance and permanent-retention rationale at
the branch or map that handles the old input.
