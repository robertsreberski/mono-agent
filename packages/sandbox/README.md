# @mono-agent/sandbox

## Category

Category: `runtime`

## Responsibility

Fail-closed sandbox policy normalization and native process wrapping for runtime-owned command execution.

## Install / Usage

```bash
pnpm --filter @mono-agent/sandbox run build
```

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

## Public API

- `createSandboxPolicy`
- `failClosedSandboxPolicy`
- `mergeSandboxPolicies`
- `sandboxPolicyToRuntimeOptions`
- `createSrtSandboxEngine`
- `prepareSandboxedCommand`
- `srtSettingsForPolicy`
- `networkPolicyAllowsUrl`

## Dependency Boundary

`@mono-agent/sandbox` is a runtime package. It must stay independent of model providers, host config, harness execution, communication adapters, and UI packages so runtimes can share the same policy object without importing host composition code.

## What This Package Does Not Own

It does not implement prompt policy, user approval, provider credentials, memory, or adapter-specific allowlists. It also does not make an unavailable native sandbox safe by default; the default policy fails closed unless a caller explicitly opts into unsafe host execution.

## Verification

```bash
pnpm --filter @mono-agent/sandbox run build
pnpm --filter @mono-agent/sandbox run typecheck
pnpm --filter @mono-agent/sandbox run test
```
