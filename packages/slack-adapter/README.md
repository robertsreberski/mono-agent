# @mono-agent/slack-adapter

Category: `communication`

## Category

Communication adapter.

## Responsibility

Adapt Slack Socket Mode events into structural agent requests and streamed Slack replies. The package owns Slack-specific credentials, channel allowlists, mention cleanup, native model/effort controls, config-driven shortcuts and App Home actions, Web API calls, and Socket Mode message handling.

## Install / Usage

```bash
pnpm --filter @mono-agent/slack-adapter run build
```

Adapter settings can be loaded from nested JSON under `slack` or explicit environment variables such as `MONO_AGENT_SLACK_BOT_TOKEN`, `MONO_AGENT_SLACK_APP_TOKEN`, and `MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS`.

The adapter is opt-in: `slack.enabled` / `MONO_AGENT_SLACK_ENABLED` defaults to `false`. While disabled the loader skips token validation and the channel reports `disabled` rather than `waiting_for_config`. Set `enabled: true` to turn it on; missing tokens or allowlist then surface as a real `waiting_for_config` reason.

## Activity indicator and transient tool ledger

While the agent works, the message stream surfaces progress in the thread. It
prefers Slack's official assistant-thread status — `assistant.threads.setStatus`
("App is _thinking…_"), which Slack auto-clears when the next message posts — and
falls back to a 👀 "seen" reaction on the triggering message. The status path only
applies inside a Slack **AI-assistant thread** and requires the app to have the
**Agents & AI Apps** feature enabled plus the **`assistant:write`** scope; in
regular channels/DMs (or without the scope) the call errors and the adapter uses
the reaction instead — no configuration needed for the fallback.

With final-only delivery, the first tool start posts one cumulative, secret-safe
activity message. Later starts edit it in place, adjacent duplicates collapse as
`(×N)`. On completion the adapter posts the final answer as a new message, then
best-effort deletes the activity message. A cleanup failure cannot duplicate or
lose the final answer, though it can leave the stale activity message behind.
Answer deltas and reasoning never enter that ledger. `ReadSkill` renders the
selected skill as `📚 Reading "<skill>"`
without exposing its path, while memory recall is preview-free as
`🧠 Recalling memory`. Memory writes remain `🧠 Updating memory`, and ordinary
file reads remain `📖 Reading`. Proactive
deliveries suppress it. An acknowledged `/cancel`
best-effort deletes the still-transient ledger and keeps the command's one
`Cancelled.` acknowledgement.

## Model and effort controls

The built-in agent app supplies the Slack adapter with the configured primary
model and fallbacks, so no Slack-specific model list is required. Runtime
controls have two native entry points:

- Send `@agent /model` or `@agent /effort` as an ordinary mention message. In a
  shared channel this keeps the selection local to that Slack thread.
- Register `/<bot-username>-model` and `/<bot-username>-effort` as Slack Slash
  Commands. `startSlackAdapter` derives these exact names from `auth.test.user`,
  so a bot named `foo` handles `/foo-model` and `/foo-effort` without a
  mono-agent config field. Slack slash commands do not carry thread context, so
  shared-channel selections made this way apply across the channel. A thread's
  mention-command selection can still override the inherited channel choice.

`startSlackAdapter` discovers the authenticated bot user ID with `auth.test` and
merges it with any configured `botUserIds`. A leading self-mention is removed
for command recognition even when ordinary prompt mention stripping is disabled,
so `@agent /model` works without copying the app's member ID into config. The
`stripMentionText` option continues to control whether mentions are removed from
normal prompts.

The same controls also accept exact arguments:

- `@agent /model default` or `@agent /model <exact-configured-ref>`
- `@agent /effort default` or `@agent /effort <supported-value>`
- `/<bot-username>-model default` or `/<bot-username>-model <exact-configured-ref>`
- `/<bot-username>-effort default` or `/<bot-username>-effort <supported-value>`

In a direct-message channel, a selection applies to every subsequent DM turn,
including new Slack threads. In public and private shared channels, slash-command
choices are channel-wide while mention-command choices are thread-local and take
precedence. Everyone using the same scope shares its selection. State is
process-local and resets on restart. Changing models also clears a selected
effort when the new model does not support it.

Model options use a short model identifier as the title and the exact configured
reference as descriptive text. Runtime-control plain text explicitly disables
Slack emoji expansion so colon-delimited references remain literal.

Enable **Interactivity & Shortcuts** in the Slack app so selector actions arrive
over Socket Mode. To expose commands in Slack's `/` picker, create the two Slash
Commands in the app configuration, add the `commands` bot scope, and reinstall
the app if Slack requests authorization; Socket Mode carries their payloads, so
no Request URL is needed. A direct programmatic adapter consumer can override
the derived names with `runtimeSlashCommands`, omit `runtimeControls` to leave
all runtime commands unbound, or supply a validated catalog through that option.
Slack static-select menus support at most 100 options; a larger catalog remains
selectable with the exact-argument form.

## Silent-delivery limitation

Programmatic proactive delivery accepts `silent: true` in both
`SlackNotifyOptions` and `SlackMessageStreamOptions` so channel integrations can
use a common option shape. Slack's `chat.postMessage` API has no bot-controlled
equivalent to Telegram's `disable_notification`, however. The adapter therefore
posts with normal Slack notification behavior and, when a logger is configured,
emits one explicit warning; it never forwards an invented `silent` field or
claims suppression succeeded. Slack client/workspace notification settings
remain authoritative. A caller that requires guaranteed quiet hours must skip
or defer the Slack delivery.

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

<!-- public-api-inventory:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

Every symbol exported by each public code entrypoint is listed below.

**`@mono-agent/slack-adapter`**

```text
AgentMessageStream
AgentRequest
AgentResponder
AgentResponse
LoadSlackAdapterConfigInput
SLACK_CONFIG_FIELDS
SLACK_MAX_MESSAGE_CHARS
SerialQueueFullError
SlackAdapter
SlackAdapterConfig
SlackAdapterConfigError
SlackAdapterConfigErrorCode
SlackAdapterConfigErrorDetails
SlackAdapterLogger
SlackAdapterMessages
SlackAdapterOptions
SlackAdapterStartLogger
SlackAdapterStartOptions
SlackAdapterStartResult
SlackAdapterStreamOptions
SlackApiError
SlackApiErrorDetails
SlackApiErrorKind
SlackApiFactoryInput
SlackAppsConnectionsOpenResult
SlackAttachmentOptions
SlackAuthTestResult
SlackBlockAction
SlackBlockActionsPayload
SlackChannelId
SlackChatDeleteParams
SlackChatDeleteResult
SlackChatPostMessageParams
SlackChatPostMessageResult
SlackChatUpdateParams
SlackChatUpdateResult
SlackContinuationSynthesisInput
SlackDeliveryError
SlackDeliveryReceipt
SlackDeliveryReceiptListener
SlackDownloadFileParams
SlackEventBase
SlackEventCallback
SlackEventCallbackHandler
SlackEventHandlingResult
SlackEventIgnoredReason
SlackFile
SlackHomeButton
SlackHomeButtonConfig
SlackHomeTabConfig
SlackHomeTabOptions
SlackInteractionHandler
SlackInteractionHandlingResult
SlackInteractivityPayload
SlackMessageStream
SlackMessageStreamLogger
SlackMessageStreamOptions
SlackMessageTs
SlackNotifyOptions
SlackNotifyResult
SlackRequestMetadata
SlackRequestOptions
SlackRuntimeControls
SlackRuntimeEffortOption
SlackRuntimeModelOption
SlackRuntimeSlashCommands
SlackSendOutcome
SlackShortcutBinding
SlackShortcutConfig
SlackShortcutPayload
SlackSlashCommandHandler
SlackSlashCommandHandlingResult
SlackSlashCommandPayload
SlackSocketModeEnvelope
SlackSocketModeRunner
SlackSocketModeRunnerBackoffOptions
SlackSocketModeRunnerHeartbeatOptions
SlackSocketModeRunnerLogger
SlackSocketModeRunnerOptions
SlackSocketModeRunnerStartOptions
SlackTriggerKind
SlackUserId
SlackViewsPublishParams
SlackWebApi
SlackWebApiClient
SlackWebApiClientOptions
SlackWebSocketFactory
SlackWebSocketLike
classifySlackError
formatMarkdownForSlack
loadSlackAdapterConfig
normalizeSlackMarkdownToMarkdown
startSlackAdapter
```

<!-- public-api-inventory:end -->

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
