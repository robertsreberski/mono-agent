---
title: "Reference"
nav_order: 13
has_children: true
---

# Reference

Canonical lookup material for mono-agent: a scannable capability matrix, a glossary of terms used throughout the docs, and the long-form feature registry that is the single source of truth for what the framework can do and how each capability is reached.

Use this section when you need to confirm an exact config key, env var, or coverage type rather than learn a workflow — for end-to-end recipes see the [playbooks](../playbooks/index.md).

## Pages in this section

| Page | What it gives you |
| --- | --- |
| [Feature matrix](feature-matrix.md) | Compact, scannable table of capabilities mapped to their primary config key, env var, and coverage type. |
| [Glossary](glossary.md) | Definitions of terms (channel, soul, ritual, recall, A2A, fallback chain, sandbox, etc.) used across the docs. |
| [Feature registry](../feature-registry.md) | Authoritative, long-form checklist — the source of truth a new capability row is added to when a package ships a feature. |

## Coverage types

Every capability in the matrix and registry is tagged with how it is reached. The codes are consistent across all reference pages:

| Code | Meaning |
| --- | --- |
| `config` | Declarable in `mono-agent.config.json` (an env var override is always available). |
| `cli` | Reached through a `mono-agent` CLI flag or command. |
| `auto` | Always active when the app runs; needs no declaration. |
| `code` | Available only programmatically — see [Programmatic](../programmatic/index.md). |
| `dev` | A development/testing affordance, not a production runtime feature. |

If a capability is marked `code` only, it cannot be turned on through `mono-agent.config.json` or the CLI; build it with the SDK as described under [Programmatic composition](../programmatic/composition.md).
{: .note }

## How to read a config example

Reference examples use real keys from the [config blueprint](../config/blueprint.md). A capability declared in config almost always has a matching `MONO_AGENT_*` environment override; the [env vars](../config/env-vars.md) page lists the override for each key.

```json
{
  "runtime": { "model": "claude:claude-sonnet-4-6" }
}
```

The example above sets the primary model; the equivalent override is `MONO_AGENT_MODEL`. For the full annotated file, see the [blueprint](../config/blueprint.md).

## Keeping the registry current

When a package adds a capability, add a row to [feature-registry.md](../feature-registry.md) (its coverage code, the config key/env var, and the CLI command if any), then mirror the summary into the [feature matrix](feature-matrix.md). The registry is the upstream source; the matrix is its scannable projection.
{: .tip }
