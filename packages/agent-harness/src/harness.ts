import { loadContextFromFiles } from "@mono-agent/context";
import type { BuiltAgentContext, ContextBlockInput, HistoryMessage } from "@mono-agent/context";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import type { RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { loadSelectedSkills } from "@mono-agent/skills";
import { failClosedToolPolicy, toolPolicyToRuntimeOptions } from "@mono-agent/tool-policy";

import { NoopRunRecorder } from "./recorder.js";
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

  constructor(options: AgentHarnessOptions) {
    validateOptions(options);
    this.options = options;
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

    let context: BuiltAgentContext | undefined;
    try {
      const prepared = await this.prepareContext(request);
      context = prepared.context;
      const runtimeResult = await this.runRuntime(request, recorder, context, runId);
      const failure = failureFromRuntimeResult(runtimeResult);
      const summary = await recorder.finish(failure === undefined ? runtimeResult : { ...runtimeResult, failureKind: failure.kind, error: failure.message });
      const baseMetadata = responseMetadata(runId, request, context, summary, runtimeResult);

      if (failure !== undefined) {
        return { metadata: baseMetadata, failure };
      }

      const text = normalizeAssistantText(runtimeResult.text);
      if (text === undefined) {
        return {
          metadata: baseMetadata,
          failure: {
            kind: "empty_response",
            message: "Runtime completed without assistant text.",
            details: runtimeResult,
          },
        };
      }

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
    }
  }

  private async prepareContext(request: AgentHarnessRequest): Promise<{ readonly context: BuiltAgentContext }> {
    const history = await this.loadHistory(request.conversationId);
    const memory = await this.loadMemory(request.conversationId);
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

  private async loadMemory(conversationId: string): Promise<ContextBlockInput | undefined> {
    const block = await this.options.memory?.load(conversationId);
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
    return await loadSelectedSkills({
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
  ): Promise<RuntimeResult> {
    const hostOnEvent = request.onEvent;
    const policyOptions = toolPolicyToRuntimeOptions(this.options.toolPolicy ?? failClosedToolPolicy());
    const requestExtension = await this.options.runtimeOptionsForRequest?.({ request, runId, context });
    const runtimeOptions: RuntimeRunOptions = {
      ...mergeRuntimeOptions(
        policyOptions,
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

    if (this.options.memory !== undefined && this.options.memoryWriteMode === "append-host-summary") {
      await this.options.memory.appendHostSummary(request.conversationId, deterministicHostSummary(request.userMessage, assistantText));
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
      merged[key] = value;
    }
  }
  return merged;
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

function createDefaultRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
