---
name: mono-agent-composer
description: Construct a working mono-agent in the current folder from one mono-agent.config.json — discover the desired runtime (with backup models), channels, skills, MCP servers, memory strategy, and sandbox, then init, validate, and start it with the mono-agent CLI. Use when a user wants to build, configure, or troubleshoot an agent built from @mono-agent packages.
---

# Mono Agent Composer

Construct a working mono-agent in the user's current folder — empty or already holding knowledge — from one `mono-agent.config.json`. Discover what the user wants (runtime with backup models, communication channels incl. crons and webhooks, skills, MCP servers, memory strategy incl. semantic search, sandbox, observability), write the config, then make it run with the `mono-agent` CLI. The config is JSON-first: edit `mono-agent.config.json` directly (agents can edit it too); changes apply on the next `mono-agent restart`. No hand-written host code unless the user genuinely needs programmatic composition. `references/feature-coverage.md` maps every framework feature to a config key, CLI flag, or the programmatic escape hatch — consult it before declaring anything impossible or inventing keys.

## Operating Rules

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

1. **Discover.** Read `references/discovery-questions.md` and resolve: runtime model + backup models, channels, identity/knowledge, skills, tools/MCP, memory strategy, sandbox, observability, and the acceptance smoke test. Then scan `references/playbooks.md` for a recipe matching the user's intent — if one fits, use it as the starting shape.
2. **Scaffold.** In the user's folder run:

   ```bash
   mono-agent init --model <ref> [--fallback-models <csv>] [--memory lite|journal|bujo]
   ```

   This writes a minimal `mono-agent.config.json` (webhook enabled as the zero-credential smoke channel), an `IDENTITY.md` that references any knowledge files already present, and `.mono-agent/` working directories. It never overwrites existing files.
3. **Configure.** Edit `mono-agent.config.json` to match the discovery answers. Read `references/config-blueprint.md` for the full annotated config shape: every channel section, skills, MCP, memory, sandbox, and fallback models. If a `references/playbooks.md` recipe matches, start from its config block and adapt it rather than assembling from scratch.
4. **Validate.**

   ```bash
   mono-agent validate
   ```

   Fix every `[error]` section. `[waiting]` channels are fine — they are simply not configured yet. Re-run until the report says the config is ready.
5. **Start and smoke.**

   ```bash
   mono-agent start
   ```

   Then run the acceptance smoke test matching the chosen channel (see `references/validation.md`). To change anything, edit `mono-agent.config.json` directly and run `mono-agent restart`; there is no live browser re-apply.

## When Config Is Not Enough

Config-first covers one responder served over any combination of the seven channels (webhook, OpenAI-compatible API, Telegram, Slack, WhatsApp, A2A, cron) plus sandbox, memory (lite with FTS-only recall, journal with hybrid BM25+vector recall + configured embeddings, or bujo with SQLite-indexed hybrid recall + LLM capture/reconcile + entity graph + auto-scheduled reflection/migration), and traceability. Drop to programmatic composition only for: custom `MonoRuntimeLike` implementations, request-scoped runtime extensions, tool approval gates, structured output schemas, multi-agent orchestration (`@mono-agent/agent-orchestrator`), custom channel message texts, or bespoke transports — `references/feature-coverage.md` lists which features are config keys and which are code-only. Read `references/package-map.md` for the package boundaries, and start from `startMonoAgentApp({ drivers, runtime, ... })` or `@mono-agent/agent-host` rather than re-writing lifecycle glue. For eval suites over the composed agent, use `@mono-agent/agent-evals`.

## Implementation References

- `references/discovery-questions.md` — the question sequence and which config keys each answer fills.
- `references/config-blueprint.md` — annotated `mono-agent.config.json` covering every section, plus the folder layout and programmatic escape hatch.
- `references/feature-coverage.md` — every framework feature mapped to config / CLI / code / dev-tooling coverage; the answer to "can the config do X?".
- `references/playbooks.md` — 13 end-to-end recipes (persona → config block → `init`/`validate`/`start`/smoke). Check for a matching recipe before hand-assembling a config.
- `references/package-map.md` — which package owns what, for programmatic composition and troubleshooting.
- `references/validation.md` — validation commands and per-channel smoke tests; read before claiming the agent works.

Human-facing companion: the published documentation site at
<https://robertsreberski.github.io/mono-agent/> (notably its Playbooks index and
Feature Matrix). The LLM-facing source of truth stays the in-repo markdown
(`docs/feature-registry.md` plus these `references/*` files) — these work offline
when the skill is bundled with `@mono-agent/agent-app`, so do not depend on the
live site being reachable.

## Done Criteria

- `mono-agent validate` exits 0 in the user's folder.
- `mono-agent start` runs, and the chosen channel's smoke test passed with a real response from the configured runtime.
- The config file matches what the user asked for: model + backups, channels, skills, MCP, memory, sandbox.
- Existing knowledge files are referenced, not duplicated or overwritten.
- No secrets are committed.
