# @worklab-ai/context

Deterministic context assembly for small Worklab-style agents.

This package turns agent inputs into both structured sections and a Markdown prompt. It accepts an identity, a current user message, optional memory, optional conversation history, optional core/SOUL guardrails, an optional skill index, and optional selected skill instruction blocks. It does not run models, persist memory, scan full skill bodies itself, or hide missing file/configuration errors.

## Install/use in this monorepo

```ts
import { buildAgentContext } from '@worklab-ai/context';
```

## Pure builder example

```ts
import { buildAgentContext } from '@worklab-ai/context';

const context = buildAgentContext({
  identity: {
    kind: 'markdown',
    content: 'You are a release-note assistant for the Mono Agent project.',
    source: 'IDENTITY.md',
  },
  core: 'Follow project guidance, verify real paths, and report failures honestly.',
  memory: [
    { kind: 'markdown', content: '- User prefers concise release notes.', source: 'MEMORY.md' },
    { kind: 'json', value: { openTasks: ['context-layer'] }, source: 'memory.json' },
  ],
  history: [
    { role: 'user', content: 'Draft the changelog.', timestamp: '2026-05-15T12:00:00Z' },
    { role: 'assistant', content: 'I will use the current diff and package README.' },
  ],
  skills: [
    {
      name: 'research',
      description: 'Find source-grounded evidence before making claims.',
      mainFile: '/agent/skills/research/SKILL.md',
    },
  ],
  skillInstructions: {
    kind: 'markdown',
    content: '# Skill: research\n\nFind source-backed evidence before making claims.',
    source: '/agent/skills/research/SKILL.md',
  },
  userMessage: 'Summarize the package changes for handoff.',
});

console.log(context.prompt);
```

## File-loader example

```ts
import { loadContextFromFiles } from '@worklab-ai/context';

const context = await loadContextFromFiles({
  identityPath: './IDENTITY.md',
  soulPath: './SOUL.md', // optional; omitted means use DEFAULT_SOUL_TEXT
  skillsRoot: './skills', // scans immediate child directories for SKILL.md
  memory: { kind: 'markdown', content: '- Keep package boundaries explicit.', source: 'MEMORY.md' },
  history: [{ role: 'user', content: 'Build a context package.' }],
  userMessage: 'Prepare the next runtime prompt.',
});
```

`loadSkillIndexFromDirectory(root)` is conservative: it scans only immediate child directories, derives the skill name from the directory name, derives the description from the first non-heading paragraph in `SKILL.md`, and records the discovered `SKILL.md` path. Malformed skill files throw a typed error instead of being silently skipped.

## Output shape

```ts
{
  prompt: '## Core Guardrails\n\n...\n\n## Identity\n\n...',
  sections: [
    { id: 'core', title: 'Core Guardrails', content: '...' },
    { id: 'identity', title: 'Identity', content: '...', source: 'IDENTITY.md' },
    { id: 'user-message', title: 'Current User Message', content: '...' },
  ],
  metadata: {
    usedDefaultCore: true,
    skillCount: 0,
    historyCount: 0,
    sources: ['IDENTITY.md'],
  },
}
```

Sections render in this stable order:

1. Core guardrails
2. Identity
3. Memory, only when provided
4. Conversation history, only when provided
5. Skill index, only when provided
6. Selected skill instructions, only when provided
7. Current user message

## Default SOUL/core fallback

If `core`/`soulPath` is omitted, the builder uses `DEFAULT_SOUL_TEXT` and sets `metadata.usedDefaultCore` to `true`. If a caller provides an explicit `core` block or `soulPath`, it must be readable and non-empty; the package does not silently fall back for explicit broken inputs.

## Error behavior

Validation failures throw `ContextValidationError` with a stable `code` and machine-readable `details`. Examples include:

- `empty_required_field` for empty identity, core, user message, or history content;
- `invalid_json` for non-JSON values such as `BigInt`, `undefined`, circular values, sparse arrays, or class instances;
- `invalid_skill_index` for duplicate skill names or malformed skill files;
- `file_read_failed` for unreadable explicit file paths.

Memory remains adapter-agnostic. Pass Markdown/text blocks or strict JSON values from whichever memory store your communication/runtime adapter owns.
