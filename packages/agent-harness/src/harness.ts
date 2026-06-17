import { loadContextFromFiles } from "@mono-agent/context";
import type { BuiltAgentContext, ContextBlockInput, HistoryMessage } from "@mono-agent/context";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import { monoRuntimeSupportsSessionResume } from "@mono-agent/runtime-adapter";
import type { RuntimeExecutionMode, RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { createSkillsCache } from "@mono-agent/skills";
import type { SkillsCache } from "@mono-agent/skills";
import { mergeSandboxPolicies, sandboxPolicyToRuntimeOptions } from "@mono-agent/sandbox";
import type { SandboxPolicy } from "@mono-agent/sandbox";
import { failClosedToolPolicy, toolPolicyToRuntimeOptions } from "@mono-agent/tool-policy";

import { NoopRunRecorder } from "./recorder.js";
import { createLiveSessionManager } from "./live-session.js";
import type { LiveSessionManager } from "./live-session.js";
import { createRuntimeSessionStore } from "./sessions.js";
import type { RuntimeSessionRecord, RuntimeSessionStore } from "./sessions.js";
import type {
  AgentHarness,
  AgentHarnessFailure,
  AgentHarnessOptions,
  AgentHarnessRequest,
  AgentHarnessResponse,
  AgentHarnessRuntimeOptionsExtension,
} from "./types.js";

export class AgentHarnessError extends Error {
  readonly failureKind: string;
  readonly details?: unknown;

  constructor(failureKind: string, message: string, details?: unknown) {
    super(message);
    this.name = "AgentHarnessError";
    this.failureKind = failureKind;
    this.details = details;
  }
}

export class MonoAgentHarness implements AgentHarness {
  private readonly options: AgentHarnessOptions;
  private readonly sessionStore: RuntimeSessionStore | undefined;
  private readonly liveSessionManager: LiveSessionManager | undefined;
  private readonly skillsCache: SkillsCache;
  private supportsResumeCache: boolean | undefined;

  constructor(options: AgentHarnessOptions) {
    validateOptions(options);
    this.options = options;
    // Skills are otherwise re-read from disk every turn. A per-harness cache
    // (or a shared one passed in) skips unchanged reads across turns.
    this.skillsCache = options.skillsCache ?? createSkillsCache();
    this.sessionStore = options.session?.mode === "continuous"
      ? createRuntimeSessionStore({
        idleTimeoutMs: options.session.idleTimeoutMs,
        onEvict: async (record) => {
          await this.options.runtime.disposeSession?.(record.providerSessionId);
        },
      })
      : undefined;
    // Continuous mode serializes same-conversation turns through a queue so a
    // follow-up arriving mid-run is answered on the warm session after the
    // current turn (queue-after-turn), instead of racing fresh.
    this.liveSessionManager = options.session?.mode === "continuous"
      ? createLiveSessionManager({ run: (request) => this.run(request) })
      : undefined;
  }

  async submit(request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
    if (this.liveSessionManager !== undefined) {
      return this.liveSessionManager.enqueue(request.conversationId, request);
    }
    return this.run(request);
  }

  async run(request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
    validateRequest(request);
    const runId = this.options.createRunId?.() ?? createDefaultRunId();
    const recorder = this.options.recorderFactory?.({ runId, conversationId: request.conversationId }) ?? new NoopRunRecorder({ runId, conversationId: request.conversationId });
    await recorder.start?.();

    if (request.abortSignal.aborted) {
      const summary = await recorder.finish({ cancelled: true, failureKind: "cancelled" });
      return failureResponse({ runId, request, summary, kind: "cancelled", message: "Agent request was cancelled before runtime execution." });
    }

    const sessionRecord = this.sessionsEnabled() ? this.sessionStore?.acquire(request.conversationId) : undefined;
    let context: BuiltAgentContext | undefined;
    const emit = (event: RuntimeEventLike): void => {
      recorder.onEvent(event);
      request.onEvent?.(event);
    };
    try {
      let resumeSessionId = sessionRecord?.providerSessionId;
      // While a provider session is live it already holds the conversation,
      // so history is omitted from the prompt — that is the optimization.
      let prepared = await this.prepareContext(request, { omitHistory: resumeSessionId !== undefined }, emit);
      context = prepared.context;

      let runtimeResult: RuntimeResult | undefined;
      let resumeError: unknown;
      try {
        runtimeResult = await this.runRuntime(request, recorder, context, runId, resumeSessionId);
      } catch (error) {
        if (resumeSessionId === undefined || request.abortSignal.aborted) {
          throw error;
        }
        resumeError = error;
      }

      if (resumeSessionId !== undefined && (shouldRetrySessionResumeError(resumeError) || shouldRetryWithoutSession(runtimeResult, request.abortSignal.aborted))) {
        const warning: RuntimeEventLike = {
          type: "runtime_warning",
          warning_kind: "session_resume_retry",
          message: `Provider session ${resumeSessionId} could not be resumed; retrying with conversation history.`,
          provider_session_id: resumeSessionId,
        };
        recorder.onEvent(warning);
        request.onEvent?.(warning);
        await this.sessionStore?.evict(request.conversationId, "stale", resumeSessionId);
        resumeSessionId = undefined;
        prepared = await this.prepareContext(request, { omitHistory: false }, emit);
        context = prepared.context;
        runtimeResult = await this.runRuntime(request, recorder, context, runId, undefined);
      }
      if (runtimeResult === undefined) {
        throw resumeError ?? new Error("Runtime did not produce a result.");
      }

      const failure = failureFromRuntimeResult(runtimeResult);
      const summary = await recorder.finish(failure === undefined ? runtimeResult : { ...runtimeResult, failureKind: failure.kind, error: failure.message });
      const baseMetadata = responseMetadata(runId, request, context, summary, runtimeResult);

      if (failure !== undefined) {
        if (sessionRecord !== undefined && shouldRetireSessionAfterFailure(failure.kind)) {
          await this.sessionStore?.evict(request.conversationId, "stale", sessionRecord.providerSessionId);
        }
        return { metadata: baseMetadata, failure };
      }

      const text = normalizeAssistantText(runtimeResult.text);
      if (text === undefined) {
        // Empty turns are not appended to history, so a retained provider
        // session would diverge from the history store. Retire it instead;
        // the next message replays history into a fresh session.
        if (sessionRecord !== undefined) {
          await this.sessionStore?.evict(request.conversationId, "stale", sessionRecord.providerSessionId);
        } else if (this.sessionsEnabled() && typeof runtimeResult.providerSessionId === "string" && runtimeResult.providerSessionId.trim().length > 0) {
          try {
            await this.options.runtime.disposeSession?.(runtimeResult.providerSessionId);
          } catch {
            // Bridge TTL backstop reclaims it eventually.
          }
        }
        return {
          metadata: baseMetadata,
          failure: {
            kind: "empty_response",
            message: "Runtime completed without assistant text.",
            details: runtimeResult,
          },
        };
      }

      this.saveSession(request.conversationId, runtimeResult.providerSessionId, sessionRecord);

      await this.persistSuccessfulTurn(request, text);
      return {
        text,
        metadata: baseMetadata,
      };
    } catch (error) {
      const failure = failureFromThrownError(error, request.abortSignal.aborted);
      const summary = await safeRecorderFail(recorder, error);
      return {
        metadata: responseMetadata(runId, request, context, summary),
        failure,
      };
    } finally {
      if (sessionRecord !== undefined) {
        this.sessionStore?.release(request.conversationId, sessionRecord);
      }
    }
  }

  async dispose(): Promise<void> {
    // Reject any in-flight/queued turns first so callers stop waiting, then
    // retire sessions. Only this harness's tracked sessions are retired (the
    // store's onEvict disposes each provider session individually).
    // runtime.disposeAllSessions is intentionally NOT called here: the provider
    // registries are process-global and other harnesses may share them.
    this.liveSessionManager?.dispose();
    await this.sessionStore?.disposeAll();
  }

  private sessionsEnabled(): boolean {
    if (this.sessionStore === undefined) {
      return false;
    }
    if (this.supportsResumeCache === undefined) {
      const override = this.options.session?.supportsResume;
      if (override !== undefined) {
        this.supportsResumeCache = override;
      } else {
        try {
          this.supportsResumeCache = monoRuntimeSupportsSessionResume(
            this.options.model,
            this.options.executionMode as RuntimeExecutionMode | undefined,
          );
        } catch {
          this.supportsResumeCache = false;
        }
      }
    }
    return this.supportsResumeCache;
  }

  private saveSession(conversationId: string, providerSessionId: unknown, owner: RuntimeSessionRecord | undefined): void {
    if (!this.sessionsEnabled()) {
      return;
    }
    if (typeof providerSessionId !== "string" || providerSessionId.trim().length === 0) {
      return;
    }
    this.sessionStore?.save(conversationId, providerSessionId, owner);
  }

  private async prepareContext(
    request: AgentHarnessRequest,
    options: { readonly omitHistory: boolean },
    emit?: (event: RuntimeEventLike) => void,
  ): Promise<{ readonly context: BuiltAgentContext }> {
    const history = options.omitHistory ? [] : await this.loadHistory(request.conversationId);
    const memory = await this.loadMemory(request.conversationId, emit);
    const selectedSkills = await this.loadSkills();
    const context = await loadContextFromFiles({
      identityPath: this.options.identityPath,
      userMessage: request.userMessage,
      ...(this.options.soulPath === undefined ? {} : { soulPath: this.options.soulPath }),
      ...(memory === undefined ? {} : { memory }),
      ...(history.length === 0 ? {} : { history }),
      ...(selectedSkills.index.length > 0 ? { skills: selectedSkills.index } : this.options.skillsRoot === undefined ? {} : { skillsRoot: this.options.skillsRoot }),
      ...(selectedSkills.instructions.length === 0 ? {} : { skillInstructions: selectedSkills.instructions }),
    });
    return { context };
  }

  private async loadHistory(conversationId: string): Promise<readonly HistoryMessage[]> {
    return this.options.historyStore?.load(conversationId) ?? [];
  }

  private async loadMemory(
    conversationId: string,
    emit?: (event: RuntimeEventLike) => void,
  ): Promise<ContextBlockInput | undefined> {
    let block;
    try {
      block = await this.options.memory?.load(conversationId);
    } catch (error) {
      // A slow or failing memory backend (e.g. embeddings timeout / circuit
      // breaker open) must never block or fail the turn — degrade to empty
      // memory and surface a warning so the turn proceeds.
      emit?.({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
        message: `Memory recall failed; continuing without memory. ${errorMessageText(error)}`,
      });
      return undefined;
    }
    if (block === undefined) {
      return undefined;
    }
    return {
      kind: "markdown",
      content: block.content,
      source: block.source,
    };
  }

  private async loadSkills(): Promise<{ readonly index: readonly import("@mono-agent/context").SkillIndexEntry[]; readonly instructions: readonly ContextBlockInput[] }> {
    if (this.options.selectedSkills === undefined || this.options.selectedSkills.length === 0) {
      return { index: [], instructions: [] };
    }
    if (this.options.skillsRoot === undefined) {
      throw new AgentHarnessError("invalid_skill_selection", "selectedSkills requires skillsRoot.");
    }
    return await this.skillsCache.loadSelectedSkillsCached({
      skillsRoot: this.options.skillsRoot,
      names: this.options.selectedSkills,
      ...(this.options.skillMaxBytes === undefined ? {} : { maxBytes: this.options.skillMaxBytes }),
    });
  }

  private async runRuntime(
    request: AgentHarnessRequest,
    recorder: RunRecorder,
    context: BuiltAgentContext,
    runId: string,
    resumeSessionId: string | undefined,
  ): Promise<RuntimeResult> {
    const hostOnEvent = request.onEvent;
    const policyOptions = toolPolicyToRuntimeOptions(this.options.toolPolicy ?? failClosedToolPolicy());
    const sandboxOptions = this.options.sandboxPolicy === undefined
      ? {}
      : sandboxPolicyToRuntimeOptions(this.options.sandboxPolicy);
    const requestExtension = await this.options.runtimeOptionsForRequest?.({ request, runId, context });
    const runtimeOptions: RuntimeRunOptions = {
      ...mergeRuntimeOptions(
        policyOptions,
        sandboxOptions,
        this.options.runtimeOptions,
        requestExtension?.runtimeOptions,
      ),
      model: this.options.model,
      messages: [{ role: "user", content: request.userMessage }],
      abortSignal: request.abortSignal,
      ...(this.options.executionMode === undefined ? {} : { executionMode: this.options.executionMode }),
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
      // Session keys live after the merge so request extensions cannot
      // clobber the harness's session decision — including forcing the keys
      // back to undefined on fresh runs.
      ...(this.sessionsEnabled()
        ? {
          sessionKeepAlive: true,
          sessionIdleTimeoutMs: this.options.session?.idleTimeoutMs,
          sessionId: resumeSessionId,
          providerSessionId: resumeSessionId,
        }
        : {}),
      onEvent: (event: RuntimeEventLike) => {
        recorder.onEvent(event);
        hostOnEvent?.(event);
      },
    };
    try {
      return await this.options.runtime.run(context.prompt, runtimeOptions);
    } finally {
      await requestExtension?.cleanup?.();
    }
  }

  private async persistSuccessfulTurn(request: AgentHarnessRequest, assistantText: string): Promise<void> {
    const timestamp = this.options.now?.().toISOString() ?? new Date().toISOString();
    await this.options.historyStore?.append(request.conversationId, [
      { role: "user", content: request.userMessage, timestamp },
      { role: "assistant", content: assistantText, timestamp },
    ]);

    const mode = this.options.memoryWriteMode;
    if (this.options.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      // Always write the deterministic rapid-log line (sync, durable).
      await this.options.memory.appendHostSummary(
        request.conversationId,
        deterministicHostSummary(request.userMessage, assistantText),
      );
      // 'capture' additionally enqueues a best-effort intelligent capture (async, non-blocking).
      if (mode === "capture") {
        this.options.memory.scheduleCapture?.(request.conversationId, captureTurnText(request.userMessage, assistantText));
      }
    }
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new MonoAgentHarness(options);
}

function validateOptions(options: AgentHarnessOptions): void {
  if (typeof options.identityPath !== "string" || options.identityPath.trim().length === 0) {
    throw new TypeError("identityPath must be a non-empty path.");
  }
  if (typeof options.runtime?.run !== "function") {
    throw new TypeError("runtime must expose run().");
  }
  if (typeof options.model !== "object" || options.model === null) {
    throw new TypeError("model must be a parsed runtime model reference.");
  }
  if (
    options.executionMode !== undefined &&
    (typeof options.executionMode !== "string" || options.executionMode.length === 0)
  ) {
    throw new TypeError("executionMode must be an optional non-empty string.");
  }
}

function validateRequest(request: AgentHarnessRequest): void {
  if (typeof request.conversationId !== "string" || request.conversationId.trim().length === 0) {
    throw new TypeError("conversationId must be a non-empty string.");
  }
  if (typeof request.userMessage !== "string" || request.userMessage.trim().length === 0) {
    throw new TypeError("userMessage must be a non-empty string.");
  }
  if (!(request.abortSignal instanceof AbortSignal)) {
    throw new TypeError("abortSignal is required.");
  }
}

function mergeRuntimeOptions(
  ...optionsList: readonly (AgentHarnessRuntimeOptionsExtension["runtimeOptions"] | Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      if (key === "sandboxPolicy") {
        merged[key] = mergeSandboxPolicies(asSandboxPolicy(merged[key]), asSandboxPolicy(value));
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function asSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  return isRecord(value) ? value as unknown as SandboxPolicy : undefined;
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const SESSION_RESUME_RETRY_FAILURE_KINDS = new Set(["session_not_found", "session_busy"]);

function shouldRetrySessionResumeError(error: unknown): boolean {
  return SESSION_RESUME_RETRY_FAILURE_KINDS.has(failureKindFromUnknown(error));
}

function shouldRetryWithoutSession(result: RuntimeResult | undefined, aborted: boolean): boolean {
  if (result === undefined || aborted || result.cancelled === true) {
    return false;
  }
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return SESSION_RESUME_RETRY_FAILURE_KINDS.has(result.failureKind);
  }
  return false;
}

function failureKindFromUnknown(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const direct = value.failureKind;
  if (typeof direct === "string") {
    return direct.trim();
  }
  const details = value.details;
  if (isRecord(details) && typeof details.failureKind === "string") {
    return details.failureKind.trim();
  }
  return "";
}

function failureFromRuntimeResult(result: RuntimeResult): AgentHarnessFailure | undefined {
  if (result.cancelled === true) {
    return {
      kind: "cancelled",
      message: "Agent runtime run was cancelled.",
      details: result,
    };
  }
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return {
      kind: result.failureKind,
      message: typeof result.error === "string" && result.error.trim().length > 0 ? result.error : "Agent runtime failed.",
      details: result.errorDetails ?? result,
    };
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return {
      kind: "runtime_error",
      message: result.error,
      details: result.errorDetails ?? result,
    };
  }
  return undefined;
}

function shouldRetireSessionAfterFailure(kind: string): boolean {
  return kind !== "cancelled";
}

function failureFromThrownError(error: unknown, wasAborted: boolean): AgentHarnessFailure {
  if (wasAborted) {
    return { kind: "cancelled", message: "Agent request was cancelled.", details: errorToDetails(error) };
  }
  if (error instanceof AgentHarnessError) {
    return { kind: error.failureKind, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { kind: error.name || "exception", message: error.message, details: errorToDetails(error) };
  }
  return { kind: "exception", message: String(error), details: error };
}

async function safeRecorderFail(recorder: RunRecorder, error: unknown): Promise<RunSummary | undefined> {
  try {
    return await recorder.fail(error);
  } catch {
    return undefined;
  }
}

function normalizeAssistantText(text: unknown): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  return text.trim().length === 0 ? undefined : text;
}

function responseMetadata(
  runId: string,
  request: AgentHarnessRequest,
  context: BuiltAgentContext | undefined,
  summary: RunSummary | undefined,
  runtimeResult?: RuntimeResult,
): AgentHarnessResponse["metadata"] {
  return {
    runId,
    conversationId: request.conversationId,
    contextSources: context?.metadata.sources ?? [],
    contextSectionIds: context?.sections.map((section) => section.id) ?? [],
    ...(runtimeResult === undefined ? {} : { runtime: runtimeMetadata(runtimeResult) }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function runtimeMetadata(result: RuntimeResult): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of ["model", "sdk", "effort", "numTurns", "durationMs", "usage", "cost", "providerSessionId", "runtimeWarnings", "diagnostics", "capabilitiesUsed"] as const) {
    if (result[key] !== undefined) {
      metadata[key] = result[key];
    }
  }
  return metadata;
}

function failureResponse(input: {
  readonly runId: string;
  readonly request: AgentHarnessRequest;
  readonly summary: RunSummary;
  readonly kind: string;
  readonly message: string;
}): AgentHarnessResponse {
  return {
    metadata: {
      runId: input.runId,
      conversationId: input.request.conversationId,
      contextSources: [],
      contextSectionIds: [],
      summary: input.summary,
    },
    failure: {
      kind: input.kind,
      message: input.message,
    },
  };
}

function deterministicHostSummary(userMessage: string, assistantText: string): string {
  return [
    "Host-observed completed turn.",
    `User: ${compactOneLine(userMessage, 240)}`,
    `Assistant: ${compactOneLine(assistantText, 240)}`,
  ].join("\n");
}

function captureTurnText(userMessage: string, assistantText: string): string {
  // Richer than the compacted host summary: the distiller wants the real turn content.
  return `User: ${userMessage}\nAssistant: ${assistantText}`;
}

function compactOneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

function errorToDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
