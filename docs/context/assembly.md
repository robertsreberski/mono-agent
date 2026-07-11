---
title: "Context assembly"
sidebar:
  order: 3
---

# Context assembly

Every turn, mono-agent builds one prompt from several ordered sections — core guardrails, identity, a session block, conversation history, the skill index, selected skill instructions, and finally the current user message. Recalled long-term memory is **not** one of these system-prompt sections; it is appended to the user message instead (see [Memory recall](#memory-recall) below). This page documents that order, how history is sized, and the truncation/bloat guards that keep prompts bounded. Assembly is mostly `auto`: you configure the inputs (identity, soul, skills, memory) and the framework assembles them.

## Section order

The context builder in `@mono-agent/agent-harness` concatenates sections in a fixed order. Empty optional sections are skipped, but present sections always appear in this sequence:

| # | Section | Source | Always present? |
|---|---------|--------|-----------------|
| 1 | Core Guardrails | `context.soulPath`, else the built-in default soul | Yes |
| 2 | Identity | `context.identityPath` | Yes (identity is required) |
| 3 | Session | the current turn's `conversationId` + delivery/callback guidance | Yes |
| 4 | Conversation History | in-memory history store | Optional (empty on first turn) |
| 5 | Skill Index | name/description of selected skills | Optional |
| 6 | Selected Skill Instructions | full `SKILL.md` bodies of selected skills | Optional |
| 7 | Current User Message | the inbound request text, with any recalled memory appended | Yes |

The user message is always last, so the model reads its guardrails, identity, and history before the task it must act on — and any recalled memory travels **with** that user message. See [Identity and soul](/context/identity-and-soul/) for sections 1–2, [Session](#session) for section 3, and [Skills](/context/skills/) for sections 5–6.

:::note
`context.identityPath` is one of only two required config fields (the other is `runtime.model`); omit `context.soulPath` to fall back to the built-in core guardrails.
:::

:::note
Recalled long-term memory used to be section 3 of this prompt. It is no longer assembled into the system-prompt sections above — it now rides the user message each turn (see [Memory recall](#memory-recall)). The `@mono-agent/agent-harness` context API still exposes a `memory` section for custom/programmatic callers that pass `memory` directly, but the standard agent appends recall to the user message.
:::

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

Skills are loaded from `<skillsRoot>/<name>/SKILL.md`, one per entry in `selectedSkills` — there is no auto-selection. Each skill's instruction body is capped at `context.skillMaxBytes` (default 48000, range 256–1,000,000). See [Skills](/context/skills/).

## Session

The **Session** block (section 3) is auto-generated each turn (coverage `auto`, no config) and tells the agent which conversation it is currently handling — the turn's `conversationId`, with any daily-rollover date suffix stripped so the id is the stable, deliverable one.

- For a deliverable push destination (`telegram:` / `slack:`), it also tells the agent how to wire an **async callback**: if the agent starts a long-running external operation, it can ask the service to include `"conversationId": "<id>"` in the JSON body of its callback to an inbound webhook, and the follow-up is routed back to this same conversation. See [Webhook](/channels/webhook/).
- For non-push conversations (cron / webhook / openai-api / a2a), it instead clarifies that this conversation cannot itself receive a proactive follow-up. Cron jobs and webhook endpoints with `notify: true` deliver their successful final answer to the resolved Telegram/Slack destination — the harness injects guidance on those turns that the final reply is delivered verbatim and how to stay silent. See [Delivery and send tools](/channels/delivery-and-send-tools/).
- When memory is configured, it also states that persistence is host-owned: the agent acknowledges memory requests and lets post-turn capture write them, without editing memory Markdown, SQLite, manifests, generations, or indexes through tools.

## Memory recall

Recalled long-term memory is **not** part of the system-prompt sections above. When `memory` is configured and a recall returns hits, the harness appends the recalled block to the **user message** each turn — after the user's text and any attachment block — clearly delimited so the model reads it as injected background context rather than the user's words:

```text
[Recalled long-term memory — background context for this turn, not the user's words:]
…recalled entries…
```

This injection happens on **every** turn, including the resume-retry path, because the user message is the one field every runtime re-sends verbatim. So memory survives a session resume even on runtimes that drop the system prompt on a resumed turn (e.g. codex-app sends developer instructions only on a fresh thread start). Keeping memory off the system prompt also leaves that prompt stable across a session, which is better for provider prompt caching.

A few specifics:

- **Not persisted.** Injected memory is added only to the provider-facing message, never written back to history or capture, so it cannot compound into future prompts.
- **Skipped when empty.** A recall that returns no hits injects nothing — no delimiter, no header.
- **Still traced.** A lightweight `memory_recalled` diagnostic (source + byte size, not the content) keeps the fact that recall fired visible in the run record even though memory no longer appears in the prompt sections.

Every configured memory tier also exposes the read-only `MemoryRecall` tool by default (`config.memory.recallTool.enabled`; explicit false opts out). Lite uses FTS; Journal/BuJo combine keyword and semantic search. Automatic context recall is score- and answer-evidence-gated to five hits / 8 KB and shares a per-turn lookup cache with the tool. See [Capture and recall](/memory/capture-and-recall/) and [Embeddings](/memory/embeddings/).

## Conversation history

Coverage: `auto`. History is kept in an **in-memory store**. The default retains the latest 12 messages; a positive turn cap retains up to twice that many messages. The history section renders prior `system`/`user`/`assistant`/`tool` messages for the conversation in order.

- `runtime.maxTurns` (`MONO_AGENT_MAX_TURNS`) is `0` or omitted for an **unlimited provider run**; set `1`–`100` to cap turns per run. This does not disable history: unlimited runs use the bounded 12-message history default.
- History is keyed per conversation. Channels reuse a stable conversation id; for cron, share one with `cron.jobs[].conversationId` so ticks accumulate the same history (see [Cron](/channels/cron/)).

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6", "maxTurns": 24 }
}
```

:::caution
The in-memory store does not survive a process restart. For durable provider-side resume across restarts, configure pi-native sessions with `providers.piNative.piSessionsRoot` (see [Sessions and concurrency](/runtime/sessions-concurrency/)); for a fully custom, persisted history store you supply your own implementation in code (below).
:::

### Custom history store (code only)

Replacing the in-memory history store is a `code` capability: pass `historyStore` to `createConfiguredAgentResponder`. See [Composition](/programmatic/composition/).

## Truncation and bloat guards

Two independent guards keep assembled prompts and tool traffic bounded:

| Guard | Coverage | Behavior |
|-------|----------|----------|
| Per-skill byte cap | `config` | Each skill instruction body truncated to `context.skillMaxBytes` (default 48000) |
| Tool-output bloat guard | `auto` | Tool outputs over 256KB are truncated; the full payload is persisted as an artifact under `artifacts.dir` (`MONO_AGENT_ARTIFACT_DIR`) |

The tool-bloat guard is always on. When a large tool result is truncated in-context, the complete output is written to the artifacts directory so nothing is lost from the run record — see [Artifacts and traces](/observability/artifacts-and-traces/).

## Context compaction

Assembly produces the prompt; **compaction** keeps it within the model's context window over long conversations. On the pi-native bridge, the runtime drives `AgentHarness.compact()` proactively (before a turn when the running model is near its window) and reactively (compact + a single re-prompt if a turn still overflows). The window auto-tracks the serving model. Runs report `context_compaction_applied` as `true`/`false`/`null` (fired / enabled-but-not-needed / disabled). Tune via `agent_compaction_*` settings. See [Sessions and concurrency](/runtime/sessions-concurrency/).

## Related

- [Identity and soul](/context/identity-and-soul/) — sections 1–2
- [Skills](/context/skills/) — sections 5–6 and the skill index
- [Capture and recall](/memory/capture-and-recall/) — the user-message memory injection and `MemoryRecall`
- [Delivery and send tools](/channels/delivery-and-send-tools/) — native cron/webhook notify the Session block references
- [Tools and guards](/runtime/tools-and-guards/) — the bloat guard in context
- [Composition](/programmatic/composition/) — custom history store and per-request runtime options
