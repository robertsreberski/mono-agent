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
  telegramFieldGroup,
} from "@mono-agent/telegram-adapter";
```

Load adapter settings separately from core config, then pass a structural `AgentResponder` from the host or harness. The base responder, stream, response, and cancellation contracts come from `@mono-agent/agent-contracts`.

## Public API

- `createTelegramBot`, `startTelegramAdapter`
- `createGrammyTelegramApi`, `TelegramApiError`
- `TelegramMessageStream`, `classifyTelegramError`
- `loadTelegramAdapterConfig`, `redactTelegramAdapterConfig`, `telegramFieldGroup`
- `downloadTelegramAttachments` (+ `DownloadTelegramAttachmentsOptions`, `TelegramFileDownloader`): the inbound-bytes flow that maps `TelegramAttachment` metadata to `AgentAttachment` bytes on `request.attachments`
- `TelegramAttachment` and related Telegram-owned inbound attachment metadata types (preserved under `metadata.telegram.attachments`)
- Telegram Bot API, request/response, and config types

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
