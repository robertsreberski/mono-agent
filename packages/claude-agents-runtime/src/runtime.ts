import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  CodedError,
  acceptedSdkIdsForBackend,
  applyTemporaryEnv,
  assertBaseRunOptions,
  buildRuntimeResult,
  readLastStringUserMessage,
} from "@worklab-ai/runtime-adapter";
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

export type ClaudeAgentsRuntimeErrorCode = "invalid_options" | "runtime_error" | "cancelled";

export interface ClaudeAgentsRuntimeErrorDetails {
  /** Mapped from the SDK result `subtype` for error results. */
  readonly failureKind?: string;
  /** The SDK result `stop_reason`, when present. */
  readonly stopReason?: string | null;
  readonly [key: string]: unknown;
}

export class ClaudeAgentsRuntimeError extends CodedError<ClaudeAgentsRuntimeErrorCode> {
  constructor(
    code: ClaudeAgentsRuntimeErrorCode,
    message: string,
    details: ClaudeAgentsRuntimeErrorDetails = {},
  ) {
    super(code, message, details);
  }
}

const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";
const ACCEPTED_SDK_IDS = new Set(acceptedSdkIdsForBackend("claude-sdk"));

export function createClaudeAgentsRuntime(options: ClaudeAgentsRuntimeOptions = {}): MonoRuntimeLike {
  const queryFactory = options.queryFactory ?? defaultQueryFactory;
  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      assertRunOptions(systemPrompt, runOptions);
      const startedAt = Date.now();
      const userMessage = readLastStringUserMessage(runOptions, makeError, "Claude Agents runtime");
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
                // The SDK result `subtype` carries the failure kind for error
                // results (error_during_execution, error_max_turns, ...).
                failureKind = summary.failureKind ?? "runtime_error";
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

      return buildRuntimeResult({
        text: finalText,
        events,
        model: runOptions.model,
        numTurns,
        durationMs: elapsed,
        usage,
        cost: totalCostUsd === undefined ? undefined : { totalUsd: totalCostUsd },
        providerSessionId,
        stopReason,
        cancelled,
        failureKind,
        error: errorMessage,
      });
    },
  };
}

function makeError(code: "invalid_options", message: string): ClaudeAgentsRuntimeError {
  return new ClaudeAgentsRuntimeError(code, message);
}

function assertRunOptions(systemPrompt: string, runOptions: RuntimeRunOptions): void {
  assertBaseRunOptions(systemPrompt, runOptions, makeError, "Claude Agents runtime");
  const sdk = runOptions.model.sdk;
  if (typeof sdk !== "string" || !ACCEPTED_SDK_IDS.has(sdk)) {
    throw new ClaudeAgentsRuntimeError(
      "invalid_options",
      `Claude Agents runtime only serves sdk ${[...ACCEPTED_SDK_IDS].join("/")}; received ${String(sdk)}.`,
      { receivedSdk: sdk },
    );
  }
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
  if (options.apiKey === undefined) {
    return (): void => undefined;
  }
  return applyTemporaryEnv({ [options.apiKeyEnv ?? DEFAULT_API_KEY_ENV]: options.apiKey });
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
  readonly failureKind?: string;
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
  // SDKResultMessage carries `is_error: boolean` on both the success and error
  // variants, and the error variant's `subtype` is the failure kind
  // (error_during_execution / error_max_turns / error_max_budget_usd /
  // error_max_structured_output_retries). There is no top-level `error` string;
  // human-readable detail lives in `errors: string[]`.
  // (Verified against @anthropic-ai/claude-agent-sdk@0.3.143 sdk.d.ts:3334-3378.)
  const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
  const isError = (message as { is_error?: unknown }).is_error === true || (subtype !== undefined && subtype !== "success");
  const failureKind = isError && subtype !== undefined && subtype !== "success" ? subtype : undefined;
  const errorMessage = isError ? errorMessageFromResult(message) : undefined;
  return {
    ...(text === undefined ? {} : { text }),
    numTurns,
    durationMs,
    ...(usage === undefined ? {} : { usage }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(sessionId === undefined ? {} : { sessionId }),
    stopReason,
    isError,
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function errorMessageFromResult(message: ClaudeSDKMessageLike): string | undefined {
  const errors = (message as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const joined = errors.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).join("; ");
    if (joined.length > 0) {
      return joined;
    }
  }
  return undefined;
}
