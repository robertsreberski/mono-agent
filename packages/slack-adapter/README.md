# @mono-agent/slack-adapter

Category: `communication`

## Category

Communication adapter.

## Responsibility

Adapt Slack Socket Mode events into structural agent requests and streamed Slack replies. The package owns Slack-specific credentials, channel allowlists, mention cleanup, Web API calls, and Socket Mode message handling.

## Install / Usage

```bash
pnpm --filter @mono-agent/slack-adapter run build
```

Adapter settings can be loaded from nested JSON under `slack` or explicit environment variables such as `MONO_AGENT_SLACK_BOT_TOKEN`, `MONO_AGENT_SLACK_APP_TOKEN`, and `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS`.

## Public API

- `slackFieldGroup`
- `loadSlackAdapterConfig`
- `redactSlackAdapterConfig`
- Slack config, event, Web API, and Socket Mode types
- Message stream and Slack client helpers

## Dependency Boundary

This package may depend on core agent contracts/settings plus Slack transport dependencies. It must not depend on the agent harness, runtime adapter, operator surfaces, other communication adapters, or host/demo code.

## What This Package Does Not Own

It does not own model execution, memory, prompt context, tool policy, browser/terminal operator surfaces, Slack app provisioning, or workspace-level authorization policy beyond explicit local adapter allowlists.

## Verification

```bash
pnpm --filter @mono-agent/slack-adapter run build
pnpm --filter @mono-agent/slack-adapter run typecheck
pnpm --filter @mono-agent/slack-adapter run test
```
