# @worklab-ai/operator-console

## Responsibility

Local loopback operator surface for Mono Agent hosts. It serves a React settings UI, validates registered field-group patches, writes a JSON settings file atomically, and optionally reads recorded-run artifacts for a Runs view.

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
  cwd: process.cwd(),
  fieldGroups: [...CORE_AGENT_FIELD_GROUPS, telegramFieldGroup],
  observability: { artifactDir: "./.mono-agent/artifacts" },
});

console.log(`${consoleServer.url}/?t=${consoleServer.token}`);
```

## Public API

- `startOperatorConsole`
- `OperatorConsoleOptions`, `OperatorConsoleStartResult`, `OperatorConsoleEvent`
- `OperatorConsoleObservabilityOptions`
- `OPERATOR_CONSOLE_STATIC_DIR` from `@worklab-ai/operator-console/static`
- Field-group types re-exported from `@worklab-ai/settings`

## Dependency Boundary

The package depends on `@worklab-ai/settings` and `@worklab-ai/observability`. It must not depend on core config, communication adapters, or the agent harness; hosts compose field groups and runtime behavior outside the console.

## What This Package Does Not Own

It is not a runtime host, credential manager, communication adapter, database, or observability backend. It only reads/writes the configured JSON file and reads local artifact files when explicitly pointed at them.

## Verification

```bash
pnpm --filter @worklab-ai/operator-console run build
pnpm --filter @worklab-ai/operator-console run typecheck
pnpm --filter @worklab-ai/operator-console run test
```
