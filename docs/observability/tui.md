---
title: "Terminal UI (mono-agent tui)"
description: "Use the terminal console for structured live chat, recorded-run replay, and config inspection."
sidebar:
  order: 4
---

`mono-agent tui` is the operator console: a live chat with structured insight into the agent's thinking process — streamed reasoning, tool calls with arguments/progress/results/timing, token usage, cost, provider lifecycle and failover — plus a recorded-run replay browser and a read-only, source-annotated view of the resolved config. It normally connects to the authoritative running agent; `--local` remains an ordinary in-process chat escape hatch, never a configuration host. It ships in `@mono-agent/tui`, built on pi-tui differential rendering. Coverage: `cli` (+ the `tui` config section for remote endpoints).

## How it connects

Remote mode is a **separate process** from the agent. `mono-agent start` runs the agent in the background as usual; every running agent serves a loopback NDJSON stream endpoint (the [`tui` channel](/channels/tui/), on by default) and registers itself in the machine-wide trace-source registry (`~/.mono-agent/trace-sources`). `mono-agent tui` reads that registry from **any directory**:

- **No agents running** — prints a hint to `mono-agent start` and exits.
- **One agent running** — connects directly.
- **Several** — opens an in-TUI picker (health, pid, transports per instance).
- `--agent <label|sourceId>` — connects to a specific instance without the picker.

```bash
mono-agent tui                        # discover + connect from anywhere
mono-agent tui --agent personal-agent # pick a specific instance
mono-agent tui --conversation ops     # chat under a stable conversation id
mono-agent tui --local                # ordinary current-folder chat, no daemon
```

:::note
It requires an interactive TTY. Piped or non-interactive stdin exits with an error.

Agents whose config sets a custom `traceability.registryDir` (as `mono-agent init` scaffolds — `./.mono-agent/trace-sources`) register in **that** directory AND, by default, also mirror an identical manifest into the global `~/.mono-agent/trace-sources` registry — so `mono-agent tui` run from anywhere on the machine finds them. Set `traceability.globalDiscovery: false` to opt an agent out of the mirror (it stays visible only from its own folder, or with `--config` pointing at it). Running `mono-agent tui` from an agent's own folder additionally consults the global registry (when different), so both that agent and every other machine-wide agent show up together.
:::

Chat runs under its own `conversationId` (default `tui-<sourceId>`), so it never blocks or interleaves with Telegram/Slack/cron conversations — the harness serializes per conversation and runs different conversations concurrently. Closing the TUI mid-turn (or pressing `esc`) aborts the in-flight turn server-side.

## What you see during a turn

| Element | Content |
| --- | --- |
| Thinking cells | The model's reasoning, streamed live. Collapsed to a one-line summary by default; `ctrl+t` expands/collapses all. |
| Tool panels | One per tool call: name + argument preview while pending, a live tail of partial output as the tool runs, then the result preview and execution time (green success / red error). Confirmed consumed live guidance appears as a completed `↪️ Steered` panel with `Consumed by current run`; uncertain delivery creates no success panel. |
| Subagent panels | An `Agent` call's panel owns the tool calls its subagent makes: each child renders indented inside the parent, named by the tool alone since the parent already names the profile. Delegations that the provider overlaps therefore stay separate even though their events interleave. Pi 0.85 instead serializes an `Agent` batch whenever any stateful/mutating or MCP tool is offered because its scheduling mode applies to the whole harness. Orphaned activity (a truncated or replayed stream with no parent panel) falls back to a top-level panel keeping its `researcher▸Read` prefix rather than being dropped. |
| Answer | The assistant's reply as streamed markdown. |
| Notices | Runtime warnings and provider failover (`failover gpt-5.6-terra → kimi`) inline in the transcript. |
| Status bar | Instance label · model · live token usage (`↑input ↓output (cache …)`) · cumulative cost · provider state · hints. |

Remote event frames are capped at 256 KiB after UTF-8 NDJSON serialization, including the newline. Above that cap, assistant-thought and tool-call payload fields are reduced, marked truncated, and remeasured. Another oversized variant (including runtime warnings/telemetry), or a reducible event whose minimal form still does not fit because of metadata or invariant fields, becomes a small `oversized_event` marker. Other frame kinds do not use this cap. Replay is independently bounded: the recorder applies sensitive-key redaction, scans retained free text for high-confidence credential shapes, and caps each event string at 4,096 bytes by default. It keeps events in RAM until terminal persistence and may leave an empty event trail after a crash. A separately saved owner-private `tool-output/<runId>/` file can preserve a raw oversized tool-result block when best-effort persistence succeeds, but it is not JSONL replay, does not cover arbitrary stream events, and has no automatic cleanup owner. See [Artifacts & traces](/observability/artifacts-and-traces/).

## Views

| View | Key | Content |
| --- | --- | --- |
| chat | `f2` | The live conversation described above. |
| replay | `f3` | Recorded runs read straight from the agent's artifact dir — runs from any channel (telegram, cron, webhook, …) expand into the sensitive-key-redacted, credential-scanned, bounded events that reached their JSONL files: thinking, tools, telemetry, failover history, error detail, plus usage and cost from the summary. Payload tails capped before persistence and RAM-buffered events lost in a crash are not recoverable here. |
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

The input editor autocompletes slash commands:

- `/model [ref|default]` applies or clears a session-scoped model override. Bare
  `/model` opens the agent's advertised model list. Changing models starts one
  cold provider epoch and emits a `model_change` replay boundary. Subsequent
  turns on that model stay warm when continuous sessions are enabled.
- `/effort [level|default]` applies or clears a session-scoped effort override.
  Bare `/effort` opens options supported by the effective model.
- `/new [label]` inserts a visual break in the transcript. It does not change
  the conversation id or clear durable agent history.
- `/exit` is an alias of `/quit`: both close only this console and leave the
  background agent running.
- `/help`, `/agents`, `/replay`, `/config`, `/cancel`, and
  `/thinking` expose the remaining navigation and turn controls.

## Embedded mode (custom hosts)

The remote and ordinary local modes use the same TUI, which also runs **in-process** against any `AgentResponder`. The same rendering drives both; remote mode transports the callbacks through the NDJSON protocol and event-frame cap described above. Custom hosts can embed it programmatically:

```ts
import { startMonoAgentTui } from "@mono-agent/tui";

const handle = startMonoAgentTui({
  responder,                       // AgentResponderLike, e.g. createAgentResponder({ harness })
  title: "Local Agent",
  conversationId: "local-agent",
  config: { path: configPath, cwd, env: { ...process.env } },
});
await handle.waitUntilExit();
```

or via the low-level bin, which also supports direct URLs:

```bash
mono-agent-tui --responder ./tui-responder.mjs --config ./mono-agent.config.json
mono-agent-tui --url http://127.0.0.1:52341/gui [--api-key <key>]
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
