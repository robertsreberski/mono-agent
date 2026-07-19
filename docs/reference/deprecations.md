---
title: "Deprecations & compatibility decisions"
sidebar:
  order: 7
---

# Deprecations & compatibility decisions

This page is the canonical removal tracker for deprecated mono-agent surfaces.
Every scheduled removal names the first version where the old spelling stops
working. Compatibility paths retained indefinitely are recorded here too, so a
future cleanup does not mistake deliberate upgrade handling for dead code.

Recording a target here does not cut or publish that release. When a target
release is prepared, its removal PR must delete the implementation, tests, and
documentation together, then remove the completed row from this table.

## Scheduled removals

| Deprecated surface | Replacement | Removal version |
| --- | --- | --- |
| `mono-agent restart --force` | `mono-agent restart --clear-sessions` (same effect) | `v2.0.0` |
| `mono-agent metrics` | `mono-agent runs` (equivalently `mono-agent runs report`) | `v2.0.0` |
| `mono-agent audit-runs` | `mono-agent runs audit` | `v2.0.0` |

`restart --force` is still accepted and behaves identically to
`--clear-sessions` (clear persisted pi sessions + active conversation history),
but every invocation prints a deprecation hint. `--force` on `install-skill` and
`web reset` is a separate, non-deprecated flag.

`metrics` and `audit-runs` are the pre-consolidation spellings of the merged
[`runs`](/observability/cli-reference/#runs) command. Both still parse and
forward unchanged — `metrics` to `runs report`, `audit-runs` to `runs audit`,
carrying every existing flag — while printing a one-line sunset hint. The
canonical `runs` spelling takes `--artifacts` as the artifact-directory flag;
the legacy `audit-runs --artifact-dir` alias keeps parsing but no longer appears
in `--help`.

## Removed surfaces

These surfaces were removed outright (a pre-1.0 curation). The old spelling now
errors with a pointer to its replacement instead of mapping forward.

| Removed surface | Replacement |
| --- | --- |
| `mono-agent recipes list \| show <id>` | `mono-agent presets list \| show <id>` |
| `mono-agent init --recipe <id>` and `mono-agent validate --recipe <id>` | `--preset <id>` |
| `mono-agent sessions` (Session Recorder launcher) | `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console) |
| CLI flag `--fallback-models <csv>` | Repeat `--fallback <ref>` and, when needed, `--fallback-effort <level>` |
| `memory-bujo` standalone CLI bin | `mono-agent memory <subcommand>` from the agent folder |

The `mono-agent sessions` removal covers only the CLI launcher. Running it now
errors with a `mono-agent tui` / `mono-agent web` pointer. The
`@mono-agent/session-web` package, the `live` event relay (`live.*` config), and
`MONO_AGENT_WEB_AUTH_TOKEN` still ship in code; they are simply no longer
reachable through any CLI command, and their full retirement is a separate later
dead-code-audited change.

The `--fallback-models` removal covers only the CLI CSV flag. Existing JSON
`runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain supported
compatibility inputs; those config forms are unaffected. The retired
recipe → preset mapping is recorded as static documentation in
[Presets & capability modules](/reference/presets/#deprecations). The
`memory-bujo` bin entry still ships this release, but it is an error-deflector
that exits non-zero on every invocation; use `mono-agent memory <subcommand>`
instead.

## Permanent compatibility

| Compatibility path | Decision and rationale |
| --- | --- |
| `LEGACY_TOOL_ALIASES` snake_case names in `tools.allowedTools` / `tools.disallowedTools` | **Retain indefinitely.** Existing hand-written policy lists cannot be migrated automatically. Removing an alias could deny a tool an old allow-list intended to enable or, more seriously, stop an old deny-list entry from matching the canonical tool and broaden access. New configs emit only PascalCase names; the aliases are accepted as input but are never registered, emitted, or recommended. |
| Managed-SRT schema-v1 install-lock reader | **Retain indefinitely.** `v0.9.0` and later write the v2 directory owner record with process incarnation identity, but a user may skip releases and encounter an owner-only v1 file left by a crashed v0.8-or-earlier installer. The legacy reader is bounded and fail-closed; new writes never use it. |
| Lifecycle-lock owner record without process incarnation | **Retain indefinitely.** `v0.9.0` and later write incarnation identity. A skipped-version upgrade can still encounter older crash debris, so the conservative PID-only liveness fallback remains as a permanent reader while every new record takes the stronger path. |

These readers and aliases are compatibility decisions, not pending removals.
Their code comments repeat the provenance and permanent-retention rationale at
the branch or map that handles the old input.
