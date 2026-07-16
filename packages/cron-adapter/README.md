# @mono-agent/cron-adapter

## Category

Category: `communication`

## Responsibility

Cron-based scheduled invocation adapter for agent hosts. It parses configured cron jobs, schedules future ticks, invokes a structural `AgentResponder`, and reports explicit succeeded, failed, cancelled, or skipped results.

## Install / Usage

```bash
pnpm --filter @mono-agent/cron-adapter run build
```

```ts
import { startCronAdapter } from "@mono-agent/cron-adapter";

const cron = startCronAdapter({
  responder,
  jobs: [
    {
      id: "daily-check",
      expression: "0 9 * * *",
      timezone: "UTC",
      prompt: "Run the daily check.",
      conversationId: "cron:daily-check",
    },
  ],
});
```

Only future ticks after startup are scheduled. Direct programmatic `startCronAdapter` callers can choose `overlap: "skip" | "queue" | "replace"` (default `"skip"`). Queue mode can be bounded with `maxQueueDepth` and `overflow: "preserve" | "coalesce" | "drop-oldest"`.

`overlap`, `maxQueueDepth`, and `overflow` are programmatic-only adapter options. The config-first `@mono-agent/agent-app` product does not expose them as cron config keys and pins `overlap: "skip"`, so jobs loaded from `mono-agent.config.json`, `MONO_AGENT_CRON_*`, or the cron folder skip overlapping ticks.

Cron expressions use the standard five positional fields `minute hour day-of-month month day-of-week`. The timezone defaults to `UTC`. Six-field expressions with seconds and macro aliases such as `@daily` are not supported. Hosts can validate user input with the same parser used by the scheduler:

```ts
import { validateCronExpression } from "@mono-agent/cron-adapter";

const result = validateCronExpression("0 8 * * MON-FRI", {
  timezone: "Europe/Warsaw",
});

if (!result.ok) {
  // Handle result.code: required, field_count, or invalid.
}
```

### Jobs as markdown files

Besides `cron.jobs` JSON / `MONO_AGENT_CRON_*` env, jobs can be authored as one `*.md` file per job in a cron folder. Frontmatter holds the schedule metadata and the markdown body is the prompt — convenient for refining long prompt templates:

```markdown
---
expression: 0 8 * * *
timezone: Europe/Warsaw
enabled: true
conversationId: daily-digest
---

Summarize yesterday across my channels and post a short digest.
```

- `id` defaults to the filename stem; `timezone` defaults to `UTC`; `enabled` defaults to `true`. The body is required and `expression` is required.
- The folder is resolved against the host working directory from `cron.dir` / `MONO_AGENT_CRON_DIR` (default `cron/`). A missing folder is not an error.
- Folder jobs are merged with config jobs; a duplicate `id` across sources is a hard error.

## Public API

- `startCronAdapter`
- `CronAdapterError`
- `validateCronExpression`
- `loadCronAdapterConfig`
- `loadCronJobsFromDirectory`
- `parseCronJobMarkdown`
- `redactCronAdapterConfig`
- `cronFieldGroup`
- Cron adapter, job, result, metadata, config, and logger types

## Dependency Boundary

This adapter depends on `cron-parser` plus shared `@mono-agent/agent-contracts` primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist missed runs or pending firings, catch up after restart, expose UI, or define core agent settings. Its programmatic overlap queue is in-memory only; durable scheduling state can be added later by a host-level persistence package.

## Verification

```bash
pnpm --filter @mono-agent/cron-adapter run build
pnpm --filter @mono-agent/cron-adapter run typecheck
pnpm --filter @mono-agent/cron-adapter run test
```
