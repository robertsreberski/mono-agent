# @mono-agent/claude-agents-runtime

## Category

Category: `runtime`

## Responsibility

Adapts `@anthropic-ai/claude-agent-sdk` to the Mono Agent runtime contract (`MonoRuntimeLike`). The runtime is a thin, structural translator: it forwards mono-agent's `RuntimeRunOptions` (system prompt, user message, MCP servers, tool allow/deny lists, abort signal) to the Claude Agent SDK and maps the SDK's streamed messages back into `RuntimeEventLike` and `RuntimeResult`.

## Install / Usage

```bash
pnpm --filter @mono-agent/claude-agents-runtime run build
```

```ts
import { createClaudeAgentsRuntime } from "@mono-agent/claude-agents-runtime";
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const runtime = createClaudeAgentsRuntime();
const responder = createConfiguredAgentResponder({
  config,
  runtime,
  model: { sdk: "claude", model: "claude-opus-4-7" },
});
```

The runtime serves the `claude-sdk` backend; its `model.sdk` guard accepts the canonical `"claude"` id and the legacy `"anthropic"` alias and rejects any other sdk fail-closed.

`ANTHROPIC_API_KEY` must be set in the environment, or supplied via `createClaudeAgentsRuntime({ apiKey })`.

## Public API

- `createClaudeAgentsRuntime(options?: ClaudeAgentsRuntimeOptions): MonoRuntimeLike`
- `ClaudeAgentsRuntimeError`
- `translateClaudeMessageToEvent`, `extractAssistantTextDelta`, `translateMcpServers` (translation helpers, exported for tests / advanced hosts)
- Types: `ClaudeAgentsRuntimeOptions`, `ClaudeQueryFactory`, `ClaudeSDKMessageLike`

### Options

| Field | Type | Purpose |
| --- | --- | --- |
| `apiKey` | `string` | Sets `process.env.ANTHROPIC_API_KEY` for the duration of the call. Restored after. |
| `apiKeyEnv` | `string` | Name of the env var used when applying `apiKey`. Defaults to `ANTHROPIC_API_KEY`. |
| `sdkOptions` | `Record<string, unknown>` | Opaque escape hatch forwarded into the Claude SDK `query({options})` call. Use for `agents`, `agent`, `cwd` defaults, `additionalDirectories`, `criticalSystemReminder_EXPERIMENTAL`, etc. |
| `queryFactory` | function | Test-only override. Default delegates to `@anthropic-ai/claude-agent-sdk`'s `query()`. |

## Dependency Boundary

This package depends on `@mono-agent/runtime-adapter` (workspace, for shared types) and `@anthropic-ai/claude-agent-sdk` (external). It does not depend on `@mono-agent/agent-harness`, `@mono-agent/agent-host`, or any communication adapter. Hosts compose this runtime with a harness.

## What This Package Does Not Own

- Tool implementations. Claude Agent SDK ships with Claude Code's built-in toolset (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`, etc.) which are available by default. Use `RuntimeRunOptions.disallowedTools` (sourced from `@mono-agent/tool-policy`) to turn any off. This package does not implement or wrap tools itself.
- MCP server lifecycle. Hosts attach MCP servers via `RuntimeRunOptions.mcpServers` (the `agent-host` plumbing); this package forwards the configs.
- API key management beyond the optional env-var helper. Hosts set `ANTHROPIC_API_KEY` in their environment normally; the `apiKey` option is a convenience.
- Model selection. The model comes from `RuntimeRunOptions.model.model`. This package never defaults a model name.
- Conversation history, recording, observability. Owned by `@mono-agent/agent-harness` and `@mono-agent/observability`.

## Verification

```bash
pnpm --filter @mono-agent/claude-agents-runtime run typecheck
pnpm --filter @mono-agent/claude-agents-runtime run test
pnpm --filter @mono-agent/claude-agents-runtime run build
```

Tested against `@anthropic-ai/claude-agent-sdk@^0.3.143`.
