# @worklab-ai/tui

## Responsibility

Terminal operator surface built with Ink. It provides local chat, in-memory transcript display, cancellation handling, and a redacted read-only core config pane for hosts that want a terminal console.

## Install / Usage

```bash
pnpm --filter @worklab-ai/tui run build
mono-agent-tui --help
```

```ts
import { startTui } from "@worklab-ai/tui";
```

Hosts supply a structural responder compatible with the adapter responder contracts and decide how config files are loaded.

## Public API

- `startTui`
- TUI app/component types and message-stream helpers
- Structural `AgentResponder` and cancellation helpers
- Read-only config summary helpers
- Bin: `mono-agent-tui`

## Dependency Boundary

The TUI depends on React/Ink and `@worklab-ai/config` for core config summaries. It remains a terminal operator surface, not a communication adapter, runtime host, or settings editor.

## What This Package Does Not Own

It does not poll Telegram/WhatsApp, edit config inline, persist transcripts, call model runtimes directly, or own adapter-specific settings.

## Verification

```bash
pnpm --filter @worklab-ai/tui run build
pnpm --filter @worklab-ai/tui run typecheck
pnpm --filter @worklab-ai/tui run test
```
