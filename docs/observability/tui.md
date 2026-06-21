---
title: "Terminal UI (mono-agent-tui)"
parent: "Observability & CLI"
nav_order: 4
---

# Terminal UI (mono-agent-tui)

`mono-agent-tui` is an interactive terminal chat for an agent: a scrollable transcript, a per-message history pane, and a read-only, redacted view of the resolved `mono-agent.config.json`. It ships in the `@mono-agent/tui` package and is an interactive **developer** surface — it does not boot a long-running host or service. Coverage: `cli`.

## What it is (and isn't)

The TUI is an Ink-based React console *adapter*. It renders chat and config, but it does not start a harness on its own — it drives an `AgentResponderLike` that you (or a host's demo bin) supply. Use it to talk to an agent, watch streamed output, and confirm the configuration the agent actually resolved (env overrides vs. JSON vs. defaults), all without leaving the terminal.

It requires an interactive TTY. Piped or non-interactive stdin exits with an error.
{: .note }

For an always-on, observable agent (channels, cron, Phoenix traces) you run the host via the `mono-agent` CLI instead — see [CLI Reference](cli-reference.md) and the [Phoenix-observed agent playbook](../playbooks/phoenix-observed-agent.md). The TUI is the quick, local, eyes-on companion to those.

## Basic usage

The binary needs a responder module and reads the same `mono-agent.config.json` as your app. The config path enables the Config pane and is forwarded to your responder factory.

```bash
mono-agent-tui \
  --responder ./tui-responder.mjs \
  --config ./mono-agent.config.json
```

`--config` alone does not boot an agent: the TUI never constructs a harness, so a `--responder` module is always required.
{: .warning }

The responder module must either default-export an `AgentResponderLike` (an object with a `respond` method) or export a `createResponder(env, cwd, configPath)` factory that returns one. Wiring a responder backed by your harness is code-only — see [Programmatic Composition](../programmatic/composition.md) for `createAgentResponder({ harness })`, which is the intended backing for `createResponder`.

### CLI flags

| Flag | Required | Default | Description |
| --- | --- | --- | --- |
| `--responder <file>` | yes | — | Path to an ESM module exporting a responder (default export) or `createResponder(env, cwd, configPath)`. |
| `--config <path>` | no | — | Path to `mono-agent.config.json`. Enables the Config pane and is forwarded to `createResponder()`. |
| `--conversation <id>` | no | `tui-local` | Conversation id passed to the responder. |
| `--title <text>` | no | `Agent` | Header title text. |
| `-h`, `--help` | no | — | Print usage and exit. |

Unknown arguments, a missing responder file, or a non-TTY stdin all exit with a non-zero status and the usage text.

## Panes

The TUI has up to three panes. The Config pane only appears when `--config` is supplied.

| Pane | Shows |
| --- | --- |
| Chat | The live conversation; your input line streams the responder's reply token-by-token. |
| History | One entry per message; open a message for detail or remove it. |
| Config | A compact, redacted summary of the resolved config, grouped into `runtime`, `context`, `memory`, `tools`, and `artifacts`. |

### The Config pane

The Config pane is **read-only**. It renders the redacted config so secrets (API keys, tokens) are never displayed, and it tags each field with where the value came from — `env`, `json`, or `default` — so you can see at a glance which `MONO_AGENT_*` override is in effect. Editing happens in `mono-agent.config.json`; press `r` to reload it from disk, and changes take effect on the next host restart.

The source tags map to these environment overrides (a non-empty value of the env var wins over JSON, which wins over the built-in default):

| Pane field | Env var |
| --- | --- |
| runtime · model | `MONO_AGENT_MODEL` |
| runtime · executionMode | `MONO_AGENT_EXECUTION_MODE` |
| runtime · effort | `MONO_AGENT_EFFORT` |
| runtime · maxTurns | `MONO_AGENT_MAX_TURNS` |
| runtime · workspace | `MONO_AGENT_WORKSPACE` |
| context · identityPath | `MONO_AGENT_IDENTITY_PATH` |
| context · soulPath | `MONO_AGENT_SOUL_PATH` |
| context · skillsRoot | `MONO_AGENT_SKILLS_ROOT` |
| context · selectedSkills | `MONO_AGENT_SELECTED_SKILLS` |
| memory · path | `MONO_AGENT_MEMORY_PATH` |
| memory · maxBytes | `MONO_AGENT_MEMORY_MAX_BYTES` |
| memory · writeMode | `MONO_AGENT_MEMORY_WRITE_MODE` |
| tools · allowedTools | `MONO_AGENT_ALLOWED_TOOLS` |
| tools · disallowedTools | `MONO_AGENT_DISALLOWED_TOOLS` |
| tools · mcpConfigPath | `MONO_AGENT_MCP_CONFIG_PATH` |
| artifacts · dir | `MONO_AGENT_ARTIFACT_DIR` |

The same config keys are documented in [Config Blueprint](../config/blueprint.md) and the full env-var list in [Environment Variables](../config/env-vars.md). The redaction model is shared with [Artifacts & Traces](artifacts-and-traces.md).

A matching `mono-agent.config.json` that the pane would summarize:

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "executionMode": "sdk",
    "effort": "medium",
    "workspace": "./workspace"
  },
  "context": {
    "identityPath": "./identity.md",
    "skillsRoot": "./skills"
  },
  "memory": {
    "path": "./memory/agent.sqlite",
    "writeMode": "capture"
  },
  "tools": {
    "allowedTools": ["Read", "Grep"]
  },
  "artifacts": {
    "dir": "./.artifacts"
  }
}
```

## Keyboard navigation

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | Cycle panes (works from any pane). |
| `1` / `2` / `3` | Jump to chat / history / config (tab off the chat pane first). |
| `enter` | Submit message (chat) · open detail (history). |
| `esc` | Cancel an in-flight response · close detail. |
| `backspace` / `del` | Remove the highlighted history message. |
| `r` | Reload config from disk (config pane). |
| `?` | Toggle the help overlay. |
| `ctrl+c` | Stop and exit. |

The numeric `1`/`2`/`3` shortcuts are intercepted by the chat pane's text input, so press `tab` to leave the chat pane before using them. `tab` always cycles. Press `?` at any time for the in-app help overlay.
{: .tip }

## Related

- [CLI Reference](cli-reference.md) — the `mono-agent` host CLI (`init`, `validate`, `start`, `restart`).
- [Phoenix-observed agent playbook](../playbooks/phoenix-observed-agent.md) — run an agent with tracing once you have moved past local TUI iteration.
- [Programmatic Composition](../programmatic/composition.md) — build the `AgentResponderLike` the TUI drives via `createAgentResponder`.
- [Config Blueprint](../config/blueprint.md) and [Environment Variables](../config/env-vars.md) — the keys and overrides the Config pane reflects.
