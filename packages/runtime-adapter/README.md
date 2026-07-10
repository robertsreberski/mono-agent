# @mono-agent/runtime-adapter

## Category

Category: `runtime`

## Responsibility

Typed runtime facade over `@mono-agent/agent-runtime`. It parses runtime model references, selects or validates execution mode, exposes the available backend matrix, owns sandbox policy/process wrapping, creates a runtime wrapper, and exposes a small structural runtime contract to the harness.

## Install / Usage

```bash
pnpm --filter @mono-agent/runtime-adapter run build
```

```ts
import {
  createMonoRuntime,
  listMonoRuntimeBackends,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";

const backends = listMonoRuntimeBackends();
```

## Public API

- `createMonoRuntime`
- `parseMonoRuntimeModelReference`, `assertParsedRuntimeModelReference`
- `defaultExecutionModeForModel`, `assertExecutionModeCompatible`, `isRuntimeExecutionMode`
- `listMonoRuntimeBackends`, `runtimeBackendForModel`, `describeMonoRuntimeSupport`
- `runtimeOptionsForLocalProvider`, `validateLocalProviderDefinition`, `isPrivateBaseUrl`
- `discoverClaudeSdkModels` for isolated, authentication-independent Claude catalog discovery
- Fallback routing accepts an ordered chain with exact per-entry effort and
  `routeSafety: "uniform" | "per-route-native"`; a host `resolveAttempt` callback
  can supply route-local provider options without exposing credentials in route telemetry.
- Sandbox policy helpers: `createSandboxPolicy`, `failClosedSandboxPolicy`, `mergeSandboxPolicies`, `prepareSandboxedCommand`, plus managed SRT resolution/integrity helpers
- `RuntimeAdapterError`
- Runtime backend, model, execution mode, message, event, sandbox, tool, and result types
- Local provider types for Ollama, LM Studio, and OpenAI-compatible gateways

Supported backend seams are exposed as data:

| Backend | Model refs | Execution mode | Boundary |
| --- | --- | --- | --- |
| Claude SDK | `claude:<model>` | `sdk` | Claude SDK through `@mono-agent/agent-runtime` |
| Claude Code CLI | `claude:<model>` | `cli` | Claude Code CLI bridge through `@mono-agent/agent-runtime` |
| Codex app CLI | `codex:<model>` | `cli` | Codex app-server bridge through `@mono-agent/agent-runtime` |
| OpenCode app CLI | `opencode:<provider>:<model>` | `cli` | OpenCode app-server bridge through `@mono-agent/agent-runtime` |
| Pi SDK provider | `pi:<provider>:<model>` | `sdk` | Pi SDK gateway, including provider ids such as `openai-codex` or Copilot-style provider ids |

## Local Pi Providers

`runtimeOptionsForLocalProvider()` converts host config into the custom-provider context expected by `@mono-agent/agent-runtime`'s Pi adapter. It only returns options when the parsed model is `pi:<provider>:<model>` and `<provider>` matches a configured local provider. Built-in Pi providers such as `pi:openai-codex:gpt-5.5` return `{}`.

Built-in Pi OAuth providers still need credentials. Use
`createPiOAuthApiKeyResolver({ path })` and pass it to `createMonoRuntime()` as
`resolvePiApiKey` when the host owns an auth JSON file such as
`~/.pi/agent/auth.json`.

Ollama example:

```ts
import {
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
} from "@mono-agent/runtime-adapter";

const model = parseMonoRuntimeModelReference("pi:ollama:qwen3:8b");
const runtimeOptions = runtimeOptionsForLocalProvider(model, [
  {
    id: "ollama",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    enabled: true,
    models: [
      { name: "qwen3:8b", capabilities: { context_window: 32768 } },
    ],
  },
]);
```

Private HTTP(S) URLs such as `localhost`, RFC1918 addresses, and Tailscale CGNAT addresses are allowed. Public hosts require `https://` plus `trustPublicUrl: true`; invalid local-provider config throws `RuntimeAdapterError` instead of falling back to a hosted provider.

## Route Safety and Managed SRT

`uniform` fallback safety reuses one monotonic runtime contract and fails closed
when a route cannot represent a required capability. Explicit
`per-route-native` creates isolated provider runtimes: Pi retains mono-agent
tool policy and uses SRT only when an effective native sandbox policy is active
(otherwise telemetry says `disabled` and subprocess tools are unsandboxed),
Claude drops only the unrepresentable mono-agent SRT layer, and direct
Codex/OpenCode use provider-native safety with exact allow-all. Capability-bearing
inputs are never silently discarded; an unsupported route is skipped with bounded,
credential-free safety telemetry.

On macOS, the default SRT resolver prefers the integrity-verified managed copy in
the private mono-agent cache. It revalidates the managed tree against an
independently pinned digest before each launch. A present but corrupt managed
install fails closed and never downgrades to an external `srt`; the external
command is considered only when the managed path is absent. External and
explicit commands are canonicalized to absolute trusted files, pinned by content
and filesystem identity after their functional proof, and revalidated before
use. Generated filesystem policy denies global reads first, then reopens only
configured roots, reviewed immutable OS paths, and narrowly derived runtime
dependencies; relative deny-write globs stay anchored to the policy root.

## Dependency Boundary

This is the only facade package that depends on `@mono-agent/agent-runtime`. Other packages consume its small `MonoRuntimeLike` interface, backend descriptors, and sandbox policy helpers instead of importing provider/runtime internals.

## What This Package Does Not Own

It does not build prompts, manage memory, expose UI, poll communication channels, or persist observability artifacts.

## Verification

```bash
pnpm --filter @mono-agent/runtime-adapter run build
pnpm --filter @mono-agent/runtime-adapter run typecheck
pnpm --filter @mono-agent/runtime-adapter run test
```
