// Provider fallback router.
//
// Wraps `createRuntime` with an ordered chain of model references. If a run
// fails with a retryable provider error (per `retryableProviderFailureInfo`),
// the router retries the same logical run with the next chain entry,
// prepending the transcript-tail snapshot of the previous attempt to the
// system prompt so the next provider can continue rather than restart.
//
// Inspired by zeroclaw's RouterProvider hint-resolution pattern, but goes
// further: zeroclaw's router resolves a hint to one provider and never
// falls back automatically. This router does, using the failure-kind
// taxonomy and capability matrix we already maintain.
//
// API:
//   createRouterRuntime({ host, chain })
//     returns { run(systemPrompt, options) } plus configureTools /
//     syncSession / refreshSession / retireDurableSession / disposeSession /
//     invalidateSession / disposeAllSessions
//     delegated to the inner runtime,
//     so the router is a drop-in replacement for createRuntime(host).
//
//   chain entries:
//     { model: ModelRef, effort?: string|null, requires?: Capabilities }
//   shorthand: a bare ModelRef is also accepted (no requirements).
//   effort string = fixed for that route, undefined = inherit the legacy run
//   effort, null = omit effort so the provider chooses its default.
//
// Result:
//   The success run's result, with `failoverHistory` appended describing every
//   prior attempt: [{ model, failureKind, requestId, retryableSubkind }].
//   If every eligible retryable/auth entry in the chain fails, returns the last
//   result with `failureKind: "provider_unavailable_exhausted"`. Terminal
//   non-retryable failures are returned as-is with their failover history.

// @ts-check

import { createRuntime } from "../../runtime.js";
import { isProviderAuthFailureText, retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "./capabilities.js";
import { buildTranscriptTailSnapshot, renderResumeSnapshot } from "../../agent/transcript.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { resolveRuntimeBrand } from "../../runtime-brand.js";
import { createObserverHub } from "../observer.js";
import { instrumentLiveInputAppliedEvents } from "./live-input-events.js";
import { createWebSearchRunState } from "../../agent/tools/web-search-state.js";

/**
 * @typedef {import('../types.js').RuntimeModelRef} RuntimeModelRef
 * @typedef {import('../types.js').AgentRuntimeHostOptions} AgentRuntimeHostOptions
 * @typedef {import('../types.js').AgentRuntimeInstance} AgentRuntimeInstance
 * @typedef {import('../types.js').RuntimeRunOptions} RuntimeRunOptions
 * @typedef {import('../types.js').RuntimeResult} RuntimeResult
 */

/**
 * @typedef {Object} RouterChainEntryInput
 * A chain entry as accepted by createRouterRuntime: either the shorthand bare
 * RuntimeModelRef, or the full `{model, effort?, requires?, attempts?}` form.
 * @property {RuntimeModelRef} model
 * @property {string|null} [effort]
 * @property {Object<string, *>} [requires]
 * @property {number} [attempts]
 */

/**
 * @typedef {Object} RouterChainEntry
 * @property {RuntimeModelRef} model
 * @property {string|null|undefined} effort
 * @property {Object<string, *>|null} requires
 * @property {number} attempts Total attempts on this route including the first.
 */

/**
 * @typedef {Object} RouterRetryPolicy
 * @property {number} backoffMs Delay before the first retry; doubles per retry.
 * @property {number} maxBackoffMs Ceiling for the doubled delay.
 */

/**
 * @typedef {Object} RouterAttemptResolution
 * Private host seam for route-specific provider options/runtime ownership.
 * Returned options are never copied into router telemetry.
 * @property {AgentRuntimeInstance} [runtime]
 * @property {Object<string, *>} [options]
 * @property {{allowedTools?: ReadonlyArray<string>, disallowedTools?: ReadonlyArray<string>, permissionMode?: string}} [policyOptions]
 * Provider-specific projection of the logical tool policy. This deliberately
 * cannot replace any other protected request field.
 * @property {() => (void|Promise<void>)} [cleanup]
 */

const ATTEMPT_SCOPED_OPTION_KEYS = ["customProvider", "customModel", "modelCapabilities", "isPrivateProvider"];
const ROUTER_TOOL_CONTEXT_KEYS = [
  "workspace", "repoRoot", "additionalReadRoots", "additionalWriteRoots",
  "ripgrepPath", "qaOutputDir", "sandboxPolicy", "sandboxEngine",
];
const RESOLVER_PROTECTED_OPTION_KEYS = new Set([
  "model", "effort", "messages", "abortSignal", "onEvent",
  "sessionId", "providerSessionId", "providerAttributionSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs",
  "diagnosticsSeed", "systemPromptPrefix", "sandboxPolicy", "sandboxEngine", "sandbox",
  "allowedTools", "disallowedTools", "permissionMode", "mcpServers", "mcpApps", "skills",
  "mcpCallNoTotalTimeoutTools",
  "webSearchState",
  "outputSchema", "liveInput", "toolEnvironment",
]);

class ResolverProtectedOptionError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(`route attempt resolver cannot override ${key}`);
    this.name = "ResolverProtectedOptionError";
  }
}

/**
 * @param {Object} [options]
 * @param {AgentRuntimeHostOptions} [options.host]
 * @param {ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>} [options.chain]
 * @param {(input: {model: RuntimeModelRef, attemptIndex: number, retryIndex: number}) => (RouterAttemptResolution|Promise<RouterAttemptResolution>)} [options.resolveAttempt]
 * @param {Partial<RouterRetryPolicy>} [options.retry] Backoff shape for same-model
 *   retries. Per-route retry counts live on each chain entry's `attempts`.
 * @returns {AgentRuntimeInstance & {chain: () => Array<RouterChainEntry>}}
 */
export function createRouterRuntime({ host = {}, chain = [], resolveAttempt, retry } = {}) {
  const retryPolicy = normalizeRetryPolicy(retry);
  const entries = normaliseChain(chain);
  if (entries.length === 0) {
    throw new Error("createRouterRuntime requires a non-empty chain");
  }
  assertUniqueEntries(entries);
  const inner = createRuntime(host);
  /** @type {import('../types.js').AgentRuntimeToolOptions|undefined} */
  let configuredTools;
  // The router builds transcript-tail snapshots outside the inner runtime's
  // bridge call (which is where the per-instance toolContext lives), so resolve
  // the host brand here to stamp the snapshot schema id with the same brand the
  // inner runtime uses — createRuntime no longer publishes it to a process global.
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);

  return {
    /**
     * @param {string} systemPrompt
     * @param {Partial<RuntimeRunOptions>} [options] Optional so a bare `{}` call
     *   is legal; the router always overrides `model` per chain entry (see
     *   AgentRuntimeInstance.run for the public, model-required contract).
     * @returns {Promise<RuntimeResult>}
     */
    async run(systemPrompt, options = {}) {
      options = {
        ...options,
        webSearchState: createWebSearchRunState(options.webSearchConfig, options.webSearchState),
      };
      const liveInputHub = options.liveInput === undefined
        ? undefined
        : createObserverHub({
            observers: [
              ...(Array.isArray(host.observers) ? host.observers : []),
              ...(Array.isArray(options.observers) ? options.observers : []),
            ],
            onEvent: options.onEvent,
          });
      if (options.liveInput !== undefined && liveInputHub !== undefined) {
        options = {
          ...options,
          liveInput: instrumentLiveInputAppliedEvents(options.liveInput, liveInputHub.emit),
        };
      }
      try {
      /** @type {Array<{model: RuntimeModelRef, failureKind: (string|null), requestId?: (string|null|undefined), retryableSubkind?: (string|null|undefined), requirements?: (Object<string,*>|null), retryIndex?: number}>} */
      const failoverHistory = [];
      /** @type {RuntimeResult|null} */
      let lastResult = null;
      /** @type {RuntimeResult|null} */
      let lastRouteSkip = null;
      const promptBase = systemPrompt;
      /** @type {*} */
      let pendingSnapshot = null;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const effectiveToolOptions = effectiveRouterToolOptions(host, configuredTools);
        if (!entrySatisfiesRequirements(entry, options)) {
          lastRouteSkip = {
            text: null,
            error: `Route ${modelKey(entry.model)} does not satisfy the logical run's required capabilities.`,
            failureKind: "skipped_capability_mismatch",
            events: [],
            cancelled: false,
            usage: {},
          };
          failoverHistory.push({
            model: entry.model,
            failureKind: "skipped_capability_mismatch",
            requirements: entry.requires,
          });
          continue;
        }

        // Attempt-scoped stripping is a property of the ROUTE (chain index), not
        // of one attempt, so it is decided once here. Every same-model retry
        // derives a fresh mutable callOptions from this immutable base, because
        // the per-attempt bag is mutated in place (effort, session deletes,
        // snapshot seed) and reassigned by mergeAttemptOptions.
        /** @type {*} */
        const entryOptionsBase = {
          ...options,
          model: entry.model,
        };
        // The legacy run-level custom-provider bag describes the primary
        // route. Without a route resolver there is no authoritative metadata
        // for a different fallback, so never let the primary's credentials or
        // model capabilities contaminate later attempts.
        const entryCallBase = resolveAttempt === undefined && i > 0
          ? withoutAttemptScopedOptions(entryOptionsBase)
          : entryOptionsBase;

        /** @type {RuntimeResult|null} A failure that ends the whole logical run. */
        let terminalResult = null;

        for (let retryIndex = 0; retryIndex < entry.attempts; retryIndex += 1) {
          /** @type {*} */
          let callOptions = { ...entryCallBase };
          /** @type {AgentRuntimeInstance} */
          let attemptRuntime = inner;
          /** @type {(() => (void|Promise<void>))|undefined} */
          let attemptCleanup;
          try {
            const resolved = resolveAttempt === undefined
              ? undefined
              : await resolveAttempt({
                  model: entry.model,
                  attemptIndex: i,
                  retryIndex,
                });
            const resolution = normalizeAttemptResolution(resolved);
            attemptCleanup = resolution?.cleanup;
            if (resolveAttempt !== undefined) {
              callOptions = mergeAttemptOptions(callOptions, resolution?.options);
              callOptions = mergeAttemptPolicyOptions(callOptions, resolution?.policyOptions);
            }
            if (resolution?.runtime !== undefined) {
              assertRuntimeLike(resolution.runtime);
              attemptRuntime = resolution.runtime;
              projectPiRuntimeToolContext(attemptRuntime, effectiveToolOptions);
            }
          } catch (error) {
            try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
            const failure = attemptResolutionFailureResult(error);
            lastResult = failure;
            failoverHistory.push({
              model: entry.model,
              failureKind: failure.failureKind || null,
            });
            // A resolver fault is a config/credential problem, not a transient
            // provider blip: retrying the same route cannot fix it. Advance.
            break;
          }

          applyEntryEffort(callOptions, entry.effort);
          // A provider session belongs to the route AND to the attempt that
          // created it. The entire chain is stateless whenever a fallback exists,
          // keeping the full logical run replayable regardless of which route is
          // attempted. A same-model retry re-sends the whole logical turn, so
          // resuming the session the failed attempt already appended into would
          // duplicate the turn or hit session_busy.
          if (entries.length > 1 || i > 0 || retryIndex > 0 || !entrySupportsSessionResume(entry)) {
            delete callOptions.sessionId;
            delete callOptions.providerSessionId;
            delete callOptions.sessionKeepAlive;
            delete callOptions.sessionIdleTimeoutMs;
          }
          let attemptSystemPrompt = promptBase;
          if (pendingSnapshot) {
            callOptions.diagnosticsSeed = {
              ...(callOptions.diagnosticsSeed || {}),
              resume_snapshot: pendingSnapshot,
            };
            // Also prepend the rendered snapshot to the system prompt so SDK
            // backends that don't read diagnosticsSeed still continue from the
            const rendered = renderResumeSnapshot(pendingSnapshot);
            if (rendered) {
              callOptions.systemPromptPrefix = rendered;
              attemptSystemPrompt = `${rendered}\n\n${promptBase}`;
            }
          }

          // A same-model retry is not a failover: only the first attempt of a new
          // route announces a transition.
          if (retryIndex === 0 && failoverHistory.length > 0) {
            const previous = failoverHistory[failoverHistory.length - 1];
            emit(callOptions, {
              type: "provider_failover_started",
              from: modelKey(previous?.model),
              to: modelKey(entry.model),
              attemptIndex: i,
              // Why the route changed, in the same vocabulary provider_retry_started
              // uses. Operators reading a transcript need the cause next to the
              // transition, not only in the run artifact's failoverHistory.
              reason: previous?.retryableSubkind || previous?.failureKind || null,
            });
          }

          let result;
          try {
            result = await attemptRuntime.run(attemptSystemPrompt, callOptions);
          } catch (err) {
            // The inner runtime usually surfaces errors as structured result
            // fields, but a bridge can still throw synchronously (e.g. spawn
            // failures). Convert to a result-like shape so the chain logic
            // is uniform.
            result = {
              text: null,
              error: err?.message || String(err),
              failureKind: "provider_unavailable",
              events: [],
              cancelled: false,
              usage: {},
            };
          } finally {
            try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
          }

          result = normalizeProviderAuthFailure(result);

          const retryability = retryableProviderFailureInfo({
            errorText: result.error || "",
            stderrTail: result.stderrTail || "",
            failureKind: result.failureKind,
          });

          const successful = !result.error && !result.failureKind && !result.cancelled;
          if (successful) {
            // Only a genuine route change is a completed failover: succeeding
            // after a same-model retry must not render as "answered by X
            // (failover)" when X is still the route the operator asked for.
            if (failoverHistory.some((attempt) => modelKey(attempt.model) !== modelKey(entry.model))) {
              emit(callOptions, {
                // modelKey, not the ModelRef: every consumer of this event reads
                // `model` as a string (responder.ts's stringField is string-only),
                // so an object here is dropped silently rather than rendered.
                type: "provider_failover_completed",
                attemptIndex: i,
                model: modelKey(entry.model),
              });
            }
            return { ...result, failoverHistory };
          }

          failoverHistory.push({
            model: entry.model,
            failureKind: result.failureKind || null,
            requestId: retryability.requestId,
            retryableSubkind: retryability.subkind,
            ...(retryIndex > 0 ? { retryIndex } : {}),
          });
          if (result.failureKind === "skipped_capability_mismatch") {
            lastRouteSkip = result;
            // A bridge-level mismatch is about this route, not the logical run.
            // Try the next entry and do not derive a transcript snapshot from it.
            break;
          }
          lastResult = result;

          // Provider auth is terminal for one provider, but chain-retryable: a
          // fallback provider may have working credentials. Other non-retryable
          // provider/request errors remain terminal.
          const shouldFallback = (retryability.retryable || result.failureKind === "provider_auth")
            && !result.cancelled
            && !isMidTurnSafetyFailure(result.failureKind);
          if (!shouldFallback) {
            terminalResult = result;
            break;
          }

          // Build a transcript-tail snapshot from this run's events so the next
          // attempt — same model or next route — can continue. A run that
          // produced no usable events yields a falsy snapshot and merges to a
          // no-op, so the common "died before the first token" retry costs
          // nothing. Keep one bounded snapshot object across the logical run
          // instead of nesting a new <resume_context> block per transition.
          pendingSnapshot = mergeResumeSnapshots(
            pendingSnapshot,
            buildTranscriptTailSnapshot(result.events, { runtimeBrand }),
          );

          // context_limit is forced retryable so the chain can reach a model with
          // a bigger window, but it is deterministic against the SAME window:
          // another attempt here is a guaranteed second failure. Advance instead.
          const sameModelRetryable = retryability.retryable
            && retryability.subkind !== "context_limit"
            && retryIndex + 1 < entry.attempts;
          if (!sameModelRetryable) break;

          const backoffMs = Math.min(retryPolicy.maxBackoffMs, retryPolicy.backoffMs * (2 ** retryIndex));
          emit(callOptions, {
            type: "provider_retry_started",
            model: modelKey(entry.model),
            attemptIndex: i,
            retryIndex: retryIndex + 1,
            attempts: entry.attempts,
            delayMs: backoffMs,
            reason: retryability.subkind || result.failureKind || null,
          });
          if (callOptions.abortSignal?.aborted) {
            return { ...result, cancelled: true, failoverHistory };
          }
          await delay(backoffMs, callOptions.abortSignal);
          if (callOptions.abortSignal?.aborted) {
            return { ...result, cancelled: true, failoverHistory };
          }
        }

        if (terminalResult !== null) {
          return { ...terminalResult, failoverHistory };
        }
        // Every other inner break falls through to the next chain entry.
      }

      const exhaustedResult = lastResult || lastRouteSkip || {
        text: null,
        events: [],
        error: "router chain exhausted with no executions",
        failureKind: "skipped_capability_mismatch",
        cancelled: false,
        usage: {},
      };
      return {
        ...exhaustedResult,
        failureKind: lastResult ? "provider_unavailable_exhausted" : exhaustedResult.failureKind,
        failoverHistory,
      };
      } finally {
        await liveInputHub?.flush();
      }
    },
    chain: () => entries.slice(),
    configureTools(next = {}) {
      configuredTools = { ...(configuredTools || {}), ...next };
      inner.configureTools?.(next);
    },
    async syncSession(providerSessionId) {
      return Boolean(await inner.syncSession?.(providerSessionId));
    },
    async refreshSession(providerSessionId) {
      if (typeof inner.refreshSession !== "function") {
        throw new Error("A routed runtime cannot guarantee a cold provider-session reopen");
      }
      await inner.refreshSession(providerSessionId);
    },
    async retireDurableSession(providerSessionId, sessionsRoot) {
      if (typeof inner.retireDurableSession !== "function") {
        throw new Error("A routed runtime cannot retire durable provider-session state");
      }
      await inner.retireDurableSession(providerSessionId, sessionsRoot);
    },
    async disposeSession(providerSessionId) {
      return Boolean(await inner.disposeSession?.(providerSessionId));
    },
    async invalidateSession(providerSessionId) {
      return Boolean(await inner.invalidateSession?.(providerSessionId));
    },
    async disposeAllSessions() {
      await inner.disposeAllSessions?.();
    },
  };
}

/**
 * @param {ReadonlyArray<*>} chain ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>, loosened
 *   here because distinguishing the two shapes is a runtime duck-type check,
 *   not something a union type narrows cleanly.
 * @returns {Array<RouterChainEntry>}
 */
function normaliseChain(chain) {
  if (!Array.isArray(chain)) return [];
  return /** @type {Array<RouterChainEntry>} */ (chain
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry.provider === "string" && typeof entry.model === "string") {
        // ModelRef shorthand: { provider, model, reference }
        return { model: entry, effort: undefined, requires: null, attempts: 1 };
      }
      if (entry.model) {
        return {
          model: entry.model,
          effort: normalizeChainEffort(entry.effort),
          requires: entry.requires && typeof entry.requires === "object" ? entry.requires : null,
          attempts: normalizeChainAttempts(entry.attempts),
        };
      }
      return null;
    })
    .filter(Boolean));
}

/**
 * The kernel default is ONE attempt per entry. Enabling same-model retries is a
 * host policy decision (`@mono-agent/config` supplies the product default), so
 * the router stays mechanism and existing callers keep single-shot behavior.
 * @param {*} attempts
 * @returns {number}
 */
function normalizeChainAttempts(attempts) {
  if (attempts === undefined || attempts === null) return 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("createRouterRuntime chain attempts must be an integer between 1 and 10");
  }
  return attempts;
}

/**
 * @param {Partial<RouterRetryPolicy>|undefined} retry
 * @returns {RouterRetryPolicy}
 */
function normalizeRetryPolicy(retry) {
  const backoffMs = normalizeRetryDelay(retry?.backoffMs, 1000, "backoffMs");
  const maxBackoffMs = normalizeRetryDelay(retry?.maxBackoffMs, 15000, "maxBackoffMs");
  return { backoffMs, maxBackoffMs };
}

/** @param {*} value @param {number} fallback @param {string} name @returns {number} */
function normalizeRetryDelay(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`createRouterRuntime retry.${name} must be a non-negative finite number`);
  }
  return value;
}

/**
 * Abortable sleep. agent-runtime is the kernel and cannot reach the app-layer
 * backoff helpers, so this mirrors the local `delay` in the codex bridge.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    /** @type {*} */ (timer).unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** @param {*} effort @returns {string|null|undefined} */
function normalizeChainEffort(effort) {
  if (effort === undefined || effort === null) return effort;
  if (typeof effort !== "string" || effort.length === 0 || effort.trim() !== effort) {
    throw new Error("createRouterRuntime chain effort must be a non-empty trimmed string, null, or omitted");
  }
  return effort;
}

/** @param {Array<RouterChainEntry>} entries */
function assertUniqueEntries(entries) {
  const seen = new Map();
  entries.forEach((entry, index) => {
    const key = modelKey(entry.model);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(`createRouterRuntime duplicate model ${key} at chain entries ${first} and ${index}`);
    }
    seen.set(key, index);
  });
}

/** @param {RuntimeModelRef} model */
function modelKey(model) {
  return model.reference;
}

/**
 * Resolve the router-owned base ToolContext exactly as createRuntime(host)
 * followed by the router's configureTools calls would. Every data key is
 * present so projecting into a resolver-supplied runtime also clears hidden
 * state. RuntimeSandbox is special: configureTools intentionally ignores an
 * undefined implementation, so the configured value only replaces the host
 * seam when it is concrete.
 *
 * @param {AgentRuntimeHostOptions} host
 * @param {import('../types.js').AgentRuntimeToolOptions|undefined} configuredTools
 * @returns {import('../types.js').AgentRuntimeToolOptions}
 */
function effectiveRouterToolOptions(host, configuredTools) {
  /** @type {Object<string, *>} */
  const effective = {};
  for (const key of ROUTER_TOOL_CONTEXT_KEYS) {
    effective[key] = configuredTools !== undefined && Object.hasOwn(configuredTools, key)
      ? configuredTools[key]
      : host[key];
  }
  effective.sandbox = configuredTools?.sandbox
    ?? host.sandbox
    ?? passthroughSandbox;
  return effective;
}

/**
 * A resolver-supplied Pi runtime is allowed to own credentials/provider
 * lifecycle, never the router-owned tool context. Replace its complete mutable
 * ToolContext before every execution so a blank or stale runtime cannot diverge
 * from the router's host/configured/run policy or telemetry.
 *
 * @param {AgentRuntimeInstance} runtime
 * @param {import('../types.js').AgentRuntimeToolOptions} toolOptions
 */
function projectPiRuntimeToolContext(runtime, toolOptions) {
  if (typeof runtime.configureTools !== "function") {
    throw new Error("route attempt runtime must expose configureTools() for tool-context projection");
  }
  runtime.configureTools(toolOptions);
}

/** @param {RouterAttemptResolution|undefined} value */
function normalizeAttemptResolution(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("route attempt resolver must return an object or undefined");
  }
  if (value.options !== undefined && (value.options === null || typeof value.options !== "object" || Array.isArray(value.options))) {
    throw new Error("route attempt resolver options must be an object");
  }
  if (value.cleanup !== undefined && typeof value.cleanup !== "function") {
    throw new Error("route attempt resolver cleanup must be a function");
  }
  return {
    ...value,
    ...(value.policyOptions === undefined
      ? {}
      : { policyOptions: normalizeAttemptPolicyOptions(value.policyOptions) }),
  };
}

const ATTEMPT_POLICY_OPTION_KEYS = new Set(["allowedTools", "disallowedTools", "permissionMode"]);

function normalizeAttemptPolicyOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("route attempt resolver policyOptions must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!ATTEMPT_POLICY_OPTION_KEYS.has(key)) {
      throw new Error(`route attempt resolver policyOptions cannot override ${key}`);
    }
  }
  for (const key of ["allowedTools", "disallowedTools"]) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      throw new Error(`route attempt resolver policyOptions.${key} must be an array or undefined`);
    }
  }
  if (value.permissionMode !== undefined && typeof value.permissionMode !== "string") {
    throw new Error("route attempt resolver policyOptions.permissionMode must be a string or undefined");
  }
  return value;
}

/**
 * Removes credentials and model metadata belonging to the previous route,
 * then applies the current route's private options. Logical request, safety,
 * effort, and session fields remain router-owned.
 * @param {Object<string, *>} base
 * @param {Object<string, *>|undefined} resolved
 */
function mergeAttemptOptions(base, resolved) {
  const merged = withoutAttemptScopedOptions(base);
  if (resolved === undefined) return merged;
  for (const [key, value] of Object.entries(resolved)) {
    if (RESOLVER_PROTECTED_OPTION_KEYS.has(key)) {
      throw new ResolverProtectedOptionError(key);
    }
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeAttemptPolicyOptions(base, policyOptions) {
  if (policyOptions === undefined) return base;
  const merged = { ...base };
  for (const key of ATTEMPT_POLICY_OPTION_KEYS) {
    if (!Object.hasOwn(policyOptions, key)) continue;
    if (policyOptions[key] === undefined) delete merged[key];
    else merged[key] = policyOptions[key];
  }
  return merged;
}

/**
 * @param {Object<string, *>} options
 * @returns {Object<string, *>}
 */
function withoutAttemptScopedOptions(options) {
  const projected = { ...options };
  for (const key of ATTEMPT_SCOPED_OPTION_KEYS) delete projected[key];
  return projected;
}

/** @param {AgentRuntimeInstance} runtime */
function assertRuntimeLike(runtime) {
  if (runtime === null || typeof runtime !== "object" || typeof runtime.run !== "function") {
    throw new Error("route attempt resolver runtime must expose run()");
  }
}

/** @param {Object<string, *>} options @param {string|null|undefined} effort */
function applyEntryEffort(options, effort) {
  if (effort === null) {
    delete options.effort;
  } else if (typeof effort === "string") {
    options.effort = effort;
  }
}

/** @param {unknown} error @returns {RuntimeResult} */
function attemptResolutionFailureResult(error) {
  // Host resolvers may handle credentials. Never echo their exception text
  // into persisted results or route telemetry. ResolverProtectedOptionError is
  // constructed only from a repository-owned allowlist key, so it is safe and
  // useful to expose for a rejected logical-request override.
  return {
    text: null,
    error: error instanceof ResolverProtectedOptionError
      ? error.message
      : "The route attempt could not be resolved before execution.",
    failureKind: "provider_unavailable",
    events: [],
    cancelled: false,
    usage: {},
  };
}

/** @param {string|null|undefined} failureKind */
function isMidTurnSafetyFailure(failureKind) {
  return typeof failureKind === "string"
    && (failureKind.startsWith("sandbox_") || failureKind.startsWith("safety_"));
}

/**
 * Merge progress into one bounded snapshot so prompts never accumulate nested
 * resume blocks across a long provider chain.
 * @param {*} previous
 * @param {*} next
 */
function mergeResumeSnapshots(previous, next) {
  if (!next) return previous || null;
  if (!previous) return next;
  const previousTurns = Array.isArray(previous.turns) ? previous.turns : [];
  const nextTurns = Array.isArray(next.turns) ? next.turns : [];
  const allTurns = [...previousTurns, ...nextTurns];
  const turns = allTurns.slice(-3);
  const dropped = allTurns.slice(0, Math.max(0, allTurns.length - turns.length));
  const existingSummaries = [
    ...(Array.isArray(previous.earlier_turn_summaries) ? previous.earlier_turn_summaries : []),
    ...(Array.isArray(next.earlier_turn_summaries) ? next.earlier_turn_summaries : []),
  ].map((entry) => String(entry?.summary ?? "").slice(0, 320)).filter(Boolean);
  const droppedSummaries = dropped.map(summarizeSnapshotTurn);
  const summaries = [...existingSummaries, ...droppedSummaries].slice(-9);
  const turnCount = Math.max(
    turns.length + summaries.length,
    Number(previous.turn_count || 0) + Number(next.turn_count || 0),
  );
  return {
    ...next,
    turn_count: turnCount,
    earlier_turn_summaries: summaries.map((summary, index) => ({
      turn_index: Math.max(1, turnCount - turns.length - summaries.length + index + 1),
      summary,
    })),
    turns,
  };
}

/** @param {*} turn */
function summarizeSnapshotTurn(turn) {
  const assistant = typeof turn?.assistant_text === "string" ? turn.assistant_text.trim() : "";
  const tools = Array.isArray(turn?.tool_uses)
    ? turn.tool_uses.map((tool) => tool?.name).filter(Boolean).slice(0, 5)
    : [];
  const pieces = [];
  if (assistant) pieces.push(assistant.split(/\r?\n/u)[0].slice(0, 220));
  if (tools.length > 0) pieces.push(`tools: ${tools.join(", ")}`);
  return (pieces.join("; ") || "provider attempt made progress").slice(0, 320);
}

/**
 * @param {RouterChainEntry} entry
 * @param {Partial<RuntimeRunOptions>} options
 * @returns {boolean}
 */
function entrySatisfiesRequirements(entry, options) {
  const requires = entry.requires;
  // Synthesize effective requirements: merge the entry's own `requires` with
  // requirements inferred from per-run options, so a chain entry that carries
  // no explicit `requires` (the agent-host + runtime-adapter paths cannot carry
  // one today) still respects option-implied capability needs. Each option
  // inference defers to an explicit entry pin, never overriding it.
  const effectiveRequires = { ...(requires || null) };
  // Infer required capabilities from request-time options. These requirements
  // override a contradictory entry pin (`requires: false`): the caller's actual
  // request cannot be silently weakened. Empty JSON Schema `{}` still counts.
  if (
    options.outputSchema !== undefined
    && options.outputSchema !== null
  ) {
    effectiveRequires.structured_output = true;
  }
  if (
    options.mcpServers !== undefined
    && options.mcpServers !== null
    && Object.keys(options.mcpServers).length > 0
  ) {
    effectiveRequires.supports_mcp = true;
  }
  if (
    Array.isArray(options.skills)
    && options.skills.length > 0
  ) {
    effectiveRequires.supports_skills = true;
  }
  if (options.liveInput) {
    effectiveRequires.supports_live_input = true;
  }
  if (options.toolEnvironment !== undefined) {
    effectiveRequires.supports_request_tool_environment = true;
  }
  if (Object.keys(effectiveRequires).length === 0) return true;
  let caps;
  try {
    caps = runtimeCapabilities(entry.model);
  } catch {
    return false;
  }
  for (const [key, expected] of Object.entries(effectiveRequires)) {
    if (caps[key] !== expected) return false;
  }
  return true;
}

/**
 * Session identifiers belong to the route that created them. Never forward one
 * into a route whose capabilities declare no resume support, including when
 * that route is reached through fallback. Unknown model references retain the
 * existing fail-later behavior.
 * @param {RouterChainEntry} entry
 * @returns {boolean}
 */
function entrySupportsSessionResume(entry) {
  try {
    return runtimeCapabilities(entry.model).supports_session_resume === true;
  } catch {
    return true;
  }
}

/**
 * @param {Partial<RuntimeRunOptions>} callOptions
 * @param {import('../types.js').RuntimeEvent} event
 * @returns {void}
 */
function emit(callOptions, event) {
  try { callOptions.onEvent?.(event); } catch { /* swallow */ }
}

/**
 * @param {RuntimeResult} result
 * @returns {RuntimeResult}
 */
function normalizeProviderAuthFailure(result) {
  if (result.cancelled) return result;
  const failureKind = result.failureKind || null;
  if (failureKind && failureKind !== "provider_unavailable") return result;
  const haystack = `${result.error || ""}\n${result.stderrTail || ""}`;
  if (!isProviderAuthFailureText(haystack)) return result;
  return { ...result, failureKind: "provider_auth" };
}
