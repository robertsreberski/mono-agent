# @mono-agent/telegram-adapter

## Category

Category: `communication`

## Responsibility

Telegram communication adapter for agent hosts. It provides a Bot API client, long poller, update handler, streamed message edits, cancellation, allowlist enforcement, and Telegram-owned settings helpers.

The adapter is opt-in: `telegram.enabled` / `MONO_AGENT_TELEGRAM_ENABLED` defaults to `false`. While disabled the loader skips credential validation and the channel reports `disabled` rather than `waiting_for_config`. Set `enabled: true` to turn it on; a missing bot token or allowlist then surfaces as a real `waiting_for_config` reason.

Inbound Telegram document, photo, audio, video, round video (video note), and voice messages are downloaded (subject to the MIME allowlist and ~20 MB cap) and delivered to the responder as transport-agnostic `AgentAttachment` bytes on the shared `AgentRequestBase.attachments` contract (decoded `mimeType` + base64 `data` + `name`). Captions remain the request text; media-only messages still get a concise text summary so existing text-only responder paths can reason about what arrived. The original Telegram file metadata (file id, sizes, kind) is preserved under `metadata.telegram.attachments`.

### Voice transcription (optional)

Set `telegram.transcription` to auto-transcribe inbound audio (voice / audio / video note) so a caption-less clip reaches the model as words, not just an on-disk file path. The transcript is inlined into the attachment's `text` field; the audio file is still saved, so if transcription fails the `text` falls back to a note pointing at the saved file (the run never fails on a transcription error).

| Field | Env | Required | Description |
| --- | --- | --- | --- |
| `telegram.transcription.endpoint` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_ENDPOINT` | when transcription is used | Full URL of an OpenAI-compatible `POST /v1/audio/transcriptions` route (e.g. a local WhisperKit server: `http://localhost:50060/v1/audio/transcriptions`). Must be http(s); not a secret. |
| `telegram.transcription.model` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_MODEL` | when `endpoint` is set | Model name sent as the multipart `model` part (e.g. `large-v3`). A missing model when the endpoint is set is a hard config error. |
| `telegram.transcription.language` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_LANGUAGE` | no | Optional ISO-639 language hint. |
| `telegram.transcription.timeoutMs` | `MONO_AGENT_TELEGRAM_TRANSCRIPTION_TIMEOUT_MS` | no | Per-call bound in ms (default 120000). Independent of `attachments.downloadTimeoutMs` — transcription latency scales with audio duration, not file size. A note longer than the local server can transcribe within this bound falls back to the saved-file note. |

The request is `multipart/form-data` with parts `file`, `model`, and optional `language`, using only native `fetch`/`FormData`/`Blob` (no added dependencies).

Known limitation: the transcript is inlined into the **current turn's** prompt only. Durable history persists the attachment as a file reference without the transcript, so a resumed session that has lost its provider context will not see the words again (the live provider session retains them).

Downloads are gated by the configured allowlist and size cap, and a download failure skips the attachment without failing the run. Whether the model actually consumes the images/documents depends on the host runtime's vision/document support — the adapter forwards bytes but does not itself guarantee model-level understanding.

## Install / Usage

```bash
pnpm --filter @mono-agent/telegram-adapter run build
```

```ts
import {
  createTelegramBot,
  createGrammyTelegramApi,
  loadTelegramAdapterConfig,
  startTelegramAdapter,
  TELEGRAM_CONFIG_FIELDS,
} from "@mono-agent/telegram-adapter";
```

Load adapter settings separately from core config, then pass a structural `AgentResponder` from the host or harness. The base responder, stream, response, and cancellation contracts come from `@mono-agent/agent-contracts`.

## Final answer and transient tool activity

Inbound turns do not stream answer tokens by default. Telegram first shows the
`typing…` action; if tools run, one cumulative, secret-safe activity message is
edited in place. Once the response is ready, Telegram posts it as a new message
and deletes the activity message. Adjacent duplicates collapse as `(×N)`.
Proactive deliveries suppress this message, and an
acknowledged `/cancel` best-effort deletes it while retaining one `Cancelled.`
acknowledgement. Programmatic drivers can set `stream.showHints: false` to keep
only the ordinary working indicator or `stream.finalOnly: false` for live answer
edits.

`ReadSkill` renders the selected skill as `📚 Reading "<skill>"` without exposing
its path. Memory recall remains preview-free as `🧠 Recalling memory`. Memory
writes remain `🧠 Updating memory`, and ordinary file reads remain `📖 Reading`.
Long file paths keep both their leading location and trailing filename; long
commands keep a balanced prefix and suffix. Every preview remains capped at 40
Unicode code points after secret redaction.

## Per-chat runtime controls

The mono-agent app supplies a display-ready `runtimeControls` catalog to the
adapter, which adds built-in `/model` and `/effort` menus. Direct programmatic
callers can opt into the same behavior through `createTelegramBot` or
`startTelegramAdapter`.

Only the host-supplied configured primary and fallback models are selectable;
the adapter performs no model discovery and accepts no arbitrary model
references. A choice is held in memory per chat until `/model default`,
`/effort default`, or process restart. Changing model clears an explicit effort
only when the new model does not support it. Interactive messages, configured
command prompts, and synthetic button-answer turns carry the selection under
`metadata.telegram`; public proactive `notify` calls intentionally retain the
configured runtime defaults.

The inline menus include **Cancel**, which deletes the menu without changing the
selection. Choosing a model or effort edits that menu into its confirmation
instead of posting another message.

When the host supplies `startNewSession`, `/new` cancels current work and starts
a fresh session for only that Telegram conversation. In the mono-agent app this
retires the warm provider session, clears that conversation's canonical history,
and reloads skills/startup context on the next message; durable memory and the
chat's model/effort selection remain intact.

When a structured `AskUser` interaction is pending, Telegram renders each
question with native option buttons plus **Other**; multi-select questions add a
**Done** button. The next authorized plain-text message is accepted as a custom
answer to that same tool call, while slash commands remain commands. Separately,
non-blocking `TelegramSendMessage.reply_options` buttons start a new user turn
when tapped.

## Public API

<!-- public-api-inventory:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

Every symbol exported by each public code entrypoint is listed below.

**`@mono-agent/telegram-adapter`**

```text
AgentMessageStream
AgentRequest
AgentResponder
AgentResponse
CreateTelegramBotOptions
DEFAULT_AGENT_ATTACHMENT_MAX_BYTES
DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST
DEFAULT_ATTACHMENT_MAX_BYTES
DEFAULT_ATTACHMENT_MIME_ALLOWLIST
DownloadTelegramAttachmentsOptions
LoadTelegramAdapterConfigInput
RedactedTelegramAdapterConfig
TELEGRAM_CONFIG_FIELDS
TELEGRAM_REPLY_CALLBACK_PREFIX
TELEGRAM_REPLY_MAX_OPTIONS
TELEGRAM_TRANSCRIPTION_UNAVAILABLE_NOTE
TelegramAdapterConfig
TelegramAdapterConfigError
TelegramAdapterConfigErrorCode
TelegramAdapterConfigErrorDetails
TelegramAdapterErrorText
TelegramAdapterErrorTextInput
TelegramAdapterLogger
TelegramAdapterMessages
TelegramAdapterStartOptions
TelegramAdapterStartResult
TelegramAdapterStreamOptions
TelegramAgentMessageInput
TelegramApiError
TelegramApiErrorDetails
TelegramApiErrorKind
TelegramAskUserAction
TelegramAskUserCallback
TelegramAttachment
TelegramAttachmentBase
TelegramAttachmentKind
TelegramAttachmentsConfig
TelegramAudio
TelegramAudioAttachment
TelegramBotApi
TelegramBotController
TelegramChat
TelegramChatId
TelegramCommandConfig
TelegramDeleteMessageParams
TelegramDeleteWebhookParams
TelegramDeliveryError
TelegramDocument
TelegramDocumentAttachment
TelegramEditMessageTextParams
TelegramFileDownloader
TelegramFileReference
TelegramGetUpdatesParams
TelegramMessage
TelegramMessageSender
TelegramMessageStream
TelegramMessageStreamLogger
TelegramMessageStreamOptions
TelegramPhotoAttachment
TelegramPhotoAttachmentSize
TelegramPhotoSize
TelegramQuietHours
TelegramReactionsConfig
TelegramRequestMetadata
TelegramRequestOptions
TelegramRuntimeControls
TelegramRuntimeEffortOption
TelegramRuntimeModelOption
TelegramSendDocumentParams
TelegramSendMessageParams
TelegramSendOutcome
TelegramSendPhotoParams
TelegramSendToolsConfig
TelegramSentMessage
TelegramTranscriber
TelegramTranscriptionConfig
TelegramUpdate
TelegramUser
TelegramVideo
TelegramVideoAttachment
TelegramVideoNote
TelegramVideoNoteAttachment
TelegramVoice
TelegramVoiceAttachment
agentAttachmentKindFromMimeType
classifyTelegramError
createGrammyTelegramApi
createOpenAiTranscriber
createTelegramBot
createTelegramMessageSender
decodeAgentAttachmentText
downloadTelegramAttachments
isTelegramReplyCallbackData
isWithinQuietHours
loadTelegramAdapterConfig
parseTelegramAskUserCallbackData
redactTelegramAdapterConfig
renderTelegramMarkdown
startTelegramAdapter
telegramAskUserCallbackData
telegramReplyCallbackData
```

<!-- public-api-inventory:end -->

## Dependency Boundary

This adapter depends only on shared `@mono-agent/agent-contracts` primitives inside the workspace. It does not depend on the harness, core config, memory, runtime package, or other adapters. Hosts compose those pieces outside the adapter.

## What This Package Does Not Own

It does not build prompts, run models, store memory, serve UI, manage provider credentials, or decide core runtime settings.

## Verification

```bash
pnpm --filter @mono-agent/telegram-adapter run build
pnpm --filter @mono-agent/telegram-adapter run typecheck
pnpm --filter @mono-agent/telegram-adapter run test
```
