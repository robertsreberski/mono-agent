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
    "permissionMode": "default",
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

`mono-agent doctor` validates effort against the model's advertised levels and, when the configured value sits outside the advertised set, emits a warning naming the nearest supported level — while remaining permissive and forwarding the configured value. `effortRank` places `ultra` above `max` only so keyword escalation cannot downgrade an explicitly configured value.

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

### Per-turn keyword escalation

Every inbound message is scanned for effort trigger phrases, always on with no configuration:

| Phrase | Effort |
|--------|--------|
| `think` | `high` |
| `extra think` / `extrathink` | `xhigh` |
| `ultra think` / `ultrathink` | `max` |

Matching is case-insensitive on word boundaries anywhere in the message ("what do you *think*?" triggers; "thinking" and "rethink" do not), and the strongest matching phrase wins. Escalation is one-directional: the turn runs at the **higher** of the otherwise-resolved effort (configured default or a per-trigger override) and the keyword's level, so a bare `think` never lowers a `xhigh` agent and an equal-or-lower keyword changes nothing. The trigger words stay in the message text.

Escalated `max` degrades to the same per-model ceiling as configured effort: native `max` when the resolved model advertises it, otherwise `xhigh`. The escalated effort is visible in the run's `run_config` event with `overridden: true`, and only the single turn is affected — the session and configured default stay unchanged. The trigger list is exported as `EFFORT_KEYWORD_TRIGGERS` from `@mono-agent/config`.

## Permission mode

`runtime.permissionMode` is validated config with the `MONO_AGENT_PERMISSION_MODE` override. With the Pi-only runtime there are no vendor CLI processes to project permission flags onto, so the key is **validated and forwarded, never enforced**: it rides through run options and the fallback router's per-attempt policy options, and nothing inside the runtime reads it. The built-in tools do not consult it, the sandbox does not consult it, and the approval manager does not take it — `createApprovalManager` is configured by `onToolApprovalRequest`, `toolRiskTiers`, and `approvalAlwaysAllowTools` alone.

The values below therefore describe an *intent a host can implement*, not a posture mono-agent applies on its own:

| Value | Intent for a host that reads it |
|-------|---------------------------------|
| `default` | Normal posture — the host pauses tool calls that need approval for its approval callback |
| `plan` | Read-only posture used by guided/planning flows |
| `acceptEdits` | Auto-accept file edits |
| `bypassPermissions` | Remove interactive guardrails |

| Key | Values | Default | Env var |
|-----|--------|---------|---------|
| `runtime.permissionMode` | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` | `default` | `MONO_AGENT_PERMISSION_MODE` |

The enforced tool posture for Pi-executed tools comes from the [sandbox](/tools/sandbox/) filesystem scopes and the programmatic human-in-the-loop approval gates on `createMonoRuntime` (`onToolApprovalRequest`, `toolRiskTiers`, `approvalDefaultRiskTier`, `approvalTimeoutMs`, `approvalAlwaysAllowTools`), which require a host UI to answer prompts — see [programmatic approval & structured output](/programmatic/approval-and-structured-output/). For limiting *which* tools exist at all, use the tool policy in [Tools & guards](/runtime/tools-and-guards/) and [Tool policy](/tools/policy/).

:::caution
`permissionMode: "bypassPermissions"` asks a host to drop its interactive guardrails; it does not by itself loosen anything mono-agent enforces, and setting `default` does not by itself add a gate. Do not treat this key as a safety control. The enforced boundary is the [sandbox](/tools/sandbox/) filesystem scopes — `sandbox.readableRoots` / `sandbox.writableRoots` relative entries resolve against the workspace, and `.env*`, `.git/config`, and `.git/hooks/**` are denied for writes by default — together with the tool policy and the programmatic approval gates.
:::

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
| `runtime.permissionMode` | `MONO_AGENT_PERMISSION_MODE` | `default` | config |
| `runtime.maxTurns` | `MONO_AGENT_MAX_TURNS` | `0` (unlimited) | config |
| `runtime.workspace` | `MONO_AGENT_WORKSPACE` | `"."` | config |

See also: [Pi runtime & model references](/runtime/backends/) · [Providers](/runtime/providers/) · [Fallback chain](/runtime/fallback/) · [Sessions & concurrency](/runtime/sessions-concurrency/) · [Config blueprint](/config/blueprint/) · [Environment variables](/config/env-vars/).