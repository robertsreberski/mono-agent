# @mono-agent/operator-console

## Category

Category: `operator-surface`

## Responsibility

Local loopback operator surface for agent hosts. It serves a React settings UI, validates registered field-group patches, writes a JSON settings file atomically, and reads local trace registry plus recorded-run artifacts for a Traceability view.

The browser Traceability view is now a local fallback / legacy surface: when an `observability.exporters` (Phoenix) entry is configured, Phoenix is the recommended external trace viewer. The local JSONL artifacts and the file-backed trace-source registry this console reads remain the local source of truth. (The traceability routes and view are not removed in this slice; their removal is a later migration gated on a live Phoenix proof.)

## Install / Usage

```bash
pnpm --filter @mono-agent/operator-console run build
```

```ts
import { startOperatorConsole } from "@mono-agent/operator-console";
import { CORE_AGENT_FIELD_GROUPS } from "@mono-agent/config";
import { telegramFieldGroup } from "@mono-agent/telegram-adapter";

const consoleServer = await startOperatorConsole({
  configPath: "./mono-agent.config.json",
  fieldGroups: [...CORE_AGENT_FIELD_GROUPS, telegramFieldGroup],
  observability: { artifactDir: "./.mono-agent/artifacts" },
  traceability: { registryDir: "~/.mono-agent/trace-sources" },
});

console.log(`${consoleServer.url}/?t=${consoleServer.token}`);
```

## Public API

- `startOperatorConsole`
- `OperatorConsoleOptions`, `OperatorConsoleStartResult`, `OperatorConsoleEvent`
- `OperatorConsoleObservabilityOptions`, `OperatorConsoleTraceabilityOptions`
- `OPERATOR_CONSOLE_STATIC_DIR` from `@mono-agent/operator-console/static`
- Field-group types re-exported from `@mono-agent/settings`

## Traceability

The console keeps the existing bearer-protected `/api/observability/*` endpoints for single-artifact-dir hosts. New `/api/traceability/*` endpoints read a file-backed source registry and aggregate recent runs across all registered sources:

- `GET /api/traceability/sources`
- `GET /api/traceability/runs`
- `GET /api/traceability/runs/:sourceId/:runId`

When no registry is configured but an `observability.artifactDir` is present, the traceability API exposes a single fallback `local` source instead of demo data. Malformed manifests, missing artifact directories, corrupt summaries/events, and stale heartbeats are returned as warnings.

The browser Traceability view renders source context, run insights, event mix, and timeline event data as operator-facing fields and chips. Artifact payloads stay structured internally, but the user-facing surface does not show raw JSON previews.

This view is a local fallback for trace inspection. Where a Phoenix exporter is configured (`observability.exporters`), Phoenix is the recommended external trace viewer; the local JSONL artifacts and trace-source registry remain the local source of truth. These endpoints and the view are unchanged in this slice.

## Dependency Boundary

The package depends on `@mono-agent/settings` and `@mono-agent/observability`. It must not depend on core config, communication adapters, or the agent harness; hosts compose field groups, trace source lifecycle, and runtime behavior outside the console.

## What This Package Does Not Own

It is not a runtime host, credential manager, communication adapter, database, or observability backend. It only reads/writes the configured JSON file and reads local registry/artifact files when explicitly pointed at them.

## Verification

```bash
pnpm --filter @mono-agent/operator-console run build
pnpm --filter @mono-agent/operator-console run typecheck
pnpm --filter @mono-agent/operator-console run test
```
