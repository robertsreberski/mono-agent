# @worklab-ai/telegram-bridge

Telegram communication bridge for Worklab-style agent runtimes. The package is a small library, not a hosted bot service: hosts provide a Telegram bot token, an explicit chat allowlist, and an `AgentResponder` or `@worklab-ai/agent-runtime` runtime instance.

## Safety defaults

The bridge fails closed. You must configure either:

- `allowedChatIds: [...]` for an explicit allowlist, or
- `allowAllChats: true` when you intentionally want any Telegram chat to use the bot.

Do not commit bot tokens, chat transcripts, `.env` files, provider API keys, or runtime OAuth credentials.

## Install and environment

This repository package is built from the pnpm workspace:

```bash
corepack enable
pnpm install
pnpm --filter @worklab-ai/telegram-bridge run build
```

A host app commonly reads these environment variables without committing them:

```bash
TELEGRAM_BOT_TOKEN=123456:bot-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

## Basic bridge

```ts
import {
  TelegramBotApiClient,
  TelegramBridge,
  TelegramLongPoller,
  type AgentResponder,
} from "@worklab-ai/telegram-bridge";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const responder: AgentResponder = {
  async respond(request, stream) {
    await stream.append(`Echo: ${request.text}`);
    return { text: `Echo: ${request.text}` };
  },
};

const api = new TelegramBotApiClient({ token });
const bridge = new TelegramBridge({ api, responder, allowedChatIds });
const poller = new TelegramLongPoller({ api, bridge, deleteWebhookOnStart: true });

await poller.start({ signal: AbortSignal.timeout(60_000) });
```

## Runtime integration

`createRuntimeResponder()` adapts an `@worklab-ai/agent-runtime`-compatible object. Pass a parsed model reference object, not a raw model string.

```ts
import { createRuntime, parseRuntimeModelReference } from "@worklab-ai/agent-runtime";
import {
  createRuntimeResponder,
  TelegramBotApiClient,
  TelegramBridge,
} from "@worklab-ai/telegram-bridge";

const runtime = createRuntime({
  workspace: process.cwd(),
});

const responder = createRuntimeResponder({
  runtime,
  systemPrompt: "You are a concise Telegram assistant.",
  model: parseRuntimeModelReference("pi:openai-codex:gpt-5.5"),
  executionMode: "sdk",
  cwd: process.cwd(),
  maxTurns: 6,
});

const api = new TelegramBotApiClient({ token: process.env.TELEGRAM_BOT_TOKEN! });
const bridge = new TelegramBridge({
  api,
  responder,
  allowedChatIds: [123456789],
});
```

The adapter maps each Telegram text message to:

```ts
messages: [{ role: "user", content: request.text }]
```

Use `buildMessages(request)` when your host has conversation history or memory. Runtime `cancelled`, `error`, and `failureKind` results are propagated honestly; the bridge sends its configured cancelled/error text instead of reporting fake success.

## Webhook handler sketch

`TelegramBridge.handleUpdate(update)` is webhook-compatible and returns a structured handling result for host logging.

```ts
app.post("/telegram/webhook", async (req, res) => {
  const result = await bridge.handleUpdate(req.body);
  res.status(200).json(result);
});
```

## Long polling for local development

Long polling is optional. It is useful for local development or small hosts that do not want to expose a webhook yet.

```ts
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

const poller = new TelegramLongPoller({
  api,
  bridge,
  deleteWebhookOnStart: true,
  dropPendingUpdates: false,
  allowedUpdates: ["message"],
  onError(error) {
    console.error("Telegram polling failed", error);
  },
});

await poller.start({ signal: controller.signal });
```

The poller calls `getUpdates` sequentially and advances the Telegram offset only after `bridge.handleUpdate(update)` resolves. Transient polling failures trigger a bounded backoff and the `onError` hook.

## Streaming behavior

Telegram does not support true token streaming. `TelegramMessageStream` emulates streaming by sending an initial status message and editing that message as assistant text arrives.

Defaults:

- initial status: `Thinking…`
- edit debounce: 750ms
- max message chunk: 3,800 characters (below Telegram's 4,096 limit)
- parse mode: none, to avoid Markdown/entity failures

During generation, long text is shown as a bounded preview. On `finish()`, the full final text is split into multiple Telegram messages when needed.

## Public pieces

- `TelegramBotApiClient` — thin Bot API client for `sendMessage`, `editMessageText`, `getUpdates`, and `deleteWebhook`.
- `TelegramBridge` — update handler with allowlist checks, `/start`, `/help`, `/cancel`, busy handling, and one active run per chat.
- `TelegramMessageStream` — edit-based streaming sink.
- `createRuntimeResponder()` — adapter for `@worklab-ai/agent-runtime`-compatible runtimes.
- `TelegramLongPoller` — optional sequential `getUpdates` loop for dev/local hosts.
