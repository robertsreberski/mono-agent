# @worklab-ai/operator-console

## Category

Category: `operator-surface`

## Responsibility

Local loopback operator surface for Mono Agent hosts. It serves a React settings UI, validates registered field-group patches, writes a JSON settings file atomically, and reads local trace registry plus recorded-run artifacts for a Traceability view.

## Install / Usage

```bash
pnpm --filter @worklab-ai/operator-console run build
```

```ts
import { startOperatorConsole } from "@worklab-ai/operator-console";
import { CORE_AGENT_FIELD_GROUPS } from "@worklab-ai/config";
import { telegramFieldGroup } from "@worklab-ai/telegram-adapter";

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
- `OPERATOR_CONSOLE_STATIC_DIR` from `@worklab-ai/operator-console/static`
- Field-group types re-exported from `@worklab-ai/settings`

## Traceability

The console keeps the existing bearer-protected `/api/observability/*` endpoints for single-artifact-dir hosts. New `/api/traceability/*` endpoints read a file-backed source registry and aggregate recent runs across all registered sources:

- `GET /api/traceability/sources`
- `GET /api/traceability/runs`
- `GET /api/traceability/runs/:sourceId/:runId`

When no registry is configured but an `observability.artifactDir` is present, the traceability API exposes a single fallback `local` source instead of demo data. Malformed manifests, missing artifact directories, corrupt summaries/events, and stale heartbeats are returned as warnings.

## Dependency Boundary

The package depends on `@worklab-ai/settings` and `@worklab-ai/observability`. It must not depend on core config, communication adapters, or the agent harness; hosts compose field groups, trace source lifecycle, and runtime behavior outside the console.

## What This Package Does Not Own

It is not a runtime host, credential manager, communication adapter, database, or observability backend. It only reads/writes the configured JSON file and reads local registry/artifact files when explicitly pointed at them.

## Verification

```bash
pnpm --filter @worklab-ai/operator-console run build
pnpm --filter @worklab-ai/operator-console run typecheck
pnpm --filter @worklab-ai/operator-console run test
```
