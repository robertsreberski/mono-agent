# @worklab-ai/tui

Ink-based React TUI console for Mono Agent: chat with an agent, browse the
in-memory transcript, and view a redacted snapshot of the active
`mono-agent.config.json` — without taking a hard dependency on the harness,
the runtime adapter, or any other communication adapter.

This package is a leaf-ish communication adapter, parallel to
`@worklab-ai/telegram-bridge`. It only knows about a structural
`AgentResponderLike` contract (matching the shape exported by
`createAgentResponder({ harness })` from `@worklab-ai/agent-harness`) and the
read-only config helpers from `@worklab-ai/config`.

## Install

```bash
pnpm add @worklab-ai/tui
```

Runtime peers: `react ^19.2`, `ink ^7`, `ink-text-input ^6`, `ink-spinner ^5`.
Tested against Node ≥ 20.

## Usage

### Programmatic

```ts
import { startMonoAgentTui } from "@worklab-ai/tui";
import { createAgentResponder } from "@worklab-ai/agent-harness";
import { myHarness } from "./my-harness.js";

const responder = createAgentResponder({ harness: myHarness });

const handle = startMonoAgentTui({
  responder,
  title: "My Agent",
  config: {
    path: "./mono-agent.config.json",
    env: { ...process.env },
  },
});

await handle.waitUntilExit();
```

`<TuiApp />` is exported for hosts that already manage Ink themselves.

### CLI

```bash
mono-agent-tui --responder ./responder.mjs --config ./mono-agent.config.json
```

The bin requires `--responder` to be explicit. The TUI does not boot a
harness on its own — the responder module either default-exports an
`AgentResponderLike` or exports `createResponder(env, cwd, configPath)`.

## Layout

```
┌── Mono Agent ──────────────────────────────────────────────────────┐
│ chat / history / config (active pane underlined)                   │
├────────────────────────────────────────────────────────────────────┤
│ pane content                                                       │
├────────────────────────────────────────────────────────────────────┤
│ status: switched to history · tab next · ? help · ctrl+c quit      │
└────────────────────────────────────────────────────────────────────┘
```

### Chat

- Streams responder output through `TuiInkMessageStream` (debounced delta
  flush, default 30 ms).
- `enter` submits, `esc` aborts the in-flight `AbortController` and records
  a `cancelled` assistant turn carrying whatever streamed so far.
- Responder rejection that is **not** a cancel (`TuiAgentCancelledError` or a
  duck-typed `AgentResponderCancelledError` from `@worklab-ai/telegram-bridge`)
  becomes an `error` assistant turn with a visible error block.

### History

- Up/down arrow moves selection, `enter` opens a detail card with the full
  body and metadata (e.g. `runtime.model`, `runtime.sdk`, `runtime.durationMs`
  when the responder attached them).
- `backspace` / `del` removes the highlighted message; the empty state
  returns once the list drains.

### Config (optional)

- Read-only summary built from `readMonoAgentConfigJson` +
  `loadMonoAgentConfigWithSources` + `redactMonoAgentConfig`. Each row is
  tagged `[env]`, `[json]`, or `[default]` based on which layer supplied
  the value.
- `r` reloads from disk.
- The Telegram bot token is rendered as `redacted` and the chat-id list as
  a count — the raw token never reaches the rendered frame (covered by a
  unit test asserting the secret string is absent from `lastFrame()`).
- **No inline editing in v1.** Edits go through `mono-agent-config-ui`
  where the loopback bridge enforces the same registered-field validator
  and atomic writes.

## Hotkeys

| keys              | action                                                |
| ----------------- | ----------------------------------------------------- |
| `tab` / `shift+tab` | cycle panes                                         |
| `1` / `2` / `3`   | jump to chat / history / config                       |
| `enter`           | submit message · open history detail                  |
| `esc`             | cancel in-flight response · close detail / overlay    |
| `backspace` / `del` | remove highlighted history message                  |
| `r`               | reload config from disk (config pane)                 |
| `?`               | toggle help overlay                                   |
| `ctrl+c`          | stop and exit                                         |

## Architecture notes

- **No harness/runtime dependency.** The TUI declares the same structural
  agent contract as `@worklab-ai/telegram-bridge`. Hosts wire a harness on
  top — the dependency direction stays leaf-ish.
- **React 19 + Ink 7.** Ink 7 ships `react >=19.2` as a peer; this lets the
  TUI share React 19 with `@worklab-ai/config-ui` rather than fragmenting on
  a React major.
- **Debounced streaming.** Token-by-token responders that call `append()` in
  a tight loop won't churn the React reconciler; deltas batch into one
  state emission per debounce window.
- **TTY-aware boot.** `startMonoAgentTui` refuses to mount when stdin is a
  non-TTY (unless the host injects an alternative stdin, as the test
  harness does). It does not silently fall back to a fake mode.

## What this package does NOT do (v1)

- Multi-conversation switcher (single conversation per session).
- File attachments / images.
- Persistent transcripts across restarts (the in-memory store is the
  default; hosts can implement `TuiHistoryStore` for persistence).
- Inline config editing — edits go through `@worklab-ai/config-ui`.
- A bundled `demos/<name>/` runnable demo wiring TUI ↔ harness; that's a
  follow-up that adds `--tui` to `demos/final-agent`.
