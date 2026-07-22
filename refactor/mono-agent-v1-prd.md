# Mono-Agent v1: Config-First Plugin Platform

Status: Proposed
Target release: 1.0 beta, followed by 1.0 stable
Last updated: 2026-07-22
Primary audience: maintainers, contributors, and individual agent builders
Decision scope: the complete v1 architecture, feature migration, product split, and production rollout

## 1. Executive summary

Mono-agent will become a production-grade, config-first wrapper around independently selected agent runtimes and integrations. Its core will be a small operational kernel. Runtime harnesses, provider integrations, channels, memory, persistence, observability, operator surfaces, and operating-system services will live outside that kernel as plugins or products.

This is a clean public break from the v0 package graph and configuration model. It is not a feature-reduction project. Stable v1 is blocked until every current package, public CLI workflow, runtime bridge, communication channel, persistence behavior, operational control, and operator experience has a recorded v1 destination and passing verification. A capability may be retired only when its user outcome is preserved elsewhere and the disposition is explicit.

The v1 distribution remains one pnpm monorepo, but packages release independently. A generated project owns an ordinary package.json and lockfile and installs only its selected runtime and plugins. The global entry point may help create or locate a project, but execution always resolves through that project's direct dependencies and project-local CLI.

The first production proof is the migration of Personal Agent and A8C Assistant. They will run project-local pinned installations, preserve their existing memory, and migrate sequentially so Telegram and Slack never have duplicate consumers.

## 2. Why this change is necessary

The existing system has sound modular building blocks, but the application layer has accumulated too many responsibilities:

- agent-app composes runtimes, the harness, channels, memory, history, observability, setup, authentication, macOS services, configuration proposals, and operator products;
- the core app statically depends on most concrete integrations even when a project does not use them;
- the runtime package groups five bridges under one release and ownership surface;
- configuration is represented in parallel persisted types, resolved types, environment mappings, field registries, setup modules, config views, handwritten references, and generated documentation;
- setup and diagnostics centrally know provider and adapter details;
- TUI and web share a transport but duplicate client, state, presentation, and capability logic;
- optional capabilities use several unrelated extension seams instead of one lifecycle and validation contract;
- current waiting states can let missing selected capabilities validate successfully;
- the macOS service copies a managed runtime closure instead of launching the project's pinned installation.

The result is more code and a larger contribution surface than the framework's actual job requires. The v1 design reduces the ownership boundary while preserving production behavior.

## 3. Product frame

### 3.1 Target users

Primary user: an individual builder operating one or more serious local agents.

Their jobs are:

- define an agent through one understandable configuration file;
- select a runtime without committing to one vendor or harness;
- install only the channels and capabilities they use;
- validate the complete setup before starting it;
- run the agent reliably as a foreground process or managed local service;
- inspect, chat with, configure, and recover the agent through consistent operator interfaces;
- upgrade individual components without an all-packages lockstep release;
- understand failures without reading framework internals.

Secondary user: an open-source contributor or integration author.

Their jobs are:

- find the correct ownership boundary quickly;
- implement one plugin without editing the application kernel;
- declare configuration once and derive types, validation, documentation, and setup UX from it;
- run a reusable compliance suite;
- publish on an independent lifecycle;
- receive deterministic errors when a contribution violates the platform contract.

### 3.2 Desired outcomes

- A minimal mono-agent project is visibly small and contains only selected integrations.
- The core package graph is stable, adapter-neutral, and easy to review.
- Pi, Claude, Codex, and OpenCode remain first-class runtime families.
- Configuration becomes the primary product API and has one source of truth.
- TUI, web, and future operator shells reuse one headless application interface.
- Production features survive the migration with explicit owners and regression tests.
- New contributors can navigate from product capability to owning package without reverse-engineering agent-app.

### 3.3 Non-goals

- Backward-compatible parsing of v0 configuration.
- Runtime shims that preserve v0 public package APIs.
- A hosted plugin marketplace or cloud registry.
- Isolation or sandboxing of untrusted plugin JavaScript.
- A fleet-wide migration of every A8C agent.
- Importing v0 run artifacts, sessions, provider transcripts, or web-console state.
- Adding new end-user agent capabilities during the architecture migration.
- Pixel-identical TUI and web rendering.
- A Windows or Linux service manager in v1; foreground execution remains portable and the first service product is macOS-only.
- Hot reloading of plugins or configuration; changes apply after validation and restart.

## 4. Product principles

1. Config first. A normal user composes an agent without writing host code.
2. Smallest sufficient ownership. Core owns coordination; integrations own integration behavior.
3. Explicit selection. Installed or configured capabilities are never inferred from global state.
4. Fail closed. Missing, incompatible, or unsafe selected capabilities are errors, not successful waiting states.
5. One schema owner. A field is declared once and every other representation is generated.
6. Runtime plurality. Cross-runtime routing is a platform feature, while provider behavior remains plugin-owned.
7. Native renderers, shared application. Operator behavior is shared; terminal and browser presentation remain native.
8. Project-local production. The project's package manifest and lockfile determine what executes.
9. Observable failure. Runtime, plugin, delivery, and lifecycle failures retain typed causes and never become fake success.
10. Strangler delivery, clean destination. New v1 paths may coexist with v0 during implementation, but v1 contains no permanent compatibility layer.

## 5. Success metrics and release gates

| Measure | Beta target | Stable target |
| --- | --- | --- |
| Core ownership | Core and plugin SDK only | Same, enforced in CI |
| Concrete integrations in core closure | Zero | Zero |
| Current package dispositions | 22 of 22 recorded | 22 of 22 closed |
| Current public CLI dispositions | 20 of 20 recorded | 20 of 20 closed |
| Runtime families | Pi, Claude, Codex, OpenCode execute real smoke turns | All focused, contract, and live tests pass |
| Config definitions | No duplicated field registry in new v1 path | Old parallel config machinery removed |
| Third-party plugin path | Example plugin loads without core edit | Packaged compliance example passes from a clean project |
| Minimal scaffold | Contains only selected runtime and plugins | Verified under npm and pnpm from packed artifacts |
| Operator architecture | TUI and web consume shared controller/state | Shared contract suite and renderer parity suite pass |
| Personal Agent | Full selected stack on beta | 24-hour healthy soak and stable adoption |
| A8C Assistant | Full selected stack on beta | 24-hour healthy soak including business hours |
| Duplicate delivery | Zero Telegram/Slack concurrent-consumer incidents | Zero through stable cutover |
| Memory continuity | Copy-based audit and recall parity | Canonical store audit and rollback proof |
| Feature ledger | Every row assigned | Every row migrated or outcome-preserving retirement approved |

Stable v1 is not permitted while any ledger row is unassigned, unverified, or marked as an ambiguous follow-up.

## 6. Delivery method and governance

The work uses a stage-gated strangler migration with vertical slices:

- Stage gates protect architecture, security, data continuity, production cutover, and release decisions.
- Each implementation slice must run end to end through config, plugin loading, execution, health, and user-facing verification.
- Horizontal framework work is allowed only when it independently reduces a named risk or enables the next vertical slice.
- Each slice lands in an isolated worktree and focused PR.
- Architecture, configuration/security, memory migration, and production cutover require an independent reviewer.
- Production writes, service replacement, npm publication, and canonical memory cutover require explicit maintainer approval.

No implementation wave may solve unrelated feature requests. Newly discovered behavior is added to the parity ledger before it is changed.

## 7. Target architecture

### 7.1 Logical tiers

Core:

- @mono-agent/plugin-sdk
- @mono-agent/core

Plugins:

- runtimes;
- communication channels;
- memory and history;
- recording and export;
- local discovery;
- sandboxing;
- continuations;
- tools and MCP capabilities;
- plugin-owned diagnostics and CLI extensions.

Products:

- @mono-agent/cli;
- create-mono-agent;
- @mono-agent/operator;
- @mono-agent/tui;
- @mono-agent/web;
- @mono-agent/service-macos;
- @mono-agent/self-config;
- @mono-agent/skills-manager;
- @mono-agent/docs-mcp.

Physical workspace layout remains flat under the existing packages and extras rules. Tier and dependency rules live in the package catalog; this project does not spend a migration wave moving directories for appearance.

### 7.2 Dependency direction

Diagram summary: core depends only on the plugin SDK and general-purpose utilities. Plugins depend on the SDK and, when necessary, another explicitly allowed capability package. Products compose core and selected plugins. Core never imports a concrete plugin or product.

    products ───────► core ───────► plugin-sdk
       │               ▲
       ├──────────────►│
       └──────────────► plugins ──► plugin-sdk

The architecture checker must reject:

- a core dependency on a runtime, channel, memory implementation, database, exporter, UI framework, or service manager;
- a plugin importing agent application/controller internals;
- a runtime plugin importing a communication adapter;
- a renderer importing a runtime or channel implementation;
- a central catalog edit as a requirement for loading a third-party plugin;
- circular capability requirements.

### 7.3 Core responsibility

@mono-agent/core owns:

- project and config loading;
- project-local plugin resolution;
- schema composition and resolved-source provenance;
- plugin dependency ordering and lifecycle;
- request, turn, and session coordination;
- context and selected-skill composition;
- concurrency, pending-run limits, cancellation, and backpressure;
- live-input admission and settlement;
- runtime route selection and fallback;
- adapter-neutral tool, approval, MCP, and sandbox policy negotiation;
- structured event flow;
- health aggregation;
- foreground lifecycle and graceful shutdown.

Core does not own:

- provider SDKs, CLIs, authentication, or model catalogs;
- chat transports or HTTP integration protocols;
- a memory algorithm or storage engine;
- run/history persistence;
- observability exporters;
- global discovery storage;
- user interfaces;
- configuration wizards;
- operating-system services;
- package installation.

### 7.4 Plugin responsibility

Each plugin has one primary kind:

- runtime;
- channel;
- memory;
- history;
- recorder;
- exporter;
- discovery;
- sandbox;
- tool;
- mcp;
- continuation;
- diagnostic.

A plugin may also expose diagnostics and namespaced CLI commands that operate only on its own data and lifecycle. Those adjuncts do not change its primary ownership.

Plugins execute as trusted in-process project dependencies. The loader does not claim to isolate malicious plugin code. The documentation and validation output must state this trust boundary.

## 8. Public contracts

### 8.1 Plugin definition

The plugin SDK exposes a single authoring entry point:

    definePlugin({
      manifest,
      schema,
      create
    })

PluginManifest contains:

- id: stable package-level identifier;
- apiVersion: exactly 1 for v1;
- version: package version;
- kind: one primary plugin kind;
- requires: optional capability requirements, not package-manager installation requests;
- description: one responsibility statement.

The create function receives resolved, validated plugin config and a capability-scoped PluginContext. It returns the primary contribution plus optional diagnostics, CLI extensions, and cleanup.

PluginContext exposes only:

- structured logger;
- lifecycle AbortSignal;
- clock and identifier helpers;
- event publication;
- declared host capabilities required by the contribution;
- secret-safe project paths explicitly granted to that plugin.

It does not expose an application controller, mutable plugin registry, arbitrary configuration, or undeclared integration instances.

### 8.2 Core entry points

The stable programmatic surface is:

- loadAgentProject(options): read the config source, resolve direct plugin dependencies, compose schemas, resolve explicit sources, and return a provenance-bearing project;
- validateAgentProject(project, options): perform structural checks and optional bounded live diagnostics without starting long-lived channels;
- createAgentHost(project, options): construct a host with run, start, health, and stop operations.

The host supports:

- run(request): one-shot execution without requiring an ingress channel;
- start(): initialize enabled long-lived contributions and require at least one runtime and one ingress;
- health(): aggregate core and plugin health with machine-readable causes;
- stop(): abort admissions, drain bounded work, stop plugins in reverse dependency order, and dispose resources idempotently.

### 8.3 Runtime contract

One plugin exists per runtime family:

- @mono-agent/runtime-pi, owning the Pi SDK gateway and local/custom Pi providers;
- @mono-agent/runtime-claude, owning Claude SDK and Claude Code CLI modes;
- @mono-agent/runtime-codex, owning Codex app-server;
- @mono-agent/runtime-opencode, owning OpenCode app-server.

The normalized runtime contract preserves:

- streaming events;
- final text and structured result;
- usage, cost, model, effort, and provider metadata;
- tool and MCP options;
- approval requests and decisions;
- cancellation;
- acknowledged live input;
- provider session resume, refresh, retirement, and invalidation when supported;
- compaction records;
- bounded diagnostics;
- classified failures.

Cross-runtime routing belongs to core. Runtime plugins declare capabilities. Core rejects or skips an incompatible route before sending capability-bearing input.

Failure classes are:

- configuration;
- authentication;
- permission or approval;
- policy or sandbox;
- unsupported capability;
- invalid request;
- cancellation;
- rate limit;
- transient provider;
- model unavailable;
- context exhausted;
- provider internal;
- unknown.

Configuration, authentication, permission, policy, unsupported-capability, and invalid-request failures are terminal. Fallback may advance only for failure classes explicitly marked retryable by the route policy.

### 8.4 Channel contract

Channel plugins:

- validate and redact their own configuration;
- emit normalized inbound requests;
- create and manage transport-specific reply streams;
- declare attachment, live-input, AskUser, proactive-delivery, and runtime-control capabilities;
- enforce their own allowlists and transport authentication;
- expose bounded health and diagnostics;
- own reconnect behavior after a successful initial start;
- stop idempotently.

Initial failure of an enabled channel is a start failure. A transport that becomes unavailable later may report degraded while it performs bounded recovery. It may not report healthy while disconnected.

### 8.5 State and durability contracts

Core coordinates state but does not select a storage format.

- History plugins persist canonical conversation turns and provider-session linkage.
- Recorder plugins persist structured run evidence and summaries.
- Memory plugins own recall, capture, completed-turn admission, audit, rebuild, and maintenance behavior.
- Discovery plugins publish and query local agent presence and health.
- Continuation plugins own durable claims, leases, results, delivery state, and operator maintenance.

Every durable plugin must document:

- filesystem or remote ownership boundary;
- atomicity and idempotency guarantees;
- schema/version behavior;
- retention;
- backup and restore;
- reset, purge, or forget surface;
- corruption and partial-write behavior;
- redaction and secret handling.

## 9. Configuration product specification

### 9.1 Canonical file

The canonical new-project file is mono-agent.config.json:

    {
      "$schema": "./.mono-agent/schema.json",
      "configVersion": 1,
      "agent": {
        "id": "personal-agent",
        "instructions": "./AGENTS.md",
        "runtime": {
          "primary": {
            "plugin": "pi",
            "model": "openai-codex:gpt-5.6-sol"
          },
          "fallbacks": [
            {
              "plugin": "codex",
              "model": "gpt-5.6-sol"
            }
          ]
        },
        "session": {
          "mode": "continuous",
          "rollover": "daily",
          "rolloverTimezone": "Europe/Amsterdam"
        },
        "concurrency": {
          "maxConcurrentRuns": 1,
          "maxPendingRuns": 16
        }
      },
      "plugins": {
        "pi": {
          "use": "@mono-agent/runtime-pi",
          "config": {}
        },
        "codex": {
          "use": "@mono-agent/runtime-codex",
          "config": {}
        },
        "telegram": {
          "use": "@mono-agent/channel-telegram",
          "config": {
            "botToken": {
              "$env": "TELEGRAM_BOT_TOKEN"
            },
            "allowedChatIds": ["123456"]
          }
        },
        "memory": {
          "use": "@mono-agent/memory-local",
          "config": {
            "mode": "bujo",
            "path": "./memory"
          }
        }
      },
      "policy": {
        "allowedTools": ["Read", "Grep", "Glob"],
        "disallowedTools": []
      }
    }

plugins is keyed by local instance ID. Multiple instances of one package are legal when the contribution contract supports it. enabled defaults to true and may be set false for a configured but intentionally inactive instance.

Runtime primary and fallback entries reference runtime instance IDs. This avoids duplicating plugin setup and permits explicit cross-runtime fallback.

### 9.2 One schema source

Core and each plugin export one executable Zod 4 schema. Schema metadata includes:

- title and description;
- examples;
- default;
- secret classification;
- setup prompt hints;
- path semantics;
- deprecation or replacement information;
- safety notes;
- whether an environment reference is allowed.

The schema is the only handwritten definition. From it the platform derives:

- input and resolved TypeScript types;
- runtime validation;
- defaults;
- composed project JSON Schema;
- editor completion;
- secret redaction;
- config explanation and provenance;
- generic setup questions;
- generated field documentation;
- validation fixtures.

No v1 package may introduce a parallel field registry, persisted shadow interface, env-key map, handwritten config reference table, or wizard fragment that restates schema facts.

Complex provider authentication remains a plugin-owned command or guided step. Schema metadata describes the field; it does not attempt to encode OAuth workflows.

### 9.3 Source and precedence rules

- JSON is authoritative for all non-secret settings.
- Unknown fields are errors at every level.
- Paths resolve relative to the selected config file.
- Defaults exist only in schemas.
- Environment values never override JSON fields implicitly.
- An explicit source object containing $env may replace a schema-approved scalar.
- A present $env reference with no value is an error.
- Secret-marked fields reject inline persisted values and require an approved reference.
- The CLI loads the selected project dotenv file and overlays the actual process environment into one secret environment. That environment is consulted only for named $env references.
- The default dotenv path is .env beside the config. --env-file selects another file explicitly.
- No string interpolation, config inheritance, profile overlay, or ambient MONO_AGENT_* mapping exists in v1.
- Alternate profiles are separate complete config files selected by --config.
- No configuration hot reload exists; validate and restart apply changes.

### 9.4 Loading flow

1. Read and parse strict JSON.
2. Validate the core envelope sufficiently to identify plugin entries.
3. Confirm every use package is a direct dependency of the project package.json.
4. Resolve packages relative to the project, never the global CLI or monorepo root.
5. Load and validate manifests and apiVersion.
6. Compose the full schema from the core and selected plugins.
7. Resolve explicit source references while recording provenance.
8. Apply schema defaults and strict validation.
9. Validate capability requirements, collisions, and cycles.
10. Produce a redacted ResolvedAgentProject.
11. Initialize contributions only after the complete project validates.

Runtime startup never invokes npm, pnpm, yarn, or lifecycle scripts.

### 9.5 Config commands

- mono-agent validate performs static readiness and exits non-zero for every missing selected package, secret, capability, or invalid field.
- mono-agent doctor runs validate and bounded live plugin diagnostics. It never starts a long-lived channel.
- mono-agent config schema --write regenerates .mono-agent/schema.json from the installed project graph.
- mono-agent config explain prints the resolved value, source kind, owning schema, default status, and safe remediation while redacting secrets.
- mono-agent add package installs an exact dependency with the detected project package manager, adds a disabled or minimal config entry after confirmation, and regenerates the schema.
- mono-agent init creates a selected stack through the scaffolder; it is not a second config engine.

Generated schema metadata records the selected plugin package names and versions. validate reports a stale generated schema but always validates against the live composed schemas.

## 10. Unified operator product

### 10.1 Goal

TUI and web become renderers of one headless operator application rather than separate applications that happen to call the same endpoint.

@mono-agent/operator owns:

- protocol schemas;
- transport-neutral client;
- discovery interface;
- controller and state machine;
- actions and events;
- agent, conversation, message, turn, activity, AskUser, attachment, config, replay, and health view models;
- capability negotiation;
- persistence ports;
- deterministic reducers and contract fixtures.

It has no React, assistant-ui, pi-tui, Express, SQLite, browser, or terminal dependency.

### 10.2 Public operator interfaces

The stable application surface includes:

- OperatorTransport;
- OperatorDirectory;
- OperatorStore;
- OperatorClient;
- OperatorController;
- OperatorState;
- OperatorAction;
- OperatorEvent;
- OperatorCapabilities;
- OperatorAgent;
- OperatorConversation;
- OperatorMessage;
- OperatorTurn;
- OperatorActivity;
- OperatorAsk;
- OperatorAttachment;
- OperatorConfigView;
- OperatorReplayView.

The action vocabulary includes:

- refresh and select agent;
- pin or unpin agent;
- create, rename, archive, unarchive, and delete conversation;
- select conversation;
- send turn;
- send or settle live input;
- cancel turn;
- answer AskUser;
- set or clear model and effort override;
- stage, attach, inspect, and remove attachment;
- quote or clear quote;
- open config, replay, or health view;
- request self-configuration;
- exit a renderer without stopping the agent.

### 10.3 Agent-side operator channel

@mono-agent/channel-operator exposes the versioned agent protocol. It replaces the TUI-named server boundary and advertises capabilities for:

- turns and structured streaming;
- cancellation;
- live input;
- AskUser snapshots and submission;
- attachments;
- verbatim history append;
- model/effort choices;
- health;
- config projection;
- replay projection when a recorder is selected;
- self-config when the product is installed.

The protocol keeps bounded frame sizes, aborts a turn on client disconnect unless a durable operator service has assumed ownership, and never advertises a route the host cannot fulfill.

### 10.4 Renderers

@mono-agent/tui owns:

- pi-tui rendering;
- keyboard and slash-command mapping;
- safe terminal text;
- terminal file selection;
- compact terminal layouts.

@mono-agent/web owns:

- React and assistant-ui rendering;
- responsive browser layout and PWA;
- browser file picker and bounded upload transport;
- browser notifications;
- SSE invalidation for multiple tabs;
- a durable SQLite implementation of OperatorStore;
- web host/origin and LAN/Tailscale safety.

Both must use the shared controller, reducers, DTOs, capability checks, remote client, and golden event fixtures. They may not maintain independent model/effort, AskUser, live-input, activity, or turn-state logic.

Both renderers support:

- running-agent discovery and selection;
- multiple conversations;
- offline/read-only state;
- streaming Markdown;
- structured reasoning, tools, warnings, compaction, usage, cost, and failover;
- model and effort override;
- cancellation;
- live follow-up with pending, applied, queued, discarded, and cancelled settlement;
- multi-question AskUser;
- quoting;
- attachments where the platform can provide files;
- redacted config;
- bounded replay;
- health;
- self-config entry when available.

Platform-only behavior remains adapter-owned. Browser notifications do not need a terminal equivalent. Terminal keybindings do not need a browser equivalent.

### 10.5 Other product boundaries

@mono-agent/self-config owns the optional proposal tool, low-risk patch allowlist, review model, atomic config/Role transaction, restart, readiness proof, and rollback. The shared operator renders its state but cannot acquire mutation authority on its own.

@mono-agent/discovery-local owns the owner-private local presence registry and heartbeat records. Observability exporters no longer own agent discovery.

@mono-agent/service-macos owns launchd lifecycle and makes readiness decisions using core health plus local discovery. Neither renderer owns service mutation.

## 11. Current package disposition

Every entry in the current package catalog has a destination:

| Current package | Disposition | v1 owner and preserved outcome |
| --- | --- | --- |
| @mono-agent/a2a-adapter | Replace package name | @mono-agent/channel-a2a preserves provider Agent Card, inbound A2A tasks, remote discovery/consumption, authentication, streaming, and shutdown |
| @mono-agent/agent-app | Retire | Composition moves to core; user commands to CLI/products; setup to scaffolder; service lifecycle to service-macos; self-config to self-config |
| @mono-agent/agent-contracts | Retire | Adapter-neutral host contracts move to plugin-sdk; operator protocol and view contracts move to operator |
| @mono-agent/agent-harness | Retire | Turn/session coordination moves to core; history persistence to history-jsonl; provider session operations to runtime plugins |
| @mono-agent/agent-orchestrator | Replace package name | @mono-agent/tool-orchestrator preserves request-scoped collaborator exposure through bounded MCP tools |
| @mono-agent/agent-runtime | Split | runtime-pi, runtime-claude, runtime-codex, and runtime-opencode preserve all five bridges |
| @mono-agent/config | Retire | Core envelope schema moves to core; integration config moves to each plugin; schema helpers move to plugin-sdk |
| @mono-agent/cron-adapter | Replace package name | @mono-agent/channel-cron preserves JSON/Markdown jobs, scheduling, overlap behavior, result taxonomy, cancellation, and notifications |
| @mono-agent/docs-mcp | Retain as product | Remains an optional version-matched documentation search/reading companion |
| @mono-agent/memory | Replace package name | @mono-agent/memory-local preserves SQLite substrate, lite, journal, BuJo, embeddings, capture, consolidation, and maintenance |
| @mono-agent/memory-supermemory | Retain as plugin | Preserves remote recall/capture, completed-turn admission, MCP exposure, and health |
| create-mono-agent | Retain as product | Becomes the selected-stack scaffolder and project-local CLI bootstrap |
| @mono-agent/observability | Split | recorder-jsonl owns run evidence; exporter-otlp owns Phoenix/OTLP; discovery-local owns presence; history-jsonl owns durable conversation history |
| @mono-agent/openai-api-adapter | Replace package name | @mono-agent/channel-openai-api preserves model discovery and Chat Completions compatibility |
| @mono-agent/operator-adapter | Split and rename | channel-operator owns the agent endpoint; operator owns protocol, client, state, and view models |
| @mono-agent/runtime-adapter | Retire | Neutral runtime contract/routing moves to SDK/core; provider logic to runtime plugins; SRT to sandbox-srt |
| @mono-agent/slack-adapter | Replace package name | @mono-agent/channel-slack preserves Socket Mode, Slack UI controls, allowlists, steering, AskUser, and delivery |
| @mono-agent/telegram-adapter | Replace package name | @mono-agent/channel-telegram preserves polling, media, transcription, steering, commands, AskUser, and delivery |
| @mono-agent/tui | Retain as product | Becomes a thin native renderer over operator |
| @mono-agent/web | Retain as product | Becomes a web renderer and durable service adapter over operator |
| @mono-agent/whatsapp-adapter | Replace package name | @mono-agent/channel-whatsapp preserves inbound admission and buffered final delivery |
| @mono-agent/webhook-adapter | Replace package name | @mono-agent/channel-webhook preserves sync/async endpoints, prompts, auth, status, and notification behavior |

Additional v1 packages required to separate current app-owned behavior:

| New package | Responsibility |
| --- | --- |
| @mono-agent/core | Operational kernel |
| @mono-agent/plugin-sdk | Plugin authoring and neutral contribution contracts |
| @mono-agent/cli | Project-local command router and core commands |
| @mono-agent/operator | Headless operator application |
| @mono-agent/channel-operator | Agent-side operator protocol |
| @mono-agent/history-jsonl | Canonical durable conversation history and provider-session linkage |
| @mono-agent/recorder-jsonl | Run events, summaries, retention, audit, report, and backfill source |
| @mono-agent/exporter-otlp | Best-effort OTLP export, including Phoenix |
| @mono-agent/discovery-local | Local agent presence, health, and endpoint registry |
| @mono-agent/sandbox-srt | SRT discovery, integrity, policy compilation, and command preparation |
| @mono-agent/continuations | Durable continuation claims, processing, delivery, and operator maintenance |
| @mono-agent/service-macos | Project-local launchd installation, control, recovery, and logs |
| @mono-agent/self-config | Proposal-only conversational configuration transaction |
| @mono-agent/skills-manager | Managed project skills and documentation companion pairing |

The final package set may contain more publishable packages than v0. The lean-core requirement is about the ownership and dependency closure of a selected application, not minimizing repository package count at the expense of mixed responsibilities.

## 12. Public CLI disposition

All 20 current public command names are accounted for:

| Current command | v1 command or product | Required behavior |
| --- | --- | --- |
| init | create-mono-agent and mono-agent init | Selected runtime/plugins, exact dependencies, config, schema, instructions, examples, and optional readiness |
| setup | No canonical alias | Migration docs point to init; no separate setup engine |
| validate | mono-agent validate | Strict structural readiness with non-zero failure |
| doctor | mono-agent doctor | Validate plus bounded live diagnostics; no longer only an alias |
| auth | Runtime namespaced commands | Provider-owned login, key intake, account inspection, and redacted status |
| sandbox | sandbox-srt namespaced commands | Effective policy, engine integrity, status, and safe remediation |
| config | mono-agent config | explain, schema, and validation helpers; never a second mutation system |
| presets | Scaffolder templates | Templates select packages and seed schema-owned values; no duplicate recipe registry |
| start | mono-agent start | Foreground by default unless a selected service product handles background lifecycle |
| restart | Service command when installed | Validate before replacement and prove new readiness |
| stop | Service command when installed | Prove manager unload and process death |
| status | Core and service status | Report project version, process, config, plugins, channels, memory, and health honestly |
| logs | Service/recorder command | Bounded logs with follow and explicit source |
| tui | @mono-agent/tui extension | Open the shared operator application in a terminal renderer |
| web | @mono-agent/web extension | Manage or report the persistent web renderer/service |
| install-skill | @mono-agent/skills-manager extension | Check/update managed copies transactionally and pair docs MCP explicitly |
| backfill | recorder/exporter extension | Select, map, dry-run, and export recorded runs |
| runs | recorder-jsonl extension | List, inspect, audit, summarize, and report runs |
| memory | Selected memory extension | Health, preview, audit, rebuild, intake, retry, resolve, and backend-specific maintenance |
| continuations | continuations extension | List, inspect, retry, cancel, resolve unknown, and report health |

Plugin and product commands are namespaced contributions discovered from direct project dependencies. The CLI must reject command collisions and must not hardcode provider, channel, memory-backend, exporter, or renderer implementation details.

## 13. Feature parity requirements

The following ledger is normative. Each requirement needs focused tests and must be included in a stable release gate.

### 13.1 Core, context, and execution

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| CORE-001 | Build system context from instructions, identity, optional Soul, prior history, memory, selected skills, request metadata, and attachments in deterministic order | core | Golden context fixtures and size-bound tests |
| CORE-002 | Load selected project skills with index or full disclosure, byte limits, caching, and separate ReadSkill policy | core and skills-manager | Unit tests plus project-skill smoke |
| CORE-003 | Normalize inbound request, reply stream, structured events, AskUser, attachments, reply destination, and cancellation | plugin-sdk and core | Contract suite used by every channel |
| CORE-004 | Enforce allowed/disallowed tools, MCP selection, request-scoped MCP additions, timeouts, and authoritative overrides without privilege widening | core | Policy intersection and adversarial tests |
| CORE-005 | Preserve max concurrent runs, bounded pending runs, fair admission, cancellation, and backpressure | core | Deterministic concurrency tests |
| CORE-006 | Preserve continuous and per-message sessions, idle expiry, daily rollover, timezone, notices, proactive isolation, and cold history replay | core, history-jsonl, runtimes | Session matrix tests |
| CORE-007 | Commit canonical history only after successful settlement and preserve completed AskUser evidence | core and history-jsonl | Crash/duplicate/AskUser history tests |
| CORE-008 | Accept live guidance only through acknowledged runtime capability and retain a normal-turn fallback without dropping text | core and runtimes | Race and settlement tests |
| CORE-009 | Route proactive results to the exact authorized destination, support verbatim delivery, suppress NOTHING_TO_REPORT, and report non-delivery without changing trigger success | core and channel plugins | Cron/webhook delivery tests |
| CORE-010 | Expose request-scoped RunHistory over completed runs with bounded, redacted, paged output | recorder-jsonl tool contribution | Search/pagination/redaction tests |
| CORE-011 | Support programmatic one-shot and long-lived host use without the CLI | core | Packed TypeScript consumer |
| CORE-012 | Preserve effort keyword escalation and request-level model/effort overrides without mutating configured defaults | core and runtime plugins | Route override tests |
| CORE-013 | Let channel plugins contribute explicitly selected outbound send tools while preserving destination allowlists, tool policy, and safe non-exposure by default | channel plugins and core | Tool registration, authorization, and default-deny tests |

### 13.2 Runtime families

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| RUN-001 | Pi SDK execution with built-in providers, OAuth/API-key resolution, transport choice, retry bounds, tool steering, durable sessions, and external Pi harness behavior | runtime-pi | Focused suite and live Pi smoke |
| RUN-002 | Claude SDK execution with streaming, tools/MCP, structured output, approval, usage, and session resume | runtime-claude | Focused suite and live SDK smoke |
| RUN-003 | Claude Code CLI execution with native capabilities and safe process lifecycle | runtime-claude | CLI integration and live smoke |
| RUN-004 | Codex app-server execution with account model discovery, approvals, events, live input where supported, usage, and thread lifecycle | runtime-codex | App-server integration and live smoke |
| RUN-005 | OpenCode app-server execution with provider/model refs, stable CLI guard, native capability reporting, and session lifecycle | runtime-opencode | App-server integration and live smoke |
| RUN-006 | Ollama, LM Studio, and OpenAI-compatible local providers with private/public URL policy, model discovery, capabilities, pricing metadata, and no hosted fallback | runtime-pi | Local fake server and one real local smoke |
| RUN-007 | Ordered same-runtime and cross-runtime fallback with capability checks and typed failure classification | core | Router matrix and injected failures |
| RUN-008 | Tool output, Bash, MCP, search, image, call-timeout, and total-timeout bounds | runtime plugins | Limit and oversized-payload tests |
| RUN-009 | Context compaction thresholds, adaptive budgets, summaries, savings gate, records, and UI events | runtime plugins and core events | Context-boundary and event tests |
| RUN-010 | Human approval gates remain explicit and cannot be converted to allow-all by an incapable route | runtime plugins and core | Approval/capability adversarial tests |
| RUN-011 | Provider configuration, authentication, and model discovery are plugin-owned and usable by scaffolder and doctor | runtime plugins | Plugin CLI/setup contract tests |
| RUN-012 | Provider errors retain cause, safe diagnostics, and runtime provenance without secret leakage | runtime plugins | Error taxonomy and redaction tests |

### 13.3 Telegram

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| TG-001 | Poll authorized chats, enforce allowlists, normalize mentions/text, and stop cleanly | channel-telegram | Adapter integration tests |
| TG-002 | Accept bounded documents, photos, audio, and shared attachment metadata without trusting filenames or paths | channel-telegram | Media and adversarial filename tests |
| TG-003 | Optionally transcribe voice through configured capability and report unsupported/failure honestly | channel-telegram | Transcription contract tests |
| TG-004 | Render transient thought/tool activity, update in place, and replace it with the final response without synthetic clutter | channel-telegram | Stream golden tests |
| TG-005 | Preserve live follow-up steering with fallback, cancellation, model/effort controls, and supported commands | channel-telegram and core | Conversation race tests |
| TG-006 | Render and settle structured AskUser safely | channel-telegram | AskUser interaction tests |
| TG-007 | Support authorized proactive and verbatim delivery with duplicate keys and durable history ordering | channel-telegram | Delivery/idempotency tests |

### 13.4 Slack

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| SLK-001 | Run one Socket Mode consumer, enforce channel/DM allowlists, normalize mentions, and reconnect after successful start | channel-slack | Socket fixture and reconnect tests |
| SLK-002 | Preserve threads and conversation IDs across ordinary, assistant, DM, and proactive flows | channel-slack | Conversation identity matrix |
| SLK-003 | Prefer assistant-thread status, fall back to reaction, maintain one transient tool ledger, then post the final as a fresh reply | channel-slack | Web API golden tests |
| SLK-004 | Preserve live steering, cancellation, model/effort controls, and normal-turn fallback | channel-slack and core | Race and command tests |
| SLK-005 | Render bounded multi-question AskUser with Block Kit and safe free-text fallback | channel-slack | Interaction payload tests |
| SLK-006 | Preserve configured shortcuts, App Home actions, and their authorization | channel-slack | Shortcut/action tests |
| SLK-007 | Preserve final-only and silent-delivery limitations explicitly | channel-slack | Capability and documentation tests |
| SLK-008 | Support authorized proactive/verbatim delivery without duplicate final replies | channel-slack | Idempotency tests |

### 13.5 Webhook, OpenAI API, cron, A2A, and WhatsApp

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| WHK-001 | Support multiple named webhook endpoints with per-endpoint auth, prompt, model/effort, conversation, reply-to, sync/async, timeout, and safe bind | channel-webhook | HTTP compatibility matrix |
| WHK-002 | Preserve request/status identifiers, terminal status contract, cancellation, and native notification behavior | channel-webhook | Async lifecycle tests |
| OAI-001 | Expose model discovery and streaming/non-streaming Chat Completions with correct SSE/JSON termination | channel-openai-api | Compatibility suite |
| OAI-002 | Preserve conversation identity precedence, latest-message extraction, and full-transcript fallback behavior | channel-openai-api | Open WebUI request fixtures |
| OAI-003 | Preserve text and image_url handling; bridge bounded data images to shared attachments without fetching remote/file URLs | channel-openai-api | Attachment tests |
| OAI-004 | Preserve names-only warnings for accepted-but-unapplied sampling fields and reject unsupported tool/function/audio/response surfaces | channel-openai-api | Request matrix |
| OAI-005 | Render bounded host tool details and separate reasoning without asking clients to execute host-owned tools | channel-openai-api | SSE size/golden tests |
| CRN-001 | Load JSON and Markdown jobs, reject duplicate IDs, validate five-field/timezone/hashed expressions, and schedule future ticks | channel-cron | Parser and clock-driven tests |
| CRN-002 | Preserve skip, queue, replace, overflow, watchdog, cancellation, and full result taxonomy | channel-cron | Deterministic scheduler suite |
| CRN-003 | Preserve exact notification destination resolution, verbatim delivery, suppression sentinel, and no duplicate notification | channel-cron and core | Delivery tests |
| A2A-001 | Expose a valid Agent Card and task endpoint with bounded request/auth behavior | channel-a2a | Protocol conformance tests |
| A2A-002 | Discover and consume remote A2A agents without adding a core dependency | channel-a2a | Fake remote and live smoke |
| WA-001 | Preserve authorized chat admission, group/mention behavior, per-chat queueing, and buffered final-only delivery | channel-whatsapp | Adapter fixture suite |
| WA-002 | Continue to advertise unsupported native proactive delivery rather than pretending success | channel-whatsapp | Capability test |

### 13.6 Memory

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| MEM-001 | Preserve local SQLite identity, migrations, ownership checks, FTS, and corruption reporting | memory-local | Migration/corruption tests |
| MEM-002 | Preserve lite full-text recall with no external embedding service | memory-local | Recall golden tests |
| MEM-003 | Preserve journal semantic recall with Ollama or LM Studio discovery, vector dimension checks, circuit breaker, and keyword fallback | memory-local | Fake service and live local smoke |
| MEM-004 | Preserve BuJo Markdown/SQLite data format, capture paths, retrieval, evidence, and current canonical roots | memory-local | Existing-format compatibility suite |
| MEM-005 | Preserve capture, append-host-summary, and disabled write modes with completed-turn idempotency | memory-local and core | Admission/duplicate tests |
| MEM-006 | Preserve host-agent or Ollama memory LLM behavior, timeout, model selection, tracing, and failure visibility | memory-local | LLM boundary tests |
| MEM-007 | Preserve MemoryRecall tool semantics, bounded evidence, and optional MCP exposure | memory plugins | Tool/MCP contract tests |
| MEM-008 | Preserve consolidation schedules and safe maintenance rituals | memory-local and channel-cron | Consolidation tests |
| MEM-009 | Preserve strict audit, preview, rebuild, backup, forget, intake inspection, retry, and unknown resolution | memory plugins | CLI and destructive-boundary tests |
| MEM-010 | Preserve Supermemory extraction, hybrid recall, awaited completed-turn admission, legacy best-effort writes, container selection, auth, and health | memory-supermemory | Fake server and live smoke |

### 13.7 History, recording, discovery, and continuations

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| STATE-001 | Persist canonical conversation history atomically with duplicate protection and provider-session metadata | history-jsonl | Crash and replay tests |
| STATE-002 | Persist bounded run events, summaries, checkpoints, source manifests, usage, cost, failures, and lifecycle metadata | recorder-jsonl | Recorder checkpoint tests |
| STATE-003 | Preserve run list/read/search/report/audit, stale-running classification, retention, and memory-run separation | recorder-jsonl | CLI fixtures |
| STATE-004 | Preserve backfill selection, dry-run, mapping, time filters, and best-effort OTLP/Phoenix export | recorder-jsonl and exporter-otlp | Export fake server tests |
| STATE-005 | Publish owner-private agent presence, endpoints, process identity, startup proof, and health with stale detection | discovery-local | Process/heartbeat tests |
| STATE-006 | Preserve seen-conversation and posted-message/reply indexes where required for delivery idempotency, moving each store to the owning channel or history plugin | channel plugins and history-jsonl | Compaction/idempotency tests |
| CONT-001 | Preserve continuation claim capabilities, origin binding, modes, deadlines, size limits, and safe captured text | continuations | Capability and limit tests |
| CONT-002 | Preserve durable leases, worker recovery, retries, cancellation, dead letters, and unknown-delivery resolution | continuations | Crash/restart suite |
| CONT-003 | Preserve pinned or detached origin context, synthesis preflight, native delivery, history recording, and safe unavailable text | continuations | End-to-end fake runtime/channel suite |
| CONT-004 | Preserve operator list/status/health/retry/cancel/resolve commands without exposing operator tokens | continuations | CLI/API redaction tests |

### 13.8 Security, sandbox, and operations

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| SEC-001 | Reject inline secrets in secret fields, redact resolved secrets, and prevent credentials in schema/docs/logs | core and plugin-sdk | Secret fixtures and repository scan |
| SEC-002 | Preserve owner-only config, dotenv, state, lock, and credential writes with symlink/hardlink/ownership checks where currently promised | owning products/plugins | Filesystem adversarial tests |
| SEC-003 | Preserve safe HTTP bind, bearer, host/origin, header sanitization, body/frame limits, timeout, and shutdown primitives | plugin-sdk helpers and channels | Shared security suite |
| SEC-004 | Preserve tool-policy monotonicity across runtime fallback and self-config overrides | core | Adversarial route tests |
| SBOX-001 | Preserve off/native modes, none/localhost/allowlist network policy, readable/writable/deny roots, and fail-closed fallback | sandbox-srt | Policy matrix |
| SBOX-002 | Preserve managed/external SRT integrity, executable ownership/link checks, trusted read roots, and revalidation before command launch | sandbox-srt | Filesystem and command tests |
| OPS-001 | Start/restart only after validate, prove process and fresh startup health, and prevent two hosts for one canonical config | core and service-macos | Lifecycle integration tests |
| OPS-002 | Launch project-local pinned CLI and dependencies; record Node, package, lockfile, install, config, and service provenance | service-macos | Drift/adoption tests |
| OPS-003 | Preserve launchd install/start/restart/stop/status, login reconciliation, bounded recovery, and no resurrection after explicit stop | service-macos | launchd fixture and live macOS smoke |
| OPS-004 | Preserve bounded log rotation, generations, follow, maintenance recovery, and exact log paths | service-macos | Rotation/interruption tests |
| OPS-005 | Replace the copied managed runtime closure without losing atomic replacement, readiness, rollback, or supply-chain provenance | service-macos | Side-by-side upgrade/rollback test |
| OPS-006 | Aggregate plugin health as healthy, degraded, or unhealthy with typed causes and no fake waiting success | core and plugins | Health contract suite |

### 13.9 Operator, setup, and contributor experience

| ID | Requirement | v1 owner | Verification |
| --- | --- | --- | --- |
| UI-001 | Drive TUI and web through the same controller, reducers, actions, view models, and protocol client | operator | Dependency gate and golden state tests |
| UI-002 | Preserve structured answers, reasoning, tools, warnings, compaction, usage, cost, failure, and failover presentation | operator and renderers | Shared event fixture snapshots |
| UI-003 | Preserve agent discovery, pin/offline behavior, multiple conversations, model/effort controls, cancel, live input, AskUser, quote, attachments, config, replay, and health | operator and renderers | Renderer parity matrix |
| UI-004 | Preserve durable web threads, messages, revisions, parts, turns, uploads, active-turn survival, invalidation, cleanup, and deletion rules | web OperatorStore adapter | SQLite migration/crash tests |
| UI-005 | Preserve explicit browser notifications and marked cron/webhook conversations with idempotent delivery | web | Browser/service tests |
| UI-006 | Preserve terminal navigation, reasoning toggle, slash commands, self-config boundary, and safe exit without stopping the agent | tui | Terminal state tests |
| SETUP-001 | Generate only selected dependencies, exact package versions, lockfile, config, schema, instructions, skill selection, env example, and capability files | create-mono-agent | Clean npm/pnpm scaffold tests |
| SETUP-002 | Preserve interactive provider discovery/auth/readiness with bounded real no-tool route checks and honest scaffold-only noninteractive behavior | scaffolder and runtime plugins | Wizard/preflight tests |
| SETUP-003 | Preserve secure transactional dotenv and project file creation, review before commit, cancellation, recovery, and no fake readiness | scaffolder | Filesystem/TTY tests |
| SETUP-004 | Preserve managed project-skill drift check/update, backups, compare-and-swap activation, and explicit Docs MCP pairing | skills-manager and docs-mcp | Transaction tests |
| SETUP-005 | Preserve proposal-only self-config, narrow patch allowlist, full review, approval/rejection, atomic write, restart, readiness, and rollback | self-config and operator | Transaction and authority tests |
| DEV-001 | Let an external plugin compile, validate, test, pack, install, and run without a mono-agent core/catalog edit | plugin-sdk | Clean external example |
| DEV-002 | Generate package responsibility, architecture, public API, config, and verification docs from owned metadata | repository tooling | Generation drift gates |
| DEV-003 | Independently version and publish affected packages while checking plugin API compatibility and packed consumers | release tooling | Beta dry-run and registry verification |

## 14. Product-level acceptance scenarios

### 14.1 Minimal first agent

Given an empty directory, an individual builder selects Pi plus webhook and no memory, UI, exporter, or service. The scaffolder creates a valid project with only core, CLI, runtime-pi, and channel-webhook production dependencies. validate passes after the required provider credential is available. run handles a one-shot request. start serves the webhook. No Telegram, Slack, database, React, pi-tui, OTLP, or launchd dependency appears in the installed production closure.

### 14.2 Cross-runtime project

A project installs runtime-pi, runtime-codex, and runtime-claude. Its primary route uses Pi and its fallbacks reference Codex and Claude instance IDs. A transient provider failure advances according to policy. An authentication or unsupported-capability failure stops with the original typed reason. config explain shows which plugin owns every route field.

### 14.3 Shared operator behavior

The same recorded operator event fixture is fed to TUI and web. Both show the same ordered messages, tool lifecycle, reasoning disclosure, usage, compaction, warnings, AskUser, and terminal state. Their layouts differ, but their controller state and available actions are identical. A renderer-specific notification or keybinding never changes shared conversation state.

### 14.4 Third-party plugin

An external repository depends on plugin-sdk, defines a channel schema and contribution, runs the compliance suite, packs the package, installs it into a generated agent, references it through use, and starts it. No mono-agent source, central catalog, or core release changes.

### 14.5 Production consumers

Personal Agent runs its Pi routes, Telegram, webhook, OpenAI API, cron, local BuJo memory with embeddings/LLM, Phoenix export, local providers, operator/web access, and macOS service from exact project dependencies.

A8C Assistant runs its Pi routes, Slack, webhook, cron, local BuJo memory, Phoenix export, native sandbox, operator access, and macOS service from exact project dependencies.

Only one Telegram poller and one Slack Socket Mode consumer run during their respective cutovers.

## 15. Data and state migration

### 15.1 Continuity policy

The production consumer migration preserves memory only.

Preserved:

- canonical local memory roots;
- BuJo Markdown content;
- SQLite memory data and identifiers;
- embedding metadata needed to reopen the store;
- unresolved memory intake state;
- Supermemory remote state when selected.

Not imported:

- conversation history;
- provider sessions and transcripts;
- run artifacts and summaries;
- continuation ledgers;
- trace/discovery entries;
- web SQLite conversations and attachments;
- service logs.

The old state remains read-only during the rollback window. New v1 state uses distinct history, recording, continuation, discovery, operator, and service directories.

### 15.2 Local memory cutover

The first v1 memory-local release freezes the existing on-disk format. Format redesign is prohibited until both production consumers complete beta.

For each consumer:

1. Stop writes to the old agent or take a copy while the old service is stopped.
2. Run the existing strict audit and record the result.
3. Create an owner-only backup.
4. Open and test a copy with memory-local.
5. Compare representative recall queries and cited blocks.
6. Perform one capture, one completed-turn duplicate check, and one rebuild against the copy.
7. Confirm the old release can still open the canonical format.
8. At cutover, stop the old service, run one final strict audit, and point v1 at the canonical root.
9. Run post-start audit, recall, and one safe capture.
10. Preserve the backup until the stable rollback window closes.

Any audit failure, format mutation, missing recall evidence, or old-reader incompatibility blocks cutover.

### 15.3 Config migration

There is no v0 parser in v1. Each production project receives an explicitly authored v1 config.

During beta:

- keep the current mono-agent.config.json untouched;
- add mono-agent.v1.config.json;
- install exact beta dependencies in the consumer project;
- run every beta command with --config mono-agent.v1.config.json;
- use a separate service label and separate non-memory state roots;
- keep Telegram/Slack disabled for shadow testing.

After successful soak:

- make the v1 file canonical in a reviewed consumer commit;
- retain the old config under a clearly named legacy/rollback location;
- remove the v0 execution wrapper only after stable adoption.

The repository publishes a migration guide mapping every v0 field to its v1 core or plugin schema. It does not publish a permanent automatic converter.

## 16. macOS service product

@mono-agent/service-macos replaces the copied managed runtime closure with a project-local lockfile service.

### 16.1 Installation and provenance

The service definition records absolute, validated paths to:

- the selected Node executable;
- the project-local node_modules/.bin/mono-agent;
- the project root;
- the selected config;
- stdout and stderr logs.

The installation marker records:

- Node version and ABI;
- CLI package name and version;
- plugin package names and versions;
- package.json digest;
- lockfile digest;
- resolved installation digest or equivalent package-manager proof;
- config digest;
- service definition digest.

The service manager never installs dependencies. An operator updates package.json and the lockfile through the package manager, runs validate, then requests restart.

### 16.2 Lifecycle behavior

- install validates the project, writes an owner-only staged service definition, verifies it, then promotes it atomically;
- start proves the service definition, installed dependency state, config, process exclusivity, and fresh startup health;
- restart validates the replacement before stopping a healthy worker;
- stop proves launchd unload and every observed worker PID has exited;
- status compares launchd state, process identity, discovery heartbeat, config digest, and installed dependency provenance;
- recovery may restore the last validated project-local launch only; it never changes package versions;
- explicit stop disables recovery so the service cannot resurrect;
- logs remain bounded with deterministic generations and recoverable rotation;
- no inherited NODE_OPTIONS or unapproved environment executes before the service establishes its allowlisted environment.

The product supports distinct managed definitions for agent workers and the machine-wide web product.

### 16.3 Rollback

During consumer migration, the v0 and v1 definitions use distinct labels. Only one is loaded. Rollback is:

1. stop and prove death of v1;
2. point memory back only if the post-cutover audit proved no incompatible mutation;
3. load the retained v0 definition;
4. prove its process, channel, and memory health;
5. record the rollback reason in the migration evidence.

## 17. Delivery roadmap and execution backlog

### Gate G0: architecture commitment

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-001 | Ratify ownership and dependency ADR | PRD approval | Core/plugin/product responsibilities and forbidden edges are explicit; architecture reviewer approves |
| V1-002 | Freeze the package, command, config, and feature baselines | V1-001 | Machine-derived inventories cover 22 packages, 20 commands, 14 capability modules, five bridges, public APIs, and current product tests |
| V1-003 | Create the capability disposition tracker | V1-002 | Every requirement in section 13 has an owner, target package, test, and status; no miscellaneous bucket |
| V1-004 | Capture golden consumer manifests | V1-002 | Personal Agent and A8C Assistant selected features, config, service, and memory requirements are recorded without secrets |
| V1-005 | Add architectural budget gates | V1-001 | CI rejects forbidden core dependencies, concrete integration imports, unowned config registries, and third-party plugin catalog requirements |

G0 exits only after the ADR and all baseline ledgers are reviewed. New v0 features are frozen except critical fixes; every accepted fix must update the v1 ledger.

### Gate G1: end-to-end v1 skeleton

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-101 | Publish plugin-sdk beta | G0 | definePlugin, manifest, schema helpers, contribution types, compliance kit, and API-version errors work from a packed consumer |
| V1-102 | Implement schema-composed config | V1-101 | Strict JSON, explicit sources, defaults, redaction, JSON Schema, docs metadata, and explain provenance come from one schema path |
| V1-103 | Implement project-local plugin loader | V1-101, V1-102 | Direct-dependency enforcement, relative resolution, API checks, cycles, collisions, and cleanup pass adversarial tests |
| V1-104 | Implement core host lifecycle | V1-101, V1-103 | One-shot run, start, health, stop, concurrency, cancellation, events, and reverse-order cleanup work with fake plugins |
| V1-105 | Implement CLI shell | V1-102, V1-104 | validate, doctor, config schema, config explain, run, start, and plugin command routing have stable exit codes and JSON output where declared |
| V1-106 | Build external hello plugin example | V1-101, V1-103 | Separate fixture package installs and runs without editing core or the package catalog |
| V1-107 | Deliver first real vertical slice | V1-104, V1-105 | One selected runtime and channel-webhook execute config to response, health, shutdown, and packed clean-project smoke |

G1 proves the architecture before broad extraction. The initial real runtime may be Pi because both production consumers depend on it, but fake-runtime tests remain the authoritative core tests.

### Gate G2: unified operator

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-201 | Define operator protocol and view models | G1 | Versioned schemas cover every current TUI/web action and capability |
| V1-202 | Implement operator client/controller/reducers | V1-201 | Deterministic state tests cover streaming, reconnect, live input, AskUser, attachments, quotes, replay, config, and health |
| V1-203 | Implement channel-operator | V1-201, V1-202 | Agent endpoint passes protocol, security, frame-bound, abort, and capability tests |
| V1-204 | Port TUI renderer | V1-202, V1-203 | No independent remote client or turn reducer remains; terminal behavior passes shared fixtures |
| V1-205 | Port web service and renderer | V1-202, V1-203 | Web persistence and browser adapters implement operator ports; active-turn recovery and current UX pass |
| V1-206 | Add renderer parity gate | V1-204, V1-205 | Identical fixtures create equivalent shared state and available actions in both products |

G2 blocks if either product retains separate AskUser, model/effort, live-input, activity, or turn-state business logic.

### Gate G3: runtime parity

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-301 | Extract runtime-pi | G1 | Pi harness behavior, provider auth, local providers, tools, sessions, retries, transport, and live smoke pass |
| V1-302 | Extract runtime-claude | G1 | SDK and CLI modes, capabilities, auth/model discovery, sessions, and both smokes pass |
| V1-303 | Extract runtime-codex | G1 | App-server model discovery, approvals, events, threads, errors, and live smoke pass |
| V1-304 | Extract runtime-opencode | G1 | Stable-version guard, provider models, capabilities, sessions, errors, and live smoke pass |
| V1-305 | Complete runtime-neutral routing | V1-301 through V1-304 | Cross-runtime fallback, capability negotiation, failure taxonomy, compaction, and policy monotonicity pass |
| V1-306 | Move provider setup to plugins | V1-301 through V1-304 | CLI/scaffolder discover setup commands through plugin metadata; core contains no provider IDs |

G3 requires one real smoke per runtime family and focused coverage for both Claude bridge modes.

### Gate G4: communication parity

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-401 | Migrate Telegram | G1, G3 | TG-001 through TG-007 pass, including one bounded live bot smoke |
| V1-402 | Migrate Slack | G1, G3 | SLK-001 through SLK-008 pass, including one bounded Socket Mode smoke |
| V1-403 | Migrate webhook and OpenAI API | G1, G3 | WHK and OAI requirements pass compatibility suites |
| V1-404 | Migrate cron and delivery routing | G1, G3 | CRN requirements and cross-channel proactive delivery pass clock-driven tests |
| V1-405 | Migrate A2A and WhatsApp | G1, G3 | A2A and WA requirements pass focused and bounded live tests |
| V1-406 | Enforce channel compliance | V1-401 through V1-405 | Every channel passes the shared responder, attachment, AskUser, health, stop, and redaction suite applicable to advertised capabilities |

G4 requires all current channels to be installable independently. No channel may be reintroduced as a core dependency for convenience.

### Gate G5: memory, state, safety, and optional capabilities

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-501 | Migrate memory-local without format change | G1, G3 | MEM-001 through MEM-009 pass existing-format and maintenance suites |
| V1-502 | Migrate memory-supermemory | G1, G3 | MEM-010 and shared memory compliance pass |
| V1-503 | Extract history-jsonl and recorder-jsonl | G1 | STATE-001 through STATE-004 pass crash, retention, replay, audit, and export fixtures |
| V1-504 | Extract discovery-local and exporter-otlp | V1-503 | Presence/readiness no longer depends on exporter selection; live Phoenix probe passes |
| V1-505 | Extract sandbox-srt | G1, G3 | SBOX and related security requirements pass, including fail-closed integrity cases |
| V1-506 | Extract continuations | G1, G4, V1-503 | CONT-001 through CONT-004 pass restart, delivery, and operator maintenance tests |
| V1-507 | Extract skills manager, Docs MCP, and orchestrator | G1, G3 | Existing managed-skill, companion, and bounded collaborator behavior passes |
| V1-508 | Extract self-config | G2, V1-504, V1-505 | Proposal authority, review, transaction, service restart, readiness, and rollback tests pass |

G5 includes a durable-state review. Every new store must have documented purge/reset, retention, audit, and recovery.

### Gate G6: products, documentation, and release system

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-601 | Rebuild create-mono-agent | G3, G4, G5 | Selected-stack npm and pnpm scaffolds install only chosen dependencies and validate from packed artifacts |
| V1-602 | Deliver service-macos | G1, V1-504 | Project-local launch, provenance, drift, recovery, logs, restart, stop, and rollback pass live macOS smoke |
| V1-603 | Split package releases | G1 | Changesets-style affected-package versioning, apiVersion compatibility, beta tags, provenance, packing, and registry verification pass |
| V1-604 | Rebuild contributor and user docs | V1-601, V1-603 | Start-here, config, plugin authoring, products, migration, security, and package docs are generated or ownership-linked |
| V1-605 | Produce v0-to-v1 migration guide | G4, G5, V1-601 | Every v0 config field, command, package, and persisted state has explicit guidance |

G6 produces the first coherent 1.0.0-beta.N release set on the next dist-tag.

### Gate G7: production beta

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-701 | Publish and install beta candidates | G6 | Registry versions, tarballs, signatures/provenance, and exact consumer pins are verified |
| V1-702 | Stage Personal Agent | V1-701 | Side-by-side config, alternate ports, disabled Telegram shadow, Pi/runtime tests, webhook/OpenAI API/cron/operator/service checks, and memory-copy rehearsal pass |
| V1-703 | Cut over and soak Personal Agent | V1-702 | Old poller stopped; canonical memory audited; v1 healthy for 24 hours including cron; rollback remains proven |
| V1-704 | Stage A8C Assistant | V1-703 | Side-by-side config, alternate ports, disabled Slack shadow, Pi/runtime, webhook/cron/operator/service/sandbox checks, and memory-copy rehearsal pass |
| V1-705 | Cut over and soak A8C Assistant | V1-704 | Old Socket Mode consumer stopped; canonical memory audited; v1 healthy for 24 hours including staffed business hours |
| V1-706 | Review beta evidence | V1-703, V1-705 | No duplicate delivery, missed selected schedule, unexplained unhealthy state, memory regression, or unresolved high-severity finding |

Consumer work uses clean branches/worktrees and never overwrites unrelated dirty checkout state.

### Gate G8: stable v1

| ID | Work item | Depends on | Acceptance and evidence |
| --- | --- | --- | --- |
| V1-801 | Close the parity ledger | G7 | Every section 13 row has implementation, test, documentation, and review evidence |
| V1-802 | Run stable release candidate | V1-801 | Full local gate, package packing, clean consumers, all runtime smokes, both golden consumers, and release workflow pass |
| V1-803 | Publish 1.0 stable | V1-802 | Independently versioned stable packages are registry-verified under latest |
| V1-804 | Deprecate replaced v0 packages | V1-803 | npm deprecation points to migration docs; versions remain available; no consumer still depends on a removed package |
| V1-805 | Remove v0 implementation and docs | V1-803 plus 30-day rollback window | Old code is proved unused, stable consumers remain healthy, and dead-code/architecture/docs gates pass |
| V1-806 | Complete post-launch review | V1-803 | Incidents, delivery metrics, contributor feedback, and follow-up decisions are recorded without reopening v1 scope silently |

## 18. Work-item execution contract

Every implementation story must state:

- one bounded outcome;
- owning package and allowed file boundaries;
- source-of-truth requirements and linked ledger IDs;
- dependencies and required built artifacts;
- allowed tools and environments;
- disallowed production mutations;
- public API/config changes;
- acceptance criteria;
- exact focused tests and one proportional broad gate;
- expected artifact and commit boundary;
- stop conditions;
- reviewer role;
- rollback or removal behavior when state or lifecycle changes.

Default stop conditions:

- the discovered ownership boundary contradicts this PRD;
- a shared-core contract change is proposed to solve one integration-only need;
- a selected capability would be silently dropped;
- a persistent-format change is needed before the consumer memory cutover;
- a task would overwrite unrelated user changes;
- a live smoke would require running two consumers for Telegram, Slack, or the same service label;
- credentials or private data would enter tracked files or logs;
- the focused baseline is red before the task's change and the failure cannot be isolated.

Retry budget for an AI-executed task is two correction loops after the first failed verification. A third failure stops for replanning with evidence.

## 19. Verification strategy

### 19.1 Configuration

Required coverage:

- valid minimal, complete, and multi-instance projects;
- malformed JSON and wrong configVersion;
- unknown core and plugin fields;
- defaults applied once;
- relative paths from the config location;
- required, optional, missing, empty, and malformed $env references;
- dotenv/process-environment precedence used only by explicit references;
- inline secret rejection;
- secret redaction in errors, explain, doctor, events, and generated docs;
- missing direct dependency;
- package resolvable only transitively;
- invalid manifest and apiVersion;
- plugin ID and command collision;
- requirement cycle and unsatisfied capability;
- generated schema composition and stale metadata;
- inferred TypeScript/JSON Schema parity;
- no implicit MONO_AGENT_* override;
- no legacy v0 field acceptance.

### 19.2 Plugin lifecycle

Required coverage:

- deterministic load and topological initialization;
- initialization rollback;
- partial start failure and reverse cleanup;
- degraded-to-healthy recovery;
- unhealthy aggregation;
- abort during initialization;
- graceful drain;
- repeated stop/dispose;
- plugin exception isolation without fake success;
- namespaced diagnostics and commands;
- trusted-plugin warning;
- third-party clean-package install.

### 19.3 Core execution

Required coverage:

- one-shot run and channel-driven run;
- queue admission and overflow;
- cancellation before, during, and after runtime start;
- live-input applied, requeued, discarded, unavailable, and end-of-turn races;
- continuous/per-message sessions;
- idle, daily, isolated, cold, and fallback boundaries;
- canonical history commit ordering;
- AskUser answer, expiry, cancellation, and replay;
- attachment authority and cleanup;
- tool/MCP policy intersection;
- cross-runtime capability negotiation;
- retryable and terminal failure routing;
- compaction;
- proactive/verbatim delivery and suppression.

### 19.4 Operator

One golden fixture corpus covers:

- normal streaming response;
- reasoning and tools;
- tool progress and replacement;
- warning and runtime failover;
- context compaction;
- usage/cost snapshots;
- cancellation;
- disconnect and reconnect;
- active-turn survival in the durable web service;
- live-input settlement/fallback;
- multi-question AskUser;
- quote and attachment;
- agent offline/online;
- pinned agents;
- config, replay, and health;
- self-config review and restart transition;
- cron/webhook notification thread.

The fixture drives operator reducer tests and both renderer adapters. Differences are allowed only for documented platform presentation.

### 19.5 Persistence and recovery

Use crash-boundary tests around:

- history append;
- recorder checkpoints;
- memory completed-turn admission;
- memory capture and rebuild;
- continuation claim/lease/delivery;
- web thread/turn/upload commits;
- service definition replacement;
- log rotation;
- discovery heartbeat replacement.

Each test proves either atomic completion or explicit recoverable state. Unknown delivery is preserved as unknown; it is never guessed to success.

### 19.6 Security

Required adversarial fixtures include:

- symlink and hardlink substitution;
- foreign/group/world writable parents;
- tracked dotenv;
- dotenv injection and invalid syntax;
- header/body/frame overflow;
- unsafe bind and Host/Origin spoofing;
- path traversal and deceptive attachment names;
- ANSI, bidi, and terminal-control text;
- content-shaped credentials in artifacts;
- malicious plugin config keys;
- runtime fallback attempting to weaken sandbox/tool policy;
- stale process/PID reuse;
- lock owner death;
- corrupt service marker or SRT installation.

### 19.7 Package and release

For every publishable package:

- build;
- typecheck;
- focused tests;
- public API inventory;
- README responsibility and architecture;
- packed install;
- dependency-category check;
- license and vulnerability checks;
- secret scan.

Release candidates additionally run:

- root architecture and deep-import checks;
- dependency-ordered build;
- typecheck;
- package and script tests;
- demo/example tests;
- docs and snippet checks;
- package-doc and public-API generation drift checks;
- release validation and packing;
- clean npm and pnpm consumers;
- one live smoke for each runtime family;
- matching live channel/state smoke for high-risk changes.

### 19.8 Production evidence

Consumer evidence records:

- exact project commit;
- exact package versions and lockfile digest;
- Node version;
- config digest without secret values;
- service label and PID;
- runtime provenance;
- enabled plugin health;
- selected channel readiness;
- memory audit result;
- representative end-to-end turn IDs;
- scheduled-run result;
- duplicate-delivery check;
- start and recovery duration;
- rollback command and proof.

## 20. Reliability, security, and privacy requirements

### 20.1 Reliability

- Enabled integrations fail initial start when they cannot initialize.
- Long-lived transports may recover from degraded state under bounded plugin policy.
- Core stops accepting new work before draining on shutdown.
- A failed exporter never changes the run result, but its health and drop count remain visible.
- A failed memory write remains visible and may affect health according to the selected memory contract; it is not reported as successful.
- Service restart never stops a healthy worker before the replacement project validates.
- No command claims a version or process adopted until it proves the executing project-local path and live PID.

### 20.2 Security and privacy

- Plugins are trusted code with the same local authority as the host process.
- Runtime tool authority remains governed by core policy and selected sandbox capability.
- Secret values never enter config JSON, schema JSON, generated examples, traces, CLI JSON, or review cards.
- Web remains a deliberately single-user product whose network reachability is the access boundary. It keeps strict Host/Origin and cross-origin mutation protection.
- Channel allowlists remain adapter-owned and mandatory when the current behavior requires them.
- Setup never enables allow-all tools, unrestricted network, public bind, proactive send tools, or a permissive local operator profile by default.
- Personal configurations are evidence for capability needs, not safe templates for generic users.

### 20.3 Accessibility and usability

- Web retains keyboard navigation, responsive behavior, accessible labels, viewport-safe dialogs/sheets, and explicit notification permission.
- TUI retains visible focus/state, safe control-text handling, discoverable commands, and cancellation/exit semantics.
- Generated configuration errors identify the owning plugin, exact path, problem, and remediation.
- The first README path distinguishes core, plugins, and products before presenting advanced architecture.

## 21. Release, rollout, and rollback

### 21.1 Versioning

- Adopt affected-package releases using Changesets or an equivalent checked-in changeset workflow.
- Every package owns its version.
- Plugin SDK compatibility is governed by manifest apiVersion and package peer range.
- Official beta packages publish as 1.0.0-beta.N under next.
- Consumers pin exact beta and stable versions; lockfiles are mandatory.
- Stable packages publish under latest only after G8 evidence.
- A release does not imply consumer deployment.

### 21.2 Beta rollout

Beta starts with:

- core, plugin SDK, CLI, and scaffolder;
- all four runtime families;
- channel plugins required by both production consumers;
- memory-local;
- history/recording/discovery;
- OTLP exporter;
- sandbox-srt;
- operator, channel-operator, TUI, web;
- service-macos;
- current skills, self-config, and continuation requirements.

Remaining A2A, WhatsApp, Supermemory, Docs MCP, and orchestration capabilities must still reach parity before stable even if they are not part of both golden consumers.

### 21.3 Personal Agent rollout

Shadow phase:

- install beta packages exactly;
- validate side-by-side config;
- use alternate webhook/OpenAI/operator ports;
- disable Telegram and cron delivery;
- run Pi primary/fallback checks;
- run one webhook and one OpenAI API turn;
- run cron manually without external notification;
- validate Phoenix and local-provider diagnostics;
- run web/operator flows;
- rehearse service install/restart/stop;
- rehearse memory migration against a copy.

Cutover:

- announce maintenance locally;
- stop and prove death of v0;
- final memory audit and backup;
- enable Telegram and schedules only in v1;
- start v1 service;
- prove Telegram inbound/final response, webhook, OpenAI API, cron scheduling, operator/web, memory recall/capture, Phoenix, and service recovery;
- soak for 24 hours including at least one normal cron boundary.

### 21.4 A8C Assistant rollout

Shadow phase:

- install beta packages exactly;
- validate side-by-side config;
- use alternate webhook/operator ports;
- disable Slack and cron delivery;
- run Pi primary/fallback checks;
- validate native sandbox behavior;
- run webhook and manual cron;
- validate Phoenix;
- rehearse service and memory migration.

Cutover:

- stop and prove death of the v0 Slack Socket Mode consumer;
- final memory audit and backup;
- enable Slack and schedules only in v1;
- prove DM/channel authorization, thread response, activity cleanup, model/effort, AskUser, webhook, cron, memory, Phoenix, sandbox, operator, and service recovery;
- soak for 24 hours including staffed business hours.

### 21.5 Rollback triggers

Immediate rollback triggers:

- duplicate Telegram or Slack consumption;
- lost or corrupted memory;
- service cannot prove process identity or stop;
- auth/policy failure hidden by fallback;
- selected channel reports healthy while unavailable;
- missing scheduled delivery without explicit failure;
- repeated crash loop;
- self-config cannot prove rollback after a failed apply;
- secret appears in logs, artifacts, config, schema, or UI.

Rollback preserves diagnostic evidence, stops v1, restores the disabled v0 definition, and verifies the old consumer. It does not run destructive cleanup.

## 22. Risks and mitigations

| Risk | Trigger | Mitigation | Owner |
| --- | --- | --- | --- |
| Core grows into a new agent-app | Concrete integration or product exception proposed in core | Architecture gate, ownership ADR, required reviewer | Core maintainers |
| Plugin SDK becomes a huge shared-contract dumping ground | Integration-specific field/type proposed as neutral | Capability test and adapter-neutrality review | SDK maintainers |
| Config remains duplicated | New registry, view mapping, or wizard fragment repeats schema | Schema-only lint/generation gate | Config/core maintainers |
| Schema metadata cannot express setup | Plugin needs OAuth or dynamic discovery | Keep field metadata declarative; use plugin-owned setup command | Plugin owner |
| Plugin version skew breaks projects | apiVersion/peer incompatibility or mismatched contracts | Exact consumer pins, peer checks, compatibility matrix, packed tests | Release owner |
| UI unification creates a lowest-common-denominator UX | Renderer-specific behavior leaks into controller or shared behavior is omitted | Shared semantic state plus platform adapters and parity matrix | Operator owner |
| Web durable behavior is lost during extraction | Refresh/restart interrupts active turns or data cleanup changes | Port existing SQLite behavior first; no schema redesign in extraction PR | Web owner |
| Runtime extraction changes provider semantics | Output/events/session/fallback differs | Golden bridge fixtures and live smoke before deleting old bridge | Runtime owner |
| Memory corruption during cutover | Audit mismatch, format mutation, missing recall | Frozen format, owner-only backup, copy rehearsal, old-reader proof | Memory owner |
| Duplicate external delivery | Two pollers/socket consumers or reused delivery key | Sequential cutover, distinct labels, process-death proof, idempotency tests | Deployment owner |
| Dirty consumer checkouts are overwritten | Migration begins in existing working directory | Dedicated worktree/branch, explicit diff review, no stash/reset | Consumer owner |
| Independent releases increase operational work | Partial publish or wrong peer range | Changeset validation, provenance, registry verify, coherent beta set | Release owner |
| Long migration drifts from v0 fixes | New feature/fix lands only in v0 | Freeze policy and ledger update required for accepted fixes | Product owner |
| Service simplification loses security guarantees | Project-local launch lacks old closure proof | Lockfile/install/Node/config provenance and validate-before-restart | Service owner |
| Third-party plugin compromises host | Untrusted package installed | Explicit trust boundary, direct dependency, normal npm review; no false isolation claim | Project operator |

## 23. Dependencies

Technical:

- Node and pnpm versions supported by the repository;
- Zod 4 JSON Schema and metadata behavior;
- external Pi packages and their supported APIs;
- Claude SDK and Claude Code CLI;
- Codex app-server;
- OpenCode stable CLI;
- SRT on supported macOS paths;
- npm registry support for independent prereleases;
- launchd for service-macos;
- assistant-ui and pi-tui for renderers;
- SQLite and filesystem semantics for current durable products.

Operational:

- credentials for bounded runtime/channel smokes;
- maintenance windows for Personal Agent and A8C Assistant;
- owner access to both consumer repositories and services;
- memory backup capacity;
- npm publication authority;
- independent security and architecture review.

Dependencies that are unavailable become explicit blocked tasks. They do not authorize fixtures as production substitutes.

## 24. Definition of Ready

A work item is ready when:

- it names the user/system outcome and linked ledger IDs;
- its owning package and forbidden boundaries are clear;
- public API/config changes are specified;
- dependencies and required package builds are available;
- acceptance criteria and verification commands are deterministic;
- state, security, and rollback impact are classified;
- credentials/live targets are either available or the task is explicitly local-only;
- stop conditions and reviewer are named;
- it fits one reviewable PR.

For production migration, Ready additionally requires:

- clean migration worktree;
- exact beta versions and lockfile;
- successful shadow verification;
- memory audit and backup;
- tested stop/start/rollback commands;
- proof the competing Telegram/Slack consumer is identifiable and stoppable;
- explicit maintainer approval for the window.

## 25. Definition of Done

A work item is done when:

- acceptance criteria are met;
- focused build, typecheck, tests, and proportional broad gate pass;
- public APIs, schema, generated docs, and examples agree;
- package responsibility and dependency boundaries are accurate;
- relevant ledger rows contain evidence and final status;
- failures and external review findings have explicit dispositions;
- durable state has audit/reset/retention/rollback coverage;
- no unrelated files or user changes are included;
- the focused PR is reviewed and merged.

A gate is done only when every required child item is done and the gate evidence is reviewed. Stable v1 is done only when G8 completes; package publication alone is not completion.

## 26. Resolved decisions and defaults

- The public migration is a clean break.
- All current feature outcomes are in scope.
- Core consists of core and plugin-sdk only.
- Runtime families are Pi, Claude, Codex, and OpenCode; Claude contains SDK and CLI modes.
- Plugins are trusted and in-process.
- Project-local direct dependencies are the only plugin resolution source.
- The canonical config is strict JSON with explicit use references and a generated $schema.
- Non-secret settings live in JSON; environment use is explicit and never an override layer.
- Physical workspace layout stays flat.
- Packages release independently.
- The operator model is one headless application with native TUI and web renderers.
- Personal Agent and A8C Assistant are the golden production consumers.
- Memory is the only migrated durable user state.
- The first managed-service product is macOS launchd and launches the project-local installation.
- Beta publishes under next; stable publishes only after all parity rows close.
- v0 packages remain downloadable and are deprecated rather than unpublished.
- No implementation calendar is asserted by this PRD. Gate evidence, not a date, determines release readiness.

## 27. PRD maintenance rules

This PRD is the decision source until the v1 architecture ADR and capability tracker are created. After that:

- architectural decisions move to the ADR and are linked here;
- implementation status lives in the capability tracker, not prose edits scattered through this file;
- a changed product decision updates this PRD through review;
- a newly discovered current feature receives a ledger row before implementation continues;
- release criteria may become stricter but cannot be weakened without explicit approval;
- package names may change only through an ADR that preserves the ownership boundaries and migration mapping;
- examples must never contain real consumer IDs, tokens, private endpoints, or secrets.

## 28. Frozen v0 baseline inventory

The G0 baseline task must regenerate and compare these lists against the then-current v0 source. This snapshot prevents an implementation agent from interpreting “all features” as only the packages it happens to touch.

### 28.1 Publishable package catalog at PRD creation

- @mono-agent/a2a-adapter
- @mono-agent/agent-app
- @mono-agent/agent-contracts
- @mono-agent/agent-harness
- @mono-agent/agent-orchestrator
- @mono-agent/agent-runtime
- @mono-agent/config
- @mono-agent/cron-adapter
- @mono-agent/docs-mcp
- @mono-agent/memory
- @mono-agent/memory-supermemory
- create-mono-agent
- @mono-agent/observability
- @mono-agent/openai-api-adapter
- @mono-agent/operator-adapter
- @mono-agent/runtime-adapter
- @mono-agent/slack-adapter
- @mono-agent/telegram-adapter
- @mono-agent/tui
- @mono-agent/web
- @mono-agent/whatsapp-adapter
- @mono-agent/webhook-adapter

### 28.2 Public CLI commands at PRD creation

- init
- setup
- validate
- doctor
- auth
- sandbox
- config
- presets
- start
- restart
- stop
- status
- logs
- tui
- web
- install-skill
- backfill
- runs
- memory
- continuations

### 28.3 Capability module IDs at PRD creation

- channel:webhook
- channel:telegram
- channel:slack
- channel:openai-api
- channel:cron
- channel:a2a
- memory:lite
- memory:journal
- memory:bujo
- memory:supermemory
- sandbox
- observability:phoenix
- provider:ollama
- provider:lmstudio

WhatsApp, the operator channel, continuations, self-config, managed services, skills, and Docs MCP are not all represented by that setup-module list; their requirements remain mandatory through the package, command, source, README, and test inventories.

### 28.4 Runtime bridge IDs at PRD creation

- claude-sdk
- claude-code-cli
- codex-app-cli
- opencode-app-cli
- pi-sdk

Any v0 feature merged after this date must be added to the parity ledger or explicitly excluded through a reviewed PRD amendment before stable v1.
