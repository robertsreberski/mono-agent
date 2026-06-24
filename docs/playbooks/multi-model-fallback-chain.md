---
title: "Multi-Model Fallback Chain with Transcript Resume"
sidebar:
  order: 13
---

# Multi-Model Fallback Chain with Transcript Resume

This playbook configures a primary cloud model with an ordered list of backup models. The pi-native failover router tries each backup on a retryable provider failure, resuming the same conversation from the transcript tail. Failover is always reported in the run result — never a silent substitution.

## Who this is for

Reliability-minded builders who cannot afford a single-provider outage and want a deterministic, ordered fallback chain (cloud primary → cloud backup → local last resort) with durable resume across restarts.

## Goal

A primary cloud model with ordered backups that the native failover router tries on retryable provider failures, resuming from the transcript tail — failover is reported in run results, never a silent substitution.

## Features used

- [runtime.multi-backend](/runtime/backends/) — mix `claude:*`, `codex:*`, and `pi:<provider>:<model>` references in one chain
- [runtime.fallback-models](/runtime/fallback/) — ordered backups tried on retryable failures
- [runtime.pi-native-tuning](/runtime/local-providers/) — `piNative` retry and durable-sessions knobs
- [runtime.provider-sessions](/runtime/sessions-concurrency/) — continuous sessions with transcript-tail resume

## Configuration

Every key below is from the annotated config blueprint. `runtime.model` is the primary; `fallbackModels` is tried in order on retryable provider failures. The `pi:<provider>:<model>` backups resolve against `providers.local` (Ollama) and pi-native credentials.

```json
{
  "runtime": {
    "model": "claude:claude-sonnet-4-6",
    "fallbackModels": ["pi:openai-codex:gpt-5.5", "pi:ollama:gemma4:31b"],
    "session": { "mode": "continuous" }
  },
  "providers": {
    "local": [
      {
        "id": "ollama",
        "type": "ollama",
        "baseUrl": "http://localhost:11434",
        "enabled": true
      }
    ],
    "piNative": {
      "piMaxRetries": 2,
      "maxRetryDelayMs": 60000,
      "piSessionsRoot": ".mono-agent/sessions"
    }
  }
}
```

Coverage: config. The primary and chain can also be set via env vars `MONO_AGENT_MODEL` and `MONO_AGENT_FALLBACK_MODELS` (env > JSON > defaults). `piNative.piMaxRetries` accepts `0`–`8` transient provider-transport retries; `maxRetryDelayMs` caps the backoff between them. Setting `piSessionsRoot` writes durable JSONL sessions so resume survives a restart — leave it unset for in-memory sessions only.

:::caution
The chain only advances on *retryable* provider failures (transport/credential/transient). Non-retryable application errors are not masked by failover.
:::

## Steps

1. `ollama pull gemma4:31b` (the last-resort local backup).
2. `mono-agent init --model claude:claude-sonnet-4-6 --fallback-models pi:openai-codex:gpt-5.5,pi:ollama:gemma4:31b`
3. Add `providers.local` for ollama and `providers.piNative.piSessionsRoot` for durable resume across restarts.
4. `mono-agent validate` then `mono-agent start`.
5. Force a retryable primary failure (e.g. an invalid primary credential) and confirm the run result reports failover to the next model in the chain.
6. Confirm transcript-tail resume continues the same conversation on the backup model.

## Smoke test

:::tip
Trigger a retryable failure on the primary; confirm the run result shows the fallback model served the turn (reported, not silent), and the conversation resumed from the transcript tail.
:::

## Related

- [Runtime backends](/runtime/backends/)
- [Fallback chain](/runtime/fallback/)
- [Local providers](/runtime/local-providers/)
- [Sessions and concurrency](/runtime/sessions-concurrency/)
- [Config blueprint](/config/blueprint/)
- [mono-agent-composer skill](https://github.com/example/mono-agent/blob/main/packages/agent-app/skills/mono-agent-composer/SKILL.md)
