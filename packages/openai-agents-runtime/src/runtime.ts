import {
  Agent,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  run as runAgent,
} from "@openai/agents";
import {
  CodedError,
  acceptedSdkIdsForBackend,
  applyTemporaryEnv,
  assertBaseRunOptions,
  buildRuntimeResult,
  readLastStringUserMessage,
} from "@mono-agent/runtime-adapter";
import type { MonoRuntimeLike, RuntimeEventLike, RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";

import {
  translateMcpServers,
  translateOpenAIStreamEvent,
} from "./translations.js";
import type { McpServerSpec, OpenAIStreamEventLike } from "./translations.js";

export interface OpenAIAgentsRuntimeOptions {
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly sdkOptions?: OpenAIAgentSdkOptions;
  readonly runFactory?: OpenAIRunFactory;
}

export interface OpenAIAgentSdkOptions {
  readonly agent?: Record<string, unknown>;
  readonly run?: Record<string, unknown>;
}

export type OpenAIRunFactory = (input: OpenAIRunFactoryInput) => Promise<OpenAIRunHandle>;

export interface OpenAIRunFactoryInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly runOptions: RuntimeRunOptions;
  readonly mcpServers: readonly McpServerSpec[];
  readonly agentOptions: Record<string, unknown>;
  readonly runConfig: Record<string, unknown>;
  readonly abortSignal: AbortSignal;
}

export interface OpenAIRunHandle {
  readonly events: AsyncIterable<OpenAIStreamEventLike>;
  readonly completed: () => Promise<OpenAIRunResult>;
}

export interface OpenAIRunResult {
  readonly finalText?: string;
  readonly numTurns: number;
  readonly usage?: unknown;
  readonly error?: unknown;
  readonly providerSessionId?: string;
}

export type OpenAIAgentsRuntimeErrorCode = "invalid_options" | "runtime_error" | "cancelled";

export interface OpenAIAgentsRuntimeErrorDetails {
  readonly failureKind?: string;
  readonly [key: string]: unknown;
}

export class OpenAIAgentsRuntimeError extends CodedError<OpenAIAgentsRuntimeErrorCode> {
  constructor(
    code: OpenAIAgentsRuntimeErrorCode,
    message: string,
    details: OpenAIAgentsRuntimeErrorDetails = {},
  ) {
    super(code, message, details);
  }
}

const DEFAULT_API_KEY_ENV = "OPENAI_API_KEY";
const DEFAULT_BASE_URL_ENV = "OPENAI_BASE_URL";
const ACCEPTED_SDK_IDS = new Set(acceptedSdkIdsForBackend("openai-agents-sdk"));

export function createOpenAIAgentsRuntime(options: OpenAIAgentsRuntimeOptions = {}): MonoRuntimeLike {
  const runFactory = options.runFactory ?? defaultRunFactory;
  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      assertRunOptions(systemPrompt, runOptions);
      const startedAt = Date.now();
      const userMessage = readLastStringUserMessage(runOptions, makeError, "OpenAI Agents runtime");
      const mcpServers = translateMcpServers(runOptions.mcpServers);
      const agentOptions = buildAgentOptions(systemPrompt, runOptions, options);
      const runConfig = buildRunConfig(runOptions, options);
      const restoreEnv = applyEnv(options);

      const events: RuntimeEventLike[] = [];
      let finalText: string | undefined;
      let numTurns = 0;
      let usage: unknown;
      let providerSessionId: string | undefined;
      let errorMessage: string | undefined;
      let failureKind: string | undefined;
      try {
        const handle = await runFactory({
          systemPrompt,
          userMessage,
          runOptions,
          mcpServers,
          agentOptions,
          runConfig,
          abortSignal: runOptions.abortSignal,
        });
        for await (const event of handle.events) {
          const translated = translateOpenAIStreamEvent(event);
          if (translated !== undefined) {
            events.push(translated);
            runOptions.onEvent?.(translated);
          }
        }
        const summary = await handle.completed();
        finalText = summary.finalText;
        numTurns = summary.numTurns;
        usage = summary.usage;
        providerSessionId = summary.providerSessionId;
        if (summary.error !== undefined && summary.error !== null) {
          failureKind = "runtime_error";
          errorMessage = summary.error instanceof Error ? summary.error.message : String(summary.error);
        }
      } catch (error) {
        failureKind = runOptions.abortSignal.aborted ? "cancelled" : "runtime_error";
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        restoreEnv();
      }

      const cancelled = runOptions.abortSignal.aborted;
      return buildRuntimeResult({
        text: finalText,
        events,
        model: runOptions.model,
        numTurns,
        durationMs: Date.now() - startedAt,
        usage,
        providerSessionId,
        cancelled,
        failureKind,
        error: errorMessage,
      });
    },
  };
}

function makeError(code: "invalid_options", message: string): OpenAIAgentsRuntimeError {
  return new OpenAIAgentsRuntimeError(code, message);
}

function assertRunOptions(systemPrompt: string, runOptions: RuntimeRunOptions): void {
  assertBaseRunOptions(systemPrompt, runOptions, makeError, "OpenAI Agents runtime");
  const sdk = runOptions.model.sdk;
  if (typeof sdk !== "string" || !ACCEPTED_SDK_IDS.has(sdk)) {
    throw new OpenAIAgentsRuntimeError(
      "invalid_options",
      `OpenAI Agents runtime only serves sdk ${[...ACCEPTED_SDK_IDS].join("/")}; received ${String(sdk)}.`,
      { receivedSdk: sdk },
    );
  }
}

function buildAgentOptions(
  systemPrompt: string,
  runOptions: RuntimeRunOptions,
  options: OpenAIAgentsRuntimeOptions,
): Record<string, unknown> {
  return {
    ...(options.sdkOptions?.agent ?? {}),
    name: "mono-agent",
    instructions: systemPrompt,
    model: runOptions.model.model,
  };
}

function buildRunConfig(
  runOptions: RuntimeRunOptions,
  options: OpenAIAgentsRuntimeOptions,
): Record<string, unknown> {
  const runConfig: Record<string, unknown> = {
    ...(options.sdkOptions?.run ?? {}),
  };
  if (typeof runOptions.maxTurns === "number") {
    runConfig.maxTurns = runOptions.maxTurns;
  }
  return runConfig;
}

function applyEnv(options: OpenAIAgentsRuntimeOptions): () => void {
  const vars: Record<string, string | undefined> = {};
  if (options.apiKey !== undefined) {
    vars[options.apiKeyEnv ?? DEFAULT_API_KEY_ENV] = options.apiKey;
  }
  if (options.baseUrl !== undefined) {
    vars[DEFAULT_BASE_URL_ENV] = options.baseUrl;
  }
  return applyTemporaryEnv(vars);
}

async function defaultRunFactory(input: OpenAIRunFactoryInput): Promise<OpenAIRunHandle> {
  const mcpInstances = input.mcpServers.map((spec) => instantiateMcpServer(spec));
  const agent = new Agent({
    name: getString(input.agentOptions.name, "mono-agent"),
    instructions: input.systemPrompt,
    model: input.runOptions.model.model,
    mcpServers: mcpInstances,
    ...(hasToolFilter(input.runOptions.allowedTools, input.runOptions.disallowedTools)
      ? { mcpConfig: { toolFilter: makeAllowDenyFilter(input.runOptions.allowedTools, input.runOptions.disallowedTools) } }
      : {}),
    ...filterAgentOptions(input.agentOptions),
  } as unknown as ConstructorParameters<typeof Agent>[0]);

  const streamed = await runAgent(agent, input.userMessage, {
    stream: true,
    signal: input.abortSignal,
    ...filterRunOptions(input.runConfig),
  } as Parameters<typeof runAgent>[2]);

  return {
    events: streamed as unknown as AsyncIterable<OpenAIStreamEventLike>,
    completed: async (): Promise<OpenAIRunResult> => {
      await streamed.completed;
      const usage = (streamed.rawResponses ?? []).reduce<{ inputTokens: number; outputTokens: number; totalTokens: number; requests: number }>(
        (acc, response) => {
          const u = response.usage;
          if (u !== undefined) {
            acc.inputTokens += u.inputTokens ?? 0;
            acc.outputTokens += u.outputTokens ?? 0;
            acc.totalTokens += u.totalTokens ?? 0;
            acc.requests += u.requests ?? 1;
          }
          return acc;
        },
        { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      );
      const text = extractTextFromOutput(streamed.output);
      return {
        ...(text === undefined ? {} : { finalText: text }),
        numTurns: streamed.currentTurn,
        usage,
        ...(streamed.lastResponseId === undefined ? {} : { providerSessionId: streamed.lastResponseId }),
        ...(streamed.error === undefined || streamed.error === null ? {} : { error: streamed.error }),
      };
    },
  };
}

function instantiateMcpServer(spec: McpServerSpec): MCPServerStreamableHttp | MCPServerSSE | MCPServerStdio {
  if (spec.kind === "streamable_http") {
    return new MCPServerStreamableHttp(spec.options as unknown as ConstructorParameters<typeof MCPServerStreamableHttp>[0]);
  }
  if (spec.kind === "sse") {
    return new MCPServerSSE(spec.options as unknown as ConstructorParameters<typeof MCPServerSSE>[0]);
  }
  return new MCPServerStdio(spec.options as unknown as ConstructorParameters<typeof MCPServerStdio>[0]);
}

function makeAllowDenyFilter(
  allowed: readonly string[] | undefined,
  disallowed: readonly string[] | undefined,
): (info: { name?: string }) => boolean {
  const allow = new Set(allowed ?? []);
  const deny = new Set(disallowed ?? []);
  return (info: { name?: string }): boolean => {
    if (typeof info.name !== "string") {
      return false;
    }
    if (deny.has(info.name)) {
      return false;
    }
    if (allow.size === 0) {
      return true;
    }
    return allow.has(info.name);
  };
}

function hasToolFilter(
  allowed: readonly string[] | undefined,
  disallowed: readonly string[] | undefined,
): boolean {
  return getStringArray(allowed).length > 0 || getStringArray(disallowed).length > 0;
}

function filterAgentOptions(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  delete out.name;
  delete out.instructions;
  delete out.model;
  delete out.mcpServers;
  return out;
}

function filterRunOptions(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  delete out.stream;
  delete out.signal;
  return out;
}

function extractTextFromOutput(output: unknown): string | undefined {
  if (!Array.isArray(output) || output.length === 0) {
    return undefined;
  }
  let text = "";
  for (const item of output) {
    if (item !== undefined && item !== null && typeof item === "object") {
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type === "message" && Array.isArray(itemRecord.content)) {
        for (const block of itemRecord.content as Array<Record<string, unknown>>) {
          if (block.type === "output_text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
    }
  }
  return text.length > 0 ? text : undefined;
}

function getString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function getStringArray(value: readonly string[] | undefined): readonly string[] {
  return Array.isArray(value) ? value : [];
}
