---
title: "Identity & soul"
sidebar:
  order: 1
---

# Identity & soul

Two markdown documents shape who your agent is on every turn: a **required identity** that declares role and boundaries, and an **optional soul** that carries voice and guardrails. This page covers how to point at them, how they render into the prompt, and the env vars that override them.

Both are part of the assembled context block. For how they sit alongside memory and skills, see [Context assembly](/context/assembly/).

## At a glance

| Field | Required | Env var | Renders as | Coverage |
| --- | --- | --- | --- | --- |
| `context.identityPath` | Yes | `MONO_AGENT_IDENTITY_PATH` | `## Identity` section | `config` |
| `context.soulPath` | No | `MONO_AGENT_SOUL_PATH` | `## Core Guardrails` section | `config` |

`context.identityPath` is one of only two fields that are never optional (the other is `runtime.model`). Omit `context.soulPath` and the framework substitutes a built-in default soul — see [Default soul fallback](#default-soul-fallback).

## Identity (required)

`context.identityPath` points at the markdown loaded into **every** prompt. It defines the agent's role, scope, and hard boundaries. `mono-agent init` scaffolds an `IDENTITY.md` for you.

```json
{
  "context": {
    "identityPath": "./IDENTITY.md"
  }
}
```

Override the path without editing config:

```bash
MONO_AGENT_IDENTITY_PATH=/etc/mono-agent/IDENTITY.md mono-agent start
```

### Reference, don't duplicate

The identity document should be short and stable. Rather than copy-pasting project knowledge into it, **reference the knowledge files the agent already reads** — `AGENTS.md`, `CLAUDE.md`, `README.md`, and similar — so there is a single source of truth.

```markdown
# Identity

You are the build-and-release agent for the `acme-web` repo.

Your role:
- Triage failing CI, propose fixes, and open PRs against `main`.
- Stay inside the repo working tree; never touch infra or secrets.

Authoritative project guidance (read before acting):
- ./AGENTS.md — contribution rules and review gates
- ./CLAUDE.md — codebase conventions and commands
- ./README.md — what the service does and how to run it
```

:::tip
Duplicating those files into the identity invites drift: when `CLAUDE.md` changes, your identity silently goes stale. A pointer stays correct.
:::

## Soul (optional)

`context.soulPath` is a secondary document for **voice, tone, and guardrails** — the "how it behaves" layer that complements the "what it is" identity. It renders as the `## Core Guardrails` section of the prompt.

```json
{
  "context": {
    "identityPath": "./IDENTITY.md",
    "soulPath": "./SOUL.md"
  }
}
```

```bash
MONO_AGENT_SOUL_PATH=/etc/mono-agent/SOUL.md mono-agent start
```

Use the soul for cross-cutting behavior that is not tied to any one task: how to handle uncertainty, how to surface failures, what never to fake, and how to leave handoff notes.

## How they render

The assembled prompt places the soul first, then the identity:

```
## Core Guardrails
<contents of soulPath, or the built-in default soul>

## Identity
<contents of identityPath>
```

Both blocks are passed through verbatim, subject to the per-section size handling described in [Context assembly](/context/assembly/).

## Default soul fallback

When `context.soulPath` is **omitted**, the `## Core Guardrails` section is filled with a built-in default soul — a conservative, source-grounded baseline (follow the instruction hierarchy, read before acting, keep scope small and reversible, preserve secrets, do not fake success, surface failures honestly, ask when unsure, leave handoff notes).

:::note
The fallback is **the default soul text, not your identity**. Leaving out `soulPath` does not duplicate the identity into the guardrails section — it inserts the framework default instead. Set `context.soulPath` only when you want to replace that baseline.
:::

## Related

- [Skills](/context/skills/) — selecting per-skill capability docs into context
- [Context assembly](/context/assembly/) — full order and sizing of the prompt context
- [Config blueprint](/config/blueprint/) — the annotated `mono-agent.config.json`
- [Environment variables](/config/env-vars/) — every `MONO_AGENT_*` override
