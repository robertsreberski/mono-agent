import { performance } from "node:perf_hooks";

export const MEMORY_SYSTEM = "You are the private memory maintenance LLM for mono-agent. Return only the requested JSON or plain text. Do not use tools, inspect files, or perform external actions.";

/**
 * Canonical runtime failure vocabulary the benchmark may retain, mirroring the
 * core taxonomy in packages/agent-runtime/src/ai/failure.js (FAILURE_KINDS).
 * Membership in this fixed list is the ONLY runtime failure detail that ever
 * enters meter events, trials or reports. Raw error text, errorDetails
 * objects, paths, endpoints and credentials are never serialized.
 */
export const RUNTIME_FAILURE_KINDS = Object.freeze([
  "spawn", "timeout", "stall", "context_limit", "usage_limit", "invalid_result",
  "invalid_delegation", "tool_failure", "provider_unavailable",
  "provider_unavailable_exhausted", "provider_auth", "provider_protocol",
  "skipped_capability_mismatch", "child_failed", "budget_exceeded",
  "cancelled", "cancelled_user", "cancelled_stale", "cancelled_shutdown",
  "cancelled_signal", "abandoned", "delegation_agent_not_in_team",
  "delegation_team_roster_empty", "session_not_found", "session_busy",
]);
/**
 * Fatal route categories: a dead credential or an exhausted quota will not heal
 * inside this invocation, so observing one stops further provider admission.
 * Anything else stays visible per trial without stopping the run.
 */
export const FATAL_RUNTIME_FAILURE_KINDS = Object.freeze(["provider_auth", "usage_limit"]);
/** Allow-listed canonical kind, or null for unknown/untrusted values. */
export function canonicalFailureKind(value) {
  return typeof value === "string" && RUNTIME_FAILURE_KINDS.includes(value) ? value : null;
}
export function isFatalFailureKind(value) {
  return FATAL_RUNTIME_FAILURE_KINDS.includes(canonicalFailureKind(value));
}
export class BenchmarkError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.code = code;
    const failureKind = canonicalFailureKind(options?.failureKind);
    if (failureKind !== null) this.failureKind = failureKind;
  }
}
export function codeOf(error) { return error instanceof BenchmarkError ? error.code : "operation_failed"; }
/** Structured category carried by a benchmark error, or null when generic. */
export function failureKindOf(error) {
  return error instanceof BenchmarkError ? canonicalFailureKind(error.failureKind) : null;
}

/**
 * Reservations account for model steps and output-token hints; they do not
 * bound provider wire output, retries or exact input.
 */
export class Budget {
  constructor(plan) {
    this.plan = plan;
    this.started = performance.now();
    this.used = { chatSteps: 0, embeddingCalls: 0, estimatedInputTokens: 0, embeddingInputTokens: 0, outputTokens: 0 };
    this.events = [];
    this.pending = new Set();
    this.admissionStopped = false;
    // Terminal provider stop ({ code, failureKind } or null). Set only by
    // stopProviders on fatal auth/quota evidence; unlike admissionStopped it is
    // never cleared by cleanup gating, so cleanup cannot reopen a dead route.
    this.providerStop = null;
    this.generation = 0;
    this.controller = new AbortController();
    this.timer = setTimeout(() => this.controller.abort(), plan.limits.runtimeMs - 10000);
  }
  reserve(cost) {
    if (this.providerStop !== null || this.admissionStopped) throw new BenchmarkError("provider_admission_stopped");
    if (this.controller.signal.aborted || performance.now() - this.started >= this.plan.limits.runtimeMs - 10000) throw new BenchmarkError("runtime_budget_exhausted");
    for (const [key, amount] of Object.entries(cost)) {
      if (!Number.isFinite(amount) || amount < 0 || this.used[key] + amount > this.plan.limits[key]) throw new BenchmarkError("budget_exhausted");
    }
    for (const [key, amount] of Object.entries(cost)) this.used[key] += amount;
  }
  track(promise) {
    promise = Promise.resolve(promise);
    this.generation += 1;
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  stopAdmission() { this.admissionStopped = true; }
  /**
   * Terminal stop after fatal provider evidence. Bounded fixed-vocabulary
   * record only; sticky across successful cleanup. Disposal and settlement
   * still run — this only refuses NEW admissions via reserve().
   */
  stopProviders(code, failureKind) {
    if (this.providerStop !== null) return;
    this.providerStop = { code: typeof code === "string" ? code : "provider_failed", failureKind: canonicalFailureKind(failureKind) };
    this.stopAdmission();
  }
  /** Track the original operation, never the raced wrapper: abort is not settlement. */
  wait(promise, { timeoutMs, signal = this.controller.signal, code = "runtime_budget_exhausted" } = {}) {
    return bounded(this.track(promise), { timeoutMs, signal, code: () => this.controller.signal.reason instanceof BenchmarkError ? this.controller.signal.reason.code : code, onCancel: () => {
      this.stopAdmission();
      this.controller.abort(new BenchmarkError(code));
    } });
  }
  // Call after producers have quiesced. Drain new generations as well as the initial
  // snapshot; a capture continuation can enqueue an embedding while we are waiting.
  async settle(timeoutMs = 10000) {
    const deadline = performance.now() + timeoutMs;
    do {
      const generation = this.generation;
      await bounded(Promise.allSettled([...this.pending]), {
        timeoutMs: Math.max(0, deadline - performance.now()), code: "provider_settlement_unknown",
      });
      await new Promise((resolve) => setImmediate(resolve));
      if (this.pending.size === 0 && this.generation === generation) return;
      if (performance.now() >= deadline) throw new BenchmarkError("provider_settlement_unknown");
    } while (true);
  }
  close() { clearTimeout(this.timer); }
}

/** Full-promise deadline, including bodies/tool continuations; consumes late rejection. */
export function bounded(promise, { timeoutMs, signal, code, onCancel } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); onCancel?.(); reject(new BenchmarkError(typeof code === "function" ? code() : code)); };
    // Install handlers even when already cancelled so late failures are never unhandled.
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(cancel, timeoutMs);
  });
}

/**
 * Version-coupled Pi request controls. `providerCheckMaxTokens` is a model hint,
 * not a universal wire cap (the selected Codex transport omits it). Explicit SSE
 * also avoids Pi's `auto` WebSocket-to-SSE fallback outside `piMaxRetries`.
 */
export function cappedOptions(stage, plan) {
  return {
    maxTurns: stage === "reader" ? plan.perCall.readerMaxTurns : 1,
    providerCheckMaxTokens: stage === "reader" ? plan.perCall.readerOutputTokens : plan.perCall.extractorOutputTokens,
    compaction: { enabled: false }, piTransport: "sse", piMaxRetries: 0, maxRetryDelayMs: 0, effort: "none",
  };
}

function outputCapEnforcement(model) {
  return model?.provider === "openai-codex" ? "unsupported_by_selected_provider" : "unverified_provider_hint";
}
function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
export function usageOf(value) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    inputTokens: finite(usage.inputTokens ?? usage.input_tokens ?? usage.input),
    outputTokens: finite(usage.outputTokens ?? usage.output_tokens ?? usage.output),
    cacheReadTokens: finite(usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? usage.cacheRead),
    cacheWriteTokens: finite(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? usage.cacheCreation ?? usage.cacheWrite),
    reasoningTokens: finite(usage.reasoningTokens ?? usage.reasoning_tokens),
  };
}

function settledCaptureTimeoutRecovery(plan, stage) {
  return ["extraction", "reconciliation"].includes(stage)
    && plan.locomo?.captureRecovery?.timeoutPolicy === "settled_capture_runtime_only"
    && Number.isSafeInteger(plan.perCall.captureTimeoutSettlementMs)
    && plan.perCall.captureTimeoutSettlementMs > 0;
}

async function waitForCaptureRuntimeSettlement(runtimePromise, {
  budget, signal, timeoutSignal, callerSignal, settlementTimeoutMs, event, compactionObserved,
}) {
  const tracked = budget.track(runtimePromise);
  try {
    return await bounded(tracked, { signal, code: "provider_timeout_or_cancelled" });
  } catch (error) {
    if (!signal.aborted) throw error;
    const localTimeout = timeoutSignal.aborted
      && !budget.controller.signal.aborted && callerSignal?.aborted !== true;
    if (!localTimeout) {
      budget.stopAdmission();
      if (!budget.controller.signal.aborted) budget.controller.abort(new BenchmarkError("provider_timeout_or_cancelled"));
      throw new BenchmarkError("provider_timeout_or_cancelled");
    }
    let settlement;
    try {
      [settlement] = await bounded(Promise.allSettled([tracked]), {
        timeoutMs: settlementTimeoutMs,
        code: "provider_settlement_unknown",
      });
    } catch {
      event.timeoutScope = "capture_call_local";
      event.timeoutSettlement = "unknown";
      event.timeoutUsage = "unknown";
      event.latePayloadAccepted = false;
      budget.stopAdmission();
      budget.controller.abort(new BenchmarkError("provider_settlement_unknown"));
      throw new BenchmarkError("provider_settlement_unknown");
    }
    event.timeoutScope = "capture_call_local";
    event.timeoutSettlement = settlement.status === "fulfilled" ? "fulfilled_discarded" : "rejected";
    event.timeoutUsage = "unknown";
    event.latePayloadAccepted = false;
    // Local timeout may have won first, but caller/global cancellation during
    // settlement still forbids recovery once the original runtime has ended.
    if (budget.controller.signal.aborted || callerSignal?.aborted === true) {
      budget.stopAdmission();
      if (!budget.controller.signal.aborted) budget.controller.abort(new BenchmarkError("provider_timeout_or_cancelled"));
      throw new BenchmarkError("provider_timeout_or_cancelled");
    }
    if (compactionObserved()) throw new BenchmarkError("unexpected_compaction");
    if (settlement.status === "fulfilled") {
      const stopReason = settlement.value?.diagnostics?.pi_stop_reason;
      if (["length", "max_tokens"].includes(stopReason)) throw new BenchmarkError("output_limit_reached");
      if (settlement.value?.diagnostics?.max_turns_hit === true) {
        throw new BenchmarkError("capture_step_budget_exhausted", { failureKind: "budget_exceeded" });
      }
      const failureKind = canonicalFailureKind(settlement.value?.failureKind);
      if (failureKind !== null) event.providerReportedFailureKind = failureKind;
      if (settlement.value?.failureKind || settlement.value?.error) {
        if (failureKind !== null) {
          event.failureKind = failureKind;
          if (isFatalFailureKind(failureKind)) budget.stopProviders("provider_failed", failureKind);
        }
        throw failureKind === null
          ? new BenchmarkError("provider_failed")
          : new BenchmarkError("provider_failed", { failureKind });
      }
    } else {
      const failureKind = canonicalFailureKind(settlement.reason?.failureKind);
      if (failureKind !== null) {
        event.failureKind = failureKind;
        event.providerReportedFailureKind = failureKind;
        if (isFatalFailureKind(failureKind)) budget.stopProviders("provider_failed", failureKind);
        throw new BenchmarkError("provider_failed", { failureKind });
      }
    }
    throw new BenchmarkError("capture_timeout_settled");
  }
}

export function meteredRuntime(runtime, { budget, stage, tag, clock = performance.now.bind(performance) }) {
  return {
    async run(system, options) {
      const cap = cappedOptions(stage, budget.plan);
      // Conservative controlled-text estimate plus fixed schemas/framing allowance. Dynamic native
      // schemas/tool continuations are not exactly countable here; observed context is separate.
      const estimated = Math.ceil(Buffer.byteLength(system + JSON.stringify(options.messages), "utf8") / 3) + budget.plan.perCall.framingAndToolAllowance;
      const inputLimit = stage === "reader"
        ? budget.plan.perCall.readerEstimatedInputTokens
        : stage === "reconciliation"
          ? budget.plan.perCall.reconciliationEstimatedInputTokens ?? budget.plan.perCall.extractorEstimatedInputTokens
          : budget.plan.perCall.extractorEstimatedInputTokens;
      if (estimated > inputLimit) {
        const errorClass = stage === "reader" ? "context_budget_exceeded" : "capture_context_budget_exceeded";
        if (stage === "reconciliation") {
          // Keep a bounded, content-free preflight fact before capture wraps the
          // local guard in MemoryModelError and durable intake reduces it to
          // "provider". Never retain the prompt or exception message here.
          budget.events.push({
            ...tag, stage: "reconciliation_preflight", status: "rejected", errorClass,
            estimatedInputTokens: estimated, estimatedInputTokensLimit: inputLimit,
            durationMs: 0,
          });
        }
        throw new BenchmarkError(errorClass);
      }
      budget.reserve({ chatSteps: cap.maxTurns, outputTokens: cap.providerCheckMaxTokens * cap.maxTurns, estimatedInputTokens: estimated * cap.maxTurns });
      const started = clock();
      const timeout = AbortSignal.timeout(budget.plan.perCall.callTimeoutMs);
      const signal = AbortSignal.any([options.abortSignal, budget.controller.signal, timeout].filter(Boolean));
      const recoverSettledCaptureTimeout = settledCaptureTimeoutRecovery(budget.plan, stage);
      const event = {
        ...tag,
        stage,
        status: "started",
        configuredStepsReserved: cap.maxTurns,
        estimatedInputTokensReserved: estimated * cap.maxTurns,
        // Reservation/accounting value only. `outputCapEnforcement` states
        // whether the selected provider is known to enforce it on the wire.
        outputTokensReserved: cap.providerCheckMaxTokens * cap.maxTurns,
        outputTokenLimitRequested: cap.providerCheckMaxTokens,
        outputCapEnforcement: outputCapEnforcement(options.model),
        requestedTransport: cap.piTransport,
        configuredTransportRetries: cap.piMaxRetries,
        transportAttempts: null,
        usage: usageOf(null),
        costUsd: null,
        requestedModel: options.model?.reference ?? null,
        executedModel: null,
        observedContext: [],
        durationMs: null,
        failureKind: null,
        providerReportedFailureKind: null,
        maxTurnsHit: false,
      };
      budget.events.push(event);
      let compacted = false;
      try {
        if (signal.aborted) throw new BenchmarkError("provider_timeout_or_cancelled");
        const runtimePromise = Promise.resolve(runtime.run(system, {
          ...options, ...cap, abortSignal: signal,
          onEvent: (value) => {
            if (/compact/iu.test(String(value?.type ?? ""))) compacted = true;
            if (value?.type === "context_usage") event.observedContext.push({ ...usageOf(value.tokens), contextWindow: finite(value.contextWindow), totalContextTokens: finite(value.tokens?.total), providerCostUsd: finite(value.providerCostUsd) });
            options.onEvent?.(value);
          },
        }));
        const result = recoverSettledCaptureTimeout
          ? await waitForCaptureRuntimeSettlement(runtimePromise, {
              budget, signal, timeoutSignal: timeout, callerSignal: options.abortSignal,
              settlementTimeoutMs: budget.plan.perCall.captureTimeoutSettlementMs, event,
              compactionObserved: () => compacted,
            })
          : await budget.wait(runtimePromise, {
              signal, timeoutMs: budget.plan.perCall.callTimeoutMs, code: "provider_timeout_or_cancelled",
            });
        event.usage = usageOf(result.usage);
        event.runtimeReportedCostUsd = finite(typeof result.cost === "number" ? result.cost : result.cost?.totalCost);
        // Runtime cost may be estimated. Only explicitly provider-labelled costs enter this field.
        event.costUsd = event.observedContext.length && event.observedContext.every((row) => row.providerCostUsd !== null)
          ? event.observedContext.reduce((sum, row) => sum + row.providerCostUsd, 0) : null;
        event.executedModel = typeof result.model === "string" ? result.model : null;
        event.sdk = typeof result.sdk === "string" ? result.sdk : null;
        event.observedModelTurns = finite(result.numTurns);
        // Structured category only: allow-listed kind enters the event, raw
        // error/errorDetails text never does (see RUNTIME_FAILURE_KINDS).
        const resultFailureKind = canonicalFailureKind(result.failureKind);
        event.providerReportedFailureKind = resultFailureKind;
        event.maxTurnsHit = result.diagnostics?.max_turns_hit === true;
        // Cancellation wins over any simultaneously returned provider category,
        // matching the product adapter's settlement precedence. Retain the
        // provider-reported category as metadata, but do not turn cancellation
        // into a sticky auth/quota stop.
        if (resultFailureKind !== null && !result.cancelled && !signal.aborted) event.failureKind = resultFailureKind;
        const stopReason = result.diagnostics?.pi_stop_reason;
        const structuredOutputRequested = options.outputSchema !== undefined;
        const hasStructuredResult = result.structuredResult !== undefined;

        // Settlement is authoritative. Reject every runtime/cancellation outcome
        // before examining either text or the structured payload.
        if (compacted) throw new BenchmarkError("unexpected_compaction", { failureKind: event.failureKind });
        if (["length", "max_tokens"].includes(stopReason)) throw new BenchmarkError("output_limit_reached", { failureKind: event.failureKind });
        if (signal.aborted || result.cancelled) throw new BenchmarkError("provider_timeout_or_cancelled", { failureKind: event.failureKind });
        // Pi reports its finite max-turn guard as usage_limit. That is a local,
        // pre-reserved step ceiling here, not provider quota evidence.
        if (event.maxTurnsHit) {
          const code = stage === "reader" ? "reader_step_budget_exhausted" : "capture_step_budget_exhausted";
          throw new BenchmarkError(code, { failureKind: "budget_exceeded" });
        }
        if (resultFailureKind === "context_limit") throw new BenchmarkError("native_context_limit", { failureKind: resultFailureKind });
        if (result.failureKind || result.error) throw new BenchmarkError("provider_failed", { failureKind: event.failureKind });
        // A successful StructuredOutput call is terminal even though Pi's final
        // assistant message has stopReason=toolUse. Without its payload, the same
        // stop reason is an unfinished tool loop and cannot be accepted.
        if (stopReason === "toolUse" && !(structuredOutputRequested && hasStructuredResult)) {
          throw new BenchmarkError("unfinished_tool_loop", { failureKind: event.failureKind });
        }
        if (structuredOutputRequested) {
          if (!hasStructuredResult) throw new BenchmarkError("structured_result_missing", { failureKind: event.failureKind });
        } else if (typeof result.text !== "string" || !result.text.trim()) {
          throw new BenchmarkError("provider_failed", { failureKind: event.failureKind });
        }
        event.status = "completed";
        return result;
      } catch (error) {
        const explicitCode = error instanceof BenchmarkError ? error.code : null;
        const timeoutSettlementCodes = [
          "capture_timeout_settled", "provider_settlement_unknown", "unexpected_compaction",
          "output_limit_reached", "capture_step_budget_exhausted", "provider_failed",
        ];
        const preserveSettlementCode = event.timeoutScope === "capture_call_local"
          && timeoutSettlementCodes.includes(explicitCode);
        const code = preserveSettlementCode
          ? explicitCode : signal.aborted ? "provider_timeout_or_cancelled" : explicitCode ?? "provider_failed";
        // Prefer a structured kind carried by the thrown failure; otherwise keep
        // the result-derived kind. Anything untrusted stays generic.
        const failureKind = canonicalFailureKind(error?.failureKind) ?? event.failureKind;
        if (failureKind !== null) {
          event.failureKind = failureKind;
          if (isFatalFailureKind(failureKind)) budget.stopProviders(code, failureKind);
        }
        event.status = code;
        throw failureKind !== null ? new BenchmarkError(code, { failureKind }) : new BenchmarkError(code);
      } finally { event.durationMs = clock() - started; }
    },
  };
}

function captureCompletionText(result, options) {
  if (options.outputSchema === undefined) return result.text;
  let selected = result.structuredResult;
  if (options.structuredResultKey !== undefined) {
    if (selected === null || typeof selected !== "object" || Array.isArray(selected)
      || !Object.prototype.hasOwnProperty.call(selected, options.structuredResultKey)) {
      throw new BenchmarkError("structured_result_key_missing");
    }
    selected = selected[options.structuredResultKey];
  }
  let serialized;
  try { serialized = JSON.stringify(selected); } catch { throw new BenchmarkError("structured_result_unserializable"); }
  if (serialized === undefined) throw new BenchmarkError("structured_result_unserializable");
  return serialized;
}

export function captureLlm(runtime, { model, workspace, sessionsRoot, budget, tag, capture }) {
  return {
    id: `agent-host:${model.reference}`,
    async complete(prompt, options = {}) {
      const stage = options.label === "capture:reconcile-batch" ? "reconciliation" : "extraction";
      let result;
      try {
        result = await meteredRuntime(runtime, { budget, stage, tag }).run(MEMORY_SYSTEM, {
          model, messages: [{ role: "user", content: prompt }], abortSignal: options.abortSignal ?? new AbortController().signal,
          cwd: workspace, piSessionsRoot: sessionsRoot, allowedTools: [], disallowedTools: [], mcpServers: {},
          ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
        });
      } catch (error) {
        if (error instanceof BenchmarkError && error.code === "capture_timeout_settled"
          && settledCaptureTimeoutRecovery(budget.plan, stage)) {
          // Strict production capture owns attempt accounting. An isolated call
          // that timed out and then settled contributes no accepted payload; an
          // invalid completion sends the unchanged pending record through its
          // native model_output retry schedule.
          return "";
        }
        throw error;
      }
      const output = captureCompletionText(result, options);
      capture?.({ ...tag, stage, prompt, output });
      return output;
    },
  };
}

function embeddingVectorDiagnostic(result, expectedCount, expectedDimension) {
  if (!Array.isArray(result) || result.length !== expectedCount) {
    return { status: "rejected", errorClass: "vector_count", vectorCount: Array.isArray(result) ? result.length : null };
  }
  for (const vector of result) {
    if (vector === null || typeof vector !== "object" || !Number.isSafeInteger(vector.length)) {
      return { status: "rejected", errorClass: "vector_shape", vectorCount: result.length };
    }
    if (Number.isSafeInteger(expectedDimension) && vector.length !== expectedDimension) {
      return { status: "rejected", errorClass: "vector_dimension", vectorCount: result.length };
    }
    if (Array.from(vector).some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return { status: "rejected", errorClass: "vector_numeric", vectorCount: result.length };
    }
  }
  return { status: "accepted", errorClass: null, vectorCount: result.length };
}

export function meteredEmbeddings(provider, { budget, tag, dimension = null }) {
  return {
    id: provider.id,
    async embed(texts, options) {
      const embeddingInputTokens = Math.ceil(texts.reduce((n, text) => n + Buffer.byteLength(text), 0) / 3);
      budget.reserve({
        embeddingCalls: 1,
        estimatedInputTokens: embeddingInputTokens,
        ...(Number.isFinite(budget.plan.limits.embeddingInputTokens) ? { embeddingInputTokens } : {}),
      });
      const event = { ...tag, stage: "embedding", textCount: texts.length, embeddingInputTokensReserved: embeddingInputTokens, status: "started", usage: usageOf(null), costUsd: null, transportAttempts: null, durationMs: null };
      budget.events.push(event);
      const start = performance.now();
      const signal = AbortSignal.any([options?.abortSignal, budget.controller.signal, AbortSignal.timeout(budget.plan.perCall.embeddingTimeoutMs)].filter(Boolean));
      try {
        if (signal.aborted) throw new BenchmarkError("embedding_timeout_or_cancelled");
        const result = await budget.wait(provider.embed(texts, { ...options, abortSignal: signal }), {
          signal, timeoutMs: budget.plan.perCall.embeddingTimeoutMs, code: "embedding_timeout_or_cancelled",
        });
        // Transport completion is not vector acceptance. Record only bounded
        // shape diagnostics and leave the result untouched so the production
        // store remains the semantic validator and failure owner.
        event.status = "completed";
        const diagnostic = embeddingVectorDiagnostic(result, texts.length, dimension);
        budget.events.push({
          ...tag, stage: "embedding_validation", status: diagnostic.status,
          errorClass: diagnostic.errorClass, textCount: texts.length,
          vectorCount: diagnostic.vectorCount,
          expectedDimension: Number.isSafeInteger(dimension) ? dimension : null,
          durationMs: 0,
        });
        return result;
      } catch (error) {
        event.status = signal.aborted ? "embedding_timeout_or_cancelled" : error instanceof BenchmarkError ? error.code : "embedding_failed";
        throw new BenchmarkError(event.status);
      }
      finally { event.durationMs = performance.now() - start; }
    },
  };
}

/** Offline doubles do not consult the evaluator projection and never produce quality scores. */
export function scriptedProviders({ source } = {}) {
  return {
    kind: "scripted",
    readerModel: { provider: "fixture", model: "reader", reference: "fixture:reader" },
    extractorModel: { provider: "fixture", model: "extractor", reference: "fixture:extractor" },
    dim: 8,
    embeddings: { id: "fixture:e2e", async embed(texts) { return texts.map(() => [1, 0.2, 0.1, 0.1, 0.2, 0.1, 0.3, 0.1]); } },
    extractor: {
      async run(_system, options) {
        const prompt = options.messages[0].content;
        if (!prompt.includes("\nTURN:\n")) {
          // Reconciliation output uses the strict production action format. The
          // schema path returns the host tool's object root; legacy text callers
          // retain the established decisions-array completion.
          const indexes = [...prompt.matchAll(/"index"\s*:\s*(\d+)/gu)].map((match) => Number(match[1]));
          const decisions = [...new Set(indexes)].map((index) => ({ index, action: "add" }));
          return options.outputSchema === undefined
            ? { text: JSON.stringify(decisions) }
            : { text: "", structuredResult: { decisions } };
        }
        const turn = prompt.split("\nTURN:\n").at(-1);
        const match = /^User(?: \(([^)]+)\))?: ([\s\S]*?)\nAssistant:/u.exec(turn);
        const fact = `${match?.[1] ?? "User"} said: ${match?.[2] ?? "A fictional fact."}`;
        const extracted = { memories: [{ type: "note", text: fact, salience: 0.8, isInsight: false, entityIds: [] }], entities: [], relations: [] };
        return options.outputSchema === undefined
          ? { text: JSON.stringify(extracted) }
          : { text: "", structuredResult: extracted };
      },
    },
    reader: {
      async run(_system, options) {
        const server = options.mcpServers?.["mono-agent-memory"];
        if (server) {
          const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
          const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
          const client = new Client({ name: "memory-e2e-contract", version: "1.0.0" });
          try {
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            const currentQuestion = [...(options.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
            const args = { query: source?.question?.text ?? (typeof currentQuestion === "string" ? currentQuestion : "What was discussed?") };
            await options.toolLifecycleSink?.({ phase: "invocation", toolCallId: "contract-recall", toolName: "MemoryRecall", arguments: args });
            const result = await client.callTool({ name: "MemoryRecall", arguments: args });
            await options.toolLifecycleSink?.({ phase: "result", toolCallId: "contract-recall", toolName: "MemoryRecall", state: result.isError ? "error" : "success", content: result.content });
          } finally { await client.close(); }
        }
        return { text: "Scripted contract response; semantic correctness is not evaluated." };
      },
    },
    async close() {},
  };
}

/** Called only after CLI confirmation. No configured-app root leases or consumer configuration. */
export async function realProviders(profile, { workspace, modules }) {
  const { createMonoRuntime, parseMonoRuntimeModelReference, createPiOAuthApiKeyResolver, runtimeOptionsForLocalProvider } = modules.runtime;
  // Explicit OAuth credential file only: one shared framework resolver for both
  // runtimes (it reads/refreshes lazily per request — construction opens no
  // credential file and copies no tokens). Without a selected path the bare
  // ambient environment-auth behavior is preserved; consumer config is never
  // discovered or read here.
  const resolvePiApiKey = profile.piAuthPath === undefined ? undefined : (() => {
    if (typeof createPiOAuthApiKeyResolver !== "function") throw new Error("pi_auth_resolver_unavailable");
    return createPiOAuthApiKeyResolver({ path: profile.piAuthPath });
  })();
  const readerModel = parseMonoRuntimeModelReference(profile.reader);
  const extractorModel = parseMonoRuntimeModelReference(profile.extractor);
  const baseHostOptions = resolvePiApiKey === undefined ? { workspace } : { workspace, resolvePiApiKey };
  let hostOptions = baseHostOptions;
  if (profile.ollamaEndpoint !== undefined) {
    if (profile.ollamaEndpoint !== "http://127.0.0.1:11434" || !Number.isSafeInteger(profile.clientContextWindow) || profile.clientContextWindow < 1) {
      throw new BenchmarkError("invalid_local_ollama_profile");
    }
    if (typeof runtimeOptionsForLocalProvider !== "function") throw new BenchmarkError("local_provider_runtime_options_unavailable");
    const models = [...new Set([readerModel.model, extractorModel.model])].map((name) => ({
      name,
      capabilities: { context_window: profile.clientContextWindow, max_tokens: 2048 },
    }));
    const localProviders = [{ id: "ollama", type: "ollama", baseUrl: profile.ollamaEndpoint, enabled: true, trustPublicUrl: false, models }];
    hostOptions = {
      ...baseHostOptions,
      resolveAttempt: ({ model }) => ({ options: runtimeOptionsForLocalProvider(model, localProviders) }),
    };
  }
  const reader = createMonoRuntime(hostOptions);
  const extractor = createMonoRuntime(hostOptions);
  const raw = modules.search.createEmbeddingProvider({
    provider: profile.embeddingProvider, model: profile.embeddingModel, timeoutMs: 10000,
    ...(profile.embeddingProvider === "openai" ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    ...(profile.embeddingEndpoint === undefined ? {} : { endpoint: profile.embeddingEndpoint }),
  });
  return {
    kind: "real", reader, extractor,
    readerModel, extractorModel, dim: profile.dimension,
    embeddings: modules.search.createCircuitBreakerEmbeddingProvider(raw),
    async close() { await reader.disposeAllSessions?.(); await extractor.disposeAllSessions?.(); },
  };
}
