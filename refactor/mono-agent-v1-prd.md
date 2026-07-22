# Mono-Agent v1: Smaller by Design

Status: Proposed (revision 4 — full deletion-first rewrite)
Target release: 1.0 beta, followed by 1.0 stable
Last updated: 2026-07-22
Primary audience: maintainers, contributors, and individual agent builders
Decision scope: the complete v1 architecture, deletion ledger, feature migration, and production rollout

## 1. Executive summary

Mono-agent v1 is a config-first platform around independently selected agent runtimes and integrations: a small operational kernel, with runtimes, channels, memory, durable state, and operator surfaces living outside it as plugins and products. It is a clean public break from the v0 package graph and configuration model.

**The product of this refactor is a smaller system.** v0 is ~189,000 handwritten source lines across 22 packages; one package, agent-app, holds 66,000 of them. Stable v1 ships at **most 130,000 lines (−31%) across at most 23 packages**, with a kernel (core + plugin-sdk + cli) capped at **15,000 lines** — 18% of the 82,500-line coordination layer it replaces. These are machine-tracked release gates, not aspirations. The mechanism is deletion first: unused capabilities die before migration starts, duplicated machinery dies as its single replacement lands, and every migration slice names the v0 code it deletes.

This is not a feature-reduction project for the capabilities that matter: every behavior the production fleet exercises has a recorded v1 destination and a test-backed parity row. Capabilities nothing uses are deleted deliberately, recorded in the deletion ledger, and remain revivable as third-party plugins from a tagged v0 release once the plugin SDK exists.

The v1 distribution remains one pnpm monorepo releasing first-party packages in lockstep. A generated project owns an ordinary package.json and lockfile and installs only its selected runtime and plugins. The production proof is the sequential migration of Personal Agent and the A8C orchestrator, preserving their memory and never running duplicate Telegram or Slack consumers.

## 2. Deletion ledger

This section is normative. Every deletion names its evidence and revival path; every simplification names the outcome it preserves and the gate at which the old machinery dies. Usage evidence comes from the live fleet configurations (Personal Agent, A8C orchestrator, and the four A8C specialist workers), read 2026-07-22.

### 2.1 Phase A — delete on v0 main, before migration starts (gate G0.5)

Nothing in any fleet configuration references these. Deleting them first means they are never ported, never given a parity row, and never re-tested.

| Item | Source lines | Evidence |
| --- | --- | --- |
| whatsapp-adapter | 2,082 | No fleet config enables it; carries the baileys SDK dependency |
| a2a — NOT deleted | — | Kept first-party: four A8C workers serve bearer-authenticated A2A endpoints in production |
| memory-supermemory | ~700 | Both memory users run local BuJo |
| agent-orchestrator (extras) | ~500 | Zero references in either consumer repository; the A8C control broker is a separate service |
| self-config (proposal engine + patch allowlist + transaction) | ~1,900 | No fleet config enables it |
| presets/recipes registry | ~1,000 | Setup-time only; replaced by scaffolder templates at G1 |
| backfill (command + export mapping) | ~1,700 | One-shot migration tool that already ran |
| @anthropic-ai/sdk dependency in agent-runtime | 0 | Declared but never imported |

Phase A total: **~7,900 source lines plus ~6,000 test lines**, banked before any migration effort. Exit criteria: green v0 release tagged `v0-final-full` (the revival source), removed CLI commands print a migration message, TUI and web hide the self-config entry in the same change.

Revival policy: each deleted capability is listed in the plugin-candidates appendix (12.3). Anyone — including the maintainer — can revive one as an out-of-tree plugin against the published SDK, starting from the tagged source.

### 2.2 Phase B — simplify during migration (outcome kept, machinery replaced)

Each row is a paired deletion: the v1 replacement and the v0 deletion land at the named gate. Targets are budget ceilings tracked by the complexity report.

| Machinery | Now | Target | Gate | Preserved outcome / invariant |
| --- | --- | --- | --- | --- |
| Managed-closure background/launchd stack (closure copier, snapshots, worker leases, readiness probes, log rotation) | 14,350 | ≤2,500 in service-macos | G6–G7 | launchd execs the project-local install directly; validate-before-restart, honest status, no resurrection after stop |
| Setup wizard + init + provider-setup (three overlapping surfaces) | 12,500 | ≤3,000 in create-mono-agent | G1 | One schema-derived scaffolder; provider auth stays plugin-owned; bounded real route checks kept |
| doctor.ts orchestration | 3,517 | ≤500 in cli | G1 | Check inventory required: every current check maps to schema validation or a plugin diagnose(), or is explicitly retired here; exit codes and JSON shapes frozen (ops tooling parses them) |
| config-reference.ts (hand-maintained field mirror) | 1,357 | 0 | G1 | Deleted only when the schema-derived reference replaces it — no docs or `config` command gap on builds production installs |
| Continuations (18 files) | 5,206 | ≤1,500 in 4 files | G5 | Claim, leases, retry, cancel, namedRoutes delivery all kept; collapsed store must round-trip the orchestrator's live records or ship a one-shot migration |
| durable-history + pi compaction-driver/session-lifecycle | ~3,580 | ≤700 transcript in state-local | G3 | Pi-native sessions become the durability layer for pi routes; the transcript keeps appendVerbatimTurn, AskUser evidence, proactive isolation, and cross-family fallback context |
| memory command + health plumbing | 4,157 | ≤800 plugin CLI contribution | G5 | All maintenance verbs kept; logic lives in memory-local |
| memory rebuild/replay/forget internals | ~10,000 | ≤5,000 | G5 | Strict audit, rebuild, forget, intake retry untouchable; freeze-audit integrity modules retired only with explicit per-module sign-off |
| Presence/trace-source registry | 931 | ≤400 in state-local | G5 | Web discovery and service readiness keep working; Phoenix session-mapping (1,041) is NOT part of this cut — it stays intact with the export contribution |
| Threading/idempotency indexes | ~2,062 | per-channel KV on a shared helper | G4 | Delivery idempotency preserved per channel |
| Channel composition glue (6× repeated gate/config-view/controls) | 4,420 | ≤800 generic lifecycle in core | G4 | Per-channel status, steering controls, and config views survive via the SDK contract |
| App controller | 4,435 | ≤1,200 host loop in core | G1 | Host loop = load config → build responder → start channels → stop; everything else becomes plugin lifecycle contributions |
| config package (validate/view/env-keys/layered-loader) | 4,854 | ≤1,500 | G1 | One schema source; explicit $env references replace the ambient env overlay |
| Atomic-write ×5–6, three hand-rolled node:http servers, three express bootstraps | ~2,200 | secure-fs (~400) + http-server (~300) in plugin-sdk | G1–G4 | Express survives only in web; A2A moves onto the helper with byte-compatible auth semantics |
| Harness orchestration/responder/context/sessions | ~7,000 | ~3,000 in core | G1–G3 | Turn/session coordination is genuinely core |

Net effect with the ~15,000-line kernel and new package skeletons added back: **repo ≤130,000 handwritten source lines at stable**, tracked by a machine-generated report from G0.

## 3. Complexity budget

Baseline, measured on v0 source at this revision (handwritten TypeScript, excluding tests, dist, and generated files): ~189,000 lines / 22 packages; agent-app 66,400 (+58,600 tests); coordination layer being replaced (agent-app, agent-harness, agent-contracts, runtime-adapter) 82,500; agent-runtime 17,400 (46% shared harness); memory 22,700; parallel configuration machinery restating schema facts >8,000.

| Budget | Gate |
| --- | --- |
| Kernel: core + plugin-sdk + cli combined | ≤15,000 lines (core ~6,500, plugin-sdk ~4,000 incl. secure-fs and http-server helpers, cli ~3,500); exceeding requires a reviewed PRD amendment |
| Publishable packages | ≤23 as rostered in section 8; a 24th requires an amendment |
| Repository handwritten source at G8 | ≤130,000 lines; stable release is blocked above it |
| Config representations per field | Exactly one (the schema); the parallel machinery is deleted, not wrapped |
| Operator wire-contract implementations | Exactly one shared client |
| Native modules in first-party production closures | Zero, with one conditional exemption: memory-local keeps better-sqlite3/sqlite-vec until node:sqlite recall parity (loadExtension or blob+in-process cosine) is proven; the parity test is the acceptance gate for the swap |
| Minimal scaffold production dependency closure | Measured at the first G1 vertical slice; may not grow afterward without an amendment |

Rules carried over: **paired deletion** (every v1 mechanism names the v0 code it replaces and the gate at which it dies; add-only slices are rejected outside the plugin SDK and operator protocol greenfields) and **one implementation** (strangler coexistence means dual entry points over one converted-in-place implementation, never a forked copy; production consumers ride frozen published v0 releases, with a maintenance branch for critical fixes, while the source tree converts). Generated artifacts are excluded from budgets but must regenerate reproducibly in CI; a generated file that needs hand-editing counts as handwritten. Shared compliance suites replace duplicated per-integration tests, never stack on them.

## 4. Target architecture

### 4.1 Tiers and dependency direction

    products ───────► core ───────► plugin-sdk
       │               ▲
       ├──────────────►│
       └──────────────► plugins ──► plugin-sdk

Core depends only on the plugin SDK and general-purpose utilities. Plugins depend on the SDK and, where declared, another capability package. Products compose core and selected plugins. Core never imports a concrete plugin or product. The architecture checker (extending the existing check:architecture and package catalog) rejects: core dependencies on any runtime, channel, memory implementation, database, exporter, UI framework, or service manager; plugins importing application internals; renderers importing runtime or channel implementations; catalog edits as a requirement for loading third-party plugins; circular capability requirements.

### 4.2 Core responsibility

Core owns: project/config loading; project-local plugin resolution; schema composition with value provenance; plugin lifecycle in dependency order; request, turn, and session coordination; context and skill composition; concurrency, pending-run bounds, cancellation, backpressure; live-input admission and settlement; runtime route selection and fallback; adapter-neutral tool/approval/MCP/sandbox policy negotiation; structured events; health aggregation; graceful shutdown. Core does not own: provider SDKs or auth; chat transports; memory algorithms; storage formats; exporters; UIs; wizards; OS services; package installation.

### 4.3 Plugin kinds and host ports

Each plugin declares one primary kind: **runtime, channel, memory, tool, or extension**. The first four are full stable contracts with compliance suites at 1.0. An extension plugin implements narrow host ports instead of a bespoke contract: history store, run recorder, event exporter, discovery registry, sandbox engine, continuation store. One package may ship several port implementations when they share one storage discipline; the port interface, not the package boundary, is the contract. Any plugin may contribute diagnostics and namespaced CLI commands scoped to its own data.

Plugins are trusted, in-process project dependencies; the loader does not claim to isolate malicious code, and documentation must say so.

### 4.4 Continuations: core tool, extension coordination

The continuation *tool surface* (a run creating a claim) lives in core. Continuation *coordination* — claims, leases, synthesis, retry, dead letters, namedRoutes delivery — ships as a first-party extension in state-local, built on two bounded capability ports that core grants explicitly:

- `enqueueRun(request)` — admission through the normal run queue, origin-bound and rate-limited;
- `deliver(destination, payload)` — the same authorized proactive-delivery path cron uses, destinations validated against channel allowlists.

These two ports are the uniform answer for every scheduler-shaped behavior (memory consolidation rituals, retention sweeps, future digests); none of them ever becomes a core amendment.

### 4.5 Path-based single-file plugins

`use` accepts a project-relative ESM path (`"use": "./plugins/foo.mjs"`) as an equal alternative to a package reference. A 50-line file exporting definePlugin is a working plugin — no packing, no publishing. Path plugins are recorded by content digest in the service installation marker so drift detection stays honest.

## 5. Public contracts

### 5.1 Plugin definition

    definePlugin({ manifest, schema, create })

Manifest: id, apiVersion (exactly 1), version, kind (runtime | channel | memory | tool | extension), optional capability requirements, one-line description. `create` receives validated config and a capability-scoped context (logger, lifecycle signal, clock/id helpers, event publication, declared host capabilities, granted paths — and, when declared and approved, the section 4.4 ports). It returns the primary contribution plus optional diagnostics, CLI commands, and cleanup. The context never exposes an application controller, mutable registry, or undeclared integrations.

### 5.2 Host entry points

- `loadAgentProject(options)` — parse strict JSON, resolve plugins (direct dependencies or project paths only), compose schemas, resolve explicit sources with provenance, validate everything before any contribution initializes.
- `validateAgentProject(project)` — structural readiness; non-zero exit for every missing package, secret, or capability.
- `createAgentHost(project)` — run (one-shot), start, health, stop (drain, reverse-order plugin shutdown, idempotent dispose).

### 5.3 Runtime contract

One plugin per family: runtime-pi, runtime-claude (SDK and CLI modes), runtime-codex, runtime-opencode. The normalized contract preserves streaming events, final/structured results, usage/cost/model/effort metadata, tools and MCP, approvals, cancellation, acknowledged live input, provider session lifecycle, compaction records, bounded diagnostics, and classified failures (the existing taxonomy). Configuration, authentication, permission, policy, unsupported-capability, and invalid-request failures are terminal; fallback advances only on classes the route policy marks retryable. Cross-runtime routing is core's.

**Leverage-native rule** (per the pi-upstream-recon discipline): pi 0.80.6 ships session persistence, compaction primitives, provider auth, model catalogs, and stream retry. runtime-pi delegates to them and shrinks to a thin binding (target ≤2,200 from 3,376 plus harness share); the hand-rolled compaction-driver and session-lifecycle layers die at G3. Other bridges keep their own native session handling; no shared session-lifecycle driver survives.

**History tiering**: for pi routes, the pi session repo is the durability layer. The runtime-neutral transcript (≤700 lines, state-local) exists for what provider sessions cannot cover: cross-family fallback context, channel history replay, cold start, verbatim appends, AskUser evidence, proactive isolation. It is required exactly when routes span runtime families or sessions are per-message — and it is deliberately not stored in pi's format, so a pi version bump can never strand production history.

### 5.4 Channel contract

Channels validate and redact their own config; emit normalized inbound requests; manage reply streams; declare attachment/live-input/AskUser/proactive/runtime-control capabilities; enforce their own allowlists and transport auth; expose bounded health; stop idempotently. **Fail-closed boundary**: configuration, authentication, and structural failures are validation or start errors. Transport-level failure — at start or later — is visible degradation with bounded recovery, exactly as production behaves today; a degraded channel never reports healthy while disconnected and never takes down an otherwise healthy agent. The SDK channel contract is an evolution of the proven channels.plugins ChannelDriver seam already running the extras in production.

### 5.5 State and durability

Core coordinates state but never picks a storage format. Every durable contribution documents: ownership boundary, atomicity and idempotency, schema versioning, retention, backup/restore, reset/purge surface, corruption behavior, redaction. Crash-boundary tests prove atomic completion or explicit recoverable state; unknown delivery stays unknown.

## 6. Configuration

Canonical file: `mono-agent.config.json` — strict JSON, `configVersion: 1`, agent envelope (identity, instructions, runtime routes by plugin instance id, session, concurrency), `plugins` keyed by instance id with `use` (package name or project path) and `config`, and policy (tools). Unknown fields are errors. Paths resolve relative to the config file.

One executable Zod 4 schema per plugin is the only handwritten definition; types, validation, defaults, composed JSON Schema, editor completion, redaction, `config explain` provenance, setup prompts, and reference documentation all derive from it. No v1 package may introduce a parallel field registry, env-key map, or handwritten reference table.

Sources and precedence: JSON is authoritative; environment values never override implicitly; an explicit `{"$env": "NAME"}` source may replace a schema-approved scalar; a present reference with no value is an error; secret-marked fields reject inline values. The CLI loads `.env` beside the config (or `--env-file`) into a secret environment consulted only for named references. No interpolation, inheritance, profiles, or hot reload; alternate profiles are separate files selected by `--config`. Memory has one mode: BuJo, with embeddings optional (absent embeddings means FTS-only recall).

Commands: `validate` (strict, non-zero on any missing selected package/secret/capability — the current waiting-state escape is closed), `doctor` (validate plus bounded plugin diagnostics; never starts long-lived channels), `config schema --write`, `config explain`, `add` (exact dependency + config stub + schema regen), `init` (delegates to the scaffolder).

## 7. Operator product

Three names, three roles — kept deliberately distinct:

- **channel-operator** is the endpoint *inside each agent* — a normal channel plugin serving the operator protocol over loopback HTTP. It exists even when no UI is attached.
- **operator** is the *client library* — protocol schemas, one client, capability negotiation, view models, golden fixtures — that every UI imports.
- **tui** and **web** are *renderers* that consume operator to reach any agent's channel-operator endpoint.

**The wire stays exactly as it is**: plain HTTP routes (info, turns, cancel, verbatim, live-input, ask) with the turn response streamed as NDJSON, and client-disconnect-aborts-turn semantics preserved (the durable web service may assume ownership). An SSE redesign was evaluated and rejected: EventSource cannot POST, the restructure would break disconnect-abort semantics and add per-subscriber buffering, and the browser never talks to agents directly anyway. A future transport swap remains possible behind the shared client, out of v1 scope.

What changes is ownership: today web re-implements the wire contract by hand with no dependency on the shared package, so the surfaces can drift. v1 requires both renderers to consume the operator package for every wire interaction, event decode, and capability decision, verified by golden fixtures decoding to equivalent view models in both. Renderer-local presentation state stays renderer-owned; no shared controller/reducer layer is mandated, and deeper unification is a post-v1 direction, not a gate. The protocol covers the complete current action surface: discovery/selection/pinning, conversation lifecycle, turns, live input with settlement, cancellation, AskUser, model/effort overrides, attachments, quoting, config/replay/health views, renderer exit without stopping the agent.

Web keeps its durable SQLite store (node:sqlite), active-turn survival, notifications, and host/origin safety. TUI keeps pi-tui rendering and terminal UX. Platform-only behavior stays adapter-owned.

## 8. Package and CLI disposition

### 8.1 v1 package roster — exactly 23

| Tier | Packages |
| --- | --- |
| Core (3) | plugin-sdk (contracts, schema helpers, compliance kit, secure-fs, http-server), core, cli (router, core commands, managed project-skill maintenance) |
| Runtimes (4) | runtime-pi, runtime-claude, runtime-codex, runtime-opencode |
| Channels (7) | channel-telegram, channel-slack, channel-webhook, channel-openai-api, channel-cron, channel-a2a, channel-operator |
| Capabilities (3) | memory-local, state-local (transcript, recorder, presence, continuation store and coordination, OTLP/Phoenix export with session-mapping intact), sandbox-srt |
| Products (6) | operator, tui, web, service-macos, create-mono-agent, docs-mcp |

Retired v0 names: agent-app, agent-contracts, agent-harness, agent-runtime (split), config, observability (absorbed into state-local), runtime-adapter, operator-adapter (split), plus the Phase A deletions. The planned exporter-otlp package is cancelled — 530 lines is a contribution, not a package. Per-package ceremony (responsibility docs, API inventories) is generated from owned metadata; a package's maintenance cost is its source, not its paperwork.

### 8.2 CLI disposition (from 20 v0 command names)

| Command | v1 disposition |
| --- | --- |
| init / setup (alias) | Scaffolder-backed; alias preserved |
| validate / doctor | cli, per section 6; check inventory guarantees no silently dropped check |
| auth | Top-level verb preserved, routed to installed runtime plugins |
| sandbox | Top-level verb preserved, routed to sandbox-srt |
| config | explain / schema / helpers; never a mutation system |
| start / restart / stop / status / logs | core + service-macos; honest process and provenance reporting |
| tui / web | Renderer launchers |
| install-skill | cli (managed copies, transactional, docs-mcp pairing) |
| runs | state-local contribution |
| memory | memory-local contribution |
| continuations | state-local contribution over the continuation store |
| presets, backfill | Deleted (Phase A); command prints a migration message in v0-final |

Plugin commands are namespaced contributions discovered from project dependencies; collisions are errors; the CLI hardcodes no provider, channel, or backend details.

## 9. Parity ledger — generated, kept features only

Requirement IDs live in one machine-readable file; every verifying test declares the IDs it evidences; CI generates the ledger report (requirement → owner → passing tests). A requirement with zero passing tagged tests fails the gate. A tag naming a deleted requirement fails the build. Stable v1 requires every row green. The inventory (~68 rows at outcome granularity; detail lives in the tagged tests):

**Core (13)**: deterministic context composition; skill loading with disclosure modes and byte limits; request/reply/AskUser/attachment normalization; tool and MCP policy intersection without privilege widening; concurrency and bounded pending admission; continuous and per-message sessions with idle expiry, daily rollover, timezone, proactive isolation; canonical history commit only after settlement, with AskUser evidence; live input via acknowledged capability with normal-turn fallback; proactive delivery to the exact authorized destination with verbatim mode and NOTHING_TO_REPORT suppression; request-scoped RunHistory tool; programmatic embedding without the CLI; effort keywords and request-level model/effort overrides; explicitly selected channel send tools with default-deny.

**Runtimes (12)**: pi SDK execution incl. OAuth/API-key resolution, tool steering, durable sessions; Claude SDK mode; Claude Code CLI mode; Codex app-server; OpenCode app-server with stable-CLI guard; Ollama/LM Studio/OpenAI-compatible local providers with URL policy and no hosted fallback; ordered same- and cross-runtime fallback with capability checks and typed failures; tool/Bash/MCP/output bounds; compaction thresholds, records, and events; explicit approval gates that no incapable route can convert to allow-all; plugin-owned provider setup/auth/model discovery; provider errors with cause and no secret leakage.

**Channels — shared compliance (1)**: every channel passes the shared suite for its advertised capabilities: normalization, allowlists, AskUser, steering, proactive/verbatim delivery idempotency, health, idempotent stop, redaction.

**Telegram (2)**: polling, media and voice transcription with adversarial-filename safety; in-place activity rendering, live steering, commands. **Slack (2)**: single Socket Mode consumer, threads and conversation identity across all flows, assistant-thread status with reaction fallback and transient tool ledger; shortcuts, App Home, final-only/silent-delivery limits stated honestly. **Webhook (1)**: multiple named endpoints with per-endpoint auth/prompt/model/effort/sync-async/timeout and the async status contract. **OpenAI API (2)**: model discovery and streaming/non-streaming Chat Completions with correct SSE/JSON termination and conversation-identity precedence; bounded image bridging, sampling-field warnings, host-tool rendering. **Cron (2)**: JSON and Markdown jobs, five-field/timezone validation, duplicate rejection; skip/queue/replace/overflow/watchdog result taxonomy. **A2A (2)**: valid Agent Card and task endpoint with bounded auth and production-record-compatible idempotency; remote discovery and consumption without core dependency. **Operator channel (1)**: protocol, frame bounds, abort-on-disconnect, capability advertisement.

**Memory (5)**: SQLite identity, migrations, ownership checks, corruption reporting; BuJo recall with and without embeddings (vector + FTS, dimension checks, circuit breaker, keyword fallback); capture/admission with completed-turn idempotency; host-agent or Ollama memory LLM behavior and consolidation schedules; strict audit, preview, rebuild, backup, forget, intake retry.

**State (4)**: atomic canonical transcript with duplicate protection, provider-session linkage, verbatim append, AskUser evidence; run recording with summaries, retention, runs CLI, stale-run classification, memory-run separation; owner-private presence with stale detection; per-channel delivery-idempotency indexes.

**Continuations (2)**: claim capabilities, origin binding, deadlines, size limits, durable leases, retries, cancellation, dead letters, namedRoutes delivery — round-tripping live production records; operator list/status/retry/cancel/resolve without token exposure.

**Security and sandbox (5)**: no inline secrets, redaction everywhere including generated docs; owner-only file writes with symlink/ownership checks where currently promised; shared HTTP hardening (bind, bearer, Host/Origin, limits, shutdown); tool-policy monotonicity across fallback; SRT off/native modes, network policy, fail-closed integrity.

**Operations (4)**: start only after validate with process exclusivity; project-local pinned launch with drift-detecting provenance; launchd install/start/restart/stop/status with bounded recovery and no resurrection after stop; bounded logs, honest health aggregation with typed causes and no fake waiting success.

**Operator surfaces (4)**: every wire interaction through the shared client (dependency gate + golden fixtures); structured presentation of answers, reasoning, tools, warnings, compaction, usage, cost, failover; feature checklist per renderer (discovery, conversations, model/effort, cancel, live input, AskUser, quote, attachments, config, replay, health); web durability (threads, uploads, active-turn survival, invalidation, deletion rules).

**Setup (3)**: scaffold contains only selected dependencies with exact versions, lockfile, schema, env example; interactive provider discovery/auth with bounded real route checks and honest noninteractive behavior; transactional dotenv/file creation with review and no fake readiness.

**Contributor (3)**: external plugin (package or path) runs without any core/catalog edit; package docs generated from metadata with drift gates; lockstep release with apiVersion/peer compatibility checks and packed-consumer verification.

## 10. Data migration and rollback

Continuity policy: **memory only**. Preserved: canonical memory roots, BuJo content, SQLite data and identifiers, embedding metadata, unresolved intake. Not imported: conversation history, provider transcripts, run artifacts, continuation ledgers (recreated compatibly per section 2.2), web conversations, service logs. Old state stays read-only through the rollback window; v1 uses distinct non-memory state directories.

Memory cutover per consumer: freeze the on-disk format until both consumers complete beta; audit, back up, rehearse against a copy (recall parity, one capture, one duplicate-admission check, one rebuild); prove the old reader still opens the canonical format; cut over with a final audit; keep the backup until the window closes. Any audit failure or format mutation blocks cutover.

Config migration: no v0 parser; each consumer gets an explicitly authored v1 config, exercised side-by-side via `--config` with separate service labels, alternate ports, and Telegram/Slack disabled during shadow. Cutover windows are scheduled at a session rollover boundary. A migration guide maps every v0 field; no permanent automatic converter.

service-macos: records absolute validated paths (node, project-local CLI, project root, config, logs) and a drift marker (node version, package versions, digests of package.json, lockfile, config, service definition). It never installs dependencies. Install stages and promotes atomically; restart validates the replacement first; stop proves unload and process death; explicit stop disables recovery. Rollback: stop and prove death of v1, verify memory audit, reload the retained v0 definition, prove its health, record the reason. Immediate rollback triggers: duplicate Telegram/Slack consumption, memory loss or corruption, unprovable process identity, auth failure hidden by fallback, healthy-while-unavailable, missed schedule without explicit failure, crash loop, secret in any artifact.

## 11. Delivery gates

| Gate | Content | Exit evidence |
| --- | --- | --- |
| G0 — commitment | ADR ratifying ownership boundaries and this deletion ledger; baselines regenerated from the existing package catalog, drift tests, and CLI registry; complexity report wired into CI | Reviewed ADR; baseline #1 recorded (~189k) |
| G0.5 — v0 shrink | All Phase A deletions on v0 main while production runs untouched | Green tagged `v0-final-full`; repo ~181k; migration messages in place |
| G1 — skeleton | plugin-sdk beta (definePlugin, ports, compliance kit, secure-fs, http-server), schema-composed config, project-local + path plugin loader, core host loop, CLI shell, external hello plugin, one real vertical slice (Pi + webhook); paired deletions: wizard, doctor orchestration, config-reference, config machinery, app-controller | Packed clean-project smoke; kernel report ≤15k; check inventory published |
| G2 — operator foundation | Protocol schemas + shared client + fixtures over the existing NDJSON wire; channel-operator; both renderers consume the shared client | Golden fixtures pass in both; no independent wire client remains |
| G3 — runtimes | Extract four runtime plugins; pi-native session/compaction delegation; neutral transcript in state-local; paired deletions: durable-history, compaction-driver, session-lifecycle | One live smoke per family; cross-family fallback tests green |
| G4 — channels | Telegram, Slack, webhook, OpenAI API, cron, A2A on the SDK contract; shared compliance suite; paired deletions: channel glue, threading indexes, express bootstraps | Channel rows green incl. bounded live smokes; A2A record-compat proven |
| G5 — memory, state, safety | memory-local (BuJo-only) without format change; state-local extraction; continuations collapse onto the ports (prerequisite: a captured week of orchestrator records round-trips); sandbox-srt | Memory/state/continuation/sandbox rows green; durable-state review complete |
| G6 — products and release | Scaffolder, service-macos (managed-closure deletion), docs rebuild, lockstep release pipeline adapted; migration guide | Clean npm/pnpm scaffolds from packed artifacts; live macOS service smoke |
| G7 — production beta | Publish beta; shadow then cut over Personal Agent, then A8C orchestrator; 24-hour soaks; single-consumer proof for Telegram and Slack | Consumer evidence records; rollback proven |
| G8 — stable | Ledger fully green; ≤130k and ≤15k proven; stable publish; v0 deprecation; v0 removal after 30-day window | Complexity report below budget; post-launch review |

## 12. Risks, non-goals, and revival appendix

### 12.1 Risks

| Risk | Mitigation |
| --- | --- |
| Continuations collapse breaks the orchestrator's namedRoutes flow | Week-of-records capture is a G5 entry prerequisite; collapsed store must round-trip live records; no origin mode deleted until proven unexercised |
| OpenAI API regression during the express→helper move (both consumers use it) | Golden SSE-termination and Open WebUI fixtures pass on the helper-mounted implementation before either cutover |
| Pi-native leaning couples history to pi's release cadence | The neutral transcript is deliberately not in pi's format; frozen v0 durable-history stays readable through the rollback window |
| Doctor/status shrinkage breaks ops tooling that parses output | Exit codes and JSON shapes frozen as contract; check inventory forbids silent drops |
| Memory simplification deletes recently added integrity machinery | Per-module sign-off required; cutover audit must pass on real stores |
| Aggressive deletion removes something an unknown consumer used | Pre-OSS there are no external consumers; fleet configs are the authority; `v0-final-full` preserves everything |
| Rewrite ends larger than v0 | Paired-deletion rule, one-implementation rule, CI-tracked report, stable blocked above 130k |
| Kernel outgrows its cap under pressure | 15k is a hard gate; amendment requires review, and the ports pattern (4.4) gives overflow features a home outside core |

### 12.2 Non-goals

Backward-compatible v0 config parsing; v0 API shims; independent per-package versioning (lockstep stays; third-party compatibility rides SDK apiVersion + peer ranges); plugin sandboxing; hosted marketplace; importing v0 run artifacts or transcripts; new end-user capabilities during migration; TUI/web rewrites beyond the shared client; operator transport changes; hot reload; Windows/Linux service managers; fleet-wide A8C worker migration during v1 (workers stay on frozen v0 releases; their A2A surface is why channel-a2a is first-party).

### 12.3 Plugin-candidates appendix (revival from `v0-final-full`)

Deleted capabilities that the OSS launch advertises honestly as community-plugin opportunities against the published SDK: WhatsApp channel, Supermemory backend, collaborator-orchestration tools, conversational self-configuration, run backfill/export tooling. Each lists its tagged source location; none blocks any v1 gate.

### 12.4 PRD maintenance

This document is the decision source until the G0 ADR and generated ledger exist; thereafter architectural decisions live in the ADR, status lives in the generated report, and product-decision changes update this PRD through review. Release criteria may tighten but never weaken without explicit approval. Examples never contain real consumer identifiers or secrets. Any v0 feature merged after this revision must be added to the requirement inventory or explicitly excluded through a reviewed amendment before stable v1.
