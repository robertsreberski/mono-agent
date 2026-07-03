# Agent Runtime Architecture

## What It Is

`@mono-agent/agent-runtime` is a provider-agnostic agent execution
kernel. It does not own tasks, database state, UI, scheduling, or a host's
domain-specific result contract. It owns the lower-level act of running an
agent turn:

- pick the right backend from a model reference and execution mode
- expose built-in tools, MCP tools, approvals, structured output, and live input
- enforce an optional sandbox policy for built-in tool execution and stdio MCP
  startup, through an injectable seam (see `agent/sandbox-seam.js`) rather than
  a bundled sandboxing implementation
- normalize provider events into one runtime event stream
- classify runtime failures and retryable provider errors
- collect usage, cost, cache, capability, and warning telemetry
- return raw text plus raw structured output to the host

Hosts consume the package through `src/runtime.js`. The package has **zero
workspace-package dependencies**: everything a host-side integration would
otherwise need to inject (sandboxing, in this package's case) is expressed as
a plain-data/plain-function seam the host wires up, not an import.

## Package Boundary

```mermaid
flowchart TB
  HostApp["Host app<br/>API / coordinator / worker / UI / DB"] --> CoreAI["host runtime composition"]

  CoreAI --> Runtime["agent-runtime<br/>createRuntime() / createRouterRuntime()"]

  Runtime --> Registry["Runtime bridge registry<br/>model ref + executionMode -> backend"]
  Runtime --> AgentKernel["Agent kernel<br/>built-in tools, MCP, approvals,<br/>compaction, transcript snapshots"]
  Runtime --> Observability["Observers + metrics<br/>usage, cost, events, warnings"]
  Runtime --> Failure["Failure taxonomy<br/>retryable provider detection"]

  Registry --> ClaudeSDK["Claude SDK bridge"]
  Registry --> ClaudeCLI["Claude Code CLI bridge"]
  Registry --> PiSDK["Pi SDK bridge<br/>OpenAI, Codex, Gemini, OpenRouter,<br/>Ollama, custom providers"]
  Registry --> CodexApp["Codex app-server CLI bridge"]

  AgentKernel --> Builtins["Read / Write / Edit / Glob / Grep / Bash<br/>WebFetch / WebSearch"]
  AgentKernel --> MCP["MCP stdio / SSE / HTTP tools"]
  AgentKernel --> Sandbox["Sandbox policy<br/>path/network checks + stdio command wrapping"]
  AgentKernel --> Artifacts["Tool-output bloat guard<br/>host artifact persistence"]

  ClaudeSDK --> Providers["External model/provider surfaces"]
  ClaudeCLI --> Providers
  PiSDK --> Providers
  CodexApp --> Providers

  Runtime --> Result["RuntimeResult<br/>text, structuredResult, events,<br/>usage, diagnostics, failureKind"]
  Result --> CoreAI
  CoreAI --> HostContract["Host parses domain contract<br/>assistant result / task effects"]
```

The runtime stays below host domain behavior. Provider code in this package
must not import host DB, API, coordinator, or UI modules. Hosts pass callbacks
and pre-resolved settings into the runtime instead.

## Runtime Selection

```mermaid
flowchart LR
  ModelRef["options.model<br/>claude:* / pi:*:* / codex:*"] --> Parse["parseRuntimeModelReference()"]
  Parse --> Mode["options.executionMode<br/>sdk or cli"]
  Mode --> Resolve["resolveRuntimeBridge()"]

  Resolve -->|sdk=claude + sdk mode| ClaudeSDK["claude bridge<br/>@anthropic-ai/claude-agent-sdk"]
  Resolve -->|sdk=claude + cli mode| ClaudeCLI["claude-code bridge<br/>claude binary"]
  Resolve -->|sdk=pi| PiSDK["pi bridge<br/>@earendil-works/pi-agent-core"]
  Resolve -->|sdk=codex + cli mode| CodexApp["codex-app bridge<br/>codex app-server"]

  Resolve --> Caps["runtimeCapabilities()<br/>static backend features"]
  Caps --> Used["capabilitiesUsed<br/>per-call observed features"]
```

Canonical active model references are:

- `claude:<modelId>` for Claude SDK or Claude Code CLI, selected by
  `executionMode`
- `pi:<providerId>:<modelName>` for Pi SDK providers
- `codex:<modelId>` for Codex app-server CLI

Legacy aliases are canonicalized at host ingress when needed. The strict parser
keeps the package boundary honest by rejecting reserved runtime IDs such as
`openai:*`, `vercel:*`, and `claude-code:*`.

## Run Lifecycle

```mermaid
sequenceDiagram
  participant Host as Host app
  participant Runtime as createRuntime()
  participant Registry as Bridge registry
  participant Bridge as Provider bridge
  participant Kernel as Agent kernel
  participant Provider as SDK / CLI / app-server
  participant Observer as Observer hub

  Host->>Runtime: run(systemPrompt, options)
  Runtime->>Registry: resolveRuntimeBridge(model, executionMode)
  Registry-->>Runtime: bridge.execute()
  Runtime->>Observer: create hub from host + call observers
  Runtime->>Bridge: execute(systemPrompt, normalized options)

  Bridge->>Kernel: prepare tools, MCP, approvals, limits
  Kernel-->>Bridge: provider-specific tool surface
  Bridge->>Provider: send prompt, messages, tools, schema, settings

  loop streaming events
    Provider-->>Bridge: assistant/tool/result/provider events
    Bridge->>Observer: normalized runtime events
    Bridge->>Kernel: execute built-in/MCP tools as needed
    Kernel-->>Bridge: tool results or tool errors
  end

  Bridge-->>Runtime: RuntimeResult
  Runtime->>Observer: flush()
  Runtime-->>Host: text, structuredResult, events, usage, diagnostics
  Host->>Host: validate/parse host-specific contract
```

The package forwards provider structured output as `structuredResult`, but it
does not validate that output against a host domain schema. Hosts own that
validation and any state-machine side effects.

## Main Subsystems

```mermaid
flowchart TB
  Public["Public API<br/>src/index.js"] --> RuntimeFactory["runtime.js<br/>createRuntime()"]
  Public --> Router["ai/runtime/router.js<br/>createRouterRuntime()"]
  Public --> AIExports["ai/index.js<br/>model refs, registry, observers"]
  Public --> AgentExports["agent/index.js<br/>allowlists, compaction,<br/>approvals, transcript"]

  RuntimeFactory --> Registry["ai/runtime/registry.js"]
  Registry --> Providers["ai/providers/*"]

  Providers --> Claude["claude-sdk.js"]
  Providers --> ClaudeCode["claude-cli.js"]
  Providers --> Pi["pi-sdk.js<br/>pi-models/messages/events"]
  Providers --> Codex["codex-app.js"]

  AgentExports --> Tools["agent/tools/*"]
  Tools --> ToolRuntime["shared/runtime-context.js<br/>workspace, repoRoot, rg, brand"]
  Tools --> PiBridge["tools/pi-bridge.js<br/>built-ins + MCP adaptation"]

  AgentExports --> Compaction["agent/compaction.js"]
  AgentExports --> Transcript["agent/transcript.js"]
  AgentExports --> Approval["agent/approval.js"]
  AgentExports --> Bloat["agent/tool-bloat.js"]

  AIExports --> Failure["ai/failure.js"]
  AIExports --> Cost["ai/cost.js"]
  AIExports --> Observer["ai/observer.js"]
  AIExports --> Capabilities["ai/runtime/capabilities*.js"]
```

Key responsibilities by subsystem:

- `runtime.js`: binds host callbacks once, configures tool runtime context, and
  routes each call to the resolved bridge.
- `ai/runtime/registry.js`: maps model reference plus execution mode to one of
  the built-in provider bridges.
- `ai/runtime/router.js`: retries across an ordered fallback chain on retryable
  provider failures, carrying a transcript-tail resume snapshot forward.
- `ai/providers/*`: owns provider-specific request shapes, event conversion,
  structured-output extraction, native subagent wiring, usage, and diagnostics.
- `agent/tools/*`: implements built-in tools, path/workdir guards, sandbox
  policy checks, MCP tool adaptation, Playwright artifact routing, and output
  limits.
- `agent/sandbox-seam.js`: the injectable `RuntimeSandbox` interface (policy
  merge, command preparation, network-allow checks) and its zero-dependency
  `passthroughSandbox` default (no policy configured → unsandboxed, exactly as
  before; a policy configured with no implementation injected → fails closed).
  Real hosts inject `@mono-agent/sandbox`'s implementation via
  `@mono-agent/runtime-adapter`.
- `agent/compaction.js`: two pure helpers consumed by the pi bridge —
  `resolveAgentCompactionPolicy` (derives the context-window compaction trigger +
  tool-output payload limits from `agent_compaction_*` settings and the running
  model) and `isLikelyContextTermination` (classifies a context-pressure error).
  The bridge drives compaction itself via `AgentHarness.compact()` (proactive +
  reactive recovery); the legacy in-loop `transformContext` manager was removed.
- `agent/transcript.js`: builds bounded resume snapshots from prior provider
  events so a fallback or continuation can keep context.
- `agent/approval.js`: provides host-driven human-in-the-loop tool approval
  gates where the backend supports runtime tool dispatch.
- `ai/failure.js`: normalizes spawn, usage-limit, provider, cancellation, and
  retryability decisions into stable failure kinds.

## Host Responsibilities

```mermaid
flowchart LR
  Host["Host app"] --> Pricing["resolveCustomPricing"]
  Host --> Auth["resolvePiApiKey"]
  Host --> Persist["persistArtifact"]
  Host --> Compact["onCompactionRecorded"]
  Host --> Approval["onToolApprovalRequest"]
  Host --> Brand["runtimeBrand"]
  Host --> Roots["workspace / repoRoot / ripgrepPath"]

  Pricing --> Runtime["agent-runtime host callbacks"]
  Auth --> Runtime
  Persist --> Runtime
  Compact --> Runtime
  Approval --> Runtime
  Brand --> Runtime
  Roots --> Runtime

  Runtime --> Raw["Raw runtime result"]
  Raw --> Domain["Host-owned domain validation<br/>result contract, state machine,<br/>DB writes, UI surfaces"]
```

The host is responsible for:

- resolving credentials and custom provider/model rows before provider calls
- choosing model references, execution mode, effort, fallback chains, and
  runtime settings
- persisting artifacts, raw logs, run rows, and UI-facing state (the legacy
  compaction-row hook is inert on the current pi bridge)
- validating structured output against the host's domain contract
- converting runtime failures into product workflow behavior
- deciding when to retry, recover, continue, cancel, or ask for user input

## Sessions, Follow-ups & Concurrency

When `runtime.session.mode = "continuous"`, the harness keeps a conversation's
provider session warm and serializes its turns through a per-conversation queue
(`@mono-agent/agent-harness` `LiveSessionManager`). A message that arrives while
a turn is in flight is **queued and answered on the warm session after the
current turn finishes** (queue-after-turn) rather than rejected — this is what
powers follow-up messages in chat channels. Different conversations run
concurrently; an optional `concurrency.maxConcurrentRuns` bounds simultaneous
model runs via admission control around the provider call (queued follow-ups
hold no slot, so the bound never deadlocks against the queue). Note this bound is
**per harness instance** — the app builds one harness per channel, so the limiter
is per-channel, not a single global cap; with N enabled channels the effective
ceiling is N× the configured value. Channels surface
a user cancel through `responder.cancel(conversationId)`, which aborts the
in-flight turn and clears that conversation's queue.

**Honest per-provider session behavior** — parity is *behavioral* (every
provider exposes queue-after-turn), not durability/cost:

The pi runtime is built on pi-agent-core's native `AgentHarness` (the hand-rolled
bridge was removed once native reached parity); it owns the session and
pi-ai-managed retry, and context/window handling is delegated to the harness.
There is **no** automatic in-loop summarization pass driven by this package, so
runs report `context_compaction_applied: null` (unknown/unsupported) rather than
asserting compaction ran.

| Provider | Warm session | Resume across turns | Survives process restart |
|---|---|---|---|
| **pi** | Yes (pi `AgentHarness` + JSONL session repo) | session repo | **Yes** (only one) |
| **claude-sdk** | No persistent process (stream closes at turn end) | `queryOptions.resume` | No (Anthropic-side id) |
| **claude-cli** | No — respawns `claude --resume` per turn (re-inits MCP) | `--resume` replay | No |
| **codex-app** | Live subprocess thread (dies with the subprocess) | next turn on the thread, else replay | No |

claude-cli and codex only *approximate* a warm session (resume/replay), so do
not assume warm-session latency wins there. Recall (memory embeddings) is bounded
by a timeout + circuit breaker and degrades to empty (with a `memory_degraded`
warning) rather than blocking or failing a turn; selected skills are mtime-cached
across turns.

## Essential Takeaway

Think of `@mono-agent/agent-runtime` as the portable agent process engine
underneath a host app. The host decides what a task means, which agent should
run, how state changes, and how results are persisted. The runtime decides how
to talk to Claude, Pi, and Codex execution surfaces; how tools are exposed; how
provider failures are normalized; and how enough telemetry is returned for a
host to make reliable orchestration decisions.
