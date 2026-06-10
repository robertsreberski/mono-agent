# @mono-agent/sandbox

## Category

Category: `runtime`

## Responsibility

Fail-closed sandbox policy normalization and native process wrapping for runtime-owned command execution.

## Install / Usage

```bash
pnpm --filter @mono-agent/sandbox run build
```

The drop-in path for hosts is one policy object handed to the runtime — every
built-in tool (Bash, Read/Write/Edit, Glob/Grep, WebFetch/WebSearch) and stdio
MCP startup then enforces it without per-call wiring:

```ts
import { failClosedSandboxPolicy } from "@mono-agent/sandbox";

const runtime = createMonoRuntime({
  workspace,
  sandboxPolicy: failClosedSandboxPolicy({ root: workspace }),
});
```

The same policy can be built from `MONO_AGENT_SANDBOX_*` env vars via
`@mono-agent/config`. For direct command preparation:

```ts
import {
  failClosedSandboxPolicy,
  prepareSandboxedCommand,
} from "@mono-agent/sandbox";

const policy = failClosedSandboxPolicy({ root: process.cwd() });
const prepared = await prepareSandboxedCommand({
  policy,
  command: {
    command: "/bin/bash",
    args: ["-lc", "pnpm test"],
    cwd: process.cwd(),
  },
});
```

By default the package prepares commands for a native `srt` sandbox and fails
closed when the sandbox engine is unavailable. An unsafe host-process fallback
requires both `fallback: "unsafe-host-process"` and
`unsafeAllowHostProcess: true`.

## Policy Semantics

- `readableRoots` / `writableRoots` default to `[root]`; everything outside is
  denied, the user's home directory is always added to the native deny-read
  list unless a readable root covers it, and `~/.ssh` is always denied.
- `denyWrite` defaults to `DEFAULT_DENY_WRITE` (`.env`, `.env.*`,
  `.git/config`, `.git/hooks/**`) and is enforced by the native engine.
- `network` is `none` by default. `allowlist` entries match exact hosts, or
  subdomains with a `*.` prefix. `localhost` covers loopback addresses
  including bracketed IPv6 (`[::1]`).
- `mergeSandboxPolicies(configured, request)` is monotonic: a request-scoped
  policy can only tighten roots, network access, and the fallback — never
  weaken or disable the configured policy. The runtime applies this merge
  itself, so per-call options cannot bypass a host-configured policy.
- Engine availability (`srt --version`) is probed once per process, and srt
  settings files are content-addressed under `tempRoot` and reused across
  commands run under the same policy.

## Public API

- `createSandboxPolicy` / `failClosedSandboxPolicy`
- `mergeSandboxPolicies`
- `sandboxRequired`
- `sandboxPolicyToRuntimeOptions`
- `createSrtSandboxEngine`
- `prepareSandboxedCommand`
- `srtSettingsForPolicy`
- `networkPolicyAllowsUrl`
- `SANDBOX_MODES`, `SANDBOX_NETWORK_MODES`, `SANDBOX_FALLBACKS`, `DEFAULT_DENY_WRITE`

## Enforcement Scope

The native engine wraps runtime-owned process execution: Bash commands and
stdio MCP server startup. File tools (Read/Write/Edit/Glob/Grep) are enforced
in-process by path checks that include symlink-target containment. WebFetch
and WebSearch are enforced in-process by the network policy, including every
redirect hop. Provider CLI bridges (Claude Code CLI/SDK, Codex app) run their
own tool loops and are not wrapped by this policy yet — pair them with the
provider's own sandboxing when that matters.

## Dependency Boundary

`@mono-agent/sandbox` is a runtime package. Beyond the shared
`@mono-agent/agent-contracts` error base it must stay independent of model
providers, host config, harness execution, communication adapters, and UI
packages so runtimes can share the same policy object without importing host
composition code.

## What This Package Does Not Own

It does not implement prompt policy, user approval, provider credentials, memory, or adapter-specific allowlists. It also does not make an unavailable native sandbox safe by default; the default policy fails closed unless a caller explicitly opts into unsafe host execution.

## Verification

```bash
pnpm --filter @mono-agent/sandbox run build
pnpm --filter @mono-agent/sandbox run typecheck
pnpm --filter @mono-agent/sandbox run test
```
