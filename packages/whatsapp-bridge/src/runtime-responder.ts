import {
  AgentResponderCancelledError,
  type AgentRequest,
  type AgentResponder,
  type AgentResponse,
} from "./bridge.js";
import type { AgentMessageStream } from "./message-stream.js";

export type RuntimeExecutionMode = "sdk" | "cli" | string;

export interface RuntimeModelReference {
  sdk: string;
  model: string;
  provider?: string;
  reference?: string;
  [key: string]: unknown;
}

export interface RuntimeMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface RuntimeEventLike {
  type?: string;
  [key: string]: unknown;
}

export interface RuntimeResultLike {
  text?: string | null;
  structuredResult?: unknown;
  structuredResultSource?: string | null;
  events?: RuntimeEventLike[];
  usage?: unknown;
  cost?: unknown;
  capabilitiesUsed?: unknown;
  durationMs?: number;
  numTurns?: number;
  model?: string;
  effort?: string;
  sdk?: string;
  cancelled?: boolean;
  error?: string | null;
  errorDetails?: unknown;
  failureKind?: string | null;
  providerSessionId?: string | null;
  runtimeWarnings?: unknown;
  diagnostics?: unknown;
  [key: string]: unknown;
}

export interface RuntimeRunOptions {
  model: RuntimeModelReference;
  messages: RuntimeMessage[];
  abortSignal: AbortSignal;
  onEvent?: (event: RuntimeEventLike) => void;
  executionMode?: RuntimeExecutionMode;
  effort?: string;
  cwd?: string;
  maxTurns?: number;
  [key: string]: unknown;
}

export interface AgentRuntimeLike {
  run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResultLike>;
}

export type RuntimeMessageBuilder = (request: AgentRequest) => RuntimeMessage[];

export interface RuntimeResponderOptions {
  runtime: AgentRuntimeLike;
  systemPrompt: string;
  model: RuntimeModelReference;
  executionMode?: RuntimeExecutionMode;
  effort?: string;
  cwd?: string;
  maxTurns?: number;
  buildMessages?: RuntimeMessageBuilder;
  runtimeOptions?: Record<string, unknown> & {
    onEvent?: (event: RuntimeEventLike) => void;
  };
  streamEvents?: boolean;
  includeResultMetadata?: boolean;
}

export interface RuntimeResponderErrorDetails {
  failureKind?: string | null;
  runtimeError?: string | null;
  errorDetails?: unknown;
  result?: RuntimeResultLike;
}

export class RuntimeResponderError extends Error {
  readonly failureKind?: string | null;
  readonly runtimeError?: string | null;
  readonly errorDetails?: unknown;
  readonly result?: RuntimeResultLike;

  constructor(message: string, details: RuntimeResponderErrorDetails = {}) {
    super(message);
    this.name = "RuntimeResponderError";
    if (details.failureKind !== undefined) {
      this.failureKind = details.failureKind;
    }
    if (details.runtimeError !== undefined) {
      this.runtimeError = details.runtimeError;
    }
    if (details.errorDetails !== undefined) {
      this.errorDetails = details.errorDetails;
    }
    if (details.result !== undefined) {
      this.result = details.result;
    }
  }
}

export function createRuntimeResponder(
  options: RuntimeResponderOptions,
): AgentResponder {
  validateRuntimeResponderOptions(options);
  const buildMessages = options.buildMessages ?? defaultRuntimeMessages;
  const streamEvents = options.streamEvents !== false;
  const includeResultMetadata = options.includeResultMetadata !== false;

  return {
    async respond(
      request: AgentRequest,
      stream: AgentMessageStream,
    ): Promise<AgentResponse> {
      const runtimeEventStream = createRuntimeEventStream(stream);
      const runtimeOptions = options.runtimeOptions ?? {};
      const hostOnEvent = runtimeOptions.onEvent;
      const runInput: {
        baseOptions: Record<string, unknown> & {
          onEvent?: (event: RuntimeEventLike) => void;
        };
        explicitOptions: RuntimeResponderOptions;
        request: AgentRequest;
        messages: RuntimeMessage[];
        onEvent?: (event: RuntimeEventLike) => void;
      } = {
        baseOptions: runtimeOptions,
        explicitOptions: options,
        request,
        messages: buildMessages(request),
      };
      if (streamEvents || hostOnEvent !== undefined) {
        runInput.onEvent = (event: RuntimeEventLike) => {
          if (streamEvents) {
            const delta = assistantTextFromRuntimeEvent(event);
            if (delta.length > 0) {
              runtimeEventStream.enqueue(delta);
            }
          }
          hostOnEvent?.(event);
        };
      }
      const runOptions = buildRunOptions(runInput);

      const result = await options.runtime.run(options.systemPrompt, runOptions);
      await runtimeEventStream.flush();

      if (result.cancelled === true) {
        throw new AgentResponderCancelledError("Agent runtime run was cancelled.", {
          reason: result,
        });
      }

      const runtimeError = runtimeErrorFromResult(result);
      if (runtimeError !== undefined) {
        throw runtimeError;
      }

      const response: AgentResponse = {};
      if (typeof result.text === "string") {
        response.text = result.text;
      }
      if (includeResultMetadata) {
        response.metadata = { runtime: runtimeMetadataFromResult(result) };
      }
      return response;
    },
  };
}

export function defaultRuntimeMessages(request: AgentRequest): RuntimeMessage[] {
  return [{ role: "user", content: request.text }];
}

export function assistantTextFromRuntimeEvent(event: unknown): string {
  if (!isRecord(event) || event.type !== "assistant") {
    return "";
  }

  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }

  let text = "";
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function validateRuntimeResponderOptions(options: RuntimeResponderOptions): void {
  if (typeof options.runtime?.run !== "function") {
    throw new TypeError("createRuntimeResponder requires a runtime with run().");
  }
  if (typeof options.systemPrompt !== "string") {
    throw new TypeError("createRuntimeResponder requires a string systemPrompt.");
  }
  assertParsedRuntimeModelReference(options.model);
  if (options.buildMessages !== undefined && typeof options.buildMessages !== "function") {
    throw new TypeError("buildMessages must be a function when provided.");
  }
}

function assertParsedRuntimeModelReference(
  model: unknown,
): asserts model is RuntimeModelReference {
  if (
    !isRecord(model) ||
    Array.isArray(model) ||
    typeof model.sdk !== "string" ||
    model.sdk.trim().length === 0 ||
    typeof model.model !== "string" ||
    model.model.trim().length === 0
  ) {
    throw new TypeError(
      "createRuntimeResponder requires a parsed runtime model reference object with sdk and model.",
    );
  }
}

function buildRunOptions(input: {
  baseOptions: Record<string, unknown> & {
    onEvent?: (event: RuntimeEventLike) => void;
  };
  explicitOptions: RuntimeResponderOptions;
  request: AgentRequest;
  messages: RuntimeMessage[];
  onEvent?: (event: RuntimeEventLike) => void;
}): RuntimeRunOptions {
  const runOptions: RuntimeRunOptions = {
    ...input.baseOptions,
    model: input.explicitOptions.model,
    messages: input.messages,
    abortSignal: input.request.abortSignal,
  };

  if (input.explicitOptions.executionMode !== undefined) {
    runOptions.executionMode = input.explicitOptions.executionMode;
  }
  if (input.explicitOptions.effort !== undefined) {
    runOptions.effort = input.explicitOptions.effort;
  }
  if (input.explicitOptions.cwd !== undefined) {
    runOptions.cwd = input.explicitOptions.cwd;
  }
  if (input.explicitOptions.maxTurns !== undefined) {
    runOptions.maxTurns = input.explicitOptions.maxTurns;
  }
  if (input.onEvent !== undefined) {
    runOptions.onEvent = input.onEvent;
  }

  return runOptions;
}

function createRuntimeEventStream(stream: AgentMessageStream): {
  enqueue(delta: string): void;
  flush(): Promise<void>;
} {
  let chain = Promise.resolve();
  let firstError: unknown;

  return {
    enqueue(delta: string): void {
      chain = chain
        .then(async () => {
          if (firstError !== undefined) {
            return;
          }
          await stream.append(delta);
        })
        .catch((error: unknown) => {
          if (firstError === undefined) {
            firstError = error;
          }
        });
    },
    async flush(): Promise<void> {
      await chain;
      if (firstError !== undefined) {
        throw firstError;
      }
    },
  };
}

function runtimeErrorFromResult(
  result: RuntimeResultLike,
): RuntimeResponderError | undefined {
  const runtimeError =
    typeof result.error === "string" && result.error.trim().length > 0
      ? result.error
      : undefined;
  const failureKind =
    typeof result.failureKind === "string" && result.failureKind.trim().length > 0
      ? result.failureKind
      : undefined;

  if (runtimeError === undefined && failureKind === undefined) {
    return undefined;
  }

  const pieces = ["Agent runtime failed"];
  if (failureKind !== undefined) {
    pieces.push(`failureKind=${failureKind}`);
  }
  if (runtimeError !== undefined) {
    pieces.push(runtimeError);
  }

  const details: RuntimeResponderErrorDetails = { result };
  if (result.failureKind !== undefined) {
    details.failureKind = result.failureKind;
  }
  if (result.error !== undefined) {
    details.runtimeError = result.error;
  }
  if (result.errorDetails !== undefined) {
    details.errorDetails = result.errorDetails;
  }

  return new RuntimeResponderError(pieces.join(": "), details);
}

function runtimeMetadataFromResult(
  result: RuntimeResultLike,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  copyDefined(metadata, "model", result.model);
  copyDefined(metadata, "sdk", result.sdk);
  copyDefined(metadata, "effort", result.effort);
  copyDefined(metadata, "usage", result.usage);
  copyDefined(metadata, "cost", result.cost);
  copyDefined(metadata, "capabilitiesUsed", result.capabilitiesUsed);
  copyDefined(metadata, "durationMs", result.durationMs);
  copyDefined(metadata, "numTurns", result.numTurns);
  copyDefined(metadata, "providerSessionId", result.providerSessionId);
  copyDefined(metadata, "structuredResultSource", result.structuredResultSource);
  copyDefined(metadata, "runtimeWarnings", result.runtimeWarnings);
  copyDefined(metadata, "diagnostics", result.diagnostics);
  if (result.structuredResult !== undefined) {
    metadata.structuredResult = result.structuredResult;
  }
  return metadata;
}

function copyDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
