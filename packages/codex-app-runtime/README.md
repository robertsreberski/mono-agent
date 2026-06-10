# @worklab-ai/codex-app-runtime

## Category

Category: `runtime`

## Responsibility

Adapts the OpenAI Codex app-server to the Mono Agent runtime contract (`MonoRuntimeLike`). Spawns the `codex` CLI binary (provided by the `@openai/codex` npm package) as a child process via `codex app-server --listen stdio://`, speaks newline-delimited JSON-RPC over stdio, and maps Codex's `item.started` / `item.completed` notifications into `RuntimeEventLike` per the same translation logic used in `@worklab-ai/agent-runtime`.

## Install / Usage

```bash
pnpm --filter @worklab-ai/codex-app-runtime run build
```

```ts
import { createCodexAppRuntime } from "@worklab-ai/codex-app-runtime";
import { createConfiguredAgentResponder } from "@worklab-ai/agent-host";

const runtime = createCodexAppRuntime();
const responder = createConfiguredAgentResponder({
  config,
  runtime,
  model: { sdk: "codex", model: "gpt-5.5" },
});
```

The runtime serves the `codex-app-cli` backend; its `model.sdk` guard accepts `"codex"` and rejects any other sdk fail-closed.

The `codex` CLI must be on `PATH` (install via `pnpm add -D @openai/codex` to get the binary, or `brew install --cask codex`). `OPENAI_API_KEY` must be set in the environment, or supplied via `createCodexAppRuntime({ apiKey })`.

## Public API

- `createCodexAppRuntime(options?: CodexAppRuntimeOptions): MonoRuntimeLike`
- `CodexAppRuntimeError`
- `createJsonRpcClient`, `JsonRpcClientError` (low-level stdio JSON-RPC client; exposed for tests and advanced hosts)
- `normalizeCodexItemEvent`, `normalizeCodexItemType` (ported from `worklab/packages/agent-runtime`)
- `translateMcpServersForCodex` — converts mono-agent's MCP server map to Codex's `mcp_servers` config shape
- Types: `CodexAppRuntimeOptions`, `CodexClientFactory`, `CodexClientFactoryInput`, `JsonRpcClient`, `JsonRpcClientOptions`, `JsonRpcRequest`, `CodexMcpServerEntry`

### Options

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `command` | `string` | `"codex"` | CLI binary to spawn. |
| `args` | `readonly string[]` | `["app-server", "--listen", "stdio://"]` | Args to the CLI. |
| `env` | `Record<string, string>` | `{}` | Extra env vars merged onto the spawned process. |
| `apiKey` | `string` | — | Sets `OPENAI_API_KEY` in the spawned env. |
| `apiKeyEnv` | `string` | `"OPENAI_API_KEY"` | Name of the env var used when applying `apiKey`. |
| `threadStartTimeoutMs` | `number` | `60000` | Per-attempt timeout for `thread/start`. |
| `threadStartAttempts` | `number` (1–5) | `2` | Retry budget for `thread/start`. |
| `threadStartBackoffMs` | `number` (0–300000) | `5000` | Backoff between retries. |
| `requestTimeoutMs` | `number` | `30000` | Default per-RPC timeout. |
| `stderrTailBytes` | `number` | `8192` | Stderr buffer size; included in `RuntimeResult.diagnostics.stderr_tail` on error. |
| `sdkOptions` | `Record<string, unknown>` | `{}` | Opaque forward into the `thread/start` request (use for `permissionMode`, `fastMode`, `outputSchema`, etc.). |
| `clientFactory` | function | — | Test-only override. Default uses `createJsonRpcClient`. |

## Streaming behavior (ported quirks)

This runtime replicates 8 specific behaviors from the upstream `worklab/packages/agent-runtime` Codex bridge — they are not obvious from the JSON-RPC spec alone:

1. **Agent message delta buffering** per `itemId`. Deltas are buffered in a map and only emitted as an assistant event when the matching `item/completed` arrives.
2. **Reasoning deltas emit immediately** as `assistant` events with `content: [{type: "thinking", text}]`. Asymmetric to agent-message buffering — intentional.
3. **Tool-call reconstruction** via `normalizeCodexItemEvent` (verbatim port). Pairs `item.started` + `item.completed` into tool-use / tool-result message blocks.
4. **Malformed-line tolerance.** Empty stdout lines are skipped silently. Non-JSON lines emit a `runtime_warning` event but the stream continues.
5. **Per-request timeouts with retry/backoff.** `thread/start` specifically gets retries with backoff because cold-start can be slow on first invocation after install.
6. **Abort sequence.** On `runOptions.abortSignal.aborted`, sends `turn/interrupt` then closes the client. Rejects all pending RPCs.
7. **Error/warning notifications mid-stream** are surfaced as `runtime_warning` events but do NOT halt the stream — only `turn/completed` ends it normally.
8. **stderr tail capture** (last `stderrTailBytes` bytes) is included in `RuntimeResult.diagnostics.stderr_tail` on error.

## Dependency Boundary

This package depends on `@worklab-ai/runtime-adapter` (workspace, for shared types) and the `@openai/codex` npm package (optional, provides the CLI binary). It does not depend on `@worklab-ai/agent-harness`, `@worklab-ai/agent-host`, or any communication adapter.

## What This Package Does Not Own

- Local-action tool implementations. Codex's built-in tools (file edit, shell within its sandbox) are governed by the spawned CLI's own permission/sandbox model. Pass `permissionMode` and related knobs via `sdkOptions`.
- MCP server lifecycle beyond `thread/start` config. The CLI manages MCP connections internally.
- Live-input steering (`turn/steer`), native subagents, fast-mode toggling, structured output enforcement, file-change snapshots — out of scope for v1.
- Conversation history, recording, observability. Owned by `@worklab-ai/agent-harness` and `@worklab-ai/observability`.

## Verification

```bash
pnpm --filter @worklab-ai/codex-app-runtime run typecheck
pnpm --filter @worklab-ai/codex-app-runtime run test
pnpm --filter @worklab-ai/codex-app-runtime run build
```

Tested against `@openai/codex@^0.130.0` (CLI binary).
