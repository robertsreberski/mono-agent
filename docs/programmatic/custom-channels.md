---
title: "Write your own channel adapter"
sidebar:
  order: 5
---

This page covers writing your own channel adapter package, loading it from `mono-agent.config.json` with `channels.plugins[]`, and registering drivers programmatically with `startMonoAgentApp`. It also covers overriding stream and message-text behavior of the core channels (welcome/help/error text, edit debounce, max chars, interim streaming). For built-in and external channel options, see [Channels overview](/channels/).

## When you need a driver

The core drivers (Telegram, Slack, Webhook, OpenAI-compatible API, Cron, TUI, Live) plus the external WhatsApp and A2A packages cover the channels mono-agent ships today. Write a custom `ChannelDriver` when you need a transport that ships nothing — for example an in-house message bus, an SMS gateway, an email poller, or a test harness. A driver is thin: it reuses an adapter's config loader plus its `start` function and adds the wiring the app host would otherwise copy by hand.

The driver contract lives in **`@mono-agent/agent-contracts`** — a dependency-free contracts package — so a channel author does not need the host package at all. `@mono-agent/agent-app` re-exports every type below (with the core-config parameter bound to `MonoAgentConfig`), so existing imports keep working.

## Loading a package from config

The external-channel seam is only a loading mechanism. The app reads `channels.plugins[]`, resolves each `package` by name at startup, calls the package's `createChannelDriver(options)` export (or the package default export), and treats the returned object as a normal `ChannelDriver`. There is no plugin registry, version negotiation, lifecycle hook API, or extra contract beyond `ChannelDriver`.

```json
{
  "channels": {
    "plugins": [
      {
        "package": "@mono-agent/whatsapp-adapter",
        "id": "whatsapp",
        "label": "WhatsApp",
        "config": {
          "enabled": true,
          "allowedChatJids": ["123@s.whatsapp.net"]
        }
      }
    ]
  }
}
```

A package can expose a factory like this:

```ts
import type { ChannelDriver } from "@mono-agent/agent-contracts";

export interface MyChannelPluginOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: Record<string, unknown>;
}

export function createChannelDriver(options: MyChannelPluginOptions = {}): ChannelDriver {
  const id = options.id ?? "my-channel";
  const label = options.label ?? "My channel";
  const inlineConfig = options.config ?? {};

  return {
    id,
    label,
    async loadConfig({ env }) {
      return {
        enabled: inlineConfig.enabled === true || env.MONO_AGENT_MY_CHANNEL_ENABLED === "true",
      };
    },
    isConfigError(error) {
      return error instanceof Error && error.name === "MyChannelConfigError";
    },
    disabledReason(config) {
      return config.enabled ? undefined : `${label} is disabled.`;
    },
    async start(input) {
      return {
        summary: { id },
        stop: async () => {
          // stop your socket, poller, or subscription here
        },
      };
    },
  };
}
```

Missing packages, malformed exports, invalid plugin entries, and duplicate channel ids are reported as `waiting_for_config` validate/start sections so the rest of the host can still run. Plugin ids must not collide with the core `BUILTIN_CHANNEL_IDS`.

## The ChannelDriver interface

```ts
import type {
  ChannelDriver,
  ChannelStartInput,
  RunningChannel,
  ChannelConfigInput,
} from "@mono-agent/agent-contracts";
// or the same names from "@mono-agent/agent-app" (host-bound aliases)

interface ChannelDriver<TConfig = unknown, TCore = unknown> {
  readonly id: ChannelId;     // any string; built-ins use "telegram", "slack", …
  readonly label: string;     // human label for status output
  loadConfig(input: ChannelConfigInput): Promise<TConfig>;
  isConfigError(error: unknown): boolean;
  disabledReason?(config: TConfig): string | undefined;
  waitingReason?(config: TConfig): string | undefined;
  configView?(input: ChannelConfigInput): Promise<ChannelConfigViewSection>;
  configIssues?(config: TConfig): readonly string[];
  start(input: ChannelStartInput<TConfig, TCore>): Promise<RunningChannel>;
}
```

| Member | Contract |
|---|---|
| `id` | Identifies the channel in `channelStatus(id)` / `channelStatuses()` and its `channel:<id>` validate section. `ChannelId` is **any string** — pick your own (e.g. `"discord"`, `"sms"`); `BUILTIN_CHANNEL_IDS` (from `@mono-agent/agent-app`) lists the ids the CLI drives from config. |
| `label` | Display name shown in status / doctor output. |
| `loadConfig` | Receives `{ env, cwd, configPath }`. Read your section out of `mono-agent.config.json` (and env). Throw your own typed config error when the config is malformed. |
| `isConfigError` | Return `true` for your loader's own typed errors. The app treats those as `waiting_for_config` (incomplete) rather than a crash. |
| `disabledReason` | Return a string when the loaded config explicitly disables the channel (e.g. `enabled: false`) → status `disabled`. Return `undefined` to proceed. |
| `waitingReason` | Return a string when the config is enabled but still missing a required sub-section → status `waiting_for_config`. |
| `configView` | Optional. Compose a source-annotated config section (field-by-field `env`/`json`/`default` provenance, secrets as set/unset) for `mono-agent config` and the secret-placement warnings. Read-only. |
| `configIssues` | Optional. Structural problems in a loaded, enabled config (e.g. an invalid per-trigger model override). `validate` reports them as an `error`; `start` logs them and starts anyway. |
| `start` | Boot the transport and return a `RunningChannel`. |

`ChannelConfigInput` (the app-side alias is `MonoAgentAppConfigInput`) is exactly:

```ts
interface ChannelConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}
```

### ChannelStartInput and RunningChannel

`start` receives everything the transport needs, including the shared `AgentResponder` the app built from your runtime config:

```ts
interface ChannelStartInput<TConfig, TCore = unknown> {
  readonly config: TConfig;          // what loadConfig returned
  readonly coreConfig: TCore;        // MonoAgentConfig when run by the mono-agent app
  readonly responder: AgentResponder; // run the agent through this
  readonly cwd: string;
  readonly logger?: ChannelLogger;
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
  id: "sms", // any string works; the id keys status maps and the channel:sms validate section
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

`defaultChannelDrivers()` returns every core built-in driver in startup/status order. App startup normally calls `resolveChannelDrivers(...)`, which returns those core drivers plus any configured `channels.plugins[]` packages. For a programmatic host, spread `defaultChannelDrivers()` and append yours; pass an empty-spread-plus-yours array to run **only** your driver. See [Composition](/programmatic/composition/) for assembling the responder/runtime that backs every channel.

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

- [Channels overview](/channels/) — core transports and external channel packages.
- [Delivery and send tools](/channels/delivery-and-send-tools/) — replying, proactive notify, allowlists.
- [Composition](/programmatic/composition/) — building the responder/runtime each driver receives.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how warm sessions and queued turns are managed behind a channel.
