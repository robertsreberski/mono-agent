import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

import {
  BufferedMessageStream,
  isAgentResponseCancelledError,
  type AgentAttachment,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
  type AgentStreamEvent,
} from "@mono-agent/agent-contracts";
import {
  assertSafeBind,
  bearerTokensEqual,
  close,
  hostForUrl,
  isLoopbackHost,
  isWildcardHost,
  listen,
  normalizeHostForBind,
  readAuthorizationBearer,
} from "@mono-agent/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  DEFAULT_BASE_PATH,
  DEFAULT_HOST,
  DEFAULT_MODEL_ID,
  DEFAULT_PORT,
} from "./constants.js";
import { OpenAIApiAdapterError } from "./errors.js";

export interface OpenAIApiRequestMetadata {
  readonly requestId: string;
  readonly model: string;
  readonly stream: boolean;
  readonly method: string;
  readonly path: string;
  readonly receivedAt: string;
  readonly remoteAddress?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly parameters: Record<string, unknown>;
  readonly attachments?: OpenAIApiAttachmentMetadata;
}

export type OpenAIApiAttachmentUrlKind = "data" | "remote" | "file" | "other";
export type OpenAIApiImageDetail = "auto" | "low" | "high";

export interface OpenAIApiImageAttachment {
  readonly type: "image";
  readonly source: "image_url";
  readonly url: string;
  readonly urlKind: OpenAIApiAttachmentUrlKind;
  readonly mediaType?: string;
  readonly detail?: OpenAIApiImageDetail;
  readonly messageRole: string;
  readonly messageIndex: number;
  readonly contentPartIndex: number;
}

export type OpenAIApiAttachment = OpenAIApiImageAttachment;

export interface OpenAIApiImageAttachmentMetadata {
  readonly type: "image";
  readonly source: "image_url";
  readonly urlKind: OpenAIApiAttachmentUrlKind;
  readonly mediaType?: string;
  readonly detail?: OpenAIApiImageDetail;
  readonly messageRole: string;
  readonly messageIndex: number;
  readonly contentPartIndex: number;
}

export interface OpenAIApiAttachmentMetadata {
  readonly count: number;
  readonly images: readonly OpenAIApiImageAttachmentMetadata[];
}

export interface OpenAIApiChatRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
  readonly abortSignal: AbortSignal;
  readonly metadata: {
    readonly openaiApi: OpenAIApiRequestMetadata;
    readonly [key: string]: unknown;
  };
}

export interface OpenAIApiAdapterLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface OpenAIApiAdapterOptions {
  readonly host?: string;
  readonly port?: number;
  readonly basePath?: string;
  readonly allowNonLoopback?: boolean;
  readonly apiKey?: string;
  readonly modelId?: string;
  readonly responder: AgentResponder<OpenAIApiChatRequest, AgentMessageStream, AgentResponse>;
  readonly logger?: OpenAIApiAdapterLogger;
}

export interface OpenAIApiAdapterStartResult {
  /** Primary usable origin (loopback for wildcard binds), never an unspecified address. */
  readonly url: string;
  readonly baseUrl: string;
  /** Every concrete loopback/private-LAN/Tailscale base URL discovered for this bind. */
  readonly baseUrls: readonly string[];
  readonly modelsUrl: string;
  readonly chatCompletionsUrl: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

interface NormalizedChatBody {
  readonly model: string;
  readonly text: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
  readonly stream: boolean;
  readonly conversationId: string;
  readonly parameters: Record<string, unknown>;
}

interface ChatCompletionChunkInput {
  readonly id: string;
  readonly created: number;
  readonly model: string;
}

const OPENAI_OWNED_BY = "host";
const FORCE_CLOSE_AFTER_MS = 250;
const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);
const UNSUPPORTED_CHAT_REQUEST_FIELDS = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "audio",
  "modalities",
] as const;

export async function startOpenAIApiAdapter(
  options: OpenAIApiAdapterOptions,
): Promise<OpenAIApiAdapterStartResult> {
  validateOptions(options);
  const host = normalizeHostForBind(options.host ?? DEFAULT_HOST);
  const port = options.port ?? DEFAULT_PORT;
  const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const modelId = normalizeOptionalString(options.modelId) ?? DEFAULT_MODEL_ID;
  const apiKey = normalizeOptionalString(options.apiKey);
  assertSafeBind(host, options.allowNonLoopback === true, (boundHost) =>
    new OpenAIApiAdapterError(
      "unsafe_host",
      "OpenAI API adapter refuses to bind a non-loopback host unless allowNonLoopback is true.",
      { host: boundHost },
    ));
  if (!isLoopbackHost(host) && apiKey === undefined) {
    throw new OpenAIApiAdapterError(
      "missing_required_config",
      "OpenAI API adapter requires an API key for every non-loopback bind.",
      { host },
    );
  }

  const app = express();
  const server = createServer(app);
  const activeRequests = new Set<AbortController>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const modelsPath = `${basePath}/models`;
  const chatCompletionsPath = `${basePath}/chat/completions`;
  const basePostPath = basePath.length === 0 ? "/" : basePath;

  app.use(express.json({ limit: "1mb" }));
  app.get(modelsPath, (req, res) => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    res.status(200).json({
      object: "list",
      data: [
        {
          id: modelId,
          object: "model",
          created: 0,
          owned_by: OPENAI_OWNED_BY,
        },
      ],
    });
  });
  const chatCompletionHandler = (req: Request, res: Response): void => {
    if (!authorize(req, res, apiKey)) {
      return;
    }
    void handleChatCompletion(req, res).catch((error: unknown) => {
      const isClientError = error instanceof OpenAIApiAdapterError && error.code === "invalid_request";
      options.logger?.[isClientError ? "warn" : "error"]?.("OpenAI API chat completion failed before response.", {
        error: errorToMessage(error),
      });
      if (!res.headersSent) {
        sendOpenAIError(
          res,
          isClientError ? 400 : 500,
          errorToMessage(error),
          isClientError ? "invalid_request" : "server_error",
        );
      }
    });
  };
  app.post(chatCompletionsPath, chatCompletionHandler);
  app.post(basePostPath, chatCompletionHandler);
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    sendOpenAIError(res, 400, errorToMessage(error), "invalid_request_error");
  });

  const address = await listen(server, port, host, {
    listenFailed: (reason) =>
      new OpenAIApiAdapterError("start_failed", "OpenAI API adapter failed to listen.", { reason }),
    noAddress: () =>
      new OpenAIApiAdapterError("start_failed", "OpenAI API adapter did not receive a TCP address."),
  });
  const boundPort = address.port;

  async function handleChatCompletion(req: Request, res: Response): Promise<void> {
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const body = normalizeChatBody(req.body, req.headers, requestId, modelId);
    const controller = new AbortController();
    activeRequests.add(controller);
    // Inline base64 data: image_url parts into the shared attachments contract so
    // they reach the agent through the generic responder/harness path (the
    // imageAttachments field alone is not forwarded). Remote/file URL images are
    // not downloaded here; they remain in metadata only.
    const agentAttachments = agentAttachmentsFromImages(body.imageAttachments);
    const request: OpenAIApiChatRequest = {
      conversationId: body.conversationId,
      text: body.text,
      imageAttachments: body.imageAttachments,
      ...(agentAttachments.length === 0 ? {} : { attachments: agentAttachments }),
      abortSignal: controller.signal,
      metadata: {
        openaiApi: {
          requestId,
          model: body.model,
          stream: body.stream,
          method: req.method,
          path: req.path,
          receivedAt,
          ...(req.socket.remoteAddress === undefined ? {} : { remoteAddress: req.socket.remoteAddress }),
          headers: sanitizeRequestHeaders(req.headers),
          parameters: body.parameters,
          ...(body.imageAttachments.length === 0 ? {} : { attachments: summarizeAttachments(body.imageAttachments) }),
        },
      },
    };

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("OpenAI API client disconnected."));
      }
    });

    try {
      if (stopping) {
        controller.abort(new Error("OpenAI API adapter is stopping."));
      }
      if (body.stream) {
        await runStreamingResponder({ request, response: res, requestId, model: body.model, options });
        return;
      }

      await runJsonResponder({ request, response: res, requestId, model: body.model, options });
    } finally {
      activeRequests.delete(controller);
    }
  }

  if (options.allowNonLoopback !== true && !isLoopbackHost(address.address)) {
    await close(server);
    throw new OpenAIApiAdapterError(
      "unsafe_host",
      "OpenAI API adapter resolved a loopback host to a non-loopback bind address.",
      { host, boundAddress: address.address },
    );
  }

  const origins = advertisedOrigins(host, boundPort);
  const url = origins[0] ?? `http://${hostForUrl(host)}:${boundPort}`;
  const baseUrls = origins.map((origin) => `${origin}${basePath}`);

  return {
    url,
    baseUrl: `${url}${basePath}`,
    baseUrls,
    modelsUrl: `${url}${modelsPath}`,
    chatCompletionsUrl: `${url}${chatCompletionsPath}`,
    host,
    port: boundPort,
    stop() {
      stopPromise ??= (async () => {
        stopping = true;
        for (const controller of activeRequests) {
          controller.abort(new Error("OpenAI API adapter stopped."));
        }
        await closeServerBounded(server);
        activeRequests.clear();
      })();
      return stopPromise;
    },
  };
}

function advertisedOrigins(host: string, port: number): readonly string[] {
  const hosts = isWildcardHost(host)
    ? [host.includes(":") ? "::1" : "127.0.0.1", ...discoverPrivateIpv4Addresses()]
    : [host];
  return [...new Set(hosts)].map((entry) => `http://${hostForUrl(entry)}:${port}`);
}

function discoverPrivateIpv4Addresses(): readonly string[] {
  const addresses: string[] = [];
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (!entry.internal && entry.family === "IPv4" && isLanOrTailscaleIpv4(entry.address)) {
          addresses.push(entry.address);
        }
      }
    }
  } catch {
    return [];
  }
  return addresses.sort((left, right) => left.localeCompare(right));
}

function isLanOrTailscaleIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

async function closeServerBounded(server: ReturnType<typeof createServer>): Promise<void> {
  const closePromise = close(server);
  void closePromise.catch(() => undefined);
  server.closeIdleConnections();
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const force = new Promise<"forced">((resolvePromise) => {
    forceTimer = setTimeout(() => {
      server.closeAllConnections();
      resolvePromise("forced");
    }, FORCE_CLOSE_AFTER_MS);
    forceTimer.unref?.();
  });
  const outcome = await Promise.race([closePromise.then(() => "closed" as const), force]);
  if (outcome === "closed") {
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
    }
    return;
  }
  await Promise.race([
    closePromise.catch(() => undefined),
    new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, FORCE_CLOSE_AFTER_MS);
      timer.unref?.();
    }),
  ]);
}

async function runJsonResponder(input: {
  readonly request: OpenAIApiChatRequest;
  readonly response: Response;
  readonly requestId: string;
  readonly model: string;
  readonly options: OpenAIApiAdapterOptions;
}): Promise<void> {
  const stream = new BufferedMessageStream({
    onClosed: () =>
      new OpenAIApiAdapterError("invalid_config", "Cannot write to a finished OpenAI API stream."),
  });
  try {
    const response = await input.options.responder.respond(input.request, stream);
    await stream.finish(response.text);
    input.response.status(200).json(chatCompletion({
      id: `chatcmpl-${input.requestId}`,
      model: input.model,
      content: stream.text,
    }));
  } catch (error) {
    const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
    input.options.logger?.[cancelled ? "warn" : "error"]?.("OpenAI API responder failed.", {
      requestId: input.requestId,
      conversationId: input.request.conversationId,
      error: errorToMessage(error),
    });
    sendOpenAIError(
      input.response,
      cancelled ? 499 : 500,
      errorToMessage(error),
      cancelled ? "request_cancelled" : "server_error",
    );
  }
}

async function runStreamingResponder(input: {
  readonly request: OpenAIApiChatRequest;
  readonly response: Response;
  readonly requestId: string;
  readonly model: string;
  readonly options: OpenAIApiAdapterOptions;
}): Promise<void> {
  input.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Disable Nagle's algorithm on the underlying socket. SSE writes are many tiny
  // chunks (often a single token); with Nagle on, the kernel coalesces them into
  // larger TCP segments, so the client receives the reply in bursts that look
  // "all at once" instead of streaming token-by-token. setNoDelay flushes each
  // chunk immediately.
  input.response.socket?.setNoDelay(true);
  // Flush the response headers before awaiting the (potentially slow) responder
  // so the client sees the stream open promptly. We deliberately do NOT write a
  // leading SSE comment (": open") here: some OpenAI-compatible clients
  // (e.g. Open WebUI) mishandle a comment that precedes the first data chunk,
  // and real OpenAI streams never send one. The first `data:` chunk (the
  // assistant-role delta) is the stream's opening signal.
  input.response.flushHeaders();

  const chunkInput = {
    id: `chatcmpl-${input.requestId}`,
    created: Math.floor(Date.now() / 1000),
    model: input.model,
  };
  const stream = new SseChatMessageStream(input.response, chunkInput);
  stream.start();

  try {
    const response = await input.options.responder.respond(input.request, stream);
    await stream.finish(response.text);
  } catch (error) {
    const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
    input.options.logger?.[cancelled ? "warn" : "error"]?.("OpenAI API streaming responder failed.", {
      requestId: input.requestId,
      conversationId: input.request.conversationId,
      error: errorToMessage(error),
    });
    stream.error(errorToMessage(error), cancelled ? "request_cancelled" : "server_error");
  }
}

class SseChatMessageStream implements AgentMessageStream {
  private currentText = "";
  private done = false;
  private started = false;
  private lastReasoningContent: string | undefined;
  private readonly activeTools = new Map<string, {
    readonly name: string;
    readonly arguments?: unknown;
  }>();

  constructor(
    private readonly response: Response,
    private readonly chunkInput: ChatCompletionChunkInput,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.writeChunk({ role: "assistant" }, null);
  }

  async status(_text: string): Promise<void> {}

  async event(event: AgentStreamEvent): Promise<void> {
    this.assertOpen();
    if (event.type === "assistant_thought") {
      if (event.text.length > 0) {
        this.writeChunk({ reasoning_content: event.text }, null);
        this.lastReasoningContent = event.text;
      } else {
        this.lastReasoningContent = undefined;
      }
      return;
    }
    if (event.type === "tool_call_started") {
      this.activeTools.set(event.id, {
        name: event.name,
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
      });
      const progressText = `Running ${event.name}...`;
      if (this.lastReasoningContent !== progressText) {
        this.writeChunk({ reasoning_content: progressText }, null);
      }
      this.lastReasoningContent = undefined;
      return;
    }
    if (event.type === "tool_call_completed") {
      this.lastReasoningContent = undefined;
      const started = this.activeTools.get(event.id);
      const name = event.name ?? started?.name ?? "tool";
      const args = event.arguments ?? started?.arguments ?? {};
      this.activeTools.delete(event.id);
      this.writeChunk({
        content: openWebUIToolDetails({
          id: event.id,
          name,
          arguments: args,
          result: event.content,
          isError: event.isError === true,
        }),
      }, null);
      return;
    }
    if (event.type === "runtime_warning") {
      this.lastReasoningContent = undefined;
      this.writeChunk({ reasoning_content: `Warning: ${event.message}` }, null);
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    this.lastReasoningContent = undefined;
    if (delta.length === 0) {
      return;
    }
    this.currentText += delta;
    this.writeChunk({ content: delta }, null);
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.lastReasoningContent = undefined;
    const delta = text.startsWith(this.currentText) ? text.slice(this.currentText.length) : text;
    this.currentText = text;
    if (delta.length > 0) {
      this.writeChunk({ content: delta }, null);
    }
  }

  async finish(finalText?: string): Promise<void> {
    if (this.done) {
      return;
    }
    if (finalText !== undefined) {
      await this.finishFinalText(finalText);
    }
    this.done = true;
    this.writeChunk({}, "stop");
    this.response.write("data: [DONE]\n\n");
    this.response.end();
  }

  private async finishFinalText(finalText: string): Promise<void> {
    if (finalText.length === 0 || finalText === this.currentText) {
      return;
    }
    if (this.currentText.length === 0) {
      await this.append(finalText);
      return;
    }
    if (finalText.startsWith(this.currentText)) {
      await this.append(finalText.slice(this.currentText.length));
    }
  }

  error(message: string, code: "request_cancelled" | "server_error"): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.response.write(`data: ${JSON.stringify({ error: openAIError(message, code) })}\n\n`);
    this.response.write("data: [DONE]\n\n");
    this.response.end();
  }

  private writeChunk(
    delta: Record<string, unknown>,
    finishReason: "stop" | null,
  ): void {
    this.response.write(`data: ${JSON.stringify({
      id: this.chunkInput.id,
      object: "chat.completion.chunk",
      created: this.chunkInput.created,
      model: this.chunkInput.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    })}\n\n`);
  }

  private assertOpen(): void {
    if (this.done) {
      throw new OpenAIApiAdapterError("invalid_config", "Cannot write to a finished OpenAI API stream.");
    }
  }
}

function normalizeChatBody(
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
  requestId: string,
  expectedModel: string,
): NormalizedChatBody {
  if (!isRecord(body)) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion body must be a JSON object.");
  }
  const model = normalizeOptionalString(body.model);
  if (model === undefined) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion body requires a non-empty model.");
  }
  if (model !== expectedModel) {
    throw new OpenAIApiAdapterError("invalid_request", `Chat completion model must be ${expectedModel}.`);
  }
  assertNoUnsupportedChatRequestFields(body);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion body requires at least one message.");
  }
  const messages = body.messages.map(parseChatMessage);
  const conversationId = readConversationId(body, headers);
  // A stable conversation id means the harness already carries the
  // transcript (history store + provider sessions), so only the trailing
  // user turn is sent; resending the full transcript would double the
  // context. body.user is excluded below: it identifies a user, not a
  // chat, so user-keyed transcripts keep full-flatten semantics.
  const input = (conversationId === undefined ? undefined : latestUserTurn(messages))
    ?? flattenTranscript(messages);
  if (input.text.length === 0 && input.imageAttachments.length === 0) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages must include text or image content.");
  }
  return {
    model,
    text: input.text,
    imageAttachments: input.imageAttachments,
    stream: body.stream === true,
    conversationId: conversationId ?? normalizeOptionalString(body.user) ?? `openai-api:${requestId}`,
    parameters: readParameters(body),
  };
}

interface ParsedChatMessage {
  readonly role: string;
  readonly content: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
}

interface NormalizedChatInput {
  readonly text: string;
  readonly imageAttachments: readonly OpenAIApiAttachment[];
}

function parseChatMessage(value: unknown, messageIndex: number): ParsedChatMessage {
  if (!isRecord(value)) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages must be JSON objects.");
  }
  const role = normalizeOptionalString(value.role);
  if (role === undefined) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages require a role.");
  }
  if (hasOwn(value, "tool_calls") || hasOwn(value, "function_call")) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion message tool/function calls are not supported.");
  }
  const content = normalizeContent(value.content, { messageIndex, messageRole: role });
  return { role, content: content.text, imageAttachments: content.imageAttachments };
}

function flattenTranscript(messages: readonly ParsedChatMessage[]): NormalizedChatInput {
  const text = messages
    .filter((message) => message.content.length > 0)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return {
    text,
    imageAttachments: messages.flatMap((message) => message.imageAttachments),
  };
}

function latestUserTurn(messages: readonly ParsedChatMessage[]): NormalizedChatInput | undefined {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant === -1) {
    // First turn: no assistant reply yet, so the transcript (including any
    // client system prompt) has never been delivered — send it whole once.
    return undefined;
  }
  const trailing = messages
    .slice(lastAssistant + 1)
    .filter((message) => message.role === "user" && (message.content.length > 0 || message.imageAttachments.length > 0));
  if (trailing.length === 0) {
    return undefined;
  }
  return {
    text: trailing
      .map((message) => message.content)
      .filter((content) => content.length > 0)
      .join("\n"),
    imageAttachments: trailing.flatMap((message) => message.imageAttachments),
  };
}

function normalizeContent(
  value: unknown,
  context: { readonly messageIndex: number; readonly messageRole: string },
): { readonly text: string; readonly imageAttachments: readonly OpenAIApiAttachment[] } {
  if (typeof value === "string") {
    return { text: value, imageAttachments: [] };
  }
  if (value === null || value === undefined) {
    return { text: "", imageAttachments: [] };
  }
  if (Array.isArray(value)) {
    const textParts: string[] = [];
    const imageAttachments: OpenAIApiAttachment[] = [];
    value.forEach((part, contentPartIndex) => {
      if (!isRecord(part)) {
        throw new OpenAIApiAdapterError("invalid_request", "Chat completion message content parts must be JSON objects.");
      }
      const type = normalizeOptionalString(part.type);
      if (type === "text") {
        if (typeof part.text !== "string") {
          throw new OpenAIApiAdapterError("invalid_request", "Chat completion text content parts require string text.");
        }
        if (part.text.length > 0) {
          textParts.push(part.text);
        }
        return;
      }
      if (type === "image_url") {
        imageAttachments.push(normalizeImageAttachment(part, { ...context, contentPartIndex }));
        return;
      }
      throw new OpenAIApiAdapterError("invalid_request", `Chat completion message content part type ${String(part.type)} is not supported.`);
    });
    return {
      text: textParts.join("\n"),
      imageAttachments,
    };
  }
  throw new OpenAIApiAdapterError("invalid_request", "Chat completion message content must be a string or text/image content parts.");
}

function normalizeImageAttachment(
  part: Record<string, unknown>,
  context: {
    readonly messageIndex: number;
    readonly messageRole: string;
    readonly contentPartIndex: number;
  },
): OpenAIApiImageAttachment {
  if (!isRecord(part.image_url)) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion image_url content parts require an image_url object.");
  }
  const url = normalizeOptionalString(part.image_url.url);
  if (url === undefined) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion image_url content parts require a non-empty image_url.url.");
  }
  const detail = normalizeImageDetail(part.image_url.detail);
  const mediaType = mediaTypeFromDataUrl(url);
  return {
    type: "image",
    source: "image_url",
    url,
    urlKind: classifyAttachmentUrl(url),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(detail === undefined ? {} : { detail }),
    messageRole: context.messageRole,
    messageIndex: context.messageIndex,
    contentPartIndex: context.contentPartIndex,
  };
}

function normalizeImageDetail(value: unknown): OpenAIApiImageDetail | undefined {
  if (value === undefined) {
    return undefined;
  }
  const detail = normalizeOptionalString(value);
  if (detail === "auto" || detail === "low" || detail === "high") {
    return detail;
  }
  throw new OpenAIApiAdapterError("invalid_request", "Chat completion image_url.detail must be auto, low, or high.");
}

function classifyAttachmentUrl(url: string): OpenAIApiAttachmentUrlKind {
  if (url.startsWith("data:")) {
    return "data";
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return "remote";
  }
  if (url.startsWith("file-")) {
    return "file";
  }
  return "other";
}

function mediaTypeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/iu.exec(url);
  return match?.[1]?.toLowerCase();
}

/**
 * Convert base64 `data:` image_url parts into the shared {@link AgentAttachment}
 * contract so they flow to the agent through the generic responder. Non-base64
 * and remote/file URL images are skipped (no download is performed here).
 */
function agentAttachmentsFromImages(images: readonly OpenAIApiAttachment[]): AgentAttachment[] {
  const attachments: AgentAttachment[] = [];
  for (const image of images) {
    if (image.urlKind !== "data") {
      continue;
    }
    const parsed = parseBase64DataUrl(image.url);
    if (parsed === undefined) {
      continue;
    }
    attachments.push({ kind: "image", mimeType: parsed.mediaType, data: parsed.base64 });
  }
  return attachments;
}

function parseBase64DataUrl(url: string): { mediaType: string; base64: string } | undefined {
  // data:[<mediaType>][;<param>=<value>]*[;base64],<data>. Split on the FIRST
  // comma so parameterized media types (e.g. image/png;charset=utf-8;base64) are
  // handled the same way mediaTypeFromDataUrl reads them. Only base64-encoded
  // payloads become attachments (raw/url-encoded data is not inlined).
  const match = /^data:([^,]*),([\s\S]*)$/iu.exec(url);
  if (match === null) {
    return undefined;
  }
  const meta = match[1] ?? "";
  if (!/;base64$/iu.test(meta)) {
    return undefined;
  }
  const base64 = (match[2] ?? "").trim();
  if (base64.length === 0) {
    return undefined;
  }
  const mediaType = (meta.split(";")[0] || "application/octet-stream").toLowerCase();
  return { mediaType, base64 };
}

function summarizeAttachments(attachments: readonly OpenAIApiAttachment[]): OpenAIApiAttachmentMetadata {
  const images = attachments.map((attachment) => ({
    type: attachment.type,
    source: attachment.source,
    urlKind: attachment.urlKind,
    ...(attachment.mediaType === undefined ? {} : { mediaType: attachment.mediaType }),
    ...(attachment.detail === undefined ? {} : { detail: attachment.detail }),
    messageRole: attachment.messageRole,
    messageIndex: attachment.messageIndex,
    contentPartIndex: attachment.contentPartIndex,
  }));
  return {
    count: attachments.length,
    images,
  };
}

function assertNoUnsupportedChatRequestFields(body: Record<string, unknown>): void {
  for (const field of UNSUPPORTED_CHAT_REQUEST_FIELDS) {
    if (hasOwn(body, field)) {
      throw new OpenAIApiAdapterError("invalid_request", `Chat completion request field ${field} is not supported.`);
    }
  }
}

// Open WebUI strips metadata from bodies it sends to OpenAI-compatible
// backends, but forwards the chat id as a header when
// ENABLE_FORWARD_USER_INFO_HEADERS is enabled. x-conversation-id is the
// generic equivalent for other proxies. Node lowercases incoming names.
const CONVERSATION_ID_HEADERS = ["x-openwebui-chat-id", "x-conversation-id"] as const;

function readConversationId(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const candidates = [
    metadata.conversation_id,
    metadata.conversationId,
    metadata.chat_id,
    metadata.chatId,
    body.conversation_id,
    body.conversationId,
    ...CONVERSATION_ID_HEADERS.map((name) => firstHeaderValue(headers[name])),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readParameters(body: Record<string, unknown>): Record<string, unknown> {
  const parameterKeys = [
    "temperature",
    "top_p",
    "max_tokens",
    "max_completion_tokens",
    "stop",
    "seed",
    "logit_bias",
    "presence_penalty",
    "frequency_penalty",
  ];
  const parameters: Record<string, unknown> = {};
  for (const key of parameterKeys) {
    if (body[key] !== undefined) {
      parameters[key] = body[key];
    }
  }
  return parameters;
}

function chatCompletion(input: {
  readonly id: string;
  readonly model: string;
  readonly content: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function sanitizeRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const sanitized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase())) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function authorize(req: Request, res: Response, apiKey: string | undefined): boolean {
  if (apiKey === undefined) {
    return true;
  }
  const presented = readAuthorizationBearer(req.header("authorization"));
  if (presented !== undefined && bearerTokensEqual(presented, apiKey)) {
    return true;
  }
  sendOpenAIError(res, 401, "Invalid API key.", "invalid_api_key");
  return false;
}

function sendOpenAIError(
  res: Response,
  status: number,
  message: string,
  code: string,
  type = "invalid_request_error",
): void {
  res.status(status).json({ error: openAIError(message, code, type) });
}

function openAIError(
  message: string,
  code: string,
  type = "invalid_request_error",
): Record<string, unknown> {
  return {
    message,
    type,
    param: null,
    code,
  };
}

function openWebUIToolDetails(input: {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly isError: boolean;
}): string {
  const argumentsJson = stableJson(input.arguments);
  const resultJson = stableJson(input.result ?? null);
  const summary = input.isError ? "Tool Error" : "Tool Executed";
  return [
    `<details type="tool_calls" done="true" id="${escapeHtmlAttribute(input.id)}" name="${escapeHtmlAttribute(input.name)}" arguments="${escapeHtmlAttribute(argumentsJson)}">`,
    `<summary>${summary}</summary>`,
    escapeHtmlText(resultJson),
    "</details>",
    "",
  ].join("\n");
}

function stableJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, "&quot;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function validateOptions(options: OpenAIApiAdapterOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new OpenAIApiAdapterError("missing_required_config", "OpenAI API adapter requires a responder.");
  }
  if (!Number.isInteger(options.port ?? DEFAULT_PORT) || (options.port ?? DEFAULT_PORT) < 0 || (options.port ?? DEFAULT_PORT) > 65535) {
    throw new OpenAIApiAdapterError("invalid_config", "OpenAI API adapter port must be an integer from 0 to 65535.");
  }
  normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  const modelId = normalizeOptionalString(options.modelId) ?? DEFAULT_MODEL_ID;
  if (modelId.length === 0) {
    throw new OpenAIApiAdapterError("invalid_config", "OpenAI API adapter modelId must be non-empty.");
  }
}

function normalizeBasePath(path: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) {
    throw new OpenAIApiAdapterError("invalid_config", "OpenAI API basePath must be an absolute path without query or hash.");
  }
  return normalized.length === 1 ? "" : normalized.replace(/\/+$/u, "");
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
