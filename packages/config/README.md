# @worklab-ai/config

## Category

Category: `core`

## Responsibility

Adapter-neutral Mono Agent core configuration. It loads runtime, context, memory, tool/MCP, and artifact settings from environment variables plus optional JSON, validates runtime model/execution-mode compatibility through `@worklab-ai/runtime-adapter`, and exposes core field groups for settings UIs.

## Install / Usage

```bash
pnpm --filter @worklab-ai/config run build
```

```ts
import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
} from "@worklab-ai/config";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});
```

Environment variables win over JSON values. Missing or empty JSON is treated as an empty layer.

## Public API

- `loadMonoAgentConfig`, `loadMonoAgentConfigWithSources`
- `redactMonoAgentConfig`
- `readMonoAgentConfigJson`, `writeMonoAgentConfigJson`
- `layerJsonOntoEnv`
- `CORE_AGENT_FIELD_GROUPS`, plus individual identity/runtime/memory/tools/artifacts field groups
- `MonoAgentConfig`, `MonoAgentConfigJson`, `RedactedMonoAgentConfig`, `MonoAgentConfigError`

## Dependency Boundary

`@worklab-ai/config` may depend on `@worklab-ai/settings` and `@worklab-ai/runtime-adapter`. It must not depend on communication adapters, the operator console, agent harness, or UI packages.

## What This Package Does Not Own

It does not load Telegram, WhatsApp, Slack, or other adapter-specific credentials or allowlists. Adapter packages own those settings and their safety rules.

## Verification

```bash
pnpm --filter @worklab-ai/config run build
pnpm --filter @worklab-ai/config run typecheck
pnpm --filter @worklab-ai/config run test
```
