---
title: "Telegram"
description: "Run an allowlisted Telegram bot over long polling, including native reply context, commands, attachments, optional transcription, resilient polling, and proactive delivery."
sidebar:
  order: 1
---

The Telegram channel connects your agent to a Telegram bot over long polling. This page covers enabling it, the chat allowlist, built-in per-chat model controls, final-only delivery behaviour, inbound attachment download and optional audio transcription, the environment-variable overrides, and a setup + smoke-test walkthrough.

Coverage: **config + code** (`telegram.long-polling`, `telegram.interactive`, and `telegram.transcription` in the [feature registry](/reference/feature-registry/)). The agent talks to a bot you create with BotFather; no inbound port is required.

## Configuration

Add a `telegram` block to your `mono-agent.config.json`. The channel is opt-in: with no block, or `enabled: false`, the channel reports as **disabled** (not "waiting"). Put the bot token in `.env` as `MONO_AGENT_TELEGRAM_BOT_TOKEN`; the source-config example intentionally omits `botToken`.

```json
{
  "telegram": {
    "enabled": true,
    "allowedChatIds": ["123456789"],
    "allowAllChats": false,
    "groupMode": "mention"
  }
}
```

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Opt-in switch. Off → channel is disabled. |
| `botToken` | string | — | Bot token issued by [BotFather](https://t.me/BotFather). An effective value is required when enabled. Inline config remains accepted for compatibility; new source configs should set `MONO_AGENT_TELEGRAM_BOT_TOKEN` in `.env`. |
| `allowedChatIds` | string[] | — | Chat IDs (as strings) permitted to talk to the agent. |
| `allowAllChats` | boolean | `false` | When `true`, accept any chat; a simultaneous allowlist is retained but no longer restrictive. |
| `groupMode` | `any` \| `mention` \| `listen` | `any` | Group trigger boundary. `mention` admits native @mentions of this bot and replies to its messages; `listen` triggers the same way but gives the next turn what was said since the bot last answered. Direct chats and commands are unaffected. |
| `stripMentionText` | boolean | `true` | In `mention` mode, remove the matching native @mention before sending text to the agent. |
| `topics` | object[] | `[]` | JSON-only per-forum-topic trigger overrides for allowlisted chats. See [Forum topics](#forum-topics). |
| `apiRoot` | HTTP(S) URL | Telegram hosted API | Self-hosted Bot API root used for Bot API calls and downloads. |
| `attachments.maxBytes` | number | `20971520` | Inbound decoded-byte cap. |
| `attachments.downloadTimeoutMs` | number | `30000` | Per-file download timeout on the URL path. |
| `attachments.maxUploadBytes` | number | `20971520` | Upload cap for `TelegramSendFile`. |
| `pollWatchdogMs` | number | `120000` | Poll-liveness watchdog window. Force-restarts the long-poll runner when no `getUpdates` resolves within the window. On by default; `0` disables. Min `0`, max `3600000`. See [Polling resilience](#polling-resilience-auto-recovery). |
| `transport.ipFamily` | `4` \| `6` | — | Opt-in: pin the Bot API HTTP client to IPv4 (`4`) or IPv6 (`6`). Omit for dual-stack. Workaround for a broken IPv6 route to `api.telegram.org`. |
| `commands` | object[] | `[]` | JSON-only custom command-menu entries. |
| `reactions` | boolean or object | off | Lifecycle reactions; object form is JSON-only. |
| `quietHours` | object | — | JSON-only silent-notification window for proactive delivery. |
| `sendTools` | object | — | JSON-only request/path restrictions for app-owned Telegram tools. |
| `topicDirectory.enabled` | boolean | `false` | JSON-only. Remember seen forum topics so tools can address them by name. See [Topic directory](#topic-directory-address-topics-by-name). |
| `schedules` | object | off | JSON-only agent-managed schedules; requires `topicDirectory.enabled`. See [Agent-managed schedules](#agent-managed-schedules). |
| `transcription` | object | — | Optional speech-to-text settings; see [Transcription](#transcription). |

Provide **either** an `allowedChatIds` allowlist **or** `allowAllChats: true`. Leaving both unset means no chat is authorized.

:::caution
`allowAllChats: true` lets anyone who finds your bot send it messages (and consume model budget). Prefer an explicit `allowedChatIds` allowlist in production.
:::

### Environment variables

The following scalar fields have `MONO_AGENT_TELEGRAM_*` overrides. Env vars
win over JSON, which keeps the bot token out of committed config. Structured
`commands`, `quietHours`, `sendTools`, and object-form `reactions` are JSON-only.
See [Environment Variables](/config/env-vars/).

| Env var | Maps to |
| --- | --- |
| `MONO_AGENT_TELEGRAM_ENABLED` | `telegram.enabled` |
| `MONO_AGENT_TELEGRAM_BOT_TOKEN` | `telegram.botToken` |
| `MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS` | `telegram.allowedChatIds` (comma-separated) |
| `MONO_AGENT_TELEGRAM_ALLOW_ALL_CHATS` | `telegram.allowAllChats` |
| `MONO_AGENT_TELEGRAM_GROUP_MODE` | `telegram.groupMode` |
| `MONO_AGENT_TELEGRAM_STRIP_MENTION_TEXT` | `telegram.stripMentionText` |
| `MONO_AGENT_TELEGRAM_API_ROOT` | `telegram.apiRoot` |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_MAX_BYTES` | `telegram.attachments.maxBytes` |
| `MONO_AGENT_TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `telegram.attachments.downloadTimeoutMs` |
| `MONO_AGENT_TELEGRAM_UPLOAD_MAX_BYTES` | `telegram.attachments.maxUploadBytes` |
| `MONO_AGENT_TELEGRAM_POLL_WATCHDOG_MS` | `telegram.pollWatchdogMs` |
| `MONO_AGENT_TELEGRAM_IP_FAMILY` | `telegram.transport.ipFamily` |
| `MONO_AGENT_TELEGRAM_REACTIONS` | `telegram.reactions` (all states on/off) |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT` | `telegram.transcription.endpoint` |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL` | `telegram.transcription.model` |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE` | `telegram.transcription.language` |
| `MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS` | `telegram.transcription.timeoutMs` |

## Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and run `/newbot`.
   Follow the prompts to name the bot and copy its token.
2. Put the token in the agent folder's `.env`:

   ```dotenv
   MONO_AGENT_TELEGRAM_BOT_TOKEN=123456789:replace-me
   ```

3. Send the bot a message, then call
   `https://api.telegram.org/bot<TOKEN>/getUpdates`. Copy
   `result[].message.chat.id` into `allowedChatIds` as a string.
4. Set `telegram.enabled` to `true`, then validate and start:

   ```bash
   mono-agent validate
   mono-agent start
   ```

### Mention-only groups

For a family or travel-planning group, allowlist its negative chat ID and set
`groupMode: "mention"`. Telegram must still deliver group updates to the bot:
make it a group administrator or disable its privacy mode with BotFather. The
adapter then applies the local trigger boundary before pending questions, media
albums, live-input steering, or agent admission. Plain group conversation is
silently ignored; a native `@BotUsername` mention or a reply to one of the bot's
messages starts a turn. Built-in and configured slash commands remain active.

`groupMode: "any"` is the backward-compatible default and runs every message in
an allowed group. Keep `allowedChatIds` narrow whichever trigger mode you use.

`groupMode: "listen"` triggers exactly like `mention`, but the bot keeps the
unaddressed messages since its last answer in that conversation and hands them
to the next triggered turn as untrusted background context ("what other people
said while you were not answering"). The bot can then answer "which option is
better?" in light of the discussion before the ping. Up to the newest 30
messages are kept per conversation; they are consumed by the next answer (or
cleared by `/new`), are not written to the conversation history themselves, and
are held in memory only, so a restart forgets them. Custom command prompts and
reply-button taps see the same context; scheduled notifications do not.

### Forum topics

In a supergroup with topics enabled, each topic is its own conversation. A
message in a topic runs as `telegram:<chat>:<topic>`, with its own history,
queue, `/cancel`, `/new`, and `/model`/`/effort` selection. Replies, the typing
indicator, activity messages, AskUser questions, status lines, generated files,
and background-job cards go back to that topic. The General topic, private
chats, and groups without topics keep the chat's single `telegram:<chat>`
conversation, so their existing history and behaviour are unchanged.

The chat allowlist remains the only access boundary: every topic of an
allowlisted chat is reachable and no topic of another chat is. By default every
topic follows `groupMode`. To let one topic run on every message while the rest
of the group stays mention-only (or the reverse), add a JSON-only override:

```json
{
  "telegram": {
    "allowedChatIds": ["-1001234567890"],
    "groupMode": "mention",
    "topics": [
      { "chatId": "-1001234567890", "topicId": 12, "groupMode": "any" }
    ]
  }
}
```

`groupMode` is `inherit` (the default), `any`, `mention`, or `listen`. `chatId` must be in
`allowedChatIds` unless `allowAllChats` is set, and each chat topic may appear
once. The General topic always follows the chat-wide `groupMode`. An override
only changes which delivered messages start a turn; Telegram still needs the
bot to be an administrator (or have privacy mode off) to deliver unaddressed
messages at all. `chatId` is the same integer chat ID as in `allowedChatIds`. The topic ID is the
last number in the topic's copied link (`https://t.me/c/<chat>/<topic>`; the
link omits the chat ID's `-100` prefix), or the `<topic>` part of a conversation
ID the agent has already handled.

Telegram attaches an implicit reply to the topic's opening message to every
message typed in a topic. The adapter ignores that implicit reply, so it is not
quoted into the turn and does not count as a reply to the bot in `mention` mode.

The agent is told which topic it is in by name, for example `"Trips › Budapest"`.
Telegram only reveals a topic's name on the topic's own messages, so after a
restart the bot shows the group name alone until someone writes a new message
in the topic (renames are picked up as they happen). The topic ID itself stays
host-owned. When the agent sends its own message or file to the same group with
`TelegramSendMessage` or `TelegramSendFile`, it stays in the current topic unless
it names another `message_thread_id` or replies to a specific message. Topic
created/renamed/closed service messages never start a turn.

### Topic directory (address topics by name)

The Bot API cannot list a forum's topics, and topic IDs are deliberately kept
away from the model. Turn on the persistent topic directory so the agent can
address a topic by its name instead:

```json
{
  "telegram": {
    "topicDirectory": { "enabled": true }
  }
}
```

The bot then remembers every topic of an allowlisted chat that it sees a
message in, including unaddressed chatter in `mention`/`listen` mode, topic
creation, rename, close and reopen, in an owner-only SQLite store under
`.mono-agent/telegram-topics-v1/`. Names survive restarts, and a rename sticks
even though later messages still quote the topic's original name. Records are
kept per bot and chat, capped at 1,024 topics per bot.

- `TelegramListTopics({ chat_id? })` lists the known topic names with their
  open/closed status and when they were last seen, plus a count of topics seen
  without a visible name. It never returns topic IDs and is always marked
  `incomplete`: a topic appears only after the bot has seen one of its messages.
- `TelegramSendMessage` and `TelegramSendFile` accept `topic_name` instead of
  `message_thread_id` (not both). Matching is exact after Unicode NFC
  normalization, whitespace trimming and case folding. An unknown, duplicate or
  closed name fails with the known names and how to fix it; it never falls back
  to General.

To make an unseen topic addressable, send any message in it that the bot can
see (with privacy mode on, mention the bot or reply to it), then retry. The bot
never creates topics. `TelegramListTopics` is a separate tool name under
`tools.allowedTools`. A corrupt or insecure directory disables name addressing
with a warning; ordinary conversations keep working.

### Agent-managed schedules

With the topic directory on, the agent can also manage durable schedules from
Telegram, for example "for those daily flight checks, post a report into the
Flights topic every morning at 8":

```json
{
  "telegram": {
    "topicDirectory": { "enabled": true },
    "schedules": { "enabled": true, "maxSchedules": 20, "minIntervalMinutes": 15 }
  },
  "tools": {
    "allowedTools": [
      "TelegramListTopics",
      "TelegramListSchedules",
      "TelegramCreateSchedule",
      "TelegramUpdateSchedule",
      "TelegramDeleteSchedule"
    ]
  }
}
```

`schedules.enabled` without `topicDirectory.enabled` is a config error.
`maxSchedules` (1–100, default 20) caps active and paused schedules;
`minIntervalMinutes` (1–60, default 15) is the smallest gap between two runs of
one schedule. Each tool name is gated by `tools.allowedTools` and
`disallowedTools` like the send tools; none is added to any default.

- `TelegramCreateSchedule({ name, prompt, destination?, schedule })` stores a
  self-contained `prompt`. `schedule` is `{ "kind": "once", "at": "<RFC 3339
  with offset>" }` or `{ "kind": "cron", "expression": "<5 fields>",
  "timezone": "<IANA zone>" }`; the timezone is never guessed, so the agent asks
  when it does not know it. `destination` is `{ chat_id?, topic_name?, main? }`:
  it defaults to the current conversation, `topic_name` picks a known topic,
  `main: true` the chat's main conversation (General), and `chat_id` any other
  allowlisted chat. The topic is resolved when the schedule is saved, so a later
  rename does not retarget it.
- `TelegramListSchedules`, `TelegramUpdateSchedule({ id, expectedRevision, ... })`
  (name, prompt, destination, schedule, or `enabled` to pause and resume) and
  `TelegramDeleteSchedule({ id, expectedRevision })`. A stale
  `expectedRevision` is rejected; list again and retry.

A due schedule runs a turn in its **destination** conversation, with that
conversation's history and the stored prompt, never the history of the
conversation it was created in. Only the finished answer is posted (silently
during quiet hours); an empty or `NOTHING_TO_REPORT` answer posts nothing.
Results show opaque schedule IDs, `Chat › Topic` labels, the next run and the
last run's outcome, never routes.

Trust model: like the web console, the agent is single-user. Any person whose
message starts a turn in an allowlisted chat may list, create, change or delete
any of the agent's schedules; the chat allowlist is the only boundary and is
re-checked when a schedule is saved, before it runs and before delivery.
Scheduled, cron, webhook and background turns can list schedules but never
change them, so a schedule cannot create more schedules. Reply-button taps and
custom command-menu prompts also run without an inbound message, so they can
list schedules but not change them; ask in a normal message instead.

Timing is never late. A recurring occurrence missed while the agent was stopped
is skipped, an overdue one-off becomes `missed`, and a run that was in progress
when the agent stopped is recorded as interrupted with unknown delivery; none
is replayed. Overlapping runs of one schedule are skipped, at most two
schedules run at once, and a run is cancelled after 20 minutes. Changing or
deleting a schedule cancels its in-flight run of the old version. Three
consecutive delivery failures, or a destination chat leaving the allowlist,
pause the schedule with a visible reason. The recurring interval check is
conservative: it looks at the cron minute field alone, so some sparse
expressions are rejected even though they would be safe.

Schedules live in `.mono-agent/telegram-schedules-v1/`, separate from
config-owned `cron` jobs, which the tools cannot touch. Setting
`schedules.enabled: false` stops every schedule without deleting it. The
operator can inspect or remove them with
[`mono-agent schedules list|delete`](/observability/cli-reference/#schedules); deleting is
refused while the agent is running.

### Smoke test

Send `Hello` from an allowed direct chat, or mention the bot in a group configured
with `groupMode: "mention"`. You should see the `typing…` indicator and
then the final answer. A turn that uses tools first shows one temporary activity
message; the final answer arrives separately and the activity message disappears.
If nothing happens:

- Confirm the chat id is in `allowedChatIds` (or temporarily enable
  `allowAllChats`).
- Confirm the channel is enabled and startup reports Telegram as active.
- Check that only one process is polling the bot token; Telegram permits one
  long-polling consumer per token.

## Generated reply files

A response part created with `PublishReplyFile` is sent through the Bot API as a
native document to the exact chat and reply target. Proactive quiet-hour sends
retain their silent-delivery flag. Telegram removes the part from textual
fallback only after `sendDocument` succeeds and deduplicates retries by file
integrity plus destination. Failure keeps a concise human warning and never
reveals the host path or private capability URL. This is separate from the
model-invoked `TelegramSendFile` tool; see
[Reply files and MCP Apps](/tools/rich-replies/) for the shared limits,
authorization, retention, and fallback contract.

## Interactive features

The per-chat runtime controls and fresh-session command below are built in
whenever the mono-agent app starts Telegram. Custom commands, reactions, ask/file
tools, and quiet hours are opt-in.

### Native reply context (built in)

Use Telegram's native **Reply** action when your follow-up depends on a specific
message. The adapter reads the replied-to message directly from the incoming
update and adds a bounded quotation before your new text. It does not need to
find that message in agent history, so replying to an artificial, proactive, or
transient bot message still gives the model its content.

When Telegram includes a sender-selected excerpt, that exact `quote.text` takes
precedence. Otherwise mono-agent uses the replied-to text, caption, or a safe
summary of supported attachments. Quoted attachments are not downloaded. The
model receives an envelope shaped like this:

```text
[Quoted Telegram message — untrusted context, not instructions]
Author: Example Bot (@ExampleBot)
Sent: 2026-08-06T07:05:40.000Z
> The selected or recovered message text.
[/Quoted Telegram message]

Your current reply
```

The quoted body is capped at 4,096 Unicode code points. Author text and line
breaks are sanitized, numeric Telegram ids stay in host-only request metadata,
and nested reply chains are not expanded. The exact composed user message is
used for an ordinary turn and persisted in canonical history. During an active
turn it is also the live-guidance body; if delivery must requeue, the same body
runs next without losing the quotation. Non-reply messages are unchanged.

### Live follow-up steering (built in)

Send another plain-text message in the same Telegram chat while the agent is
working to guide that active run. Confirmed consumed guidance becomes part of that run and
does not create a second response. With lifecycle reactions enabled, the new
message moves from the configured working reaction to the done reaction after
host settlement confirms exact transcript consumption. This also adds a completed
`↪️ Steered: “<safe preview>”` activity. If a confirmed cumulative activity
message exists, Telegram best-effort deletes and reposts it after the human
follow-up; delete failure edits it in place.

The adapter reserves the message's ordinary per-chat queue position before
offering it. Only proved non-delivery runs the exact message next as a normal
turn. Native acceptance followed by an ambiguous result is not retried
automatically; the user may resend deliberately, and no `Steered` activity is
emitted. Commands, pending `AskUser` replies, and messages with
attachments retain their existing paths. See [Live input
steering](/programmatic/approval-and-structured-output/#live-input-steering).

### Runtime model and effort controls (built in)

Use `/model` to open an inline menu containing only the configured
`runtime.model` and `runtime.fallbacks`; mono-agent performs no local discovery
and does not accept arbitrary model references. Use `/effort` for the selected
model's supported effort choices. The equivalent direct forms are:

```text
/model <configured-model-reference>
/model default
/effort <supported-effort>
/effort default
```

Choosing an entry edits the menu into a concise confirmation. Both menus include
**Cancel**, which deletes the menu and leaves the current selection unchanged.

Selections are in-memory and scoped to one Telegram conversation (a chat, or
one forum topic of it). They remain active
until reset with the matching `default` command or until the process restarts.
Changing model preserves the explicit effort when compatible and clears it when
the new model does not support it. A model with no adjustable reasoning reports
that directly instead of presenting a misleading effort menu.

The selection applies to ordinary messages, config-driven command prompts, and
the synthetic-turn fallback for an inline button tap. Public proactive
cron/webhook notification turns deliberately keep the configured defaults. An
effort-only or configured-primary selection keeps normal chat session
continuity. A model different from the configured primary runs each turn as a
fresh isolated session so provider history from two models cannot be mixed;
resetting `/model default` restores the shared primary-model session.

This is code coverage, not a `telegram` JSON field. The app always supplies the
catalog. Programmatic `startTelegramAdapter` callers can opt in by passing
`runtimeControls` explicitly.

### Fresh conversation session (built in)

Use `/new` to cancel current work and start a fresh session for this Telegram
conversation. Mono-agent retires the chat's warm provider session, atomically
clears only its canonical conversation history, and clears the skill cache so
skills and startup context are rebuilt on the next message. Other chats, other
forum topics of the same chat, and durable memory are untouched. The chat's process-local `/model` and `/effort`
selection is retained.

This does not restart the agent process. The built-in app supplies the
host-owned reset callback; standalone adapter users can expose the same command
with `startNewSession`.

### Command menu

Register custom slash commands that appear beside the built-ins in Telegram's command menu (autocomplete) and run a configured prompt as a turn. Built-in `/start`, `/help`, `/cancel`, `/new`, `/model`, and `/effort` cannot be overridden.

```json
{
  "telegram": {
    "commands": [
      { "command": "brief", "description": "Compose my morning brief", "prompt": "Compose my morning brief." },
      { "command": "about", "description": "What this agent does" }
    ]
  }
}
```

Each entry needs a `command` (1–32 lowercase letters/digits/underscores) and a `description`. With a `prompt`, tapping the command runs it on that chat through the normal per-chat queue and current runtime selection; without a `prompt` it is a menu-only entry that echoes its description. The command list is registered via `setMyCommands` at startup (scoped to private chats). The app registers the built-in runtime commands even when no custom commands are configured.

### Status reactions

Set `telegram.reactions: true` to have the bot react to your message with a lifecycle emoji: **👀** while the agent works, **👍** on success, **👎** on failure (and the reaction is cleared when you `/cancel`). Telegram constrains bot reactions to a fixed emoji set, so these stand in for ✅/❌. Best-effort — a missing reaction permission never affects the run.

```json
{ "telegram": { "reactions": true } }
```

Each state can be toggled independently with an object — every key defaults to `true`, so you set the ones you *don't* want to `false`. For example, to keep the working and error reactions but drop the success 👍 (which can feel cluttered):

```json
{ "telegram": { "reactions": { "done": false } } }
```

When a terminal state's reaction is disabled, the working **👀** is **cleared** on completion rather than left lingering — so a turn that only reacts while working ends with a clean, reaction-free message. The `MONO_AGENT_TELEGRAM_REACTIONS` env var is a simple all-on/all-off override; granular per-state control is JSON-only.

### Quiet hours (silent notifications)

Deliver proactive notifications (cron/webhook `notify`) silently during a daily window, so an overnight result lands without a push sound. `start`/`end` are 24-hour `HH:MM` clock times in `timezone` (an IANA zone); an `end` earlier than `start` wraps midnight.

```json
{
  "telegram": {
    "quietHours": { "start": "22:00", "end": "07:00", "timezone": "Europe/Rome" }
  }
}
```

Only the push notification is suppressed (`disable_notification`); the message still arrives. Live replies to your messages are never silenced.

### Asking you questions (inline keyboards)

The channel-agnostic `AskUser` tool renders natively in Telegram. Under the
**allow-all** tool default it is available automatically; under a **specific**
`tools.allowedTools` list, add its exact name:

```json
{ "tools": { "allowedTools": ["AskUser"] } }
```

`AskUser` accepts one to five related questions. Every question has a short
header, prompt, and two or three proposed answers with descriptions; it may also
allow multiple selections. Telegram shows the optional long context or draft as
a separate message, then presents one question at a time. Tap a proposed answer,
tap **Other** and type below, or—for multi-select—toggle choices and tap **Done**.
The answer resumes the same in-flight model run. Slash commands remain commands,
and stale buttons never start a new turn. The chat allowlist remains the
destination boundary.

Once recorded, the same question message loses its buttons and summarizes
resolved selections with their original option labels. A single answer is shown
inline; multiple answers are listed by question header in recorded order.
Unknown question and option IDs are omitted. A custom-only entry in a
multi-answer summary appears as `custom answer`, never as the channel user's
text. A single custom-only or otherwise unresolved answer remains the generic
`Answer recorded.` confirmation.

For a non-blocking prompt whose later button tap should become a fresh user turn,
use `TelegramSendMessage.reply_options` with two to eight labels. Those buttons
are intentionally separate from `AskUser`: they do not pause or resume the
current model run.

A tap the adapter cannot match to any of its button protocols is acknowledged and
otherwise ignored — the spinner clears and no turn starts, which is
indistinguishable from a dead button. The adapter logs a warning naming the
unrecognized payload prefix when that happens. It normally means a keyboard
outlived the release that renamed its payload, or that something outside the
agent built the card with a retired protocol.

### Sending files

`TelegramSendFile` lets the agent send a generated file or image back to an allowed chat (available under the allow-all default; name it explicitly under a specific `tools.allowedTools`). A required `kind` selects `"document"` (any file, downloadable) or `"photo"` (an image shown inline). It accepts the bytes as base64 `data` (with a `filename`) **or** a workspace `path`, plus an optional `caption`; uploads are bounded by the adapter's attachment size cap.

When one bot serves multiple chats, bind all app-owned Telegram tools to the
request that produced the run and restrict path delivery to its output directory:

```json
{
  "telegram": {
    "sendTools": {
      "scope": "producing-conversation",
      "pathScope": "run-output"
    }
  }
}
```

This is opt-in. In strict mode `TelegramSendFile` has no model-facing `chat_id`:
the host derives the destination (chat and forum topic) from the Telegram
conversation that produced the run, rechecks it against the adapter allowlist,
and omits the raw chat id from the tool result. `TelegramSendMessage` posts into
the producing topic and rejects a different `message_thread_id`. Unexpected destination input cannot redirect the upload;
missing or non-Telegram request context fails closed. A file path must realpath
beneath the current run output directory; traversal, other-run paths, and
symlink escapes fail closed.

For example, a strict file call contains only the file operation and content:

```json
{ "kind": "document", "path": "artifacts/outbound/<run-id>/transcript.md" }
```

```json
{ "tools": { "allowedTools": ["TelegramSendFile"] } }
```

## Final-answer delivery and transient tool activity

Telegram does not stream answer tokens. While an inbound run is in flight the bot first shows a `typing…` chat action. If the agent starts a tool, the bot posts one temporary cumulative activity message with a short, redacted preview. Later tool starts edit that message and adjacent identical lines collapse as `(×N)`. Confirmed consumed live guidance uses the same preview boundary for its completed `↪️ Steered` line. Once the response is finalized, the bot posts it as a new message and then best-effort deletes the activity message; the progress bubble is never converted into the answer. Long paths are middle-truncated so the filename stays visible; long commands retain both their beginning and ending. Agent reasoning is never shown. A run with no tools or confirmed consumed guidance still sends only the final message, and proactive notifications never show the tool ledger.

An acknowledged `/cancel` best-effort deletes a still-transient activity message and leaves one `Cancelled.` acknowledgement. The adapter will not delete a message after final-answer delivery has been attempted.

This is built-in behaviour, not a JSON field. A custom channel driver can set `stream.showHints: false` for the previous answer-only behavior or `stream.finalOnly: false` (`createTelegramChannelDriver`) to restore live interim answer streaming — coverage **code**. See [Delivery and Send Tools](/channels/delivery-and-send-tools/) for the preview/redaction rules and streaming model across channels, and [Custom Channels](/programmatic/custom-channels/) to build a driver.

:::note
The OpenAI-compatible [`/v1/chat/completions` endpoint](/channels/openai-api/) still streams token-by-token; final-only applies to the chat adapters (Telegram and Slack).
:::

## Polling resilience (auto-recovery)

The long-poll runner self-heals across transient network failures — a network blip, a host sleep, or a wifi switch — so the bot no longer goes silent until a full process restart. This is on by default and mirrors the Slack [heartbeat watchdog](/channels/slack/).

**Fast failure detection.** The Bot API client HTTP timeout is capped at **50s** (down from grammY's 500s default) and the `getUpdates` long-poll is bounded at **30s**, so a half-open or stalled socket fails fast instead of hanging for minutes. The runner self-retries transient `getUpdates` errors (e.g. `ETIMEDOUT`, `EADDRNOTAVAIL`) with exponential backoff for up to **90 seconds** before giving up to the outer restart monitor.

**Auto-restart on crash.** On a genuine runner crash (e.g. `ENETUNREACH` after a network switch) an auto-restart monitor recreates the runner with exponential backoff — **500ms** doubling up to a **30s** cap. A runner that stays up for a 30s stability window resets the backoff. A clean, deliberate stop is never auto-restarted.

**Poll-liveness watchdog.** grammY's runner self-retries `getUpdates` internally, so a degraded connection can stop delivering updates *without the task ever rejecting* — the crash monitor can't see it. The `pollWatchdogMs` watchdog (default `120000`; `0` disables) stamps each `getUpdates` resolution and force-restarts a silently-deaf runner that stops delivering updates inside the window. The 120s window sits comfortably above the 30s long-poll, so a normal idle poll never trips it.

**Degraded, not dead.** When a poll crash happens, the channel is marked **`degraded`** (shown via the start log / `mono-agent status` as `degraded: <reason>`) rather than going mute — the responder and harness are kept alive, and the adapter restarts its own runner. Once the restarted runner survives the 30s stability window the channel returns to **`running`** automatically. This is non-fatal and distinct from `failed`. See [the channel status lifecycle](/channels/#opt-in-and-the-status-lifecycle).

**IPv4/IPv6 pin.** The original incident was a broken IPv6 route to `api.telegram.org` (`curl` succeeded on both families in ~50ms, but Node's long-poll `getUpdates` timed out over IPv6). Set `telegram.transport.ipFamily` to `4` or `6` (via `MONO_AGENT_TELEGRAM_IP_FAMILY`) to pin the Bot API HTTP client to a single family; omit it for dual-stack. The family-pinned client uses non-keep-alive sockets so a network switch can't strand a pooled socket bound to the dead interface.

**Bounded startup.** `start()` clears any leftover webhook (`deleteWebhook`) on a best-effort 5s `AbortSignal.timeout`, so a flaky network no longer hangs startup past the launcher's readiness deadline (the cause of a `mono-agent restart` "did not report ready" failure).

## Attachments

Inbound Telegram media (photos, documents, voice, video) is fetched via the Bot API and inlined into `request.attachments`, so the agent receives the bytes alongside the text. A multi-photo/video album arrives as several messages sharing a media group and is aggregated into one request. A download that fails is skipped without failing the run.

Download tuning — byte cap and timeout — is configurable via `telegram.attachments.{maxBytes,downloadTimeoutMs}` (defaults: 20 MiB / 30 s); the MIME allowlist remains **code-only** (`DownloadTelegramAttachmentsOptions`). See [Custom Channels](/programmatic/custom-channels/).

Programmatic callers should prefer the shared
`DEFAULT_AGENT_ATTACHMENT_MAX_BYTES` and
`DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST` exports. The shorter
`DEFAULT_ATTACHMENT_MAX_BYTES` and `DEFAULT_ATTACHMENT_MIME_ALLOWLIST` names are
Telegram compatibility aliases with identical values.

## Transcription

Telegram can automatically transcribe inbound voice notes, audio files, and round-video `video_note`s through an OpenAI-compatible `POST /v1/audio/transcriptions` endpoint. The transcript is added to the attachment text the model sees on the current turn; the downloaded audio remains saved. If transcription fails or times out, the run continues with a one-line unavailable note pointing to the saved file.

Transcription is opt-in. Set the full HTTP(S) transcriptions-route URL and a model name; with no `endpoint`, no transcription calls are made. The built-in transcriber has no credential field and sends no `Authorization` header, so the endpoint must accept unauthenticated requests (typically from a local server).

```json
{
  "telegram": {
    "transcription": {
      "endpoint": "http://localhost:50060/v1/audio/transcriptions",
      "model": "large-v3",
      "language": "en",
      "timeoutMs": 120000
    }
  }
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `telegram.transcription.endpoint` | — (off) | Full OpenAI-compatible transcriptions-route URL. Must use HTTP or HTTPS. |
| `telegram.transcription.model` | — | Required when `endpoint` is set; sent as the multipart `model` field. |
| `telegram.transcription.language` | — | Optional ISO-639 language hint sent as the multipart `language` field. |
| `telegram.transcription.timeoutMs` | `120000` | Per-call timeout in milliseconds (`1`–`3600000`), independent of `attachments.downloadTimeoutMs`. |

The transcript is available to the current turn only. Durable history preserves the attachment as a file reference, not the transcript, after provider context is lost. Each field also has a `MONO_AGENT_TELEGRAM_TRANSCRIPTION_*` override in the [environment-variable reference](/config/env-vars/).

## Self-hosted Bot API server (large files)

The hosted `api.telegram.org` caps bot downloads at 20 MB. Telegram's official self-hosted server ([tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api)) lifts that to 2 GB. Point the adapter at it:

```json
{
  "telegram": {
    "apiRoot": "http://127.0.0.1:8081",
    "attachments": { "maxBytes": 268435456, "maxUploadBytes": 268435456 }
  }
}
```

`apiRoot` is applied to every Bot API call, to file downloads, and to the app send tools (`TelegramSendMessage`/`TelegramSendFile`).

How it behaves with a `--local` server:

- `getFile` downloads the file into the daemon's `--dir` and returns an **absolute local path**; the adapter detects that shape and reads the bytes from disk (stat-checked against `attachments.maxBytes`), then deletes the daemon's copy — the harness has already persisted its own copy into the attachments dir. A missing file (the daemon expires downloads after ~1–25 h) is a clean skip, never a failed run. A non-`--local` self-hosted server (relative paths) is fetched from `<apiRoot>/file/bot<token>/…` instead.
- `TelegramSendFile` (`kind:"document"`) with a `path` input uploads by **`file://` URI** — the daemon reads the file from disk itself, so there is no size buffering in the agent process (the configured `maxUploadBytes` is enforced via stat). If the server rejects the URI, the tool falls back once to a buffered upload. The presented filename is the path's basename.
- **Memory ceiling for inbound files**: attachment bytes still travel as base64 through the request, so keep `attachments.maxBytes` at or below ~256 MiB (peak transient memory is roughly 3.4× the file size; V8's max string length caps the mechanism near 384 MiB decoded).

Operational notes for the daemon: it binds `0.0.0.0` **by default** — always pass `--http-ip-address=127.0.0.1` (it has no TLS/auth beyond the bot token in the path); it needs `api_id`/`api_hash` from [my.telegram.org](https://my.telegram.org); a bot must `logOut` of the hosted API before its first local login, and cannot log back into the hosted API for **10 minutes** after; long polling works unchanged, so no webhook or inbound exposure is needed.

## Sending without a prompt

When the Telegram adapter is enabled the agent can send Telegram messages on its own initiative through the `TelegramSendMessage` app tool. Under the **allow-all** tool default it is available automatically; under a **specific** `tools.allowedTools` add the exact tool name (and `disallowedTools` removes it):

```json
{
  "tools": {
    "allowedTools": ["TelegramSendMessage"]
  }
}
```

The existing `telegram.*` adapter config (token + chat allowlist) remains the destination boundary — the tool can only send where the adapter is already permitted. Pass `message_thread_id`, or `topic_name` with the [topic directory](#topic-directory-address-topics-by-name) on, to post into a forum topic; omit both for the chat's main conversation (a forum's General topic). This powers proactive/async delivery; see [Delivery and Send Tools](/channels/delivery-and-send-tools/) and [Tool Policy](/tools/policy/).

## Related

- [Channels overview](/channels/)
- [Delivery and Send Tools](/channels/delivery-and-send-tools/)
- [Slack](/channels/slack/) · [WhatsApp](/channels/whatsapp/)
- [Sessions and Concurrency](/runtime/sessions-concurrency/) — per-conversation admission and download bounds
- [Telegram personal assistant playbook](/playbooks/telegram-personal-assistant-bujo/)
