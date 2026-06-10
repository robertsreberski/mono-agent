import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  BufferedMessageStream,
  isAgentResponseCancelledError,
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
  listen,
  readAuthorizationBearer,
} from "@mono-agent/settings";
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
}

export interface OpenAIApiChatRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
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
  readonly url: string;
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly chatCompletionsUrl: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

interface NormalizedChatBody {
  readonly model: string;
  readonly text: string;
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
  const host = options.host ?? DEFAULT_HOST;
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

  const app = express();
  const server = createServer(app);
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
  const url = `http://${hostForUrl(host)}:${boundPort}`;

  async function handleChatCompletion(req: Request, res: Response): Promise<void> {
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const body = normalizeChatBody(req.body, requestId, modelId);
    const controller = new AbortController();
    const request: OpenAIApiChatRequest = {
      conversationId: body.conversationId,
      text: body.text,
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
        },
      },
    };

    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort(new Error("OpenAI API client disconnected."));
      }
    });

    if (body.stream) {
      await runStreamingResponder({ request, response: res, requestId, model: body.model, options });
      return;
    }

    await runJsonResponder({ request, response: res, requestId, model: body.model, options });
  }

  return {
    url,
    baseUrl: `${url}${basePath}`,
    modelsUrl: `${url}${modelsPath}`,
    chatCompletionsUrl: `${url}${chatCompletionsPath}`,
    host,
    port: boundPort,
    async stop() {
      await close(server);
    },
  };
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
  });

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
      }
      return;
    }
    if (event.type === "tool_call_started") {
      this.activeTools.set(event.id, {
        name: event.name,
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
      });
      return;
    }
    if (event.type === "tool_call_completed") {
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
      this.writeChunk({ reasoning_content: `Warning: ${event.message}` }, null);
    }
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    if (delta.length === 0) {
      return;
    }
    this.currentText += delta;
    this.writeChunk({ content: delta }, null);
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
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

function normalizeChatBody(body: unknown, requestId: string, expectedModel: string): NormalizedChatBody {
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
  const text = body.messages
    .map(normalizeMessage)
    .filter((line) => line.length > 0)
    .join("\n");
  if (text.length === 0) {
    throw new OpenAIApiAdapterError("invalid_request", "Chat completion messages must include text content.");
  }
  return {
    model,
    text,
    stream: body.stream === true,
    conversationId: readConversationId(body, requestId),
    parameters: readParameters(body),
  };
}

function normalizeMessage(value: unknown): string {
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
  const content = normalizeContent(value.content);
  return content.length === 0 ? "" : `${role}: ${content}`;
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!isRecord(part)) {
          throw new OpenAIApiAdapterError("invalid_request", "Chat completion message content parts must be JSON objects.");
        }
        const type = normalizeOptionalString(part.type);
        if (type !== "text") {
          throw new OpenAIApiAdapterError("invalid_request", `Chat completion message content part type ${String(part.type)} is not supported.`);
        }
        if (typeof part.text !== "string") {
          throw new OpenAIApiAdapterError("invalid_request", "Chat completion text content parts require string text.");
        }
        return part.text;
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  throw new OpenAIApiAdapterError("invalid_request", "Chat completion message content must be a string or text content parts.");
}

function assertNoUnsupportedChatRequestFields(body: Record<string, unknown>): void {
  for (const field of UNSUPPORTED_CHAT_REQUEST_FIELDS) {
    if (hasOwn(body, field)) {
      throw new OpenAIApiAdapterError("invalid_request", `Chat completion request field ${field} is not supported.`);
    }
  }
}

function readConversationId(body: Record<string, unknown>, requestId: string): string {
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const candidates = [
    metadata.conversation_id,
    metadata.conversationId,
    metadata.chat_id,
    metadata.chatId,
    body.conversation_id,
    body.conversationId,
    body.user,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return `openai-api:${requestId}`;
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
