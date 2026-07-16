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
| `mono-agent recipes list \| show <id>` | `mono-agent presets list \| show <id>` | `v2.0.0` |
| `mono-agent init --recipe <id>` and `mono-agent validate --recipe <id>` | `--preset <id>` | `v2.0.0` |
| CLI flag `--fallback-models <csv>` | Repeat `--fallback <ref>` and, when needed, `--fallback-effort <level>` | `v2.0.0` |

The `--fallback-models` decision covers only the CLI CSV flag. Existing JSON
`runtime.fallbackModels` and `MONO_AGENT_FALLBACK_MODELS` remain supported
compatibility inputs; no removal version for those config forms is set here.

## Permanent compatibility

| Compatibility path | Decision and rationale |
| --- | --- |
| `LEGACY_TOOL_ALIASES` snake_case names in `tools.allowedTools` / `tools.disallowedTools` | **Retain indefinitely.** Existing hand-written policy lists cannot be migrated automatically. Removing an alias could deny a tool an old allow-list intended to enable or, more seriously, stop an old deny-list entry from matching the canonical tool and broaden access. New configs emit only PascalCase names; the aliases are accepted as input but are never registered, emitted, or recommended. |
| Managed-SRT schema-v1 install-lock reader | **Retain indefinitely.** `v0.9.0` and later write the v2 directory owner record with process incarnation identity, but a user may skip releases and encounter an owner-only v1 file left by a crashed v0.8-or-earlier installer. The legacy reader is bounded and fail-closed; new writes never use it. |
| Lifecycle-lock owner record without process incarnation | **Retain indefinitely.** `v0.9.0` and later write incarnation identity. A skipped-version upgrade can still encounter older crash debris, so the conservative PID-only liveness fallback remains as a permanent reader while every new record takes the stronger path. |

These readers and aliases are compatibility decisions, not pending removals.
Their code comments repeat the provenance and permanent-retention rationale at
the branch or map that handles the old input.
