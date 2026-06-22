---
title: "Execution mode, effort & permissions"
sidebar:
  order: 2
---

# Execution mode, effort & permissions

This page covers the `runtime.*` knobs that shape *how* a run executes once a backend is selected: whether the model runs through an in-process SDK or a CLI subprocess, how much reasoning effort it spends, how tool permissions are posed, and how many turns a run may take. All of these are `config` coverage (set in `mono-agent.config.json`) with a matching `MONO_AGENT_*` environment override. For *which* backend each model string maps to, see [Backends](/runtime/backends/).

A representative runtime block:

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "executionMode": "sdk",
    "effort": "medium",
    "permissionMode": "default",
    "reasoningSummary": "auto",
    "maxTurns": 0,
    "workspace": "."
  }
}
```

## Execution mode

`runtime.executionMode` selects how the model is driven: `sdk` runs the provider in-process; `cli` shells out to a vendor CLI subprocess (Claude Code / Codex / OpenCode). When omitted, the mode is **inferred from the model string**: `codex:*` and `opencode:*` references default to `cli`, everything else (including `claude:*` and `pi:<provider>:<model>`) defaults to `sdk`. Set it explicitly only to override that inference.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.executionMode` | `sdk` \| `cli` | inferred (codex/opencode → `cli`, else `sdk`) | `MONO_AGENT_EXECUTION_MODE` |

Several other features key off the backend implied by execution mode — most notably `permissionMode` (CLI-only, below). When wiring a model into `memory.llm`, the same `executionMode` field applies there; see [Capture & recall](/memory/capture-and-recall/).

## Effort

`runtime.effort` is a single reasoning-effort hint that normalizes across providers. Higher effort trades latency and token cost for deeper reasoning; for pi-native backends, reasoning depth is **derived from this field**.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.effort` | `none` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `medium` | `MONO_AGENT_EFFORT` |

```json
{ "runtime": { "model": "claude:claude-sonnet-4-6", "effort": "high" } }
```

## Permission mode

`runtime.permissionMode` sets the tool-permission posture for **CLI backends only** (Claude Code / Codex / OpenCode). It mirrors the underlying CLI's permission flags and has no effect on `sdk` execution mode.

| Value | Meaning |
|-------|---------|
| `default` | Normal interactive permission prompts |
| `plan` | Planning posture — the model proposes without executing edits/commands |
| `acceptEdits` | Auto-accept file edits |
| `bypassPermissions` | Bypass permission prompts entirely |

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.permissionMode` | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` | `default` | `MONO_AGENT_PERMISSION_MODE` |

`permissionMode` is the *config-level* posture. Programmatic human-in-the-loop approval gates (risk tiers, timeout, always-allow lists) are a separate, **code-only** mechanism on `createMonoRuntime({ onToolApprovalRequest, toolRiskTiers, approvalDefaultRiskTier, approvalTimeoutMs, approvalAlwaysAllowTools })` that requires a host UI to answer prompts — see [programmatic approval & structured output](/programmatic/approval-and-structured-output/). For limiting *which* tools exist at all, use the tool policy in [Tools & guards](/runtime/tools-and-guards/) and [Tool policy](/tools/policy/).

:::caution
`permissionMode: "bypassPermissions"` removes interactive guardrails. Pair it with the [sandbox](/tools/sandbox/) filesystem scopes and a constrained [tool policy](/tools/policy/) so an unattended run cannot reach beyond its workspace.
:::

## Reasoning summary

`runtime.reasoningSummary` is **retained for back-compat and currently has no runtime effect**. The Claude/Codex CLIs emit their own reasoning summaries, and pi-native derives reasoning from `runtime.effort` — so this field is read but not wired to behavior today. Tune reasoning via `effort` instead.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.reasoningSummary` | `auto` \| `concise` \| `detailed` \| `off` \| `on` | `auto` | `MONO_AGENT_REASONING_SUMMARY` |

:::note
Setting `reasoningSummary` does nothing at runtime today. Use `runtime.effort` to control reasoning depth.
:::

## Max turns

`runtime.maxTurns` caps the number of turns a single run may take. `0` (or omitting the key) means **unlimited**; values `1`–`100` cap the run.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.maxTurns` | `0` (unlimited) \| `1`–`100` | `0` | `MONO_AGENT_MAX_TURNS` |

This value also sizes conversation history: history is capped only when turns are capped, and stays unlimited when `maxTurns` is `0` or omitted (`auto` coverage). A custom history store is available via code (`createConfiguredAgentResponder({ historyStore })`). See [Sessions & concurrency](/runtime/sessions-concurrency/).

```json
{ "runtime": { "model": "codex:gpt-5.5", "maxTurns": 12 } }
```

## Workspace

`runtime.workspace` is the working directory for runtime tools (file reads/writes, shell, etc.). Relative paths resolve against the config directory; the default is `"."`.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.workspace` | path string | `"."` | `MONO_AGENT_WORKSPACE` |

The workspace is also the default root for sandbox filesystem scopes — `sandbox.readableRoots` / `sandbox.writableRoots` relative entries resolve against it, and `.env*`, `.git/config`, and `.git/hooks/**` are denied for writes by default. See [Sandbox](/tools/sandbox/). For the on-disk layout around the workspace, see [Folder layout](/config/folder-layout/).

## Quick reference

| Key | Env var | Default | Coverage |
|-----|---------|---------|----------|
| `runtime.executionMode` | `MONO_AGENT_EXECUTION_MODE` | inferred from model | config |
| `runtime.effort` | `MONO_AGENT_EFFORT` | `medium` | config |
| `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | `default` (CLI only) | config |
| `runtime.reasoningSummary` | `MONO_AGENT_REASONING_SUMMARY` | `auto` (no effect today) | config |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | config |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `"."` | config |

See also: [Backends](/runtime/backends/) · [Fallback chain](/runtime/fallback/) · [Sessions & concurrency](/runtime/sessions-concurrency/) · [Config blueprint](/config/blueprint/) · [Environment variables](/config/env-vars/).
