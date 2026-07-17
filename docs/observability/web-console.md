---
title: "Always-on web console"
sidebar:
  order: 5
---

# Always-on web console

`mono-agent web` is the browser operator console for every running agent discovered on this computer. It is a separate `@mono-agent/web` application built on assistant-ui's External Store Runtime and native Thread, ThreadList, Message, Composer, Attachment, GroupedParts, and ToolFallback primitives, with the assistant-ui Reasoning disclosure adapted for structured runtime parts. The service owns conversations and in-flight turns, so refreshing or closing a browser tab does not abort work.

This is the chat-first companion to [`mono-agent tui`](/observability/tui/). The previous read-only run browser remains available as [`mono-agent sessions`](#session-recorder-moved-to-sessions).

## Start it once

On macOS, install and start the managed service:

```bash
mono-agent web start
mono-agent web
```

Bare `mono-agent web` is read-only: it prints service status, the usable URLs, and lifecycle help. It does not start, stop, or rewrite the service. The default listener is `0.0.0.0:5050`, so the same process is directly reachable from localhost, the trusted local network, and the machine's Tailscale address.

```bash
mono-agent web start       # install/start the managed service
mono-agent web stop
mono-agent web restart
mono-agent web status
mono-agent web logs
mono-agent web run         # foreground service, including non-macOS hosts
```

Use `--loopback` with `start` or `run` to bind `127.0.0.1` instead. Advanced `--host` and `--port` overrides are available when `0.0.0.0:5050` is not appropriate. The lifecycle status records the effective bind and any owned Tailscale route so later commands operate on the same service rather than guessing.

## Security boundary: trusted network, no login

The console intentionally has no application authentication or multi-user accounts. Anyone who can reach its HTTP listener can read retained conversations, upload files, cancel turns, and send instructions to every discovered agent. Treat the listener as an owner-equivalent operator surface:

- run it only on a trusted LAN or tailnet;
- use `--loopback` when other devices must not reach it;
- do not publish port `5050` through a public router, tunnel, or unrestricted reverse proxy;
- keep operating-system and Tailscale network admission controls as the access boundary.

The server rejects unexpected Host/Origin combinations and does not enable cross-origin API access, but those checks are browser request-integrity controls, not authentication. Plain LAN HTTP is not encrypted. Tailscale transport protects direct tailnet traffic, while Tailscale Serve provides browser-trusted HTTPS when available.

At startup, mono-agent inspects the existing Tailscale Serve configuration. It prefers HTTPS `:443` only when free; otherwise it chooses the first free port in `8443`–`8499`. It never resets or replaces another Serve handler. Ownership is recorded locally, and `web stop` removes only the route this console created. If the first route cannot be created, the local/LAN service stays healthy and status prints the direct URLs plus remediation. If a restart cannot migrate an existing owned route to a changed app port, mono-agent restores the prior worker and exact route and exits nonzero.

## Agents, threads, and turns

The left rail lists auto-discovered trace sources and their current health. On desktop, drag its right-edge resize handle to widen the rail and reveal full agent names. The handle is also a focusable keyboard separator: arrow keys resize incrementally, while Home and End select its minimum and maximum widths. The chosen width is a browser-local presentation preference, so a phone, laptop, and different browser profiles can keep different layouts.

Use the star beside an agent to add or remove it from favorites. The same pin control is available in the mobile agent picker. Pin state is persisted in the web service's SQLite settings rather than in browser storage, so favorites stay consistent when the same console is opened through localhost, a LAN address, or Tailscale. Pinned agents sort first; the remaining agents retain the normal discovery ordering.

Selecting an agent filters its conversations; each conversation is permanently bound to that source id so a label change or a different agent cannot inherit its history. An offline agent and its threads remain visible, but sending is disabled until that exact source returns.

Threads use the first prompt as their initial title and can be renamed. They are archived rather than individually deleted, and archived threads can be restored. The console permits one active turn per thread while different threads and agents can run concurrently.

The service, not the browser tab, owns the upstream operator connection. A browser disconnect or reload can therefore reconnect through the event stream while the turn continues. If the web service itself restarts, any turn that was still active is marked interrupted instead of being shown as permanently running.

During a turn the transcript shows streamed markdown, reasoning, tool calls and results, user-facing errors, and the final outcome. Raw runtime, provider, and usage telemetry remains internal; measured token and cost data appears only through the context control. The composer exposes the selected agent's available model and effort controls. Copy, cancel, archive, and unarchive are supported; edit/regenerate/branch/steer and browser-defined client tools are deliberately not enabled.

## Run controls and context

The run-settings control uses a searchable model picker with the selected model's supported reasoning-effort choices in the same popover. On narrow screens it becomes a full-width bottom sheet so every effort level remains reachable without overflowing the viewport. Choosing **Automatic model** or **Automatic** effort delegates that setting to the agent.

When the selected agent advertises a model context window and turns report token usage, the context control accumulates the conversation's newest per-turn snapshots and shows the percentage directly in the header plus the exact token breakdown and progress bar in its popover. Repeated cumulative snapshots within one turn are counted once. If the runtime cannot establish a trustworthy context-window size, the console shows the measured token counts without inventing a percentage.

Assistant reasoning is grouped into a disclosure that opens while that reasoning is actively streaming and collapses when it completes; adjacent tool calls and the final answer retain their original order. Type `/` in an empty composer to open the keyboard-friendly command popover for available actions such as run settings, starting a new conversation, or stopping an active response.

## Attachments use the browser device picker

The attachment button opens the native file picker on the device running the browser. It does not expose or browse the web-service host's filesystem.

Web uploads use the same transport-neutral `AgentAttachment` contract and harness path as Telegram:

- the same MIME allowlist;
- a 20 MiB per-file default limit;
- the same image versus document classification;
- UTF-8 decoding for supported text files;
- the same owner-private harness attachment persistence and model-facing attachment description.

A web turn additionally permits at most 10 files and 64 MiB in aggregate. Attachment-only turns are valid. The browser streams bytes to a staged upload with progress; it does not retain base64 copies in React state. Removing an unattached upload removes its stage, and abandoned stages are purged after 24 hours. Committed attachments remain with their conversation, including after archival.

Telegram's optional audio transcription is adapter-specific and is not reused here. Browser-selected audio and video retain their ordinary attachment MIME and document classification unless a future transport-neutral capability changes that contract.

Older running agents that do not advertise attachment support remain usable for text chat, but the upload control is disabled for them rather than sending a request they cannot interpret.

## Local state and reset

The service keeps its owner-private SQLite store, settings, upload stages, and logs under `~/.mono-agent/web/`. Stored messages, attachment metadata, revisions, run state, and pinned agents are local to this computer; they are independent from browser storage and from the agents' provider-side sessions. The desktop agent-rail width is the exception: it is an intentionally browser-local display preference and is removed when that browser's site data is cleared.

There is no per-message or per-thread destructive delete. To intentionally erase the whole console store, stop the service and use the explicit two-part confirmation:

```bash
mono-agent web reset --all --yes
```

Reset removes the web console's conversations, committed uploads, staged uploads, and server settings, including agent pins. It does not clear browser-local display preferences such as the rail width, and it does not remove an agent's config, durable conversation history, memory, or recorded run artifacts.

## Current scope

The first web-console release covers discovery, persistent multi-conversation chat, model/effort selection, streamed reasoning and tools, internal telemetry-backed context usage, cancellation, and attachments. It is responsive down to narrow phone widths and installable as a PWA when served from a secure browser context.

Recorded-run replay, source-annotated config inspection, and managed conversational configuration remain in the TUI and Session Recorder for now. Use:

```bash
mono-agent tui
mono-agent tui --configure
mono-agent sessions
```

## Session Recorder moved to `sessions`

`@mono-agent/session-web` remains the read-only Session Recorder. Its command moved from `mono-agent web` to `mono-agent sessions` without changing its flags, authentication behavior, artifact paging, or live-relay aggregation:

```bash
mono-agent sessions
mono-agent sessions --port 4599 --no-open
mono-agent sessions --host 0.0.0.0 --allow-non-loopback
mono-agent sessions --include-memory
mono-agent sessions --max-runs 500
```

The recorder retains `MONO_AGENT_WEB_AUTH_TOKEN` for compatibility. That variable belongs to the legacy recorder only; it does not add a login to the new always-on web console.

## Related

- [CLI command reference](/observability/cli-reference/#web) — lifecycle and flags.
- [Terminal UI](/observability/tui/) — replay, config view, and managed configuration.
- [TUI stream endpoint](/channels/tui/) — the default-on agent endpoint used for web chat.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how web threads map to harness conversations and provider sessions.
