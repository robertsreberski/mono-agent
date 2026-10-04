// @ts-check
// Compatibility boundary between mono-agent's Pi-native bridge and the
// mono-owned harness built on the pinned Pi agent loop.

import { createRunDriver } from "./harness/run-driver.js";
import { PI_CONTEXT } from "./harness/context.js";
import { buildPiSessionContext } from "./harness/session-context.js";
import { installPromptCacheDiagnostics, promptCacheRequest } from "./prompt-cache-diagnostics.js";
import { createToolExecutionGate, isSharedTool } from "./tool-execution-gate.js";
export { PI_CONTEXT, buildPiSessionContext };

/** @param {any} rawSession */
export function createPiSessionAdapter(rawSession) {
  let driver = null;
  let closePromise = null;
  return {
    rawSession,
    get metadata() { return rawSession.metadata; },
    attach(nextDriver) { driver = nextDriver; },
    async buildContext() { return { messages: buildPiSessionContext(await rawSession.getEntries(), { includeFailed: true }) }; },
    getEntries: () => rawSession.getEntries(),
    getLeafId: () => rawSession.getLeafId(),
    appendMessage: (message) => rawSession.appendMessage(message),
    moveTo: (targetId) => rawSession.moveTo(targetId),
    getMetadata: () => Promise.resolve(rawSession.metadata),
    close() {
      if (!closePromise) closePromise = (async () => {
        if (driver) { await driver.abort(); await driver.waitForIdle(); }
        await rawSession.close();
      })();
      return closePromise;
    },
  };
}

/** @param {any} session @param {any} options */
export async function createPiHarnessAdapter(session, options) {
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
    async execute(toolCallId, params, signal, onUpdate) {
      const release = gate ? await gate.acquire(isSharedTool(tool), signal) : () => {};
      try {
        if (runState.stopping || signal?.aborted) throw new Error("tool execution aborted");
        if (questionState.awaiting) throw new Error("Child turn ended awaiting a parent reply.");
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        if (tool.name === "AskParent" && result?.details?.tool === "AskParent") questionState.awaiting = true;
        return result;
      } finally { release(); }
    },
  }));
  let driver;
  let removeDiagnostics = () => {};
  let currentActiveToolNames = originalTools.map((tool) => tool.name);
  let closed = false;
  try {
    driver = createRunDriver(session.rawSession, { ...options, tools: adaptedTools, toolExecution });
    session.attach(driver);
    if (currentActiveToolNames.includes("FinishSilently") && options.silentTurnState) {
      driver.hooks.on("after_response", (event) => {
        const calls = event.message.content.filter((part) => part.type === "toolCall");
        options.silentTurnState.soleCall = calls.length === 1 && calls[0].name === "FinishSilently";
        if (event.message.content.some((part) => part.type === "text" && part.text?.trim())) options.silentTurnState.visibleContent = true;
      });
    }
    if (currentActiveToolNames.includes("AskParent")) {
      let questionBatch = false;
      driver.hooks.on("after_response", (event) => {
        questionBatch = event.message.content.some((part) => part.type === "toolCall" && part.name === "AskParent");
      });
      driver.hooks.on("before_tool", () => questionState.awaiting
        ? { block: { reason: "Child turn ended awaiting a parent reply.", terminate: true } } : undefined);
      driver.hooks.on("after_tool", (event) => {
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
    getActiveTools: () => originalTools.filter((tool) => currentActiveToolNames.includes(tool.name)),
    async setActiveTools(names) {
      currentActiveToolNames = [...names];
      driver.setTools(adaptedTools.filter((tool) => names.includes(tool.name)));
    },
    async setCompactionSettings(settings) { driver.setCompactionSettings(settings); },
    setMidRunCompactionArmed(value) { driver.setMidRunCompactionArmed(value); },
    appendMessage: (message) => session.appendMessage(message),
    async prompt(text, promptOptions) {
      if (closed) throw new Error("Pi harness is closed");
      runState.stopping = false; questionState.awaiting = false; gate?.resume();
      return driver.prompt(text, promptOptions);
    },
    steer: (message) => driver.steer(message),
    cancelQueued: (entryId) => driver.cancelQueued(entryId),
    async abort() { stopTools(); await driver.abort(); },
    waitForIdle: () => driver.waitForIdle(),
    compact: () => driver.compact(),
    on(type, handler) {
      if (type === "tool_result") return driver.hooks.on("after_tool", handler);
      if (type === "session_before_compact") return driver.hooks.on("before_compaction", async (event) => {
        const result = await handler(event);
        if (result?.cancel) return { decline: true };
        return result?.compaction === undefined ? undefined : { compaction: result.compaction };
      });
      throw new Error(`Unsupported Pi harness hook: ${String(type)}`);
    },
    subscribe: (listener) => driver.subscribe(listener),
    async abortOpenOperations() { await driver.abortOpenOperations(); },
    async close() {
      stopTools();
      if (closed) return; closed = true;
      removeDiagnostics();
      await driver.close();
      await session.close();
    },
  };
}
