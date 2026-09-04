import { AgentResponseCancelledError, type ProcessJobProjection } from "@mono-agent/agent-contracts";

import {
  MessengerAdapter,
  type AgentResponder,
  type MessengerAdapterLogger,
  type MessengerAdapterMessages,
  type MessengerNotifyOptions,
  type MessengerNotifyResult,
} from "./adapter.js";
import { MessengerAdapterConfigError, type MessengerAdapterConfig } from "./config.js";
import { MessengerGraphClient, type MessengerGraphClientLike } from "./graph-client.js";
import {
  createMessengerWebhookServer,
  type MessengerWebhookServer,
  type MessengerWebhookServerLogger,
  type MessengerWebhookServerOptions,
} from "./server.js";

export interface MessengerAdapterStartLogger extends MessengerAdapterLogger, MessengerWebhookServerLogger {}

export interface StartMessengerAdapterOptions {
  readonly config: MessengerAdapterConfig;
  readonly responder: AgentResponder;
  readonly logger?: MessengerAdapterStartLogger;
  readonly messages?: MessengerAdapterMessages;
  /** Injectable Graph client (tests); defaults to the real Send API client. */
  readonly client?: MessengerGraphClientLike;
  /** Injectable `fetch` for both the Graph client and attachment downloads. */
  readonly fetch?: typeof fetch;
  /** Injectable webhook server factory (tests). */
  readonly createServer?: (options: MessengerWebhookServerOptions) => MessengerWebhookServer;
  /** Reports a webhook server that died after start. */
  readonly onServerError?: (reason: string) => void;
}

export interface MessengerAdapterStartResult {
  readonly adapter: MessengerAdapter;
  readonly host: string;
  readonly port: number;
  readonly webhookPath: string;
  stop(): Promise<void>;
  notify(userId: string, text: string, options?: MessengerNotifyOptions): Promise<MessengerNotifyResult>;
  updateProcessJob(userId: string, projection: ProcessJobProjection): ReturnType<MessengerAdapter["updateProcessJob"]>;
}

/**
 * Composition-root entrypoint: builds the Graph client, the adapter, and the
 * webhook server, then starts listening. Fail-closed on a missing responder or
 * an incomplete config.
 */
export async function startMessengerAdapter(options: StartMessengerAdapterOptions): Promise<MessengerAdapterStartResult> {
  if (typeof options.responder?.respond !== "function") {
    throw new MessengerAdapterConfigError("missing_required_config", "startMessengerAdapter requires a responder.");
  }
  const { config } = options;
  if (!config.enabled) {
    throw new MessengerAdapterConfigError("missing_required_config", "startMessengerAdapter requires an enabled config.");
  }
  const client = options.client ?? new MessengerGraphClient({
    pageAccessToken: config.pageAccessToken,
    apiVersion: config.apiVersion,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const adapter = new MessengerAdapter({
    client,
    responder: options.responder,
    allowedUserIds: [...config.allowedUserIds],
    allowAllUsers: config.allowAllUsers,
    proactive: {
      messagingType: config.proactiveMessagingType,
      ...(config.proactiveTag === undefined ? {} : { tag: config.proactiveTag }),
    },
    ...(options.fetch === undefined ? {} : { attachments: { fetch: options.fetch } }),
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const createServer = options.createServer ?? createMessengerWebhookServer;
  const server = createServer({
    host: config.host,
    port: config.port,
    webhookPath: config.webhookPath,
    verifyToken: config.verifyToken,
    appSecret: config.appSecret,
    onPayload: (payload) => adapter.handleWebhookPayload(payload),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onServerError === undefined ? {} : { onServerError: options.onServerError }),
  });
  const listening = await server.start();
  options.logger?.info?.("Messenger webhook listening.", {
    host: listening.host,
    port: listening.port,
    path: config.webhookPath,
  });

  let stopPromise: Promise<void> | undefined;
  return {
    adapter,
    host: listening.host,
    port: listening.port,
    webhookPath: config.webhookPath,
    stop() {
      stopPromise ??= (async () => {
        await server.stop();
        adapter.stop(new AgentResponseCancelledError("Messenger adapter stopped."));
      })();
      return stopPromise;
    },
    notify: (userId, text, notifyOptions) => adapter.notify(userId, text, notifyOptions),
    updateProcessJob: (userId, projection) => adapter.updateProcessJob(userId, projection),
  };
}
