---
title: "Context & Skills"
sidebar:
  order: 0
---

# Context & Skills

This section covers how mono-agent assembles the prompt for every turn: a required **identity** document, an optional **soul** document, the running **conversation history**, and any explicitly **selected skills**. All of it is declared in the `context` block of `mono-agent.config.json` and is coverage type **config** (with a few `auto` and `code` escape hatches noted below).

## What goes into a turn

Each turn the agent builds a prompt from these layers:

| Layer | Source | Coverage | Key |
|-------|--------|----------|-----|
| Identity | `IDENTITY.md` (or path) | config | `context.identityPath` |
| Soul (optional) | `SOUL.md` (or path) | config | `context.soulPath` |
| Conversation history | in-memory store | auto / code | sized from `runtime.maxTurns` |
| Selected skills | `<skillsRoot>/<name>/SKILL.md` | config | `context.skillsRoot`, `context.selectedSkills` |
| Recalled memory (optional) | memory subsystem | config | see [Memory](/memory/capture-and-recall/) |

Identity is the only required piece of `context` — `context.identityPath` is the one field in this section you cannot omit. Everything else is opt-in.

## Configuring the context block

```json
{
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["research"],
    "skillMaxBytes": 48000
  }
}
```

Every field has a matching `MONO_AGENT_*` env var that overrides the JSON (env > JSON > defaults):

| Field | Env var | Default |
|-------|---------|---------|
| `context.identityPath` | `MONO_AGENT_IDENTITY_PATH` | `./IDENTITY.md` |
| `context.soulPath` | `MONO_AGENT_SOUL_PATH` | unset (no soul) |
| `context.skillsRoot` | `MONO_AGENT_SKILLS_ROOT` | `./skills` |
| `context.selectedSkills` | `MONO_AGENT_SELECTED_SKILLS` | none selected |
| `context.skillMaxBytes` | `MONO_AGENT_SKILL_MAX_BYTES` | `48000` |

Paths are resolved relative to the agent folder. `mono-agent init` scaffolds an `IDENTITY.md` for you; see [Folder Layout](/config/folder-layout/).

:::note
There is **no auto-selection of skills** — a skill is loaded only if its exact name appears in `context.selectedSkills` and a `SKILL.md` exists at `<skillsRoot>/<name>/SKILL.md`.
:::

## How each layer behaves

- **Identity & soul** are plain markdown loaded into every prompt. Identity carries role and boundaries; soul is an optional secondary voice/guardrail document. See [Identity & Soul](/context/identity-and-soul/).
- **Conversation history** assembly is automatic (coverage `auto`): an in-memory store sized from `runtime.maxTurns`, and unlimited when `runtime.maxTurns` is omitted or `0`. To swap in a custom store you must use the programmatic path — `createConfiguredAgentResponder({ historyStore })` (coverage `code`); see [Programmatic](/programmatic/).
- **Selected skills** are loaded explicitly and each is capped at `context.skillMaxBytes` bytes (default 48000, valid range 256–1,000,000). See [Skills](/context/skills/).

:::caution
History is capped only when turns are capped. If you leave `runtime.maxTurns` unset for a long-lived channel agent, history grows unbounded in memory — pair it with runtime compaction (`runtime.context-compaction`) so the prompt stays within the model window. See [Sessions & Concurrency](/runtime/sessions-concurrency/).
:::

## In this section

- [Identity & Soul](/context/identity-and-soul/) — authoring `IDENTITY.md` and the optional `SOUL.md`.
- [Skills](/context/skills/) — the `SKILL.md` format, `selectedSkills`, and per-skill byte caps.
- [Assembly](/context/assembly/) — the full prompt-assembly order and how the layers combine each turn.

## Related

- [Memory](/memory/capture-and-recall/) — recalled memory is injected alongside context.
- [Tools](/tools/) — tool definitions and policy live next to context in each turn.
