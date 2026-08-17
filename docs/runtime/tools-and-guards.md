---
title: "Built-in tools & auto-guards"
description: "Understand mono-agent's built-in tools and automatic protections for processes, web access, tool output, telemetry, retries, and safe parallelism."
sidebar:
  order: 6
---

This page covers mono-agent's managed built-ins (Read, Write, Edit, Glob, Grep, Bash, Exec, NodeRepl, WebFetch, WebSearch, Agent) and the runtime guards that protect each turn: loss-aware process execution, the tool-output bloat guard, per-run usage/cost tracking, bridge-driven Pi context compaction, and WebFetch's in-tool retry. It also notes which behaviors you configure versus which run automatically.

## Subagents (`Agent`)

`Agent` lets the main agent hand a self-contained task to a helper that works
independently and reports back. It exists only on the pi runtime, and only when
`subagents.enabled` is true **and** `Agent` appears in `tools.allowedTools` —
`mono-agent validate` warns when one half is configured without the other.

```json
{
  "tools": { "allowedTools": ["Read", "Glob", "Grep", "Agent"] },
  "subagents": {
    "enabled": true,
    "maxConcurrent": 5,
    "definitions": [
      {
        "name": "researcher",
        "description": "Reads code and docs to answer a factual question. Read-only.",
        "prompt": "You are a codebase researcher. Answer with file:line citations. Never modify files.",
        "allowedTools": ["Read", "Glob", "Grep", "WebFetch"],
        "maxTurns": 25
      }
    ]
  }
}
```

Each definition needs exactly one of `prompt` or `promptPath`. The `Agent` tool
takes `{prompt, name?, description?}`; with no `name` it runs a read-only
general-purpose researcher on the parent's model.

**Subagents built at call time.** A pre-declared profile means editing config and
restarting for every new specialization, so the agent can also author one on the
spot: passing `systemPrompt` (plus a kebab-case `name`, and optionally `tools`
and `effort`) builds a one-off subagent for that call instead of selecting a
profile. `tools` and `effort` apply only alongside `systemPrompt` — a configured
profile brings its own — and a name that collides with a configured profile is
rejected so the activity log stays unambiguous.

What an authored subagent may reach is an operator decision, not the model's.
Requested tools are intersected with a ceiling, and anything dropped is reported
back in the result so the model stops asking for it:

```json
{
  "subagents": {
    "enabled": true,
    "inline": { "allowedTools": ["Read", "Glob", "Grep", "Edit", "Bash"] }
  }
}
```

The same ceiling clamps the built-in general-purpose profile to the intersection
of its read-only defaults; configured profiles retain their explicit contracts,
and a ceiling with no read-only tools rejects general-purpose instead of widening
it. Omitting `inline.allowedTools` caps authored subagents and general-purpose at
the parent agent's own built-ins (its `tools.allowedTools` minus
`tools.disallowedTools`), so a helper never reaches further than the agent that
built it. Omitting `tools` on the call gives a read-only helper. Set
`inline.enabled` to `false` to allow only pre-declared profiles; the `Agent`
tool then takes exactly `{prompt, name?, description?}` with `name` restricted
to the configured profiles.

**What comes back.** The main agent receives the subagent's final answer plus a
compact log — one line per tool call with a short argument summary, ok/error,
and duration — capped at roughly 24 KB. It does not receive raw tool output. A
subagent that fails, times out, or returns nothing still reports its activity
log, since that log is usually the most useful part of a failed delegation.

**What operators see.** Every subagent tool call streams live to the TUI and web
console as its own entry, named `<profile>▸<tool>` and bracketed by the
subagent's own start/finish rows. The subagent's thinking and prose stay
internal — only its final answer reaches the parent, through the tool result.

**Limits.** `maxConcurrent` (default 5) bounds simultaneous subagents;
`maxPerTurn` (default 20) bounds the total per parent turn and is the real
runaway guard, since a delegation loop can spend budget serially without ever
hitting the concurrency cap. Each subagent gets `maxTurns` (default 100) and
`timeoutMs` (default 5 minutes), and its timeout starts only once it actually
begins, not while queued.

**Guardrails.** A subagent is read-only unless its profile enumerates more (or,
for one built at call time, unless its `tools` request survives the ceiling), and
it never receives `Agent`, `AskUser`, or any channel-send tool — it cannot
message the user or spawn subagents of its own. It inherits the parent's sandbox
and cannot widen it, gets no MCP servers unless its profile names them, and runs
with no provider session of its own. Omitting a profile's `model` inherits the
parent's configured route, so subagents get the fallback chain and same-model
retries too; naming a model routes that profile through it instead.

**Skills.** A subagent inherits the parent's skill index and the `ReadSkill` tool
whenever the agent runs with `context.skillDisclosure: "index"` and a
`context.skillsRoot` — the index is appended to the profile prompt, and the child
pulls any body it needs on demand. It never receives inlined skill bodies:
`selectedSkills` and `skillMaxBytes` are full-disclosure concepts and do not carry
over. Under full disclosure a child gets no index, matching its parent. Opt a
profile out with `"disallowedTools": ["ReadSkill"]`, which withholds both the tool
and the index. A profile pinned to a model whose runtime lacks skill support
(direct OpenCode) is skipped automatically rather than failing the run, since a
non-empty skill list makes skill support a routing requirement.

## Built-in tools

These tools need no extra capability config (coverage: `config` — they exist by default on the supporting runtime; you gate them):

| Tool | Purpose |
| --- | --- |
| `Read` | Read a file (text, images, PDFs, notebooks). |
| `Write` | Create or overwrite a file. |
| `Edit` | Exact-string replacement in a file. |
| `Glob` | Match files by glob pattern. |
| `Grep` | Search file contents. |
| `Bash` | Run a command string through a clean non-interactive Bash. |
| `Exec` | Run one executable directly with an argv array and no shell parsing. |
| `NodeRepl` | Evaluate JavaScript in a run-scoped Node.js REPL. |
| `WebFetch` | Fetch and locally extract one public URL, with opt-in browser rendering. |
| `WebSearch` | Search via local SearXNG, ChatGPT-subscription Codex app-server, or keyless public fallbacks. |

These are gated by `tools.allowedTools` / `tools.disallowedTools`. Deny always wins, and listing the same tool in both is rejected at validation time. Mono-agent-managed built-ins are provided by the Pi bridge; provider-owned routes use their native tool surfaces. See [Tool Policy](/tools/policy/) for the full allow/deny semantics, plus [MCP tools](/tools/mcp/) and the [sandbox](/tools/sandbox/) for process and network confinement.

```json
{
  "tools": {
    "allowedTools": ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    "disallowedTools": ["Bash", "Write", "Edit"]
  }
}
```

Env equivalents: `MONO_AGENT_ALLOWED_TOOLS`, `MONO_AGENT_DISALLOWED_TOOLS` (comma-separated tool names).

:::note
An **omitted** `allowedTools` (or `["*"]`) allows **every** tool subject to `disallowedTools` — the allow-all default. Listing specific names narrows to those; an **explicit empty** `[]` allows none (a deliberate chat-only agent). Add names to `disallowedTools` to subtract from the open default without switching to a full allowlist.
:::

These are the normalized policy semantics, but the selected runtime must be able to enforce them. Direct `codex:*` normal runs currently accept only effective allow-all (an omitted or wildcard-containing allowlist, with no denylist); named-only lists, `[]`, and denylist variants fail validation/runtime setup instead of being silently widened. See [Tool policy](/tools/policy/#allow-all-by-default).

## Exec and Bash

Use `Exec({ executable, args, workdir?, timeout_ms?, max_output_chars?, background? })` for
ordinary commands. It calls the executable directly, so every argument stays
literal: no shell expansion, redirection, command substitution, pipelines, or
quoting ambiguity. Use `Bash` only for commands that genuinely require shell
syntax.

`Bash` launches `/bin/bash --noprofile --norc -c`, pins `BASH_ENV` and `ENV` to
`/dev/null`, and removes inherited Bash functions/startup-option variables.
This avoids interactive aliases, user profiles, exported functions, and shell
startup hooks changing an agent call. Its public `timeout_ms` is exact
milliseconds.
The old `timeout` field remains temporarily compatible—values up to 600 retain
the historical seconds interpretation and larger values mean milliseconds—but
every use emits a deprecation warning.

Both tools share one loss-aware process runner. It:

- spawns a detached process group without an extra shell;
- enforces abort and timeout with `SIGTERM`, then `SIGKILL` after a one-second
  grace period;
- bounds stdout and stderr together at 8 MiB before applying the smaller
  model-facing output cap;
- preserves partial stdout/stderr on non-zero exit, signal, abort, timeout, and
  overflow;
- returns sandbox preparation and cleanup failures as structured tool errors;
- records structured status, exit code/signal, duration, byte count, timeout,
  and truncation metadata without copying the command or argv into timing
  telemetry.

`background` is absent from both schemas unless an enabled Pi-native host
injects an available process-job controller for the exact request. With no
controller, schemas and foreground behavior are unchanged. With one,
`background: true` hands the already sandbox-prepared command to the host and
returns an opaque job id without waiting for completion. The host preserves the
same command/shell semantics, owns cleanup after the inherited POSIX process
group exits, and wakes the originating Slack, Telegram, or web conversation
through a normal tool-capable turn. Commands that daemonize into another group
or session are unsupported. See [Background process jobs](/tools/background-process-jobs/)
for configuration, limits, supported origins, recovery, and operator access.

These are macOS-facing tools. Prefer portable commands or feature-detect flags
instead of assuming GNU variants of `sed`, `date`, `stat`, `xargs`, and similar
utilities.

## NodeRepl

`NodeRepl({ code })` uses Node's built-in [`node:repl`](https://nodejs.org/api/repl.html) default evaluator. Mono-agent lazily starts one child REPL for a run and reuses it for later `NodeRepl` calls in that run. Variables, the module cache, `_`, and `_error` therefore persist between calls; the child is destroyed when the run ends, so the next run starts clean. The evaluator supports multiline JavaScript, top-level `await`, Node built-ins, `console` output, and `require()` of packages already installed for the workspace.

This is code execution, with the same filesystem, process, and network authority as `Exec` and `Bash`. The child goes through the same sandbox preparation seam and configured SRT policy. With no active sandbox it runs on the host; with native SRT it receives the configured roots, deny-write rules, and network policy. A fixed 120-second evaluation timeout, abort, child exit, or hard output overflow kills the child and resets its state before a later call. Normal results use the existing tool-output cap.

The host and REPL child communicate through random-token, length-prefixed JSON
frames on ordinary stdin/stdout. Console output is captured separately from
protocol frames. This works through sandbox wrappers that forward standard
pipes and avoids relying on Node's special IPC file descriptor.

`NodeRepl` is intentionally small: it has no session ids, persistent history, reset command, terminal emulation, or package installer. Use `Bash` for shell commands and install dependencies before the run. REPL dot commands such as `.save` and `.load` are not a supported tool interface.

## Tool-output bloat guard (auto)

Tool results are truncated at a 256KB budget so a single oversized result cannot blow up the context window or the model's reasoning. When a result exceeds the budget, the guard attempts to save each original block through the artifact sink. The compact replacement references only paths the sink successfully returned; if the sink is absent or a write fails, omitted bytes are not recoverable. Successful files land under `artifacts.dir/tool-output/` and are separate from JSONL replay.

Images get a separate, larger budget than text so vision payloads are not clipped at the text limit.

This guard is always on (coverage: `auto`). You do not enable it; you only choose where artifacts are written:

```json
{
  "artifacts": {
    "dir": ".mono-agent/artifacts"
  }
}
```

Env: `MONO_AGENT_ARTIFACT_DIR`.

## Usage & cost tracking (auto)

Each run collects per-turn usage, cost, and cache metrics as events for its JSONL artifact. Pi catalog estimates delegate to Pi's native cost calculation, including request-wide pricing tiers and cache-write rates. Before persistence, non-numeric values under sensitive-looking object keys are redacted; numeric values under matched keys are retained; retained free text is scanned for a closed set of high-confidence credential shapes. The recorder applies a 4,096-byte default cap per string, writes an empty start snapshot, schedules best-effort `running` checkpoints after 25 new events or five seconds from the first uncheckpointed event, and queues the terminal snapshot after any scheduled checkpoint. It replaces the events and summary files separately rather than appending or fsyncing a journal, so a crash can preserve the last successful prefix while losing the unscheduled or failed-write tail. This is automatic (coverage: `auto`) — it rides on the same `artifacts.dir` and needs no separate flag. See [Artifacts & traces](/observability/artifacts-and-traces/) for the complete write-boundary and stale-reconciliation contract.

Related per-turn timing also lands in the JSONL: a `provider_bridge_latency` event separates provider/tool/IO time from harness overhead, and per-tool `tool_timing` events carry `execution_ms`. See [Artifacts & traces](/observability/artifacts-and-traces/) and the [CLI reference](/observability/cli-reference/) for reading these, and [Phoenix & backfill](/observability/phoenix-and-backfill/) to export them as spans.

## Context compaction (Pi bridge-driven, configurable)

Compaction is delegated to the active provider bridge rather than hand-rolled in the runtime. On the pi-native bridge, the bridge drives `AgentHarness.compact()`:

- **Proactively** — before a turn when the running model is near its context window.
- **Reactively** — if a turn still overflows, it compacts and re-prompts once
  only after the rebuilt context preview proves a positive reduction. A
  non-reducing compaction is cancelled before persistence and is not sent back
  to the same model unchanged.

The window auto-tracks whichever model is actually serving the request. Numeric
provider overflow limits become learned ceilings; a generic overflow temporarily
lowers the process-local ceiling to 90% of the failed request estimate. If the
provider metadata is persistently wrong, set `runtime.compaction.contextWindowOverride`.
The runtime still cannot make a malformed model definition, one individually
oversized prompt, or a provider failure compactable; unrecovered overflow remains
an explicit `context_limit` and advances through configured fallbacks.

Every run reports `context_compaction_applied`:

| Value | Meaning |
| --- | --- |
| `true` | Compaction fired this run. |
| `false` | Enabled but not needed. |
| `null` | Compaction disabled (or the bridge does not support it). |

Pi diagnostics also report the full proactive request estimate and fixed
overhead components on every check, plus `context_compaction_reactive_attempted`,
`context_compaction_tokens_after`, and `context_compaction_reduced`. If the
request still exceeds the primary model's window, the run is classified as
`context_limit`; the fallback router may then try the next configured model.

This is automatic and configurable on the pi-native bridge. Defaults resolve
against the effective context window `W`: trigger ratio `0.70`, safety headroom
`clamp(floor(W × 0.25), 16000, 96000)`, retained context
`clamp(floor(W × 0.10), 4000, 20000)`, summary output
`clamp(floor(W × 0.04), 2000, 12000)`, and minimum proactive savings
`clamp(floor(W × 0.10), 4000, 20000)`. Configure overrides under
`runtime.compaction` (or the matching `MONO_AGENT_COMPACTION_*` variables).
Other bridges follow their own compaction behavior. See [Backends](/runtime/backends/) for bridge differences, [Sessions & concurrency](/runtime/sessions-concurrency/) for how sessions persist, and [Fallback](/runtime/fallback/) for window changes across the fallback chain.

## Web research and WebFetch retry

`WebSearch` supports a loopback SearXNG companion, structured
ChatGPT-subscription Codex app-server search, and deterministic keyless
fallbacks. `WebFetch` performs local Defuddle/Readability extraction for HTML,
plus JSON, feed, PDF, and text handling. Optional `agent-browser` rendering is
off by default and is a config-level capability ceiling.

`WebFetch` retries transient network failures and HTTP 408/425/429/5xx in-tool
with bounded backoff and `Retry-After` handling. This keeps the model from
burning reasoning rounds re-issuing a fetch that failed for a momentary network
reason. Browser rendering is never attempted for HTTP errors or non-HTML
content.

See [Local-first web research](/tools/web-research/) for the backend, extraction,
isolation, and config contract.

:::tip
This is distinct from provider-transport retries (`providers.piNative.piMaxRetries` / `maxRetryDelayMs`), which retry the model call itself. WebFetch retry is local to the tool's HTTP request. See [Fallback](/runtime/fallback/) for provider-level retry and failover.
:::

## Tool scheduling (code-only)

Pi defaults to safe parallelism: independent read-only tools may overlap, while
`Write`, `Edit`, `Bash`, `Exec`, `NodeRepl`, every MCP tool, and other
stateful/mutating built-ins carry a sequential execution marker. Force every
tool to run sequentially only when a host needs globally deterministic ordering:

```ts
const runtimeOptions = {
  piToolExecutionMode: "sequential", // default: "safe-parallel"
};
```

There is no config-file or CLI key for this (coverage: `code`). The deprecated
`piToolParallelismMode` alias maps `one-at-a-time` to `sequential` and `all` to
`safe-parallel`, with a runtime warning. Tool scheduling is independent from
Pi's one-at-a-time user steering/follow-up queue.

See [Programmatic composition](/programmatic/composition/) for where
`runtimeOptions` is supplied.

## Coverage at a glance

| Capability | Coverage | How |
| --- | --- | --- |
| Built-in tools | `config` | `tools.allowedTools` / `tools.disallowedTools` |
| Bloat guard (256KB + artifacts) | `auto` | Built in; artifacts to `artifacts.dir` |
| Usage/cost tracking | `auto` | Recorded in JSONL artifacts |
| Context compaction | `config` + `provider` | `runtime.compaction.*`; bridge-driven Pi compaction |
| Web research | `config` + `auto` | `tools.web.*`; extraction/retry built in |
| Tool scheduling | `code` | `runtimeOptions.piToolExecutionMode` |
