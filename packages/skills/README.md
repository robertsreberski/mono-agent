# @worklab-ai/skills

## Responsibility

Deterministic selected-skill activation. It loads only explicitly selected skill bodies, enforces byte caps, and converts skill instructions into context blocks for prompt assembly.

## Install / Usage

```bash
pnpm --filter @worklab-ai/skills run build
```

```ts
import {
  loadSelectedSkills,
  skillInstructionsToContextBlocks,
} from "@worklab-ai/skills";
```

## Public API

- `loadSelectedSkills`
- `skillInstructionsToContextBlocks`
- `SkillActivationError`
- `LoadedSkill`, `LoadedSkillContext`, `LoadSelectedSkillsInput`

## Dependency Boundary

This package may depend on `@worklab-ai/context` for context block types. It must not depend on runtimes, communication adapters, UI, memory, or MCP execution.

## What This Package Does Not Own

It does not discover skills automatically, execute tools, install skills, call MCP servers, or decide which skills a host should select.

## Verification

```bash
pnpm --filter @worklab-ai/skills run build
pnpm --filter @worklab-ai/skills run typecheck
pnpm --filter @worklab-ai/skills run test
```
