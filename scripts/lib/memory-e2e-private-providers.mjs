import { PrivateError } from "./memory-e2e-private-input.mjs";

const routePattern = /^[a-z0-9-]+:[A-Za-z0-9:._/-]{1,160}$/u;
export function validatePrivateRoute(route, allowed, registration, runtime) {
  if (typeof route !== "string" || !routePattern.test(route) || route.includes("..")) throw new PrivateError("private_provider_route_refused");
  if (route.startsWith("ollama:")) return { provider: "ollama", model: route.slice(7), endpoint: "http://127.0.0.1:11434" };
  if (!allowed.includes(route) || !registration.productionRoutes.includes(route)
    || runtime?.isPiBuiltinProvider?.(route.split(":", 1)[0]) !== true) throw new PrivateError("private_provider_route_refused");
  return { provider: "agent-host", model: route, trace: false, timeoutMs: 60000 };
}
/** Native Pi uses MemorySessionRepo when piSessionsRoot is absent. Only that
 * audited path is admitted: no external adapters, tools, recorder, observers,
 * artifact sink, durable sessions, fallback routing or provider debug flags. */
export function assertPrivateRuntimeOptions(options) {
  if (["piSessionsRoot", "persistArtifact", "onEvent", "onTrace", "toolLifecycleSink", "sessionRecovery"].some((key) => options[key] !== undefined)
    || (options.observers?.length ?? 0) !== 0 || (options.allowedTools?.length ?? 0) !== 0
    || Object.keys(options.mcpServers ?? {}).length !== 0) throw new PrivateError("private_isolation_required");
}
export function privatePiRuntime(modules, workspace, budget) {
  const raw = modules.runtime.createMonoRuntime({ workspace });
  return {
    async run(system, options) {
      assertPrivateRuntimeOptions(options);
      budget.privateChatCalls = (budget.privateChatCalls ?? 0) + 1;
      const inputTokens = Math.ceil(Buffer.byteLength(system + JSON.stringify(options.messages), "utf8") / 3);
      budget.reserve({ chatSteps: options.maxTurns ?? 1, estimatedInputTokens: inputTokens * (options.maxTurns ?? 1) });
      try {
        // No durable session root and no content event callbacks are forwarded.
        const result = await budget.wait(raw.run(system, { ...options, piMaxRetries: 0, piTransport: "sse", keepAlive: false, providerCheckMaxTokens: 4096,
          abortSignal: AbortSignal.any([options.abortSignal, budget.controller.signal, AbortSignal.timeout(60000)].filter(Boolean)) }));
        if (result.failureKind || result.error) throw new PrivateError("private_provider_failed");
        return result;
      } catch { throw new PrivateError("private_provider_failed"); }
    },
    async disposeAllSessions() { await raw.disposeAllSessions?.(); },
  };
}
/** Tool-less local completion through the app's existing memoryRuntime seam.
 * Unlike a generic HTTP adapter this refuses redirects and caps response bytes. */
export function privateCompletionRuntime(modules, route, workspace, budget) {
  if (!route.startsWith("ollama:")) return privatePiRuntime(modules, workspace, budget);
  return {
    async run(system, options) {
      assertPrivateRuntimeOptions(options);
      budget.privateChatCalls = (budget.privateChatCalls ?? 0) + 1;
      const prompt = options.messages.map((message) => message.content).join("\n\n");
      budget.reserve({ chatSteps: 1, estimatedInputTokens: Math.ceil(Buffer.byteLength(system + prompt) / 3) });
      try {
        const response = await budget.wait(fetch("http://127.0.0.1:11434/api/generate", {
          method: "POST", redirect: "error", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: route.slice(7), system, prompt, stream: false,
            format: options.outputSchema ?? "json", options: { num_predict: 4096 } }),
          signal: AbortSignal.any([options.abortSignal, budget.controller.signal, AbortSignal.timeout(60000)].filter(Boolean)),
        }));
        if (!response.ok || !response.body) throw new PrivateError("private_provider_failed");
        const reader = response.body.getReader(); const chunks = []; let bytes = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
            if (bytes > 1024 * 1024) { await reader.cancel(); throw new PrivateError("private_budget_exceeded"); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof data.response !== "string") throw new PrivateError("private_provider_failed");
        budget.reserve({ outputTokens: Math.ceil(Buffer.byteLength(data.response) / 3) });
        return { text: data.response, ...(options.outputSchema === undefined ? {} : { structuredResult: JSON.parse(data.response) }) };
      } catch (error) { throw new PrivateError(error instanceof PrivateError ? error.code : "private_provider_failed"); }
    },
    async disposeAllSessions() {},
  };
}
