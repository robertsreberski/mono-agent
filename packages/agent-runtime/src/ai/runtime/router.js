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
//     disposeSession / disposeAllSessions delegated to the inner runtime,
//     so the router is a drop-in replacement for createRuntime(host).
//
//   chain entries:
//     { model: ModelRef, executionMode?: "sdk" | "cli", requires?: Capabilities }
//   shorthand: a bare ModelRef is also accepted (no requirements).
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
import { resolveRuntimeBrand } from "../../runtime-brand.js";

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
 * RuntimeModelRef, or the full `{model, executionMode?, requires?}` form.
 * @property {RuntimeModelRef} model
 * @property {string} [executionMode]
 * @property {Object<string, *>} [requires]
 */

/**
 * @typedef {Object} RouterChainEntry
 * @property {RuntimeModelRef} model
 * @property {string|null} executionMode
 * @property {Object<string, *>|null} requires
 */

/**
 * @param {Object} [options]
 * @param {AgentRuntimeHostOptions} [options.host]
 * @param {ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>} [options.chain]
 * @returns {AgentRuntimeInstance & {chain: () => Array<RouterChainEntry>}}
 */
export function createRouterRuntime({ host = {}, chain = [] } = {}) {
  const entries = normaliseChain(chain);
  if (entries.length === 0) {
    throw new Error("createRouterRuntime requires a non-empty chain");
  }
  const inner = createRuntime(host);
  // The router builds transcript-tail snapshots outside the inner runtime's
  // bridge call (which is where the per-instance toolContext lives), so resolve
  // the host brand here to stamp the snapshot schema id with the same brand the
  // inner runtime uses — createRuntime no longer publishes it to a process global.
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);

  return {
    /**
     * @param {string} systemPrompt
     * @param {Partial<RuntimeRunOptions>} [options] Optional so a bare `{}` call
     *   is legal; the router always overrides `model`/`executionMode` per chain
     *   entry (see AgentRuntimeInstance.run for the public, model-required contract).
     * @returns {Promise<RuntimeResult>}
     */
    async run(systemPrompt, options = {}) {
      /** @type {Array<{model: RuntimeModelRef, failureKind: (string|null), requestId?: (string|null|undefined), retryableSubkind?: (string|null|undefined), requirements?: (Object<string,*>|null)}>} */
      const failoverHistory = [];
      /** @type {RuntimeResult|null} */
      let lastResult = null;
      /** @type {RuntimeResult|null} */
      let lastCapabilityMismatch = null;
      let promptBase = systemPrompt;
      /** @type {*} */
      let pendingSnapshot = null;

      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entrySatisfiesRequirements(entry, options)) {
          failoverHistory.push({
            model: entry.model,
            failureKind: "skipped_capability_mismatch",
            requirements: entry.requires,
          });
          continue;
        }

        const callOptions = {
          ...options,
          model: entry.model,
          executionMode: entry.executionMode || options.executionMode,
        };
        if (!entrySupportsSessionResume(entry)) {
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
          // previous attempt.
          const rendered = renderResumeSnapshot(pendingSnapshot);
          if (rendered) {
            callOptions.systemPromptPrefix = rendered;
            attemptSystemPrompt = `${rendered}\n\n${promptBase}`;
          }
        }

        if (failoverHistory.length > 0) {
          emit(callOptions, {
            type: "provider_failover_started",
            from: failoverHistory[failoverHistory.length - 1]?.model,
            to: entry.model,
            attemptIndex: i,
          });
        }

        let result;
        try {
          result = await inner.run(attemptSystemPrompt, callOptions);
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
        }

        result = normalizeProviderAuthFailure(result);

        const retryability = retryableProviderFailureInfo({
          errorText: result.error || "",
          stderrTail: result.stderrTail || "",
          failureKind: result.failureKind,
        });

        const successful = !result.error && !result.failureKind && !result.cancelled;
        if (successful) {
          if (failoverHistory.length > 0) {
            emit(callOptions, {
              type: "provider_failover_completed",
              attemptIndex: i,
              model: entry.model,
            });
          }
          return { ...result, failoverHistory };
        }

        failoverHistory.push({
          model: entry.model,
          failureKind: result.failureKind || null,
          requestId: retryability.requestId,
          retryableSubkind: retryability.subkind,
        });
        if (result.failureKind === "skipped_capability_mismatch") {
          lastCapabilityMismatch = result;
          // A bridge-level mismatch is about this route, not the logical run.
          // Try the next entry and do not derive a transcript snapshot from it.
          continue;
        }
        lastResult = result;

        // Provider auth is terminal for one provider, but chain-retryable: a
        // fallback provider may have working credentials. Other non-retryable
        // provider/request errors remain terminal.
        const shouldFallback = (retryability.retryable || result.failureKind === "provider_auth")
          && !result.cancelled;
        if (!shouldFallback) {
          return { ...result, failoverHistory };
        }

        // Build a transcript-tail snapshot from this run's events so the
        // next provider can continue. If the run produced no usable events,
        // skip the snapshot (the next attempt starts fresh).
        const snapshot = buildTranscriptTailSnapshot(result.events, { runtimeBrand });
        // Commit the context this real provider attempt saw, then queue only
        // its newly produced snapshot for the next attempt. A bridge mismatch
        // takes the earlier continue path, so it neither consumes nor duplicates
        // the pending snapshot.
        promptBase = attemptSystemPrompt;
        pendingSnapshot = snapshot || null;
      }

      const exhaustedResult = lastResult || lastCapabilityMismatch || {
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
    },
    chain: () => entries.slice(),
    configureTools(next) {
      inner.configureTools?.(next);
    },
    async disposeSession(providerSessionId) {
      return inner.disposeSession?.(providerSessionId);
    },
    async disposeAllSessions() {
      await inner.disposeAllSessions?.();
    },
  };
}

/**
 * @param {ReadonlyArray<*>} chain ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>, loosened
 *   here because distinguishing the two shapes is a runtime duck-type check
 *   (`entry.sdk && entry.model`), not something a union type narrows cleanly.
 * @returns {Array<RouterChainEntry>}
 */
function normaliseChain(chain) {
  if (!Array.isArray(chain)) return [];
  return /** @type {Array<RouterChainEntry>} */ (chain
    .map((entry) => {
      if (!entry) return null;
      if (entry.sdk && entry.model) {
        // ModelRef shorthand: { sdk, model, ... }
        return { model: entry, executionMode: null, requires: null };
      }
      if (entry.model) {
        return {
          model: entry.model,
          executionMode: typeof entry.executionMode === "string" ? entry.executionMode : null,
          requires: entry.requires && typeof entry.requires === "object" ? entry.requires : null,
        };
      }
      return null;
    })
    .filter(Boolean));
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
  if (options.fastMode === true) {
    effectiveRequires.supports_fast_mode = true;
  }
  // Native teammates likewise require a capable route; Pi/OpenCode must skip
  // rather than silently dropping them.
  if (
    Array.isArray(options.nativeSubagents?.teammates)
    && options.nativeSubagents.teammates.length > 0
  ) {
    effectiveRequires.supports_native_subagents = true;
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
 * Session identifiers belong to the bridge that created them. Never forward
 * one into a bridge that declares no resume support (notably isolated
 * per-run OpenCode), including when that bridge is reached through fallback.
 * Unknown SDKs retain the existing fail-later behavior.
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
