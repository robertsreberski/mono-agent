import { randomUUID } from "node:crypto";

import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  Client,
  ClientFactory,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@worklab-ai/agent-contracts";

import { A2AConsumerError } from "./errors.js";

export interface A2AConsumerOptions {
  readonly agentUrl: string;
  readonly bearerToken?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly preferredTransports?: readonly ("HTTP+JSON" | "JSONRPC")[];
}

export interface A2AConsumerSendMessageInput {
  readonly text?: string;
  readonly message?: Message;
  readonly contextId?: string;
  readonly taskId?: string;
  readonly returnImmediately?: boolean;
  readonly stream?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface A2AConsumerResponseMetadata {
  readonly a2a: {
    readonly remoteAgentUrl: string;
    readonly protocolVersion: string;
    readonly messageId?: string;
    readonly taskId?: string;
    readonly contextId?: string;
    readonly state?: string;
  };
  readonly [key: string]: unknown;
}

export interface A2AConsumerResponse extends AgentResponse {
  readonly text?: string;
  readonly metadata: A2AConsumerResponseMetadata;
}

export class A2AConsumer {
  readonly agentCard: AgentCard;
  private readonly client: Client;
  private readonly agentUrl: string;
  private readonly timeoutMs: number | undefined;

  constructor(input: {
    readonly client: Client;
    readonly agentCard: AgentCard;
    readonly agentUrl: string;
    readonly timeoutMs?: number;
  }) {
    this.client = input.client;
    this.agentCard = input.agentCard;
    this.agentUrl = input.agentUrl;
    this.timeoutMs = input.timeoutMs;
  }

  async sendMessage(input: A2AConsumerSendMessageInput): Promise<A2AConsumerResponse> {
    const request = buildSendMessageRequest(input);
    const timeoutContext = signalWithTimeout(input.signal, input.timeoutMs ?? this.timeoutMs);
    const options = timeoutContext.signal === undefined
      ? undefined
      : { signal: timeoutContext.signal } satisfies RequestOptions;

    try {
      if (input.stream === true && this.agentCard.capabilities?.streaming === true) {
        return await this.sendStreaming(request, options);
      }
      const result = await this.client.sendMessage(request, options);
      return responseFromResult(result, {
        agentUrl: this.agentUrl,
        protocolVersion: this.client.protocolVersion,
        allowPending: input.returnImmediately === true,
      });
    } catch (error) {
      throw normalizeConsumerError(error, {
        agentUrl: this.agentUrl,
        timeoutContext,
      });
    } finally {
      timeoutContext.cleanup();
    }
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<A2AConsumerResponse> {
    const options = signal === undefined ? undefined : { signal } satisfies RequestOptions;
    try {
      const task = await this.client.cancelTask({ id: taskId, tenant: "", metadata: {} }, options);
      return responseFromResult(task, {
        agentUrl: this.agentUrl,
        protocolVersion: this.client.protocolVersion,
        allowPending: true,
        allowCanceled: true,
      });
    } catch (error) {
      throw normalizeConsumerError(error);
    }
  }

  private async sendStreaming(
    request: SendMessageRequest,
    options: RequestOptions | undefined,
  ): Promise<A2AConsumerResponse> {
    let latest: SendMessageResult | undefined;
    for await (const event of this.client.sendMessageStream(request, options)) {
      latest = resultFromStreamEvent(event) ?? latest;
    }
    if (latest === undefined) {
      throw new A2AConsumerError(
        "empty_a2a_response",
        "Remote A2A stream ended without a message or task.",
      );
    }
    return responseFromResult(latest, {
      agentUrl: this.agentUrl,
      protocolVersion: this.client.protocolVersion,
      allowPending: false,
    });
  }
}

export async function createA2AConsumer(
  options: A2AConsumerOptions,
): Promise<A2AConsumer> {
  const fetchImpl = bearerFetch(options.fetchImpl ?? fetch, options.bearerToken);
  const agentCard = await discoverA2AAgent({
    agentUrl: options.agentUrl,
    fetchImpl,
  });
  const factory = new ClientFactory({
    transports: [
      new RestTransportFactory({ fetchImpl }),
      new JsonRpcTransportFactory({ fetchImpl }),
    ],
    preferredTransports: [...(options.preferredTransports ?? ["HTTP+JSON", "JSONRPC"])],
    clientConfig: {
      acceptedOutputModes: ["text/plain"],
    },
  });
  const client = await factory.createFromAgentCard(agentCard);
  return new A2AConsumer({
    client,
    agentCard,
    agentUrl: options.agentUrl,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export async function discoverA2AAgent(input: {
  readonly agentUrl: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<AgentCard> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cardUrl = agentCardUrlFor(input.agentUrl);
  let response: Response;
  try {
    response = await fetchImpl(cardUrl);
  } catch (error) {
    throw new A2AConsumerError("discovery_failed", "Failed to fetch A2A Agent Card.", {
      reason: error instanceof Error ? error.message : String(error),
      agentUrl: input.agentUrl,
    });
  }
  if (!response.ok) {
    throw new A2AConsumerError("discovery_failed", "Failed to fetch A2A Agent Card.", {
      status: response.status,
      agentUrl: input.agentUrl,
    });
  }
  const card = await response.json() as unknown;
  assertAgentCard(card, input.agentUrl);
  return card;
}

export async function sendA2AMessage(
  input: A2AConsumerOptions & A2AConsumerSendMessageInput,
): Promise<A2AConsumerResponse> {
  const consumer = await createA2AConsumer(input);
  return await consumer.sendMessage(input);
}

export function createA2AConsumerResponder(
  options: A2AConsumerOptions & {
    readonly streamRemote?: boolean;
  },
): AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse> {
  let consumerPromise: Promise<A2AConsumer> | undefined;
  const getConsumer = (): Promise<A2AConsumer> => {
    consumerPromise ??= createA2AConsumer(options);
    return consumerPromise;
  };
  return {
    async respond(request, stream): Promise<AgentResponse> {
      const consumer = await getConsumer();
      const response = await consumer.sendMessage({
        text: request.text,
        contextId: request.conversationId,
        signal: request.abortSignal,
        stream: options.streamRemote === true,
      });
      if (response.text !== undefined) {
        await stream.append(response.text);
      }
      return response;
    },
  };
}

function buildSendMessageRequest(input: A2AConsumerSendMessageInput): SendMessageRequest {
  const message = input.message ?? textMessage({
    text: requireText(input.text),
    contextId: input.contextId ?? "",
    taskId: input.taskId ?? "",
  });
  return {
    tenant: "",
    message,
    configuration: {
      acceptedOutputModes: ["text/plain"],
      taskPushNotificationConfig: undefined,
      historyLength: 10,
      returnImmediately: input.returnImmediately === true,
    },
    metadata: input.metadata ?? {},
  };
}

function textMessage(input: {
  readonly text: string;
  readonly contextId: string;
  readonly taskId: string;
}): Message {
  return {
    messageId: randomUUID(),
    contextId: input.contextId,
    taskId: input.taskId,
    role: Role.ROLE_USER,
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

function requireText(text: string | undefined): string {
  const normalized = text?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new A2AConsumerError("send_failed", "A2A consumer requires non-empty text.");
  }
  return normalized;
}

function responseFromResult(
  result: SendMessageResult,
  context: {
    readonly agentUrl: string;
    readonly protocolVersion: string;
    readonly allowPending: boolean;
    readonly allowCanceled?: boolean;
  },
): A2AConsumerResponse {
  if (isTask(result)) {
    const failure = failureForTask(result, context.allowCanceled === true);
    if (failure !== undefined) {
      throw failure;
    }
    const text = textFromTask(result);
    if (text === undefined && !context.allowPending && result.status?.state === TaskState.TASK_STATE_COMPLETED) {
      throw new A2AConsumerError(
        "empty_a2a_response",
        "Remote A2A task completed without text output.",
        { taskId: result.id },
      );
    }
    return {
      ...(text === undefined ? {} : { text }),
      metadata: {
        a2a: {
          remoteAgentUrl: context.agentUrl,
          protocolVersion: context.protocolVersion,
          taskId: result.id,
          contextId: result.contextId,
          ...(result.status?.state === undefined ? {} : { state: TaskState[result.status.state] }),
        },
      },
    };
  }

  const text = textFromMessage(result);
  if (text === undefined) {
    throw new A2AConsumerError(
      "empty_a2a_response",
      "Remote A2A message did not contain text output.",
      { messageId: result.messageId },
    );
  }
  return {
    text,
    metadata: {
      a2a: {
        remoteAgentUrl: context.agentUrl,
        protocolVersion: context.protocolVersion,
        messageId: result.messageId,
        contextId: result.contextId,
        taskId: result.taskId,
      },
    },
  };
}

function textFromTask(task: Task): string | undefined {
  return textFromMessage(task.status?.message) ?? textFromArtifacts(task);
}

function textFromArtifacts(task: Task): string | undefined {
  const texts = task.artifacts.flatMap((artifact) => textFromParts(artifact.parts));
  return joinedText(texts);
}

function textFromMessage(message: Message | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  return joinedText(textFromParts(message.parts));
}

function textFromParts(parts: readonly Part[]): string[] {
  return parts.flatMap((part) => {
    if (part.content?.$case === "text") {
      const text = part.content.value.trim();
      return text.length === 0 ? [] : [text];
    }
    return [];
  });
}

function joinedText(texts: readonly string[]): string | undefined {
  if (texts.length === 0) {
    return undefined;
  }
  const text = texts.join("\n").trim();
  return text.length === 0 ? undefined : text;
}

function failureForTask(task: Task, allowCanceled: boolean): A2AConsumerError | undefined {
  const state = task.status?.state;
  const text = textFromMessage(task.status?.message);
  if (state === TaskState.TASK_STATE_FAILED) {
    return new A2AConsumerError("remote_failed", text ?? "Remote A2A task failed.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_CANCELED && !allowCanceled) {
    return new A2AConsumerError("remote_canceled", text ?? "Remote A2A task was canceled.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_REJECTED) {
    return new A2AConsumerError("remote_rejected", text ?? "Remote A2A task was rejected.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    return new A2AConsumerError("remote_auth_required", text ?? "Remote A2A task requires authentication.", { taskId: task.id });
  }
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
    return new A2AConsumerError("remote_input_required", text ?? "Remote A2A task requires input.", { taskId: task.id });
  }
  return undefined;
}

function resultFromStreamEvent(event: StreamResponse): SendMessageResult | undefined {
  if (event.payload?.$case === "message" || event.payload?.$case === "task") {
    return event.payload.value;
  }
  if (event.payload?.$case === "statusUpdate") {
    return {
      id: event.payload.value.taskId,
      contextId: event.payload.value.contextId,
      status: event.payload.value.status,
      artifacts: [],
      history: [],
      metadata: {},
    };
  }
  if (event.payload?.$case === "artifactUpdate") {
    return {
      id: event.payload.value.taskId,
      contextId: event.payload.value.contextId,
      status: undefined,
      artifacts: event.payload.value.artifact === undefined ? [] : [event.payload.value.artifact],
      history: [],
      metadata: {},
    };
  }
  return undefined;
}

function isTask(result: SendMessageResult): result is Task {
  return "status" in result;
}

function normalizeConsumerError(
  error: unknown,
  context: {
    readonly agentUrl?: string;
    readonly timeoutContext?: TimeoutSignalContext;
  } = {},
): A2AConsumerError {
  if (context.timeoutContext?.timedOut() === true) {
    const timeoutMs = context.timeoutContext.timeoutMs;
    return new A2AConsumerError("timeout", timeoutMessage(timeoutMs), {
      timeoutMs,
      ...(context.agentUrl === undefined ? {} : { agentUrl: context.agentUrl }),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (error instanceof A2AConsumerError) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  if (/\b(401|403|UNAUTHENTICATED|Unauthorized|auth)/iu.test(reason)) {
    return new A2AConsumerError("remote_auth_required", "Remote A2A agent requires authentication.", { reason });
  }
  return new A2AConsumerError("send_failed", "A2A message send failed.", { reason });
}

function assertAgentCard(card: unknown, agentUrl: string): asserts card is AgentCard {
  if (!isRecord(card) || typeof card.name !== "string" || !Array.isArray(card.supportedInterfaces)) {
    throw new A2AConsumerError("invalid_agent_card", "A2A discovery returned an invalid Agent Card.", {
      agentUrl,
    });
  }
}

function agentCardUrlFor(agentUrl: string): string {
  const parsed = new URL(agentUrl);
  if (parsed.pathname.endsWith("/.well-known/agent-card.json")) {
    return parsed.toString();
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/.well-known/agent-card.json`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function bearerFetch(fetchImpl: typeof fetch, bearerToken: string | undefined): typeof fetch {
  const token = bearerToken?.trim();
  if (token === undefined || token.length === 0) {
    return fetchImpl;
  }
  return async (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return await fetchImpl(input, {
      ...init,
      headers,
    });
  };
}

interface TimeoutSignalContext {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  timedOut(): boolean;
  cleanup(): void;
}

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): TimeoutSignalContext {
  if (timeoutMs === undefined) {
    return {
      signal,
      timeoutMs,
      timedOut: () => false,
      cleanup: () => undefined,
    };
  }
  const controller = new AbortController();
  let didTimeOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timeout = undefined;
    didTimeOut = true;
    controller.abort(new Error(`A2A request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const clear = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const abortFromInput = (): void => {
    clear();
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) {
    abortFromInput();
  } else {
    signal?.addEventListener("abort", abortFromInput, { once: true });
  }
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clear();
      signal?.removeEventListener("abort", abortFromInput);
    },
  };
}

function timeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? "A2A request timed out."
    : `A2A request timed out after ${timeoutMs}ms.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
