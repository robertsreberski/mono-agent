# @mono-agent/cron-adapter

## Category

Category: `communication`

## Responsibility

Cron-based scheduled invocation adapter for Mono Agent hosts. It parses configured cron jobs, schedules future ticks, invokes a structural `AgentResponder`, and reports explicit succeeded, failed, cancelled, or skipped results.

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

## Public API

- `startCronAdapter`
- `CronAdapterError`
- `loadCronAdapterConfig`
- `redactCronAdapterConfig`
- `cronFieldGroup`
- Cron adapter, job, result, metadata, config, and logger types

## Dependency Boundary

This adapter depends on `cron-parser` plus shared contracts/settings primitives. It must not depend on the agent harness, runtime adapter, operator surfaces, memory, observability, other communication adapters, or host/demo code. Hosts compose it with a structural responder.

## What This Package Does Not Own

It does not build prompts, run models, persist missed runs, catch up after restart, queue overlapping jobs, expose UI, or define core Mono Agent settings. Durable scheduling state can be added later by a host-level persistence package.

## Verification

```bash
pnpm --filter @mono-agent/cron-adapter run build
pnpm --filter @mono-agent/cron-adapter run typecheck
pnpm --filter @mono-agent/cron-adapter run test
```
