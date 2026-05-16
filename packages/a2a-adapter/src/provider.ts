import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AgentEvent,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type Task,
  type TaskStatus,
} from "@a2a-js/sdk";
import {
  AgentResponseCancelledError,
  isAgentResponseCancelledError,
  type AgentMessageStream,
  type AgentRequestBase,
  type AgentResponder,
  type AgentResponse,
} from "@worklab-ai/agent-contracts";
import express, { type NextFunction, type Request, type Response } from "express";

import {
  type A2AAgentCardOptions,
  type A2AAgentSkillOptions,
  createA2AAgentCard,
} from "./card.js";
import { A2AProviderError } from "./errors.js";

export interface A2ARequestMetadata {
  readonly tenant?: string;
  readonly contextId: string;
  readonly taskId: string;
  readonly messageId: string;
  readonly inputModes: readonly string[];
  readonly sourceUrl?: string;
}

export interface A2AAgentRequest extends AgentRequestBase {
  readonly conversationId: string;
  readonly text: string;
  readonly abortSignal: AbortSignal;
  readonly metadata: {
    readonly a2a: A2ARequestMetadata;
    readonly [key: string]: unknown;
  };
}

export interface A2AProviderLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface A2AProviderOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicBaseUrl?: string;
  readonly allowNonLoopback?: boolean;
  readonly requireBearer?: boolean;
  readonly bearerToken?: string;
  readonly responder: AgentResponder<A2AAgentRequest, AgentMessageStream, AgentResponse>;
  readonly agent: Omit<A2AAgentCardOptions, "publicBaseUrl" | "skill" | "requireBearer">;
  readonly skill: A2AAgentSkillOptions;
  readonly logger?: A2AProviderLogger;
}

export interface A2AProviderStartResult {
  readonly url: string;
  readonly agentCardUrl: string;
  readonly jsonRpcUrl: string;
  readonly restUrl: string;
  readonly host: string;
  readonly port: number;
  readonly agentCard: AgentCard;
  stop(): Promise<void>;
}

export type A2AProvider = A2AProviderStartResult;

interface ActiveRun {
  readonly controller: AbortController;
  readonly taskId: string;
  readonly contextId: string;
  readonly eventBus: ExecutionEventBus;
  cancellationPublished: boolean;
}

export async function startA2AProvider(
  options: A2AProviderOptions,
): Promise<A2AProviderStartResult> {
  validateProviderOptions(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  assertSafeBind(host, options.allowNonLoopback === true);
  const requireBearer = options.requireBearer === true;
  if (requireBearer && normalizeOptionalString(options.bearerToken) === undefined) {
    throw new A2AProviderError(
      "missing_required_config",
      "A2A provider requires bearerToken when requireBearer is true.",
    );
  }

  const app = express();
  const server = createServer(app);
  const address = await listen(server, port, host);
  const boundHost = hostForUrl(host);
  const boundPort = address.port;
  const publicBaseUrl = options.publicBaseUrl === undefined
    ? `http://${boundHost}:${boundPort}`
    : options.publicBaseUrl;
  assertSafePublicBaseUrl(publicBaseUrl, options.allowNonLoopback === true);

  const agentCard = createA2AAgentCard({
    ...options.agent,
    publicBaseUrl,
    requireBearer,
    skill: options.skill,
  });
  const executor = new MonoA2AExecutor(options.responder, {
    sourceUrl: publicBaseUrl,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    executor,
    new DefaultExecutionEventBusManager(),
  );
  const auth = requireBearer
    ? bearerAuthMiddleware(options.bearerToken as string)
    : (_req: Request, _res: Response, next: NextFunction) => next();

  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use("/a2a/json-rpc", auth, jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }));
  app.use("/a2a/rest", auth, restHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }));

  const url = publicBaseUrl.replace(/\/+$/u, "");
  return {
    url,
    agentCardUrl: `${url}/.well-known/agent-card.json`,
    jsonRpcUrl: `${url}/a2a/json-rpc`,
    restUrl: `${url}/a2a/rest`,
    host,
    port: boundPort,
    agentCard,
    async stop() {
      await close(server);
    },
  };
}

class MonoA2AExecutor implements AgentExecutor {
  private readonly responder: AgentResponder<A2AAgentRequest, AgentMessageStream, AgentResponse>;
  private readonly sourceUrl: string | undefined;
  private readonly logger: A2AProviderLogger | undefined;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    responder: AgentResponder<A2AAgentRequest, AgentMessageStream, AgentResponse>,
    options: {
      readonly sourceUrl?: string;
      readonly logger?: A2AProviderLogger;
    } = {},
  ) {
    this.responder = responder;
    this.sourceUrl = options.sourceUrl;
    this.logger = options.logger;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      eventBus,
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      cancellationPublished: false,
    };
    this.activeRuns.set(requestContext.taskId, active);

    eventBus.publish(AgentEvent.task(createTask({
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      state: TaskState.TASK_STATE_SUBMITTED,
      history: [requestContext.userMessage],
      statusText: "Task submitted.",
    })));

    try {
      const normalized = textFromMessage(requestContext.userMessage);
      const stream = new A2AProviderMessageStream(eventBus, {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
      });
      eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        state: TaskState.TASK_STATE_WORKING,
        text: "Task is running.",
      })));

      const response = await this.responder.respond({
        conversationId: conversationIdFor(requestContext),
        text: normalized.text,
        abortSignal: controller.signal,
        metadata: {
          a2a: {
            ...(requestContext.context.tenant === undefined ? {} : { tenant: requestContext.context.tenant }),
            contextId: requestContext.contextId,
            taskId: requestContext.taskId,
            messageId: requestContext.userMessage.messageId,
            inputModes: normalized.inputModes,
            ...(this.sourceUrl === undefined ? {} : { sourceUrl: this.sourceUrl }),
          },
        },
      }, stream);

      if (active.cancellationPublished || controller.signal.aborted) {
        return;
      }

      await stream.finish(response.text);
      const finalText = stream.text;
      if (finalText.length > 0) {
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          artifact: {
            artifactId: "final-text",
            name: "Final text response",
            description: "Text response returned by the Mono Agent responder.",
            parts: [textPart(finalText)],
            metadata: {},
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: {},
        }));
      }

      eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        state: TaskState.TASK_STATE_COMPLETED,
        ...(finalText.length === 0 ? {} : { text: finalText }),
      })));
    } catch (error) {
      if (active.cancellationPublished) {
        return;
      }
      if (controller.signal.aborted || isAgentResponseCancelledError(error)) {
        publishCanceled(active, "Task canceled.");
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.error?.("A2A responder failed.", { reason });
      eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        state: error instanceof A2AProviderError && error.code === "unsupported_input"
          ? TaskState.TASK_STATE_FAILED
          : TaskState.TASK_STATE_FAILED,
        text: reason,
      })));
    } finally {
      this.activeRuns.delete(requestContext.taskId);
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const active = this.activeRuns.get(taskId);
    if (active === undefined) {
      eventBus.finished();
      return;
    }
    active.controller.abort(new AgentResponseCancelledError("A2A task cancellation requested."));
    publishCanceled(active, "Task cancellation requested by user.");
  }
}

class A2AProviderMessageStream implements AgentMessageStream {
  private readonly eventBus: ExecutionEventBus;
  private readonly taskId: string;
  private readonly contextId: string;
  private currentText = "";
  private finished = false;

  constructor(
    eventBus: ExecutionEventBus,
    context: {
      readonly taskId: string;
      readonly contextId: string;
    },
  ) {
    this.eventBus = eventBus;
    this.taskId = context.taskId;
    this.contextId = context.contextId;
  }

  get text(): string {
    return this.currentText.trim();
  }

  async status(text: string): Promise<void> {
    this.assertOpen();
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }
    this.eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
      taskId: this.taskId,
      contextId: this.contextId,
      state: TaskState.TASK_STATE_WORKING,
      text: normalized,
    })));
  }

  async append(delta: string): Promise<void> {
    this.assertOpen();
    this.currentText += delta;
  }

  async replace(text: string): Promise<void> {
    this.assertOpen();
    this.currentText = text;
  }

  async finish(finalText?: string): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (finalText !== undefined) {
      this.currentText = finalText;
    }
  }

  private assertOpen(): void {
    if (this.finished) {
      throw new A2AProviderError("invalid_config", "Cannot write to a finished A2A stream.");
    }
  }
}

function validateProviderOptions(options: A2AProviderOptions): void {
  if (typeof options.responder?.respond !== "function") {
    throw new A2AProviderError("missing_required_config", "A2A provider requires a responder.");
  }
  if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) {
    throw new A2AProviderError("invalid_config", "A2A provider port must be an integer from 0 to 65535.");
  }
}

function assertSafeBind(host: string, allowNonLoopback: boolean): void {
  if (allowNonLoopback || isLoopbackHost(host)) {
    return;
  }
  throw new A2AProviderError(
    "unsafe_host",
    "A2A provider refuses to bind a non-loopback host unless allowNonLoopback is true.",
    { host },
  );
}

function assertSafePublicBaseUrl(publicBaseUrl: string, allowNonLoopback: boolean): void {
  const parsed = new URL(publicBaseUrl);
  if (allowNonLoopback || isLoopbackHost(parsed.hostname)) {
    return;
  }
  throw new A2AProviderError(
    "unsafe_host",
    "A2A provider refuses a non-loopback publicBaseUrl unless allowNonLoopback is true.",
    { publicBaseUrl },
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.");
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      rejectPromise(new A2AProviderError("start_failed", "A2A provider failed to listen.", {
        reason: error.message,
      }));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        rejectPromise(new A2AProviderError("start_failed", "A2A provider did not receive a TCP address."));
        return;
      }
      resolvePromise(address);
    });
  });
}

function close(server: Server): Promise<void> {
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

function bearerAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authorization = req.header("authorization");
    if (authorization === `Bearer ${token}`) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", 'Bearer realm="a2a"');
    res.status(401).json({ error: "Unauthorized" });
  };
}

function textFromMessage(message: Message): {
  readonly text: string;
  readonly inputModes: readonly string[];
} {
  const inputModes: string[] = [];
  const textParts: string[] = [];
  for (const part of message.parts) {
    inputModes.push(part.mediaType.length > 0 ? part.mediaType : "application/octet-stream");
    if (part.content?.$case !== "text") {
      throw new A2AProviderError(
        "unsupported_input",
        "A2A provider supports text/plain parts only.",
      );
    }
    textParts.push(part.content.value);
  }
  const text = textParts.join("\n").trim();
  if (text.length === 0) {
    throw new A2AProviderError(
      "unsupported_input",
      "A2A provider requires non-empty text input.",
    );
  }
  return { text, inputModes };
}

function conversationIdFor(requestContext: RequestContext): string {
  if (requestContext.contextId.length > 0) {
    return requestContext.contextId;
  }
  if (requestContext.taskId.length > 0) {
    return requestContext.taskId;
  }
  return `a2a:${requestContext.userMessage.messageId}`;
}

function createTask(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly state: TaskState;
  readonly history?: readonly Message[];
  readonly statusText?: string;
}): Task {
  return {
    id: input.taskId,
    contextId: input.contextId,
    status: createStatus({
      taskId: input.taskId,
      contextId: input.contextId,
      state: input.state,
      ...(input.statusText === undefined ? {} : { text: input.statusText }),
    }),
    artifacts: [],
    history: [...(input.history ?? [])],
    metadata: {},
  };
}

function createStatus(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly state: TaskState;
  readonly text?: string;
}): TaskStatus {
  return {
    state: input.state,
    message: input.text === undefined
      ? undefined
      : agentMessage({
          taskId: input.taskId,
          contextId: input.contextId,
          text: input.text,
        }),
    timestamp: new Date().toISOString(),
  };
}

function createStatusUpdate(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly state: TaskState;
  readonly text?: string;
}) {
  return {
    taskId: input.taskId,
    contextId: input.contextId,
    status: createStatus(input),
    metadata: {},
  };
}

function agentMessage(input: {
  readonly taskId: string;
  readonly contextId: string;
  readonly text: string;
}): Message {
  return {
    role: Role.ROLE_AGENT,
    messageId: randomUUID(),
    taskId: input.taskId,
    contextId: input.contextId,
    parts: [textPart(input.text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    mediaType: "text/plain",
    filename: "",
    metadata: {},
  };
}

function publishCanceled(active: ActiveRun, text: string): void {
  active.cancellationPublished = true;
  active.eventBus.publish(AgentEvent.statusUpdate(createStatusUpdate({
    taskId: active.taskId,
    contextId: active.contextId,
    state: TaskState.TASK_STATE_CANCELED,
    text,
  })));
  active.eventBus.finished();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
