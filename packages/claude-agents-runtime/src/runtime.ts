import { query } from "@anthropic-ai/claude-agent-sdk";
import type { MonoRuntimeLike, RuntimeEventLike, RuntimeResult, RuntimeRunOptions } from "@worklab-ai/runtime-adapter";

import {
  extractAssistantTextDelta,
  translateClaudeMessageToEvent,
  translateMcpServers,
} from "./translations.js";
import type { ClaudeSDKMessageLike } from "./translations.js";

export interface ClaudeAgentsRuntimeOptions {
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly sdkOptions?: Record<string, unknown>;
  readonly queryFactory?: ClaudeQueryFactory;
}

export type ClaudeQueryFactory = (input: {
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}) => AsyncIterable<ClaudeSDKMessageLike> & { interrupt?: () => Promise<void> };

export class ClaudeAgentsRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeAgentsRuntimeError";
    this.code = code;
  }
}

const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";

export function createClaudeAgentsRuntime(options: ClaudeAgentsRuntimeOptions = {}): MonoRuntimeLike {
  const queryFactory = options.queryFactory ?? defaultQueryFactory;
  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      assertRunOptions(systemPrompt, runOptions);
      const startedAt = Date.now();
      const userMessage = readUserMessage(runOptions);
      const sdkOptions = buildSdkOptions(systemPrompt, runOptions, options);
      const restoreApiKey = applyApiKey(options);

      const events: RuntimeEventLike[] = [];
      let accumulatedText = "";
      let resultText: string | undefined;
      let numTurns = 0;
      let durationMs = 0;
      let usage: unknown;
      let totalCostUsd: number | undefined;
      let providerSessionId: string | undefined;
      let stopReason: string | null = null;
      let failureKind: string | undefined;
      let errorMessage: string | undefined;

      try {
        const queryHandle = queryFactory({ prompt: userMessage, options: sdkOptions });
        const abortListener = (): void => {
          void queryHandle.interrupt?.().catch(() => undefined);
        };
        if (runOptions.abortSignal.aborted) {
          abortListener();
        } else {
          runOptions.abortSignal.addEventListener("abort", abortListener, { once: true });
        }

        try {
          for await (const message of queryHandle) {
            const event = translateClaudeMessageToEvent(message);
            if (event !== undefined) {
              events.push(event);
              runOptions.onEvent?.(event);
            }
            accumulatedText += extractAssistantTextDelta(message);
            if (message.type === "result") {
              const summary = extractResultSummary(message);
              resultText = summary.text;
              numTurns = summary.numTurns;
              durationMs = summary.durationMs;
              usage = summary.usage;
              totalCostUsd = summary.totalCostUsd;
              providerSessionId = summary.sessionId;
              stopReason = summary.stopReason;
              if (summary.isError) {
                failureKind = "runtime_error";
                errorMessage = summary.errorMessage ?? "Claude SDK returned an error result.";
              }
            }
          }
        } finally {
          runOptions.abortSignal.removeEventListener?.("abort", abortListener);
        }
      } catch (error) {
        failureKind = runOptions.abortSignal.aborted ? "cancelled" : "runtime_error";
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        restoreApiKey();
      }

      const finalText = resultText ?? (accumulatedText.length > 0 ? accumulatedText : undefined);
      const elapsed = durationMs > 0 ? durationMs : Date.now() - startedAt;
      const cancelled = runOptions.abortSignal.aborted;

      const result: RuntimeResult = {
        ...(finalText === undefined ? {} : { text: finalText }),
        events,
        sdk: runOptions.model.sdk,
        model: runOptions.model.model,
        numTurns,
        durationMs: elapsed,
        ...(usage === undefined ? {} : { usage }),
        ...(totalCostUsd === undefined ? {} : { cost: { totalUsd: totalCostUsd } }),
        ...(providerSessionId === undefined ? {} : { providerSessionId }),
        ...(stopReason === null ? {} : { stopReason }),
        ...(cancelled ? { cancelled: true } : {}),
        ...(failureKind === undefined ? {} : { failureKind }),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
      };
      return result;
    },
  };
}

function assertRunOptions(systemPrompt: string, runOptions: RuntimeRunOptions): void {
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    throw new ClaudeAgentsRuntimeError("invalid_options", "Claude Agents runtime requires a non-empty system prompt.");
  }
  if (!runOptions || !runOptions.model || typeof runOptions.model.model !== "string" || runOptions.model.model.length === 0) {
    throw new ClaudeAgentsRuntimeError("invalid_options", "Claude Agents runtime requires runOptions.model.model.");
  }
  if (!(runOptions.abortSignal instanceof AbortSignal)) {
    throw new ClaudeAgentsRuntimeError("invalid_options", "Claude Agents runtime requires runOptions.abortSignal.");
  }
}

function readUserMessage(runOptions: RuntimeRunOptions): string {
  const last = runOptions.messages[runOptions.messages.length - 1];
  if (last === undefined) {
    throw new ClaudeAgentsRuntimeError("invalid_options", "Claude Agents runtime requires at least one runtime message.");
  }
  if (typeof last.content === "string") {
    return last.content;
  }
  throw new ClaudeAgentsRuntimeError("invalid_options", "Claude Agents runtime only supports string message content.");
}

function buildSdkOptions(
  systemPrompt: string,
  runOptions: RuntimeRunOptions,
  options: ClaudeAgentsRuntimeOptions,
): Record<string, unknown> {
  const sdkOptions: Record<string, unknown> = {
    ...(options.sdkOptions ?? {}),
    model: runOptions.model.model,
    systemPrompt,
  };
  if (Array.isArray(runOptions.allowedTools) && runOptions.allowedTools.length > 0) {
    sdkOptions.allowedTools = [...runOptions.allowedTools];
  }
  if (Array.isArray(runOptions.disallowedTools) && runOptions.disallowedTools.length > 0) {
    sdkOptions.disallowedTools = [...runOptions.disallowedTools];
  }
  if (runOptions.cwd !== undefined) {
    sdkOptions.cwd = runOptions.cwd;
  }
  const mcpServers = translateMcpServers(runOptions.mcpServers);
  if (mcpServers !== undefined) {
    sdkOptions.mcpServers = mcpServers;
  }
  return sdkOptions;
}

function applyApiKey(options: ClaudeAgentsRuntimeOptions): () => void {
  const envName = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  if (options.apiKey === undefined) {
    return (): void => undefined;
  }
  const previous = process.env[envName];
  process.env[envName] = options.apiKey;
  return (): void => {
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
  };
}

function defaultQueryFactory(input: { readonly prompt: string; readonly options: Record<string, unknown> }): AsyncIterable<ClaudeSDKMessageLike> & { interrupt?: () => Promise<void> } {
  return query(input as Parameters<typeof query>[0]) as unknown as AsyncIterable<ClaudeSDKMessageLike> & {
    interrupt?: () => Promise<void>;
  };
}

interface ResultSummary {
  readonly text?: string;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly usage?: unknown;
  readonly totalCostUsd?: number;
  readonly sessionId?: string;
  readonly stopReason: string | null;
  readonly isError: boolean;
  readonly errorMessage?: string;
}

function extractResultSummary(message: ClaudeSDKMessageLike): ResultSummary {
  const text = typeof (message as { result?: unknown }).result === "string" ? (message as { result: string }).result : undefined;
  const numTurns = typeof (message as { num_turns?: unknown }).num_turns === "number"
    ? (message as { num_turns: number }).num_turns
    : 0;
  const durationMs = typeof (message as { duration_ms?: unknown }).duration_ms === "number"
    ? (message as { duration_ms: number }).duration_ms
    : 0;
  const usage = (message as { usage?: unknown }).usage;
  const totalCostUsd = typeof (message as { total_cost_usd?: unknown }).total_cost_usd === "number"
    ? (message as { total_cost_usd: number }).total_cost_usd
    : undefined;
  const sessionId = typeof (message as { session_id?: unknown }).session_id === "string"
    ? (message as { session_id: string }).session_id
    : undefined;
  const stopReason = typeof (message as { stop_reason?: unknown }).stop_reason === "string"
    ? (message as { stop_reason: string }).stop_reason
    : null;
  const isError = message.subtype !== "success";
  const errorMessage = typeof (message as { error?: unknown }).error === "string"
    ? (message as { error: string }).error
    : undefined;
  return {
    ...(text === undefined ? {} : { text }),
    numTurns,
    durationMs,
    ...(usage === undefined ? {} : { usage }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(sessionId === undefined ? {} : { sessionId }),
    stopReason,
    isError,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}
