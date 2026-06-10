# @mono-agent/openai-agents-runtime

## Category

Category: `runtime`

## Responsibility

Adapts `@openai/agents` to the Mono Agent runtime contract (`MonoRuntimeLike`). The runtime is a thin, structural translator: it constructs an `Agent` with the host-supplied system prompt and model, attaches MCP servers from `RuntimeRunOptions.mcpServers`, streams `RunStreamEvent`s back as `RuntimeEventLike`, and returns a `RuntimeResult` with text, usage, and turn count.

## Install / Usage

```bash
pnpm --filter @mono-agent/openai-agents-runtime run build
```

```ts
import { createOpenAIAgentsRuntime } from "@mono-agent/openai-agents-runtime";
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const runtime = createOpenAIAgentsRuntime();
const responder = createConfiguredAgentResponder({
  config,
  runtime,
  model: { sdk: "openai", model: "gpt-5" },
});
```

`OPENAI_API_KEY` must be set in the environment, or supplied via `createOpenAIAgentsRuntime({ apiKey })`.

## Public API

- `createOpenAIAgentsRuntime(options?: OpenAIAgentsRuntimeOptions): MonoRuntimeLike`
- `OpenAIAgentsRuntimeError`
- `translateMcpServers`, `translateOpenAIStreamEvent` (translation helpers for tests/advanced hosts)
- Types: `OpenAIAgentsRuntimeOptions`, `OpenAIAgentSdkOptions`, `OpenAIRunFactory`, `OpenAIRunFactoryInput`, `OpenAIRunHandle`, `OpenAIRunResult`, `McpServerSpec`, `OpenAIStreamEventLike`

### Options

| Field | Type | Purpose |
| --- | --- | --- |
| `apiKey` | `string` | Sets `process.env.OPENAI_API_KEY` for the duration of the call. Restored after. |
| `apiKeyEnv` | `string` | Name of the env var used when applying `apiKey`. Defaults to `OPENAI_API_KEY`. |
| `baseUrl` | `string` | Sets `OPENAI_BASE_URL` for the duration of the call. Use for Azure / OpenAI-compatible endpoints. |
| `sdkOptions.agent` | `Record<string, unknown>` | Opaque forward to the `new Agent({...})` constructor. Use for `handoffs`, `outputType`, `tools`, hosted tools (`webSearchTool()`, etc.), `modelSettings`, guardrails. |
| `sdkOptions.run` | `Record<string, unknown>` | Opaque forward to `run(agent, input, {...})`. Use for `context`, `tracing`, `session`, `sandbox`. |
| `runFactory` | function | Test-only override. Default delegates to `@openai/agents`. |

### Hosted tools (opt-in via `sdkOptions.agent.tools`)

```ts
import { webSearchTool } from "@openai/agents";

const runtime = createOpenAIAgentsRuntime({
  sdkOptions: { agent: { tools: [webSearchTool()] } },
});
```

## Dependency Boundary

This package depends on `@mono-agent/runtime-adapter` (workspace, for shared types) and `@openai/agents` (external). It does not depend on `@mono-agent/agent-harness`, `@mono-agent/agent-host`, or any communication adapter. Hosts compose this runtime with a harness.

## What This Package Does Not Own

- Local-action tools. Unlike the Claude Agent SDK, `@openai/agents` ships **no** local file/shell/grep tools. This package does not inject any. To give the agent local capability, the host attaches MCP servers via `RuntimeRunOptions.mcpServers` (e.g. the GitHub MCP server, filesystem MCP, etc.). Hosted OpenAI tools (`WebSearchTool`, `FileSearchTool`, `ComputerTool`, `CodeInterpreterTool`) are opt-in via `sdkOptions.agent.tools`.
- MCP server lifecycle beyond construction. The default `runFactory` constructs `MCPServerStreamableHttp` / `MCPServerSSE` / `MCPServerStdio` instances from the host's `mcpServers` map. Connection / disconnection is handled by `@openai/agents` during the `run()` call.
- API key management beyond the optional env-var helpers. Hosts set `OPENAI_API_KEY` / `OPENAI_BASE_URL` in their environment normally.
- Model selection. The model comes from `RuntimeRunOptions.model.model`.
- Conversation history, recording, observability. Owned by `@mono-agent/agent-harness` and `@mono-agent/observability`.

## Verification

```bash
pnpm --filter @mono-agent/openai-agents-runtime run typecheck
pnpm --filter @mono-agent/openai-agents-runtime run test
pnpm --filter @mono-agent/openai-agents-runtime run build
```

Tested against `@openai/agents@^0.11.4`.
