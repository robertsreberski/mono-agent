import type { PiSession, PiHarnessOptions, PiDriver, PiTool } from "./types.js";
// @ts-check
// Runtime integration for the mono-agent engine over the pinned Pi loop.

import { effectivePayloadEffort } from "../../providers/pi/effective-effort.js";
import { createRunDriver } from "../../engine/run-driver.js";

import { installPromptCacheDiagnostics, promptCacheRequest } from "./prompt-cache-diagnostics.js";
import { createToolExecutionGate, isSharedTool } from "./tool-execution-gate.js";

/** @param {any} session @param {any} options */
export function createHarnessAdapter(session: any, options: any): Promise<{
    models: any;
    getPromptCacheRequest: () => any;
    getModel: () => any;
    getThinkingLevel: () => any;
    getEffectiveEffort: () => any;
    getActiveTools: () => any;
    setActiveTools(names: any): Promise<void>;
    setCompactionSettings(settings: any): Promise<void>;
    setMidRunCompactionArmed(value: any): void;
    appendMessage: (message: any) => any;
    beginTurn: (id: any, source: any, descriptor: any) => Promise<void>;
    endTurn: (status: any, result: any) => Promise<void>;
    prompt(text: any, promptOptions: any): Promise<{
        tipId: any;
        deferred?: any;
        operationId: `${string}-${string}-${string}-${string}-${string}`;
        status: string;
        error: {
            code: string;
            message: any;
        };
    }>;
    steer: (message: any, identity: any) => Promise<`${string}-${string}-${string}-${string}-${string}`>;
    cancelQueued: (entryId: any) => Promise<any>;
    abort(): Promise<void>;
    waitForIdle: () => Promise<void>;
    compact: () => Promise<any>;
    on(type: any, handler: any): () => any;
    subscribe: (listener: any) => () => boolean;
    abortOpenOperations(): Promise<void>;
    repairOpenOperations(): Promise<void>;
    close(): Promise<void>;
}>;
export async function createHarnessAdapter(session: PiSession, options: PiHarnessOptions) {
  const originalTools = Array.isArray(options.tools) ? options.tools : [];
  const toolExecution = options.toolExecutionMode === "sequential" ? "sequential" : "parallel";
  const gate = toolExecution === "parallel" ? createToolExecutionGate() : null;
  const questionState = { awaiting: false };
  const runState = { stopping: false, stopEpoch: 0 };
  const stopTools = () => { runState.stopping = true; runState.stopEpoch += 1; gate?.stop(); };
  const adaptedTools = originalTools.map((tool) => ({
    ...tool,
    // The FIFO host gate, not a static loadout-wide scheduling override, owns
    // shared/exclusive admission for dynamically invoked calls.
    executionMode: toolExecution,
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: ((update: any) => void) | undefined) {
      const release = gate ? await gate.acquire(isSharedTool(tool), signal!) : () => {};
      try {
        if (runState.stopping || signal?.aborted) throw new Error("tool execution aborted");
        if (questionState.awaiting) throw new Error("Child turn ended awaiting a parent reply.");
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        if (tool.name === "AskParent" && result?.details?.tool === "AskParent") questionState.awaiting = true;
        return result;
      } finally { release(); }
    },
  }));
  let driver: PiDriver;
  let effectiveEffort: string | undefined;
  let removeDiagnostics = () => {};
  let currentActiveToolNames = originalTools.map((tool) => tool.name);
  let closed = false;
  try {
    driver = createRunDriver(session.rawSession, { ...options, tools: adaptedTools, toolExecution,
      onPreparedPayload(payload: any, model: import("./types.js").PiModel) {
        effectiveEffort = effectivePayloadEffort(payload, model);
        options.onEffectiveEffort?.(effectiveEffort);
      } });
    session.attach(driver);
    if (currentActiveToolNames.includes("FinishSilently") && options.silentTurnState) {
      driver.hooks.on("after_response", (event: any) => {
        const calls = event.message.content.filter((part: any) => part.type === "toolCall");
        options.silentTurnState!.soleCall = calls.length === 1 && calls[0]!.name === "FinishSilently";
        if (event.message.content.some((part: any) => part.type === "text" && part.text?.trim())) options.silentTurnState!.visibleContent = true;
      });
    }
    if (currentActiveToolNames.includes("AskParent")) {
      let questionBatch = false;
      driver.hooks.on("after_response", (event: any) => {
        questionBatch = event.message.content.some((part: any) => part.type === "toolCall" && part.name === "AskParent");
      });
      driver.hooks.on("before_tool", () => questionState.awaiting
        ? { block: { reason: "Child turn ended awaiting a parent reply.", terminate: true } } : undefined);
      driver.hooks.on("after_tool", (event: any) => {
        if (event.toolName === "AskParent" && !event.isError && event.details?.tool === "AskParent") questionState.awaiting = true;
        return questionState.awaiting || (questionBatch && event.toolName !== "AskParent") ? { terminate: true } : undefined;
      });
    }
    removeDiagnostics = installPromptCacheDiagnostics(driver, options);
  } catch (error) {
    try { await session.close(); } catch { /* preserve construction error */ }
    throw error;
  }
  return {
    models: options.models,
    getPromptCacheRequest: () => promptCacheRequest(driver),
    getModel: () => options.model,
    getThinkingLevel: () => options.thinkingLevel ?? "off",
    getEffectiveEffort: () => effectiveEffort,
    getActiveTools: () => originalTools.filter((tool) => currentActiveToolNames.includes(tool.name)),
    async setActiveTools(names: string[]) {
      currentActiveToolNames = [...names];
      driver.setTools(adaptedTools.filter((tool) => names.includes(tool.name)));
    },
    async setCompactionSettings(settings: any) { driver.setCompactionSettings(settings); },
    setMidRunCompactionArmed(value: boolean) { driver.setMidRunCompactionArmed(value); },
    appendMessage: (message: any) => session.appendMessage(message),
    beginTurn: (id: any, source: any, descriptor: any) => driver.beginTurn(id, source, descriptor),
    endTurn: (status: any, result: any) => driver.endTurn(status, result),
    async prompt(text: any, promptOptions: any) {
      if (closed) throw new Error("mono-agent harness is closed");
      runState.stopping = false; gate?.resume();
      return driver.prompt(text, promptOptions);
    },
    steer: (message: any, identity: any) => driver.steer(message, identity),
    cancelQueued: (entryId: string) => driver.cancelQueued(entryId),
    async abort() { stopTools(); await driver.abort(); },
    waitForIdle: () => driver.waitForIdle(),
    compact: () => driver.compact(),
    on(type: string, handler: (event: any) => any) {
      if (type === "before_tool") return driver.hooks.on(type, handler);
      if (type === "tool_result") return driver.hooks.on("after_tool", handler);
      if (type === "session_before_compact") return driver.hooks.on("before_compaction", async (event: any) => {
        const result = await handler(event);
        if (result?.cancel) return { decline: true };
        return result?.compaction === undefined ? undefined : { compaction: result.compaction };
      });
      throw new Error(`Unsupported mono-agent harness hook: ${String(type)}`);
    },
    subscribe: (listener: (event: any) => void) => driver.subscribe(listener),
    async abortOpenOperations() { await driver.abortOpenOperations(); },
    async repairOpenOperations() { await driver.repairOpenOperations(); },
    async close() {
      stopTools();
      if (closed) return; closed = true;
      removeDiagnostics();
      await driver.close();
      await session.close();
    },
  };
}
