---
title: "Terminal UI (mono-agent tui)"
sidebar:
  order: 4
---

# Terminal UI (mono-agent tui)

`mono-agent tui` is the operator console for running agents: a live chat with **full insight into the agent's thinking process** — streamed reasoning, tool calls with arguments/progress/results/timing, token usage, cost, provider lifecycle and failover — plus a recorded-run replay browser and a read-only, source-annotated view of the resolved config. It ships in `@mono-agent/tui`, built on pi-tui differential rendering. Coverage: `cli` (+ the `tui` config section for the endpoint it connects to).

## How it connects

The TUI is a **separate process** from the agent. `mono-agent start` runs the agent in the background as usual; every running agent serves a loopback NDJSON stream endpoint (the [`tui` channel](/channels/tui/), on by default) and registers itself in the machine-wide trace-source registry (`~/.mono-agent/trace-sources`). `mono-agent tui` reads that registry from **any directory**:

- **No agents running** — prints a hint to `mono-agent start` and exits.
- **One agent running** — connects directly.
- **Several** — opens an in-TUI picker (health, pid, transports per instance).
- `--agent <label|sourceId>` — connects to a specific instance without the picker.

```bash
mono-agent tui                        # discover + connect from anywhere
mono-agent tui --agent personal-agent # pick a specific instance
mono-agent tui --conversation ops     # chat under a stable conversation id
```

:::note
It requires an interactive TTY. Piped or non-interactive stdin exits with an error.

Agents whose config sets a custom `traceability.registryDir` (as `mono-agent init` scaffolds — `./.mono-agent/trace-sources`) register in **that** directory instead of the global one. Run `mono-agent tui` from the agent's folder (or with `--config` pointing at its config) so the local registry is resolved, or remove the override to make the agent globally discoverable.
:::

Chat runs under its own `conversationId` (default `tui-<sourceId>`), so it never blocks or interleaves with Telegram/Slack/cron conversations — the harness serializes per conversation and runs different conversations concurrently. Closing the TUI mid-turn (or pressing `esc`) aborts the in-flight turn server-side.

## What you see during a turn

| Element | Content |
| --- | --- |
| Thinking cells | The model's reasoning, streamed live. Collapsed to a one-line summary by default; `ctrl+t` expands/collapses all. |
| Tool panels | One per tool call: name + argument preview while pending, a live tail of partial output as the tool runs, then the result preview and execution time (green success / red error). |
| Answer | The assistant's reply as streamed markdown. |
| Notices | Runtime warnings and provider failover (`failover gpt-5.5 → kimi`) inline in the transcript. |
| Status bar | Instance label · model · live token usage (`↑input ↓output (cache …)`) · cumulative cost · provider state · hints. |

Oversized tool payloads are truncated on the wire (marked in the panel); the full data is always in the run's [JSONL artifacts](/observability/artifacts-and-traces/) and visible in the replay view.

## Views

| View | Key | Content |
| --- | --- | --- |
| chat | `f2` | The live conversation described above. |
| replay | `f3` | Recorded runs read straight from the agent's artifact dir — every turn from **every** channel (telegram, cron, webhook, …), each expandable into its full coalesced event timeline: thinking, tools, telemetry, failover history, error detail, usage and cost from the run summary. |
| config | `f4` | Redacted, source-annotated resolved config — the same builder as `mono-agent config`, each field tagged `env`/`json`/`default`. Read-only; `r` reloads. The env layer shown is your shell's, not the agent process's (the pane says so). |
| agents | `f5` | The running-instance picker; `r` refreshes, `enter` connects. |

## Keyboard & slash commands

| Key | Action |
| --- | --- |
| `f2`–`f5` | Jump to chat / replay / config / agents. |
| `tab` / `shift+tab` | Cycle views (`tab` belongs to the editor's autocomplete inside chat). |
| `esc` | Cancel the in-flight turn (chat) · back out of a replay detail · return to chat. |
| `ctrl+t` | Expand/collapse thinking cells. |
| `enter` | Submit message · open selection. |
| `ctrl+c` twice | Quit. |

The input editor autocompletes slash commands: `/help`, `/agents`, `/replay`, `/config`, `/cancel`, `/thinking`, `/quit`.

## Embedded mode (custom hosts)

The remote mode above is the primary surface, but the TUI still runs **in-process** against any `AgentResponder` — the same rendering drives both, because the wire protocol replays the exact stream callbacks. Hosts embed it programmatically (see `demos/downloads-curator`):

```ts
import { startMonoAgentTui } from "@mono-agent/tui";

const handle = startMonoAgentTui({
  responder,                       // AgentResponderLike, e.g. createAgentResponder({ harness })
  title: "Downloads Curator",
  conversationId: "downloads-curator",
  config: { path: configPath, cwd, env: { ...process.env } },
});
await handle.waitUntilExit();
```

or via the low-level bin, which also supports direct URLs:

```bash
mono-agent-tui --responder ./tui-responder.mjs --config ./mono-agent.config.json
mono-agent-tui --url http://127.0.0.1:52341/tui [--api-key <key>]
mono-agent-tui                        # discovery mode, like `mono-agent tui`
```

`--responder` modules default-export an `AgentResponderLike` or export `createResponder(env, cwd, configPath)` — see [Programmatic Composition](/programmatic/composition/).

### `mono-agent-tui` flags

| Flag | Description |
| --- | --- |
| `--responder <file>` | In-process mode: ESM module exporting a responder. Mutually exclusive with `--url`. |
| `--url <baseUrl>` | Remote mode: a running agent's `tui` endpoint. |
| `--api-key <key>` | Bearer key for `--url` when the agent sets `tui.apiKey`. |
| `--registry-dir <dir>` | Discovery registry override (default `~/.mono-agent/trace-sources`). |
| `--config <path>` | Enables the config view; forwarded to `createResponder()`. |
| `--conversation <id>` | Conversation id (default `tui-local`). |
| `--title <text>` | Header title. |

## Related

- [TUI channel](/channels/tui/) — the endpoint inside each agent this console connects to (`tui` config section, on by default).
- [CLI Reference](/observability/cli-reference/) — the `mono-agent` host CLI, including `mono-agent tui`.
- [Artifacts & Traces](/observability/artifacts-and-traces/) — the recorded runs the replay view reads.
- [Programmatic Composition](/programmatic/composition/) — building responders for embedded mode.
