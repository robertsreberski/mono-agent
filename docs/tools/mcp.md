---
title: "MCP servers"
description: "Attach external Model Context Protocol servers and understand their configuration and policy boundary."
sidebar:
  order: 2
---

This page covers how mono-agent attaches [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers to your agent through `tools.mcpConfigPath`, how the path is resolved and forwarded to the runtime, and the one rule that surprises people: **external MCP-server tools are not gated by `tools.allowedTools`**. App-owned MCP tools can define a narrower policy boundary; `RunHistory`, `SessionHistory`, `SetConversationTitle`, and the adapter send tools do. Coverage type: `config`.

## What `tools.mcpConfigPath` does

Point `tools.mcpConfigPath` at an `mcp.json` file describing one or more MCP servers (stdio, SSE, or streamable HTTP). The agent gains every tool those servers advertise.

```json
{
  "tools": {
    "allowedTools": ["Read", "Grep"],
    "disallowedTools": ["Bash"],
    "mcpConfigPath": "./mcp.json"
  }
}
```

| Key | Type | Notes |
| --- | --- | --- |
| `tools.mcpConfigPath` | string | Path to an `mcp.json`. Resolved against the workspace, not the config file. |
| `tools.mcpRequestContextServers` | string[] | Opt-in stdio server names that receive trusted per-run producing-conversation, run-id, output-directory, current-request attachment, and scoped progress context. HTTP/SSE and unlisted servers are unchanged. |
| `tools.continuationServers` | string[] | Opt-in stdio or loopback-HTTP server names that receive a host-bound claim capability for durable asynchronous results. Remote HTTP, SSE, and unlisted servers fail closed or remain unchanged. |
| `tools.allowedTools` | string[] | Allowlist for **built-in** runtime tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Exec`, `Bash`, `NodeRepl`, `WebFetch`, `WebSearch`) and policy-gated app-owned tools such as `RunHistory`, `SessionHistory`, `SetConversationTitle`, and adapter send tools. Omit (or `["*"]`) for allow-all; a specific list narrows to those names. Does not affect external MCP-server tools. |
| `tools.disallowedTools` | string[] | Denylist; deny always wins, even under allow-all. Filters built-ins, `ReadSkill`, `RunHistory`, `SessionHistory`, `SetConversationTitle`, and adapter send tools. On the pi-native runtime it does **not** filter external MCP-server tools (see below). |

Environment overrides: `MONO_AGENT_MCP_CONFIG_PATH` sets `tools.mcpConfigPath`, `MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS` selects request-context stdio servers, and `MONO_AGENT_CONTINUATION_SERVERS` selects continuation-capable stdio/loopback-HTTP servers.

`mcpConfigPath` resolves against the **workspace** (`runtime.workspace`, default `"."`), so a relative path like `./mcp.json` is read from the same folder the agent operates in. Keep the file beside your `mono-agent.config.json` and reference it relatively for portability.

## Example `mcp.json` (stdio server)

A stdio server is a child process the runtime spawns and talks to over stdin/stdout:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": {
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

SSE and streamable HTTP servers use a `url` instead of `command`/`args`:

```json
{
  "mcpServers": {
    "remote-api": {
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

HTTP/SSE header values in `mcp.json` are literal; mono-agent does not expand
environment references inside them. Do not put credentials in this file,
whether committed or merely untracked. There is currently no credential
indirection for authenticated HTTP/SSE entries, so do not declare one unless a
separate trusted mechanism supplies authentication without putting it in this
file.

Treat every declared stdio server as fully trusted. Environment delivery is
runtime-dependent: some runtimes inherit the full agent process environment,
including unrelated credentials loaded from `.env` or `--env-file`, while
others launch from a restricted safe list. Literal per-server `env` entries are
passed through. Do not rely on inherited variables for credential delivery or
on a restricted runtime for per-server secret isolation.

Run `mono-agent validate` to confirm the file is found; it reports the resolved
`MCP config:` path or an `MCP config file is missing:` warning.

## Trusted request context for a stdio server

An MCP server that owns conversation-scoped data or long-running progress must not
ask the model to supply a chat or conversation id. Opt it in by configured server
name instead:

```json
{
  "tools": {
    "mcpConfigPath": "./.mcp.json",
    "mcpRequestContextServers": ["transcribe"]
  }
}
```

After all static, request, and authoritative tool-policy options are merged,
mono-agent clones the selected stdio spec for that run and overwrites these env
keys with host-owned values:

- `MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID`
- `MONO_AGENT_MCP_PRODUCING_RUN_ID`
- `MONO_AGENT_MCP_RUN_OUTPUT_DIR`
- `MONO_AGENT_MCP_ATTACHMENTS_ROOT`
- `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS`
- `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES`
- `MONO_AGENT_INTERACTION_PROGRESS_URL`
- `MONO_AGENT_INTERACTION_PROGRESS_TOKEN`

The output directory is `artifacts/outbound/<run-id>`. It is scratch space for
the current run, not a durable artifact: mono-agent removes the exact directory
object it created only after the runtime and tool clients settle. The attachment
root is canonical. `MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS` is a JSON array of
the exact lexical paths saved successfully from this request. The accompanying
`MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES` value is a JSON array of
`{ "path", "dev", "ino" }` objects captured from each file descriptor after
write and sync. Consumers must require both an allowed path and its matching
device/inode identity before reading. A later turn, another conversation, and
failed saves are never carried over. Authoritative empty arrays are injected
when there are no allowed files.

The progress bearer is valid only for that run and conversation, cannot call ask
routes, and is revoked at cleanup. The bridge revalidates it after reading the
request body, so a post stalled during run cleanup is rejected. `/v1/progress`
derives its destination from the bearer; a submitted `conversationId` cannot
redirect it. Configured spoof values lose to the trusted overlay, the shared MCP
config is not mutated, and the bridge master URL/token are explicitly blanked for
opted project MCPs.

You can also inline servers directly in config via `tools.mcpServers` (an object keyed by server name) instead of a separate file. The file (`mcpConfigPath`) and the inline form (`mcpServers`) carry the same per-server schema.

## Durable continuation context

`tools.continuationServers` is a separate trust decision from `tools.mcpRequestContextServers`. It lets one selected stdio or loopback-HTTP MCP service claim a host-bound continuation during the originating request, then submit an immutable result later. The host retains the channel/thread destination and runs the eventual synthesis and native delivery; the model and A2A payload never receive that routing authority.

```json
{
  "tools": {
    "mcpConfigPath": "./mcp.json",
    "continuationServers": ["work-control"]
  }
}
```

For stdio, mono-agent overwrites `MONO_AGENT_CONTINUATION_CLAIM_URL`, `_TOKEN`, `_FINGERPRINT`, and `_MODE`. For loopback HTTP it overwrites the matching `x-mono-agent-continuation-claim-*` headers. Only `localhost`, `127.0.0.1`, and `::1` HTTP endpoints are supported; selecting SSE or a remote HTTP server raises a capability error before provider work starts.

The claim credential is short-lived and tied to the run, selected server, origin history, physical reply target, and mode. It must be exchanged while the MCP request is active. See [Durable continuations](/tools/durable-continuations/) for configuration, endpoint shapes, retries, named routes, and recovery.

## Runtime support

How the servers reach the underlying runtime depends on the backend:

- **SDK runtimes** — the servers are **inlined** into the runtime options the agent passes to the provider session. The `mcp.json` is read and its `mcpServers` are merged into the request.
- **Supported CLI runtimes** — mono-agent translates or forwards the server config into the provider-native shape.
- **Direct OpenCode** — MCP is intentionally unsupported because provider-owned shell tools inherit the server environment. Any configured server, `MemoryRecall`, hosted Supermemory MCP, or real adapter send-tool injection fails validation and the bridge before startup. The host's implicit `RunHistory`, `SessionHistory`, and `SetConversationTitle` tools plus bridge-backed `AskUser` are omitted for a direct OpenCode primary/fallback and for an accepted per-trigger direct OpenCode turn; they do not make an otherwise minimal effective-allow-all config unusable. A rejected per-trigger override stays on its base runtime and keeps those tools. Use a Pi runtime, including `pi:opencode-go:*`, when MCP or host-mediated questions are required.
- **Direct ACP** — lifecycle persistence and cold projection work, but this route has no compatible request-scoped host seam for the new `SessionHistory` tool, so that tool is omitted for any chain or accepted per-trigger override that can attempt direct ACP. `validate` / `doctor` reports `unsupported_route`. Issue #626 deliberately preserves `RunHistory`'s pre-existing direct-ACP route wiring; use a Pi, Claude, or Codex app-server route when the model must call `SessionHistory`.

For supported backends, you author one `mcp.json` and mono-agent does the translation. See [Runtime backends](/runtime/backends/) for the exact capability boundary.

## External MCP tools are NOT gated by `tools.allowedTools`

This is the load-bearing rule for declared external servers. `tools.allowedTools` / `tools.disallowedTools` filter built-in runtime tools (`Read`, `Bash`, …) and policy-gated app-owned tools. They do **not** suppress tools provided by an external MCP server.

Consequences:

- Under allow-all (the default) MCP tools are available because their server is declared, not because of the wildcard. Setting `tools.allowedTools: []` ("no built-in tools") still leaves every MCP tool available.
- An MCP tool's availability is governed by whether its server is **declared** in `mcp.json` / `tools.mcpServers`, not by the allowlist. To withhold an MCP tool, remove or don't declare its server.
- On **direct Codex**, a valid declared server also authorizes Codex-generated `mcp_tool_call` approval elicitations for that exact server name. The bridge does not persist the approval and does not accept inherited/unconfigured servers or genuine downstream MCP form/URL elicitations. `permissionMode: "plan"` still permits these declared MCP calls, so their server-owned side effects are outside Codex's read-only filesystem sandbox.
- On the **pi-native runtime**, `disallowedTools` does **not** filter external MCP-server tools either — declaring the server is the only lever. Claude Code receives `--disallowedTools`; direct Codex has no native name-policy projection and therefore rejects any normal-run restrictive policy instead of partially enforcing it. To hard-restrict an external MCP tool on pi, don't declare its server.
- App-injected MCP tools define their own boundary. `MemoryRecall` and `AskCollaborator` are gated by their own enablement/composition switches; `RunHistory`, `SessionHistory`, `SetConversationTitle`, and adapter send tools are deliberately governed by the normal tool policy.

The `MemoryRecall` description is written to direct **proactive** recall: the agent is told to call it whenever context is missing or uncertain, before assuming or asking. This is behavioral guidance, not a gate — `MemoryRecall`'s availability is still governed by `config.memory.recallTool.enabled`. See [Capture & recall](/memory/capture-and-recall/).

## `SetConversationTitle`: web conversation naming

`SetConversationTitle` is an app-owned request-scoped MCP tool, not an entry in
`mcp.json`. The host injects it only for an ordinary interactive `web:<threadId>`
request whose web service still considers the title writable. Its strict input
is `{ "title": "..." }`: surrounding/internal whitespace is normalized, control
characters are rejected, and the result is capped at 80 characters. The tool
description asks the model to choose a concise semantic title after the topic is
clear and call again only after a material topic shift.

Allow-all exposes the tool automatically on compatible routes. A restrictive
policy must name `SetConversationTitle`, while `disallowedTools` can remove it.
Any configured or accepted direct OpenCode route suppresses it. Trigger-created
and archived web threads never advertise title write authority. The web service
consumes only a successful structured result from this exact tool during the
active turn, performs a conditional SQLite update, and emits the normal thread
invalidation. A browser rename sets a permanent manual lock, so a later or
racing agent result cannot overwrite it. The call remains visible in the
collapsed Activity disclosure but creates no assistant message. If the tool is
absent or unused, the first user message remains the automatic fallback title.

## `RunHistory`: prior-run evidence

`RunHistory` is an app-owned, read-only, request-scoped MCP tool over the existing local run artifacts. There is no new config key. Under allow-all it is exposed automatically on MCP-capable routes; under a restrictive policy, add the exact `RunHistory` name. The deprecated policy alias `run_history` is accepted in `tools.allowedTools` / `tools.disallowedTools`, but only `RunHistory` is registered and shown to the model. Direct OpenCode and other MCP-incompatible routes suppress it.

The compact shorthand is designed for agent exploration:

| Call arguments | Result |
| --- | --- |
| `{}` | List recent completed runs. |
| `{ "query": "north Spain flights" }` | Search safe trigger and summary metadata, ranked by how many Unicode-normalized, case-folded terms a run carries. A single match also carries that run's compact overview. |
| `{ "runId": "..." }` | Return a compact overview: metadata and trigger, final visible output, warnings/failures, tool-name call/error counts, and a timeline cursor when detail exists. |
| `{ "runId": "...", "cursor": "..." }` | Return the next timeline page (at most 10 entries and about 16 KiB). |

`run_id` is accepted as an input alias for `runId`. Explicit
`action: "list" | "search" | "inspect"` calls remain compatible. List and
search accept an optional `limit` (default 5, range 1–10) and expose an opaque
`nextCursor` when more matches remain. Tool-authored
`navigation.guidance` and `navigation.nextActions[]` are separate from the
untrusted evidence; each next action contains exact `arguments` the agent can
submit to continue, narrow, or return to an overview.

List/search **matching** scans retained summaries once per call. It does not
open event JSONL to decide what matches and only considers sanitized
trigger/user input, run id, dates, status/failure kind, source/detail, model,
and effort. It never searches system prompts, reasoning, memory, visible
assistant output, or tool output.

Search **ranks** rather than requiring every term, because a caller naming what
it wants ("unsubscribe group A newsletters") usually says more than the trigger
it is looking for did. Runs carrying every term win outright and are returned
alone; ranked partial matches are offered only when no run carried the whole
query, in which case `matchedAllTerms` is `false` and `navigation.guidance`
names the terms the best candidate actually matched — from the same fields the
scorer read, so a run that ranked on its model or date says so. A run matching
no term is never returned. Because matching is substring matching, a lone ASCII
letter or digit (the "A" of "group A") is dropped from scoring unless the whole
query is made of them.

When a search lands on exactly one run and no cursor was supplied, the result
also carries that run's compact `overview` and offers the timeline cursor as the
next action — the "which one?" round trip is skipped. This **overview
hydration** is the one place a search touches event JSONL, and it is the same
bounded read and same safe projection an explicit `{ "runId" }` performs: no
wider read than the follow-up call it replaces, and no change to what a search
*matches* on. An unreadable artifact for that run degrades to the plain search
result rather than a tool error.

The current or any running run is excluded, as are unrelated conversations and threads. When daily session rollover is configured, its `#YYYY-MM-DD` buckets are ignored for RunHistory scope, so rollover never partitions one logical conversation's recorded history. The safe projection never returns system prompts, reasoning/thinking, recalled memory or turn-context payloads, raw artifact paths, or provider-session metadata. Ordinary filesystem spans are sanitized in place to `[host-path]` plus a bounded non-sensitive suffix, so surrounding commands, tool results, and assistant diagnostics remain visible; credentials and private run-artifact content are still omitted. Absolute roots, account/home prefixes, artifact roots, and private run paths never survive. Structured and artifact-shaped opaque tool results are scrubbed or omitted; nested `RunHistory` result bodies are always replaced with an omission marker so inspection cannot recursively embed prior inspections. Structured projected values first pass through the shared observability redactor: non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; free text is not content-scanned or scrubbed. `RunHistory` then applies an additional projection sanitizer to object keys as well as string values, with deterministic collision-safe key disambiguation. In that second pass, numeric values under `credential`, `private_key`, and `bearer` can remain visible; numeric values under `apiKey`, `token`, `client_secret`, `password`, `authorization`, and `cookie` are redacted. Assignment-shaped password or secret prose is content-scanned and replaced with the diagnostic or tool-result omission sentinel. An optionally quoted assignment value is exempt only when its complete value is exactly `[redacted]`; any prefix or suffix is omitted. Per-string and per-page bounds still apply, and incomplete event input is announced. All historical content is labelled untrusted evidence, never instructions.

Use active conversation history first for the current exchange. Use `MemoryRecall` for intentionally captured durable facts, and `RunHistory` for exact evidence from an earlier run or tool call. See [Artifacts and traces](/observability/artifacts-and-traces/#agent-facing-prior-run-evidence-runhistory).

## `SessionHistory`: retained tool lifecycles

`SessionHistory` is the sibling read-only, request-scoped MCP tool over the canonical managed-tool sidecar, not an extension of `RunHistory`. It has no config key. Allow-all exposes it automatically on compatible routes; a restrictive policy must name `SessionHistory` (`session_history` is a deprecated policy alias), and `disallowedTools` can remove it. The endpoint is bound to a random per-request loopback capability path, requires the exact loopback Host header, creates a fresh stateless MCP server/transport for every HTTP request, and disappears at request cleanup. Direct OpenCode and direct ACP cannot receive it, but their tool lifecycles still persist and cold-project.

| Call arguments | Result |
| --- | --- |
| `{}` or `{ "action": "search" }` | Up to five completed prior calls in the current logical session. |
| `{ "query": "needle", "tools": ["Read"], "states": ["error"], "runIds": ["..."], "fromMs": 0, "toMs": 9999999999999, "limit": 10 }` | AND-match redacted stored text and filter by exact tool/state/run/time; returns an opaque `nextCursor` when more remain. |
| `{ "action": "get", "recordId": "sth1_...", "chunkBytes": 4096 }` | One invocation or result plus a bounded payload chunk, truncation/byte metadata, terminal classification, recovery flag, and opaque artifact availability. |
| `{ "action": "get", "toolCallId": "..." }` | The newest completed record for that provider call id in scope. Prefer `recordId` when search returned one. |
| `{ "action": "get", "cursor": "..." }` | Continue the same record in chunks of at most 8 KiB. |

Search defaults to five and caps at ten results; tool/state/run filters cap at 20 values, queries at 512 UTF-8 bytes, previews at 1 KiB, and model-facing text blocks at 10,000 characters. Cursors are base64url structural tokens bound to the logical conversation, physical conversation, current run, and original filters; substitution, stale anchors, foreign records, and pruned anchors fail opaquely. Only the exact active `(conversationId, runId)` is blocked, so an older daily bucket that reused the same opaque run id remains visible. Daily rollover buckets share one configured logical-session scope, while a natural `#` in an id remains opaque when rollover is off. Isolated/proactive records require `includeIsolated: true` on both the originating call and any continuation.

Every returned preview/chunk is redacted, bounded, path-opaque, and marked `untrusted: true` with an explicit notice. Path opacity applies to object keys as well as string values: an opaque host-root token and at most two non-sensitive trailing components replace each filesystem path while useful command/result text, nested structure, punctuation, line/column suffixes, and web URLs remain. Safe keys retain their spelling, and deterministic bounded suffixes preserve distinct values when sanitized keys collide. Nested `SessionHistory` result bodies are replaced with an omission marker. A retained tombstone says that a known record was removed by age/count/byte retention without recreating its payload. Artifact references expose only an opaque id and availability. The host accepts and rechecks only regular files beneath the configured run-specific `tool-output` root; provider-supplied outside or symlinked paths are dropped without becoming filesystem probes. SessionHistory neither returns a path nor owns the artifact lifetime. Search/get never execute a tool, read an arbitrary path, mutate history, or rerun a recovered/completed call.

Compaction only changes the active prompt projection. Within sidecar retention, older calls remain searchable even after their message context disappears. Cold reseed retains the newest fitting suffix in chronological order and caps the complete UTF-8 projection, including its truncation marker, at 64 KiB. Use `SessionHistory` for exact retained managed-tool invocations/results, and `RunHistory` for broader completed-run context such as warnings and final visible output.

:::note
The **app-owned adapter tools** (`SlackSendMessage`, `TelegramSendMessage`,
`TelegramSendFile`, and structured `AskUser`) are also delivered as MCP tools
but, unlike external MCP tools, they **are** governed by the tool policy. Under
allow-all they become available automatically when their host prerequisites are
present. On runtimes that enforce specific lists, name them explicitly or deny
them normally; direct Codex rejects the restrictive configuration before a run.
Valid `slack.*` / `telegram.*` adapter config is required for send tools. See
[Delivery & send tools](/channels/delivery-and-send-tools/).
:::

For the full allow/deny semantics of built-in tools, see [Tool policy](/tools/policy/). For how `Bash` is confined, see [Sandbox](/tools/sandbox/).

## Related

- [Tool policy](/tools/policy/) — the allow/deny model and app-owned MCP exceptions.
- [Tools & guards](/runtime/tools-and-guards/) — built-in tool catalog and runtime guards.
- [Capture & recall](/memory/capture-and-recall/) — `MemoryRecall`, an app-injected MCP tool.
- [Artifacts and traces](/observability/artifacts-and-traces/) — the separate run records projected safely by `RunHistory` and the tool-lifecycle sidecar used by `SessionHistory`.
- [Durable continuations](/tools/durable-continuations/) — trusted asynchronous claim, result, synthesis, and delivery.
- [Slack team bot with MCP tools](/playbooks/slack-team-bot-mcp-tools/) — end-to-end playbook wiring MCP servers into a channel agent.
- Need to register MCP servers from code instead of config? See [Programmatic composition](/programmatic/composition/).
