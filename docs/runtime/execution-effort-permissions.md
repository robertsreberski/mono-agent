---
title: "Effort & permissions"
description: "Configure reasoning effort, keyword escalation, permission posture, turn limits, and workspace scope."
sidebar:
  order: 2
---

This page covers the `runtime.*` knobs that shape *how* a run executes once a provider is selected: how much reasoning effort it spends, how tool permissions are posed, and how many turns a run may take. All of these are `config` coverage (set in `mono-agent.config.json`) with a matching `MONO_AGENT_*` environment override. For *which* provider each model string maps to, see [Pi runtime & model references](/runtime/backends/).

A representative runtime block:

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "effort": "medium",
    "maxTurns": 0,
    "workspace": "."
  }
}
```

## Effort

`runtime.effort` is the primary route's reasoning-effort hint. Canonical `runtime.fallbacks[]` entries have independent optional effort; omission means that route's provider default rather than inheritance from the primary. Higher effort trades latency and token cost for deeper reasoning. The wizard offers only the effort values advertised for the selected model plus **Provider default**.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.effort` | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `ultra` | provider/model default when omitted | `MONO_AGENT_EFFORT` |

The Pi runtime maps the configured value onto the resolved model's capabilities:

- A model without reasoning (or `reasoning_mode: none`) always runs with the off thinking level.
- `none`, then, is a no-op there; on a reasoning-capable model `none` forces thinking off.
- Passthrough levels `minimal`/`medium`/`high`/`xhigh` map one-to-one.
- `max` passes through only when the resolved model explicitly advertises `max` as a reasoning level; otherwise it degrades to the Pi `xhigh` ceiling so an advertised-but-unsupported level never escalates silently.
- `ultra` is not a Pi reasoning level and resolves to `low`.

`mono-agent doctor` validates effort against the model's advertised levels and, when the configured value sits outside the advertised set, emits a warning naming the nearest supported level — while remaining permissive and forwarding the configured value.

```json
{ "runtime": { "model": "openai-codex:gpt-5.6-terra", "effort": "high" } }
```

```json
{
  "runtime": {
    "model": "openai-codex:gpt-5.6-terra",
    "effort": "high",
    "fallbacks": [
      { "model": "openai-codex:gpt-5.6-sol", "effort": "xhigh" },
      { "model": "ollama:gemma4:31b" }
    ]
  }
}
```

### Explicit effort selection

Per-turn effort comes from validated request metadata or the configured runtime default. Message prose does not change it: words such as `think`, `extra think`, and `ultra think` remain ordinary user text. Provider-supported effort ceilings still apply.

## Permission controls

`runtime.permissionMode` and `MONO_AGENT_PERMISSION_MODE` have been removed. The Pi runtime did not enforce them. Remove these settings when upgrading; validation reports an actionable migration error.

The enforced tool posture comes from the [sandbox](/tools/sandbox/), [tool policy](/tools/policy/), and programmatic approval gates on `createMonoRuntime`: `onToolApprovalRequest`, `toolRiskTiers`, `approvalDefaultRiskTier`, `approvalTimeoutMs`, and `approvalAlwaysAllowTools`. See [programmatic approval and structured output](/programmatic/approval-and-structured-output/) and the [framework migration guide](/reference/framework-simplification-migration/).

## Max turns

`runtime.maxTurns` caps the number of turns a single run may take. `0` (or omitting the key) means **unlimited**; values `1`–`100` cap turns. The Pi runtime counts turn completions and stops the loop once the cap is reached, surfacing the limit as `max_turns_hit` on the run result.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.maxTurns` | `0` (unlimited) \| `1`–`100` | `0` | `MONO_AGENT_MAX_TURNS` |

This value does not size conversation history. The configured app uses an owner-only, disk-backed 64-message history window for each exact conversation id regardless of whether `maxTurns` is positive, `0`, or omitted (`auto` coverage). Aggregate defaults are 256 MiB, 10,000 conversations, and 365 days of inactivity; publication is atomic and retention runs only after commit. A custom history store is available via code (`createConfiguredAgentResponder({ historyStore })`). See [Sessions & concurrency](/runtime/sessions-concurrency/).

```json
{ "runtime": { "model": "openai-codex:gpt-5.6-terra", "maxTurns": 12 } }
```

## Workspace

`runtime.workspace` is the working directory for runtime tools (file reads/writes, shell, etc.). Relative paths resolve against the config directory; the default is `"."`.
The directory must exist before startup so mono-agent can attest its filesystem boundary without trusting a path that may later become a symlink. Guided `mono-agent init` creates its configured `.mono-agent/workspace/`; when writing config by hand, create the selected directory first.

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.workspace` | path string | `"."` | `MONO_AGENT_WORKSPACE` |

The workspace is also the default root for sandbox filesystem scopes — `sandbox.readableRoots` / `sandbox.writableRoots` relative entries resolve against it, and `.env*`, `.git/config`, and `.git/hooks/**` are denied for writes by default. See [Sandbox](/tools/sandbox/). For the on-disk layout around the workspace, see [Folder layout](/config/folder-layout/).

## Quick reference

| Key | Env var | Default | Coverage |
|-----|---------|---------|----------|
| `runtime.effort` | `MONO_AGENT_EFFORT` | unset (provider/model default) | config |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | config |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `"."` | config |

See also: [Pi runtime & model references](/runtime/backends/) · [Providers](/runtime/providers/) · [Fallback chain](/runtime/fallback/) · [Sessions & concurrency](/runtime/sessions-concurrency/) · [Config blueprint](/config/blueprint/) · [Environment variables](/config/env-vars/).
