import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { verifyMessengerSignature } from "./text.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface MessengerWebhookServerLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface MessengerWebhookServerOptions {
  readonly host: string;
  readonly port: number;
  readonly webhookPath: string;
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly maxBodyBytes?: number;
  readonly logger?: MessengerWebhookServerLogger;
  /** Called after the 200 reply; processing must not delay Meta's delivery ack. */
  readonly onPayload: (payload: unknown) => Promise<unknown> | unknown;
  /** Called when the listening server dies after a successful start. */
  readonly onServerError?: (reason: string) => void;
}

export interface MessengerWebhookServer {
  start(): Promise<{ readonly host: string; readonly port: number }>;
  stop(): Promise<void>;
}

/**
 * Meta webhook endpoint: `GET <path>` answers the `hub.challenge` handshake,
 * `POST <path>` validates `X-Hub-Signature-256` over the raw body, and
 * `GET <path>/health` reports liveness. Everything else is 404.
 */
export function createMessengerWebhookServer(options: MessengerWebhookServerOptions): MessengerWebhookServer {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const healthPath = `${options.webhookPath}/health`;
  let server: Server | undefined;
  let started = false;

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : url.pathname;
    if (pathname === healthPath && request.method === "GET") {
      sendJson(response, 200, { ok: true, channel: "messenger" });
      return;
    }
    if (pathname !== options.webhookPath) {
      sendText(response, 404, "Not found");
      return;
    }
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token !== null && token === options.verifyToken && challenge !== null) {
        sendText(response, 200, challenge);
        return;
      }
      options.logger?.warn?.("Messenger webhook verification rejected.", { mode });
      sendText(response, 403, "Verification failed");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "GET, POST");
      sendText(response, 405, "Method not allowed");
      return;
    }
    readBody(request, maxBodyBytes).then((body) => {
      if (body === undefined) {
        sendText(response, 413, "Webhook body too large");
        return;
      }
      const signature = request.headers["x-hub-signature-256"];
      const header = Array.isArray(signature) ? signature[0] : signature;
      if (header === undefined || header.length === 0) {
        sendText(response, 400, "Missing signature");
        return;
      }
      if (!verifyMessengerSignature(body, header, options.appSecret)) {
        options.logger?.warn?.("Messenger webhook signature rejected.");
        sendText(response, 401, "Invalid signature");
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        sendText(response, 400, "Invalid JSON");
        return;
      }
      sendJson(response, 200, { status: "ok" });
      Promise.resolve()
        .then(() => options.onPayload(payload))
        .catch((error: unknown) => {
          options.logger?.error?.("Messenger webhook payload processing failed.", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }).catch((error: unknown) => {
      options.logger?.error?.("Messenger webhook request failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendText(response, 400, "Bad request");
      }
    });
  };

  return {
    async start() {
      if (server !== undefined) {
        throw new Error("Messenger webhook server already started.");
      }
      const instance = createServer(handle);
      server = instance;
      instance.on("error", (error) => {
        if (started) {
          options.onServerError?.(error instanceof Error ? error.message : String(error));
        }
      });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const onError = (error: Error): void => {
          instance.off("listening", onListening);
          rejectPromise(error);
        };
        const onListening = (): void => {
          instance.off("error", onError);
          resolvePromise();
        };
        instance.once("error", onError);
        instance.once("listening", onListening);
        instance.listen(options.port, options.host);
      });
      started = true;
      const address = instance.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      return { host: options.host, port };
    },
    async stop() {
      const instance = server;
      if (instance === undefined) {
        return;
      }
      server = undefined;
      started = false;
      instance.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => {
        instance.close(() => resolvePromise());
      });
    },
  };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      request.destroy();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(text);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
