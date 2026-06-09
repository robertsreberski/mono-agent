import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isAgentResponseCancelledError, } from "@worklab-ai/agent-contracts";
import express, {} from "express";
export class OpenAIApiAdapterError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = "OpenAIApiAdapterError";
        this.code = code;
        this.details = { ...details, code };
    }
}
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_BASE_PATH = "/v1";
const DEFAULT_MODEL_ID = "mono-agent";
const OPENAI_OWNED_BY = "worklab-ai";
export async function startOpenAIApiAdapter(options) {
    validateOptions(options);
    const host = options.host ?? DEFAULT_HOST;
    const port = options.port ?? DEFAULT_PORT;
    const basePath = normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
    const modelId = normalizeOptionalString(options.modelId) ?? DEFAULT_MODEL_ID;
    const apiKey = normalizeOptionalString(options.apiKey);
    assertSafeBind(host, options.allowNonLoopback === true);
    const app = express();
    const server = createServer(app);
    const modelsPath = `${basePath}/models`;
    const chatCompletionsPath = `${basePath}/chat/completions`;
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
    app.post(chatCompletionsPath, (req, res) => {
        if (!authorize(req, res, apiKey)) {
            return;
        }
        void handleChatCompletion(req, res).catch((error) => {
            options.logger?.error?.("OpenAI API chat completion failed before response.", {
                error: errorToMessage(error),
            });
            if (!res.headersSent) {
                sendOpenAIError(res, 500, errorToMessage(error), "server_error");
            }
        });
    });
    app.use((error, _req, res, next) => {
        if (res.headersSent) {
            next(error);
            return;
        }
        sendOpenAIError(res, 400, errorToMessage(error), "invalid_request_error");
    });
    const address = await listen(server, port, host);
    const boundPort = address.port;
    const url = `http://${hostForUrl(host)}:${boundPort}`;
    async function handleChatCompletion(req, res) {
        const requestId = randomUUID();
        const receivedAt = new Date().toISOString();
        const body = normalizeChatBody(req.body, requestId);
        const controller = new AbortController();
        const request = {
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
                    headers: req.headers,
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
async function runJsonResponder(input) {
    const stream = new InMemoryMessageStream();
    try {
        const response = await input.options.responder.respond(input.request, stream);
        await stream.finish(response.text);
        input.response.status(200).json(chatCompletion({
            id: `chatcmpl-${input.requestId}`,
            model: input.model,
            content: stream.text,
        }));
    }
    catch (error) {
        const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
        input.options.logger?.[cancelled ? "warn" : "error"]?.("OpenAI API responder failed.", {
            requestId: input.requestId,
            conversationId: input.request.conversationId,
            error: errorToMessage(error),
        });
        sendOpenAIError(input.response, cancelled ? 499 : 500, errorToMessage(error), cancelled ? "request_cancelled" : "server_error");
    }
}
async function runStreamingResponder(input) {
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
    }
    catch (error) {
        const cancelled = input.request.abortSignal.aborted || isAgentResponseCancelledError(error);
        input.options.logger?.[cancelled ? "warn" : "error"]?.("OpenAI API streaming responder failed.", {
            requestId: input.requestId,
            conversationId: input.request.conversationId,
            error: errorToMessage(error),
        });
        stream.error(errorToMessage(error), cancelled ? "request_cancelled" : "server_error");
    }
}
class InMemoryMessageStream {
    currentText = "";
    done = false;
    get text() {
        return this.currentText.trim();
    }
    async status(_text) { }
    async append(delta) {
        this.assertOpen();
        this.currentText += delta;
    }
    async replace(text) {
        this.assertOpen();
        this.currentText = text;
    }
    async finish(finalText) {
        if (this.done) {
            return;
        }
        this.done = true;
        if (finalText !== undefined) {
            this.currentText = finalText;
        }
    }
    assertOpen() {
        if (this.done) {
            throw new OpenAIApiAdapterError("invalid_config", "Cannot write to a finished OpenAI API stream.");
        }
    }
}
class SseChatMessageStream {
    response;
    chunkInput;
    currentText = "";
    done = false;
    started = false;
    constructor(response, chunkInput) {
        this.response = response;
        this.chunkInput = chunkInput;
    }
    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.writeChunk({ role: "assistant" }, null);
    }
    async status(_text) { }
    async append(delta) {
        this.assertOpen();
        if (delta.length === 0) {
            return;
        }
        this.currentText += delta;
        this.writeChunk({ content: delta }, null);
    }
    async replace(text) {
        this.assertOpen();
        const delta = text.startsWith(this.currentText) ? text.slice(this.currentText.length) : text;
        this.currentText = text;
        if (delta.length > 0) {
            this.writeChunk({ content: delta }, null);
        }
    }
    async finish(finalText) {
        if (this.done) {
            return;
        }
        if (finalText !== undefined) {
            await this.replace(finalText);
        }
        this.done = true;
        this.writeChunk({}, "stop");
        this.response.write("data: [DONE]\n\n");
        this.response.end();
    }
    error(message, code) {
        if (this.done) {
            return;
        }
        this.done = true;
        this.response.write(`data: ${JSON.stringify({ error: openAIError(message, code) })}\n\n`);
        this.response.write("data: [DONE]\n\n");
        this.response.end();
    }
    writeChunk(delta, finishReason) {
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
    assertOpen() {
        if (this.done) {
            throw new OpenAIApiAdapterError("invalid_config", "Cannot write to a finished OpenAI API stream.");
        }
    }
}
function normalizeChatBody(body, requestId) {
    if (!isRecord(body)) {
        throw new OpenAIApiAdapterError("invalid_config", "Chat completion body must be a JSON object.");
    }
    const model = normalizeOptionalString(body.model);
    if (model === undefined) {
        throw new OpenAIApiAdapterError("invalid_config", "Chat completion body requires a non-empty model.");
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new OpenAIApiAdapterError("invalid_config", "Chat completion body requires at least one message.");
    }
    const text = body.messages
        .map(normalizeMessage)
        .filter((line) => line.length > 0)
        .join("\n");
    if (text.length === 0) {
        throw new OpenAIApiAdapterError("invalid_config", "Chat completion messages must include text content.");
    }
    return {
        model,
        text,
        stream: body.stream === true,
        conversationId: readConversationId(body, requestId),
        parameters: readParameters(body),
    };
}
function normalizeMessage(value) {
    if (!isRecord(value)) {
        throw new OpenAIApiAdapterError("invalid_config", "Chat completion messages must be JSON objects.");
    }
    const role = normalizeOptionalString(value.role);
    if (role === undefined) {
        throw new OpenAIApiAdapterError("invalid_config", "Chat completion messages require a role.");
    }
    const content = normalizeContent(value.content);
    return content.length === 0 ? "" : `${role}: ${content}`;
}
function normalizeContent(value) {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return value
            .map((part) => {
            if (!isRecord(part) || part.type !== "text") {
                return "";
            }
            return typeof part.text === "string" ? part.text : "";
        })
            .filter((text) => text.length > 0)
            .join("\n");
    }
    return "";
}
function readConversationId(body, requestId) {
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
function readParameters(body) {
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
    const parameters = {};
    for (const key of parameterKeys) {
        if (body[key] !== undefined) {
            parameters[key] = body[key];
        }
    }
    return parameters;
}
function chatCompletion(input) {
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
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}
function authorize(req, res, apiKey) {
    if (apiKey === undefined) {
        return true;
    }
    if (req.header("authorization") === `Bearer ${apiKey}`) {
        return true;
    }
    sendOpenAIError(res, 401, "Invalid API key.", "invalid_api_key");
    return false;
}
function sendOpenAIError(res, status, message, code, type = "invalid_request_error") {
    res.status(status).json({ error: openAIError(message, code, type) });
}
function openAIError(message, code, type = "invalid_request_error") {
    return {
        message,
        type,
        param: null,
        code,
    };
}
function validateOptions(options) {
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
function normalizeBasePath(path) {
    const normalized = path.trim();
    if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) {
        throw new OpenAIApiAdapterError("invalid_config", "OpenAI API basePath must be an absolute path without query or hash.");
    }
    return normalized.length === 1 ? "" : normalized.replace(/\/+$/u, "");
}
function assertSafeBind(host, allowNonLoopback) {
    if (allowNonLoopback || isLoopbackHost(host)) {
        return;
    }
    throw new OpenAIApiAdapterError("unsafe_host", "OpenAI API adapter refuses to bind a non-loopback host unless allowNonLoopback is true.", { host });
}
function isLoopbackHost(host) {
    const normalized = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
    return normalized === "localhost" ||
        normalized === "127.0.0.1" ||
        normalized === "::1" ||
        normalized.startsWith("127.");
}
function hostForUrl(host) {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
function listen(server, port, host) {
    return new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
            rejectPromise(new OpenAIApiAdapterError("start_failed", "OpenAI API adapter failed to listen.", {
                reason: error.message,
            }));
        };
        server.once("error", onError);
        server.listen(port, host, () => {
            server.off("error", onError);
            const address = server.address();
            if (typeof address !== "object" || address === null) {
                rejectPromise(new OpenAIApiAdapterError("start_failed", "OpenAI API adapter did not receive a TCP address."));
                return;
            }
            resolvePromise(address);
        });
    });
}
function close(server) {
    return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => {
            if (error === undefined) {
                resolvePromise();
                return;
            }
            rejectPromise(error);
        });
    });
}
function errorToMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const normalized = value.trim();
    return normalized.length === 0 ? undefined : normalized;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=server.js.map