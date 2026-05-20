import type { MonoRuntimeLike, RuntimeEventLike, RuntimeResult, RuntimeRunOptions } from "@worklab-ai/runtime-adapter";

import { normalizeCodexItemEvent } from "./codex-events.js";
import { createJsonRpcClient } from "./json-rpc-client.js";
import type { JsonRpcClient } from "./json-rpc-client.js";
import { translateMcpServersForCodex } from "./translations.js";

export interface CodexAppRuntimeOptions {
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly threadStartTimeoutMs?: number;
  readonly threadStartAttempts?: number;
  readonly threadStartBackoffMs?: number;
  readonly requestTimeoutMs?: number;
  readonly stderrTailBytes?: number;
  readonly sdkOptions?: Record<string, unknown>;
  readonly clientFactory?: CodexClientFactory;
}

export type CodexClientFactory = (input: CodexClientFactoryInput) => JsonRpcClient;

export interface CodexClientFactoryInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly stderrTailBytes: number;
  readonly onNotification: (method: string, params: Record<string, unknown>) => void;
  readonly onWarning: (message: string) => void;
}

export class CodexAppRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAppRuntimeError";
    this.code = code;
  }
}

const DEFAULTS = {
  command: "codex",
  args: ["app-server", "--listen", "stdio://"],
  apiKeyEnv: "OPENAI_API_KEY",
  threadStartTimeoutMs: 60_000,
  threadStartAttempts: 2,
  threadStartBackoffMs: 5_000,
  requestTimeoutMs: 30_000,
  stderrTailBytes: 8_192,
} as const;

export function createCodexAppRuntime(options: CodexAppRuntimeOptions = {}): MonoRuntimeLike {
  return {
    async run(systemPrompt: string, runOptions: RuntimeRunOptions): Promise<RuntimeResult> {
      assertRunOptions(systemPrompt, runOptions);
      const startedAt = Date.now();
      const userMessage = readUserMessage(runOptions);

      const command = options.command ?? DEFAULTS.command;
      const args = options.args ?? DEFAULTS.args;
      const env = mergeEnv(options);
      const stderrTailBytes = options.stderrTailBytes ?? DEFAULTS.stderrTailBytes;
      const threadStartTimeoutMs = options.threadStartTimeoutMs ?? DEFAULTS.threadStartTimeoutMs;
      const threadStartAttempts = clamp(options.threadStartAttempts ?? DEFAULTS.threadStartAttempts, 1, 5);
      const threadStartBackoffMs = clamp(options.threadStartBackoffMs ?? DEFAULTS.threadStartBackoffMs, 0, 300_000);
      const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
      const clientFactory = options.clientFactory ?? defaultClientFactory;

      const events: RuntimeEventLike[] = [];
      const agentTextByItem = new Map<string, string>();
      let assistantText = "";
      let threadId: string | undefined;
      let activeTurnId: string | undefined;
      let turnUsage: unknown;
      let hadPartialProgress = false;
      let failureKind: string | undefined;
      let errorMessage: string | undefined;
      let threadStartAttemptsUsed = 0;
      let threadStartDurationMs = 0;
      let resolveTurnCompleted: (() => void) | undefined;
      const turnCompleted = new Promise<void>((resolve) => {
        resolveTurnCompleted = resolve;
      });

      const emit = (event: RuntimeEventLike): void => {
        events.push(event);
        runOptions.onEvent?.(event);
      };

      const handleNotification = (method: string, params: Record<string, unknown>): void => {
        if (method === "turn/started" && typeof params.turnId === "string") {
          activeTurnId = params.turnId;
          emit({ type: "cli_event", raw: { type: "turn_started", ...params } });
          return;
        }
        if (method === "turn/completed") {
          if (isObject(params.usage)) {
            turnUsage = params.usage;
          }
          emit({ type: "cli_event", raw: { type: "turn_completed", ...params } });
          resolveTurnCompleted?.();
          return;
        }
        if (method === "item/agentMessage/delta" && typeof params.itemId === "string") {
          const current = agentTextByItem.get(params.itemId) ?? "";
          const delta = typeof params.delta === "string" ? params.delta : "";
          agentTextByItem.set(params.itemId, current + delta);
          hadPartialProgress = true;
          return;
        }
        if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
          const delta = typeof params.delta === "string" ? params.delta : "";
          emit({ type: "assistant", message: { content: [{ type: "thinking", text: delta }] } });
          return;
        }
        if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
          const text = typeof params.message === "string" ? params.message : typeof params.error === "string" ? params.error : JSON.stringify(params);
          emit({ type: "runtime_warning", warning_kind: method.replace(/\W+/g, "_"), message: text });
          return;
        }
        if (method === "item/started" || method === "item/completed") {
          const item = isObject(params.item) ? (params.item as Record<string, unknown>) : undefined;
          if (item !== undefined && item.type === "agentMessage" && method === "item/completed") {
            const id = typeof item.id === "string" ? item.id : "agent_message";
            const text = typeof item.text === "string" && item.text.length > 0
              ? item.text
              : agentTextByItem.get(id) ?? "";
            assistantText = text;
            emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
            return;
          }
          if (item === undefined) {
            return;
          }
          const normalized = normalizeCodexItemEvent({ type: method.replace("/", "."), item });
          if (normalized !== null) {
            emit(normalized);
          }
          return;
        }
      };

      const client = clientFactory({
        command,
        args,
        env,
        stderrTailBytes,
        onNotification: handleNotification,
        onWarning: (message) => emit({ type: "runtime_warning", warning_kind: "malformed_stdout", message }),
      });

      const abortHandler = (): void => {
        if (threadId !== undefined && activeTurnId !== undefined) {
          void client
            .request({ method: "turn/interrupt", params: { threadId, turnId: activeTurnId }, timeoutMs: 5_000 })
            .catch(() => undefined);
        }
        void client.close().catch(() => undefined);
      };
      if (runOptions.abortSignal.aborted) {
        abortHandler();
      } else {
        runOptions.abortSignal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        const threadStartedAt = Date.now();
        const threadParams = buildThreadStartParams(systemPrompt, runOptions, options);
        const startResult = await callWithRetries(
          () => client.request({ method: "thread/start", params: threadParams, timeoutMs: threadStartTimeoutMs }),
          threadStartAttempts,
          threadStartBackoffMs,
          (used) => {
            threadStartAttemptsUsed = used;
          },
        );
        threadStartDurationMs = Date.now() - threadStartedAt;
        threadId = extractThreadId(startResult);
        if (threadId === undefined) {
          throw new CodexAppRuntimeError("thread_start_failed", "Codex thread/start did not return a threadId.");
        }
        await client.request({
          method: "turn/send",
          params: { threadId, message: { role: "user", content: userMessage } },
          timeoutMs: requestTimeoutMs,
        });
        await waitForTurnCompletion(turnCompleted, runOptions.abortSignal);
      } catch (error) {
        if (error instanceof CodexAppRuntimeError) {
          failureKind = error.code;
          errorMessage = error.message;
        } else {
          failureKind = runOptions.abortSignal.aborted ? "cancelled" : "runtime_error";
          errorMessage = error instanceof Error ? error.message : String(error);
        }
      } finally {
        try {
          runOptions.abortSignal.removeEventListener?.("abort", abortHandler);
        } catch {
          // ignore
        }
        await client.close();
      }

      const cancelled = runOptions.abortSignal.aborted;
      const stderrTail = client.stderrTail();
      const durationMs = Date.now() - startedAt;
      const finalText = assistantText.length > 0 ? assistantText : undefined;

      const diagnostics: Record<string, unknown> = {
        codex_thread_start_attempts: threadStartAttemptsUsed,
        codex_thread_start_duration_ms: threadStartDurationMs,
        had_partial_progress: hadPartialProgress,
      };
      if (stderrTail.length > 0) {
        diagnostics.stderr_tail = stderrTail;
      }

      const result: RuntimeResult = {
        ...(finalText === undefined ? {} : { text: finalText }),
        events,
        sdk: runOptions.model.sdk,
        model: runOptions.model.model,
        numTurns: activeTurnId === undefined ? 0 : 1,
        durationMs,
        ...(turnUsage === undefined ? {} : { usage: turnUsage }),
        ...(threadId === undefined ? {} : { providerSessionId: threadId }),
        ...(cancelled ? { cancelled: true } : {}),
        ...(failureKind === undefined ? {} : { failureKind }),
        ...(errorMessage === undefined ? {} : { error: errorMessage }),
        diagnostics,
      };
      return result;
    },
  };
}

function defaultClientFactory(input: CodexClientFactoryInput): JsonRpcClient {
  return createJsonRpcClient(input);
}

function assertRunOptions(systemPrompt: string, runOptions: RuntimeRunOptions): void {
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    throw new CodexAppRuntimeError("invalid_options", "Codex app runtime requires a non-empty system prompt.");
  }
  if (!runOptions || !runOptions.model || typeof runOptions.model.model !== "string" || runOptions.model.model.length === 0) {
    throw new CodexAppRuntimeError("invalid_options", "Codex app runtime requires runOptions.model.model.");
  }
  if (!(runOptions.abortSignal instanceof AbortSignal)) {
    throw new CodexAppRuntimeError("invalid_options", "Codex app runtime requires runOptions.abortSignal.");
  }
}

function readUserMessage(runOptions: RuntimeRunOptions): string {
  const last = runOptions.messages[runOptions.messages.length - 1];
  if (last === undefined) {
    throw new CodexAppRuntimeError("invalid_options", "Codex app runtime requires at least one message.");
  }
  if (typeof last.content !== "string") {
    throw new CodexAppRuntimeError("invalid_options", "Codex app runtime only supports string message content.");
  }
  return last.content;
}

function mergeEnv(options: CodexAppRuntimeOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (options.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) {
      env[key] = value;
    }
  }
  if (options.apiKey !== undefined) {
    env[options.apiKeyEnv ?? DEFAULTS.apiKeyEnv] = options.apiKey;
  }
  return env;
}

function buildThreadStartParams(
  systemPrompt: string,
  runOptions: RuntimeRunOptions,
  options: CodexAppRuntimeOptions,
): Record<string, unknown> {
  const mcpServers = translateMcpServersForCodex(runOptions.mcpServers);
  const params: Record<string, unknown> = {
    ...(options.sdkOptions ?? {}),
    model: runOptions.model.model,
    instructions: systemPrompt,
  };
  if (runOptions.cwd !== undefined) {
    params.cwd = runOptions.cwd;
  }
  if (Object.keys(mcpServers).length > 0) {
    params.mcp_servers = mcpServers;
  }
  return params;
}

async function callWithRetries<T>(
  call: () => Promise<T>,
  maxAttempts: number,
  backoffMs: number,
  onAttempt: (used: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onAttempt(attempt);
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new CodexAppRuntimeError("thread_start_failed", String(lastError));
}

async function waitForTurnCompletion(turnCompleted: Promise<void>, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
    void turnCompleted.then(() => {
      abortSignal.removeEventListener?.("abort", onAbort);
      resolve();
    });
  });
}

function extractThreadId(value: unknown): string | undefined {
  if (isObject(value) && typeof value.threadId === "string") {
    return value.threadId;
  }
  if (isObject(value) && typeof value.thread_id === "string") {
    return value.thread_id;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
