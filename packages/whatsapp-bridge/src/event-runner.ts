import type { WhatsAppBridge, WhatsAppMessageHandlingResult } from "./bridge.js";
import type { WhatsAppRawMessage, WhatsAppSocketLike } from "./types.js";

export interface WhatsAppEventRunnerOptions {
  socket: WhatsAppSocketLike;
  bridge: WhatsAppBridge;
  processHistory?: boolean;
  saveCreds?: () => Promise<void> | void;
  onQr?: (qr: string) => void | Promise<void>;
  onConnectionUpdate?: (update: WhatsAppConnectionUpdate) => void | Promise<void>;
  onMessageResult?: (result: WhatsAppMessageHandlingResult) => void | Promise<void>;
  logger?: WhatsAppEventRunnerLogger;
}

export interface WhatsAppEventRunnerStartOptions {
  signal?: AbortSignal;
}

export interface WhatsAppConnectionUpdate {
  connection?: string;
  receivedPendingNotifications?: boolean;
  isNewLogin?: boolean;
  isOnline?: boolean;
  hasQr: boolean;
}

export interface WhatsAppEventRunnerLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

interface MessagesUpsertLike {
  type?: string;
  messages?: WhatsAppRawMessage[];
}

export class WhatsAppEventRunner {
  private readonly socket: WhatsAppSocketLike;
  private readonly bridge: WhatsAppBridge;
  private readonly processHistory: boolean;
  private readonly saveCreds: (() => Promise<void> | void) | undefined;
  private readonly onQr: ((qr: string) => void | Promise<void>) | undefined;
  private readonly onConnectionUpdate:
    | ((update: WhatsAppConnectionUpdate) => void | Promise<void>)
    | undefined;
  private readonly onMessageResult:
    | ((result: WhatsAppMessageHandlingResult) => void | Promise<void>)
    | undefined;
  private readonly logger: WhatsAppEventRunnerLogger | undefined;

  private started = false;
  private processing = Promise.resolve();
  private cleanup: (() => void)[] = [];

  private readonly handleMessagesUpsert = (payload: unknown): void => {
    this.processing = this.processing.then(async () => {
      await this.processMessagesUpsert(payload);
    });
    this.processing = this.processing.catch((error: unknown) => {
      this.logger?.error?.("WhatsApp messages.upsert processing failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  private readonly handleCredsUpdate = (): void => {
    if (this.saveCreds === undefined) {
      return;
    }
    Promise.resolve()
      .then(async () => this.saveCreds?.())
      .catch((error: unknown) => {
        this.logger?.error?.("WhatsApp creds.update save failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  private readonly handleConnectionUpdate = (payload: unknown): void => {
    const update = normalizeConnectionUpdate(payload);
    this.logger?.info?.("WhatsApp connection update.", {
      connection: update.connection,
      receivedPendingNotifications: update.receivedPendingNotifications,
      isNewLogin: update.isNewLogin,
      isOnline: update.isOnline,
      hasQr: update.hasQr,
    });

    const qr = qrFromConnectionUpdate(payload);
    if (qr !== undefined && this.onQr !== undefined) {
      Promise.resolve(this.onQr(qr)).catch((error: unknown) => {
        this.logger?.error?.("WhatsApp QR callback failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (this.onConnectionUpdate !== undefined) {
      Promise.resolve(this.onConnectionUpdate(update)).catch((error: unknown) => {
        this.logger?.error?.("WhatsApp connection update callback failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  private readonly handleAbort = (): void => {
    this.stop();
  };

  constructor(options: WhatsAppEventRunnerOptions) {
    this.socket = options.socket;
    this.bridge = options.bridge;
    this.processHistory = options.processHistory === true;
    this.saveCreds = options.saveCreds;
    this.onQr = options.onQr;
    this.onConnectionUpdate = options.onConnectionUpdate;
    this.onMessageResult = options.onMessageResult;
    this.logger = options.logger;
  }

  start(options: WhatsAppEventRunnerStartOptions = {}): void {
    if (this.started) {
      return;
    }
    if (options.signal?.aborted === true) {
      return;
    }
    const ev = this.socket.ev;
    if (ev === undefined) {
      throw new TypeError("WhatsAppEventRunner requires a socket with an event emitter.");
    }

    this.started = true;
    ev.on("messages.upsert", this.handleMessagesUpsert);
    ev.on("creds.update", this.handleCredsUpdate);
    ev.on("connection.update", this.handleConnectionUpdate);
    this.cleanup.push(() => removeListener(ev, "messages.upsert", this.handleMessagesUpsert));
    this.cleanup.push(() => removeListener(ev, "creds.update", this.handleCredsUpdate));
    this.cleanup.push(() => removeListener(ev, "connection.update", this.handleConnectionUpdate));

    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", this.handleAbort, { once: true });
      this.cleanup.push(() => options.signal?.removeEventListener("abort", this.handleAbort));
    }
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    for (const cleanup of this.cleanup.splice(0)) {
      cleanup();
    }
    this.started = false;
  }

  async idle(): Promise<void> {
    await this.processing;
  }

  private async processMessagesUpsert(payload: unknown): Promise<void> {
    if (!isMessagesUpsertLike(payload)) {
      await this.emitMessageResult({ kind: "ignored", reason: "non_message_update" });
      return;
    }

    if (payload.type !== "notify" && !this.processHistory) {
      await this.emitMessageResult({ kind: "ignored", reason: "history_sync_ignored" });
      return;
    }

    for (const message of payload.messages ?? []) {
      try {
        const result = await this.bridge.handleMessage(message);
        await this.emitMessageResult(result);
      } catch (error) {
        const result: WhatsAppMessageHandlingResult = { kind: "error", error };
        await this.emitMessageResult(result);
      }
    }
  }

  private async emitMessageResult(result: WhatsAppMessageHandlingResult): Promise<void> {
    if (this.onMessageResult !== undefined) {
      await this.onMessageResult(result);
    }
  }
}

function isMessagesUpsertLike(value: unknown): value is MessagesUpsertLike {
  if (!isRecord(value)) {
    return false;
  }
  const messages = value.messages;
  return messages === undefined || Array.isArray(messages);
}

function normalizeConnectionUpdate(payload: unknown): WhatsAppConnectionUpdate {
  const record = isRecord(payload) ? payload : {};
  const update: WhatsAppConnectionUpdate = { hasQr: typeof record.qr === "string" };
  if (typeof record.connection === "string") {
    update.connection = record.connection;
  }
  if (typeof record.receivedPendingNotifications === "boolean") {
    update.receivedPendingNotifications = record.receivedPendingNotifications;
  }
  if (typeof record.isNewLogin === "boolean") {
    update.isNewLogin = record.isNewLogin;
  }
  if (typeof record.isOnline === "boolean") {
    update.isOnline = record.isOnline;
  }
  return update;
}

function qrFromConnectionUpdate(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.qr !== "string") {
    return undefined;
  }
  return payload.qr;
}

function removeListener(
  ev: NonNullable<WhatsAppSocketLike["ev"]>,
  event: string,
  listener: (payload: unknown) => void,
): void {
  if (typeof ev.off === "function") {
    ev.off(event, listener);
    return;
  }
  ev.removeListener?.(event, listener);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
