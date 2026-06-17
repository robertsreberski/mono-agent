import {
  SlackAdapter,
  type AgentResponder,
  type SlackAdapterLogger,
  type SlackAdapterMessages,
  type SlackAdapterStreamOptions,
  type SlackAttachmentOptions,
  type SlackEventHandlingResult,
} from "./adapter.js";
import { SlackWebApiClient } from "./slack-client.js";
import {
  SlackSocketModeRunner,
  type SlackSocketModeRunnerBackoffOptions,
  type SlackSocketModeRunnerLogger,
  type SlackWebSocketFactory,
} from "./socket-mode-runner.js";
import type { SlackChannelId, SlackUserId, SlackWebApi } from "./types.js";

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
  readonly logger?: SlackAdapterStartLogger;

  /** Reconnect backoff bounds forwarded to the Socket Mode runner. */
  readonly reconnect?: SlackSocketModeRunnerBackoffOptions;
  /** Observe every Socket Mode event handling result. */
  readonly onEventResult?: (result: SlackEventHandlingResult) => void | Promise<void>;

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

  const adapter = new SlackAdapter(buildAdapterOptions(api, options));
  const runner = new SlackSocketModeRunner(buildRunnerOptions(api, adapter, options));

  const controller = new AbortController();
  // Fire-and-forget the reconnect loop. The runner resolves only when the
  // signal aborts, so we hold the promise and await it during stop().
  const loop = runner.start({ signal: controller.signal });
  // Prevent unhandled rejections if the loop ever throws; stop() observes it too.
  loop.catch((error: unknown) => {
    options.logger?.error?.("Slack Socket Mode runner stopped unexpectedly.", {
      error: error instanceof Error ? error.message : String(error),
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
  if (options.logger !== undefined) {
    adapterOptions.logger = options.logger;
  }
  return adapterOptions;
}

function buildRunnerOptions(
  api: SlackWebApi,
  adapter: SlackAdapter,
  options: SlackAdapterStartOptions,
): ConstructorParameters<typeof SlackSocketModeRunner>[0] {
  const runnerOptions: ConstructorParameters<typeof SlackSocketModeRunner>[0] = {
    api,
    handler: adapter,
  };
  if (options.reconnect !== undefined) {
    runnerOptions.reconnect = options.reconnect;
  }
  if (options.webSocketFactory !== undefined) {
    runnerOptions.webSocketFactory = options.webSocketFactory;
  }
  if (options.onEventResult !== undefined) {
    runnerOptions.onEventResult = options.onEventResult;
  }
  if (options.logger !== undefined) {
    runnerOptions.logger = options.logger;
  }
  return runnerOptions;
}
