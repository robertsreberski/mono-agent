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

Only future ticks after startup are scheduled. Overlapping runs for the same job are skipped, not queued or run concurrently.

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
- `loadCronAdapterConfig`
- `loadCronJobsFromDirectory`
- `parseCronJobMarkdown`
- `redactCronAdapterConfig`
- `cronFieldGroup`
- Cron adapter, job, result, metadata, config, and logger types

## Dependency Boundary

This adapter depends on `cron-parser` plus shared contracts/settings primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist missed runs, catch up after restart, queue overlapping jobs, expose UI, or define core core agent settings. Durable scheduling state can be added later by a host-level persistence package.

## Verification

```bash
pnpm --filter @mono-agent/cron-adapter run build
pnpm --filter @mono-agent/cron-adapter run typecheck
pnpm --filter @mono-agent/cron-adapter run test
```
