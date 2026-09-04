// Top-level runtime factory.
//
// `createRuntime(host)` is the ergonomic entry point for hosts. It binds the
// host integration callbacks (pricing, persistence, credentials), builds a
// per-instance `ToolContext` (agent/tools/shared/tool-context.js) that this
// runtime instance threads to every bridge call via `options.toolContext`
// instead of a process-global, and returns a `.run(systemPrompt, options)`
// method that resolves the Pi provider bridge based on `options.model`.
//
// The runtime registry lazily imports the Pi implementation only when a run
// selects it. Hosts that need finer control can keep using the named exports
// directly.
//
// Return shape from `.run()`:
//   { text, structuredResult, structuredResultSource, events, usage,
//     durationMs, numTurns, model, effort, sdk, cancelled, error,
//     errorDetails, failureKind, providerSessionId, runtimeWarnings,
//     diagnostics }
//
// `text` is the raw assistant text. `structuredResult` is whatever JSON the
// agent returned via the configured outputSchema (undefined when no schema
// was supplied). Hosts that want a domain-specific contract (for example,
// a product-specific result object,
// task envelopes, etc.) parse it themselves.

// @ts-check

import { resolveRuntimeBridge } from "./ai/runtime/registry.js";
import { createObserverHub } from "./ai/observer.js";
import {
  disposeAllProviderSessions,
  disposeProviderSession,
  invalidateProviderSession,
  refreshProviderSession,
  syncProviderSession,
} from "./ai/runtime/sessions.js";
import { createToolContext, updateToolContext } from "./agent/tools/shared/tool-context.js";
import { resolveRuntimeBrand } from "./runtime-brand.js";
import { retireDurableNativeSession } from "./ai/providers/pi-native/session-lifecycle.js";
import { instrumentLiveInputAppliedEvents } from "./ai/runtime/live-input-events.js";
import { createToolLifecycleEventGate } from "./ai/tool-lifecycle.js";

/**
 * @typedef {import('./ai/types.js').AgentRuntimeHostOptions} AgentRuntimeHostOptions
 * @typedef {import('./ai/types.js').AgentRuntimeToolOptions} AgentRuntimeToolOptions
 * @typedef {import('./ai/types.js').AgentRuntimeInstance} AgentRuntimeInstance
 * @typedef {import('./ai/types.js').RuntimeRunOptions} RuntimeRunOptions
 * @typedef {import('./ai/types.js').RuntimeResult} RuntimeResult
 */

// Host-integration callbacks bound onto every request. This list is the runtime
// half of the `Pick<AgentRuntimeHostOptions, ...>` clause in the `RuntimeRequest`
// typedef (ai/types.js) -- the two must stay identical, or hosts get keys the
// declared request shape does not admit.
const HOST_KEYS = [
  "resolveCustomPricing",
  "resolvePiApiKey",
  "persistArtifact",
  "onCompactionRecorded",
  "onToolApprovalRequest",
  "toolRiskTiers",
  "approvalDefaultRiskTier",
  "approvalTimeoutMs",
  "approvalAlwaysAllowTools",
];

const TOOL_RUNTIME_KEYS = [
  "workspace",
  "repoRoot",
  "ripgrepPath",
  "qaOutputDir",
  "sandboxPolicy",
  "sandboxEngine",
  "sandbox",
];

/**
 * @param {Object<string, *>} source
 * @param {Array<string>} keys
 * @returns {Object<string, *>}
 */
function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Select recognized keys that are present even when their value is undefined.
 * `configureTools` uses this variant so callers can explicitly clear state
 * held by the long-lived per-instance ToolContext.
 * @param {Object<string, *>} source
 * @param {Array<string>} keys
 * @returns {Object<string, *>}
 */
function pickPresent(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && key in source) out[key] = source[key];
  }
  return out;
}

const PROMPT_OVERRIDE_KEYS = ["structuredOutputInstruction", "structuredOutputFinalization", "liveInputGuidance"];

/**
 * Per-field merge of the prompt overrides: a run-level override wins over the
 * host-level default wins over the bridge's built-in default (an absent field
 * leaves the bridge on its built-in string). Kept out of the `...hostDefaults,
 * ...options` spread so a run that overrides ONE prompt does not drop the host's
 * other prompt defaults (an object-replacing spread would).
 * @param {import('./ai/types.js').RuntimePromptOverrides} [hostPrompts]
 * @param {import('./ai/types.js').RuntimePromptOverrides} [runPrompts]
 * @returns {import('./ai/types.js').RuntimePromptOverrides|undefined}
 */
function resolvePrompts(hostPrompts, runPrompts) {
  if (!hostPrompts && !runPrompts) return undefined;
  /** @type {Record<string, *>} */
  const merged = {};
  for (const key of PROMPT_OVERRIDE_KEYS) {
    const value = /** @type {any} */ (runPrompts)?.[key] ?? /** @type {any} */ (hostPrompts)?.[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * @param {AgentRuntimeHostOptions} [host]
 * @returns {AgentRuntimeInstance}
 */
export function createRuntime(host = {}) {
  const hostDefaults = pickDefined(host, HOST_KEYS);
  const toolRuntime = pickDefined(host, TOOL_RUNTIME_KEYS);
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);
  const hostObservers = Array.isArray(host.observers) ? host.observers.slice() : [];
  // Per-instance tool context, built once and threaded to every bridge via
  // `options.toolContext` (below). It replaces the former global side effect:
  // two runtimes in one process now keep independent workspace/brand/sandbox
  // config instead of clobbering a shared singleton. `configureTools` mutates
  // THIS object so later runs of this instance observe the update.
  const toolContext = createToolContext({ ...toolRuntime, runtimeBrand });

  /** @type {*} */
  let self;

  /**
   * Kernel fallback for `subagents.run`, so the `Agent` built-in works from a
   * bare `createRuntime` with no host wiring. Hosts replace it to route child
   * turns through their own runtime (fallback chain, retries, recording).
   *
   * Scope of the guarantee, precisely: this fallback rebuilds the child bag with
   * stripped session/steering state, but a HOST-SUPPLIED `run` is installed
   * verbatim and is a privileged seam — it is responsible for its own session
   * isolation. Recursion is blocked independently of the callback: the `Agent`
   * tool stamps `depth + 1` into every descriptor it hands out, and
   * `getPiBuiltinTools` refuses to register the tool at depth >= 1, so a custom
   * callback cannot produce a grandchild even if it ignores the rest.
   * @param {*} request
   */
  const defaultSubagentRun = async (request) => self.run(request.systemPrompt, {
    model: request.model,
    // A child must never be less confined than its parent. The policy is a
    // per-run option, not a host key, so without forwarding it the child would
    // run with no sandbox at all — and its default tools include WebFetch and
    // WebSearch, so even a read-only profile could bypass network policy.
    ...(request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy }),
    ...(request.sandboxEngine === undefined ? {} : { sandboxEngine: request.sandboxEngine }),
    // The parent's disclosed skills, for the same reason: they are a per-run
    // option, so a child that does not receive them has no ReadSkill tool and no
    // index, and must rediscover by trial and error what its parent could look
    // up. A host-supplied `run` may gate this; the default has no route or deny
    // list of its own to consult, so it forwards what it was given.
    ...(request.skills === undefined ? {} : { skills: request.skills }),
    ...(request.skillsRoot === undefined ? {} : { skillsRoot: request.skillsRoot }),
    ...(request.toolEnvironment === undefined ? {} : { toolEnvironment: request.toolEnvironment }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    // A profile that pins effort — declared or authored at call time — means it
    // on this path too; dropping it would silently run the child at the
    // parent's level while reporting the profile's.
    ...(request.definition?.effort === undefined ? {} : { effort: request.definition.effort }),
    messages: [{ role: "user", content: request.prompt }],
    maxTurns: request.maxTurns,
    allowedTools: request.definition?.allowedTools,
    disallowedTools: request.definition?.disallowedTools,
    mcpServers: request.definition?.mcpServers ?? {},
    abortSignal: request.abortSignal,
    onEvent: request.onEvent,
    subagents: { depth: (request.depth ?? 1) },
  });

  self = {
    /**
     * @param {string} systemPrompt
     * @param {Partial<RuntimeRunOptions>} [options] Optional only so the
     *   `options.model` guard below can throw a descriptive error; every
     *   real caller must supply a model (see AgentRuntimeInstance.run).
     * @returns {Promise<RuntimeResult>}
     */
    async run(systemPrompt, options = {}) {
      if (!options.model) throw new Error("createRuntime.run requires options.model");
      const bridge = await resolveRuntimeBridge(options.model, {
        liveInput: !!options.liveInput,
      });
      const callObservers = Array.isArray(options.observers) ? options.observers : [];
      const hub = createObserverHub({
        observers: [...hostObservers, ...callObservers],
      });
      const lifecycleGate = createToolLifecycleEventGate({
        sink: options.toolLifecycleSink,
        // Observer delivery keeps the runtime's synchronous contract. Only the
        // client-facing lifecycle event waits for its serialized persistence.
        onObserve: (event) => hub.emit(event),
        onEvent: options.onEvent,
        abortSignal: options.abortSignal,
      });
      const liveInput = instrumentLiveInputAppliedEvents(options.liveInput, lifecycleGate.emit);
      const prompts = resolvePrompts(host.prompts, options.prompts);
      // A request-scoped environment must never mutate the long-lived runtime's
      // shared ToolContext. Clone only for this call, preserving configureTools
      // updates while keeping credentials isolated between concurrent turns.
      const runToolContext = options.toolEnvironment === undefined
        ? toolContext
        : { ...toolContext, toolEnvironment: options.toolEnvironment };
      // Default the nested-run callback so the Agent built-in is usable without
      // host wiring; the depth field is left exactly as the caller set it, since
      // defaultSubagentRun is what increments it for the child.
      const subagents = options.subagents === undefined
        ? undefined
        : { ...options.subagents, run: options.subagents.run ?? defaultSubagentRun };
      try {
        return await bridge.execute(systemPrompt, {
          ...hostDefaults,
          ...options,
          ...(subagents === undefined ? {} : { subagents }),
          // `...options` alone doesn't carry the `options.model` narrowing above
          // (spread reads the parameter's declared — Partial — type); re-assert
          // the already-validated model so the request satisfies RuntimeRequest.
          model: options.model,
          runtimeBrand,
          toolContext: runToolContext,
          observerHub: hub,
          onEvent: lifecycleGate.emit,
          // The host gate is the sole persistence owner. Provider subscribe
          // callbacks are synchronous and must never await the storage sink.
          toolLifecycleSink: undefined,
          ...(liveInput === undefined ? {} : { liveInput }),
          // Merged AFTER the spreads so the per-field run>host>default precedence
          // wins over either bag's whole-object `prompts`.
          ...(prompts === undefined ? {} : { prompts }),
        });
      } finally {
        await lifecycleGate.flush();
        await hub.flush();
      }
    },
    configureTools(next = {}) {
      updateToolContext(toolContext, pickPresent(next, TOOL_RUNTIME_KEYS));
    },
    async syncSession(providerSessionId) {
      return syncProviderSession(providerSessionId);
    },
    async refreshSession(providerSessionId) {
      return refreshProviderSession(providerSessionId);
    },
    async retireDurableSession(providerSessionId, sessionsRoot) {
      return retireDurableNativeSession(providerSessionId, sessionsRoot);
    },
    async disposeSession(providerSessionId) {
      return disposeProviderSession(providerSessionId);
    },
    async invalidateSession(providerSessionId) {
      return invalidateProviderSession(providerSessionId);
    },
    async disposeAllSessions() {
      return disposeAllProviderSessions();
    },
  };

  return self;
}
