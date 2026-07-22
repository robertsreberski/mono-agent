# Mono-Agent v1: Smaller by Design

Status: Proposed (revision 6 — declarative project composition)
Target release: 1.0 beta, followed by 1.0 stable
Last updated: 2026-07-22
Primary audience: maintainers, contributors, and individual agent builders
Decision scope: the complete v1 architecture, deletion ledger, feature migration, and production rollout

## 1. Executive summary

Mono-agent v1 is a config-first platform around independently selected agent runtimes and integrations: a small operational kernel, with runtimes, channels, memory, durable state, continuations, and exporters loaded as agent plugins; TUI and web declared as applications; documentation search declared as a companion; and host integration declared through a deployment adapter. It is a clean public break from the v0 package graph and configuration model.

**The product of this refactor is a smaller system.** The provisional v0 baseline is ~189,000 handwritten production-source lines across 22 publishable packages; one package, agent-app, holds 66,000 of them. Stable v1 ships at **most 130,000 lines (at least 31% below the normalized G0 baseline)**, with core + plugin-sdk + cli capped at **15,000 lines**. These are machine-tracked release gates, not aspirations. The mechanism is deletion first: deliberate product cuts are archived before source deletion, duplicated machinery dies as its single replacement lands, and every migration slice names the v0 code it deletes.

Package count is not a success metric. The current v1 roster has 25 publishable packages because continuation coordination and OTLP export have ownership and lifecycle boundaries distinct from local state. Architecture gates protect narrow responsibilities and selected dependency closure; they never force unrelated capabilities into one package merely to hit a count.

Every kept behavior has an atomic, test-backed requirement. Deliberately removed capabilities are recorded as product decisions with an archive and revival path; lack of a config reference is evidence only for config-selected features, never for CLI- or interaction-invoked behavior.

The v1 distribution remains one pnpm monorepo releasing first-party packages in lockstep. A generated project owns an ordinary package.json and lockfile and installs only its selected config components plus the thin CLI. Configuration chooses and configures already-installed code; it never downloads or executes a newly named package merely because JSON changed. The production proof is the sequential migration of Personal Agent and the A8C orchestrator, preserving memory and continuation control state and never running duplicate Telegram or Slack consumers.

Stable v1 must also prove that smaller means easier:

- a minimal Pi + webhook project installs no unselected channel, UI, memory, exporter, service, or native module and completes one real turn from generated instructions;
- `config explain` identifies the owning schema, effective source, and safe remediation for every resolved value;
- the same file can declare agent plugins, applications, companion services, and deployment intent while load and validation remain read-only;
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
| Managed-closure background/launchd stack | 14,350 | ≤2,500 in service-macos | G6–G7 | Config-declared desired state through a programmatic deployment adapter; explicit plan/apply; project-local pinned launch; validate-before-restart, honest status, no resurrection after stop |
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
| Config package | 4,854 | ≤1,500 | G1 | One project envelope schema plus one schema per selected component; explicit `$env` replaces ambient overlay |
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

    create-mono-agent ──writes──► package.json + lockfile + mono-agent.config.json

    cli ──► core ───────────────────────────────┐
    applications ──► operator ─────────────────┤
    agent plugins ──────────────────────────────┤──► plugin-sdk
    companions ─────────────────────────────────┤
    deployment adapters ────────────────────────┘

Core depends only on the plugin SDK and general-purpose utilities. Agent plugins, companion services, and deployment adapters depend on the SDK and, only where declared, another capability package. TUI and web depend on the headless operator library and SDK contracts, not on runtime or channel implementations. The CLI is a thin frontend over public core/project APIs. `create-mono-agent` writes the project and dependency closure but is not part of the generated agent's runtime graph.

Core never imports a concrete plugin, application, companion, or deployment adapter. The architecture checker (extending the existing `check:architecture` and package catalog) rejects: core dependencies on any runtime, channel, memory implementation, database, continuation coordinator, exporter, UI framework, companion, or service manager; plugins importing application internals; renderers importing runtime or channel implementations; catalog edits as a requirement for loading third-party components; circular capability requirements.

### 4.2 Core responsibility

Core owns: project/config loading; project-local component resolution; schema composition with value provenance; agent-plugin lifecycle in dependency order; read-only project planning and explicit apply dispatch; request, turn, and session coordination; context and skill composition; concurrency, pending-run bounds, cancellation, backpressure; live-input admission and settlement; runtime route selection and fallback; adapter-neutral tool/approval/MCP/sandbox policy negotiation; structured events; health aggregation; graceful shutdown. Core does not own: provider SDKs or auth; chat transports; memory algorithms; storage formats; exporters; UIs; wizards; OS-service implementations; package installation.

### 4.3 Plugin kinds, contributions, and host ports

Each plugin declares one primary kind: **runtime, channel, memory, tool, or extension**. The first four are stable contracts with compliance suites at 1.0. An extension implements one or more narrow **contribution ports** consumed by the host or an application: transcript store, run recorder, event exporter, discovery registry, sandbox engine, continuation coordinator, or request-scope capability provider. In the opposite direction, a **host capability** such as `enqueueRun` or `deliver` is implemented by core and granted to a plugin only when declared and authorized. The PRD uses these two terms consistently.

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

### 4.6 Declarative project planes and side-effect boundary

The config describes one project through four deliberately different execution planes. They share the `use`, optional `enabled`, and schema-owned `config` envelope, but selecting one kind never silently changes another kind's lifecycle.

| Config plane | What it selects | Owner and lifecycle |
| --- | --- | --- |
| `plugins` | In-process runtime, channel, memory, tool, and extension instances | The agent host initializes enabled instances in dependency order and drains them in reverse order. |
| `applications` | User-facing clients or services such as TUI and web | Separate from the host. `on-demand` instances launch only through an explicit programmatic or CLI request; `managed` instances become desired deployment targets. A managed instance requires one enabled deployment adapter. |
| `companions` | Paired external services such as the documentation MCP server | Separate from the host and never injected as an agent plugin. Registration or launch is planned explicitly; lifecycle is `on-demand` or `managed`. |
| `deployment` | One platform adapter, initially service-macos | Reconciles the implicit agent target plus every enabled `managed` application/companion with the host platform only after explicit apply. A single adapter owns those targets so two service managers cannot race. |

Three published package roles are intentionally absent from those planes: core, plugin-sdk, and operator are imported infrastructure; create-mono-agent is a bootstrap tool. The CLI is the project-local frontend. Their presence is determined by package dependencies, not by synthetic config instances.

Configuration is desired state, not permission to mutate the machine during parsing:

1. `loadAgentProject` and `validateAgentProject` resolve packages, compose schemas, build references, and report diagnostics without starting processes, registering MCP servers, writing service definitions, or installing dependencies.
2. `createAgentHost` initializes only enabled `plugins`; it does not start applications, companions, or deployment reconciliation.
3. `planAgentProject` compares declared applications, companions, and deployment state with observed state and returns a serializable, fingerprinted plan without mutation.
4. `applyAgentProjectPlan` is the only general reconciliation side-effect boundary. It rejects a stale plan and invokes only the selected deployment/companion contracts. A CLI, TUI, web UI, or embedding program may present and call this API, but command execution is never the source of truth.
5. `launchProjectComponent` explicitly runs one configured `on-demand` application or companion without making it a background service.

Changing a `use` value does not fetch code. Every package reference must already be a direct dependency recorded in the project's package.json and lockfile; create-mono-agent or an explicit package-manager operation updates that closure. Path-based agent plugins follow section 4.5. This makes a config diff reviewable and prevents a JSON edit from becoming arbitrary remote-code installation.

## 5. Public contracts

### 5.1 Agent plugin definition

    definePlugin({ manifest, schema, create, commands? })

Manifest: plugin id, apiVersion (exactly 1), version, primary kind (runtime | channel | memory | tool | extension), declared contributions, optional capability requirements, one-line description, and static CLI command names/help. The config key is the **instance id**: the same plugin may be selected more than once with different instance ids and config.

`create` receives one instance's validated config and a capability-scoped context (instance id, logger, lifecycle signal, clock/id helpers, event publication, declared host capabilities, granted paths, and approved section 4.4 seams). It returns only its declared contributions plus optional diagnostics and cleanup. The context never exposes an application controller, mutable registry, another instance's config, or undeclared integrations.

The optional `commands` factory is separate from runtime `create`. It lazily supplies only the handlers declared in the manifest and receives bounded CLI I/O, instance identity, config provenance, and command-specific secret access—never a running host or undeclared capability. This is how an explicitly disabled runtime can still expose setup/auth/diagnostic commands without initializing provider or channel code.

### 5.2 Application, companion, and deployment definitions

    defineProjectComponent({ manifest, schema, describe, inspect, launch?, reconcile? })
    defineDeploymentAdapter({ manifest, schema, inspect, plan, apply, remove })

A project-component manifest has `kind: application | companion`, apiVersion 1, package identity, lifecycle support, one-line description, and any component references its schema accepts. Pure `describe` returns the redacted launch/readiness/state descriptor that an embedding program or deployment adapter may consume; secrets remain opaque handles. `inspect` is read-only. `launch` runs an explicitly requested on-demand instance and returns a stoppable handle. An optional `reconcile` object provides pure `plan` plus side-effecting `apply` and `remove` operations for companion-owned registrations or state. None of these functions runs while loading or validating config.

A deployment adapter accepts resolved descriptors for the implicit `agent` target and every enabled `managed` application/companion. `inspect` and `plan` are read-only; `apply` and `remove` require the exact fingerprinted plan returned by `plan`. The adapter may write only within its declared platform scope and project state paths. service-macos therefore owns launchd definitions and service lifecycle, but it cannot install npm packages, rewrite agent config, or initialize plugins.

All three definition helpers live in plugin-sdk, use the same schema metadata/provenance/redaction machinery, and have focused compliance suites. A new application or companion does not require a core edit. A new deployment adapter requires only the deployment compliance contract and catalog metadata when it is first-party.

Definition modules must be import-side-effect-free: module evaluation may construct schemas and static manifests but may not read secrets, perform network I/O, spawn a process, or write project/host state. First-party and scaffolded-component compliance tests instrument those effects during import. Plugins remain trusted code rather than a malicious-code sandbox, but violating this contract is a package defect and prevents first-party release.

### 5.3 Project and host entry points

`@mono-agent/core` exports the following library API and its non-interactive host runner uses the same implementation:

- `loadAgentProject(options)` — parse strict JSON, resolve configured package components only from direct dependencies and path plugins only from permitted project files, compose schemas, resolve references and explicit sources with provenance, and return an immutable project. It performs no lifecycle action.
- `validateAgentProject(project)` — return structured readiness for the entire selected graph, including every missing package, secret, capability, target, or lifecycle conflict. The CLI maps any enabled-instance error to a non-zero exit.
- `createAgentHost(project)` — run one turn, start, health, and stop the agent plane only (drain, reverse-order plugin shutdown, idempotent dispose).
- `inspectAgentProject(project)` — read current host/application/companion/deployment state without changing it.
- `planAgentProject(project)` — return the complete fingerprinted desired-state diff and warnings without changing it.
- `applyAgentProjectPlan(project, plan)` — reject stale or mismatched plans, then apply exactly the declared operations through selected component and deployment contracts.
- `launchProjectComponent(project, instanceId)` — launch one enabled `on-demand` application or companion explicitly and return a stoppable handle.

The CLI, create-mono-agent, TUI, web, and embedded programs call these APIs; none has a privileged alternate implementation. This is what makes the project config-first without making it CLI-dependent.

A project plan contains stable operation ids, precondition digests, target ownership, ordering, and redacted human/JSON descriptions. Apply verifies each precondition immediately before its operation, records durable per-operation receipts, and stops on the first failure with applied/pending/rollback status; it never claims cross-component atomicity that the host platform cannot provide. Reapplying the same plan is idempotent, and resume or rollback operates from the receipts rather than guessing from process output.

### 5.4 Runtime contract

One plugin per family: runtime-pi, runtime-claude (SDK and CLI modes), runtime-codex, runtime-opencode. The normalized contract preserves streaming events, final/structured results, usage/cost/model/effort metadata, tools and MCP, approvals, cancellation, acknowledged live input, provider session lifecycle, compaction records, bounded diagnostics, and classified failures (the existing taxonomy). Configuration, authentication, permission, policy, unsupported-capability, and invalid-request failures are terminal; fallback advances only on classes the route policy marks retryable. Cross-runtime routing is core's.

**Leverage-native rule** (per the pi-upstream-recon discipline): pi 0.80.6 ships session persistence, compaction primitives, provider auth, model catalogs, and stream retry. runtime-pi delegates to them and shrinks to a thin binding (target ≤2,200 from 3,376 plus harness share); the hand-rolled compaction-driver and session-lifecycle layers die at G3. Other bridges keep their own native session handling; no shared session-lifecycle driver survives.

**History rule**: the runtime-neutral transcript (≤700 lines, state-local) is canonical for every runtime family and session mode. Core commits user-visible input, settled output, AskUser evidence, verbatim appends, runtime route, and provider-session linkage only after settlement. It is the source for channel replay, cold start, cross-family fallback, and audit.

Provider-native sessions are runtime-owned execution state and an optimization, never the only durable user-visible history. Pi still delegates Pi session persistence, compaction, retry, and provider mechanics upstream; runtime-pi records the resulting session/compaction linkage in the neutral transcript. A provider session may be discarded or become unreadable without stranding canonical history.

### 5.5 Channel contract

Channels validate and redact their own config; emit normalized inbound requests; manage reply streams; declare attachment/live-input/AskUser/proactive/runtime-control capabilities; enforce their own allowlists and transport auth; expose bounded health; stop idempotently. **Fail-closed boundary**: configuration, authentication, and structural failures are validation or start errors. Transport-level failure — at start or later — is visible degradation with bounded recovery, exactly as production behaves today; a degraded channel never reports healthy while disconnected and never takes down an otherwise healthy agent. The SDK channel contract is an evolution of the proven channels.plugins ChannelDriver seam already running the extras in production.

### 5.6 State and durability

Core coordinates state but never picks a storage format. Every durable contribution documents: ownership boundary, atomicity and idempotency, schema versioning, retention, backup/restore, reset/purge surface, corruption behavior, redaction. Crash-boundary tests prove atomic completion or explicit recoverable state; unknown delivery stays unknown.

## 6. Configuration

Canonical file: `mono-agent.config.json` — strict JSON, `configVersion: 1`, one agent envelope, maps keyed by instance id, and at most one deployment adapter. Unknown fields are errors. Paths resolve relative to the config file. `$schema`, when present, points to the exact composed schema generated for the project's locked dependency graph.

### 6.1 Minimal project

This is the stable usability target: one runtime and one channel, with no UI, memory, companion, exporter, or service-manager dependency. Omitted planes do not exist at runtime.

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "minimal-example",
    "instructions": "./AGENTS.md",
    "runtime": {
      "primary": "pi-primary",
      "fallbacks": []
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
        "provider": { "$env": "PI_PROVIDER" },
        "model": { "$env": "PI_MODEL" },
        "apiKey": { "$env": "PI_PROVIDER_API_KEY" }
      }
    },
    "inbound": {
      "use": "@mono-agent/channel-webhook",
      "config": {
        "listen": {
          "host": "127.0.0.1",
          "port": 3210
        },
        "token": { "$env": "WEBHOOK_TOKEN" }
      }
    }
  },
  "policy": {
    "tools": {
      "default": "deny",
      "allow": []
    },
    "approvals": {
      "default": "ask"
    }
  }
}
```

### 6.2 Maximal safe first-party selection

The following blueprint selects every first-party config component planned for v1. It is an architecture reference and integration fixture, not a recommended starter preset. “Selected” means installed, schema-validated, and available to its declared lifecycle; it does not mean every component is started or every tool is authorized. It intentionally requires the listed environment values, a reachable example MCP service, compatible runtime authentication, and macOS for the enabled deployment; readiness fails honestly when those prerequisites are absent. The common envelopes, instance references, and lifecycle values below are normative. Each package's executable schema owns its nested `config`; changes to this proposed leaf shape require the owning task and generated reference to update together.

```json
{
  "$schema": "./.mono-agent/mono-agent.config.schema.json",
  "configVersion": 1,
  "agent": {
    "id": "full-example",
    "instructions": "./AGENTS.md",
    "runtime": {
      "primary": "pi-primary",
      "fallbacks": [
        "claude-sdk",
        "claude-cli",
        "codex",
        "opencode"
      ]
    },
    "session": {
      "mode": "continuous",
      "idleTimeoutMs": 1800000,
      "rollover": "daily",
      "timezone": "Europe/Amsterdam",
      "isolateProactiveRuns": true
    },
    "concurrency": {
      "maxActiveRuns": 2,
      "maxPendingRuns": 16
    },
    "context": {
      "skills": {
        "roots": ["./skills"],
        "selected": [],
        "disclosure": "index",
        "maxBytes": 96000
      },
      "mcp": {
        "configPath": "./mcp.json"
      }
    }
  },
  "plugins": {
    "pi-primary": {
      "use": "@mono-agent/runtime-pi",
      "enabled": true,
      "config": {
        "provider": { "$env": "PI_PROVIDER" },
        "model": { "$env": "PI_MODEL" },
        "apiKey": { "$env": "PI_PROVIDER_API_KEY" }
      }
    },
    "claude-sdk": {
      "use": "@mono-agent/runtime-claude",
      "enabled": true,
      "config": {
        "mode": "sdk",
        "model": { "$env": "CLAUDE_SDK_MODEL" },
        "apiKey": { "$env": "ANTHROPIC_API_KEY" }
      }
    },
    "claude-cli": {
      "use": "@mono-agent/runtime-claude",
      "enabled": true,
      "config": {
        "mode": "cli",
        "command": "claude",
        "model": { "$env": "CLAUDE_CLI_MODEL" }
      }
    },
    "codex": {
      "use": "@mono-agent/runtime-codex",
      "enabled": true,
      "config": {
        "command": "codex",
        "model": { "$env": "CODEX_MODEL" }
      }
    },
    "opencode": {
      "use": "@mono-agent/runtime-opencode",
      "enabled": true,
      "config": {
        "command": "opencode",
        "model": { "$env": "OPENCODE_MODEL" }
      }
    },
    "telegram": {
      "use": "@mono-agent/channel-telegram",
      "enabled": true,
      "config": {
        "botToken": { "$env": "TELEGRAM_BOT_TOKEN" },
        "allowedChatIds": [
          { "$env": "TELEGRAM_OWNER_CHAT_ID" }
        ]
      }
    },
    "slack": {
      "use": "@mono-agent/channel-slack",
      "enabled": true,
      "config": {
        "botToken": { "$env": "SLACK_BOT_TOKEN" },
        "appToken": { "$env": "SLACK_APP_TOKEN" },
        "allowedUserIds": [
          { "$env": "SLACK_OWNER_USER_ID" }
        ]
      }
    },
    "webhook": {
      "use": "@mono-agent/channel-webhook",
      "enabled": true,
      "config": {
        "listen": {
          "host": "127.0.0.1",
          "port": 4313
        },
        "token": { "$env": "WEBHOOK_TOKEN" },
        "endpoints": {
          "default": {
            "path": "/hook",
            "mode": "sync",
            "timeoutMs": 120000
          }
        }
      }
    },
    "openai-api": {
      "use": "@mono-agent/channel-openai-api",
      "enabled": true,
      "config": {
        "listen": {
          "host": "127.0.0.1",
          "port": 4312
        },
        "apiKey": { "$env": "OPENAI_COMPAT_API_KEY" },
        "modelId": "full-example"
      }
    },
    "cron": {
      "use": "@mono-agent/channel-cron",
      "enabled": true,
      "config": {
        "jobsDirectory": "./cron",
        "timezone": "Europe/Amsterdam"
      }
    },
    "a2a": {
      "use": "@mono-agent/channel-a2a",
      "enabled": true,
      "config": {
        "provider": {
          "listen": {
            "host": "127.0.0.1",
            "port": 4314
          },
          "publicUrl": { "$env": "A2A_PUBLIC_URL" },
          "bearerToken": { "$env": "A2A_BEARER_TOKEN" },
          "idempotencyNamespace": "full-example"
        },
        "agentCard": {
          "name": "Full Example",
          "description": "Maximal mono-agent v1 integration fixture"
        },
        "consumer": {
          "peers": []
        }
      }
    },
    "operator-endpoint": {
      "use": "@mono-agent/channel-operator",
      "enabled": true,
      "config": {
        "listen": {
          "host": "127.0.0.1",
          "port": 4310
        },
        "token": { "$env": "OPERATOR_TOKEN" }
      }
    },
    "memory": {
      "use": "@mono-agent/memory-local",
      "enabled": true,
      "config": {
        "root": "./.mono-agent/memory",
        "capture": {
          "enabled": true
        },
        "embeddings": {
          "baseUrl": { "$env": "EMBEDDINGS_BASE_URL" },
          "apiKey": { "$env": "EMBEDDINGS_API_KEY" },
          "model": { "$env": "EMBEDDINGS_MODEL" },
          "dimensions": 1536
        }
      }
    },
    "state": {
      "use": "@mono-agent/state-local",
      "enabled": true,
      "config": {
        "root": "./.mono-agent/state",
        "runs": {
          "retentionDays": 30
        }
      }
    },
    "continuations": {
      "use": "@mono-agent/continuations",
      "enabled": true,
      "config": {
        "root": "./.mono-agent/continuations",
        "requestScopedMcpServers": ["work-control"],
        "routes": {
          "owner-telegram": {
            "channelInstance": "telegram",
            "destination": { "$env": "TELEGRAM_OWNER_CHAT_ID" }
          }
        },
        "worker": {
          "leaseMs": 60000,
          "maxAttempts": 5
        }
      }
    },
    "telemetry": {
      "use": "@mono-agent/exporter-otlp",
      "enabled": true,
      "config": {
        "endpoint": { "$env": "OTLP_ENDPOINT" },
        "headers": {
          "Authorization": { "$env": "OTLP_AUTHORIZATION" }
        },
        "includeSensitive": false
      }
    },
    "sandbox": {
      "use": "@mono-agent/sandbox-srt",
      "enabled": true,
      "config": {
        "mode": "native",
        "network": {
          "default": "deny",
          "allowHosts": ["127.0.0.1", "::1"]
        }
      }
    }
  },
  "applications": {
    "terminal": {
      "use": "@mono-agent/tui",
      "enabled": true,
      "lifecycle": "on-demand",
      "config": {
        "agents": [
          {
            "id": "self",
            "channelInstance": "operator-endpoint"
          }
        ],
        "defaultAgent": "self"
      }
    },
    "browser": {
      "use": "@mono-agent/web",
      "enabled": true,
      "lifecycle": "managed",
      "config": {
        "listen": {
          "host": "127.0.0.1",
          "port": 4311
        },
        "dataDirectory": "./.mono-agent/web",
        "auth": {
          "mode": "bearer",
          "token": { "$env": "WEB_CONSOLE_TOKEN" }
        },
        "allowedOrigins": ["http://127.0.0.1:4311"],
        "agents": [
          {
            "id": "self",
            "channelInstance": "operator-endpoint"
          }
        ]
      }
    }
  },
  "companions": {
    "documentation": {
      "use": "@mono-agent/docs-mcp",
      "enabled": true,
      "lifecycle": "on-demand",
      "config": {
        "transport": "stdio",
        "corpus": "bundled",
        "registrations": [
          {
            "client": "codex",
            "scope": "project",
            "name": "mono-agent-docs"
          },
          {
            "client": "claude",
            "scope": "project",
            "name": "mono-agent-docs"
          }
        ]
      }
    }
  },
  "deployment": {
    "use": "@mono-agent/service-macos",
    "enabled": true,
    "config": {
      "serviceIdPrefix": "com.mono-agent.full-example",
      "startAtLogin": true,
      "restartPolicy": "on-failure",
      "logs": {
        "directory": "./.mono-agent/logs",
        "maxBytes": 10485760,
        "retainFiles": 5
      }
    }
  },
  "policy": {
    "tools": {
      "default": "deny",
      "allow": ["MemoryRecall", "RunHistory"],
      "channelSend": {
        "default": "deny",
        "allow": []
      }
    },
    "approvals": {
      "default": "ask"
    }
  }
}
```

The paired `.env.example` contains names only, never credentials:

```dotenv
PI_PROVIDER=
PI_MODEL=
PI_PROVIDER_API_KEY=
CLAUDE_SDK_MODEL=
ANTHROPIC_API_KEY=
CLAUDE_CLI_MODEL=
CODEX_MODEL=
OPENCODE_MODEL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_CHAT_ID=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_OWNER_USER_ID=
WEBHOOK_TOKEN=
OPENAI_COMPAT_API_KEY=
A2A_PUBLIC_URL=
A2A_BEARER_TOKEN=
OPERATOR_TOKEN=
EMBEDDINGS_BASE_URL=
EMBEDDINGS_API_KEY=
EMBEDDINGS_MODEL=
OTLP_ENDPOINT=
OTLP_AUTHORIZATION=
WEB_CONSOLE_TOKEN=
```

The referenced harness-native `mcp.json` is separate on purpose; the maximal fixture supplies the named continuation-capable server without teaching core another MCP-server schema:

```json
{
  "mcpServers": {
    "work-control": {
      "url": "http://127.0.0.1:4320/mcp"
    }
  }
}
```

`mono-agent.config.json` selects 17 agent instances from 16 plugin packages (`runtime-claude` is selected twice), two application packages, one companion package, and one deployment package: 20 unique config-selected packages. The full 25-package roster is then accounted for without fake config entries: cli is the project frontend; core, plugin-sdk, and operator are infrastructure dependencies; create-mono-agent is the bootstrap command. The generated package.json directly declares the CLI and every `use` package, while its lockfile pins the complete transitive graph.

At runtime, `createAgentHost` initializes the 17 enabled agent instances. Applying the deployment plan derives its targets rather than asking the user to list them twice: it manages the implicit `agent` plus `applications.browser`, the only enabled component with `lifecycle: managed`. `applications.terminal` and `companions.documentation` remain explicitly launchable on demand. The docs companion's declared Codex and Claude registrations appear in the plan and are written only by explicit apply.

The continuation block shows its Personal Agent use without coupling it to A2A: the selected `work-control` MCP server receives a request-scoped claim capability, durable work may finish after the originating Telegram turn, and `owner-telegram` gives the coordinator an authorized return route for tool-free synthesis and exactly-once delivery. A2A may create continuations too, but it is only another caller of the same coordinator.

If deployment was never applied, omitting the block creates no launchd state and the project remains usable in foreground or through an embedding program. To decommission an existing deployment safely, keep the package selected, set `deployment.enabled` to `false` (and change any managed component to `on-demand` or disabled), review and apply the removal plan, then remove the block and dependency. Merely deleting JSON is intentionally not an implicit machine mutation.

### 6.3 Schema, sources, and commands

One executable Zod 4 schema per selected component is the only handwritten definition; types, validation, defaults, composed JSON Schema, editor completion, redaction, `config explain` provenance, setup prompts, and reference documentation all derive from it. No v1 package may introduce a parallel field registry, env-key map, handwritten reference table, application registry, or service-option table.

Sources and precedence: JSON is authoritative; environment values never override a field implicitly. An explicit `{"$env": "NAME"}` may replace a schema-approved scalar; a present reference with no value is an error; secret-marked fields reject inline values. Process environment wins. The explicitly supplied env file, or `.env` beside the config, fills only names absent from the process environment. `config explain` reports schema default, JSON literal, or exact environment variable name as provenance while redacting its value. There is no interpolation, inheritance, profile overlay, or hot reload; alternate profiles are separate files selected by `loadAgentProject({ configPath })` or the CLI's `--config` frontend.

Instance ids are unique across `plugins`, `applications`, and `companions`; `agent` is reserved for the implicit host target. Schemas mark instance-reference fields by required component kind. Runtime routes may reference only runtime plugins; operator applications may reference only channel-operator instances; continuation routes may reference only proactive channels; managed lifecycles require an enabled deployment adapter. Missing, disabled where availability is required, wrong-kind, and cyclic references are validation errors with both source paths. `context.mcp.configPath` deliberately points to the standard harness-owned MCP file instead of copying every server definition into the core schema; the agent config still owns whether and how selected plugins may use those named servers.

Multiple instances of the same package are valid and are distinguished only by instance id. `enabled: false` keeps an instance selected for structural schema validation and setup/auth/diagnostic contributions, sets its desired running state to absent, and prevents `create` or launch. Read-only inspection and a removal plan remain available so previously reconciled application, companion, or deployment state can be cleaned up safely; no create/start operation is allowed for a disabled instance. A missing secret/capability blocks an enabled instance; for a disabled instance it remains a visible not-ready diagnostic and may be repaired by an explicit command or API. The CLI discovers contributions only from instances explicitly present in the current config, whether enabled or disabled; it never scans all dependencies or the first-party catalog.

The first-party memory-local plugin has one v1 mode: BuJo, with embeddings optional (absent embeddings means FTS-only recall). Third-party memory plugins remain valid. The v0 `lite` and `journal` modes and conversational self-config are not represented in any first-party v1 schema.

Runtime and lifecycle commands are optional frontends over the public APIs: `validate` (strict, non-zero on any missing configured package or enabled-instance secret/capability — the current waiting-state escape is closed), `doctor` (validate plus bounded component diagnostics; never starts long-lived channels), `config schema --write`, `config explain`, `project plan`, and `project apply`. The optional authoring helpers `add` (explicit package-manager change + config stub + schema regeneration) and `init` (delegates to the scaffolder) are not runtime requirements. A programmatic consumer can perform the complete agent/component lifecycle without invoking a CLI process; project authors may also edit config/package.json and run their package manager directly.

## 7. Operator application layer

Three names, three roles — kept deliberately distinct:

- **channel-operator** is the endpoint *inside an agent that selects it* — a normal channel plugin serving the operator protocol over loopback HTTP. It remains useful when no UI is currently attached.
- **operator** is the *headless application library* — protocol schemas, one agent client, cross-agent directory model, capability negotiation, domain state machines, and golden fixtures — that every UI imports. It is a dependency, not a config-selected process.
- **tui** and **web** are *renderers* that consume operator to reach any agent's channel-operator endpoint.

**The wire stays exactly as it is**: plain HTTP routes (info, turns, cancel, verbatim, live-input, ask) with the turn response streamed as NDJSON, and client-disconnect-aborts-turn semantics preserved (the durable web service may assume ownership). An SSE redesign was evaluated and rejected: EventSource cannot POST, the restructure would break disconnect-abort semantics and add per-subscriber buffering, and the browser never talks to agents directly anyway. A future transport swap remains possible behind the shared client, out of v1 scope.

The boundary has two layers:

1. the **agent wire** addresses one channel-operator endpoint and owns request/stream encoding, cancellation, and capability negotiation;
2. the **application directory** owns discovery, endpoint identity, selection, pinning, offline visibility, and per-agent connection state without pretending those are wire operations.

Both renderers use the same domain state machines for conversation/turn lifecycle, NDJSON stream reduction, AskUser, capability-to-action gating, and the application directory. Given the same fixture stream and capabilities, they must produce equivalent domain state and available actions. Renderer-owned code is limited to layout, navigation, widgets, terminal/browser integration, and platform persistence adapters. It may not reinterpret protocol events or reimplement action eligibility.

This is one interface contract rendered on multiple platforms, not one cross-platform widget framework. Config selects TUI and web independently under `applications`; each references a configured channel-operator instance by id, so endpoint credentials and discovery are not duplicated. TUI is normally `on-demand`. Web may be `on-demand` or `managed`. A scaffold that omits either application never installs its package; an existing project disables/removes any managed state before an explicit package-manager cleanup. Neither operation changes the agent or the other renderer. “GUI” is therefore a generic description of a renderer, not another package or lifecycle concept.

The operator contract covers the complete current action surface: discovery/selection/pinning, conversation lifecycle, turns, live input with settlement, cancellation, AskUser, model/effort overrides, attachments, quoting, config/replay/health views, and renderer exit without stopping the agent.

Web keeps its durable SQLite store (node:sqlite), active-turn survival, notifications, and host/origin safety. TUI keeps pi-tui rendering and terminal UX. Platform-only behavior stays adapter-owned.

## 8. Package and CLI disposition

### 8.1 v1 package roster — currently 25

| Ownership category | Packages |
| --- | --- |
| Core infrastructure (3) | plugin-sdk (component contracts, schema helpers, compliance kits, secure-fs, http-server), core (host APIs and non-interactive runner entry), cli (thin API frontend and configured command routing) |
| Runtime plugins (4) | runtime-pi, runtime-claude, runtime-codex, runtime-opencode |
| Channel plugins (7) | channel-telegram, channel-slack, channel-webhook, channel-openai-api, channel-cron, channel-a2a, channel-operator |
| Capability plugins (5) | memory-local; state-local (neutral transcript, run recorder, presence, delivery-idempotency); continuations; exporter-otlp (OTLP/Phoenix export and session mapping); sandbox-srt |
| Application layer (3) | operator (shared headless library), tui, web |
| Project tooling (1) | create-mono-agent |
| Deployment adapters (1) | service-macos |
| Companion services (1) | docs-mcp |

The 16 runtime/channel/capability packages are config-selectable agent plugins. TUI and web are config-selectable applications; operator arrives transitively. docs-mcp is a config-selectable companion and service-macos is a config-selectable deployment adapter. The CLI is the direct project frontend, core and plugin-sdk arrive through the dependency graph, and create-mono-agent is used before that graph exists. This taxonomy replaces the overloaded “product” bucket: package ownership, config selection, and process lifecycle are now separate, inspectable facts.

Retired v0 names: agent-app, agent-contracts, agent-harness, agent-runtime (split), config, observability (split between state-local and exporter-otlp), runtime-adapter, operator-adapter (split), plus the Phase A deletions. The roster may change through reviewed ownership evidence; neither 25 nor any lower number is a gate. Per-package ceremony (responsibility docs, API inventories) is generated from owned metadata.

### 8.2 CLI disposition (from 20 v0 command names)

| Command | v1 disposition |
| --- | --- |
| init / setup (alias) | Scaffolder-backed; alias preserved |
| validate / doctor | cli, per section 6; check inventory guarantees no silently dropped check |
| auth | Top-level verb preserved, routed to configured runtime instances |
| sandbox | Top-level verb preserved, routed to sandbox-srt |
| config | explain / schema / helpers; never a mutation system |
| start | Foreground `createAgentHost` frontend; a managed start is an explicit project plan/apply operation |
| restart / stop / status / logs | Convenience frontends over inspect/plan/apply and the configured deployment adapter; unavailable with a precise explanation when no adapter owns the target |
| tui / web | Convenience frontends for configured application instance ids through `launchProjectComponent` |
| install-skill | cli (managed skill copies, transactional); it never implicitly selects or registers docs-mcp, whose desired state belongs under `companions` |
| runs | state-local contribution |
| memory | memory-local contribution |
| continuations | continuations contribution over its existing compatible store |
| presets | Deleted at G1 only after equivalent scaffolder templates land |
| backfill | Deleted at G0.5; the v0-final command prints archive/revival guidance |
| tui --configure | Deleted at G0.5 with the self-config product; points to init, schema docs, and `config explain` |

Plugin commands are namespaced contributions discovered only from configured instances. Static metadata can make setup/auth commands available for an explicitly disabled instance without initializing it. Command and alias collisions are validation errors; the CLI hardcodes no provider, channel, backend, application, companion, or platform details. Every lifecycle command is a removable frontend over the section 5.3 APIs; deleting the CLI would not make the config or lifecycle contracts unusable.

### 8.3 Documentation disposition

Canonical documentation follows the same planes as config: one minimal quickstart; one generated complete component-selection blueprint; schema-derived core and per-component reference pages; a package map showing config-selectable versus transitive/tooling roles; and one lifecycle guide for foreground, on-demand, managed, plan/apply, disable/remove, and rollback behavior. Package READMEs remain the contributor-level ownership/API source and link back to those user journeys.

docs-mcp is an optional delivery form of the canonical documentation, not its source of truth and not part of the agent host. Selecting it under `companions` makes exact-version offline search available to configured coding clients. A new project that omits it installs nothing; an existing project first sets it disabled, applies the registration-removal plan, and then removes the config entry and package explicitly. Either way, the website, generated schema, package READMEs, and ordinary docs remain intact. Its bundled corpus and the website are generated from the same canonical files, and a digest drift gate blocks release when they differ.

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

**Project composition**: strict agent/plugin/application/companion/deployment envelopes; direct-dependency and lockfile enforcement for every `use`; schema composition and cross-instance reference validation; `enabled` and lifecycle semantics; load/validate/inspect/plan without mutation; host initialization limited to plugins; explicit on-demand launch; fingerprinted apply with stale-plan rejection; one deployment owner per managed target; programmatic and CLI behavior parity; no package download, MCP registration, service write, or process launch from config loading.

**Runtimes**: Pi SDK execution including OAuth/API-key resolution, tool steering, native sessions, and compaction linkage; Claude SDK mode; Claude Code CLI mode; Codex app-server; OpenCode app-server with stable-CLI guard; Ollama/LM Studio/OpenAI-compatible local providers with URL policy and no hosted fallback; ordered same- and cross-runtime fallback with capability checks and typed failures; tool/Bash/MCP/output bounds; explicit approval gates that no incapable route can convert to allow-all; plugin-owned provider setup/auth/model discovery; provider errors with cause and no secret leakage.

**Channels — shared compliance**: every channel passes normalization, allowlist, advertised AskUser/steering/proactive/verbatim behavior, delivery idempotency, bounded health, idempotent stop, and redaction assertions independently.

**Telegram**: polling; media and voice transcription with adversarial-filename safety; in-place activity rendering; live steering; commands. **Slack**: single Socket Mode consumer; threads and conversation identity across all flows; assistant-thread status with reaction fallback and transient tool ledger; shortcuts; App Home; final-only/silent-delivery limits stated honestly. **Webhook**: multiple named endpoints with per-endpoint auth, prompt, model, effort, sync/async, timeout, and async status. **OpenAI API**: model discovery; streaming and non-streaming Chat Completions with correct SSE/JSON termination and conversation-identity precedence; bounded image bridging; sampling-field warnings; host-tool rendering. **Cron**: JSON and Markdown jobs; five-field/timezone validation; duplicate rejection; skip/queue/replace/overflow/watchdog outcomes. **A2A**: valid Agent Card and task endpoint with bounded auth and production-record-compatible idempotency; remote discovery and consumption without a core dependency. **Operator channel**: protocol; frame bounds; abort-on-disconnect; capability advertisement.

**Memory**: SQLite identity, migrations, ownership checks, corruption reporting; BuJo recall with and without embeddings, vector + FTS, dimension checks, circuit breaker, and keyword fallback; capture/admission with completed-turn idempotency; host-agent or Ollama memory-LLM behavior and consolidation schedules; strict audit, preview, rebuild, backup, forget, and intake retry. Lite and journal are cut rows, not parity requirements.

**State**: atomic canonical transcript with duplicate protection, provider-session linkage, verbatim append, and AskUser evidence; run recording with summaries, retention, runs CLI, stale-run classification, and memory-run separation; owner-private presence with stale detection; per-channel delivery-idempotency indexes.

**Continuations**: claim capability, origin binding, deadlines, size limits, durable leases, retries, cancellation, dead letters, named-route delivery, tool-free synthesis, idempotent receipts, unknown-delivery recovery, and `per-record-v3` compatibility; operator list/status/retry/cancel/resolve without token exposure.

**Observability**: structured event redaction and bounds; OTLP/Phoenix export with stable trace/session mapping, backpressure, flush/shutdown, and visible degradation.

**Security and sandbox**: no inline secrets; redaction in logs, errors, health, explain, and generated docs; owner-only file writes with symlink/ownership checks where promised; shared HTTP hardening for bind, bearer, Host/Origin, size limits, and shutdown; tool-policy monotonicity across fallback; SRT off/native modes, network policy, and fail-closed integrity.

**Operations**: start only after validation with process exclusivity; project-local pinned launch with drift-detecting provenance; declarative managed targets; read-only inspect/plan; explicit fingerprinted apply/remove; launchd install/start/restart/stop/status with bounded recovery and no resurrection after stop; foreground operation when deployment is absent; bounded logs and honest health aggregation with typed causes and no fake waiting success.

**Operator surfaces**: every wire interaction through the shared client; equivalent shared domain state and available actions from golden fixtures; config-selected application instances referencing channel-operator instances without credential duplication; independent on-demand/managed lifecycle; structured presentation of answers, reasoning, tools, warnings, compaction, usage, cost, and failover; feature assertions per renderer for directory/discovery, conversations, model/effort, cancel, live input, AskUser, quote, attachments, config, replay, and health; web durability for threads, uploads, active-turn survival, invalidation, and deletion rules.

**Setup**: scaffold contains only the CLI and selected `use` dependencies with exact versions, lockfile, composed schema, and names-only env example; minimal and maximal-safe fixtures round-trip; interactive provider discovery/auth with bounded real route checks and honest noninteractive behavior; transactional dotenv/file creation with review and no fake readiness; schema-derived config documentation and explain output.

**Contributor and release**: package and single-file path plugins run without a core/catalog edit; applications and companions implement one shared project-component contract; deployment adapters implement one reconciliation contract; package docs derive from metadata with drift gates; lockstep release enforces apiVersion/peer compatibility and packed-consumer verification.

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

There is no v0 config parser. Each consumer receives an explicitly authored v1 config and exact package closure, exercised via the programmatic project APIs (and optionally `--config`) with separate service ids, alternate ports, and Telegram/Slack disabled during shadow. A generated migration guide maps every v0 field to the agent envelope, a plugin/application/companion/deployment instance, or an explicit cut. Cutover occurs at a session rollover boundary.

Before mutation, `planAgentProject` must show the complete service and companion-registration diff and bind it to the digests of package.json, lockfile, config, path plugins, and observed platform state. The reviewed plan is the cutover artifact; a CLI transcript alone is not. `applyAgentProjectPlan` rejects drift and is the only path used by migration automation.

service-macos reads its desired state from `deployment`, then records absolute validated paths for Node, the project-local core runner entry, project root, config, protected env source, state, and logs plus the plan fingerprint. Service definitions never contain expanded secret values. It never shells through a human CLI command and never installs dependencies. Apply stages and promotes launchd definitions atomically; restart validates the replacement first; stop proves unload and process death; explicit remove disables recovery. If the block was never applied, omitting it creates no launchd state and the same project remains usable in foreground. An existing deployment is removed by selecting the adapter with `enabled: false`, applying its removal plan, and only then deleting the block/dependency. docs-mcp registrations follow the same plan/apply/remove and drift rules through their companion contract.

Rollback: stop and prove death of v1, reconcile continuation state, audit memory, restore a complete pre-cutover state backup only if format/records require it, load the retained v0 definition, prove version and health, and record the reason. Immediate rollback triggers are duplicate Telegram/Slack consumption, a missing or duplicated continuation result, memory loss/corruption, unprovable process identity, auth failure hidden by fallback, healthy-while-unavailable, missed schedule without explicit failure, crash loop, or a secret in any artifact.

## 11. Delivery gates

| Gate | Content | Exit evidence |
| --- | --- | --- |
| G0 — commitment | ADR ratifies ownership, explicit cuts, and migration policy; exact complexity classifier/baseline; atomic requirement manifest and generated ledger; stable task ids adopted | Reviewed ADR; baseline records SHA, file manifest, production/test counts and digest; every discovered behavior is kept or cut |
| G0.25 — archive and detach | Final full v0 release; `archive/v0-final-full` tag and `v0-maintenance` branch; local CLI, Personal Agent, A8C orchestrator, and linked workers pinned off repository main | Exact resolved versions, process commands, config paths, channel ownership, memory/continuation health, and bounded startup evidence |
| G0.5 — deletion-first v0 | WhatsApp, Supermemory, orchestrator extra, self-config including `tui --configure`, backfill, and unused dependency removed; migration/revival messages land | Focused tests and one broad CI gate green; no SELF-CONFIG surface remains; complexity delta recorded |
| G1 — config-first skeleton | plugin-sdk agent/project/deployment contracts; four-plane schema-composed config; selected-instance package/path loader; read-only load/validate/inspect/plan and explicit apply/launch APIs; core host loop; thin CLI; external hello plugin; Pi + webhook vertical slice; schema-driven scaffolder templates land before presets/wizard deletion; old doctor/config/app-controller machinery deleted | Packed clean-project smoke; minimal closure/native report; kernel trend; config/example/explain tests; no-side-effect and stale-plan tests; programmatic/CLI parity; check inventory published |
| G2 — operator foundation | Agent wire client, application directory, shared domain state machines and fixtures; channel-operator; TUI and web consume them as independently configured applications | Golden fixtures yield equivalent domain state/actions; application lifecycle/reference tests; dependency/static check finds no second wire decoder or eligibility reducer |
| G3 — runtimes and history | Canonical neutral transcript; four runtime plugins; Pi-native session/compaction delegation; old durable-history, compaction-driver, and shared session-lifecycle deleted | One bounded live smoke per family; settlement/history and cross-family fallback assertions green |
| G4 — channels | Seven channels on SDK contract; shared HTTP/security helpers and compliance suite; old channel glue, threading indexes, and repeated bootstraps deleted | Atomic channel rows green; bounded Telegram, Slack, A2A, and OpenAI-compatible client smokes; A2A record compatibility proven |
| G5 — durable capabilities | state-local, continuations with unchanged `per-record-v3`, memory-local BuJo-only, exporter-otlp, sandbox-srt; old state/memory/observability machinery and lite/journal modes deleted | Durable-state review; memory rehearsal; continuation corpus + week-of-records roundtrip; exporter and sandbox proofs |
| G6 — project composition and release | create-mono-agent; service-macos deployment adapter with managed-closure deletion; docs-mcp companion; generated docs; lockstep beta pipeline; migration guide | Minimal and maximal-safe npm/pnpm scaffolds from packed artifacts; all 25 packages accounted for; no-side-effect load; programmatic plan/apply/remove plus CLI parity; path/package plugin smokes; live macOS service and companion-registration smokes |
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
| V1-010 | G1 | V1-009 | Create plugin-sdk/core/cli package skeletons and category/dependency rules | Catalog, dependency, public API, pack checks |
| V1-011 | G1 | V1-010 | Implement agent-plugin, project-component, and deployment-adapter definitions plus manifests, redacted target descriptors, schemas, diagnostics, and CLI metadata | SDK type tests, import-side-effect instrumentation, and one compliance fixture per component kind |
| V1-012 | G1 | V1-011 | Implement strict agent/plugins/applications/companions/deployment envelope, schema composition, instance references, lifecycle/disabled semantics, explicit env sources, and provenance | Atomic config/reference/error/redaction tests; minimal and maximal envelope fixtures round-trip |
| V1-013 | G1 | V1-011, V1-012 | Implement selected direct-dependency loader and constrained single-file path-plugin loader; reject missing lockfile ownership | Package/path parity, realpath/import/digest/dependency negative tests; loading causes no lifecycle or install side effect |
| V1-014 | G1 | V1-011 | Implement secure-fs and HTTP lifecycle helpers | Adversarial filesystem and HTTP contract tests |
| V1-015 | G1 | V1-011, V1-012, V1-013 | Implement host lifecycle, bounds, settlement, health, shutdown, and host seams | Lifecycle/crash/backpressure tests |
| V1-016 | G1 | V1-012, V1-015 | Implement inspect/plan/apply/launch project APIs, operation receipts and stale-plan protection, thin CLI shell, validate, schema, explain, add, and configured contribution routing | Read-only load/inspect/plan tests; idempotent apply and partial-failure resume/rollback; programmatic/CLI parity; stale-plan rejection; exit-code/JSON compatibility; no dependency scan |
| V1-017 | G1 | V1-012, V1-016 | Land schema-derived minimal and selected-stack scaffolder templates, then delete presets, old wizard, and config-reference | Packed scaffold snapshots, exact dependency closure, names-only env example, and transactional-failure tests |
| V1-018 | G1 | V1-011, V1-016 | Convert doctor inventory to core validation plus plugin diagnostics; delete old orchestration | Every v0 check mapped to proof or reviewed cut |
| V1-019 | G1 | V1-013, V1-015 | Complete real Pi + webhook vertical slice and delete converted app-controller/config glue | Packed clean-project turn and minimal closure report |
| V1-020 | G2 | V1-011 | Extract operator protocol schemas and single-agent NDJSON client | Golden wire/frame/disconnect tests |
| V1-021 | G2 | V1-020 | Implement turn/stream/AskUser/capability and directory domain state machines | Deterministic reducer/action fixtures |
| V1-022 | G2 | V1-015, V1-020 | Extract channel-operator endpoint | Protocol compliance and abort-on-disconnect tests |
| V1-023 | G2 | V1-016, V1-021, V1-022 | Migrate TUI to the project-component contract and shared client/domain; delete local interpretations | Config-reference/lifecycle tests, TUI fixture parity, programmatic launch, and interactive smoke |
| V1-024 | G2 | V1-016, V1-021, V1-022 | Migrate web to the project-component contract and shared client/domain while retaining durable ownership/persistence | Config-reference and on-demand/managed lifecycle tests; web fixture parity, restart/upload/notification tests |
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
| V1-045 | G6 | V1-017, V1-030, V1-038 | Finish create-mono-agent for npm/pnpm, exact selected dependencies, and minimal/maximal-safe stacks | Packed scaffold matrix, config/package/lockfile closure checks, and first-turn smokes |
| V1-046 | G6 | V1-016, V1-024, V1-039, V1-040 | Build service-macos as the deployment-adapter contract over the core runner and delete managed-closure stack | Programmatic inspect/plan/apply/remove without human CLI commands; stale-plan, absent-deployment, install/restart/stop/drift/rollback live service smoke |
| V1-047 | G6 | V1-012, V1-016, V1-030, V1-038, V1-041, V1-042, V1-043, V1-044, V1-045 | Generate config/API/package docs; migrate docs-mcp to the companion contract and explicit registration reconciliation | Docs drift/accessibility/local-link gates; no-side-effect load; programmatic plan/apply/remove registration smoke |
| V1-048 | G6 | V1-023, V1-024, V1-030, V1-038, V1-041, V1-042, V1-043, V1-044, V1-045, V1-046, V1-047 | Adapt lockstep beta release and packed-consumer verification for every config plane | Clean registry-like install of minimal and maximal-safe stacks; all 25 packages mapped; foreground and managed lifecycle proofs |
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
| A single config grows into another monolith | Four explicit execution planes, package-owned leaf schemas, instance references instead of duplicated values, generated explain/reference output, and omission of every unused plane |
| Selecting a component unexpectedly mutates the host | Load, validate, inspect, and plan are contractually read-only; only explicit launch/apply crosses the side-effect boundary; fingerprint drift fails closed |
| The maximal example is copied as an allow-all production preset | It is labeled an integration fixture, binds network services to loopback, uses explicit secret references, leaves channel-send tools denied, and states that selection is not authorization |
| Twenty-five packages feel harder to explore than a monolith | Generated responsibility/dependency/config/API maps, standard READMEs, one minimal example, one maximal selection map, and scaffolded exact dependency closure |

### 13.2 Non-goals and explicit product cuts

Non-goals: backward-compatible v0 config parsing; v0 API shims; independent per-package versioning; malicious-plugin sandboxing; hosted marketplace; runtime package download or installation caused by config; side effects during load/validate/inspect/plan; importing v0 conversation/provider/run/web history; new end-user capabilities during migration; operator transport replacement; a universal cross-platform widget framework beyond shared wire/domain behavior; hot reload; Node SQLite/vector migration; Windows/Linux service managers; fleet-wide A8C worker migration during v1.

Explicit v1 cuts: conversational self-config and `tui --configure`; lite and journal memory modes; WhatsApp; Supermemory; the generic orchestrator extra; historical backfill/resend. These are not called unused. A consumer requiring one remains on frozen v0 or completes a separately approved migration/revival before its v1 cutover.

### 13.3 Plugin-candidates appendix

The OSS launch advertises these honest community/revival opportunities from the exact `archive/v0-final-full` source map: WhatsApp channel, Supermemory backend, collaborator-orchestration tools, conversational self-configuration product, lite/journal memory backends, and historical backfill tooling. Revival must implement the published v1 SDK/config/compliance contracts; it does not restore code to core or weaken a stable gate.

### 13.4 PRD maintenance

This document is the decision source until the G0 ADR and generated ledger exist. Thereafter architectural decisions live in the ADR, behavior status lives in the generated requirement report, execution status maps to the stable task ids in section 12, and product-decision changes update this PRD through review. Release criteria may tighten but never weaken without explicit approval. Examples never contain real consumer identifiers or secrets. The minimal and maximal-safe config blocks are executable generated fixtures: composed schemas must accept them, their package references must equal the expected dependency closure, and generated documentation must reproduce them without drift. Any v0 feature merged after this revision must be atomized in the requirement manifest or explicitly cut through a reviewed amendment before stable v1.
