---
title: "Sessions, concurrency & Pi-native tuning"
sidebar:
  order: 5
---

This page covers how the runtime keeps provider sessions warm per conversation, how it bounds in-flight work with admission and execution limits, and the Pi-native transport knobs for retries and durable on-disk sessions. Every option here is `config` coverage with a matching `MONO_AGENT_*` env var unless noted.

## The four "session" meanings

Mono-agent uses "session" for four related but different boundaries:

| Meaning | What owns it | What it controls | What resets it |
| --- | --- | --- | --- |
| `runtime.session` config block | Agent config / env | Whether turns try to reuse a warm provider session and how long idle warmth lasts | Changing config, setting `mode: "per-message"`, or disabling resume support |
| Provider session | Runtime backend / provider bridge | Warm runtime continuity: provider-side context, provider session id, busy state, and idle eviction | Idle eviction, stale/busy resume retry, provider session rotation, cancelled successful turn, harness disposal, or process restart when only in-memory |
| Durable Pi transcript | Pi-native JSONL store under `providers.piNative.piSessionsRoot` | Cross-restart resume for Pi-native provider sessions | `mono-agent restart --force`, deleting the store, changing the durable session id source, or leaving `piSessionsRoot` unset |
| Web run-Session | `mono-agent web` / `@mono-agent/session-web` | Browser-visible run artifact: one recorded run with prompt, events, status, totals, and final text | Artifact retention/removal or source disappearance; the aggregator's in-memory working-set cap (`--max-runs`, default 200) only evicts completed runs from memory — they stay reachable via disk paging ("Load older") — and provider rollover does not rewrite old run records |

Boundary rules:

| Boundary | What ends | What survives | What is emitted |
| --- | --- | --- | --- |
| Daily rollover (`runtime.session.rollover: "daily"`) | The current day-bucket conversation id and its warm provider-session lineage | Durable memory, old run artifacts, durable Pi transcripts for other ids, and app process state | `session_boundary` with `kind: "rollover"` on the first turn of the new bucket |
| Isolated proactive turn (`runtime.session.isolateProactive: true`) | Nothing shared; the proactive turn intentionally skips the conversation's warm provider session | Existing interactive warm session, durable history, memory, and run artifacts | `session_boundary` with `kind: "isolated"` and `reason: "proactive"` |
| Isolated model override | Nothing shared; the override turn uses a one-shot provider session for the alternate model | Existing default-model warm session, durable history, memory, and run artifacts | `session_boundary` with `kind: "isolated"` and `reason: "model_override"` |
| Resume replay after stale/missing provider session | The stale provider session id | Durable history, memory, run artifacts, and the run itself, which retries once | `runtime_warning` `session_resume_retry` plus `session_boundary` with `kind: "resume_replay"` |
| Idle eviction / replaced / disposed provider session | Warm runtime continuity for that conversation id | Durable Pi transcripts, durable history, memory, and run artifacts | App log line and status metadata event (`evicted`) with reason |
| Detached status read | Nothing | All runtime/session state | No runtime event; status reads the latest published config + store snapshot |
| `mono-agent restart --force` / explicit purge | Durable Pi transcript store under `piSessionsRoot` | Durable memory under `memory.path` and recorded run artifacts | Restart/status output only |

## Provider sessions

`runtime.session` decides whether the runtime keeps a warm provider session per conversation or starts fresh on every message.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `runtime.session.mode` | `"continuous"` \| `"per-message"` | `continuous` | `continuous` keeps a warm provider session per conversation; `per-message` rebuilds context each turn |
| `runtime.session.idleTimeoutMs` | number (ms) | `1800000` (30 min) | How long a warm session lingers before idle eviction |
| `runtime.session.rollover` | `"none"` \| `"daily"` | `none` | Whether the responder buckets conversation ids by local day |
| `runtime.session.rolloverTimezone` | IANA timezone string | system local timezone | Timezone used to compute the daily rollover bucket |
| `runtime.session.rolloverNotice` | boolean | unset / off | When true, the first turn of a new daily bucket gets a one-line adapter-visible notice before the model answer |

In `continuous` mode the runtime holds one warm provider session per conversation. Same-conversation follow-ups **queue and resume warm** rather than rebuilding the provider session from scratch. A queued warm-session follow-up holds **no concurrency slot** while it waits (see below). After `idleTimeoutMs` with no activity, the session is evicted and the next message starts cold.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000, "rollover": "daily", "rolloverTimezone": "UTC", "rolloverNotice": false }
  }
}
```

Env vars: `MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`, `MONO_AGENT_SESSION_ROLLOVER`, `MONO_AGENT_SESSION_ROLLOVER_TIMEZONE`, `MONO_AGENT_SESSION_ROLLOVER_NOTICE`.

Warm in-memory sessions are lost on restart. To resume across restarts, persist them durably with `providers.piNative.piSessionsRoot` (Pi-native backends only — see [Pi-native tuning](#pi-native-tuning) below).

`rolloverNotice` is adapter-local and default-off. It does not enable rollover by itself and does not add a new IPC channel or change provider resume behavior. When daily rollover is already enabled and a base conversation crosses into a new day bucket, the responder streams `New session bucket started: <bucket>.` before the model answer and includes the same prelude in the returned final text for final-only transports.

## Concurrency: admission and execution bounds

`concurrency` bounds how much work is in flight. There are two separate limits, applied at different points in a run:

| Key | Default-bearing | Caps | Applied |
| --- | --- | --- | --- |
| `concurrency.maxConcurrentRuns` | yes | How many runs **execute** against the provider at once (execution width) | At the provider step |
| `concurrency.maxPendingRuns` | yes | How many runs may be **admitted** and wait before the provider step | Before the expensive provider step |

`maxConcurrentRuns` is the execution width — the number of runs that may be calling the provider simultaneously. `maxPendingRuns` is the admission bound — it caps how many runs can be queued waiting for an execution slot before new work is rejected, protecting you from unbounded backlog ahead of the expensive provider call. Queued follow-ups on a warm session hold no slot against either limit.

```json
{
  "concurrency": {
    "maxConcurrentRuns": 4,
    "maxPendingRuns": 16
  }
}
```

Env vars: `MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS`, `MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS`.

These bounds cover the harness run path (which begins at `responder.respond`). Channel adapters (Slack/Telegram) do per-conversation admission and attachment downloads *before* that boundary, so cross-conversation transport download IO is not covered here — per-file byte caps and timeouts apply to that instead. Adapter queues are drained and aborted on `/cancel` and stop.

### Per-channel scope gotcha

These values are **not a single global cap.** The app builds one harness — and therefore one limiter — per enabled channel. Each channel's limiter bounds *that channel independently*. With N enabled channels, the effective ceiling is **N × the configured value**.

:::caution
For example, `maxConcurrentRuns: 4` with three enabled channels (Telegram, Slack, webhook) allows up to **12** simultaneous provider runs across the app, not 4.
:::

Size the value as a *per-channel* budget. If you need a hard app-wide ceiling, divide your target by the number of enabled channels. See [Channels](/channels/) for which channels are active.

## Pi-native tuning

`providers.piNative` tunes the Pi-native transport: retry behavior on transient provider failures, and optional durable session storage. These apply to `pi:<provider>:<model>` backends. All fields are optional.

| Key | Range / Default | Meaning |
| --- | --- | --- |
| `providers.piNative.piMaxRetries` | `0`–`8`, default `2` | Transient provider-transport retries |
| `providers.piNative.maxRetryDelayMs` | default `60000` | Backoff cap between retries (ms) |
| `providers.piNative.piSessionsRoot` | path; unset = in-memory | Durable JSONL session store enabling resume across restarts |

```json
{
  "providers": {
    "piNative": {
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000,
      "piSessionsRoot": ".mono-agent/sessions"
    }
  }
}
```

Env vars: `MONO_AGENT_PI_MAX_RETRIES`, `MONO_AGENT_MAX_RETRY_DELAY_MS`, `MONO_AGENT_PI_SESSIONS_ROOT`.

### Durable sessions and restart

When `piSessionsRoot` is set, provider sessions are persisted to JSONL on disk. Resume then recovers from disk after a restart instead of re-sending the full history to the provider. When unset, sessions are in-memory only and are lost on restart.

:::caution
`mono-agent restart --force` purges `piSessionsRoot` so the agent resumes nothing — a fresh start. Durable memory under `memory.path` is untouched, and the purge is a no-op when sessions are in-memory.
:::

For retry behavior across *different* models (provider failover, not transport retries), see [Fallback models](/runtime/fallback/). Transport retries here are within a single model; fallback moves to the next model in the chain.

## Related

- [Backends & models](/runtime/backends/) — choosing `runtime.model` and execution mode
- [Local providers](/runtime/local-providers/) — `pi:<provider>:<model>` for Ollama / LM Studio / OpenAI-compatible
- [Fallback models](/runtime/fallback/) — ordered backups on retryable provider failure
- [Tool parallelism](/runtime/tools-and-guards/) — concurrent tool calls within a model step (code-only)
