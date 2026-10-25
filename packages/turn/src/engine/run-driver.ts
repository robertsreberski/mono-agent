// Own admission/queues/persistence, but depend on Pi's loop and all providers.
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { Message, Model, Api, TranscriptContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { normalizeContext, toToolDeclaration } from "@earendil-works/pi-ai";
import { adaptProviderContext, adaptRequestTools } from "./tool-schema-adaptation.js";
import { randomUUID, createHash } from "node:crypto";
import { projectContext, projectInheritedContext } from "./request-projection.js";
import { evidenceDigest } from "./evidence-view.js";
import { checkHandoffDispatch, estimateHandoffTokens } from "./handoff.js";
import { convertToLlm } from "./compaction-kit/messages.js";
import { estimateContextTokens, shouldCompact } from "./compaction-kit/compaction.js";
import { recordInterruption, repairInterruptedSession, isExecutableAssistant } from "./interruption.js";
import { validateSessionTurn } from "./journal-schema.js";
import { compactionEvidence } from "./compaction-evidence.js";
import { createTurnBinding, digestTurnInput } from "./turn-evidence.js";
import { BACKOFF_ABORT, createRetryStream } from "./retry-stream.js";

export function createRunDriver(store: any, options: any): {
    hooks: {
        on: (type: any, handler: any) => () => any;
    };
    beginTurn: (id?: string, source?: string, descriptor?: any) => Promise<void>;
    endTurn: (status: any, result?: any) => Promise<void>;
    emit: (event: any) => Promise<void>;
    prompt: (text: any, promptOptions?: any) => Promise<{
        tipId: any;
        deferred?: any;
        operationId: `${string}-${string}-${string}-${string}-${string}`;
        status: string;
        error: {
            code: string;
            message: any;
        };
    }>;
    subscribe(listener: any): () => boolean;
    steer(message: any, identity: any): Promise<`${string}-${string}-${string}-${string}-${string}`>;
    cancelQueued(entryId: any): Promise<any>;
    abort(): Promise<void>;
    waitForIdle(): Promise<void>;
    compact(options?: { continuityTrigger?: string }): Promise<any>;
    setTools(value: any): void;
    setMidRunCompactionArmed(value: any): void;
    setCompactionSettings(value: any): void;
    repairOpenOperations(): Promise<void>;
    abortOpenOperations(): Promise<void>;
    close(): Promise<void>;
} {
  // Snapshot accepted content: a request extension cannot mutate a cached handoff
  // while a provider/tool await is in flight.
  const inherited = options.inheritedProjection === undefined ? undefined : structuredClone(options.inheritedProjection);
  const dispatchBudget = options.handoffDispatchBudget === undefined ? undefined : structuredClone(options.handoffDispatchBudget);
  const project = (entries: any, extra: {} = {}) => inherited === undefined ? projectContext(entries, extra)
    : projectInheritedContext(entries, inherited, extra);
  let dispatchRequest: any;
  const budgetFailure = (reason: any) => Object.assign(new Error(`Handoff dispatch budget exceeded: ${reason}`),
    { code: "ERR_HANDOFF_DISPATCH_BUDGET", reason });
  if (dispatchBudget && (options.model.contextWindow < dispatchBudget.contextWindow
    || options.model.maxTokens < dispatchBudget.outputReserve)) throw budgetFailure("target_window");
  const listeners = new Set<(event: any) => void>();
  const registrations = new Map();
  const queue = new Map();
  const messageIds = new WeakMap();
  const executions = new Set();
  let runId: any, controller: any, running: any;
  let turnBeginning = false, turnEnding = false;
  const inputAdmissions = new Set();
  let turnId: any = null, turnBinding: any, ownsTurn = false, promptCount = 0, initialInputKey: any, currentInputId: any, initialMessageId: any;
  const modelConfig = () => ({ model: { provider: options.model.provider, id: options.model.id, api: options.model.api } });
  async function beginTurn(id: string = `synthetic:runtime:${randomUUID()}`, source: string = "synthetic", descriptor?: any): Promise<void> {
    if (turnId || turnBeginning || turnEnding) throw new Error("Pi logical turn is already open");
    turnBeginning = true;
    try {
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
      const projectionBinding = inherited && options.inheritedProjectionRef && !store.validator.projectionBinding
        ? { version: 1, artifact: structuredClone(options.inheritedProjectionRef), coverage: inherited.coverage,
          messageDigest: evidenceDigest(inherited.messages) } : undefined;
      await store.beginTurn(id, modelConfig(), source, turnBinding, projectionBinding); await store.sync(); turnId = id; promptCount = 0; initialInputKey = undefined; initialMessageId = undefined;
      if (descriptor) {
        const owner = { kind: descriptor.kind, ownerKey: descriptor.ownerKey, historyBucket: descriptor.historyBucket };
        if (needsOwnerBinding) await store.write("owner_binding", owner);
        await store.write("handle_binding", { handleId: descriptor.handleId, baseRevision: descriptor.baseRevision,
          model: modelConfig().model, authoritative: true });
        await store.sync();
      }
    } finally { turnBeginning = false; }
  }
  async function endTurn(status: any, result?: any): Promise<void> {
    if (!turnId) return;
    if (turnEnding) throw new Error("Pi logical turn is already ending");
    if ([...store.validator.openOperations].some((id: any) => store.validator.operations.get(id).turnId === turnId)) {
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
  function cancelInput(entryId: any, item: any): any {
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
  async function ensureTurn(cause: any): Promise<boolean> {
    if (turnId) return false;
    await beginTurn(`synthetic:${cause}:${randomUUID()}`); ownsTurn = true; return true;
  }
  let closed = false, compactionArmed = false;
  let settings = { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 };
  function toolCall(toolCallId: any): any { return store.validator.calls.get(`${runId}\0${toolCallId}`); }
  function assertHealthy(): void { if (store.failure) { controller?.abort(store.failure); throw store.failure; } }
  async function barrier(): Promise<void> { try { await store.sync(); } catch (error) { controller?.abort(error); throw error; } assertHealthy(); }
  function wrapTools(loadout: any): any { return loadout.map((tool: any) => ({ ...tool,
    async execute(toolCallId: any, args: any, signal: any, onUpdate: any): Promise<any> {
      const operationId = runId; const call = toolCall(toolCallId);
      if (!call || call.name !== tool.name || call.admission !== "admitted") {
        throw new Error("Tool call has no durable model-issued admission; nested calls are unsupported");
      }
      const execution = (async () => {
        assertHealthy();
        await store.write("tool_call", { callId: toolCallId, name: tool.name, messageId: call.messageId, admission: "started" }, { operationId });
        await barrier();
        if (signal?.aborted) throw new Error("Tool execution interrupted before invocation");
        let result: any, isError = false;
        try { result = await tool.execute(toolCallId, args, signal, onUpdate); isError = result?.isError === true; }
        catch (error) { result = { content: [{ type: "text", text: (error as { code?: unknown; message?: string })?.message || String(error) }], details: {} }; isError = true; }
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
        } catch (error) { result = { content: [{ type: "text", text: (error as { code?: unknown; message?: string })?.message || String(error) }], details: {} }; isError = true; }
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
    || !Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0
    || (retry.maxDelayMs !== undefined && !(Number.isFinite(retry.maxDelayMs) && retry.maxDelayMs >= 0))
    || (retry.shouldRetry !== undefined && typeof retry.shouldRetry !== "function")) throw new RangeError("Invalid Pi retry policy");

  function on(type: any, handler: any): () => any {
    const handlers = registrations.get(type) || new Set();
    handlers.add(handler); registrations.set(type, handlers);
    return () => handlers.delete(handler);
  }
  async function hooks(type: any, event: any): Promise<any> {
    let merged: any;
    for (const handler of registrations.get(type) || []) {
      const value = await handler(event, { abortSignal: controller?.signal });
      if (value !== undefined) merged = { ...merged, ...value };
    }
    return merged;
  }
  function publish(event: any): void | Promise<void> {
    const recording: Promise<unknown>[] = [];
    const envelope = { lane: "main", ...(runId ? { runId } : {}), ...event };
    for (const listener of listeners) {
      try {
        const result = (listener as (event: any) => unknown)(envelope);
        // Only the completed-cut boundary awaits asynchronous recorders. General
        // provider/tool observers retain their synchronous delivery contract.
        if (options.continuityRecording && event.type === "compaction_end" && result && typeof (result as Promise<unknown>).then === "function") recording.push(Promise.resolve(result).catch((error) => {
          for (const observer of listeners) { try { observer({ type: "handler_error", lane: "main", runId, eventType: event.type, error }); } catch { /* diagnostic */ } }
        }));
      }
      catch (error) {
        // Match the old harness event bus: a subscriber failure is diagnostic,
        // not a provider/tool failure or a reason to repeat an effect.
        const fault = { type: "handler_error", lane: "main", runId, eventType: event.type, error };
        for (const observer of listeners) {
          try { observer(fault); } catch { /* don't recursively publish faults */ }
        }
      }
    }
    if (recording.length) return Promise.all(recording).then(() => {});
  }
  async function emit(event: any): Promise<void> {
    if (event.message?.[BACKOFF_ABORT]) return;
    if (event.type === "agent_start" || event.type === "agent_end"
      || ((event.type === "message_start" || event.type === "message_end") && event.message.role === "system")) return;
    if (event.type === "message_end") {
      // Pi 1.1 adds transport/tool timings. They are not part of our session
      // envelope: normalize before hooks, persistence and the next projection.
      // The loop shares this message, so its in-memory context stays identical too.
      if (event.message.role === "assistant" || event.message.role === "toolResult") delete event.message.durationMs;
      if (event.message.role === "assistant") await hooks("after_response", { message: event.message });
      if (isExecutableAssistant(event.message) && Array.isArray(event.message.content)) {
        const calls = event.message.content.filter((part: any) => part.type === "toolCall");
        if (new Set(calls.map((call: any) => call.id)).size !== calls.length) throw new TypeError("Invalid provider tool-call evidence: duplicate ID");
      }
      const id = messageIds.get(event.message) || randomUUID();
      const isInput = event.message.role === "user" && !queue.has(id);
      const inputId = isInput ? currentInputId : (queue.has(id) ? queue.get(id).inputId ?? id : null);
      const entryId = await store.appendMessage(event.message, id, { id: inputId, complete: true,
        ...(isInput ? { placement: promptCount === 1 ? "initial" : "replay" } : turnBinding && inputId ? { placement: "live" } : {}),
        ...(turnBinding && inputId ? { requestDigest: digestTurnInput(event.message.content) } : {}) });
      if (isInput && initialMessageId === undefined) initialMessageId = entryId;
      if (inputId && !store.validator.turns.get(turnId)?.inputs.has(inputId)) {
        await store.write("input_consumed", { inputId, messageId: entryId }, { operationId: runId });
      }
      if (isExecutableAssistant(event.message) && Array.isArray(event.message.content)) {
        for (const call of event.message.content.filter((part: any) => part?.type === "toolCall")) {
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
  async function poll(): Promise<any[]> {
    if (controller?.signal.aborted || closed || turnBeginning || !turnId) return [];
    const pending = [...queue.values()].filter((q: any) => q.state === "queued" && q.turnId === turnId);
    const selected = options.steeringMode === "all" ? pending : pending.slice(0, 1);
    for (const q of selected) q.state = "selected";
    return selected.map((q: any) => q.message);
  }
  async function performCompaction(reason: string = "manual", continuityTrigger?: string): Promise<any> {
    publish({ type: "compaction_start", reason });
    const context = { abortSignal: controller?.signal || new AbortController().signal };
    let entry: any, ended = false, operationOpened = false;
    const operationId = randomUUID();
    const own = await ensureTurn("manual-compaction");
    try {
      const cause = options.continuityRecording ? `continuity:${continuityTrigger ?? (reason === "threshold" ? "mid-run" : "manual")}` : reason;
      await store.openOperation(operationId, modelConfig(), "compaction", cause); operationOpened = true;
      let decision: any;
      const nativeEntries = await store.getEntries();
      const source = { sourceTipId: store.tip, sourceSeq: store.seq };
      const repairs = await store.getRepairEntries();
      const projection = project(nativeEntries, { repairs, mode: "compaction" });
      const branchEntries = projection.entries;
      const nonRetainablePrefixLength = "nonRetainablePrefixLength" in projection ? projection.nonRetainablePrefixLength : 0;
      for (const handler of registrations.get("before_compaction") || []) {
        decision = await handler({ reason, branchEntries, nonRetainablePrefixLength, signal: context.abortSignal, context }, context);
        if (decision !== undefined) break;
      }
      if (!decision || decision.decline || !decision.compaction) {
        if (reason === "manual") throw new Error("Pi compaction cancelled");
        return;
      }
      if (context.abortSignal.aborted) throw new Error("Pi compaction aborted");
      // A composed cut must reduce the entire inherited prefix. Retaining its
      // native envelopes as derived current messages would copy predecessor evidence.
      if (inherited && (decision.compaction.retainedTail ?? []).some((message: any) =>
        inherited.messages.some((prior: any) => JSON.stringify(prior) === JSON.stringify(message)))) {
        throw new Error("Composed compaction must cover the inherited prefix");
      }
      // Omission after a composed checkpoint means the native summary owns the
      // prefix. Every later checkpoint must carry its coverage, not revert to v2.
      const inheritedCoverage = inherited?.coverage ?? nativeEntries.filter((prior: any) => prior.type === "compaction"
        && prior.checkpoint?.inheritedCoverage).at(-1)?.checkpoint.inheritedCoverage;
      if (options.continuityRecording) {
        const preparing = compactionEvidence({ type: "compaction", id: operationId, summary: decision.compaction.summary,
          checkpoint: { summaryMessage: { summary: decision.compaction.summary }, coverage: { version: 1, sourceTipId: source.sourceTipId, sourceEntryCount: nativeEntries.length } } },
          store.metadata.journalId, { operationId, cause, model: modelConfig().model });
        try { await options.onCompactionPreparing(Object.freeze(preparing)); }
        catch (error) {
          if (context.abortSignal.aborted) throw error;
          publish({ type: "warning", code: "context_compaction_prepare_failed", message: "Context reduction continues without retained evidence because its preparation is unavailable." });
        }
        if (context.abortSignal.aborted) throw new Error("Pi compaction aborted during evidence preparation.");
        if (store.tip !== source.sourceTipId) throw new Error("Compaction source advanced during evidence preparation.");
      }
      const id = await store.appendCompaction(decision.compaction, inheritedCoverage, inheritedCoverage ? source : undefined);
      await barrier();
      entry = await store.getEntry(id);
      // Publish completion only after the exact checkpoint and terminal
      // operation marker are both durable, never after summary generation alone.
      await store.closeOperation(operationId, "completed"); operationOpened = false; await barrier();
      ended = true;
      if (options.continuityRecording) entry = { ...entry, continuityCheckpoint: compactionEvidence(entry, store.metadata.journalId,
        { operationId, cause, model: modelConfig().model }) };
      await publish({ type: "compaction_end", reason, status: "completed", entry, compaction: entry });
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
  async function requestContext(): Promise<{ messages: Message[]; tools: any; }> {
    if (options.assertSessionCurrent) await options.assertSessionCurrent();
    const messages = project(await store.getEntries(), { repairs: await store.getRepairEntries() }).messages;
    // The host supplies the current prompt/loadout on every reopen. Rebuild that
    // leading declaration after compaction too, without duplicating old prompts.
    const declarations = tools.map(toToolDeclaration);
    const normalized = normalizeContext({ systemPrompt: options.systemPrompt,
      tools: declarations, messages: messages.filter((m: any) => m.role !== "system") });
    if (dispatchBudget) {
      const entries = await store.getEntries();
      const input = entries.find((entry: any) => entry.type === "message" && entry.id === initialMessageId)?.message;
      const currentInput = input ?? messages.findLast((message: any) => message.role === "user");
      const reverseIndex = [...normalized.messages].reverse().findIndex((message: Message) => message === currentInput
        || JSON.stringify(message) === JSON.stringify(currentInput));
      const index = reverseIndex < 0 ? -1 : normalized.messages.length - reverseIndex - 1;
      dispatchRequest = { systemPrompt: options.systemPrompt, tools: adaptRequestTools(tools, options.model.api).map(toToolDeclaration),
        messages: normalized.messages.filter((message: Message, at: number) => at !== index && message.role !== "system"), currentInput };
      const fit: {status:string, reason?:any} = checkHandoffDispatch(dispatchRequest, dispatchBudget);
      if (fit.status !== "ready") throw budgetFailure(fit.reason);
    }
    return { messages: normalized.messages, tools };
  }
  async function drive(text: any, promptOptions: any): Promise<{ tipId: any; deferred?: any; operationId: `${string}-${string}-${string}-${string}-${string}`; status: string; error: { code: string; message: any; }; }> {
    if (closed || running || turnEnding) throw new Error("mono-agent harness is closed, busy or ending its turn");
    runId = randomUUID(); controller = new AbortController();
    const id = runId;
    promptOptions?.onOperationAdmitted?.(id);
    publish({ type: "run_start" });
    // Start synchronously owning the promise before the first storage await.
    running = (async () => {
      let opened = false, status = "failed", error: any, deferred: any;
      try {
        await ensureTurn("prompt");
        promptCount += 1;
        const inputKey = JSON.stringify([text, promptOptions?.images ?? []]);
        initialInputKey ??= inputKey;
        currentInputId = turnBinding ? (inputKey === initialInputKey ? turnBinding.reconciliation.initialInputId : null)
          : inputKey === initialInputKey ? `input:${createHash("sha256").update(turnId).digest("hex")}` : `synthetic:input:${randomUUID()}`;
        await store.openOperation(id, modelConfig(), "prompt", promptCount === 1 ? "prompt" : "re_prompt"); opened = true;
        const messages = project(await store.getEntries()).messages;
        const prompts: any[] = [{ role: "user", content: [{ type: "text", text }, ...(promptOptions?.images || [])], timestamp: Date.now() }];
        await runAgentLoop(prompts, { messages, tools }, {
          ...options.streamOptions,
          ...(dispatchBudget ? { maxTokens: dispatchBudget.outputReserve } : {}),
          sessionId: store.metadata.id,
          model: options.model,
          reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
          convertToLlm,
          toolExecution: options.toolExecution,
          getSteeringMessages: poll,
          getFollowUpMessages: async () => [],
          prepareRequest: async () => {
            if (!dispatchBudget && compactionArmed && settings.enabled) {
              const messages = project(await store.getEntries()).messages;
              if (shouldCompact(estimateContextTokens(messages).tokens, options.model.contextWindow, settings)) await performCompaction("threshold");
            }
            return { context: await requestContext() };
          },
          beforeToolCall: async ({ toolCall, args }: BeforeToolCallContext) => {
            assertHealthy();
            const result = await hooks("before_tool", { toolName: toolCall.name, toolCallId: toolCall.id, args });
            const call = toolCall.name && store.validator.calls.get(`${id}\0${toolCall.id}`);
            await store.write("tool_call", { callId: toolCall.id, name: toolCall.name, messageId: call.messageId,
              admission: result?.block ? "blocked" : "admitted" }, { operationId: id });
            await barrier();
            return result?.block ? { block: true, ...result.block } : undefined;
          },

          onPayload: async (payload: unknown, model: Model<Api>) => {
            if (options.assertSessionCurrent) await options.assertSessionCurrent();
            const before = dispatchBudget ? estimateHandoffTokens(payload) : 0;
            const result = await hooks("before_payload", { payload, model: model || options.model });
            if (dispatchBudget) {
              // Provider-shaped payload hooks run after normalization. Charge any
              // late growth to host/total bounds, including in-place mutation.
              const growth = Math.max(0, estimateHandoffTokens(result?.payload ?? payload) - before);
              const { messages, currentInput, ...host } = dispatchRequest;
              if (estimateHandoffTokens(host) + growth > dispatchBudget.hostCap) throw budgetFailure("host_cap");
              if (estimateHandoffTokens(dispatchRequest) + growth + dispatchBudget.outputReserve
                + dispatchBudget.safety > dispatchBudget.contextWindow) throw budgetFailure("target_window");
            }
            options.onPreparedPayload?.(result?.payload ?? payload, model || options.model);
            return result?.payload;
          },
        }, emit, controller.signal, (model: Model<Api>, context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined) => ((createRetryStream(
          options.models, model, adaptProviderContext(context, tools, model.api), streamOptions, retry, emit,
        )) as any));
        assertHealthy();
        const entries = await store.getEntries();
        const final = [...entries].reverse().find((e: any) => e.type === "message" && e.message.role === "assistant")?.message;
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
        error = { code: "run_failed", message: (cause as { code?: unknown; message?: string })?.message || String(cause) };
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
    subscribe(listener: any): () => boolean { listeners.add(listener); return () => listeners.delete(listener); },
    async steer(message: any, identity: any): Promise<`${string}-${string}-${string}-${string}-${string}`> {
      if (closed || turnEnding || turnBeginning || !turnId) throw new Error("mono-agent harness has no active turn or is closed, beginning or ending its turn");
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
    async cancelQueued(entryId: any): Promise<any> {
      const item = queue.get(entryId);
      if (item?.state === "queued") return await cancelInput(entryId, item);
      if (item?.state === "cancelling") return await item.cancellation;
      return { kind: item ? "already_placed" : "not_found", entryId };
    },
    async abort(): Promise<void> { controller?.abort(); },
    async waitForIdle(): Promise<void> { await running; },
    async compact(compactOptions?: { continuityTrigger?: string }): Promise<any> {
      if (running || closed || turnEnding) throw new Error("mono-agent harness is closed, busy or ending its turn");
      controller = new AbortController();
      running = performCompaction("manual", compactOptions?.continuityTrigger);
      try { return await running; } finally { running = null; }
    },
    setTools(value: any): void { tools = wrapTools(value); },
    setMidRunCompactionArmed(value: any): void { compactionArmed = value === true; },
    setCompactionSettings(value: any): void { settings = { ...settings, ...value }; },
    async repairOpenOperations(): Promise<void> { await repairInterruptedSession(store); queue.clear(); turnId = null; turnBinding = undefined; ownsTurn = false; },
    async abortOpenOperations(): Promise<void> {
      const open = await store.getOpenOperations();
      for (const turn of await store.getOpenTurns()) await recordInterruption(store, turn.turnId, "user_interrupted", open.filter((op: any) => op.turnId === turn.turnId).map((op: any) => op.operationId));
      for (const op of (await store.getOpenOperations()).reverse()) await store.closeOperation(op.operationId, "aborted");
      for (const turn of await store.getOpenTurns()) {
        if (turn.turnId === turnId) await endTurn("aborted");
        else await store.endTurn(turn.turnId, "aborted");
      }
      await barrier(); turnId = null; ownsTurn = false;
    },
    async close(): Promise<void> { closed = true; controller?.abort(); await running; },
  };
}
