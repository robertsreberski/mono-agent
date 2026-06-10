# @mono-agent/skills

## Category

Category: `context`

## Responsibility

Deterministic selected-skill activation. It loads only explicitly selected skill bodies, enforces byte caps, and converts skill instructions into context blocks for prompt assembly.

## Install / Usage

```bash
pnpm --filter @mono-agent/skills run build
```

```ts
import {
  loadSelectedSkills,
  skillInstructionsToContextBlocks,
} from "@mono-agent/skills";
```

## Public API

- `loadSelectedSkills`
- `skillInstructionsToContextBlocks`
- `SkillActivationError`
- `LoadedSkill`, `LoadedSkillContext`, `LoadSelectedSkillsInput`

## Dependency Boundary

This package may depend on `@mono-agent/context` for context block types. It must not depend on runtimes, communication adapters, UI, memory, or MCP execution.

## What This Package Does Not Own

It does not discover skills automatically, execute tools, install skills, call MCP servers, or decide which skills a host should select.

## Verification

```bash
pnpm --filter @mono-agent/skills run build
pnpm --filter @mono-agent/skills run typecheck
pnpm --filter @mono-agent/skills run test
```
