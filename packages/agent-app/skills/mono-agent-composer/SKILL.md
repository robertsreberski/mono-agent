---
name: mono-agent-composer
description: Construct a working mono-agent in the current folder from one mono-agent.config.json — discover the desired runtime (with backup models), channels, skills, MCP servers, memory strategy, and sandbox, then init, validate, and start it with the mono-agent CLI. Use when a user wants to build, configure, or troubleshoot an agent built from @mono-agent packages.
---

# Mono Agent Composer

Construct a working mono-agent in the user's current folder — empty or already holding knowledge — from one `mono-agent.config.json`. Discover what the user wants (runtime with backup models, communication channels incl. crons and webhooks, skills, MCP servers, memory strategy incl. semantic search, sandbox, observability), write the config, then make it run with the `mono-agent` CLI. The config is JSON-first: edit `mono-agent.config.json` directly (agents can edit it too); changes apply on the next `mono-agent restart`. No hand-written host code unless the user genuinely needs programmatic composition.

## Authoritative Sources — Read the References, Not the Package Source

The `references/*.md` bundled beside this SKILL.md ARE the source of truth for what a mono-agent can do and how to configure it. They are maintained in lockstep with the framework and are **complete for configuration and capabilities**. Answer every "can it do X?", "what is the key for Y?", and "how is Z configured?" from them.

Do **not** read or grep the `@mono-agent` TypeScript/package source — `packages/*/src`, `node_modules/@mono-agent/*`, the vendored runtime — to compose, configure, or troubleshoot an agent. For configuration the source is not more authoritative than the references: it is slower, easy to misread, and full of internal-only knobs that are NOT user-configurable. You will usually be working in the user's own agent folder where that source does not even exist.

- `references/feature-coverage.md` is the **exhaustive** map of every feature to a `config` key, `cli` flag, `auto` behavior, or `code`-only escape hatch. If a capability is listed `config`/`cli`, use that key/flag verbatim. If it is **not in the table, or is marked `code`**, it is not reachable through `mono-agent.config.json` — say so plainly and name the escape hatch. Absence from the table means "not configurable," never "go check the source."
- The real exception: if the user is **modifying the framework itself** (changing `@mono-agent` package code), that is framework development, not composing an agent — outside this skill. Only then is reading `packages/*/src` correct.
- The published docs site (<https://mono-agent-docs.vercel.app/>) is the human-facing companion and the repo's `docs/` is a repo-only long-form mirror an end user will not have. Neither is needed: the bundled references work offline and are sufficient.

**Red flags — STOP, you are about to grep source you should not:**

| Thought | Reality |
| --- | --- |
| "Let me verify the key name against the source." | The references give the exact key. Trust them; don't re-derive from source. |
| "The references might be incomplete — I'll double-check `packages/.../src`." | `feature-coverage.md` is exhaustive for config/CLI. Not in it = not configurable. |
| "I'll confirm the docs and source agree." | You are composing an agent, not auditing the framework. The references are the contract. |
| "The real behavior is in the source, not just the docs." | For configuration the references are authoritative. Answer from them and stop. |

## Operating Rules

- Answer capability/config questions from the bundled `references/*.md` (authoritative and complete) — never grep or read the `@mono-agent` package source to compose an agent. See "Authoritative Sources" above.

- The deliverable is a folder that works: `mono-agent.config.json` + `IDENTITY.md` (+ optional `skills/`, `mcp.json`), validated and started — not a tutorial.
- Start by discovering the intended agent product, not by naming packages.
- Ask one question at a time; skip anything the user already answered.
- Respect existing knowledge: if the folder has `AGENTS.md`, `CLAUDE.md`, `README.md`, or an existing `IDENTITY.md`, reference it from the identity instead of replacing it. Never overwrite existing files.
- Fail closed: no allowed tools, no memory writes, loopback-only network until the user opts in.
- Do not fake runtime success, silently broaden tool access, or hide provider/MCP failures. Backup models are configured failover (`runtime.fallbackModels`), never silent substitution.
- Secrets stay in env vars or the untracked config file; never commit tokens or `.env*` files.

## Prerequisites

The `mono-agent` CLI ships with `@mono-agent/agent-app` on npm:

```bash
npm install -g @mono-agent/agent-app   # or: npx @mono-agent/agent-app …
```

To run an unreleased build instead, use a clone of the mono-agent workspace with Node 20+ and pnpm 10 or newer already installed:

```bash
git clone <mono-agent-repo> ~/mono-agent && cd ~/mono-agent
pnpm install --frozen-lockfile
pnpm run build
alias mono-agent="node ~/mono-agent/packages/agent-app/dist/cli.js"
```

Everything below runs in the user's agent folder, not the workspace.

## Composition Flow

1. **Discover.** Read `references/discovery-questions.md` and resolve: runtime model + backup models, channels, identity/knowledge, skills, tools/MCP, memory strategy, sandbox, observability, and the acceptance smoke test. Then run `mono-agent presets list` (and `mono-agent presets show <id>`) for a saved answer-set matching the user's intent; `references/playbooks.md` is the prose companion. If a preset fits, use it as the starting shape. The five core presets are `starter`, `telegram-assistant`, `slack-bot`, `local-private`, and `code-sandbox`; optional plugins such as Supermemory ship their own setup skill/preset. Shapes with no core preset (an OpenAI-API gateway, cron digest, A2A provider, Phoenix-observed, Supermemory, or a full multi-channel build) are hand-assembled from the capability modules and playbooks.
2. **Scaffold.** In the user's folder, prefer the preset path when one fits — scaffold non-interactively with `--yes` (the composer is not the interactive `init` wizard):

   ```bash
   mono-agent init --preset <id> --yes [--with slack,cron] [--effort high] [--auth] [--dry-run]   # preset + .env.example + checklist
   mono-agent init --model <ref> [--fallback-models <csv>] [--effort <level>] [--auth] [--memory lite|journal|bujo]   # bare scaffold
   ```

   Either writes a `mono-agent.config.json` (with `tools.allowedTools` pre-filled from the selected capabilities' recommended tools), an `IDENTITY.md` that references any knowledge files already present, and `.mono-agent/` working directories (presets also emit a `.env.example` and any extra files). `--effort` writes `runtime.effort` on supporting providers (do not use it with direct `opencode:*` SDK 1.x); `--auth` opts in to provider setup before writing files; `--dry-run` previews without writing or launching auth/preflight commands. Existing scaffold/config files are never overwritten; reviewed secret setup is the deliberate exception that can transactionally replace `.env` and update `.gitignore`.
3. **Configure.** Edit `mono-agent.config.json` to match the discovery answers. Read `references/config-blueprint.md` for the full annotated config shape: every channel section, skills, MCP, memory, sandbox, and fallback models. Run `mono-agent config` to see the resolved configuration field-by-field with each value tagged `env` / `json` / `default` — the fastest way to confirm a value came from where you intended.
4. **Validate.**

   ```bash
   mono-agent validate [--preset <id>] [--consumer <path>]
   ```

   Fix every `[error]` section. `[waiting]` channels are fine — they are simply not configured yet. Watch the **Tools & MCP** section: allow-all (the default) shows `All tools allowed`, an **explicit empty** `tools.allowedTools: []` reports `waiting` (the no-tools trap), and an unknown tool name in a specific allowlist is flagged with a "did you mean" hint. With `--preset`, the report also flags any capability the preset promised that is not yet live. Re-run until the report says the config is ready.
5. **Start and smoke.**

   ```bash
   mono-agent start
   ```

   Then run the acceptance smoke test matching the chosen channel (see `references/validation.md`). To change anything, edit `mono-agent.config.json` directly and run `mono-agent restart`; there is no live browser re-apply.

## When Config Is Not Enough

Config-first covers one responder served over any combination of the seven channels (webhook, OpenAI-compatible API, Telegram, Slack, WhatsApp, A2A, cron) plus sandbox, memory (lite with FTS-only recall, journal with hybrid BM25+vector recall + configured embeddings, or bujo with SQLite-indexed hybrid recall + LLM capture/reconcile + entity graph + auto-scheduled consolidation), and traceability. Drop to programmatic composition only for: custom `MonoRuntimeLike` implementations, request-scoped runtime extensions, tool approval gates, structured output schemas, multi-agent orchestration (`@mono-agent/agent-orchestrator`), custom channel message texts, or bespoke transports — `references/feature-coverage.md` lists which features are config keys and which are code-only. Read `references/package-map.md` for the package boundaries, and start from `startMonoAgentApp({ drivers, runtime, ... })` or `@mono-agent/agent-app` rather than re-writing lifecycle glue.

## Implementation References

- `references/discovery-questions.md` — the question sequence and which config keys each answer fills.
- `references/config-blueprint.md` — annotated `mono-agent.config.json` covering every section, plus the folder layout and programmatic escape hatch.
- `references/feature-coverage.md` — every framework feature mapped to config / CLI / code / dev-tooling coverage; the answer to "can the config do X?".
- `references/playbooks.md` — end-to-end recipes (persona → config block → `init`/`validate`/`start`/smoke). Check for a matching preset or playbook before hand-assembling a config.
- `references/package-map.md` — which package owns what, for programmatic composition and troubleshooting.
- `references/validation.md` — validation commands and per-channel smoke tests; read before claiming the agent works.

These bundled `references/*` files are your authoritative, self-sufficient source — they ship with `@mono-agent/agent-app` and work offline, so always read them rather than the package source or a remote site. The published documentation site at <https://mono-agent-docs.vercel.app/> (notably its Playbooks index and Feature Matrix) is the human-facing companion, and the repo's `docs/reference/feature-registry.md` is a longer-form mirror that exists only inside a framework checkout — neither is required, and do not depend on the live site being reachable.

## Done Criteria

- `mono-agent validate` exits 0 in the user's folder.
- `mono-agent start` runs, and the chosen channel's smoke test passed with a real response from the configured runtime.
- The config file matches what the user asked for: model + backups, channels, skills, MCP, memory, sandbox.
- Existing knowledge files are referenced, not duplicated or overwritten.
- No secrets are committed.
