---
title: "Sessions, concurrency & Pi-native tuning"
sidebar:
  order: 5
---

This page covers how the runtime keeps provider sessions warm per conversation, how it bounds in-flight work with admission and execution limits, and the Pi-native transport knobs for retries and durable on-disk sessions. Every option here is `config` coverage with a matching `MONO_AGENT_*` env var unless noted.

## Provider sessions

`runtime.session` decides whether the runtime keeps a warm provider session per conversation or starts fresh on every message.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `runtime.session.mode` | `"continuous"` \| `"per-message"` | `continuous` | `continuous` keeps a warm provider session per conversation; `per-message` rebuilds context each turn |
| `runtime.session.idleTimeoutMs` | number (ms) | `1800000` (30 min) | How long a warm session lingers before idle eviction |

In `continuous` mode the runtime holds one warm provider session per conversation. Same-conversation follow-ups **queue and resume warm** rather than rebuilding the provider session from scratch. A queued warm-session follow-up holds **no concurrency slot** while it waits (see below). After `idleTimeoutMs` with no activity, the session is evicted and the next message starts cold.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "session": { "mode": "continuous", "idleTimeoutMs": 1800000 }
  }
}
```

Env vars: `MONO_AGENT_SESSION_MODE`, `MONO_AGENT_SESSION_IDLE_TIMEOUT_MS`.

Warm in-memory sessions are lost on restart. To resume across restarts, persist them durably with `providers.piNative.piSessionsRoot` (Pi-native backends only — see [Pi-native tuning](#pi-native-tuning) below).

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
