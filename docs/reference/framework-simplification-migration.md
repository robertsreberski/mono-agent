---
title: "Framework simplification migration"
description: "Migrate retired configuration, runtime and memory APIs, and install the optional Phoenix exporter."
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

Use `createRuntime` and its per-instance `configureTools` method for tool configuration. The process-global `configureToolRuntime`, `readToolRuntime`, `resetToolRuntime`, and `readRuntimeBrand` API has been removed. Direct tool/helper integrations must carry their own context from `@mono-agent/agent-runtime/agent/tools/shared/tool-context.js`. Immutable default branding does not provide a shared mutable tool environment.

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
});
```

Retain the same `runId` when retrying admission. Omit `captureText` for summary-only writes. BuJo and Supermemory implement this boundary; the store owns deduplication and admission. Provider responses remain valid when memory persistence fails.

Direct BuJo callers must migrate from `capture`, loose `captureTurn`, and the legacy capture queue to completed-turn persistence. Await `flush` for queued processing before closing an offline process. Strict extraction, durable intake and replay, Journal indexing, explicit forgetting, backup recovery, and graph expansion remain supported.

The legacy `MemoryWriteResult` and loose-parser `Extraction` types are removed. Use `MemoryCompletedTurnResult` for admission results. Low-level extraction integrations retain `captureTurnStrict` and `extractCapturePlanStrict`; the permissive `extractCapturePlan` export is removed. Replace `queueSnapshot` or `runtime.queues.capture` inspection with durable intake/outbox status.

The memory audit JSON field `backlog.captureQueue` is replaced by `backlog.completedTurnIntake`, which counts pending durable intake rather than legacy best-effort captures. Update scripts that inspect this field.

The `mono-agent-memory-recall` compatibility binary is removed. For agent requests, use the injected `MemoryRecall` tool backed by the shared per-turn retrieval service. For operator queries, use `mono-agent memory recall`. Remove MCP configurations that start the old executable and its binary-only environment setup.

## Optional Phoenix exporter

Install `@mono-agent/observability-phoenix` at the exact version of the consumer's `@mono-agent/agent-app`. Keep the existing `observability.exporters` entry with `type: "phoenix"`; no new configuration format is required. The host resolves the explicitly installed package, checks its version, and preserves it in managed runtime installations.

Replace imports from `@mono-agent/observability/otel` with `@mono-agent/observability-phoenix`. The old subpath has been removed. The optional package provides the Phoenix factory and OTLP mapping/serialization APIs used by backfill. The core observability package retains local recording and generic exporter composition without OpenTelemetry dependencies.

A missing, mismatched, or broken configured plugin produces an actionable error. After successful setup, transport errors remain bounded and best-effort: they do not replace the run outcome or suppress local JSONL artifacts. See [Phoenix export and backfill](/observability/phoenix-and-backfill/).

## Operator integrations

The shared Node client transport is available at `@mono-agent/operator-adapter/client`. Web and TUI reuse its stream parsing and long-lived fetch implementation while retaining their own endpoint/authentication rules and frame ceilings. Multipart terminal replies and bounded final frames without a trailing newline are handled consistently.

Browser wire types use canonical type-only imports. UI-only types stay in the frontend, and server runtime code is not imported into browser bundles. Notification previews and channel log sanitizers share their respective generic implementations while preserving channel-specific credential handling.
