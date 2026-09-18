import { performance } from "node:perf_hooks";

export const MEMORY_SYSTEM = "You are the private memory maintenance LLM for mono-agent. Return only the requested JSON or plain text. Do not use tools, inspect files, or perform external actions.";
export class BenchmarkError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function codeOf(error) { return error instanceof BenchmarkError ? error.code : "operation_failed"; }

/** Reservations bound configured model steps/output, not unobservable HTTP retries or exact input. */
export class Budget {
  constructor(plan) {
    this.plan = plan;
    this.started = performance.now();
    this.used = { chatSteps: 0, embeddingCalls: 0, estimatedInputTokens: 0, outputTokens: 0 };
    this.events = [];
    this.pending = new Set();
    this.controller = new AbortController();
    this.timer = setTimeout(() => this.controller.abort(), plan.limits.runtimeMs - 10000);
    this.timer.unref?.();
  }
  reserve(cost) {
    if (this.controller.signal.aborted || performance.now() - this.started >= this.plan.limits.runtimeMs - 10000) throw new BenchmarkError("runtime_budget_exhausted");
    for (const [key, amount] of Object.entries(cost)) {
      if (!Number.isFinite(amount) || amount < 0 || this.used[key] + amount > this.plan.limits[key]) throw new BenchmarkError("budget_exhausted");
    }
    for (const [key, amount] of Object.entries(cost)) this.used[key] += amount;
  }
  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  async settle(timeoutMs = 10000) {
    let timer;
    try {
      await Promise.race([Promise.allSettled([...this.pending]), new Promise((_, reject) => { timer = setTimeout(() => reject(new BenchmarkError("provider_settlement_unknown")), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  close() { clearTimeout(this.timer); }
}

/** Version-coupled existing Pi check cap; never pass an ignored generic maxTokens option. */
export function cappedOptions(stage, plan) {
  return {
    maxTurns: stage === "reader" ? 3 : 1,
    providerCheckMaxTokens: stage === "reader" ? plan.perCall.readerOutputTokens : plan.perCall.extractorOutputTokens,
    compaction: { enabled: false }, piMaxRetries: 0, maxRetryDelayMs: 0, effort: "none",
  };
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

export function meteredRuntime(runtime, { budget, stage, tag, clock = performance.now.bind(performance) }) {
  return {
    async run(system, options) {
      const cap = cappedOptions(stage, budget.plan);
      // Conservative controlled-text estimate plus fixed schemas/framing allowance. Dynamic native
      // schemas/tool continuations are not exactly countable here; observed context is separate.
      const estimated = Math.ceil(Buffer.byteLength(system + JSON.stringify(options.messages), "utf8") / 3) + budget.plan.perCall.framingAndToolAllowance;
      const inputLimit = stage === "reader" ? budget.plan.perCall.readerEstimatedInputTokens : budget.plan.perCall.extractorEstimatedInputTokens;
      if (estimated > inputLimit) throw new BenchmarkError(stage === "reader" ? "context_budget_exceeded" : "capture_context_budget_exceeded");
      budget.reserve({ chatSteps: cap.maxTurns, outputTokens: cap.providerCheckMaxTokens * cap.maxTurns, estimatedInputTokens: estimated * cap.maxTurns });
      const started = clock();
      const timeout = AbortSignal.timeout(budget.plan.perCall.callTimeoutMs);
      const signal = AbortSignal.any([options.abortSignal, budget.controller.signal, timeout]);
      const event = { ...tag, stage, status: "started", configuredStepsReserved: cap.maxTurns, estimatedInputTokensReserved: estimated * cap.maxTurns, outputTokensReserved: cap.providerCheckMaxTokens * cap.maxTurns, transportAttempts: null, usage: usageOf(null), costUsd: null, requestedModel: options.model?.reference ?? null, executedModel: null, observedContext: [], durationMs: null };
      budget.events.push(event);
      let compacted = false;
      try {
        const result = await budget.track(runtime.run(system, {
          ...options, ...cap, abortSignal: signal,
          onEvent: (value) => {
            if (/compact/iu.test(String(value?.type ?? ""))) compacted = true;
            if (value?.type === "context_usage") event.observedContext.push({ ...usageOf(value.tokens), contextWindow: finite(value.contextWindow), totalContextTokens: finite(value.tokens?.total), providerCostUsd: finite(value.providerCostUsd) });
            options.onEvent?.(value);
          },
        }));
        event.usage = usageOf(result.usage);
        event.runtimeReportedCostUsd = finite(typeof result.cost === "number" ? result.cost : result.cost?.totalCost);
        // Runtime cost may be estimated. Only explicitly provider-labelled costs enter this field.
        event.costUsd = event.observedContext.length && event.observedContext.every((row) => row.providerCostUsd !== null)
          ? event.observedContext.reduce((sum, row) => sum + row.providerCostUsd, 0) : null;
        event.executedModel = typeof result.model === "string" ? result.model : null;
        event.sdk = typeof result.sdk === "string" ? result.sdk : null;
        event.observedModelTurns = finite(result.numTurns);
        if (compacted) throw new BenchmarkError("unexpected_compaction");
        if (["length", "max_tokens"].includes(result.diagnostics?.pi_stop_reason)) throw new BenchmarkError("output_limit_reached");
        if (signal.aborted) throw new BenchmarkError("provider_timeout_or_cancelled");
        if (result.failureKind || result.error || result.cancelled || typeof result.text !== "string" || !result.text.trim()) throw new BenchmarkError("provider_failed");
        event.status = "completed";
        return result;
      } catch (error) {
        const code = signal.aborted ? "provider_timeout_or_cancelled" : error instanceof BenchmarkError ? error.code : "provider_failed";
        event.status = code;
        throw new BenchmarkError(code);
      } finally { event.durationMs = clock() - started; }
    },
  };
}

export function captureLlm(runtime, { model, workspace, sessionsRoot, budget, tag, capture }) {
  return {
    id: `agent-host:${model.reference}`,
    async complete(prompt, options = {}) {
      const stage = options.label === "capture:reconcile-batch" ? "reconciliation" : "extraction";
      const result = await meteredRuntime(runtime, { budget, stage, tag }).run(MEMORY_SYSTEM, {
        model, messages: [{ role: "user", content: prompt }], abortSignal: options.abortSignal ?? new AbortController().signal,
        cwd: workspace, piSessionsRoot: sessionsRoot, allowedTools: [], disallowedTools: [], mcpServers: {},
      });
      capture?.({ ...tag, stage, prompt, output: result.text });
      return result.text;
    },
  };
}

export function meteredEmbeddings(provider, { budget, tag }) {
  return {
    id: provider.id,
    async embed(texts, options) {
      budget.reserve({ embeddingCalls: 1, estimatedInputTokens: Math.ceil(texts.reduce((n, text) => n + Buffer.byteLength(text), 0) / 3) });
      const event = { ...tag, stage: "embedding", textCount: texts.length, status: "started", usage: usageOf(null), costUsd: null, transportAttempts: null, durationMs: null };
      budget.events.push(event);
      const start = performance.now();
      try { const result = await budget.track(provider.embed(texts, options)); event.status = "completed"; return result; }
      catch { event.status = "embedding_failed"; throw new BenchmarkError("embedding_failed"); }
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
          // Reconciliation output uses the strict production action format.
          const indexes = [...prompt.matchAll(/"index"\s*:\s*(\d+)/gu)].map((match) => Number(match[1]));
          return { text: JSON.stringify([...new Set(indexes)].map((index) => ({ index, action: "add" }))) };
        }
        const turn = prompt.split("\nTURN:\n").at(-1);
        const match = /^User(?: \(([^)]+)\))?: ([\s\S]*?)\nAssistant:/u.exec(turn);
        const fact = `${match?.[1] ?? "User"} said: ${match?.[2] ?? "A fictional fact."}`;
        return { text: JSON.stringify({ memories: [{ type: "note", text: fact, salience: 0.8, isInsight: false, entityIds: [] }], entities: [], relations: [] }) };
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
            const args = { query: source?.question.text ?? "What was discussed?" };
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
  const { createMonoRuntime, parseMonoRuntimeModelReference } = modules.runtime;
  const reader = createMonoRuntime({ workspace });
  const extractor = createMonoRuntime({ workspace });
  const raw = modules.search.createEmbeddingProvider({
    provider: profile.embeddingProvider, model: profile.embeddingModel, timeoutMs: 10000,
    ...(profile.embeddingProvider === "openai" ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  });
  return {
    kind: "real", reader, extractor,
    readerModel: parseMonoRuntimeModelReference(profile.reader), extractorModel: parseMonoRuntimeModelReference(profile.extractor), dim: profile.dimension,
    embeddings: modules.search.createCircuitBreakerEmbeddingProvider(raw),
    async close() { await reader.disposeAllSessions?.(); await extractor.disposeAllSessions?.(); },
  };
}
