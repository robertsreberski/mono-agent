# @worklab-ai/whatsapp-bridge

WhatsApp communication bridge for Mono Agent packages. It mirrors the shape of `@worklab-ai/telegram-bridge` where WhatsApp allows it, while keeping Baileys-specific auth, event, and group-trigger behavior explicit.

## Scope

- Text-only v0 bridge: `conversation` and `extendedTextMessage.text` messages.
- Uses [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp Web / Linked Devices connectivity.
- Direct chats trigger on any allowed non-empty text.
- Group chats default to mention-required mode. Any-text group mode is an explicit opt-in.
- One active agent run per WhatsApp chat JID, with `/cancel` cancellation.
- Fails closed: configure `allowedChatJids` or set `allowAllChats: true` intentionally.

This package does **not** implement media download, voice notes, image understanding, stickers, WhatsApp Business Cloud API, final-demo/config integration, or live deployment helpers.

## Safety and credentials

Baileys is an unofficial WhatsApp Web / Linked Devices library. Use it responsibly, avoid spam/automation that violates WhatsApp terms, and prefer user-initiated conversations.

The Baileys auth directory contains linked-device credential material. Keep it outside git, back it up carefully if needed, and do not log or commit its files. QR strings are sensitive login material: this package only passes QR values to an explicit `onQr` callback and does not print them by default.

## Minimal setup

```ts
import {
  WhatsAppBridge,
  WhatsAppEventRunner,
  createBaileysWhatsAppSocket,
  createRuntimeResponder,
} from "@worklab-ai/whatsapp-bridge";

const { socket, saveCreds } = await createBaileysWhatsAppSocket({
  authDir: ".worklab-tmp/whatsapp-auth",
});

const responder = createRuntimeResponder({
  runtime,
  systemPrompt: "You are a concise assistant.",
  model: { sdk: "openai-codex", model: "gpt-5.5", provider: "openai-codex" },
  executionMode: "cli",
  effort: "high",
  cwd: process.cwd(),
});

const bridge = new WhatsAppBridge({
  socket,
  responder,
  allowedChatJids: ["1234567890@s.whatsapp.net"],
});

const runner = new WhatsAppEventRunner({
  socket,
  bridge,
  saveCreds,
  onQr: (qr) => {
    // Host-owned display, e.g. render as QR in a local admin surface.
    // Treat `qr` as sensitive login material.
  },
});

runner.start();
```

## Direct chats

Direct one-to-one chats always trigger after allowlist checks:

```ts
new WhatsAppBridge({
  socket,
  responder,
  allowedChatJids: ["1234567890@s.whatsapp.net"],
});
```

Agent requests use conversation IDs like `whatsapp:1234567890@s.whatsapp.net` and include bounded WhatsApp metadata under `request.metadata.whatsapp`.

## Group chats: mention required by default

Group chats default to `groupMode: "mention"`. Configure the bot JIDs that Baileys reports in `contextInfo.mentionedJid`. WhatsApp/Baileys v7 may expose both phone-number and LID identifiers, so include both when available.

```ts
new WhatsAppBridge({
  socket,
  responder,
  allowedChatJids: ["1234567890-123456@g.us"],
  trigger: {
    groupMode: "mention",
    botJids: [
      "15551234567@s.whatsapp.net",
      "123456789@lid",
    ],
    mentionTextAliases: ["@mybot"],
  },
});
```

When `mentionTextAliases` are configured, matching alias text is stripped before the agent sees the prompt. Unmentioned group messages return `mention_required` and do not call the responder.

## Group chats: explicit any-text mode

For groups where any allowed group message should trigger the agent, opt in explicitly:

```ts
new WhatsAppBridge({
  socket,
  responder,
  allowedChatJids: ["1234567890-123456@g.us"],
  trigger: { groupMode: "any" },
});
```

Allowlisting is still required unless `allowAllChats: true` is deliberately set.

## Commands and busy handling

Supported commands are text-only and follow the same group trigger rules as normal prompts:

- `/start` — sends the welcome text.
- `/help` — sends help text.
- `/cancel` — aborts the active run for the chat and sends a cancellation message.

While a run is active for a chat, additional prompts receive a busy message. Messages from the socket account (`fromMe`) are ignored to avoid response loops.

## Streaming behavior

WhatsApp does not have Telegram-style safe edit semantics in this package. `WhatsAppMessageStream` buffers assistant deltas and sends the final response when `finish()` is called. It may send one initial status message (`Thinking…` by default), then sends final text in bounded chunks.

```ts
new WhatsAppBridge({
  socket,
  responder,
  allowedChatJids: ["1234567890@s.whatsapp.net"],
  stream: {
    sendInitialStatus: true,
    initialStatusText: "Thinking…",
    maxMessageChars: 3800,
  },
});
```

## Event runner

`WhatsAppEventRunner` attaches to Baileys-style socket events:

- `messages.upsert` — processes only `type: "notify"` by default.
- `creds.update` — calls the supplied `saveCreds` callback without reading or logging credentials.
- `connection.update` — reports sanitized connection state and passes QR strings only to `onQr` when configured.

```ts
const runner = new WhatsAppEventRunner({
  socket,
  bridge,
  saveCreds,
  onMessageResult: (result) => console.log(result.kind),
  onConnectionUpdate: (update) => console.log(update.connection, update.hasQr),
});

runner.start({ signal });
```

## Tests and verification

Unit tests use fakes for sockets, event emitters, runtime responders, and runtime calls. Automated tests do not require live WhatsApp access or credential files.

Recommended checks from the repository root:

```bash
pnpm --filter @worklab-ai/whatsapp-bridge run build
pnpm --filter @worklab-ai/whatsapp-bridge run typecheck
pnpm --filter @worklab-ai/whatsapp-bridge run test
pnpm run build
pnpm run typecheck
pnpm test
git diff --check
```

If you perform an optional live smoke, use an ignored auth directory such as `.worklab-tmp/whatsapp-auth` and never commit auth files, QR strings, phone numbers, or chat contents.
