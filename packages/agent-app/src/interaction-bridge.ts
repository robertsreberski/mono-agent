import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Interaction bridge: the app-owned loopback HTTP surface that lets tool child
 * processes (adapter-send-tools, project MCP servers) interact with the human
 * behind a channel conversation while a tool call is in flight.
 *
 * Two capabilities share it:
 * - Blocking `AskUser`: POST /v1/asks registers a pending ask (question posted
 *   through the channel's sink); the tool long-polls GET /v1/asks/:id until the
 *   channel intercepts the user's next message and resolves it.
 * - Blocking channel-owned asks (e.g. Telegram buttons): POST /v1/asks with
 *   `postQuestion:false` registers the same pending ask without duplicating
 *   channel-specific UI already posted by the tool.
 * - Tool progress: POST /v1/progress fans out to the channel sink's postStatus
 *   (e.g. a Telegram status message edited in place).
 *
 * The registry is in-memory by design: on an app restart pending asks vanish and
 * the user's later reply simply arrives as a normal next turn (multi-turn
 * degradation), which the AskUser tool description tells the model to expect.
 */

export interface ChannelInteractionSink {
  /** Post a free-text question to the conversation's chat. */
  postQuestion(conversationId: string, text: string): Promise<void>;
  /** Post (or edit in place, per `key`) a short tool-progress status line. */
  postStatus(
    conversationId: string,
    text: string,
    options: { readonly key: string; readonly state: "working" | "done" | "failed" },
  ): Promise<void>;
}

export interface InteractionBridgeOptions {
  readonly host?: string;
  /** TCP port; 0 picks an ephemeral port. Default {@link DEFAULT_INTERACTION_BRIDGE_PORT}. */
  readonly port?: number;
  /** Default + upper bound for a single ask's wait (ms). Default 10 minutes. */
  readonly askTimeoutMs?: number;
  readonly logger?: {
    warn?: (message: string, metadata?: Record<string, unknown>) => void;
    debug?: (message: string, metadata?: Record<string, unknown>) => void;
  };
}

export interface InteractionBridgeHandle {
  readonly url: string;
  readonly token: string;
  registerSink(channelId: string, sink: ChannelInteractionSink): void;
  /** Resolve the conversation's pending ask with the user's reply; true when consumed. */
  tryResolveAsk(conversationId: string, answer: string, answerKind?: AskAnswerKind): boolean;
  /** True when this conversation currently has any pending ask. */
  hasPendingAsk(conversationId: string): boolean;
  /** Fail every pending ask on the conversation (user cancelled the run). */
  cancelAsks(conversationId: string): void;
  /** Environment consumed by tool child processes (AskUser, project MCP servers). */
  env(): Record<string, string>;
  stop(): Promise<void>;
}

/** Default port 0 = ephemeral: consumers get the URL via env, so a fixed port only invites collisions. */
export const DEFAULT_INTERACTION_BRIDGE_PORT = 0;
export const DEFAULT_ASK_USER_TIMEOUT_MS = 600_000;

/** Render a loopback bridge origin, including bracketed IPv6 literals. */
export function formatInteractionBridgeUrl(host: string, port?: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}${port === undefined ? "" : `:${String(port)}`}`;
}

/** Resolved `interaction` config block (JSON `interaction` key + env overrides). */
export interface InteractionSettings {
  /** True when the operator explicitly configured the block (JSON or env). */
  readonly configured: boolean;
  readonly host: string;
  readonly port: number;
  readonly askTimeoutMs: number;
  readonly progressEnabled: boolean;
}

/**
 * Load the app-level `interaction` block from `mono-agent.config.json` with env
 * overrides (`MONO_AGENT_INTERACTION_BRIDGE_HOST/PORT`,
 * `MONO_AGENT_ASK_USER_TIMEOUT_MS`, `MONO_AGENT_PROGRESS_ENABLED`). Tolerant of
 * a missing file/block: returns unconfigured defaults.
 */
export async function loadInteractionSettings(input: {
  readonly env: Record<string, string | undefined>;
  readonly configPath: string;
}): Promise<InteractionSettings> {
  let block: Record<string, unknown> = {};
  let present = false;
  try {
    const parsed: unknown = JSON.parse(await readFile(input.configPath, "utf8"));
    const interaction = (parsed as Record<string, unknown> | null)?.interaction;
    if (typeof interaction === "object" && interaction !== null) {
      block = interaction as Record<string, unknown>;
      present = true;
    }
  } catch {
    // Missing or invalid config file: the core loader reports that; here we just
    // fall back to defaults.
  }
  const bridge = (block.bridge ?? {}) as Record<string, unknown>;
  const askUser = (block.askUser ?? {}) as Record<string, unknown>;
  const progress = (block.progress ?? {}) as Record<string, unknown>;
  const envHost = trimmed(input.env.MONO_AGENT_INTERACTION_BRIDGE_HOST);
  const envPort = integerOf(input.env.MONO_AGENT_INTERACTION_BRIDGE_PORT);
  const envTimeout = integerOf(input.env.MONO_AGENT_ASK_USER_TIMEOUT_MS);
  const envProgress = trimmed(input.env.MONO_AGENT_PROGRESS_ENABLED);
  const configured =
    present || envHost !== undefined || envPort !== undefined || envTimeout !== undefined || envProgress !== undefined;
  return {
    configured,
    host: envHost ?? (typeof bridge.host === "string" ? bridge.host : "127.0.0.1"),
    port: envPort ?? integerValue(bridge.port) ?? DEFAULT_INTERACTION_BRIDGE_PORT,
    askTimeoutMs: envTimeout ?? integerValue(askUser.timeoutMs) ?? DEFAULT_ASK_USER_TIMEOUT_MS,
    progressEnabled: envProgress !== undefined ? envProgress !== "false" : progress.enabled !== false,
  };
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function integerOf(value: string | undefined): number | undefined {
  const normalized = trimmed(value);
  if (normalized === undefined || !/^\d+$/u.test(normalized)) {
    return undefined;
  }
  return Number.parseInt(normalized, 10);
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
/** Per-request long-poll wait cap, keeping every HTTP request comfortably short-lived. */
const MAX_LONG_POLL_WAIT_MS = 25_000;
const MAX_BODY_BYTES = 64 * 1024;

type AskStatus = "pending" | "answered" | "expired" | "cancelled";
export type AskAnswerKind = "text" | "callback";

interface AskSnapshot {
  readonly status: AskStatus;
  readonly answer?: string;
}

interface PendingAsk {
  readonly askId: string;
  readonly conversationId: string;
  readonly answerKind: AskAnswerKind;
  status: AskStatus;
  answer?: string;
  expiryTimer: ReturnType<typeof setTimeout>;
  readonly waiters: Set<(snapshot: AskSnapshot) => void>;
}

/** Strip the daily-rollover `#bucket` suffix so registry keys match the channel's base id. */
function normalizeConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

function channelIdOf(conversationId: string): string {
  return conversationId.split(":", 1)[0] ?? conversationId;
}

export async function startInteractionBridge(
  options: InteractionBridgeOptions = {},
): Promise<InteractionBridgeHandle> {
  const host = options.host ?? "127.0.0.1";
  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_USER_TIMEOUT_MS;
  const token = randomBytes(24).toString("base64url");
  const sinks = new Map<string, ChannelInteractionSink>();
  // One pending ask per conversation; a second concurrent ask is a 409 by design
  // (the model must consolidate its questions instead of stacking them).
  const asksByConversation = new Map<string, PendingAsk>();
  const asksById = new Map<string, PendingAsk>();
  let askCounter = 0;

  function settleAsk(ask: PendingAsk, status: Exclude<AskStatus, "pending">, answer?: string): void {
    if (ask.status !== "pending") {
      return;
    }
    ask.status = status;
    if (answer !== undefined) {
      ask.answer = answer;
    }
    clearTimeout(ask.expiryTimer);
    asksByConversation.delete(ask.conversationId);
    const snapshot = snapshotOf(ask);
    for (const waiter of ask.waiters) {
      waiter(snapshot);
    }
    ask.waiters.clear();
  }

  function snapshotOf(ask: PendingAsk): AskSnapshot {
    return ask.status === "answered" && ask.answer !== undefined
      ? { status: ask.status, answer: ask.answer }
      : { status: ask.status };
  }

  function registerAsk(
    conversationId: string,
    question: string,
    timeoutMs: number,
    answerKind: AskAnswerKind,
  ): PendingAsk {
    askCounter += 1;
    const askId = `ask-${String(askCounter)}-${randomBytes(6).toString("base64url")}`;
    const ask: PendingAsk = {
      askId,
      conversationId,
      answerKind,
      status: "pending",
      waiters: new Set(),
      expiryTimer: setTimeout(() => settleAsk(ask, "expired"), timeoutMs),
    };
    ask.expiryTimer.unref?.();
    asksByConversation.set(conversationId, ask);
    asksById.set(askId, ask);
    return ask;
  }

  async function handleCreateAsk(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const conversationIdRaw = stringField(body, "conversationId");
    const question = stringField(body, "question");
    if (conversationIdRaw === undefined || question === undefined) {
      sendJson(response, 400, { error: "conversationId and question are required." });
      return;
    }
    const conversationId = normalizeConversationId(conversationIdRaw);
    const sink = sinks.get(channelIdOf(conversationId));
    if (sink === undefined) {
      sendJson(response, 501, {
        error: `no interactive channel is registered for "${channelIdOf(conversationId)}" — ask in your final reply instead.`,
      });
      return;
    }
    if (asksByConversation.has(conversationId)) {
      sendJson(response, 409, { error: "a question is already pending on this conversation; wait for its answer." });
      return;
    }
    const requested = numberField(body, "timeoutMs");
    const postQuestion = booleanField(body, "postQuestion") ?? true;
    const answerKind = answerKindField(body, "answerKind") ?? "text";
    // The config value is both the default and the ceiling: tools may wait less,
    // never more, than the operator allowed.
    const timeoutMs = Math.min(requested ?? askTimeoutMs, askTimeoutMs);
    const ask = registerAsk(conversationId, question, timeoutMs, answerKind);
    let createResponseCompleted = false;
    let createRequestAbandoned = false;
    const abandonUnacknowledgedAsk = (): void => {
      if (createResponseCompleted || createRequestAbandoned) {
        return;
      }
      createRequestAbandoned = true;
      request.removeListener("aborted", abandonUnacknowledgedAsk);
      response.removeListener("close", abandonUnacknowledgedAsk);
      settleAsk(ask, "cancelled");
      asksById.delete(ask.askId);
    };
    request.once("aborted", abandonUnacknowledgedAsk);
    response.once("close", abandonUnacknowledgedAsk);
    const completeCreateResponse = (statusCode: number, payload: unknown): void => {
      if (createRequestAbandoned) {
        return;
      }
      sendJson(response, statusCode, payload);
      // `sendJson` calls `response.end()` synchronously. Mark ownership released
      // only after that succeeds, then detach the premature-close guards so the
      // normal response lifecycle cannot delete an acknowledged pending ask.
      createResponseCompleted = true;
      request.removeListener("aborted", abandonUnacknowledgedAsk);
      response.removeListener("close", abandonUnacknowledgedAsk);
    };
    if (postQuestion) {
      try {
        await sink.postQuestion(conversationId, question);
      } catch (error) {
        if (createRequestAbandoned) {
          return;
        }
        settleAsk(ask, "cancelled");
        asksById.delete(ask.askId);
        options.logger?.warn?.("interaction bridge: posting the ask question failed.", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
        completeCreateResponse(502, { error: "posting the question to the channel failed." });
        return;
      }
    }
    completeCreateResponse(201, { askId: ask.askId, timeoutMs });
  }

  function handleAwaitAsk(request: IncomingMessage, response: ServerResponse, askId: string, url: URL): void {
    const ask = asksById.get(askId);
    if (ask === undefined) {
      sendJson(response, 404, { error: "unknown askId." });
      return;
    }
    if (ask.status !== "pending") {
      // Terminal snapshots are single-consumer: the asking tool reads it once.
      asksById.delete(askId);
      sendJson(response, 200, snapshotOf(ask));
      return;
    }
    const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs")) || 0, 0), MAX_LONG_POLL_WAIT_MS);
    if (waitMs === 0) {
      sendJson(response, 200, snapshotOf(ask));
      return;
    }
    let settled = false;
    const respond = (snapshot: AskSnapshot): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(pollTimer);
      ask.waiters.delete(respond);
      if (snapshot.status !== "pending") {
        asksById.delete(askId);
      }
      sendJson(response, 200, snapshot);
    };
    const pollTimer = setTimeout(() => respond({ status: "pending" }), waitMs);
    pollTimer.unref?.();
    ask.waiters.add(respond);
    request.on("close", () => {
      clearTimeout(pollTimer);
      ask.waiters.delete(respond);
    });
  }

  async function handleProgress(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const conversationIdRaw = stringField(body, "conversationId");
    const key = stringField(body, "key");
    const message = stringField(body, "message");
    if (conversationIdRaw === undefined || key === undefined || message === undefined) {
      sendJson(response, 400, { error: "conversationId, key, and message are required." });
      return;
    }
    const state = stringField(body, "state");
    const conversationId = normalizeConversationId(conversationIdRaw);
    const sink = sinks.get(channelIdOf(conversationId));
    if (sink === undefined) {
      sendJson(response, 501, { error: "no interactive channel is registered for this conversation." });
      return;
    }
    // Accepted before delivery: progress is best-effort by contract and a slow
    // channel edit must not stall the reporting tool.
    sendJson(response, 202, { ok: true });
    void sink
      .postStatus(conversationId, message, {
        key,
        state: state === "done" || state === "failed" ? state : "working",
      })
      .catch((error: unknown) => {
        options.logger?.debug?.("interaction bridge: progress post failed (best-effort).", {
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  const server = createServer((request, response) => {
    void routeRequest(request, response).catch((error: unknown) => {
      options.logger?.warn?.("interaction bridge: request handling failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal error." });
      } else {
        response.end();
      }
    });
  });

  async function routeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "missing or invalid bearer token." });
      return;
    }
    const url = new URL(request.url ?? "/", "http://bridge.local");
    if (request.method === "POST" && url.pathname === "/v1/asks") {
      await handleCreateAsk(request, response);
      return;
    }
    const askMatch = /^\/v1\/asks\/([^/]+)$/u.exec(url.pathname);
    if (askMatch !== null && request.method === "GET") {
      handleAwaitAsk(request, response, askMatch[1] as string, url);
      return;
    }
    if (askMatch !== null && request.method === "DELETE") {
      const ask = asksById.get(askMatch[1] as string);
      if (ask !== undefined) {
        settleAsk(ask, "cancelled");
        asksById.delete(ask.askId);
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/progress") {
      await handleProgress(request, response);
      return;
    }
    sendJson(response, 404, { error: "unknown route." });
  }

  await listenOn(server, host, options.port ?? DEFAULT_INTERACTION_BRIDGE_PORT);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = formatInteractionBridgeUrl(host, port);

  return {
    url,
    token,
    registerSink(channelId, sink) {
      sinks.set(channelId, sink);
    },
    tryResolveAsk(conversationId, answer, answerKind = "text") {
      const ask = asksByConversation.get(normalizeConversationId(conversationId));
      if (ask === undefined) {
        return false;
      }
      if (ask.answerKind !== answerKind) {
        return false;
      }
      settleAsk(ask, "answered", answer);
      return true;
    },
    hasPendingAsk(conversationId) {
      return asksByConversation.has(normalizeConversationId(conversationId));
    },
    cancelAsks(conversationId) {
      const ask = asksByConversation.get(normalizeConversationId(conversationId));
      if (ask !== undefined) {
        settleAsk(ask, "cancelled");
      }
    },
    env() {
      return {
        MONO_AGENT_INTERACTION_BRIDGE_URL: url,
        MONO_AGENT_INTERACTION_BRIDGE_TOKEN: token,
        MONO_AGENT_ASK_USER_TIMEOUT_MS: String(askTimeoutMs),
      };
    },
    async stop() {
      for (const ask of asksById.values()) {
        settleAsk(ask, "cancelled");
      }
      asksById.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      });
    },
  };
}

async function listenOn(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large.");
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function answerKindField(body: Record<string, unknown>, key: string): AskAnswerKind | undefined {
  const value = body[key];
  return value === "text" || value === "callback" ? value : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(payload);
}
