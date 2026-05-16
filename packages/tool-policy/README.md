# @worklab-ai/tool-policy

## Responsibility

Fail-closed tool and MCP policy normalization. It accepts host policy input, loads optional JSON policy files, and converts allowed/disallowed tools plus MCP config paths into runtime options.

## Install / Usage

```bash
pnpm --filter @worklab-ai/tool-policy run build
```

```ts
import {
  createToolPolicy,
  toolPolicyToRuntimeOptions,
} from "@worklab-ai/tool-policy";
```

## Public API

- `createToolPolicy`
- `failClosedToolPolicy`
- `loadToolPolicyFromJsonFile`
- `toolPolicyToRuntimeOptions`
- `ToolPolicyError`, `ToolPolicy`, `ToolPolicyInput`

## Dependency Boundary

This package is a small policy normalizer with filesystem JSON loading. It must not depend on runtime execution, communication adapters, UI, or the harness.

## What This Package Does Not Own

It does not grant tools by default, execute tools, validate MCP server reachability, or manage user consent.

## Verification

```bash
pnpm --filter @worklab-ai/tool-policy run build
pnpm --filter @worklab-ai/tool-policy run typecheck
pnpm --filter @worklab-ai/tool-policy run test
```
