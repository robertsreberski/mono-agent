# @worklab-ai/context

## Responsibility

Deterministic context assembly for Mono Agent prompts. It loads identity and optional SOUL text, normalizes JSON/Markdown blocks, indexes selected skills, appends recent history, and returns a structured prompt context without calling a model.

## Install / Usage

```bash
pnpm --filter @worklab-ai/context run build
```

```ts
import { buildAgentContext, loadContextFromFiles } from "@worklab-ai/context";
```

Use file loading at host boundaries and `buildAgentContext` for deterministic prompt assembly in tests or harnesses.

## Public API

- `buildAgentContext`
- `loadContextFromFiles`
- `buildSkillIndex`, `loadSkillIndexFromDirectory`
- `normalizeJsonValue`
- `DEFAULT_SOUL_TEXT`, `ContextValidationError`
- Context, JSON, skill-index, history, and section types

## Dependency Boundary

This package is pure TypeScript plus filesystem helpers. It does not depend on runtime execution, adapters, memory persistence, UI, or observability.

## What This Package Does Not Own

It does not decide which tools are allowed, run a model, mutate memory, manage conversation transport, or persist run artifacts.

## Verification

```bash
pnpm --filter @worklab-ai/context run build
pnpm --filter @worklab-ai/context run typecheck
pnpm --filter @worklab-ai/context run test
```
