// Own admission/queues/persistence, but depend on Pi's loop and all providers.
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { normalizeContext, toToolDeclaration } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { buildPiSessionContext } from "./session-context.js";
import { convertToLlm } from "./compaction-kit/messages.js";
import { estimateContextTokens, shouldCompact } from "./compaction-kit/compaction.js";
import { BACKOFF_ABORT, createRetryStream } from "./retry-stream.js";

export function createRunDriver(store, options) {
  const listeners = new Set();
  const registrations = new Map();
  const queue = new Map();
  const messageIds = new WeakMap();
  let runId, controller, running;
  let closed = false, compactionArmed = false;
  let settings = { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 };
  let tools = options.tools || [];
  const retry = { enabled: true, maxRetries: 3, baseDelayMs: 1000, ...options.retry };
  if (!Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < 0
    || !Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0) throw new RangeError("Invalid Pi retry policy");

  function on(type, handler) {
    const handlers = registrations.get(type) || new Set();
    handlers.add(handler); registrations.set(type, handlers);
    return () => handlers.delete(handler);
  }
  async function hooks(type, event) {
    /** @type {any} */
    let merged;
    for (const handler of registrations.get(type) || []) {
      const value = await handler(event, { abortSignal: controller?.signal });
      if (value !== undefined) merged = { ...merged, ...value };
    }
    return merged;
  }
  function publish(event) {
    const envelope = { lane: "main", ...(runId ? { runId } : {}), ...event };
    for (const listener of listeners) {
      try { listener(envelope); }
      catch (error) {
        // Match the old harness event bus: a subscriber failure is diagnostic,
        // not a provider/tool failure or a reason to repeat an effect.
        const fault = { type: "handler_error", lane: "main", runId, eventType: event.type, error };
        for (const observer of listeners) {
          try { observer(fault); } catch { /* don't recursively publish faults */ }
        }
      }
    }
  }
  async function emit(event) {
    if (event.message?.[BACKOFF_ABORT]) return;
    if (event.type === "agent_start" || event.type === "agent_end"
      || ((event.type === "message_start" || event.type === "message_end") && event.message.role === "system")) return;
    if (event.type === "message_end") {
      if (event.message.role === "assistant") await hooks("after_response", { message: event.message });
      const id = messageIds.get(event.message) || randomUUID();
      const entryId = await store.appendMessage(event.message, id);
      const queued = queue.get(id);
      if (queued) queued.state = "placed";
      publish({ ...event, entryId });
    } else publish(event);
  }
  async function poll() {
    if (controller?.signal.aborted || closed) return [];
    const pending = [...queue.values()].filter((q) => q.state === "queued");
    const selected = options.steeringMode === "all" ? pending : pending.slice(0, 1);
    for (const q of selected) q.state = "selected";
    return selected.map((q) => q.message);
  }
  async function performCompaction(reason = "manual") {
    publish({ type: "compaction_start", reason });
    const context = { abortSignal: controller?.signal || new AbortController().signal };
    let entry, ended = false;
    try {
      let decision;
      for (const handler of registrations.get("before_compaction") || []) {
        decision = await handler({ reason, branchEntries: await store.getEntries(), signal: context.abortSignal, context }, context);
        if (decision !== undefined) break;
      }
      if (!decision || decision.decline || !decision.compaction) {
        if (reason === "manual") throw new Error("Pi compaction cancelled");
        return;
      }
      if (context.abortSignal.aborted) throw new Error("Pi compaction aborted");
      const id = await store.appendCompaction(decision.compaction);
      entry = await store.getEntry(id);
      // Publication is after placement, never merely after summary generation.
      ended = true;
      publish({ type: "compaction_end", reason, status: "completed", entry, compaction: entry });
      return entry;
    } catch (error) {
      ended = true;
      publish({ type: "compaction_end", reason, status: "failed", error, cancelled: true });
      throw error;
    } finally {
      if (!ended && reason !== "manual") publish({ type: "compaction_end", reason, status: "declined", cancelled: true });
    }
  }
  async function requestContext() {
    const messages = buildPiSessionContext(await store.getEntries());
    // The host supplies the current prompt/loadout on every reopen. Rebuild that
    // leading declaration after compaction too, without duplicating old prompts.
    return { messages: normalizeContext({ systemPrompt: options.systemPrompt,
      tools: tools.map(toToolDeclaration), messages: messages.filter((m) => m.role !== "system") }).messages, tools };
  }
  async function drive(text, promptOptions) {
    if (closed || running) throw new Error("Pi harness is closed or busy");
    runId = randomUUID(); controller = new AbortController();
    const id = runId;
    promptOptions?.onOperationAdmitted?.(id);
    publish({ type: "run_start" });
    // Start synchronously owning the promise before the first storage await.
    running = (async () => {
      let opened = false, status = "failed", error;
      try {
        await store.openTurn(id, { model: { provider: options.model.provider, id: options.model.id } }); opened = true;
        const messages = buildPiSessionContext(await store.getEntries());
        /** @type {any[]} */
        const prompts = [{ role: "user", content: [{ type: "text", text }, ...(promptOptions?.images || [])], timestamp: Date.now() }];
        await runAgentLoop(prompts, { messages, tools }, {
          ...options.streamOptions,
          sessionId: store.metadata.id,
          model: options.model,
          reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
          convertToLlm,
          toolExecution: options.toolExecution,
          getSteeringMessages: poll,
          getFollowUpMessages: async () => [],
          prepareRequest: async () => {
            if (compactionArmed && settings.enabled) {
              const messages = buildPiSessionContext(await store.getEntries());
              if (shouldCompact(estimateContextTokens(messages).tokens, options.model.contextWindow, settings)) await performCompaction("threshold");
            }
            return { context: await requestContext() };
          },
          beforeToolCall: async ({ toolCall, args }) => {
            const result = await hooks("before_tool", { toolName: toolCall.name, toolCallId: toolCall.id, args });
            return result?.block ? { block: true, ...result.block } : undefined;
          },
          afterToolCall: async ({ toolCall, result, isError }) => hooks("after_tool", {
            toolName: toolCall.name, toolCallId: toolCall.id, ...result, isError,
          }),
          onPayload: async (payload, model) => {
            const result = await hooks("before_payload", { payload, model: model || options.model });
            return result?.payload;
          },
        }, emit, controller.signal, (model, context, streamOptions) => /** @type {any} */ (createRetryStream(
          options.models, model, context, streamOptions, retry, emit,
        )));
        const entries = await store.getEntries();
        const final = [...entries].reverse().find((e) => e.type === "message" && e.message.role === "assistant")?.message;
        status = controller.signal.aborted || final?.stopReason === "aborted" ? "aborted"
          : final?.stopReason === "error" ? "failed" : "completed";
        if (final?.stopReason === "deferred") { status = "failed"; error = { code: "assistant_deferred", message: "Provider deferred the response" }; }
        if (status === "failed" && !error) error = { code: "assistant_error", message: final?.errorMessage || "Pi assistant failed" };
      } catch (cause) {
        controller.abort(cause);
        error = { code: "run_failed", message: cause?.message || String(cause) };
        throw cause;
      } finally {
        if (opened) await store.closeTurn(id, status);
        publish({ type: "run_end", status, error });
      }
      return { operationId: id, status, error, tipId: await store.getLeafId() };
    })();
    try { return await running; } finally { running = null; }
  }
  return {
    hooks: { on },
    emit,
    prompt: drive,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async steer(message) {
      if (closed) throw new Error("Pi harness is closed");
      const entryId = randomUUID(); const copy = typeof message === "string"
        ? { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }
        : structuredClone(message);
      messageIds.set(copy, entryId); queue.set(entryId, { message: copy, state: "queued" });
      return entryId;
    },
    async cancelQueued(entryId) {
      const item = queue.get(entryId);
      if (item?.state === "queued") { queue.delete(entryId); return { kind: "cancelled", entryId }; }
      return { kind: item ? "already_placed" : "not_found", entryId };
    },
    async abort() { controller?.abort(); },
    async waitForIdle() { await running; },
    async compact() {
      if (running || closed) throw new Error("Pi harness is closed or busy");
      controller = new AbortController();
      running = performCompaction();
      try { return await running; } finally { running = null; }
    },
    setTools(value) { tools = value; },
    setMidRunCompactionArmed(value) { compactionArmed = value === true; },
    setCompactionSettings(value) { settings = { ...settings, ...value }; },
    async abortOpenOperations() {
      for (const turn of await store.getOpenTurns()) await store.closeTurn(turn.runId, "aborted");
    },
    async close() { closed = true; controller?.abort(); await running; },
  };
}
