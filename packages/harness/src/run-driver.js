// Own admission/queues/persistence, but depend on Pi's loop and all providers.
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { normalizeContext, toToolDeclaration } from "@earendil-works/pi-ai";
import { randomUUID, createHash } from "node:crypto";
import { buildHarnessSessionContext } from "./session-context.js";
import { convertToLlm } from "./compaction-kit/messages.js";
import { estimateContextTokens, shouldCompact } from "./compaction-kit/compaction.js";
import { recordInterruption, repairInterruptedSession, isExecutableAssistant } from "./interruption.js";
import { validateSessionTurn } from "./journal-schema.js";
import { createTurnBinding, digestTurnInput } from "./turn-evidence.js";
import { BACKOFF_ABORT, createRetryStream } from "./retry-stream.js";

export function createRunDriver(store, options) {
  const listeners = new Set();
  const registrations = new Map();
  const queue = new Map();
  const messageIds = new WeakMap();
  const executions = new Set();
  let runId, controller, running;
  let turnEnding = false;
  const inputAdmissions = new Set();
  let turnId = null, turnBinding, ownsTurn = false, promptCount = 0, initialInputKey, currentInputId;
  const modelConfig = () => ({ model: { provider: options.model.provider, id: options.model.id, api: options.model.api } });
  async function beginTurn(id = `synthetic:runtime:${randomUUID()}`, source = "synthetic", descriptor) {
    if (turnId || turnEnding) throw new Error("Pi logical turn is already open");
    if (descriptor) {
      validateSessionTurn(descriptor, store.metadata.id);
      if (source !== "synthetic" && (source !== descriptor.kind || id !== descriptor.turnId)) {
        throw new TypeError("Logical turn does not match sessionTurn descriptor");
      }
      const owner = { kind: descriptor.kind, ownerKey: descriptor.ownerKey, historyBucket: descriptor.historyBucket };
      if (store.validator.owner.kind !== "unbound" && (store.validator.owner.kind !== owner.kind
        || store.validator.owner.ownerKey !== owner.ownerKey || store.validator.owner.historyBucket !== owner.historyBucket)) {
        throw new Error("Native journal ownership does not match sessionTurn");
      }
    }
    const needsOwnerBinding = store.validator.owner.kind === "unbound";
    turnBinding = descriptor ? createTurnBinding(descriptor, modelConfig().model) : undefined;
    await store.beginTurn(id, modelConfig(), source, turnBinding); await store.sync(); turnId = id; promptCount = 0; initialInputKey = undefined;
    if (descriptor) {
      const owner = { kind: descriptor.kind, ownerKey: descriptor.ownerKey, historyBucket: descriptor.historyBucket };
      if (needsOwnerBinding) await store.write("owner_binding", owner);
      await store.write("handle_binding", { handleId: descriptor.handleId, baseRevision: descriptor.baseRevision,
        model: modelConfig().model, authoritative: true });
      await store.sync();
    }
  }
  async function endTurn(status, result) {
    if (!turnId) return;
    if (turnEnding) throw new Error("Pi logical turn is already ending");
    if ([...store.validator.openOperations].some((id) => store.validator.operations.get(id).turnId === turnId)) {
      throw new Error("Cannot end a logical turn with open operations");
    }
    turnEnding = true;
    try {
      await Promise.allSettled([...inputAdmissions]);
      // A live offer belongs to exactly one turn. Unconsumed offers (including
      // selections abandoned by an aborted loop) are cancelled before its seal.
      for (const [entryId, item] of queue) {
        if (item.state === "queued" || item.state === "selected") await cancelInput(entryId, item);
        else if (item.state === "cancelling") await item.cancellation;
      }
      const id = turnId; await store.endTurn(id, status, result); await store.sync();
      queue.clear(); turnId = null; turnBinding = undefined; ownsTurn = false;
    } finally { turnEnding = false; }
  }
  function cancelInput(entryId, item) {
    const previous = item.state;
    // Synchronous exclusion from poll and retention of message identity are
    // necessary while journal I/O yields. Never delete a selected message early.
    item.state = "cancelling";
    item.cancellation = (async () => {
      try {
        if (item.bound) {
          await store.write("input_queued", { inputId: item.inputId, placement: "live", requestDigest: digestTurnInput(item.message.content), state: "cancelled" }, { turnId: item.turnId }); await barrier();
        }
        queue.delete(entryId); return { kind: "cancelled", entryId };
      } catch (error) { item.state = previous; throw error; }
    })();
    return item.cancellation;
  }
  async function ensureTurn(cause) {
    if (turnId) return false;
    await beginTurn(`synthetic:${cause}:${randomUUID()}`); ownsTurn = true; return true;
  }
  let closed = false, compactionArmed = false;
  let settings = { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 };
  function toolCall(toolCallId) { return store.validator.calls.get(`${runId}\0${toolCallId}`); }
  function assertHealthy() { if (store.failure) { controller?.abort(store.failure); throw store.failure; } }
  async function barrier() { try { await store.sync(); } catch (error) { controller?.abort(error); throw error; } assertHealthy(); }
  function wrapTools(loadout) { return loadout.map((tool) => ({ ...tool,
    async execute(toolCallId, args, signal, onUpdate) {
      const operationId = runId; const call = toolCall(toolCallId);
      if (!call || call.name !== tool.name || call.admission !== "admitted") {
        throw new Error("Tool call has no durable model-issued admission; nested calls are unsupported");
      }
      const execution = (async () => {
        assertHealthy();
        await store.write("tool_call", { callId: toolCallId, name: tool.name, messageId: call.messageId, admission: "started" }, { operationId });
        await barrier();
        if (signal?.aborted) throw new Error("Tool execution interrupted before invocation");
        let result, isError = false;
        try { result = await tool.execute(toolCallId, args, signal, onUpdate); isError = result?.isError === true; }
        catch (error) { result = { content: [{ type: "text", text: error?.message || String(error) }], details: {} }; isError = true; }
        // Apply host finalization before capturing the observed outcome. Pi's
        // ordinary hook catch must not swallow a journal admission/outcome fault.
        try {
          const after = await hooks("after_tool", { toolName: tool.name, toolCallId, ...result, isError });
          if (after) {
            const structuredContent = after.structuredContent ?? (after.content ? undefined : result?.structuredContent);
            for (const key of ["content", "details", "usage", "terminate"]) if (after[key] != null) result = { ...result, [key]: after[key] };
            if (structuredContent === undefined) delete result.structuredContent;
            else result = { ...result, structuredContent };
            isError = after.isError ?? isError;
          }
        } catch (error) { result = { content: [{ type: "text", text: error?.message || String(error) }], details: {} }; isError = true; }
        const message = { role: "toolResult", toolCallId, toolName: tool.name, content: result?.content ?? [],
          details: result?.details, usage: result?.usage, isError, timestamp: Date.now() };
        await store.write("tool_result", { callId: toolCallId, name: tool.name, messageId: null, phase: "returned",
          message, outcome: isError ? "error" : "success" }, { operationId });
        await barrier();
        return { ...result, isError };
      })();
      executions.add(execution);
      try { return await execution; } finally { executions.delete(execution); }
    },
  })); }
  let tools = wrapTools(options.tools || []);
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
      if (isExecutableAssistant(event.message) && Array.isArray(event.message.content)) {
        const calls = event.message.content.filter((part) => part.type === "toolCall");
        if (new Set(calls.map((call) => call.id)).size !== calls.length) throw new TypeError("Invalid provider tool-call evidence: duplicate ID");
      }
      const id = messageIds.get(event.message) || randomUUID();
      const isInput = event.message.role === "user" && !queue.has(id);
      const inputId = isInput ? currentInputId : (queue.has(id) ? queue.get(id).inputId ?? id : null);
      const entryId = await store.appendMessage(event.message, id, { id: inputId, complete: true,
        ...(isInput ? { placement: promptCount === 1 ? "initial" : "replay" } : turnBinding && inputId ? { placement: "live" } : {}),
        ...(turnBinding && inputId ? { requestDigest: digestTurnInput(event.message.content) } : {}) });
      if (inputId && !store.validator.turns.get(turnId)?.inputs.has(inputId)) {
        await store.write("input_consumed", { inputId, messageId: entryId }, { operationId: runId });
      }
      if (isExecutableAssistant(event.message) && Array.isArray(event.message.content)) {
        for (const call of event.message.content.filter((part) => part?.type === "toolCall")) {
          await store.write("tool_call", { callId: call.id, name: call.name, messageId: entryId, admission: "observed" }, { operationId: runId });
        }
      } else if (event.message.role === "toolResult" && store.validator.calls.has(`${runId ?? turnId}\0${event.message.toolCallId}`)) {
        await store.write("tool_result", { callId: event.message.toolCallId, name: event.message.toolName, messageId: entryId,
          outcome: event.message.isError ? "error" : "success" }, { operationId: runId });
      }
      await barrier();
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
    let entry, ended = false, operationOpened = false;
    const operationId = randomUUID();
    const own = await ensureTurn("manual-compaction");
    try {
      await store.openOperation(operationId, modelConfig(), "compaction", reason); operationOpened = true;
      let decision;
      const nativeEntries = await store.getEntries(); const repairs = await store.getRepairEntries();
      const branchEntries = repairs.length ? buildHarnessSessionContext(nativeEntries, { repairs }).map((message, index) => ({
        type: "message", message, id: nativeEntries.find((entry) => entry.type === "message" && entry.message === message)?.id ?? `derived:repair:${index}`,
        parentId: null, timestamp: message.timestamp, seq: index,
      })) : nativeEntries;
      for (const handler of registrations.get("before_compaction") || []) {
        decision = await handler({ reason, branchEntries, signal: context.abortSignal, context }, context);
        if (decision !== undefined) break;
      }
      if (!decision || decision.decline || !decision.compaction) {
        if (reason === "manual") throw new Error("Pi compaction cancelled");
        return;
      }
      if (context.abortSignal.aborted) throw new Error("Pi compaction aborted");
      const id = await store.appendCompaction(decision.compaction);
      await barrier();
      entry = await store.getEntry(id);
      // Publish completion only after the exact checkpoint and terminal
      // operation marker are both durable, never after summary generation alone.
      await store.closeOperation(operationId, "completed"); operationOpened = false; await barrier();
      ended = true;
      publish({ type: "compaction_end", reason, status: "completed", entry, compaction: entry });
      return entry;
    } catch (error) {
      ended = true;
      publish({ type: "compaction_end", reason, status: "failed", error, cancelled: true });
      throw error;
    } finally {
      if (operationOpened) await store.closeOperation(operationId, entry ? "completed" : "failed");
      if (own) await endTurn(entry ? "completed" : "failed");
      if (!ended && reason !== "manual") publish({ type: "compaction_end", reason, status: "declined", cancelled: true });
    }
  }
  async function requestContext() {
    const messages = buildHarnessSessionContext(await store.getEntries(), { repairs: await store.getRepairEntries() });
    // The host supplies the current prompt/loadout on every reopen. Rebuild that
    // leading declaration after compaction too, without duplicating old prompts.
    return { messages: normalizeContext({ systemPrompt: options.systemPrompt,
      tools: tools.map(toToolDeclaration), messages: messages.filter((m) => m.role !== "system") }).messages, tools };
  }
  async function drive(text, promptOptions) {
    if (closed || running || turnEnding) throw new Error("mono-agent harness is closed, busy or ending its turn");
    runId = randomUUID(); controller = new AbortController();
    const id = runId;
    promptOptions?.onOperationAdmitted?.(id);
    publish({ type: "run_start" });
    // Start synchronously owning the promise before the first storage await.
    running = (async () => {
      let opened = false, status = "failed", error, deferred;
      try {
        await ensureTurn("prompt");
        promptCount += 1;
        const inputKey = JSON.stringify([text, promptOptions?.images ?? []]);
        initialInputKey ??= inputKey;
        currentInputId = turnBinding ? (inputKey === initialInputKey ? turnBinding.reconciliation.initialInputId : null)
          : inputKey === initialInputKey ? `input:${createHash("sha256").update(turnId).digest("hex")}` : `synthetic:input:${randomUUID()}`;
        await store.openOperation(id, modelConfig(), "prompt", promptCount === 1 ? "prompt" : "re_prompt"); opened = true;
        const messages = buildHarnessSessionContext(await store.getEntries());
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
              const messages = buildHarnessSessionContext(await store.getEntries());
              if (shouldCompact(estimateContextTokens(messages).tokens, options.model.contextWindow, settings)) await performCompaction("threshold");
            }
            return { context: await requestContext() };
          },
          beforeToolCall: async ({ toolCall, args }) => {
            assertHealthy();
            const result = await hooks("before_tool", { toolName: toolCall.name, toolCallId: toolCall.id, args });
            const call = toolCall.name && store.validator.calls.get(`${id}\0${toolCall.id}`);
            await store.write("tool_call", { callId: toolCall.id, name: toolCall.name, messageId: call.messageId,
              admission: result?.block ? "blocked" : "admitted" }, { operationId: id });
            await barrier();
            return result?.block ? { block: true, ...result.block } : undefined;
          },

          onPayload: async (payload, model) => {
            const result = await hooks("before_payload", { payload, model: model || options.model });
            return result?.payload;
          },
        }, emit, controller.signal, (model, context, streamOptions) => /** @type {any} */ (createRetryStream(
          options.models, model, context, streamOptions, retry, emit,
        )));
        assertHealthy();
        const entries = await store.getEntries();
        const final = [...entries].reverse().find((e) => e.type === "message" && e.message.role === "assistant")?.message;
        status = controller.signal.aborted || final?.stopReason === "aborted" ? "aborted"
          : final?.stopReason === "error" ? "failed" : "completed";
        if (final?.stopReason === "deferred") {
          const handle = final.deferred;
          if (handle?.id && handle.provider === options.model.provider && handle.modelId === options.model.id && handle.api === final.api) {
            status = "suspended"; deferred = handle;
          } else { status = "failed"; error = { code: "assistant_error", message: "Provider returned an invalid deferred handle" }; }
        }
        if (status === "failed" && !error) error = { code: "assistant_error", message: final?.errorMessage || "Pi assistant failed" };
      } catch (cause) {
        controller.abort(cause);
        error = { code: "run_failed", message: cause?.message || String(cause) };
        throw cause;
      } finally {
        await Promise.allSettled([...executions]);
        assertHealthy();
        if (opened && status !== "suspended") {
          if (status === "aborted") await recordInterruption(store, turnId, "user_interrupted", [id]);
          await store.closeOperation(id, status);
          if (ownsTurn) await endTurn(status);
        }
        if (status === "suspended") publish({ type: "run_suspend", reason: "deferred", deferred });
        else publish({ type: "run_end", status, error });
      }
      return { operationId: id, status, error, ...(deferred ? { deferred } : {}), tipId: await store.getLeafId() };
    })();
    try { return await running; } finally { running = null; }
  }
  return {
    hooks: { on },
    beginTurn, endTurn,
    emit,
    prompt: drive,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async steer(message, identity) {
      if (closed || turnEnding) throw new Error("mono-agent harness is closed or ending its turn");
      const entryId = randomUUID(); const copy = typeof message === "string"
        ? { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }
        : structuredClone(message);
      const bound = !!turnBinding; const admittedTurnId = turnId;
      const inputId = bound ? identity?.inputId : entryId;
      const admission = (async () => {
        if (bound) {
          await store.write("input_queued", { inputId, placement: "live", requestDigest: digestTurnInput(copy.content), state: "queued" }, { turnId: admittedTurnId }); await barrier();
        }
        messageIds.set(copy, entryId); queue.set(entryId, { message: copy, inputId, state: "queued", bound, turnId: admittedTurnId });
        return entryId;
      })();
      inputAdmissions.add(admission);
      try { return await admission; } finally { inputAdmissions.delete(admission); }
    },
    async cancelQueued(entryId) {
      const item = queue.get(entryId);
      if (item?.state === "queued") return await cancelInput(entryId, item);
      if (item?.state === "cancelling") return await item.cancellation;
      return { kind: item ? "already_placed" : "not_found", entryId };
    },
    async abort() { controller?.abort(); },
    async waitForIdle() { await running; },
    async compact() {
      if (running || closed || turnEnding) throw new Error("mono-agent harness is closed, busy or ending its turn");
      controller = new AbortController();
      running = performCompaction();
      try { return await running; } finally { running = null; }
    },
    setTools(value) { tools = wrapTools(value); },
    setMidRunCompactionArmed(value) { compactionArmed = value === true; },
    setCompactionSettings(value) { settings = { ...settings, ...value }; },
    async repairOpenOperations() { await repairInterruptedSession(store); queue.clear(); turnId = null; turnBinding = undefined; ownsTurn = false; },
    async abortOpenOperations() {
      const open = await store.getOpenOperations();
      for (const turn of await store.getOpenTurns()) await recordInterruption(store, turn.turnId, "user_interrupted", open.filter((op) => op.turnId === turn.turnId).map((op) => op.operationId));
      for (const op of (await store.getOpenOperations()).reverse()) await store.closeOperation(op.operationId, "aborted");
      for (const turn of await store.getOpenTurns()) {
        if (turn.turnId === turnId) await endTurn("aborted");
        else await store.endTurn(turn.turnId, "aborted");
      }
      await barrier(); turnId = null; ownsTurn = false;
    },
    async close() { closed = true; controller?.abort(); await running; },
  };
}
