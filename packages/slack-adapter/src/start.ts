import { types as nodeUtilTypes } from "node:util";

import {
  SlackAdapter,
  type AgentResponder,
  type SlackAdapterLogger,
  type SlackAdapterMessages,
  type SlackAdapterStreamOptions,
  type SlackAttachmentOptions,
  type SlackEventHandlingResult,
  type SlackHomeTabOptions,
  type SlackShortcutBinding,
} from "./adapter.js";
import {
  createSecretSafeSlackLogger,
  redactSlackErrorMessage,
  redactSlackSecretText,
} from "./log-redaction.js";
import { SlackWebApiClient } from "./slack-client.js";
import {
  SlackSocketModeRunner,
  type SlackSocketModeRunnerBackoffOptions,
  type SlackSocketModeRunnerHeartbeatOptions,
  type SlackSocketModeRunnerLogger,
  type SlackWebSocketFactory,
} from "./socket-mode-runner.js";
import type { SlackChannelId, SlackUserId, SlackWebApi } from "./types.js";

const PROMISE_THEN = Promise.prototype.then;

export interface SlackAdapterStartLogger extends SlackAdapterLogger, SlackSocketModeRunnerLogger {}

export interface SlackAdapterStartOptions {
  /** Slack bot token used for chat.postMessage and chat.update. */
  readonly botToken: string;
  /** Slack app-level token with connections:write for Socket Mode. */
  readonly appToken: string;
  /** Optional override for the Slack Web API base URL. */
  readonly apiBaseUrl?: string;
  /** Optional fetch implementation forwarded to the default Slack client. */
  readonly fetchImpl?: typeof fetch;
  /** Optional request timeout (ms) forwarded to the default Slack client. */
  readonly requestTimeoutMs?: number;

  readonly allowedChannelIds?: readonly SlackChannelId[];
  readonly allowAllChannels?: boolean;
  readonly botUserIds?: readonly SlackUserId[];
  readonly mentionTextAliases?: readonly string[];
  readonly stripMentionText?: boolean;

  readonly responder: AgentResponder;
  readonly stream?: SlackAdapterStreamOptions;
  readonly messages?: SlackAdapterMessages;
  readonly attachments?: SlackAttachmentOptions;
  /**
   * Shortcut bindings (callback_id → prompt). When set, the Socket Mode runner
   * routes shortcut payloads to the adapter, which runs the bound prompt as a
   * proactive turn. Omitted/empty leaves interactivity ignored.
   */
  readonly shortcuts?: readonly SlackShortcutBinding[];
  /**
   * App Home tab configuration (persistent action buttons). When enabled, the
   * adapter publishes the tab on open and routes button clicks to their prompts.
   */
  readonly homeTab?: SlackHomeTabOptions;
  readonly logger?: SlackAdapterStartLogger;

  /** Resolve an in-thread reply back to the conversation that produced the message it threads off. */
  readonly resolvePostIndex?: (channelId: string, ts: string) => Promise<string | undefined>;
  /** Record a posted message `(channel, ts) → conversationId` for later reply resolution. */
  readonly recordPostedMessage?: (channelId: string, ts: string, conversationId: string) => void;

  /** Reconnect backoff bounds (and jitter/stability/startup-grace/drain tuning) forwarded to the Socket Mode runner. */
  readonly reconnect?: SlackSocketModeRunnerBackoffOptions;
  /** Heartbeat watchdog for detecting and recycling a silently dead socket. */
  readonly heartbeat?: SlackSocketModeRunnerHeartbeatOptions;
  /** Observe every Socket Mode event handling result. */
  readonly onEventResult?: (result: SlackEventHandlingResult) => void | Promise<void>;
  /**
   * Called once when the connection drops into the reconnect/backoff loop
   * (degraded). Credential-like reason material is redacted, and callback
   * failures are isolated from reconnect recovery. Wire to the app's onDegraded.
   */
  readonly onConnectionLost?: (reason: string) => void;
  /**
   * Called once a reconnect has stayed up for the stability window after a
   * prior loss (recovered). Callback failures are isolated from recovery.
   * Wire to onRecovered.
   */
  readonly onConnectionRestored?: () => void;
  /** Injected RNG for backoff jitter; defaults to Math.random. Tests inject a deterministic value. */
  readonly random?: () => number;

  /**
   * Injected Slack Web API factory. Defaults to constructing a real
   * {@link SlackWebApiClient}. Tests can supply a fake transport here.
   */
  readonly createApi?: (input: SlackApiFactoryInput) => SlackWebApi;
  /**
   * Injected WebSocket factory forwarded to the Socket Mode runner. Tests can
   * supply a fake socket so the start path runs without a real connection.
   */
  readonly webSocketFactory?: SlackWebSocketFactory;
}

export interface SlackApiFactoryInput {
  readonly botToken: string;
  readonly appToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export interface SlackAdapterStartResult {
  /** The Slack Web API client driving the adapter and Socket Mode runner. */
  readonly api: SlackWebApi;
  /** The constructed adapter, exposed for advanced inspection. */
  readonly adapter: SlackAdapter;
  /** The Socket Mode runner driving the connection. */
  readonly runner: SlackSocketModeRunner;
  /** Cleanly aborts the Socket Mode connection and awaits the runner loop. */
  stop(): Promise<void>;
}

export async function startSlackAdapter(
  options: SlackAdapterStartOptions,
): Promise<SlackAdapterStartResult> {
  if (typeof options.responder?.respond !== "function") {
    throw new TypeError("startSlackAdapter requires a responder.");
  }

  const api = (options.createApi ?? defaultCreateApi)({
    botToken: options.botToken,
    appToken: options.appToken,
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });

  const knownSecrets = [options.botToken, options.appToken] as const;
  const logger = createSecretSafeSlackLogger(options.logger, knownSecrets);
  const adapter = new SlackAdapter(buildAdapterOptions(api, options, logger));
  const runner = new SlackSocketModeRunner(buildRunnerOptions(
    api,
    adapter,
    options,
    logger,
    knownSecrets,
  ));

  const controller = new AbortController();
  // Fire-and-forget the reconnect loop. The runner resolves only when the
  // signal aborts, so we hold the promise and await it during stop().
  const loop = runner.start({ signal: controller.signal });
  // Prevent unhandled rejections if the loop ever throws; stop() observes it too.
  loop.catch((error: unknown) => {
    logger?.error?.("Slack Socket Mode runner stopped unexpectedly.", {
      error: redactSlackErrorMessage(error),
    });
  });

  let stopped = false;
  return {
    api,
    adapter,
    runner,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      controller.abort();
      await loop;
    },
  };
}

function defaultCreateApi(input: SlackApiFactoryInput): SlackWebApi {
  return new SlackWebApiClient({
    botToken: input.botToken,
    appToken: input.appToken,
    ...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
  });
}

function buildAdapterOptions(
  api: SlackWebApi,
  options: SlackAdapterStartOptions,
  logger: SlackAdapterStartLogger | undefined,
): ConstructorParameters<typeof SlackAdapter>[0] {
  const adapterOptions: ConstructorParameters<typeof SlackAdapter>[0] = {
    api,
    responder: options.responder,
  };
  if (options.allowedChannelIds !== undefined) {
    adapterOptions.allowedChannelIds = [...options.allowedChannelIds];
  }
  if (options.allowAllChannels !== undefined) {
    adapterOptions.allowAllChannels = options.allowAllChannels;
  }
  if (options.botUserIds !== undefined) {
    adapterOptions.botUserIds = [...options.botUserIds];
  }
  if (options.mentionTextAliases !== undefined) {
    adapterOptions.mentionTextAliases = [...options.mentionTextAliases];
  }
  if (options.stripMentionText !== undefined) {
    adapterOptions.stripMentionText = options.stripMentionText;
  }
  if (options.stream !== undefined) {
    adapterOptions.stream = options.stream;
  }
  if (options.messages !== undefined) {
    adapterOptions.messages = options.messages;
  }
  if (options.attachments !== undefined) {
    adapterOptions.attachments = options.attachments;
  }
  if (options.shortcuts !== undefined) {
    adapterOptions.shortcuts = options.shortcuts;
  }
  if (options.homeTab !== undefined) {
    adapterOptions.homeTab = options.homeTab;
  }
  if (logger !== undefined) {
    adapterOptions.logger = logger;
  }
  if (options.resolvePostIndex !== undefined) {
    adapterOptions.resolvePostIndex = options.resolvePostIndex;
  }
  if (options.recordPostedMessage !== undefined) {
    adapterOptions.recordPostedMessage = options.recordPostedMessage;
  }
  return adapterOptions;
}

function buildRunnerOptions(
  api: SlackWebApi,
  adapter: SlackAdapter,
  options: SlackAdapterStartOptions,
  logger: SlackAdapterStartLogger | undefined,
  knownSecrets: readonly string[],
): ConstructorParameters<typeof SlackSocketModeRunner>[0] {
  const runnerOptions: ConstructorParameters<typeof SlackSocketModeRunner>[0] = {
    api,
    handler: adapter,
  };
  if (options.reconnect !== undefined) {
    runnerOptions.reconnect = options.reconnect;
  }
  if (options.heartbeat !== undefined) {
    runnerOptions.heartbeat = options.heartbeat;
  }
  if (options.webSocketFactory !== undefined) {
    runnerOptions.webSocketFactory = options.webSocketFactory;
  }
  if (options.onEventResult !== undefined) {
    runnerOptions.onEventResult = options.onEventResult;
  }
  const onConnectionLost = options.onConnectionLost;
  if (onConnectionLost !== undefined) {
    runnerOptions.onConnectionLost = (reason) => {
      invokeHostCallbackSafely(() => {
        return onConnectionLost(redactSlackSecretText(reason, knownSecrets));
      });
    };
  }
  const onConnectionRestored = options.onConnectionRestored;
  if (onConnectionRestored !== undefined) {
    runnerOptions.onConnectionRestored = () => {
      invokeHostCallbackSafely(onConnectionRestored);
    };
  }
  if (options.random !== undefined) {
    runnerOptions.random = options.random;
  }
  // Only subscribe to interactivity when shortcuts or Home-tab buttons are bound,
  // so the runner's behavior is unchanged for agents that wire none.
  const hasShortcuts = options.shortcuts !== undefined && options.shortcuts.length > 0;
  const hasHomeButtons = options.homeTab?.buttons !== undefined && options.homeTab.buttons.length > 0;
  if (hasShortcuts || hasHomeButtons) {
    runnerOptions.onInteraction = async (payload) => {
      try {
        const result = await adapter.handleInteraction(payload);
        if (result.kind === "triggered") {
          logger?.info?.("Slack interaction triggered.", { result });
        } else {
          logger?.debug?.("Slack interaction ignored.", { result });
        }
      } catch (error) {
        logger?.error?.("Slack interaction handling failed.", {
          error: redactSlackErrorMessage(error),
        });
      }
    };
  }
  if (logger !== undefined) {
    runnerOptions.logger = logger;
  }
  return runnerOptions;
}

function invokeHostCallbackSafely(callback: () => unknown): void {
  try {
    const outcome = callback();
    if (nodeUtilTypes.isPromise(outcome)) {
      Reflect.apply(PROMISE_THEN, outcome, [undefined, () => undefined]);
    }
  } catch {
    // Host observability callbacks cannot stop Socket Mode reconnect recovery.
  }
}
