---
title: "Operator stream endpoint"
description: "Configure the bounded local NDJSON endpoint used by the web console, ACP bridge, and jobs client."
sidebar:
  order: 8
---

The built-in operator endpoint carries bounded NDJSON turns for the
web console and other maintained operator clients. The terminal renderer and
`mono-agent tui` command are removed in the published `0.26.0` release; the protocol remains because
web, ACP, and jobs behavior depends on it.

Coverage: **config**. The compatibility identifier remains `tui` in configuration,
environment variables, discovery metadata, channel/source ids, traces, and wire
schema. It is a protocol identifier, not an available terminal product.

## Configuration

```json
{
  "tui": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 0,
    "basePath": "",
    "allowNonLoopback": false
  }
}
```

The endpoint defaults on, binds loopback, and chooses an ephemeral port. Set
`tui.enabled` to `false` to disable it. `MONO_AGENT_TUI_*` remains the supported
environment-variable family except the obsolete `MONO_AGENT_TUI_API_KEY`, which
is silently ignored along with inline `tui.apiKey` and Authorization headers.

Do not widen `host` without also setting `allowNonLoopback: true`. Non-loopback exposure is an explicit trust-boundary decision. The
endpoint preserves history, cancellation, attachment,
structured AskUser, and agent-owned cron capability behavior.

## Compatibility contract

The following names intentionally remain stable for existing clients and data:

- config keys under `tui.*` and environment keys under `MONO_AGENT_TUI_*`;
- discovery metadata at `metadata.channels.tui` and the `tui` channel/source id;
- `/gui`, `TUI_WIRE_SCHEMA`, `startTuiAdapter`, `TuiAdapter*`, and
  `TUI_CONFIG_FIELDS` in their existing public APIs;
- bounded event frames, history import, cancellation,
  attachment handling, and capability negotiation.

Serialized remote event frames remain capped at 256 KiB after UTF-8 NDJSON
encoding. Oversized assistant-thought and tool-call payload fields are reduced
and remeasured; another oversized event variant, or a minimal reducible event
that still does not fit, becomes a bounded `oversized_event` marker. This does
not imply complete artifact persistence.

For browser operation, see the [web console](/observability/web-console/). For
offline diagnostics, use `mono-agent runs list`, `mono-agent runs show <run-id>`,
and `mono-agent config`.
