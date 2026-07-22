# Mono-Agent v1: Smaller by Design

Status: Proposed (revision 5 — reviewed deletion-first execution contract)
Target release: 1.0 beta, followed by 1.0 stable
Last updated: 2026-07-22
Primary audience: maintainers, contributors, and individual agent builders
Decision scope: the complete v1 architecture, deletion ledger, feature migration, and production rollout

## 1. Executive summary

Mono-agent v1 is a config-first platform around independently selected agent runtimes and integrations: a small operational kernel, with runtimes, channels, memory, durable state, continuations, exporters, and operator surfaces living outside it as plugins and products. It is a clean public break from the v0 package graph and configuration model.

**The product of this refactor is a smaller system.** The provisional v0 baseline is ~189,000 handwritten production-source lines across 22 publishable packages; one package, agent-app, holds 66,000 of them. Stable v1 ships at **most 130,000 lines (at least 31% below the normalized G0 baseline)**, with core + plugin-sdk + cli capped at **15,000 lines**. These are machine-tracked release gates, not aspirations. The mechanism is deletion first: deliberate product cuts are archived before source deletion, duplicated machinery dies as its single replacement lands, and every migration slice names the v0 code it deletes.

Package count is not a success metric. The current v1 roster has 25 publishable packages because continuation coordination and OTLP export have ownership and lifecycle boundaries distinct from local state. Architecture gates protect narrow responsibilities and selected dependency closure; they never force unrelated capabilities into one package merely to hit a count.

Every kept behavior has an atomic, test-backed requirement. Deliberately removed capabilities are recorded as product decisions with an archive and revival path; lack of a config reference is evidence only for config-selected features, never for CLI- or interaction-invoked behavior.

The v1 distribution remains one pnpm monorepo releasing first-party packages in lockstep. A generated project owns an ordinary package.json and lockfile and installs only its selected runtime and plugins. The production proof is the sequential migration of Personal Agent and the A8C orchestrator, preserving memory and continuation control state and never running duplicate Telegram or Slack consumers.

Stable v1 must also prove that smaller means easier:

- a minimal Pi + webhook project installs no unselected channel, UI, memory, exporter, service, or native module and completes one real turn from generated instructions;
- `config explain` identifies the owning schema, effective source, and safe remediation for every resolved value;
- one package plugin and one single-file path plugin pass the same compliance contract without a core or catalog edit;
- TUI and web produce the same operator domain state and available actions from shared fixtures while retaining platform-native presentation;
- both production consumers pass their capability matrix, 24-hour soak, rollback rehearsal, and single-consumer proofs.

## 2. Deletion ledger

This section is normative. Every deletion names its evidence or explicit product decision, replacement when one exists, archive source, and gate. Usage evidence includes configuration, public CLI and flags, service definitions, scheduled jobs, source imports, persisted operational state, and the selected production-consumer matrix; fleet configuration alone is not proof that an interaction-invoked capability is unused.

### 2.1 Archive and detach the live source before deletion (gate G0.25)

The current `main` checkout is a live source for the local CLI and Personal Agent, so Phase A cannot begin while a consumer still resolves code from it.

1. Cut the final full v0 as a normal semver lockstep release, using the repository's existing `vX.Y.Z` workflow. This exact published version is called **v0-final** below.
2. Create `archive/v0-final-full` at that exact release commit and a `v0-maintenance` branch for critical fixes. The archive tag deliberately does not match the release workflow's `v*` trigger.
3. Pin the local CLI, Personal Agent, A8C orchestrator, and any worker currently linked to repository `main` to the exact published v0 release.
4. Prove each named consumer's resolved package version, process command, config path, channel ownership, memory health, and bounded startup health.
5. Record revival source paths for every Phase A capability.

Any consumer still resolving repository `main` blocks G0.25. The full archive precedes every deletion, so it actually contains the code it promises to preserve.

### 2.2 Phase A — delete on v0 main after G0.25 (gate G0.5)

| Item | Provisional source lines | Evidence or explicit decision | Replacement / revival |
| --- | --- | --- | --- |
| whatsapp-adapter | 2,082 | No selected v1 production consumer uses it; removes the Baileys dependency | Community channel candidate from `archive/v0-final-full` |
| a2a — NOT deleted | — | Four A8C workers serve authenticated A2A and the orchestrator consumes them | First-party `channel-a2a` |
| memory-supermemory | ~700 | Explicit v1 product cut; selected v1 consumers use local BuJo | Community memory candidate from the archive |
| agent-orchestrator (extras) | ~500 | Explicit v1 product cut; the A8C control broker is a separate service | Community tool candidate from the archive |
| self-config proposal engine, patch allowlist, transaction, `tui --configure`, and related UI | ~1,900 | Explicit v1 product cut. It is interaction-invoked, not config-enabled; deletion is not justified as non-use | Schema-derived init, `config explain`, generated docs; conversational mutation may be revived as a separate product |
| backfill command and export mapping | ~1,700 | Explicit v1 product cut; stable v1 provides live OTLP export but no historical resend promise | Archived tool candidate; v0 command prints the archive/revival guidance |
| `@anthropic-ai/sdk` dependency in agent-runtime | 0 | Declared but never imported | None |

The G0 complexity report replaces provisional counts with exact source and test counts. Exit criteria: the lean v0 tree is green, removed CLI/flag surfaces return precise migration guidance, and TUI/web remove SELF-CONFIG affordances in the same change. No v1 mechanism is added during G0.5.

### 2.3 Phase B — paired replacement and deletion during migration

Each row lands the single v1 implementation and deletes or retires the named v0 machinery in the same gate. A temporary compatibility entry point may call the converted implementation; a forked copy is forbidden.

| Machinery | Now | Planning target | Gate | Preserved outcome or explicit cut |
| --- | --- | --- | --- | --- |
| Managed-closure background/launchd stack | 14,350 | ≤2,500 in service-macos | G6–G7 | Project-local pinned launch; validate-before-restart, honest status, no resurrection after stop |
| Setup wizard + init + provider setup | 12,500 | ≤3,000 in create-mono-agent | G1 | One schema-derived scaffolder; plugin-owned auth; bounded real route checks |
| Presets registry and `presets` command | ~1,000 | 0 after templates land | G1 | Selected-stack scaffolder templates replace it before deletion; no main-branch setup gap |
| `doctor.ts` orchestration | 3,517 | ≤500 in cli | G1 | Every check maps to core schema validation, plugin `diagnose()`, or an explicitly reviewed retirement; exit codes and JSON shapes stay stable |
| `config-reference.ts` | 1,357 | 0 | G1 | Schema-derived reference and `config explain` exist in the same slice |
| Continuation service, store, and workers | 5,206 | ≤2,500 in `continuations` | G5 | Claims, pinned origin context, leases, synthesis, retry, cancellation, unknown delivery, named routes, CLI, and current on-disk format stay intact |
| Durable history + Pi compaction/session drivers | ~3,580 | ≤700 neutral transcript plus native runtime bindings | G3 | Neutral transcript is canonical for every runtime; Pi owns Pi-native session and compaction details |
| Memory command + health plumbing | 4,157 | ≤800 plugin CLI contribution | G5 | All retained BuJo maintenance verbs move to memory-local |
| Memory rebuild/replay/forget internals | ~10,000 | ≤5,000 | G5 | Strict audit, rebuild, forget, and intake retry are preserved; integrity modules need per-module sign-off |
| `lite` and `journal` memory modes | Measured at G0 | 0 | G5 | Explicit v1 product cut. No automatic conversion; any remaining journal consumer stays on frozen v0 unless separately migrated to BuJo |
| Presence/trace registry | 931 | ≤400 in state-local | G5 | Discovery and service readiness remain |
| OTLP/Phoenix export and session mapping | ~1,571 | Focused `exporter-otlp` contribution | G5 | Live export and session mapping remain separate from local state ownership |
| Threading/idempotency indexes | ~2,062 | Per-channel KV on a shared state-local helper | G4 | Delivery idempotency remains per channel |
| Channel composition glue | 4,420 | ≤800 generic lifecycle in core | G4 | Per-channel health, steering, and config views survive through the SDK |
| App controller | 4,435 | ≤1,200 host loop in core | G1 | Load → validate → initialize → serve → drain → stop |
| Config package | 4,854 | ≤1,500 | G1 | One core envelope schema plus one schema per plugin; explicit `$env` replaces ambient overlay |
| Repeated atomic-write and HTTP bootstraps | ~2,200 | secure-fs + http-server helpers in plugin-sdk | G1–G4 | Express remains only in web; security semantics stay fixture-compatible |
| Harness orchestration/responder/context/sessions | ~7,000 | ~3,000 in core | G1–G3 | Turn/session coordination remains genuinely core |

Net effect with the kernel and focused package skeletons added back: repository handwritten production source is at most 130,000 lines at stable, tracked from G0.

## 3. Complexity and maintainability budget

The current ~189,000-line figure is provisional until G0 commits `scripts/v1-complexity-report.mjs` and baseline report #1. The report operates only on Git-tracked files and emits the exact included-file manifest, classification, line count, and digest. Every executable source file is classified as production, test, generated, vendored, or excluded-with-reason; an unclassified source file fails CI.

Production and test source are reported separately. Reducing tests never satisfies the production-source budget. Physical lines include comments and blanks so the calculation is deterministic. Generated files are excluded only when their generator and reproducibility check are recorded; a generated file requiring hand edits is production source. The baseline report records its exact Git SHA and the same classifier is used at every later gate.

| Budget | Gate |
| --- | --- |
| Kernel: core + plugin-sdk + cli combined | ≤15,000 production-source lines; exceeding requires a reviewed PRD amendment |
| Repository production source at G8 | ≤130,000 and at least 31% below normalized baseline; stable is blocked if either condition fails |
| Package responsibilities | One coherent ownership/lifecycle boundary per package; package count is reported but is not a release gate |
| Config representations per field | Exactly one authoritative schema field; generated projections do not count as additional representations |
| Operator wire and domain implementations | One shared wire client and one shared set of domain state machines; renderer presentation remains local |
| Native modules | Minimal no-memory scaffold has zero. Memory-local may retain only `better-sqlite3` and `sqlite-vec` through v1 stable; no other first-party production closure gains a native module |
| Minimal scaffold dependency closure | Measured at the first G1 vertical slice and may not grow without a reviewed dependency-budget change |

The Node `node:sqlite`/vector swap is post-v1 work unless parity is proven early; stable does not risk memory integrity merely to claim zero native modules. The report also tracks public exports, dependency edges, circular edges, config fields, and duplicated protocol/config implementations so line reduction cannot hide a larger or less maintainable surface.

Rules: **paired deletion**, **one implementation**, and **boundary before budget**. A line or package target never justifies mixing unrelated lifecycles, weakening reliability, deleting required tests, compressing readable code, or bypassing an acceptance requirement. Shared compliance suites replace duplicated per-integration tests; they do not simply stack on top.

## 4. Target architecture

### 4.1 Tiers and dependency direction

    products ───────► core ───────► plugin-sdk
       │               ▲
       ├──────────────►│
       └──────────────► plugins ──► plugin-sdk

Core depends only on the plugin SDK and general-purpose utilities. Plugins depend on the SDK and, where declared, another capability package. Products compose core and selected plugins. Core never imports a concrete plugin or product. The architecture checker (extending the existing `check:architecture` and package catalog) rejects: core dependencies on any runtime, channel, memory implementation, database, continuation coordinator, exporter, UI framework, or service manager; plugins importing application internals; renderers importing runtime or channel implementations; catalog edits as a requirement for loading third-party plugins; circular capability requirements.

### 4.2 Core responsibility

Core owns: project/config loading; project-local plugin resolution; schema composition with value provenance; plugin lifecycle in dependency order; request, turn, and session coordination; context and skill composition; concurrency, pending-run bounds, cancellation, backpressure; live-input admission and settlement; runtime route selection and fallback; adapter-neutral tool/approval/MCP/sandbox policy negotiation; structured events; health aggregation; graceful shutdown. Core does not own: provider SDKs or auth; chat transports; memory algorithms; storage formats; exporters; UIs; wizards; OS services; package installation.

### 4.3 Plugin kinds, contributions, and host ports

Each plugin declares one primary kind: **runtime, channel, memory, tool, or extension**. The first four are stable contracts with compliance suites at 1.0. An extension implements one or more narrow **contribution ports** consumed by the host or a product: transcript store, run recorder, event exporter, discovery registry, sandbox engine, continuation coordinator, or request-scope capability provider. In the opposite direction, a **host capability** such as `enqueueRun` or `deliver` is implemented by core and granted to a plugin only when declared and authorized. The PRD uses these two terms consistently.

A package may expose several contributions only when they share one ownership and lifecycle boundary. Thus state-local may own transcript, run-record, presence, and delivery-idempotency contributions because they share a local durable-state discipline; continuation coordination and OTLP export remain separate packages because their failure modes, operations, and release concerns differ.

Every contribution is explicit in the manifest and selected by an instance in config. Any plugin may also contribute diagnostics and namespaced CLI commands scoped to its own data. Plugins are trusted, in-process project dependencies; the loader does not claim to isolate malicious code, and documentation must say so.

### 4.4 Continuation coordination

A continuation is the durable return path for work that finishes after the originating turn. Coordination is the whole lifecycle, not merely a database:

1. bind a claim to the originating run, conversation, policy snapshot, reply destination, and deadline;
2. accept a later result exactly once while handling leases, duplicate delivery, cancellation, expiry, and process recovery;
3. enqueue a tool-free synthesis run with the pinned origin context;
4. deliver the synthesized result only to the authorized destination and persist an idempotent receipt;
5. expose list, status, retry, cancel, and explicit resolution for failed or unknown delivery.

The first-party `continuations` extension owns the claim API, scoped capability issuance/injection for explicitly selected local MCP services, records, current store format, state machine, workers, retry/dead-letter policy, named routes, and operator CLI. It does not invent a new model-visible continuation tool: the selected MCP service claims through the request-bound capability, as in v0. Core owns no continuation record, timer, worker, or retry policy. The SDK/core expose only reusable request-scope and host seams:

- a read-only origin envelope and settlement lifecycle hook, so an extension can activate or abandon a claim consistently with turn settlement;
- `enqueueRun(request)`, admitted through the normal bounded queue with an explicit tool policy;
- `deliver(destination, payload)`, using the same authorized proactive channel path as cron.

This division keeps asynchronous coordination replaceable while preserving the invariant that only core can schedule a run or ask a selected channel to deliver. It also avoids turning every scheduler-shaped feature into a core amendment.

### 4.5 Path-based single-file plugins

`use` accepts a project-relative ESM file (`"use": "./plugins/foo.mjs"`) as an equal alternative to a package reference. “Single-file” is literal: the entry must be one regular file contained by the project root after realpath resolution, with no symlink escape. It may use only statically analyzable ESM imports of Node built-ins and packages declared as direct project dependencies; relative, absolute, `file:`, dynamic-import, and CommonJS `require` edges are rejected. A path plugin that needs local helpers graduates to a normal package/workspace plugin.

The service drift marker hashes the entry file plus the project lockfile and the resolved versions/integrities of its imported direct dependencies. The same manifest, schema, lifecycle, and compliance rules apply to path and package plugins; neither requires a core or first-party catalog edit.

## 5. Public contracts

### 5.1 Plugin definition

    definePlugin({ manifest, schema, create, commands? })

Manifest: plugin id, apiVersion (exactly 1), version, primary kind (runtime | channel | memory | tool | extension), declared contributions, optional capability requirements, one-line description, and static CLI command names/help. The config key is the **instance id**: the same plugin may be selected more than once with different instance ids and config.

`create` receives one instance's validated config and a capability-scoped context (instance id, logger, lifecycle signal, clock/id helpers, event publication, declared host capabilities, granted paths, and approved section 4.4 seams). It returns only its declared contributions plus optional diagnostics and cleanup. The context never exposes an application controller, mutable registry, another instance's config, or undeclared integrations.

The optional `commands` factory is separate from runtime `create`. It lazily supplies only the handlers declared in the manifest and receives bounded CLI I/O, instance identity, config provenance, and command-specific secret access—never a running host or undeclared capability. This is how an explicitly disabled runtime can still expose setup/auth/diagnostic commands without initializing provider or channel code.

### 5.2 Host entry points

- `loadAgentProject(options)` — parse strict JSON, resolve only configured plugins (direct dependencies or project paths), compose schemas, resolve explicit sources with provenance, validate everything before any enabled contribution initializes.
- `validateAgentProject(project)` — structural readiness; non-zero exit for every missing package, secret, or capability.
- `createAgentHost(project)` — run (one-shot), start, health, stop (drain, reverse-order plugin shutdown, idempotent dispose).

### 5.3 Runtime contract

One plugin per family: runtime-pi, runtime-claude (SDK and CLI modes), runtime-codex, runtime-opencode. The normalized contract preserves streaming events, final/structured results, usage/cost/model/effort metadata, tools and MCP, approvals, cancellation, acknowledged live input, provider session lifecycle, compaction records, bounded diagnostics, and classified failures (the existing taxonomy). Configuration, authentication, permission, policy, unsupported-capability, and invalid-request failures are terminal; fallback advances only on classes the route policy marks retryable. Cross-runtime routing is core's.

**Leverage-native rule** (per the pi-upstream-recon discipline): pi 0.80.6 ships session persistence, compaction primitives, provider auth, model catalogs, and stream retry. runtime-pi delegates to them and shrinks to a thin binding (target ≤2,200 from 3,376 plus harness share); the hand-rolled compaction-driver and session-lifecycle layers die at G3. Other bridges keep their own native session handling; no shared session-lifecycle driver survives.

**History rule**: the runtime-neutral transcript (≤700 lines, state-local) is canonical for every runtime family and session mode. Core commits user-visible input, settled output, AskUser evidence, verbatim appends, runtime route, and provider-session linkage only after settlement. It is the source for channel replay, cold start, cross-family fallback, and audit.

Provider-native sessions are runtime-owned execution state and an optimization, never the only durable user-visible history. Pi still delegates Pi session persistence, compaction, retry, and provider mechanics upstream; runtime-pi records the resulting session/compaction linkage in the neutral transcript. A provider session may be discarded or become unreadable without stranding canonical history.

### 5.4 Channel contract

Channels validate and redact their own config; emit normalized inbound requests; manage reply streams; declare attachment/live-input/AskUser/proactive/runtime-control capabilities; enforce their own allowlists and transport auth; expose bounded health; stop idempotently. **Fail-closed boundary**: configuration, authentication, and structural failures are validation or start errors. Transport-level failure — at start or later — is visible degradation with bounded recovery, exactly as production behaves today; a degraded channel never reports healthy while disconnected and never takes down an otherwise healthy agent. The SDK channel contract is an evolution of the proven channels.plugins ChannelDriver seam already running the extras in production.

### 5.5 State and durability

Core coordinates state but never picks a storage format. Every durable contribution documents: ownership boundary, atomicity and idempotency, schema versioning, retention, backup/restore, reset/purge surface, corruption behavior, redaction. Crash-boundary tests prove atomic completion or explicit recoverable state; unknown delivery stays unknown.

## 6. Configuration

Canonical file: `mono-agent.config.json` — strict JSON, `configVersion: 1`, one core envelope, and a plugin map keyed by instance id. Unknown fields are errors. Paths resolve relative to the config file. This example fixes the normative top-level shape; instance ids and plugin-config values are illustrative, and each plugin owns the contents of its `config` object:

```json
{
  "configVersion": 1,
  "agent": {
    "id": "example",
    "instructions": "./AGENTS.md",
    "runtime": {
      "primary": "pi-primary",
      "fallbacks": ["codex-backup"]
    },
    "session": {
      "mode": "continuous"
    },
    "concurrency": {
      "maxActiveRuns": 2,
      "maxPendingRuns": 16
    }
  },
  "plugins": {
    "pi-primary": {
      "use": "@mono-agent/runtime-pi",
      "config": {
        "model": "provider/model",
        "apiKey": { "$env": "PRIMARY_PROVIDER_API_KEY" }
      }
    },
    "codex-backup": {
      "use": "@mono-agent/runtime-codex",
      "config": {
        "model": "codex-model"
      }
    },
    "inbound": {
      "use": "@mono-agent/channel-webhook",
      "config": {
        "port": 3210,
        "token": { "$env": "WEBHOOK_TOKEN" }
      }
    }
  },
  "policy": {
    "tools": {
      "allow": []
    }
  }
}
```

One executable Zod 4 schema per plugin is the only handwritten definition; types, validation, defaults, composed JSON Schema, editor completion, redaction, `config explain` provenance, setup prompts, and reference documentation all derive from it. No v1 package may introduce a parallel field registry, env-key map, or handwritten reference table.

Sources and precedence: JSON is authoritative; environment values never override a field implicitly. An explicit `{"$env": "NAME"}` may replace a schema-approved scalar; a present reference with no value is an error; secret-marked fields reject inline values. Process environment wins. The chosen `--env-file`, or `.env` beside the config, fills only names absent from the process environment. `config explain` reports schema default, JSON literal, or exact environment variable name as provenance while redacting its value. There is no interpolation, inheritance, profile overlay, or hot reload; alternate profiles are separate files selected by `--config`.

Multiple instances of the same plugin are valid and are distinguished only by instance id. `enabled: false` keeps an instance selected for structural schema validation and setup/auth/diagnostic CLI contributions but prevents `create` and all runtime contributions. A missing runtime secret/capability blocks an enabled instance; for a disabled instance it remains a visible not-ready diagnostic and may be repaired by its command. The CLI discovers contributions only from instances explicitly present in the current config, whether enabled or disabled; it never scans all dependencies or the first-party catalog.

The first-party memory-local plugin has one v1 mode: BuJo, with embeddings optional (absent embeddings means FTS-only recall). Third-party memory plugins remain valid. The v0 `lite` and `journal` modes and conversational self-config are not represented in any first-party v1 schema.

Commands: `validate` (strict, non-zero on any missing configured package or enabled-instance secret/capability — the current waiting-state escape is closed), `doctor` (validate plus bounded plugin diagnostics; never starts long-lived channels), `config schema --write`, `config explain`, `add` (exact dependency + config stub + schema regen), `init` (delegates to the scaffolder).

## 7. Operator product

Three names, three roles — kept deliberately distinct:

- **channel-operator** is the endpoint *inside each agent* — a normal channel plugin serving the operator protocol over loopback HTTP. It exists even when no UI is attached.
- **operator** is the *headless application library* — protocol schemas, one agent client, cross-agent directory model, capability negotiation, domain state machines, and golden fixtures — that every UI imports.
- **tui** and **web** are *renderers* that consume operator to reach any agent's channel-operator endpoint.

**The wire stays exactly as it is**: plain HTTP routes (info, turns, cancel, verbatim, live-input, ask) with the turn response streamed as NDJSON, and client-disconnect-aborts-turn semantics preserved (the durable web service may assume ownership). An SSE redesign was evaluated and rejected: EventSource cannot POST, the restructure would break disconnect-abort semantics and add per-subscriber buffering, and the browser never talks to agents directly anyway. A future transport swap remains possible behind the shared client, out of v1 scope.

The boundary has two layers:

1. the **agent wire** addresses one channel-operator endpoint and owns request/stream encoding, cancellation, and capability negotiation;
2. the **application directory** owns discovery, endpoint identity, selection, pinning, offline visibility, and per-agent connection state without pretending those are wire operations.

Both renderers use the same domain state machines for conversation/turn lifecycle, NDJSON stream reduction, AskUser, capability-to-action gating, and the application directory. Given the same fixture stream and capabilities, they must produce equivalent domain state and available actions. Renderer-owned code is limited to layout, navigation, widgets, terminal/browser integration, and platform persistence adapters. It may not reinterpret protocol events or reimplement action eligibility.

The operator contract covers the complete current action surface: discovery/selection/pinning, conversation lifecycle, turns, live input with settlement, cancellation, AskUser, model/effort overrides, attachments, quoting, config/replay/health views, and renderer exit without stopping the agent.

Web keeps its durable SQLite store (node:sqlite), active-turn survival, notifications, and host/origin safety. TUI keeps pi-tui rendering and terminal UX. Platform-only behavior stays adapter-owned.

## 8. Package and CLI disposition

### 8.1 v1 package roster — currently 25

| Tier | Packages |
| --- | --- |
| Core (3) | plugin-sdk (contracts, schema helpers, compliance kit, secure-fs, http-server), core, cli (router, core commands, managed project-skill maintenance) |
| Runtimes (4) | runtime-pi, runtime-claude, runtime-codex, runtime-opencode |
| Channels (7) | channel-telegram, channel-slack, channel-webhook, channel-openai-api, channel-cron, channel-a2a, channel-operator |
| Capabilities (5) | memory-local; state-local (neutral transcript, run recorder, presence, delivery-idempotency); continuations; exporter-otlp (OTLP/Phoenix export and session mapping); sandbox-srt |
| Products (6) | operator, tui, web, service-macos, create-mono-agent, docs-mcp |

Retired v0 names: agent-app, agent-contracts, agent-harness, agent-runtime (split), config, observability (split between state-local and exporter-otlp), runtime-adapter, operator-adapter (split), plus the Phase A deletions. The roster may change through reviewed ownership evidence; neither 25 nor any lower number is a gate. Per-package ceremony (responsibility docs, API inventories) is generated from owned metadata.

### 8.2 CLI disposition (from 20 v0 command names)

| Command | v1 disposition |
| --- | --- |
| init / setup (alias) | Scaffolder-backed; alias preserved |
| validate / doctor | cli, per section 6; check inventory guarantees no silently dropped check |
| auth | Top-level verb preserved, routed to configured runtime instances |
| sandbox | Top-level verb preserved, routed to sandbox-srt |
| config | explain / schema / helpers; never a mutation system |
| start / restart / stop / status / logs | core + service-macos; honest process and provenance reporting |
| tui / web | Renderer launchers |
| install-skill | cli (managed copies, transactional, docs-mcp pairing) |
| runs | state-local contribution |
| memory | memory-local contribution |
| continuations | continuations contribution over its existing compatible store |
| presets | Deleted at G1 only after equivalent scaffolder templates land |
| backfill | Deleted at G0.5; the v0-final command prints archive/revival guidance |
| tui --configure | Deleted at G0.5 with the self-config product; points to init, schema docs, and `config explain` |

Plugin commands are namespaced contributions discovered only from configured instances. Static metadata can make setup/auth commands available for an explicitly disabled instance without initializing it. Command and alias collisions are validation errors; the CLI hardcodes no provider, channel, or backend details.

## 9. Atomic requirement and parity ledger

G0 creates `refactor/v1-requirements.json` before any product deletion. It is the complete machine-readable disposition of v0 behavior, not a hand-maintained summary of test tags. Each row contains:

- one independently falsifiable assertion;
- a stable requirement id, owner, delivery gate, consumer applicability, and `kept` or `cut` disposition;
- exact source evidence from current config, CLI/flags, code, tests, docs, services/jobs, persisted state, or production-consumer inventory;
- for a kept row, one or more named proof assertions and their automated/live/migration evidence type;
- for a cut row, the deletion-ledger decision and archive/revival location.

One test may exercise several requirements, but it must emit a distinct assertion result for each id; a broad tag on a compound test cannot green several rows. A kept behavioral row without passing proof fails CI. A proof naming a cut or unknown id fails CI. Operational cutover rows may use captured live evidence, but normal code behavior requires automated proof. The generated report is requirement → owner → gate → proof result, and stable requires every applicable kept row green.

The grouped inventory below is a **discovery seed**, currently roughly 70 behavior areas. It is not the final row count or a compression target. G0 expands every `and`, capability list, failure branch, and renderer/channel variant into atomic rows by reconciling the package catalog, public exports, CLI registry, config schema, feature registry/matrix, tests, docs, service definitions, scheduled jobs, durable formats, and both production-consumer matrices.

**Core**: deterministic context composition; skill loading with disclosure modes and byte limits; request/reply/AskUser/attachment normalization; tool and MCP policy intersection without privilege widening; concurrency and bounded pending admission; continuous and per-message sessions with idle expiry, daily rollover, timezone, proactive isolation; canonical transcript commit only after settlement for every runtime, with AskUser evidence; live input via acknowledged capability with normal-turn fallback; proactive delivery to the exact authorized destination with verbatim mode and NOTHING_TO_REPORT suppression; request-scoped RunHistory tool; programmatic embedding without the CLI; effort keywords and request-level model/effort overrides; explicitly selected channel send tools with default-deny.

**Runtimes**: Pi SDK execution including OAuth/API-key resolution, tool steering, native sessions, and compaction linkage; Claude SDK mode; Claude Code CLI mode; Codex app-server; OpenCode app-server with stable-CLI guard; Ollama/LM Studio/OpenAI-compatible local providers with URL policy and no hosted fallback; ordered same- and cross-runtime fallback with capability checks and typed failures; tool/Bash/MCP/output bounds; explicit approval gates that no incapable route can convert to allow-all; plugin-owned provider setup/auth/model discovery; provider errors with cause and no secret leakage.

**Channels — shared compliance**: every channel passes normalization, allowlist, advertised AskUser/steering/proactive/verbatim behavior, delivery idempotency, bounded health, idempotent stop, and redaction assertions independently.

**Telegram**: polling; media and voice transcription with adversarial-filename safety; in-place activity rendering; live steering; commands. **Slack**: single Socket Mode consumer; threads and conversation identity across all flows; assistant-thread status with reaction fallback and transient tool ledger; shortcuts; App Home; final-only/silent-delivery limits stated honestly. **Webhook**: multiple named endpoints with per-endpoint auth, prompt, model, effort, sync/async, timeout, and async status. **OpenAI API**: model discovery; streaming and non-streaming Chat Completions with correct SSE/JSON termination and conversation-identity precedence; bounded image bridging; sampling-field warnings; host-tool rendering. **Cron**: JSON and Markdown jobs; five-field/timezone validation; duplicate rejection; skip/queue/replace/overflow/watchdog outcomes. **A2A**: valid Agent Card and task endpoint with bounded auth and production-record-compatible idempotency; remote discovery and consumption without a core dependency. **Operator channel**: protocol; frame bounds; abort-on-disconnect; capability advertisement.

**Memory**: SQLite identity, migrations, ownership checks, corruption reporting; BuJo recall with and without embeddings, vector + FTS, dimension checks, circuit breaker, and keyword fallback; capture/admission with completed-turn idempotency; host-agent or Ollama memory-LLM behavior and consolidation schedules; strict audit, preview, rebuild, backup, forget, and intake retry. Lite and journal are cut rows, not parity requirements.

**State**: atomic canonical transcript with duplicate protection, provider-session linkage, verbatim append, and AskUser evidence; run recording with summaries, retention, runs CLI, stale-run classification, and memory-run separation; owner-private presence with stale detection; per-channel delivery-idempotency indexes.

**Continuations**: claim capability, origin binding, deadlines, size limits, durable leases, retries, cancellation, dead letters, named-route delivery, tool-free synthesis, idempotent receipts, unknown-delivery recovery, and `per-record-v3` compatibility; operator list/status/retry/cancel/resolve without token exposure.

**Observability**: structured event redaction and bounds; OTLP/Phoenix export with stable trace/session mapping, backpressure, flush/shutdown, and visible degradation.

**Security and sandbox**: no inline secrets; redaction in logs, errors, health, explain, and generated docs; owner-only file writes with symlink/ownership checks where promised; shared HTTP hardening for bind, bearer, Host/Origin, size limits, and shutdown; tool-policy monotonicity across fallback; SRT off/native modes, network policy, and fail-closed integrity.

**Operations**: start only after validation with process exclusivity; project-local pinned launch with drift-detecting provenance; launchd install/start/restart/stop/status with bounded recovery and no resurrection after stop; bounded logs and honest health aggregation with typed causes and no fake waiting success.

**Operator surfaces**: every wire interaction through the shared client; equivalent shared domain state and available actions from golden fixtures; structured presentation of answers, reasoning, tools, warnings, compaction, usage, cost, and failover; feature assertions per renderer for directory/discovery, conversations, model/effort, cancel, live input, AskUser, quote, attachments, config, replay, and health; web durability for threads, uploads, active-turn survival, invalidation, and deletion rules.

**Setup**: scaffold contains only selected dependencies with exact versions, lockfile, schema, and env example; interactive provider discovery/auth with bounded real route checks and honest noninteractive behavior; transactional dotenv/file creation with review and no fake readiness; schema-derived config documentation and explain output.

**Contributor and release**: package and single-file path plugins run without a core/catalog edit; package docs derive from metadata with drift gates; lockstep release enforces apiVersion/peer compatibility and packed-consumer verification.

## 10. Data migration and rollback

### 10.1 State classification

Continuity policy is **memory plus continuation control state**. A pending continuation is active operational work with a delivery obligation; it is not disposable history.

| State | v1 treatment | Reason |
| --- | --- | --- |
| BuJo roots, SQLite identity, embeddings metadata, unresolved intake | Preserve in place after audited rehearsal and backup | User-owned durable memory |
| Continuation `per-record-v3` records, origin blobs, transactions, ownership DB, token secret, guards, receipts | Preserve with the same format through both beta cutovers | Active claims, idempotency, rollback, and unknown delivery must survive |
| Conversation history, provider-native sessions, run artifacts, web conversations | Do not import; retain read-only v0 copy through rollback window | No stable cross-version product promise |
| Service logs and transient caches | Do not import; retain only by existing operations policy | Diagnostic, not canonical state |

v1 uses distinct directories for new transcript, run, presence, exporter, and web state. Memory and continuation directories are the only canonical v0 directories adopted after their respective exclusive cutovers.

### 10.2 Memory cutover

Freeze the memory format until both consumers complete beta. Per consumer: audit; back up; rehearse on a copy; compare representative recall with and without embeddings; perform one capture, duplicate-admission attempt, forget preview, and rebuild; prove both v0-final and v1 readers open the resulting format; cut over with a final audit; retain the complete backup until the rollback window closes. Any audit failure, unexpected format mutation, missing integrity behavior, or remaining lite/journal dependency blocks that consumer. Lite/journal data is not automatically converted; migrate it to BuJo as a separate, explicitly reviewed consumer task or keep that consumer on frozen v0.

### 10.3 Continuation cutover

The `continuations` package preserves the current `per-record-v3` format during v1 beta. G5 uses a sanitized corpus plus at least one captured week of orchestrator records to prove:

1. v0-final and v1 independently open equivalent cloned stores and produce the same normalized inventory;
2. both execute the same transition corpus for claim, activate/abandon, submit, lease recovery, synthesize, deliver, retry, cancel, dead-letter, and resolve;
3. v0-final can reopen a store written by v1 with terminal, active, unknown-delivery, and legacy-migrated records intact;
4. ownership, permissions, bounds, HMAC/digest validation, interrupted-transaction recovery, and rollback guards remain fail-closed.

Shadow testing uses a cloned store and disabled delivery; two coordinators never own the canonical store simultaneously. At cutover, stop v0, prove process death and lock release, take a complete backup, start v1 against the canonical store, and reconcile every active/nonterminal id before enabling delivery.

If format compatibility cannot be achieved, the fallback is not conversion or discard: freeze new claims, drain active and unknown records to zero under v0, archive terminal state read-only, and cut over to a fresh v1 store. Any unresolved claim blocks cutover. This fallback requires a reviewed PRD amendment because preserving the format is the accepted plan.

### 10.4 Config and service migration

There is no v0 config parser. Each consumer receives an explicitly authored v1 config, exercised via `--config` with separate service labels, alternate ports, and Telegram/Slack disabled during shadow. A generated migration guide maps every v0 field to a v1 field, plugin, or explicit cut. Cutover occurs at a session rollover boundary.

service-macos records absolute validated paths for Node, the project-local CLI, project root, config, and logs plus a drift marker covering Node/package versions and digests of package.json, lockfile, config, path plugins, and service definition. It never installs dependencies. Install stages and promotes atomically; restart validates the replacement first; stop proves unload and process death; explicit stop disables recovery.

Rollback: stop and prove death of v1, reconcile continuation state, audit memory, restore a complete pre-cutover state backup only if format/records require it, load the retained v0 definition, prove version and health, and record the reason. Immediate rollback triggers are duplicate Telegram/Slack consumption, a missing or duplicated continuation result, memory loss/corruption, unprovable process identity, auth failure hidden by fallback, healthy-while-unavailable, missed schedule without explicit failure, crash loop, or a secret in any artifact.

## 11. Delivery gates

| Gate | Content | Exit evidence |
| --- | --- | --- |
| G0 — commitment | ADR ratifies ownership, explicit cuts, and migration policy; exact complexity classifier/baseline; atomic requirement manifest and generated ledger; stable task ids adopted | Reviewed ADR; baseline records SHA, file manifest, production/test counts and digest; every discovered behavior is kept or cut |
| G0.25 — archive and detach | Final full v0 release; `archive/v0-final-full` tag and `v0-maintenance` branch; local CLI, Personal Agent, A8C orchestrator, and linked workers pinned off repository main | Exact resolved versions, process commands, config paths, channel ownership, memory/continuation health, and bounded startup evidence |
| G0.5 — deletion-first v0 | WhatsApp, Supermemory, orchestrator extra, self-config including `tui --configure`, backfill, and unused dependency removed; migration/revival messages land | Focused tests and one broad CI gate green; no SELF-CONFIG surface remains; complexity delta recorded |
| G1 — config-first skeleton | plugin-sdk, schema-composed config, selected-instance package/path loader, core host loop, CLI shell, external hello plugin, Pi + webhook vertical slice; schema-driven scaffolder templates land before presets/wizard deletion; old doctor/config/app-controller machinery deleted | Packed clean-project smoke; minimal closure/native report; kernel trend; config/example/explain tests; check inventory published |
| G2 — operator foundation | Agent wire client, application directory, shared domain state machines and fixtures; channel-operator; TUI and web consume them | Golden fixtures yield equivalent domain state/actions; dependency/static check finds no second wire decoder or eligibility reducer |
| G3 — runtimes and history | Canonical neutral transcript; four runtime plugins; Pi-native session/compaction delegation; old durable-history, compaction-driver, and shared session-lifecycle deleted | One bounded live smoke per family; settlement/history and cross-family fallback assertions green |
| G4 — channels | Seven channels on SDK contract; shared HTTP/security helpers and compliance suite; old channel glue, threading indexes, and repeated bootstraps deleted | Atomic channel rows green; bounded Telegram, Slack, A2A, and OpenAI-compatible client smokes; A2A record compatibility proven |
| G5 — durable capabilities | state-local, continuations with unchanged `per-record-v3`, memory-local BuJo-only, exporter-otlp, sandbox-srt; old state/memory/observability machinery and lite/journal modes deleted | Durable-state review; memory rehearsal; continuation corpus + week-of-records roundtrip; exporter and sandbox proofs |
| G6 — products and release | create-mono-agent, service-macos with managed-closure deletion, docs/docs-mcp rebuild, lockstep beta pipeline, migration guide | Clean npm and pnpm scaffolds from packed artifacts; path/package plugin smokes; live macOS service smoke |
| G7 — production beta | Publish beta; migrate Personal Agent first, then A8C orchestrator; shadow, exclusive cutover, rollback rehearsal, and 24-hour soak for each | Consumer matrices green; memory and continuation reconciliations; exact single-consumer Telegram/Slack proof |
| G8 — stable | Atomic ledger fully green; production source ≤130k and ≥31% below normalized baseline; kernel ≤15k; stable publish; v0 deprecation and 30-day removal window | Reproducible reports at release SHA; packed consumer install; post-launch review and explicit finding dispositions |

No gate may be merged out of order. Work inside a gate may run concurrently only where the dependency graph below permits it.

## 12. Execution task graph

Every implementation PR names one or more task ids and atomic requirement ids, includes its paired deletion, and records each review finding as fixed, follow-up, or rejected with reason. A task is complete only when its proof is committed; code completion alone is not status.

| ID | Gate | Depends on | Deliverable and paired deletion | Required proof |
| --- | --- | --- | --- | --- |
| V1-001 | G0 | — | Ratify ADR for package ownership, host seams, config, product cuts, migration, and budgets | Architecture review approval |
| V1-002 | G0 | V1-001 | Commit complexity classifier and normalized baseline | Reproduction from clean checkout matches manifest digest/count |
| V1-003 | G0 | V1-001 | Build atomic requirement manifest from all discovery sources | Zero unclassified behaviors; generated ledger deterministic |
| V1-004 | G0.25 | V1-002, V1-003 | Cut final lockstep v0 release and create archive tag/maintenance branch | Registry-packed install and tag/SHA/version match |
| V1-005 | G0.25 | V1-004 | Pin local CLI and every repository-main-linked consumer to final v0 | Per-consumer resolution/process/config/state proof |
| V1-006 | G0.5 | V1-005 | Remove WhatsApp, Supermemory, orchestrator extra, and unused SDK dependency | Focused tests, architecture/docs checks, complexity delta |
| V1-007 | G0.5 | V1-005 | Remove self-config engine, transactions, `tui --configure`, and all UI affordances | CLI/TUI negative tests and migration guidance |
| V1-008 | G0.5 | V1-005 | Remove backfill/export mapping while retaining live export | CLI negative tests and archive/revival guidance |
| V1-009 | G0.5 | V1-006, V1-007, V1-008 | Certify lean v0 base for v1 work | Focused lanes plus one broad CI gate; ledger/complexity reports |
| V1-010 | G1 | V1-009 | Create plugin-sdk/core/cli package skeletons and architecture rules | Catalog, dependency, public API, pack checks |
| V1-011 | G1 | V1-010 | Implement manifest, contribution, lifecycle, schema, diagnostic, and CLI metadata contracts | SDK type tests and compliance fixture plugin |
| V1-012 | G1 | V1-011 | Implement strict core envelope, schema composition, instance ids, disabled selection, env precedence, and provenance | Atomic config/error/redaction tests |
| V1-013 | G1 | V1-011, V1-012 | Implement selected package loader and constrained single-file path loader | Package/path parity, realpath/import/digest negative tests |
| V1-014 | G1 | V1-011 | Implement secure-fs and HTTP lifecycle helpers | Adversarial filesystem and HTTP contract tests |
| V1-015 | G1 | V1-011, V1-012, V1-013 | Implement host lifecycle, bounds, settlement, health, shutdown, and host seams | Lifecycle/crash/backpressure tests |
| V1-016 | G1 | V1-012, V1-015 | Implement CLI shell, validate, schema, explain, add, and configured plugin routing | Exit-code/JSON compatibility and no-dependency-scan tests |
| V1-017 | G1 | V1-012, V1-016 | Land schema-derived scaffolder templates, then delete presets, old wizard, and config-reference | Packed scaffold snapshots and transactional-failure tests |
| V1-018 | G1 | V1-011, V1-016 | Convert doctor inventory to core validation plus plugin diagnostics; delete old orchestration | Every v0 check mapped to proof or reviewed cut |
| V1-019 | G1 | V1-013, V1-015 | Complete real Pi + webhook vertical slice and delete converted app-controller/config glue | Packed clean-project turn and minimal closure report |
| V1-020 | G2 | V1-011 | Extract operator protocol schemas and single-agent NDJSON client | Golden wire/frame/disconnect tests |
| V1-021 | G2 | V1-020 | Implement turn/stream/AskUser/capability and directory domain state machines | Deterministic reducer/action fixtures |
| V1-022 | G2 | V1-015, V1-020 | Extract channel-operator endpoint | Protocol compliance and abort-on-disconnect tests |
| V1-023 | G2 | V1-021, V1-022 | Migrate TUI to shared client/domain and delete local interpretations | TUI fixture parity and interactive smoke |
| V1-024 | G2 | V1-021, V1-022 | Migrate web to shared client/domain while retaining durable ownership/persistence | Web fixture parity, restart/upload/notification tests |
| V1-025 | G3 | V1-015 | Extract canonical neutral transcript into state-local | Settlement, duplicate, replay, AskUser, corruption tests |
| V1-026 | G3 | V1-019, V1-025 | Finish runtime-pi using upstream sessions/compaction; delete hand-rolled drivers | Pi SDK live smoke and compaction/linkage tests |
| V1-027 | G3 | V1-015, V1-025 | Extract Claude SDK and CLI modes | Mode-specific live smokes and failure classification |
| V1-028 | G3 | V1-015, V1-025 | Extract Codex app-server runtime | App-server live smoke, approval/cancel/session tests |
| V1-029 | G3 | V1-015, V1-025 | Extract OpenCode app-server runtime and stable-CLI guard | App-server live smoke and version/failure tests |
| V1-030 | G3 | V1-026, V1-027, V1-028, V1-029 | Finish route capability negotiation and typed same/cross-family fallback | Fallback matrix with policy-monotonicity proofs |
| V1-031 | G4 | V1-011, V1-014, V1-015 | Finalize channel SDK and shared compliance suite | Fixture channel passes every advertised capability row |
| V1-032 | G4 | V1-031 | Extract Telegram; delete its old composition glue | Poll/media/voice/steering/proactive live smoke |
| V1-033 | G4 | V1-031 | Extract Slack; delete its old composition glue | Single Socket consumer, thread/status/command live smoke |
| V1-034 | G4 | V1-019, V1-031 | Finish webhook plugin and named async endpoints | Auth/timeout/status/idempotency tests |
| V1-035 | G4 | V1-014, V1-031 | Extract OpenAI API channel and delete Express-only bootstrap | Open WebUI fixture plus SSE/JSON termination tests |
| V1-036 | G4 | V1-015, V1-031 | Extract cron and scheduler semantics | Clock-controlled policy/watchdog tests |
| V1-037 | G4 | V1-031 | Extract A2A provider/consumer channel | Production-record corpus and authenticated live smoke |
| V1-038 | G4 | V1-032, V1-033, V1-034, V1-035, V1-036, V1-037 | Delete remaining generic channel glue and replace delivery indexes through state port | Architecture/dead-code audit and all channel rows green |
| V1-039 | G5 | V1-025, V1-038 | Complete state-local recorder, presence, idempotency, retention, and CLI | Crash-boundary, permissions, retention, stale-state tests |
| V1-040 | G5 | V1-014, V1-015 | Extract continuation store/state machine/worker/CLI unchanged in `per-record-v3` | Sanitized corpus, transition corpus, v0 cross-open proof |
| V1-041 | G5 | V1-030, V1-038, V1-040 | Wire origin settlement, synthesis queue, named routes, delivery receipts, and recovery | Week-of-records rehearsal and fault-injection test |
| V1-042 | G5 | V1-030 | Extract memory-local BuJo, health and CLI; delete lite/journal and old memory plumbing | Real-store copy audit/recall/rebuild/forget rehearsal |
| V1-043 | G5 | V1-030 | Extract exporter-otlp and delete mixed observability ownership | OTLP/Phoenix fixture, mapping, pressure, shutdown tests |
| V1-044 | G5 | V1-011, V1-030 | Extract sandbox-srt | Off/native, network, integrity, policy tests and live smoke |
| V1-045 | G6 | V1-017, V1-030, V1-038 | Finish create-mono-agent for npm/pnpm and selected stacks | Packed scaffold matrix and first-turn smokes |
| V1-046 | G6 | V1-016, V1-039, V1-040 | Build service-macos and delete managed-closure stack | Install/restart/stop/drift/rollback live service smoke |
| V1-047 | G6 | V1-012, V1-030, V1-038, V1-041, V1-042, V1-043, V1-044, V1-045 | Generate config/API/package docs and update docs-mcp | Docs drift/accessibility/local-link gates |
| V1-048 | G6 | V1-023, V1-024, V1-030, V1-038, V1-041, V1-042, V1-043, V1-044, V1-045, V1-046, V1-047 | Adapt lockstep beta release and packed-consumer verification | Clean registry-like install of all selected product stacks |
| V1-049 | G7 | V1-048 | Rehearse and cut over Personal Agent exclusively | Consumer matrix, state audit, rollback, 24-hour soak |
| V1-050 | G7 | V1-049 | Rehearse and cut over A8C orchestrator exclusively | Continuation reconciliation, Slack/A2A proof, rollback, 24-hour soak |
| V1-051 | G8 | V1-050 | Close ledger, complexity, security, docs, OSS, and review findings | Full release gate at exact candidate SHA |
| V1-052 | G8 | V1-051 | Publish stable, announce v0 deprecation, observe 30-day window | Registry verification, consumer install, post-launch report |

## 13. Risks, non-goals, and revival appendix

### 13.1 Risks

| Risk | Mitigation |
| --- | --- |
| Continuation extraction breaks named routes or loses active work | Separate package retains `per-record-v3` and the full coordinator; cross-open corpus and week-of-records rehearsal precede cutover; unresolved claims block |
| OpenAI API regression during the Express-to-helper move | Golden SSE termination and Open WebUI fixtures pass on the helper-mounted implementation before either cutover |
| Pi-native leaning couples canonical history to Pi releases | Neutral transcript is canonical for every runtime; Pi sessions are provider-owned optimization and linkage only |
| Shared operator logic becomes a lowest-common-denominator UI framework | Only domain transitions/actions are shared; renderers retain layout, navigation, widgets, platform integrations, and persistence adapters |
| Doctor/status shrinkage breaks ops tooling that parses output | Exit codes and JSON shapes are frozen; check inventory forbids silent drops |
| Memory simplification removes recently added integrity behavior | Per-module requirement disposition and real-store rehearsal are mandatory; lite/journal are explicit cuts, not accidental deletion |
| A behavior invoked outside config is mistaken for unused | G0 reconciles CLI, flags, interactions, jobs, code, state, and consumer matrices; cuts require an explicit decision and archive |
| Rewrite ends larger or less legible than v0 | Paired deletion, one implementation, reproducible classifier, stable ≤130k/31% gate, and separate test count |
| Kernel absorbs plugin-specific policy | 15k hard gate and architecture checks; continuations/exporter remain distinct ownership boundaries |
| Twenty-five packages feel harder to explore than a monolith | Generated responsibility/dependency/API maps, standard READMEs, one config example, and scaffolded selected dependency closure |

### 13.2 Non-goals and explicit product cuts

Non-goals: backward-compatible v0 config parsing; v0 API shims; independent per-package versioning; malicious-plugin sandboxing; hosted marketplace; importing v0 conversation/provider/run/web history; new end-user capabilities during migration; operator transport replacement; renderer unification beyond shared wire/domain behavior; hot reload; Node SQLite/vector migration; Windows/Linux service managers; fleet-wide A8C worker migration during v1.

Explicit v1 cuts: conversational self-config and `tui --configure`; lite and journal memory modes; WhatsApp; Supermemory; the generic orchestrator extra; historical backfill/resend. These are not called unused. A consumer requiring one remains on frozen v0 or completes a separately approved migration/revival before its v1 cutover.

### 13.3 Plugin-candidates appendix

The OSS launch advertises these honest community/revival opportunities from the exact `archive/v0-final-full` source map: WhatsApp channel, Supermemory backend, collaborator-orchestration tools, conversational self-configuration product, lite/journal memory backends, and historical backfill tooling. Revival must implement the published v1 SDK/config/compliance contracts; it does not restore code to core or weaken a stable gate.

### 13.4 PRD maintenance

This document is the decision source until the G0 ADR and generated ledger exist. Thereafter architectural decisions live in the ADR, behavior status lives in the generated requirement report, execution status maps to the stable task ids in section 12, and product-decision changes update this PRD through review. Release criteria may tighten but never weaken without explicit approval. Examples never contain real consumer identifiers or secrets. Any v0 feature merged after this revision must be atomized in the requirement manifest or explicitly cut through a reviewed amendment before stable v1.
