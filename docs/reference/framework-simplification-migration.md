---
title: "Framework simplification migration"
description: "Migrate retired configuration, runtime, memory, and first-party trace-export surfaces."
sidebar:
  order: 90
---

This breaking change removes inactive settings and compatibility implementations. Upgrade a consumer only after updating its configuration and imports. Existing installed versions continue to use their existing APIs; this change does not migrate consumer folders or runtime data automatically.

## Configuration and effort

| Removed surface | Replacement |
| --- | --- |
| `runtime.permissionMode`, `MONO_AGENT_PERMISSION_MODE` | Remove the setting. Configure sandbox/tool policy and programmatic approval callbacks where required. The removed setting was never enforced by the Pi runtime. |
| Effort changes inferred from `think`, `extrathink`, or `ultrathink` | Set `runtime.effort` or supported per-request effort metadata explicitly. Provider-specific ceilings remain in effect. |
| Memory database `decayGamma`, `weights.recency` | Remove these options; they did not affect relevance scores. |
| Memory database `RecallOptions.expandHops` | Use the store's explicit graph expansion operation. App-managed recall already performs graph expansion separately. |

Retired config fields produce migration errors. Real sandbox enforcement, tool approvals, model/provider fallback, chronology, and memory validity filtering remain supported.

## Runtime consumers

Pass typed `toolLimits` and `compaction` inputs to runtime calls. The flat `runOptions.settings` bag and the `resolveRuntimePolicies` migration helper have been removed. The policy resolver accepts typed policy groups directly and retains model-derived defaults and bounded values.

Use `createRuntime` and its per-instance `configureTools` method for tool configuration. The process-global `configureToolRuntime`, `readToolRuntime`, `resetToolRuntime`, and `readRuntimeBrand` API has been removed. Direct calls through `@mono-agent/agent-runtime/agent/tools/index.js`, including its path guards, must pass `{ ctx: createToolContext(...) }` using `@mono-agent/agent-runtime/agent/tools/shared/tool-context.js`. Immutable default branding does not provide a shared mutable tool environment.

The runtime has one Pi bridge. Public bridge listing/resolution remains available; provider and model fallback still operate through the router.

External hosts such as Worklab must migrate worker and doctor integrations that deep-import the old runtime-context module before upgrading. Worklab versions pinned to older runtime releases should retain that pin until their consumer migration is complete. This framework change does not upgrade Worklab or claim compatibility with its unmigrated source.

## Memory stores

Writable stores implement `persistCompletedTurn`; the harness no longer falls back to `appendHostSummary` plus `scheduleCapture`. A store used only for reads can omit completed-turn persistence. Selecting a writing mode without that method is rejected when constructing the harness.

```typescript
await store.persistCompletedTurn({
  runId: "stable-host-run-id",
  conversationId: "conversation-id",
  summary: "The host's deterministic summary",
  captureText: "The completed turn text approved for capture",
  // Optional, only if the host verified this outer speaker:
  captureSpeakerKind: "human-turn",
});
```

Retain the same `runId` when retrying admission. Omit `captureText` for summary-only writes. BuJo and injected custom stores can implement this boundary; the store owns deduplication and admission. Provider responses remain valid when memory persistence fails.

Direct BuJo callers must migrate from `capture`, loose `captureTurn`, and the legacy capture queue to completed-turn persistence. Await `flush` for queued processing before closing an offline process. Strict extraction, durable intake and replay, Journal indexing, explicit forgetting, backup recovery, and graph expansion remain supported.

The legacy `MemoryWriteResult` and loose-parser `Extraction` types are removed. Use `MemoryCompletedTurnResult` for admission results. Low-level extraction integrations retain `captureTurnStrict` and `extractCapturePlanStrict`; the permissive `extractCapturePlan` export is removed. The `queueSnapshot().capture` and `runtime.queues.capture` fields are removed; inspect `queueSnapshot().intake` (durable completed-turn intake) and the outbox status instead.

The memory audit JSON field `backlog.captureQueue` is replaced by `backlog.completedTurnIntake`, which counts pending durable intake rather than legacy best-effort captures. Update scripts that inspect this field.

The `mono-agent-memory-recall` compatibility binary is removed. For agent requests, use the injected `MemoryRecall` tool backed by the shared per-turn retrieval service. For operator queries, use `mono-agent memory recall`. Remove MCP configurations that start the old executable and its binary-only environment setup.

## Retired first-party Supermemory support

The first-party Supermemory backend, `@mono-agent/memory-supermemory` package,
backend-specific CLI/doctor surfaces, and automatic official MCP injection are
removed without replacement. Generic `MemoryStore` injection and manually authored
MCP servers remain supported.

Before upgrading:

1. Stop the agent and retain the complete known-good version set you already
   operate if you may need its export or service-management workflow. Repository
   version `0.22.0` is not evidence of a separately published plugin pin, so this
   guide does not invent one.
2. Remove `memory.backend: "supermemory"` and every active
   `memory.supermemory` block. Remove `MONO_AGENT_MEMORY_BACKEND=supermemory` and
   all `MONO_AGENT_MEMORY_SUPERMEMORY_*` assignments from the process environment
   and `.env`.
3. Decide explicitly whether the upgraded agent should use no memory, one of the
   local Lite/Journal/BuJo tiers, or a custom programmatically injected store.
   Mono-agent never chooses for you.
4. Run `mono-agent validate` before starting the upgraded agent.

Active selector values, nonempty or malformed backend blocks, and nonblank retired
environment variables fail closed with fixed, secret-safe guidance. A literal empty
`memory.supermemory: {}` object and blank retired environment assignments are
accepted only as inert migration tombstones; they enable no backend. Direct
JavaScript composition and public redaction enforce the same boundary, so bypassing
the file loader cannot silently create a local store or expose a legacy credential.

There is no automatic fallback to BuJo, config rewrite, local import, replacement
selection, export, remote migration, or remote cleanup. Existing remote data is
untouched. Any export, retention, or deletion requires a separate operator-authorized
workflow against the service and known-good software already in use.

Manual generic MCP configuration is independent of this retirement. Mono-agent does
not inspect or rewrite an operator-authored server merely because its key or URL uses
the same vendor name or domain. Only the former synthesized official server and its
synthesized bearer header are gone.

Local memory also does not imply whole-app network isolation: providers, channels,
web tools, embedding services, and manually configured MCP servers may still use the
network.

## Retired Phoenix/OTLP export

An earlier source revision extracted Phoenix transport into an optional package,
but that extraction is not a published `@mono-agent/observability-phoenix@0.22.0`
plugin. Static inspection of the published `@mono-agent/agent-app@0.22.0` and
`@mono-agent/observability@0.22.0` tarballs shows the older built-in
observability implementation, while the public plugin lookup returned no package.
Do not add a new plugin dependency or mix the retired source package with a newer
app.

First-party Phoenix/OTLP export, the `@mono-agent/observability/run-export`
subpath, `observability.exporters`, `MONO_AGENT_OBSERVABILITY_EXPORTERS`, exporter
status/probing, and `mono-agent backfill` are removed. The local JSONL recorder,
`mono-agent runs`, `runs audit`, `runs report`, `RunHistory`, trace-source
discovery, failover details, and provider-neutral `RunExporter` /
`createCompositeRunRecorder` contracts remain.

Before upgrading:

1. If a final legacy export is required, perform it with the complete currently
   working version set that the consumer already operates. No concrete app/plugin
   pin is recommended because no separately published plugin version was verified.
2. Remove every active `observability.exporters` block and active
   `MONO_AGENT_OBSERVABILITY_EXPORTERS` assignment.
3. Run `mono-agent validate`, then upgrade and validate again.
4. Use `mono-agent runs`, `mono-agent runs audit`, or `mono-agent runs report`
   for retained local artifacts.

Active or malformed legacy values fail before startup with fixed, secret-safe
repair text; they are not silently discarded. An absent field, a blank env
assignment, env `[]`, `observability: {}`, or
`observability: { exporters: [] }` is tolerated only as an inert upgrade
tombstone and enables nothing.

The upgrade performs no automatic final export, replacement selection, config
rewrite, artifact conversion, local artifact deletion, remote trace deletion, or
installed-consumer migration. Removing the bundled trace exporter also does not
make the application network-isolated: providers, channels, MCP servers, web
tools, and configured external memory services can still use the network.

## Retired terminal renderer

The first-party terminal renderer is removed on the current unreleased source
branch: `mono-agent tui`, `mono-agent help tui`, the standalone
`mono-agent-tui` binary, and direct `@mono-agent/tui` imports no longer provide a
renderer. Use `mono-agent web run --loopback` for live operation, `mono-agent runs list` and
`mono-agent runs show <run-id>` for bounded offline run diagnostics, and
`mono-agent config` for the resolved configuration view.

This source change does not mutate consumer folders or runtime data and does not
deprecate or remove the historical npm artifact. Version `0.22.0` still contains
the renderer, so keep the complete known-good version set already in use until
consumer scripts and imports have been migrated. No compatibility exports were
relocated merely to preserve old renderer API names.

The shared endpoint is not retired. Keep `tui.*`, `MONO_AGENT_TUI_*`, the `tui`
channel/source id, `metadata.channels.tui`, `/gui`, and the public operator wire
names unchanged. Web, ACP, jobs, and proactive delivery continue to use those
compatibility identifiers. Validate the updated consumer before restarting it.

## Operator integrations

The shared Node client transport is available at `@mono-agent/operator-adapter/client`. Web and ACP clients reuse its stream parsing and long-lived fetch implementation while retaining their own endpoint/authentication rules and frame ceilings. Multipart terminal replies and bounded final frames without a trailing newline are handled consistently.

Browser wire types use canonical type-only imports. UI-only types stay in the frontend, and server runtime code is not imported into browser bundles. Notification previews and channel log sanitizers share their respective generic implementations while preserving channel-specific credential handling.
