---
title: "Custom channel drivers"
sidebar:
  order: 5
---

This page covers writing your own channel driver and registering it with `startMonoAgentApp`, plus overriding the stream and message-text behaviour of the built-in channels (welcome/help/error text, edit debounce, max chars, interim streaming). Custom drivers are a **code-only** capability — there is no `mono-agent.config.json` key that adds a transport, so this lives in your host program. For config-driven channels see [Channels overview](/channels/).

## When you need a driver

The built-in drivers (Telegram, Slack, WhatsApp, A2A, Webhook, OpenAI-compatible API, Cron) cover every channel the `mono-agent` CLI runs from config. Write a custom `ChannelDriver` only when you need a transport that ships nothing — for example an in-house message bus, an SMS gateway, an email poller, or a test harness. A driver is thin: it reuses an adapter's config loader plus its `start` function and adds the wiring the app host would otherwise copy by hand.

All of the types below are exported from `@mono-agent/agent-app`.

## The ChannelDriver interface

```ts
import type {
  ChannelDriver,
  ChannelStartInput,
  RunningChannel,
  MonoAgentAppConfigInput,
} from "@mono-agent/agent-app";

interface ChannelDriver<TConfig = unknown> {
  readonly id: ChannelId;     // "telegram" | "slack" | "a2a" | "webhook" | "openai-api" | "cron" | "whatsapp"
  readonly label: string;     // human label for status output
  loadConfig(input: MonoAgentAppConfigInput): Promise<TConfig>;
  isConfigError(error: unknown): boolean;
  disabledReason?(config: TConfig): string | undefined;
  waitingReason?(config: TConfig): string | undefined;
  start(input: ChannelStartInput<TConfig>): Promise<RunningChannel>;
}
```

| Member | Contract |
|---|---|
| `id` | Identifies the channel in `channelStatus(id)` / `channelStatuses()`. The `ChannelId` union is fixed; reuse the closest id, or use a built-in id you are not otherwise running. |
| `label` | Display name shown in status / doctor output. |
| `loadConfig` | Receives `{ env, cwd, configPath }`. Read your section out of `mono-agent.config.json` (and env). Throw your own typed config error when the config is malformed. |
| `isConfigError` | Return `true` for your loader's own typed errors. The app treats those as `waiting_for_config` (incomplete) rather than a crash. |
| `disabledReason` | Return a string when the loaded config explicitly disables the channel (e.g. `enabled: false`) → status `disabled`. Return `undefined` to proceed. |
| `waitingReason` | Return a string when the config is enabled but still missing a required sub-section → status `waiting_for_config`. |
| `start` | Boot the transport and return a `RunningChannel`. |

`MonoAgentAppConfigInput` is exactly:

```ts
interface MonoAgentAppConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}
```

### ChannelStartInput and RunningChannel

`start` receives everything the transport needs, including the shared `AgentResponder` the app built from your runtime config:

```ts
interface ChannelStartInput<TConfig> {
  readonly config: TConfig;          // what loadConfig returned
  readonly coreConfig: MonoAgentConfig;
  readonly responder: AgentResponder; // run the agent through this
  readonly cwd: string;
  readonly logger?: MonoAgentAppLogger;
  readonly onFailure: (reason: string) => void; // report a post-start death
}

interface RunningChannel {
  readonly summary: Record<string, unknown>; // connection facts (URL, job count, ...)
  stop(): Promise<void>;
  dispose?(): Promise<void>;                  // set by the app, not the driver
}
```

`onFailure` is for transports that die **after** a successful `start` — a polling loop that throws, a socket that closes. Calling it flips the channel from `running` to `failed`; otherwise a dead poller would still report as running. The built-in Telegram driver wires its `onPollingError` straight into `onFailure`.

:::note
Do not set `dispose` yourself — the app attaches responder/harness teardown so warm provider sessions are retired on stop/reload. Your job is to stop the transport in `stop()`.
:::

### Minimal example

```ts
import {
  startMonoAgentApp,
  defaultChannelDrivers,
  type ChannelDriver,
} from "@mono-agent/agent-app";

class SmsConfigError extends Error {}

const smsDriver: ChannelDriver<{ enabled: boolean; gatewayUrl?: string }> = {
  id: "webhook", // reuse an id you are not otherwise running
  label: "SMS gateway",
  async loadConfig({ env }) {
    return {
      enabled: env.MONO_AGENT_SMS_ENABLED === "true",
      gatewayUrl: env.MONO_AGENT_SMS_GATEWAY_URL,
    };
  },
  isConfigError(error) {
    return error instanceof SmsConfigError;
  },
  disabledReason(config) {
    return config.enabled ? undefined : "SMS is disabled.";
  },
  waitingReason(config) {
    return config.gatewayUrl ? undefined : "SMS requires a gateway URL.";
  },
  async start(input) {
    if (!input.config.gatewayUrl) {
      throw new SmsConfigError("SMS requires a gateway URL.");
    }
    const poller = startSmsPoller({
      gatewayUrl: input.config.gatewayUrl,
      onInbound: async (msg) => {
        const result = await input.responder.respond({
          conversationId: msg.from,
          text: msg.body,
        });
        await sendSms(msg.from, result.text);
      },
      onError: (err) => input.onFailure(err.message),
    });
    return {
      summary: { gatewayUrl: input.config.gatewayUrl },
      stop: async () => poller.stop(),
    };
  },
};

await startMonoAgentApp({
  drivers: [...defaultChannelDrivers(), smsDriver],
});
```

`defaultChannelDrivers()` returns every built-in driver in startup/status order. Spread it and append yours; pass an empty-spread-plus-yours array to run **only** your driver. See [Composition](/programmatic/composition/) for assembling the responder/runtime that backs every channel.

## Overriding built-in stream and message text

You usually do not need a new driver to change behaviour — `defaultChannelDrivers(overrides)` and the per-channel factories (`createTelegramChannelDriver`, `createSlackChannelDriver`, …) accept transport overrides. These are the seams for swapping the bot/socket factory in tests. The stream and message-text knobs (welcome/help/error text, edit debounce, max chars, interim streaming) are baked into the built-in Telegram driver's start options; to change them, construct the underlying adapter yourself inside a thin custom driver and pass `stream` / `messages`.

The Telegram adapter's stream and message options:

| Option | Type | Default (app) | Effect |
|---|---|---|---|
| `stream.initialStatusText` | `string` | `"Agent is thinking..."` | Placeholder shown before the first token. |
| `stream.editDebounceMs` | `number` | `350` | Min gap between message edits while streaming. |
| `stream.maxMessageChars` | `number` | platform cap | Split threshold; must be an integer ≥ 32. |
| `stream.showThoughts` | `boolean` | `true` | Stream reasoning/thoughts as interim text. |
| `stream.finalOnly` | `boolean` | `true` (bot) | `true` posts one final answer; **set `false` for live interim streaming** (edit-in-place as tokens arrive). |
| `messages.welcomeText` | `string` | "Agent is online…" | Shown on `/start`. |
| `messages.helpText` | `string` | "Send a message…" | Shown on `/help`. |
| `messages.unauthorizedText` | `string` | "This chat is not allowlisted…" | Sent to non-allowlisted chats. |
| `messages.errorText` | `string` or `(input) => string` | derived from the failure | Text on a failed run. A function receives the failure (kind/message/details) so you can special-case `usage_limit`, `cancelled`, etc. |

```ts
import {
  startMonoAgentApp,
  defaultChannelDrivers,
  type ChannelDriver,
} from "@mono-agent/agent-app";
import {
  loadTelegramAdapterConfig,
  startTelegramAdapter,
  TelegramAdapterConfigError,
  type TelegramAdapterConfig,
} from "@mono-agent/telegram-adapter";

const liveTelegram: ChannelDriver<TelegramAdapterConfig> = {
  id: "telegram",
  label: "Telegram",
  async loadConfig({ env, configPath }) {
    return loadTelegramAdapterConfig({ env, jsonPath: configPath });
  },
  isConfigError(error) {
    return error instanceof TelegramAdapterConfigError;
  },
  disabledReason(config) {
    return config.enabled ? undefined : "Telegram is disabled.";
  },
  async start(input) {
    const result = await startTelegramAdapter({
      botToken: input.config.botToken,
      allowedChatIds: [...input.config.allowedChatIds],
      allowAllChats: input.config.allowAllChats,
      responder: input.responder,
      stream: {
        finalOnly: false,        // live interim streaming
        editDebounceMs: 500,     // throttle edits harder
        showThoughts: false,     // hide reasoning, stream the answer only
      },
      messages: {
        welcomeText: "Hi! Ask me anything.",
        helpText: "Just type. /cancel stops an in-flight reply.",
        errorText: ({ error }) =>
          `Sorry, that failed: ${error instanceof Error ? error.message : "unknown error"}`,
      },
      onPollingError: (error) =>
        input.onFailure(error instanceof Error ? error.message : String(error)),
      ...(input.logger ? { logger: input.logger } : {}),
    });
    return { summary: {}, stop: () => result.stop() };
  },
};

// Run the built-ins except the default Telegram driver, plus the live one.
const builtins = defaultChannelDrivers().filter((d) => d.id !== "telegram");
await startMonoAgentApp({ drivers: [...builtins, liveTelegram] });
```

Slack and WhatsApp expose their own message-stream modules with the same shape (`editDebounceMs`, `maxMessageChars`, `finalOnly`); build them the same way against `startSlackAdapter` / `startWhatsAppAdapter`.

:::caution
`finalOnly: false` produces many edit calls per response. Keep `editDebounceMs` at a few hundred ms or higher to stay under the transport's rate limits — the app default of 350 ms is a safe floor for Telegram.
:::

## Sending and delivery from inside a driver

Your driver talks to the agent through `input.responder`. For replying back into the channel, follow the same delivery contract the built-in channels use — including proactive/out-of-turn sends via the adapter send tools (`slack_send_message` / `telegram_send_message`). See [Delivery and send tools](/channels/delivery-and-send-tools/). For the underlying responder/runtime wiring, see [Composition](/programmatic/composition/); for structured-output and approval gating around runs, see [Approval and structured output](/programmatic/approval-and-structured-output/).

## Related pages

- [Channels overview](/channels/) — the config-driven built-in transports.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — replying, proactive notify, allowlists.
- [Composition](/programmatic/composition/) — building the responder/runtime each driver receives.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how warm sessions and queued turns are managed behind a channel.
