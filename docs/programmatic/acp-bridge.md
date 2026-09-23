---
title: "ACP bridge"
description: "Expose a running mono-agent to ACP clients such as acpx without transferring agent configuration, credentials, tools, or workspace ownership."
sidebar:
  order: 5
---

The ACP bridge lets a standard ACP client run tasks through an existing local mono-agent while the agent remains the authority for its model, effort, instructions, memory, tools, MCP servers, sandbox, credentials, and workspace. The client owns orchestration, the user-authored prompt, status projection, and cancellation; it does not reconstruct or override the agent.

This is an **ACP v1 core-session profile for mono-agent**, not an unqualified general ACP v1 Agent. It supports initialization, new and resumed sessions, prompts, streamed updates, cancellation, text, and resource-link input. Client-supplied MCP servers are intentionally unsupported even though stdio MCP is part of the general ACP v1 Agent baseline.

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
      "installedVersion": "0.19.1",
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

Use this handshake:

1. Send `initialize` with ACP protocol version `1` and ordinary `clientInfo`. The bridge accepts standard client filesystem and terminal capability advertisements but never calls them: filesystem and command execution remain inside the selected mono-agent's configured tools and sandbox. Add `clientCapabilities.elicitation.form: {}` when the client can render and answer form elicitation.
2. Read the optional `_meta["mono-agent"]` source descriptor. It is the same sanitized descriptor shape returned by discovery and is useful for detecting source drift after the child starts.
3. Send `session/new` with the client's absolute `cwd`, `mcpServers: []`, and no additional directories. The requested `cwd` is advisory: the bridge always uses the mono-agent workspace returned in `_meta["mono-agent"].workspace`.
4. Send text and resource-link prompt blocks, consume typed `session/update` notifications, and preserve opaque session, message, and tool-call ids.
5. Persist the returned session id. After reconnecting or replacing the bridge process, send `session/resume` with that exact id, an advisory absolute `cwd`, `mcpServers: []`, and no additional directories.
6. On task cancellation, send `session/cancel`, continue draining protocol messages, and wait for the prompt response or child exit.

The bridge advertises `sessionCapabilities.resume` but not `loadSession`. Resume continues the exact mono-agent conversation without replaying history to the ACP client. A session id is accepted only when its owner-only authorization record belongs to the exact source and workspace; invented, corrupt, cross-source, pre-upgrade, and reset ids are rejected.

## Call configured local peers from another mono-agent

`PeerAgent` is an app-owned tool, separate from subagent profiles and from
`acpx`. Configure a named local peer and explicitly allow the tool:

```json
{
  "peers": { "finance": { "sourceId": "finance-ai" } },
  "tools": { "allowedTools": ["Read", "PeerAgent"] }
}
```

The tool lists only configured, running, bridge-compatible sources and rechecks
before dispatch. The caller must also have a unique running local trace-source
registration matching its artifacts directory; otherwise provenance cannot be
attested and the send is refused. `PeerAgent({action:"send",peer:"finance",thread:"portfolio",
message:"Summarize the latest allocation"})` waits for a bounded, labelled
**untrusted** answer. A later send on the same caller conversation, peer and
thread resumes the exact ACP session, including after restarting either agent;
it never automatically replays a prompt interrupted by a restart. If the peer
cleared its ACP session, or its bounded single-use generation ledger reaches
1024 sends, the current send fails explicitly (`unknown_session_id` or
`peer_session_exhausted`) without dispatch; the old session mapping is removed
and only the next explicitly requested send starts a fresh session. A concurrent send to a parked thread names its pending `questionId` and asks
you to answer, decline, or stop, without leaking a state-directory path. `PeerAgent({action:"stop",peer:"finance",
thread:"portfolio"})` requests ACP `session/cancel` for the active turn.

With a wake-capable caller origin and enabled process jobs, `background:true`
returns a durable started job receipt and wakes **that exact originating
conversation** at terminal settlement. ACP-served turns have no background
wake origin: they can call further peers in the foreground only. The verified
handoff carries depth and the signed, bounded source chain across ACP. A send
to a source already in that chain (including itself) fails immediately rather
than queuing behind a foreground turn on that source. The chain-depth ceiling
still applies. If the peer calls `AskUser`, the caller receives an untrusted
bounded ACP form with a one-time `questionId`. Foreground `send` returns
`awaiting_answer` immediately while the same ACP run remains parked. Use
`PeerAgent({action:"answer",peer:"finance",thread:"portfolio",questionId,
answers:{question_1:"yes"}})` with the **ACP form field keys and option IDs**;
the bridge still validates all choices, required fields, and paired Other text.
Use `action:"decline"` with `questionId` to refuse rather than invent an answer.
Answer from the caller's own evidence or ask the caller's own user; the peer's
question is not its owner's approval. Subsequent peer answers or questions
continue on the same run. Sensitive questions fail before a form is offered.
A parked form has a 30-minute default deadline, with its advertised `expiresAt`
clamped to the original ACP turn deadline when that is sooner. Question text
and form data are UTF-8 bounded; background projections redact the question
using the process-job output redaction path. Expiry, decline, stop, cancellation
of a continuation job or its foreground answer, or either side restarting
interrupts the turn; late answers fail, and only a new explicit `send` resumes
the thread without replaying the interrupted prompt. For background sends the first job
settles with a typed `peerQuestion` in its projection and an exact-origin
question wake; answering admits a **new continuation process job** bound to the
original wake origin. That job wakes again with the final answer, failure, or
next question. The first job's `peerQuestion.state` is durably updated to
`answered`, `expired`, or `interrupted` as the parked question settles; no
additional expiry wake is emitted. Neither the parked ACP prompt nor an answer
is replayed after restart; the owner-private thread record and its original
question job card recover as interrupted on the next request (where the job
still exists). A damaged owner-only peer thread is skipped
with a generic warning, never allowed to break unrelated agent turns. Process
exit closes the ACP child transport; an embedded host that disposes its harness
without exiting has no factory-level peer-disposal hook yet, so a parked relay
remains bounded by the 30-minute turn deadline (or an explicit `stop`).

Peer-specific bounded ACP `_meta` carries a source-bound, owner-private HMAC
handoff. The proof binds target source, session, caller conversation, turn
generation, message digest and depth. The bridge validates and durably consumes
each generation once before dispatch; replay fails closed, while exhaustion
returns a distinct recoverable error without replay. Consumed ledgers are
pruned when the bridge detects that their ACP session authorization is gone;
short bounded lock contention between bridges does not immediately fail a
valid distinct generation. It replaces the client proof with a domain-separated operator
attestation (no raw `proof` in operator metadata); the runtime independently
verifies before rendering an explicit Session notice that this is a request
from another agent, not the owner's approval, and before using depth.
Ordinary clients, including `acpx`, need no handoff and retain their existing
behavior. Metadata and peer prompt text do not grant authority or owner
approval. Verifying an invalid handoff never creates a secret. Peer state
never starts a synthetic sandbox: private peer roots are added only when
process-job protection is **already active** on that turn. Otherwise owner-only
file permissions protect the state, without changing ordinary turns or blocking
an unsandboxed target. An unsandboxed agent whose tools can read its own or the
peer's handoff secret falls outside this provenance boundary, as does a
malicious same-UID process with local secret access. Attribution remains
advisory, never authority.

## Use through acpx

A mono-agent source is an ACP agent identity, not a model. Keep model and effort selection in `mono-agent.config.json`; route the source through an ordinary acpx agent alias:

```json
{
  "agents": {
    "mono-personal": {
      "argv": ["mono-agent", "bridge", "acp", "--source-id", "personal-agent"]
    }
  },
  "mcpServers": []
}
```

The alias then behaves like any other acpx agent:

```bash
acpx mono-personal sessions new
acpx mono-personal "continue the task"
```

The source id in `argv` is part of the stable agent command identity acpx uses for its session state. No mono-agent-specific acpx adapter or model convention is required.

## Ownership boundary

| Surface | Owner | Bridge behavior |
| --- | --- | --- |
| Task, goal, prompt, scheduling, status, cancellation | ACP client | Sent through ACP without changing agent configuration. |
| Model, effort, instructions, memory, tools | mono-agent | Resolved by the selected running agent; no ACP config options are advertised. |
| Workspace and sandbox | mono-agent | The requested `cwd` is advisory; the discovered workspace is authoritative. Client filesystem and terminal callbacks are unused, and additional roots are rejected. |
| MCP servers and credentials | mono-agent | The client sends `mcpServers: []`; injected client MCP and credential transfer are rejected. |
| Conversation execution | mono-agent | The durable ACP session id maps directly to the operator conversation id across bridge and source restarts. |

Do not copy mono-agent config into the client, parse config files to reconstruct behavior, or surface an override UI for model, effort, tools, MCP, sandbox, or workspace. The descriptor flags are the contract.

## Prompt and update mapping

Text blocks retain their order and are joined as one user turn. ACP `resource_link` blocks are rendered into an explicit user-context section containing the resource name, URI, title, description, MIME type, and size when present. Image, audio, embedded-resource, and attachment input are rejected because the profile does not advertise them.

The bridge streams:

- assistant text as `agent_message_chunk`;
- non-empty status and reasoning as `agent_thought_chunk`;
- tool start/progress/result as `tool_call` and partial `tool_call_update` notifications;
- cumulative token context plus USD cost, when supplied by the runtime, as stable `usage_update` notifications.

Fields omitted by a partial tool update mean “unchanged”; clients must not clear previously received fields. Treat message and tool-call ids as opaque strings.

## AskUser through form elicitation

When both sides advertise support, a mono-agent `AskUser` tool call becomes an ACP `elicitation/create` request scoped to the session and tool call. The requested schema contains one required choice field per remaining question plus an optional paired **Other response** text field. The client should render the schema generically and return the selected values unchanged:

- `accept` submits all answers atomically to the existing mono-agent run;
- `decline` cancels the run and returns prompt stop reason `refusal`;
- `cancel` cancels the run and returns prompt stop reason `cancelled`.

The bridge rejects unknown options, duplicate selections, missing required choices, custom text without **Other**, **Other** without custom text, stale interactions, and malformed client responses. Form elicitation never collects likely secrets; a potentially sensitive question fails with `sensitive_elicitation_unsupported` instead of presenting a form.

If the client does not advertise `elicitation.form`, the bridge cancels the blocked mono-agent run and returns an `interaction_required` error. The client should show that error as a task requiring operator attention; it must not invent an answer or report success.

## Durable session authorization and reset

Each successful `session/new` writes a bounded `mono-agent.acp-session.v1` authorization record under owner-only `acp-sessions/` beside `history/` and `artifacts/`. Filenames are hashes of the opaque session ids; records bind the id to one source id and canonical workspace. Publication is atomic, and `session/new` does not return until the record is durable.

`session/resume` and every prompt verify that record before using the session id as the mono-agent conversation id. Existing conversation history remains in the normal history store; the authorization record grants no access to a different source or workspace and contains no credentials, prompt text, or model configuration. Sessions created by bridge versions that predate this registry are intentionally not auto-migrated.

`mono-agent restart --clear-sessions` removes provider transcripts, active conversation history, and ACP session authorizations. Those ids cannot be resumed after reset. Durable memory and recorded run artifacts remain untouched.

## Optional request tool environment

`--require-tool-environment` is an explicit compatibility gate for callers that need the existing bounded request-tool environment. Startup fails if the selected operator does not advertise that capability. Even when enabled, the bridge forwards only its fixed allowlist and at most the first absolute `PATH` entry; it never forwards the whole process environment. Ordinary ACP clients should omit this flag unless their task runner deliberately depends on that contract.
