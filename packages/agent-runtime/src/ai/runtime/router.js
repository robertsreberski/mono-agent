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
//   If every entry in the chain fails, returns the last result with
//   `failureKind: "provider_unavailable_exhausted"`.

// @ts-check

import { createRuntime } from "../../runtime.js";
import { retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "./capabilities.js";
import { buildTranscriptTailSnapshot, renderResumeSnapshot } from "../../agent/transcript.js";

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
      /** @type {*} */
      let resumeSnapshot = null;

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
        if (resumeSnapshot) {
          callOptions.diagnosticsSeed = {
            ...(callOptions.diagnosticsSeed || {}),
            resume_snapshot: resumeSnapshot,
          };
          // Also prepend the rendered snapshot to the system prompt so SDK
          // backends that don't read diagnosticsSeed still continue from the
          // previous attempt.
          const rendered = renderResumeSnapshot(resumeSnapshot);
          if (rendered) {
            callOptions.systemPromptPrefix = rendered;
            systemPrompt = `${rendered}\n\n${systemPrompt}`;
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
          result = await inner.run(systemPrompt, callOptions);
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
        lastResult = result;

        // Bail early on non-retryable failures (auth, billing, cancellation,
        // invalid_result). Only retryable provider errors trigger fallback.
        const shouldFallback = retryability.retryable && !result.cancelled;
        if (!shouldFallback) break;

        // Build a transcript-tail snapshot from this run's events so the
        // next provider can continue. If the run produced no usable events,
        // skip the snapshot (the next attempt starts fresh).
        const snapshot = buildTranscriptTailSnapshot(result.events);
        if (snapshot) resumeSnapshot = snapshot;
      }

      const exhaustedResult = lastResult || {
        text: null,
        events: [],
        error: "router chain exhausted with no executions",
        failureKind: "provider_unavailable_exhausted",
        cancelled: false,
        usage: {},
      };
      return {
        ...exhaustedResult,
        failureKind: "provider_unavailable_exhausted",
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
  // Honour request-time outputSchema → require structured_output unless the
  // entry already pins it.
  if (options.outputSchema && effectiveRequires.structured_output === undefined) {
    effectiveRequires.structured_output = true;
  }
  // Honour native-subagent teammates → require supports_native_subagents unless
  // the entry already pins it. A pi entry (supports_native_subagents:false) then
  // fails here rather than silently dropping the teammates.
  if (
    Array.isArray(options.nativeSubagents?.teammates)
    && options.nativeSubagents.teammates.length > 0
    && effectiveRequires.supports_native_subagents === undefined
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
 * @param {Partial<RuntimeRunOptions>} callOptions
 * @param {import('../types.js').RuntimeEvent} event
 * @returns {void}
 */
function emit(callOptions, event) {
  try { callOptions.onEvent?.(event); } catch { /* swallow */ }
}
