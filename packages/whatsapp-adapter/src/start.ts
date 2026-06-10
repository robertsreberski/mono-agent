import {
  WhatsAppAdapter,
  type AgentResponder,
  type WhatsAppAdapterLogger,
  type WhatsAppAdapterMessages,
  type WhatsAppAdapterStreamOptions,
  type WhatsAppMessageHandlingResult,
  type WhatsAppTriggerOptions,
} from "./adapter.js";
import {
  createBaileysWhatsAppSocket,
  type BaileysWhatsAppSocket,
  type BaileysWhatsAppSocketOptions,
} from "./baileys-socket.js";
import { WhatsAppAdapterConfigError } from "./config.js";
import type { WhatsAppAdapterConfig } from "./config.js";
import {
  WhatsAppEventRunner,
  type WhatsAppConnectionUpdate,
  type WhatsAppEventRunnerLogger,
} from "./event-runner.js";

/**
 * Factory seam used to construct the WhatsApp socket. Defaults to the real
 * Baileys factory, but tests inject a fake to exercise the start path without a
 * live WhatsApp connection.
 */
export type WhatsAppSocketFactory = (
  options: BaileysWhatsAppSocketOptions,
) => Promise<BaileysWhatsAppSocket>;

export interface WhatsAppAdapterStartLogger
  extends WhatsAppAdapterLogger,
    WhatsAppEventRunnerLogger {}

export interface StartWhatsAppAdapterOptions {
  /** Directory the Baileys multi-file auth state is read from / written to. */
  readonly authDir: string;
  /** Resolved adapter config (allowlist + group trigger settings). */
  readonly config: WhatsAppAdapterConfig;
  /** Agent responder invoked for each authorized inbound message. */
  readonly responder: AgentResponder;
  readonly logger?: WhatsAppAdapterStartLogger;
  /** Optional terminal message overrides (welcome/help/error/etc.). */
  readonly messages?: WhatsAppAdapterMessages;
  /** Optional streaming/status-message behavior overrides. */
  readonly stream?: WhatsAppAdapterStreamOptions;
  /** Override or extend the trigger options resolved from config. */
  readonly trigger?: WhatsAppTriggerOptions;
  /** Process Baileys history-sync upserts in addition to live notifications. */
  readonly processHistory?: boolean;
  /** Surface scannable login QR codes. */
  readonly onQr?: (qr: string) => void | Promise<void>;
  /** Observe Baileys connection lifecycle updates. */
  readonly onConnectionUpdate?: (
    update: WhatsAppConnectionUpdate,
  ) => void | Promise<void>;
  /** Observe each adapter message-handling result. */
  readonly onMessageResult?: (
    result: WhatsAppMessageHandlingResult,
  ) => void | Promise<void>;
  /** Socket construction options forwarded to the factory. */
  readonly socketOptions?: Omit<BaileysWhatsAppSocketOptions, "authDir">;
  /** Injectable socket factory seam (defaults to the Baileys factory). */
  readonly createSocket?: WhatsAppSocketFactory;
}

export interface WhatsAppAdapterStartResult {
  readonly adapter: WhatsAppAdapter;
  readonly runner: WhatsAppEventRunner;
  readonly socket: BaileysWhatsAppSocket;
  stop(): Promise<void>;
}

/**
 * Composition-root entrypoint: constructs the Baileys socket, the
 * WhatsAppAdapter, and the WhatsAppEventRunner, wires credential persistence,
 * and starts listening. Returns a handle whose `stop()` tears everything down
 * cleanly.
 *
 * Fail-closed: rejects before opening a connection when the responder is
 * missing. The adapter constructor itself rejects a config that neither
 * allowlists chats nor opts into `allowAllChats`.
 */
export async function startWhatsAppAdapter(
  options: StartWhatsAppAdapterOptions,
): Promise<WhatsAppAdapterStartResult> {
  validateOptions(options);

  const createSocket = options.createSocket ?? createBaileysWhatsAppSocket;
  const socket = await createSocket({
    ...options.socketOptions,
    authDir: options.authDir,
  });

  const adapter = new WhatsAppAdapter({
    socket: socket.socket,
    responder: options.responder,
    allowedChatJids: [...options.config.allowedChatJids],
    allowAllChats: options.config.allowAllChats,
    trigger: options.trigger ?? resolveTriggerOptions(options.config),
    ...(options.stream !== undefined ? { stream: options.stream } : {}),
    ...(options.messages !== undefined ? { messages: options.messages } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  const runner = new WhatsAppEventRunner({
    socket: socket.socket,
    adapter,
    processHistory: options.processHistory === true,
    saveCreds: socket.saveCreds,
    ...(options.onQr !== undefined ? { onQr: options.onQr } : {}),
    ...(options.onConnectionUpdate !== undefined
      ? { onConnectionUpdate: options.onConnectionUpdate }
      : {}),
    ...(options.onMessageResult !== undefined
      ? { onMessageResult: options.onMessageResult }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  runner.start();

  let stopped = false;
  return {
    adapter,
    runner,
    socket,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      runner.stop();
      await runner.idle();
      await closeSocket(socket, options.logger);
    },
  };
}

function resolveTriggerOptions(config: WhatsAppAdapterConfig): WhatsAppTriggerOptions {
  return {
    groupMode: config.trigger.groupMode,
    botJids: [...config.trigger.botJids],
    mentionTextAliases: [...config.trigger.mentionTextAliases],
    stripMentionText: config.trigger.stripMentionText,
  };
}

async function closeSocket(
  socket: BaileysWhatsAppSocket,
  logger: WhatsAppAdapterStartLogger | undefined,
): Promise<void> {
  const end = socket.baileysSocket?.end;
  if (typeof end !== "function") {
    return;
  }
  try {
    // `end(undefined)` closes the WebSocket without logging out, preserving the
    // persisted auth state for the next start. `logout()` would wipe creds.
    await end.call(socket.baileysSocket, undefined);
  } catch (error) {
    logger?.error?.("WhatsApp socket failed to close cleanly.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateOptions(options: StartWhatsAppAdapterOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new WhatsAppAdapterConfigError(
      "missing_required_config",
      "startWhatsAppAdapter requires a responder.",
    );
  }
  if (typeof options.authDir !== "string" || options.authDir.trim().length === 0) {
    throw new WhatsAppAdapterConfigError(
      "missing_required_config",
      "startWhatsAppAdapter requires a non-empty authDir.",
      { env: "authDir" },
    );
  }
}
