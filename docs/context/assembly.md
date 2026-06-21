---
title: "Context assembly"
parent: "Context & Skills"
nav_order: 3
---

# Context assembly

Every turn, mono-agent builds one prompt from several ordered sections — core guardrails, identity, memory recall, conversation history, the skill index, selected skill instructions, and finally the current user message. This page documents that order, how history is sized, and the truncation/bloat guards that keep prompts bounded. Assembly is mostly `auto`: you configure the inputs (identity, soul, skills, memory) and the framework assembles them.

## Section order

`@mono-agent/context` concatenates sections in a fixed order. Empty optional sections are skipped, but present sections always appear in this sequence:

| # | Section | Source | Always present? |
|---|---------|--------|-----------------|
| 1 | Core Guardrails | `context.soulPath`, else the built-in default soul | Yes |
| 2 | Identity | `context.identityPath` | Yes (identity is required) |
| 3 | Memory | recalled memory blocks (when memory is enabled) | Optional |
| 4 | Conversation History | in-memory history store | Optional (empty on first turn) |
| 5 | Skill Index | name/description of selected skills | Optional |
| 6 | Selected Skill Instructions | full `SKILL.md` bodies of selected skills | Optional |
| 7 | Current User Message | the inbound request text | Yes |

The user message is always last, so the model reads its instructions, recall, and history before the task it must act on. See [Identity and soul](identity-and-soul.md) for sections 1–2 and [Skills](skills.md) for sections 5–6.

`context.identityPath` is one of only two required config fields (the other is `runtime.model`); omit `context.soulPath` to fall back to the built-in core guardrails.
{: .note }

## Configuring the inputs

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "maxTurns": 0 },
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["research"],
    "skillMaxBytes": 48000
  }
}
```

Matching env vars (env > JSON > defaults): `MONO_AGENT_IDENTITY_PATH`, `MONO_AGENT_SOUL_PATH`, `MONO_AGENT_SKILLS_ROOT`, `MONO_AGENT_SELECTED_SKILLS`, `MONO_AGENT_SKILL_MAX_BYTES`, and `MONO_AGENT_MAX_TURNS`.

Skills are loaded from `<skillsRoot>/<name>/SKILL.md`, one per entry in `selectedSkills` — there is no auto-selection. Each skill's instruction body is capped at `context.skillMaxBytes` (default 48000, range 256–1,000,000). See [Skills](skills.md).

## Memory recall

When `memory` is configured, recalled entries become the Memory section (3). For the `journal`/`bujo` tiers with embeddings, an auto-provisioned read-only `memory_recall` tool also lets the agent pull more context mid-turn via `config.memory.recallTool.enabled` (`MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED`, default on). Recall combines keyword (FTS) and semantic search with no chat LLM. See [Capture and recall](../memory/capture-and-recall.md) and [Embeddings](../memory/embeddings.md).

## Conversation history

Coverage: `auto`. History is kept in an **in-memory store** and is **unlimited** unless you cap turns. The history section renders prior `system`/`user`/`assistant`/`tool` messages for the conversation in order.

- `runtime.maxTurns` (`MONO_AGENT_MAX_TURNS`) is `0` or omitted for **unlimited**; set `1`–`100` to cap turns per run. History sizing follows from this cap.
- History is keyed per conversation. Channels reuse a stable conversation id; for cron, share one with `cron.jobs[].conversationId` so ticks accumulate the same history (see [Cron](../channels/cron.md)).

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "maxTurns": 24 }
}
```

The in-memory store does not survive a process restart. For durable provider-side resume across restarts, configure pi-native sessions with `providers.piNative.piSessionsRoot` (see [Sessions and concurrency](../runtime/sessions-concurrency.md)); for a fully custom, persisted history store you supply your own implementation in code (below).
{: .warning }

### Custom history store (code only)

Replacing the in-memory history store is a `code` capability: pass `historyStore` to `createConfiguredAgentResponder`. See [Composition](../programmatic/composition.md).

## Truncation and bloat guards

Two independent guards keep assembled prompts and tool traffic bounded:

| Guard | Coverage | Behavior |
|-------|----------|----------|
| Per-skill byte cap | `config` | Each skill instruction body truncated to `context.skillMaxBytes` (default 48000) |
| Tool-output bloat guard | `auto` | Tool outputs over 256KB are truncated; the full payload is persisted as an artifact under `artifacts.dir` (`MONO_AGENT_ARTIFACT_DIR`) |

The tool-bloat guard is always on. When a large tool result is truncated in-context, the complete output is written to the artifacts directory so nothing is lost from the run record — see [Artifacts and traces](../observability/artifacts-and-traces.md).

## Context compaction

Assembly produces the prompt; **compaction** keeps it within the model's context window over long conversations. On the pi-native bridge, the runtime drives `AgentHarness.compact()` proactively (before a turn when the running model is near its window) and reactively (compact + a single re-prompt if a turn still overflows). The window auto-tracks the serving model. Runs report `context_compaction_applied` as `true`/`false`/`null` (fired / enabled-but-not-needed / disabled). Tune via `agent_compaction_*` settings. See [Sessions and concurrency](../runtime/sessions-concurrency.md).

## Related

- [Identity and soul](identity-and-soul.md) — sections 1–2
- [Skills](skills.md) — sections 5–6 and the skill index
- [Capture and recall](../memory/capture-and-recall.md) — the Memory section and `memory_recall`
- [Tools and guards](../runtime/tools-and-guards.md) — the bloat guard in context
- [Composition](../programmatic/composition.md) — custom history store and per-request runtime options
