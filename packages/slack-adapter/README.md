# @mono-agent/slack-adapter

Category: `communication`

## Category

Communication adapter.

## Responsibility

Adapt Slack Socket Mode events into structural agent requests and streamed Slack replies. The package owns Slack-specific credentials, channel allowlists, mention cleanup, config-driven shortcuts and App Home actions, Web API calls, and Socket Mode message handling.

## Install / Usage

```bash
pnpm --filter @mono-agent/slack-adapter run build
```

Adapter settings can be loaded from nested JSON under `slack` or explicit environment variables such as `MONO_AGENT_SLACK_BOT_TOKEN`, `MONO_AGENT_SLACK_APP_TOKEN`, and `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS`.

The adapter is opt-in: `slack.enabled` / `MONO_AGENT_SLACK_ENABLED` defaults to `false`. While disabled the loader skips token validation and the channel reports `disabled` rather than `waiting_for_config`. Set `enabled: true` to turn it on; missing tokens or allowlist then surface as a real `waiting_for_config` reason.

## Activity indicator (assistant status / 👀)

While the agent works, the message stream surfaces progress in the thread. It
prefers Slack's official assistant-thread status — `assistant.threads.setStatus`
("App is _thinking…_"), which Slack auto-clears when the next message posts — and
falls back to a 👀 "seen" reaction on the triggering message. The status path only
applies inside a Slack **AI-assistant thread** and requires the app to have the
**Agents & AI Apps** feature enabled plus the **`assistant:write`** scope; in
regular channels/DMs (or without the scope) the call errors and the adapter uses
the reaction instead — no configuration needed for the fallback.

## Shortcuts and App Home

`slack.shortcuts` binds global or message shortcut callback IDs to prompts.
`slack.homeTab` publishes an optional header and prompt-running buttons when the
Home tab opens. Both fields are structured JSON-only configuration; they have no
environment-variable form. App Home defaults to disabled when `enabled` is
omitted, and `buttons` defaults to an empty array; an enabled header-only tab is
valid.

```json
{
  "slack": {
    "shortcuts": [
      {
        "callbackId": "triage_request",
        "prompt": "Prepare the daily support triage checklist.",
        "channelId": "C0123"
      }
    ],
    "homeTab": {
      "enabled": true,
      "headerText": "*Quick actions*",
      "buttons": [
        {
          "actionId": "build_digest",
          "label": "Build digest",
          "prompt": "Build today's team digest.",
          "channelId": "C0123"
        }
      ]
    }
  }
}
```

Destinations still pass the Slack channel allowlist. See the canonical
[Slack channel guide](../../docs/channels/slack.md#shortcuts) for all fields,
routing behavior, and Slack app setup.

## Public API

- `SLACK_CONFIG_FIELDS`
- `loadSlackAdapterConfig`
- `redactSlackAdapterConfig`
- Slack config, event, Web API, and Socket Mode types
- Message stream, Slack client, and Slack/Markdown formatting helpers

## Dependency Boundary

This package may depend on `@mono-agent/agent-contracts` plus Slack transport dependencies. It must not depend on the agent harness, runtime adapter, operator surfaces, other communication adapters, or host/demo code.

## What This Package Does Not Own

It does not own model execution, memory, prompt context, tool policy, browser/terminal operator surfaces, Slack app provisioning, or workspace-level authorization policy beyond explicit local adapter allowlists.

## Verification

```bash
pnpm --filter @mono-agent/slack-adapter run build
pnpm --filter @mono-agent/slack-adapter run typecheck
pnpm --filter @mono-agent/slack-adapter run test
```
