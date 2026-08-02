---
title: "Worklab ACP bridge"
description: "Discover running mono-agent instances and import them into Worklab without transferring agent configuration, credentials, tools, or workspace ownership."
sidebar:
  order: 5
---

The ACP bridge lets Worklab run a task through an existing local mono-agent while the agent remains the authority for its model, effort, instructions, memory, tools, MCP servers, sandbox, credentials, and workspace. Worklab owns task orchestration, the user-authored prompt, status projection, and cancellation; it does not reconstruct or override the agent.

This is an **ACP v1 core-session profile for Worklab and mono-agent**, not an unqualified general ACP v1 Agent. It supports initialization, new sessions, prompts, streamed updates, cancellation, text, and resource-link input. Client-supplied MCP servers are intentionally unsupported even though stdio MCP is part of the general ACP v1 Agent baseline.

## Discover importable agents

Use the installed CLI as the process boundary:

```bash
mono-agent bridge acp --discover
```

The command prints one JSON line and nothing else on stdout. It calls the same public `discoverAcpBridgeAgents()` function exported by `@mono-agent/web`, so library and CLI consumers receive the same contract:

```json
{
  "schema": "mono-agent.acp-discovery.v1",
  "bridgeVersion": 1,
  "protocolVersion": 1,
  "sources": [
    {
      "schema": "mono-agent.acp-source.v1",
      "bridgeVersion": 1,
      "protocolVersion": 1,
      "installedVersion": "0.18.0",
      "sourceId": "personal-agent",
      "label": "Personal Agent",
      "health": "running",
      "compatible": true,
      "workspace": { "path": "/absolute/canonical/workspace", "owner": "agent" },
      "ownership": {
        "configuration": "agent",
        "workspace": "agent",
        "mcp": "agent"
      },
      "constraints": {
        "promptContent": ["text", "resource_link"],
        "clientMcp": false,
        "clientFilesystem": false,
        "clientTerminal": false,
        "attachments": false,
        "additionalDirectories": false
      },
      "warnings": []
    }
  ]
}
```

The discovery result deliberately omits the operator URL, API key, config path, config contents, dotenv path, credentials, and MCP definitions. `installedVersion` is for operator display and diagnostics. Import only a `running` source with `compatible: true`, `bridgeVersion: 1`, and `protocolVersion: 1`; do not infer compatibility from the package version string.

An older running process that has not published bridge metadata appears as incompatible with `bridgeVersion: 0` and `installedVersion: "unknown"`. Restart that agent under a release containing this bridge before importing it. A future unsupported bridge version is also incompatible rather than guessed compatible.

Programmatic discovery is equivalent:

```ts
import { discoverAcpBridgeAgents } from "@mono-agent/web";

const discovery = await discoverAcpBridgeAgents();
const source = discovery.sources.find((entry) => entry.compatible && entry.health === "running");
```

## Start the selected bridge

Spawn the installed executable directly, without a shell:

```bash
mono-agent bridge acp --source-id personal-agent
```

Stdout is UTF-8 newline-delimited ACP JSON-RPC only. Keep stderr separate and bounded for diagnostics. The bridge resolves the exact trace-source id, requires a running compatible source and trusted loopback operator endpoint, and exits nonzero before the protocol loop when preflight fails.

Use this Worklab handshake:

1. Send `initialize` with ACP protocol version `1`, ordinary `clientInfo`, and only capabilities Worklab implements. Add `clientCapabilities.elicitation.form: {}` when Worklab can render and answer form elicitation. Do not advertise client filesystem or terminal capabilities.
2. Read the optional `_meta["mono-agent"]` source descriptor. It is the same sanitized descriptor shape returned by discovery and is useful for detecting source drift after the child starts.
3. Send `session/new` with `cwd` exactly equal to the descriptor's canonical workspace path, `mcpServers: []`, and no additional directories.
4. Send text and resource-link prompt blocks, consume typed `session/update` notifications, and preserve opaque session, message, and tool-call ids.
5. On task cancellation, send `session/cancel`, continue draining protocol messages, and wait for the prompt response or child exit.

The bridge advertises neither `loadSession` nor `sessionCapabilities.resume`. A session id is accepted only when this live bridge connection created it; a syntactically valid invented id is rejected. Worklab should persist its own task transcript and create a fresh ACP session after reconnecting.

## Ownership boundary

| Surface | Owner | Bridge behavior |
| --- | --- | --- |
| Task, goal, prompt, scheduling, status, cancellation | Worklab | Sent through ACP without changing agent configuration. |
| Model, effort, instructions, memory, tools | mono-agent | Resolved by the selected running agent; no ACP config options are advertised. |
| Workspace and sandbox | mono-agent | `session/new.cwd` must canonical-match the discovered workspace; client filesystem, terminal, and additional roots are rejected. |
| MCP servers and credentials | mono-agent | Worklab sends `mcpServers: []`; injected client MCP and credential transfer are rejected. |
| Conversation execution | mono-agent | The ACP session id maps directly to the operator conversation id for the life of the bridge. |

Do not copy mono-agent config into Worklab, parse config files to reconstruct behavior, or surface an override UI for model, effort, tools, MCP, sandbox, or workspace. The descriptor flags are the contract.

## Prompt and update mapping

Text blocks retain their order and are joined as one user turn. ACP `resource_link` blocks are rendered into an explicit user-context section containing the resource name, URI, title, description, MIME type, and size when present. Image, audio, embedded-resource, and attachment input are rejected because the profile does not advertise them.

The bridge streams:

- assistant text as `agent_message_chunk`;
- non-empty status and reasoning as `agent_thought_chunk`;
- tool start/progress/result as `tool_call` and partial `tool_call_update` notifications;
- cumulative token context plus USD cost, when supplied by the runtime, as stable `usage_update` notifications.

Fields omitted by a partial tool update mean “unchanged”; Worklab must not clear previously received fields. Treat message and tool-call ids as opaque strings.

## AskUser through form elicitation

When both sides advertise support, a mono-agent `AskUser` tool call becomes an ACP `elicitation/create` request scoped to the session and tool call. The requested schema contains one required choice field per remaining question plus an optional paired **Other response** text field. Worklab should render the schema generically and return the selected values unchanged:

- `accept` submits all answers atomically to the existing mono-agent run;
- `decline` cancels the run and returns prompt stop reason `refusal`;
- `cancel` cancels the run and returns prompt stop reason `cancelled`.

The bridge rejects unknown options, duplicate selections, missing required choices, custom text without **Other**, **Other** without custom text, stale interactions, and malformed client responses. Form elicitation never collects likely secrets; a potentially sensitive question fails with `sensitive_elicitation_unsupported` instead of presenting a form.

If Worklab does not advertise `elicitation.form`, the bridge cancels the blocked mono-agent run and returns an `interaction_required` error. Worklab should show that error as a task requiring operator attention; it must not invent an answer or report success.

## Optional request tool environment

`--require-tool-environment` is an explicit compatibility gate for callers that need the existing bounded request-tool environment. Startup fails if the selected operator does not advertise that capability. Even when enabled, the bridge forwards only its fixed allowlist and at most the first absolute `PATH` entry; it never forwards the whole process environment. Ordinary Worklab imports should omit this flag unless their task runner deliberately depends on that contract.
