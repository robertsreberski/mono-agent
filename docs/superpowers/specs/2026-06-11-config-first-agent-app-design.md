# Config-First Agent App — Design

Date: 2026-06-11
Status: Approved for implementation (autonomous goal run)
Branch: `feat/config-first-agent-app`

## Premise

An engineer loads the mono-agent composer skill into their harness (e.g. Claude Code),
inside any folder — empty or with existing knowledge (AGENTS.md, CLAUDE.md, docs). They
declare what they want in one config file: skills, MCP servers, communication channels,
memory strategy, sandbox policy, and an agent runtime with backup models. Then the mono
agent is constructed in that folder, largely from the config file, and it just works.

## Gap analysis (current state)

The building blocks already exist and are uniform:

- Every communication adapter exposes `loadXAdapterConfig({env, jsonPath})` +
  `startXAdapter(options) → Promise<{stop()}>` and a settings `FieldGroup`, and already
  reads its own section (`telegram`, `slack`, `a2a`, `webhook`, `openaiApi`, `cron`,
  `whatsapp`) from the same `mono-agent.config.json`.
- `@mono-agent/config` + `@mono-agent/agent-host` turn the core sections (runtime,
  context/skills, memory, tools/MCP, sandbox, artifacts, traceability, providers) into a
  running responder.
- `@mono-agent/agent-runtime` ships a native fallback router
  (`createRouterRuntime({host, chain})`) with a retryable-failure taxonomy and
  transcript-tail resume across providers.

What blocks the premise:

1. **No packaged host runner.** Only `demos/final-agent` knows how to compose the whole
   thing — ~1800 LOC of hand-written lifecycle glue (per-channel start/stop/status,
   config-apply queue, traceability wiring, CLI). Anyone composing an agent folder today
   must replicate it.
2. **No backup models in config.** The native router exists but is not reachable from
   `MonoAgentConfig`, `runtime-adapter`, or `agent-host`.
3. **The composer skill teaches glue-writing.** It walks an agent through hand-composing
   a TypeScript host instead of authoring a config file and running a CLI.
4. **No scaffolding/validation.** Nothing creates a working folder layout or explains
   which config section is wrong before runtime.

## Approaches considered

- **A. Package the host (chosen).** New `@mono-agent/agent-app` package generalizing the
  demo controller into a config-driven runner + `mono-agent` CLI (`init`/`validate`/
  `start`), `runtime.fallbackModels` wired through the native router, and a config-first
  rewrite of the composer skill.
- **B. Code-gen scaffolder.** Generate `host.ts` glue into the user's folder. Rejected:
  every folder forks the glue, fixes never propagate, contradicts "largely based on
  config file".
- **C. Console-first daemon.** Make the operator console the host. Rejected: operator
  surfaces must not own runtime hosting or transports (architecture rule).

## Design

### 1. `runtime.fallbackModels` (backup models)

- `packages/agent-runtime` (vendored upstream): `createRouterRuntime` additionally
  delegates `configureTools` / `disposeSession` / `disposeAllSessions` to its inner
  runtime so it satisfies the full `MonoRuntimeLike` surface.
- `packages/runtime-adapter`: `createMonoRuntime(options)` accepts an optional
  `fallbackChain: readonly {model, executionMode?}[]`. Each entry is validated at
  construction (parsed reference + execution-mode compatibility). When present, runs are
  served by `createRouterRuntime({host, chain})`; otherwise behavior is unchanged.
- `packages/config`: new optional `runtime.fallbackModels: readonly RuntimeModelReference[]`.
  Env `MONO_AGENT_FALLBACK_MODELS` (CSV of model reference strings), JSON bridge
  `runtime.fallbackModels: string[]`, field group entry, redaction passthrough.
- `packages/agent-host`: `createConfiguredAgentRuntime` builds the chain
  `[primary, ...fallbackModels]` when fallbacks are configured.

Failure honesty: the router only falls back on retryable provider failures and reports
`failoverHistory`; exhaustion surfaces as `provider_unavailable_exhausted`. No silent
model swaps — consistent with the "do not hide provider failures" rule.

### 2. `@mono-agent/agent-app` (new package, category `app`)

One responsibility: turn the folder's `mono-agent.config.json` into a running agent with
all configured channels, operator console, and traceability. Generalizes (and replaces)
the final-agent demo's controller.

- `app-config.ts` — aggregated loader over core + channel configs, combined
  `FieldGroup` list, config error union, redaction (generalized from the demo's
  `configuration.ts`). The file keys stay exactly as today (`runtime`, `context`,
  `memory`, `tools`, `sandbox`, `artifacts`, `traceability`, `providers`, plus channel
  sections `telegram`, `slack`, `a2a`, `webhook`, `openaiApi`, `cron`, `whatsapp`) so
  existing adapter loaders and the operator console keep working unchanged.
- `channels.ts` — a uniform channel-driver registry replacing five copies of the same
  state machine. A driver is:
  `{ id, label, loadConfig(input), disabledReason?(config), start(ctx) → {stop(), summary} }`
  where `ctx` provides the shared responder/runtime factory, logger, and the loaded
  channel config. Drivers: telegram, slack, a2a, webhook, openai-api, cron, whatsapp.
- `app.ts` — `startMonoAgentApp(options) → MonoAgentApp`: operator console first, then
  traceability, then all configured channels in parallel; per-channel status
  (`disabled` / `waiting_for_config` / `running` / `failed`), in-flight start dedupe,
  serialized `applyConfigChange` (stop → reload → restart, console URL/token stable),
  graceful `stop()`. DI factories per driver retained for tests.
- Catalog: new `app` category allowed to depend on every other category (the publishable
  analogue of `host-demo`). Communication adapters still cannot depend on it.

### 3. `mono-agent` CLI (bin of `@mono-agent/agent-app`)

- `mono-agent init` — scaffold the current folder non-destructively:
  `mono-agent.config.json` (minimal: runtime model placeholder, context, artifacts,
  webhook enabled as the zero-credential smoke channel), `IDENTITY.md` (seeded from
  existing AGENTS.md/CLAUDE.md/IDENTITY.md if found — referenced, not copied),
  `.mono-agent/` artifact/workspace dirs. Existing files are never overwritten.
- `mono-agent validate` — load every section and print a per-section report: core
  config errors, runtime support for primary and each fallback model
  (`describeMonoRuntimeSupport`), identity/skills/memory/MCP paths, channel configs
  (`running-ready` / `disabled` / `invalid: reason`). Exit non-zero on errors.
- `mono-agent start` — run `startMonoAgentApp` with SIGINT/SIGTERM handling and a
  human-readable status printout (generalized from the demo CLI).

### 4. Demo refactor

`demos/final-agent` keeps its public entry (`startFinalAgentDemo`) and the
`deploy:final` generator, but delegates controller + configuration to
`@mono-agent/agent-app`. Controller behavior tests move to the package; the demo keeps a
thin composition smoke test.

### 5. Composer skill rewrite (config-first)

`docs/skills/mono-agent-composer/` becomes harness-portable and config-first:

- Discovery questions map 1:1 to config sections (runtime + backups, channels, skills,
  MCP, memory, sandbox, observability).
- Composition flow: `mono-agent init` → edit `mono-agent.config.json` (+ `IDENTITY.md`,
  `skills/`, `mcp.json`) → `mono-agent validate` → `mono-agent start` → channel-matched
  smoke test. No hand-written host code unless the user needs custom programmatic
  composition (escape hatch documented, pointing at `@mono-agent/agent-host`).
- Works from any folder: instructions cover running the CLI from a cloned workspace
  (`pnpm --filter @mono-agent/agent-app exec mono-agent …` or a global link) until
  packages are published to npm.
- References updated: discovery-questions, package-map, validation; host-blueprint
  reframed around the app package with the programmatic path as an appendix.

## Error handling

- Config errors are typed per section and surface as `waiting_for_config` with the exact
  loader message; channels never half-start.
- Channel start failures are isolated: one failing channel does not block others.
- `validate` aggregates everything a human needs before first start.
- Fallback exhaustion and failover history are visible in run results/artifacts.

## Testing

- Unit: config fallback parsing, runtime-adapter chain validation, router delegation,
  driver registry behavior, init scaffolding (fresh + existing-knowledge folder),
  validate report shape.
- Behavior: app controller lifecycle with fake adapter factories (start/stop/apply-config
  paths) — moved/adapted from the demo's tests.
- Repo gates: `pnpm run check:architecture`, `typecheck`, `build`, `test`.
- Manual smoke: `init` + `validate` + `start` in a fresh temp folder with the webhook
  channel and a curl request.

## Out of scope

- Publishing to npm (separate release task; CLI is workspace-runnable today).
- Physical `packages/<category>/<name>` layout moves.
- Multi-agent (`demos/multi-agent`) migration onto agent-app — follow-up.
- New memory engines or sandbox engines.
