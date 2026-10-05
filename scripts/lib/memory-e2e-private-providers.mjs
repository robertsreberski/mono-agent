import { PrivateError, privateCode } from "./memory-e2e-private-input.mjs";

// Refuse presence, not just recognized values: SDK parsers can themselves warn
// for invalid levels. The shared guard covers every admitted native Pi route,
// including OpenAI-compatible/Azure routes and Google/AWS transitive logging.
export const PRIVATE_LOGGING_ENV = Object.freeze([
  "ANTHROPIC_LOG", "OPENAI_LOG", "GOOGLE_SDK_NODE_LOGGING", "AZURE_LOG_LEVEL",
  "AWS_SDK_LOG_LEVEL", "AWS_SDK_JS_LOG_LEVEL", "DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
]);
export function assertPrivateProviderEnvironment(env = process.env) {
  if (PRIVATE_LOGGING_ENV.some((key) => Object.hasOwn(env, key))) throw new PrivateError("private_isolation_required");
}
/** Existing production embedding transport seam; never alter global fetch or
 * ordinary providers. All private indexing/store requests refuse redirects. */
export function privateEmbeddingFetch(input, options = {}) {
  assertPrivateProviderEnvironment();
  return fetch(input, { ...options, redirect: "error" });
}

// Retry authority is a trusted instance, never an arbitrary provider property.
export class PrivateProviderError extends PrivateError {
  constructor(retryable = false) { super("private_provider_failed"); this.retryable = retryable === true; }
}
export function assertPrivateBudget(budget) {
  if (budget.exhausted) throw new PrivateError("private_budget_exhausted");
  try { budget.reserve({}); }
  catch (error) { if (privateCode(error) === "private_budget_exhausted") throw new PrivateError("private_budget_exhausted"); throw error; }
}
function transientFailure(modules, errorText, failureKind) {
  return ["timeout", "stall"].includes(failureKind)
    || modules.providerFailures?.retryableProviderFailureInfo({ errorText, failureKind }).retryable === true;
}

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
  if (["piSessionsRoot", "persistArtifact", "onEvent", "onTrace", "toolLifecycleSink", "sessionRecovery", "sessionTurn"].some((key) => options[key] !== undefined)
    || (options.observers?.length ?? 0) !== 0 || (options.allowedTools?.length ?? 0) !== 0
    || Object.keys(options.mcpServers ?? {}).length !== 0) throw new PrivateError("private_isolation_required");
}
export function privatePiRuntime(modules, workspace, budget, { piAuthPath } = {}) {
  assertPrivateProviderEnvironment();
  let raw, resolvePiApiKey;
  try {
    // Same lazy credential-store seam as production/real benchmarks. Selecting
    // credentials is execution-only: no auth path or credential enters artifacts.
    resolvePiApiKey = piAuthPath === undefined ? undefined : modules.runtime.createPiOAuthApiKeyResolver({ path: piAuthPath });
    raw = modules.runtime.createMonoRuntime({ workspace, ...(resolvePiApiKey === undefined ? {} : { resolvePiApiKey }) });
  } catch { throw new PrivateError("private_judge_unavailable"); }
  return {
    async checkAuth(provider) {
      assertPrivateProviderEnvironment();
      budget.reserve({});
      if (typeof modules.providerAuth?.checkPiProviderAuth !== "function") throw new PrivateError("private_judge_unavailable");
      try {
        // Pi checks credential/environment availability without a request or
        // OAuth refresh. The actual run still owns entitlement/refresh failures.
        const credential = await budget.wait(Promise.resolve().then(() => resolvePiApiKey?.readCredential(provider)));
        const auth = await budget.wait(modules.providerAuth.checkPiProviderAuth(provider, credential, process.env, budget.controller.signal));
        if (!auth) throw new PrivateError("private_provider_auth_failed");
      } catch (error) {
        throw new PrivateError(privateCode(error) === "private_budget_exhausted" ? "private_budget_exhausted" : "private_provider_auth_failed");
      }
    },
    async run(system, options) {
      assertPrivateProviderEnvironment();
      assertPrivateRuntimeOptions(options);
      assertPrivateBudget(budget);
      budget.privateChatCalls = (budget.privateChatCalls ?? 0) + 1;
      const inputTokens = Math.ceil(Buffer.byteLength(system + JSON.stringify(options.messages), "utf8") / 3);
      budget.reserve({ chatSteps: options.maxTurns ?? 1, estimatedInputTokens: inputTokens * (options.maxTurns ?? 1) });
      try {
        // No durable session root and no content event callbacks are forwarded.
        const result = await budget.wait(raw.run(system, { ...options, piMaxRetries: 0, piTransport: "sse", keepAlive: false, sessionKeepAlive: false, providerCheckMaxTokens: 4096,
          abortSignal: AbortSignal.any([options.abortSignal, budget.controller.signal, AbortSignal.timeout(60000)].filter(Boolean)) }));
        if (result.failureKind === "provider_auth") throw new PrivateError("private_provider_auth_failed");
        if (result.failureKind || result.error) throw new PrivateProviderError(transientFailure(modules, typeof result.error === "string" ? result.error : "", result.failureKind));
        return result;
      } catch (error) {
        assertPrivateBudget(budget);
        if (error instanceof PrivateError) throw error;
        if (privateCode(error) === "private_budget_exhausted") throw new PrivateError("private_budget_exhausted");
        throw new PrivateProviderError(transientFailure(modules, error instanceof Error ? error.message : "", null));
      }
    },
    async disposeAllSessions() { await raw.disposeAllSessions?.(); },
  };
}
/** Tool-less local completion through the app's existing memoryRuntime seam.
 * Unlike a generic HTTP adapter this refuses redirects and caps response bytes. */
export function privateCompletionRuntime(modules, route, workspace, budget, auth = {}) {
  assertPrivateProviderEnvironment();
  if (!route.startsWith("ollama:")) return privatePiRuntime(modules, workspace, budget, auth);
  return {
    async run(system, options) {
      assertPrivateProviderEnvironment();
      assertPrivateRuntimeOptions(options);
      assertPrivateBudget(budget);
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
        if (!response.ok || !response.body) throw new PrivateProviderError(response.status === 429 || response.status >= 500);
        const reader = response.body.getReader(); const chunks = []; let bytes = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
            if (bytes > 1024 * 1024) { await reader.cancel(); throw new PrivateError("private_budget_exceeded"); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof data.response !== "string") throw new PrivateError("private_provider_failed");
        budget.reserve({ outputTokens: Math.ceil(Buffer.byteLength(data.response) / 3) });
        return { text: data.response, ...(options.outputSchema === undefined ? {} : { structuredResult: JSON.parse(data.response) }) };
      } catch (error) {
        assertPrivateBudget(budget);
        if (error instanceof PrivateError) throw error;
        if (privateCode(error) === "private_budget_exhausted") throw new PrivateError("private_budget_exhausted");
        throw new PrivateProviderError(transientFailure(modules, error instanceof Error ? error.message : "", null));
      }
    },
    async disposeAllSessions() {},
  };
}
