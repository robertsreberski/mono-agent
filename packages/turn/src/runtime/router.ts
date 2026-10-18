import type { RuntimeHandoffProducerRequest } from "../contracts/native-storage.js";
import type { LiveInputEvent } from "./live-input-events.js";
import type { TurnToolOptions, RuntimeAttemptRunOptions, RuntimeAttemptResult, RuntimeAttempt, NativeDispatchBinding } from "../contracts/runtime.js";
import type { RuntimeEvent } from "../contracts/events.js";
import { assertNoRetiredRunOptions, RetiredRunOptionError } from "./retired-options.js";
import { DEFAULT_RUNTIME_RETRY_BACKOFF_MS, DEFAULT_RUNTIME_RETRY_MAX_BACKOFF_MS } from "./retry-defaults.js";
import { isDispatchProgress } from "../execution/pi/dispatch-progress.js";
import { snapshotNativeDispatchOptions, prepareNativeDispatchBinding } from "../execution/pi/prepared-dispatch.js";
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
//   Every attempt other than the primary's session-eligible first attempt runs
//   with a fresh provider attribution id, and its result (success or failure)
//   never carries providerSessionId or providerSessionRecovery: a stateless
//   retry/backup cannot synchronize or recover the primary provider session.
//   If every eligible retryable/auth entry in the chain fails, returns the last
//   result with `failureKind: "provider_unavailable_exhausted"`. Terminal
//   non-retryable failures are returned as-is with their failover history.
//   Tools are never re-run: once a failed attempt started a tool or consumed a
//   live input, no retry or backup runs. That failure is returned with a
//   `provider_failover_blocked` runtime warning naming the reason. The evidence
//   is re-checked immediately before every new attempt is admitted (after
//   backoff and after the route resolver). Evidence that arrives after another
//   attempt was admitted cannot be honoured, so a route runtime must settle its
//   tool events and live-input leases before its run() returns.

// @ts-check

import { randomUUID } from "node:crypto";
import { createRuntime } from "./create-runtime.js";
import { createCompactionUsage, withCompactionUsage, compactionCostEvent } from "../telemetry/compaction-usage.js";
import { fallbackContextFit } from "./context-fit.js";
import { resolvePiRuntimeModel } from "../providers/pi/models.js";
import { isProviderLocalToolSchemaFailure, isProviderAuthFailureText, retryableProviderFailureInfo } from "../telemetry/failure.js";
import { runtimeCapabilities } from "./capabilities.js";
import { buildTranscriptTailSnapshot, renderResumeSnapshot } from "../agent/transcript.js";
import { passthroughSandbox } from "../agent/sandbox-seam.js";
import { resolveRuntimeBrand } from "../runtime-brand.js";
import { createObserverHub } from "../telemetry/observer.js";
import { instrumentLiveInputAppliedEvents } from "./live-input-events.js";
import { createWebSearchRunState } from "../tools/web/web-search-state.js";

const ATTEMPT_SCOPED_OPTION_KEYS = ["customProvider", "customModel", "modelCapabilities", "isPrivateProvider"];
const ROUTER_TOOL_CONTEXT_KEYS = [
  "workspace", "repoRoot", "additionalReadRoots", "additionalWriteRoots",
  "ripgrepPath", "qaOutputDir", "sandboxPolicy", "sandboxEngine",
];
const RESOLVER_PROTECTED_OPTION_KEYS = new Set([
  "model", "effort", "messages", "abortSignal", "onEvent",
  "nativeSessionAuthority", "nativeSessionProjection", "sessionTurn", "onSessionTurnDetached", "detachedContext", "sessionRecovery", "sessionId", "providerSessionId", "providerAttributionSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs",
  "diagnosticsSeed", "systemPromptPrefix", "sandboxPolicy", "sandboxEngine", "sandbox",
  "allowedTools", "disallowedTools", "mcpServers", "mcpApps", "skills",
  "mcpCallNoTotalTimeoutTools",
  "webSearchState",
  "outputSchema", "liveInput", "toolEnvironment", "persistArtifact",
]);

class ResolverProtectedOptionError extends Error {
  constructor(key: string) {
    super(`route attempt resolver cannot override ${key}`);
    this.name = "ResolverProtectedOptionError";
  }
}

export function createRouterRuntime(options?: RouterOptions): AgentRuntimeInstance & {
    chain: () => Array<RouterChainEntry>;
};

export function createRouterRuntime(options: HostRouterOptions): HostRouterRuntime;

export function createRouterRuntime(options?: RouterOptions): AgentRuntimeInstance & {
    chain: () => Array<RouterChainEntry>;
};
export function createRouterRuntime({ host = {}, chain = [], resolveAttempt, retry, sessionTurnReconciliation }: HostRouterOptions = {}): HostRouterRuntime {
  const retryPolicy = normalizeRetryPolicy(retry);
  const entries = normaliseChain(chain);
  if (entries.length === 0) {
    throw new Error("createRouterRuntime requires a non-empty chain");
  }
  assertUniqueEntries(entries);
  const inner = createRuntime(host);
  let configuredTools: TurnToolOptions | undefined;
  // The router builds transcript-tail snapshots outside the inner runtime's
  // bridge call (which is where the per-instance toolContext lives), so resolve
  // the host brand here to stamp the snapshot schema id with the same brand the
  // inner runtime uses — createRuntime no longer publishes it to a process global.
  const runtimeBrand = resolveRuntimeBrand(host.runtimeBrand);

  // Single ordinary attempt engine. Prepared native dispatch never enters it.
  async function runAttemptLoop(systemPrompt: string, options: Partial<RuntimeAttemptRunOptions>, compactionUsage: any): Promise<RuntimeAttemptResult> {
      options = {
        ...options,
        webSearchState: createWebSearchRunState(options.webSearchConfig, options.webSearchState),
      };
      /**
       * Side-effect evidence of the latest admitted attempt.
       */
      let currentAttemptEffects: AttemptSideEffects | null = null;
      /**
       * Failed attempts followed by another.
       */
      const failedAttempts: { effects: AttemptSideEffects; model: RuntimeModelRef; result: RuntimeResult; }[] = [];
      const liveInputHub = options.liveInput === undefined
        ? undefined
        : createObserverHub({
            observers: [
              ...(Array.isArray(host.observers) ? host.observers : []),
              ...(Array.isArray(options.observers) ? options.observers : []),
            ],
            onEvent: options.onEvent as (event: object) => unknown,
          });
      if (options.liveInput !== undefined && liveInputHub !== undefined) {
        options = {
          ...options,
          liveInput: instrumentLiveInputAppliedEvents(options.liveInput, (event: LiveInputEvent) => {
            if (currentAttemptEffects !== null && isLiveInputTakenEvent(event)) currentAttemptEffects.liveInput = true;
            liveInputHub.emit(event);
          })!,
        };
      }
      try {
      const failoverHistory: { model: RuntimeModelRef; failureKind: (string | null); requestId?: (string | null); retryableSubkind?: (string | null); requirements?: ({ [x: string]: any;} | null); retryIndex?: number; }[] = [];
      let lastResult: RuntimeAttemptResult | null = null;
      let pendingDetach: { descriptor: any; model: RuntimeModelRef; attemptIndex: number; retryIndex: number; result: RuntimeResult; } | undefined;
      const markPendingDetach = (model: any, attemptIndex: any, retryIndex: any, result: any) => {
        if (options.sessionTurn?.reconciliation) pendingDetach = {
          descriptor: structuredClone(options.sessionTurn), model, attemptIndex, retryIndex, result,
        };
      };
      let detachedAcknowledged = false;
      let detachedMessages: readonly any[] | undefined;
      let lastRouteSkip: RuntimeAttemptResult | null = null;
      const promptBase = systemPrompt;
      let pendingSnapshot: any = null;
      let contextFailure = null;
      let lastToolSchemaTokens = 0;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
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
          if (i === 0) markPendingDetach(entry.model, i, 0, lastRouteSkip);
          // A settled user abort may have no provider failure. Preserve that
          // distinction in attempt evidence used by strict native-tail recovery.
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
        const entryOptionsBase: any = {
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

        /**
         * A failure that ends the whole logical run.
         */
        let terminalResult: RuntimeAttemptResult | null = null;

        for (let retryIndex = 0; retryIndex < entry.attempts; retryIndex += 1) {
          let callOptions: any = { ...entryCallBase };
          let attemptRuntime: RuntimeAttempt = inner;
          let attemptCleanup: (() => (void | Promise<void>)) | undefined;
          // Strip ownership before private resolution: detached retries/backups
          // may select their own native root but never inherit primary authority.
          const sessionEligibleAttempt = i === 0 && retryIndex === 0 && entrySupportsSessionResume(entry);
          if (!sessionEligibleAttempt) {
            delete callOptions.nativeSessionAuthority;
            delete callOptions.nativeSessionProjection;
            delete callOptions.sessionTurn;
            delete callOptions.sessionRecovery;
            delete callOptions.sessionId;
            delete callOptions.providerSessionId;
            delete callOptions.sessionKeepAlive;
            delete callOptions.sessionIdleTimeoutMs;
          }
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
            if (error instanceof RetiredRunOptionError) throw error;
            const failure = attemptResolutionFailureResult(error);
            lastResult = failure;
            if (i === 0 && retryIndex === 0) markPendingDetach(entry.model, i, retryIndex, failure);
            failoverHistory.push({
              model: entry.model,
              failureKind: failure.failureKind || null,
            });
            // A resolver fault is a config/credential problem, not a transient
            // provider blip: retrying the same route cannot fix it. Advance.
            break;
          }

          // Recheck late effects and cancellation after each awaited boundary.
          // Admission itself is synchronous: no await may follow its final check.
          const admitAttempt = () => {
            const failed = failedAttempts.find((attempt: { effects: AttemptSideEffects; model: RuntimeModelRef; result: RuntimeResult; }) => sideEffectReason(attempt.effects) !== null);
            const reason = failed === undefined ? null : sideEffectReason(failed.effects);
            if (failed !== undefined && reason !== null) {
              const blocked = failoverBlockedResult(failed.result, modelKey(failed.model), reason);
              emit(callOptions, { type: "runtime_warning", ...blocked.warning });
              return { ...normalizeAttemptResult(blocked.result, !detachedAcknowledged), failoverHistory };
            }
            if (!sessionEligibleAttempt && callOptions.abortSignal?.aborted) {
              return { ...normalizeAttemptResult(lastResult || lastRouteSkip || { text: null, events: [], cancelled: true }, !detachedAcknowledged), cancelled: true, failoverHistory };
            }
          };
          // No yield on acceptance: the final fence must reach run synchronously.
          const checkedAdmission = () => {
            const admission = admitAttempt();
            if (admission) return (async () => {
              try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
              return admission;
            })();
          };
          let admission = checkedAdmission();
          if (admission) return admission;

          applyEntryEffort(callOptions, entry.effort);
          // Only the primary's first attempt may own a provider session. Retries
          // replay the logical turn and must not resume a transcript the failed
          // attempt may have appended to; backup routes never inherit that session.
          if (!sessionEligibleAttempt) {
            // A stateless attempt must not present itself as the primary's
            // session (session id, OpenCode x-opencode-session header).
            callOptions.providerAttributionSessionId = randomUUID();
          }
          if (i === 0 && retryIndex === 0 && !sessionEligibleAttempt) markPendingDetach(entry.model, i, retryIndex,
            { text: null, error: "Primary route cannot own the protected native session", failureKind: "skipped_capability_mismatch", events: [], cancelled: false, usage: {} });
          delete callOptions.onSessionTurnDetached;
          delete callOptions.detachedContext;
          if (pendingDetach && !sessionEligibleAttempt) {
            const detachment = pendingDetach;
            try {
              if (typeof options.onSessionTurnDetached !== "function") throw new Error("Detached native turn acknowledgement unavailable");
              await options.onSessionTurnDetached(pendingDetach);
              pendingDetach = undefined;
              detachedAcknowledged = true;
            } catch {
              try { await attemptCleanup?.(); } catch { /* retain native evidence */ }
              return { ...normalizeAttemptResult(lastResult || lastRouteSkip || detachment.result, false), error: "Protected native turn could not be durably detached", failureKind: "safety_session_turn_reconciliation",
                retryable: false, failoverHistory };
            }
          }
          admission = checkedAdmission();
          if (admission) return admission;

          // Host replay is private, lazy and shared across detached attempts.
          // Replace the prior prefix, rather than doubling cold-turn history.
          if (!sessionEligibleAttempt && !callOptions.abortSignal?.aborted && typeof options.detachedContext === "function") {
            try {
              if (detachedMessages === undefined) {
                const replay = structuredClone(await options.detachedContext());
                if (!Array.isArray(replay)) throw new Error("Invalid detached replay");
                detachedMessages = freezeDetachedContext(replay);
              }
            } catch {
              try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
              if (callOptions.abortSignal?.aborted) return {
                ...normalizeAttemptResult(lastResult || lastRouteSkip || { text: null, events: [] }, !detachedAcknowledged), cancelled: true, failoverHistory,
              };
              const warning = { warning_kind: "detached_context_unavailable", source: "router",
                message: "Conversation history unavailable; no retry or backup model was started." };
              const failure = normalizeAttemptResult(lastResult || lastRouteSkip || { error: "Conversation history unavailable", failureKind: "provider_unavailable", events: [] }, !detachedAcknowledged);
              emit(callOptions, { type: "runtime_warning", ...warning });
              // Opaque host warnings already pass through as iterables; narrowing would change failure behavior.
              return { ...failure, runtimeWarnings: [... ((failure.runtimeWarnings || []) as readonly unknown[]), warning], failoverHistory };
            }
            callOptions.messages = [...detachedMessages, ...options.messages!.slice(-1)];
          }
          admission = checkedAdmission();
          if (admission) return admission;
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

          if (contextFailure && i > 0) {
            const fit = fallbackContextFit(entry.model, callOptions, attemptSystemPrompt, lastToolSchemaTokens);
            if (fit && !fit.fits) {
              const warning = { warning_kind: "fallback_context_window_skipped", source: "router",
                model: modelKey(entry.model), ...fit, message: "Fallback context window cannot hold the estimated request." };
              emit(callOptions, { type: "runtime_warning", ...warning });
              failoverHistory.push({ model: entry.model, failureKind: "skipped_context_window", retryableSubkind: "context_limit", ...fit });
              try { await attemptCleanup?.(); } catch { /* skipped route cleanup is additive */ }
              break;
            }
          }

          // A same-model retry is not a failover: only the first attempt of a new
          // route announces a transition.
          if (retryIndex === 0 && failoverHistory.length > 0) {
            const previous = failoverHistory[failoverHistory.length - 1];
            emit(callOptions, {
              type: "provider_failover_started",
              from: modelKey(previous?.model!),
              to: modelKey(entry.model),
              attemptIndex: i,
              // Why the route changed, in the same vocabulary provider_retry_started
              // uses. Operators reading a transcript need the cause next to the
              // transition, not only in the run artifact's failoverHistory.
              reason: previous?.retryableSubkind || previous?.failureKind || null,
            });
          }

          const attemptEffects: AttemptSideEffects = { tool: false, liveInput: false };
          currentAttemptEffects = attemptEffects;
          const hostOnEvent = callOptions.onEvent;
          callOptions.onEvent = (event: RuntimeEvent) => {
            if (isToolActivityEvent(event)) attemptEffects.tool = true;
            hostOnEvent?.(event);
          };

          let result;
          try {
            result = await attemptRuntime.run(attemptSystemPrompt, callOptions);
          } catch (err: any) {
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
              ...(isDispatchProgress(err?.dispatchProgress) ? { dispatchProgress: err.dispatchProgress } : {}),
            };
          } finally {
            try { await attemptCleanup?.(); } catch { /* cleanup is additive */ }
          }

          compactionUsage.add(result.usage?.compaction?.requests);
          for (const event of result.events || []) compactionUsage.observe(event);
          result = normalizeAttemptResult(result, sessionEligibleAttempt);
          if (Array.isArray(result.events) && result.events.some(isToolActivityEvent)) attemptEffects.tool = true;
          if (isDispatchProgress(result.dispatchProgress)) {
            if (result.dispatchProgress.toolAdmitted) attemptEffects.tool = true;
            if (result.dispatchProgress.liveInputTaken) attemptEffects.liveInput = true;
          }

          const retryability = retryableProviderFailureInfo({
            errorText: result.error || "",
            stderrTail: result.stderrTail || "",
            failureKind: result.failureKind!,
          });

          let routeApi = callOptions.piResolvedModel?.api;
          if (!routeApi) { try { routeApi = resolvePiRuntimeModel(entry.model, callOptions).model.api; } catch { /* unknown route metadata */ } }
          const providerSchemaFailure = isProviderLocalToolSchemaFailure(result.error || "", routeApi);
          if (providerSchemaFailure) retryability.subkind = "provider_tool_schema_incompatible";
          if (result.failureKind === "context_limit") {
            contextFailure = result;
            lastToolSchemaTokens = Number(result.diagnostics?.context_tool_schema_tokens) || 0;
          }

          const successful = !result.error && !result.failureKind && !result.cancelled;
          if (successful) {
            // Only a genuine route change is a completed failover: succeeding
            // after a same-model retry must not render as "answered by X
            // (failover)" when X is still the route the operator asked for.
            if (failoverHistory.some((attempt: { model: RuntimeModelRef; failureKind: (string | null); requestId?: (string | null | undefined); retryableSubkind?: (string | null); requirements?: ({ [x: string]: any;} | null); retryIndex?: number; }) => modelKey(attempt.model) !== modelKey(entry.model))) {
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
            failureKind: result.cancelled && !result.failureKind ? "cancelled" : (result.failureKind || null),
            requestId: retryability.requestId,
            retryableSubkind: retryability.subkind,
            ...(retryIndex > 0 ? { retryIndex } : {}),
          });
          if (result.failureKind === "skipped_capability_mismatch") {
            const blockedReason = sideEffectReason(attemptEffects);
            if (blockedReason !== null && entries.slice(i + 1).some((next: RouterChainEntry) => entrySatisfiesRequirements(next, options))) {
              const blocked = failoverBlockedResult(result, modelKey(entry.model), blockedReason);
              emit(callOptions, { type: "runtime_warning", ...blocked.warning });
              terminalResult = blocked.result;
              break;
            }
            failedAttempts.push({ effects: attemptEffects, model: entry.model, result });
            lastRouteSkip = result;
            if (sessionEligibleAttempt) markPendingDetach(entry.model, i, retryIndex, result);
            // A bridge-level mismatch is about this route, not the logical run.
            // Try the next entry and do not derive a transcript snapshot from it.
            break;
          }
          lastResult = result;

          // Provider auth is terminal for one provider, but chain-retryable: a
          // fallback provider may have working credentials. Other non-retryable
          // provider/request errors remain terminal.
          const shouldFallback = (retryability.retryable || result.failureKind === "provider_auth" || providerSchemaFailure)
            && !result.cancelled
            && !isMidTurnSafetyFailure(result.failureKind);
          if (!shouldFallback) {
            terminalResult = result;
            break;
          }
          if (sessionEligibleAttempt) markPendingDetach(entry.model, i, retryIndex, result);

          // context_limit is forced retryable so the chain can reach a model with
          // a bigger window, but it is deterministic against the SAME window:
          // another attempt here is a guaranteed second failure. Advance instead.
          const sameModelRetryable = retryability.retryable && !providerSchemaFailure
            && retryability.subkind !== "context_limit"
            && retryability.subkind !== "subscription_limit"
            && retryIndex + 1 < entry.attempts;

          // Tools are never re-run. Another attempt replays the logical turn, so
          // once this attempt started a tool or consumed a live input, neither a
          // same-model retry nor a backup may run: end with this failure.
          const blockedReason = sideEffectReason(attemptEffects);
          if (blockedReason !== null && (sameModelRetryable
            || entries.slice(i + 1).some((next: RouterChainEntry) => entrySatisfiesRequirements(next, options)))) {
            const blocked = failoverBlockedResult(result, modelKey(entry.model), blockedReason);
            emit(callOptions, { type: "runtime_warning", ...blocked.warning });
            terminalResult = blocked.result;
            break;
          }
          failedAttempts.push({ effects: attemptEffects, model: entry.model, result });

          // Build a transcript-tail snapshot from this run's events so the next
          // attempt — same model or next route — can continue. A run that
          // produced no usable events yields a falsy snapshot and merges to a
          // no-op, so the common "died before the first token" retry costs
          // nothing. Keep one bounded snapshot object across the logical run
          // instead of nesting a new <resume_context> block per transition.
          pendingSnapshot = mergeResumeSnapshots(
            pendingSnapshot,
            buildTranscriptTailSnapshot(result.events!, { runtimeBrand }),
          );

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
        failureKind: contextFailure && lastResult === contextFailure ? "context_limit" : lastResult ? "provider_unavailable_exhausted" : exhaustedResult.failureKind!,
        failoverHistory,
      };
      } finally {
        await liveInputHub?.flush();
      }
  }

  return {
    /**
     * @param [options] Optional so a bare `{}` call
     *   is legal; the router always overrides `model` per chain entry (see
     *   AgentRuntimeInstance.run for the public, model-required contract).
     */
    async run(systemPrompt: string, options: Partial<RuntimeAttemptRunOptions> = {}): Promise<RuntimeAttemptResult> {
      if (Object.hasOwn(options, "piSessionsRoot")) throw new TypeError("piSessionsRoot was renamed to sessionsRoot; use sessionsRoot instead");
      assertNoRetiredRunOptions(options);
      if (options.manualCompaction === true) {
        // A provider session belongs to exactly one route. Never retry/fail over
        // a mutating manual operation against a different model or session.
        const primary = entries[0];
        if (!primary || !entrySupportsSessionResume(primary)
          || (options.model && modelKey(options.model) !== modelKey(primary.model))) {
          throw new Error("Manual compaction is unavailable for this session model.");
        }
        let attemptOptions: any = { ...options, model: primary.model };
        delete attemptOptions.detachedContext;
          let attemptRuntime: RuntimeAttempt = inner;
        let cleanup;
        try {
          const resolution = normalizeAttemptResolution(await resolveAttempt?.({
            model: primary.model, attemptIndex: 0, retryIndex: 0,
          }));
          cleanup = resolution?.cleanup;
          if (resolution) {
            attemptOptions = ((mergeAttemptOptions(attemptOptions, resolution.options)) as any);
            attemptOptions = ((mergeAttemptPolicyOptions(attemptOptions, resolution.policyOptions)) as any);
            if (resolution.runtime) {
              assertRuntimeLike(resolution.runtime);
              attemptRuntime = resolution.runtime;
              projectPiRuntimeToolContext(attemptRuntime, effectiveRouterToolOptions(host, configuredTools));
            }
          }
          applyEntryEffort(attemptOptions, primary.effort);
          return await attemptRuntime.run(systemPrompt, attemptOptions);
        } finally {
          await cleanup?.();
        }
      }
      const routeWarnings: import("../contracts/events.js").RuntimeEvent[] = [];
      const compactionUsage = createCompactionUsage();
      let result = await runAttemptLoop(systemPrompt, { ...options, onEvent: (event: RuntimeEvent) => {
        compactionUsage.observe(event);
        if (event.type === "runtime_warning" && event.warning_kind === "fallback_context_window_skipped") routeWarnings.push(event);
        options.onEvent?.(event);
      } }, compactionUsage);
      result = withCompactionUsage(result, compactionUsage);
      if (result.usage?.compaction) {
        const event = compactionCostEvent(result);
        options.onEvent?.(event);
        result.events = [...(result.events || []), event];
      }
      return routeWarnings.length ? { ...result, runtimeWarnings: [... ((result.runtimeWarnings || []) as any[]), ...routeWarnings] } : result;
    },
    // Preparation is a primary-only single attempt, never a routed retry or
    // backup. A custom resolver must explicitly certify native ownership.
    async prepareNativeDispatch(systemPrompt: string, options: RuntimeAttemptRunOptions) {
      if (Object.hasOwn(options, "piSessionsRoot")) throw new TypeError("piSessionsRoot was renamed to sessionsRoot; use sessionsRoot instead");
      assertNoRetiredRunOptions(options);
      const primary = entries[0];
      if (resolveAttempt !== undefined && sessionTurnReconciliation !== "v1"
        || !primary || modelKey(options.model) !== modelKey(primary.model)
        || !entrySupportsSessionResume(primary) || !entrySatisfiesRequirements(primary, options)) {
        throw new Error("Router primary does not support native prepared dispatch");
      }
      let callOptions = snapshotNativeDispatchOptions({ ...options, model: primary.model });
      let attemptRuntime: RuntimeAttempt = inner;
      const capturedTools = snapshotNativeDispatchOptions(effectiveRouterToolOptions(host, configuredTools));
 let cleanup: (() => (void | Promise<void>)) | undefined;
      let cleaned = false;
      const release = async () => { if (!cleaned) { cleaned = true; await cleanup?.(); } };
      try {
        const resolution = normalizeAttemptResolution(await resolveAttempt?.({ model: primary.model, attemptIndex: 0, retryIndex: 0 }));
        cleanup = resolution?.cleanup;
        callOptions = mergeAttemptPolicyOptions(mergeAttemptOptions(callOptions, resolution?.options), resolution?.policyOptions);
        applyEntryEffort(callOptions, primary.effort);
        if (resolution?.runtime) {
          assertRuntimeLike(resolution.runtime); attemptRuntime = resolution.runtime;
          projectPiRuntimeToolContext(attemptRuntime, capturedTools);
        }
        if (!attemptRuntime.prepareNativeDispatch) throw new Error("Native prepared dispatch unavailable");
        const lease = await attemptRuntime.prepareNativeDispatch(systemPrompt, callOptions);
        let available = true, producing = false;
        return { snapshot: lease.snapshot,
          ...(lease.assertReady ? { assertReady: () => { if (!available || producing) throw new Error("Prepared dispatch is no longer available"); lease.assertReady!(); } } : {}),
          ...(lease.checkHandoffSummary ? { checkHandoffSummary: (input: RuntimeHandoffProducerRequest) => { if (!available) throw new Error("Prepared dispatch is no longer available"); return lease.checkHandoffSummary!(input); } } : {}),
          ...(lease.produceHandoffSummary ? { produceHandoffSummary: async (input: RuntimeHandoffProducerRequest) => { if (!available || producing) throw new Error("Prepared producer is no longer available"); const captured = structuredClone(input); producing = true; try { return await lease.produceHandoffSummary!(captured); } finally { producing = false; } } } : {}),
          run: async (input: NativeDispatchBinding) => {
            if (!available) throw new Error("Prepared dispatch is no longer available");
            if (producing) throw new Error("Prepared handoff producer is still running");
            const binding = prepareNativeDispatchBinding(input); // Rejection does not consume either lease.
            available = false;
            try {
              const result = normalizeProviderAuthFailure(await lease.run(binding));
              const retryability = retryableProviderFailureInfo({ errorText: result.error || "", stderrTail: result.stderrTail || "", failureKind: result.failureKind! });
              return { ...result, failoverHistory: result.error || result.failureKind || result.cancelled ? [{ model: primary.model,
                failureKind: result.cancelled && !result.failureKind ? "cancelled" : (result.failureKind || null),
                requestId: retryability.requestId, retryableSubkind: retryability.subkind }] : [] };
            } finally { try { await lease.close(); } finally { await release(); } }
          },
          close: async () => { available = false; try { await lease.close(); } finally { await release(); } } };
      } catch (error) { await release(); throw error; }
    },
    chain: () => entries.slice(),
    configureTools(next: TurnToolOptions = {}) {
      configuredTools = { ...(configuredTools || {}), ...next };
      inner.configureTools?.(next);
    },
    sessionTurnReconciliation: resolveAttempt === undefined ? inner.sessionTurnReconciliation! : sessionTurnReconciliation!,
    async reconcileSessionTurn(request: { sessionsRoot: string; descriptor: any; purpose: "execution" | "compaction"; expectedModel: { provider: string; id: string; api?: string; }; expectedInputs: ReadonlyArray<{ id: string; requestDigest: string; placement: "initial" | "live"; }>; expectedBaseTip?: string | null; }) {
      if (!inner.reconcileSessionTurn) throw new Error("Native turn reconciliation unavailable");
      return inner.reconcileSessionTurn(request);
    },
    async recoverSession(receipt: { runId: string; revision: number; providerSessionId: string; modelKey: string; tipId: string; }, context: { appliedInputIds: readonly string[]; }) {
      return await inner.recoverSession?.(receipt, context) === true;
    },
    async syncSession(providerSessionId: string) {
      return Boolean(await inner.syncSession?.(providerSessionId));
    },
    async refreshSession(providerSessionId: string) {
      if (typeof inner.refreshSession !== "function") {
        throw new Error("A routed runtime cannot guarantee a cold provider-session reopen");
      }
      await inner.refreshSession(providerSessionId);
    },
    async salvageDurableSession(providerSessionId: string, sessionsRoot: string) {
      if (typeof inner.salvageDurableSession !== "function") throw new Error("Durable session salvage unavailable");
      return inner.salvageDurableSession(providerSessionId, sessionsRoot);
    },
    async retireDurableSession(providerSessionId: string, sessionsRoot: string, deletionOptions?: { hostAuthority: { version: 1; rootId: string; authorityId: string; ownerKey: string; historyBucket: string; }; disposition: "C" | "D"; assertOwned: () => Promise<void>; }) {
      if (typeof inner.retireDurableSession !== "function") {
        throw new Error("A routed runtime cannot retire durable provider-session state");
      }
      return deletionOptions === undefined ? inner.retireDurableSession(providerSessionId, sessionsRoot)
        : inner.retireDurableSession(providerSessionId, sessionsRoot, deletionOptions);
    },
    async disposeSession(providerSessionId: string) {
      return Boolean(await inner.disposeSession?.(providerSessionId));
    },
    async invalidateSession(providerSessionId: string) {
      return Boolean(await inner.invalidateSession?.(providerSessionId));
    },
    async disposeAllSessions() {
      await inner.disposeAllSessions?.();
    },
  };
}

/**
 * @param chain ReadonlyArray<RuntimeModelRef|RouterChainEntryInput>, loosened
 *   here because distinguishing the two shapes is a runtime duck-type check,
 *   not something a union type narrows cleanly.
 */
function normaliseChain(chain: readonly any[]): RouterChainEntry[] {
  if (!Array.isArray(chain)) return [];
  return ((chain
    .map((entry: any) => {
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
    .filter(Boolean)) as RouterChainEntry[]);
}

/**
 * The kernel default is ONE attempt per entry. Enabling same-model retries is a
 * host policy decision (`@mono-agent/config` supplies the product default), so
 * the router stays mechanism and existing callers keep single-shot behavior.
 */
function normalizeChainAttempts(attempts: any): number {
  if (attempts === undefined || attempts === null) return 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("createRouterRuntime chain attempts must be an integer between 1 and 10");
  }
  return attempts;
}

function normalizeRetryPolicy(retry: Partial<RouterRetryPolicy> | undefined): RouterRetryPolicy {
  const backoffMs = normalizeRetryDelay(retry?.backoffMs, DEFAULT_RUNTIME_RETRY_BACKOFF_MS, "backoffMs");
  const maxBackoffMs = normalizeRetryDelay(retry?.maxBackoffMs, DEFAULT_RUNTIME_RETRY_MAX_BACKOFF_MS, "maxBackoffMs");
  return { backoffMs, maxBackoffMs };
}

function normalizeRetryDelay(value: any, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`createRouterRuntime retry.${name} must be a non-negative finite number`);
  }
  return value;
}

/**
 * Abortable sleep. agent-runtime is the kernel and cannot reach the app-layer
 * backoff helpers, so this mirrors the local `delay` in the codex bridge.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve: (value: void | PromiseLike<void>) => void) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
 ((timer) as any).unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}

function normalizeChainEffort(effort: any): string | null | undefined {
  if (effort === undefined || effort === null) return effort;
  if (typeof effort !== "string" || effort.length === 0 || effort.trim() !== effort) {
    throw new Error("createRouterRuntime chain effort must be a non-empty trimmed string, null, or omitted");
  }
  return effort;
}

function assertUniqueEntries(entries: RouterChainEntry[]) {
  const seen = new Map();
  entries.forEach((entry: RouterChainEntry, index: number) => {
    const key = modelKey(entry.model);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(`createRouterRuntime duplicate model ${key} at chain entries ${first} and ${index}`);
    }
    seen.set(key, index);
  });
}

function modelKey(model: RuntimeModelRef) {
  return model.reference;
}

/**
 * Resolve the router-owned base ToolContext exactly as createRuntime(host)
 * followed by the router's configureTools calls would. Every data key is
 * present so projecting into a resolver-supplied runtime also clears hidden
 * state. RuntimeSandbox is special: configureTools intentionally ignores an
 * undefined implementation, so the configured value only replaces the host
 * seam when it is concrete.
 */
function effectiveRouterToolOptions(host: TurnHostOptions, configuredTools: TurnToolOptions | undefined): TurnToolOptions {
  const effective: { [x: string]: any; } = {};
  for (const key of ROUTER_TOOL_CONTEXT_KEYS) {
    effective[key] = configuredTools !== undefined && Object.hasOwn(configuredTools, key)
      ? configuredTools[key as keyof TurnToolOptions]
      : host[key as keyof TurnHostOptions];
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
 */
function projectPiRuntimeToolContext(runtime: RuntimeAttempt, toolOptions: TurnToolOptions) {
  if (typeof runtime.configureTools !== "function") {
    throw new Error("route attempt runtime must expose configureTools() for tool-context projection");
  }
  runtime.configureTools(toolOptions);
}

function normalizeAttemptResolution(value: HostRouterAttemptResolution | undefined) {
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

const ATTEMPT_POLICY_OPTION_KEYS = new Set(["allowedTools", "disallowedTools"]);

function normalizeAttemptPolicyOptions(value: any) {
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
  return value;
}

/**
 * Removes credentials and model metadata belonging to the previous route,
 * then applies the current route's private options. Logical request, safety,
 * effort, and session fields remain router-owned.
 */
function mergeAttemptOptions(base: { [x: string]: any; }, resolved: { [x: string]: any; } | undefined) {
  if (resolved !== undefined) assertNoRetiredRunOptions(resolved);
  const merged = withoutAttemptScopedOptions(base);
  if (resolved === undefined) return merged;
  for (const [key, value] of Object.entries(resolved)) {
    if (RESOLVER_PROTECTED_OPTION_KEYS.has(key) || key === "sessionsRoot" && base.nativeSessionAuthority !== undefined) {
      throw new ResolverProtectedOptionError(key);
    }
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeAttemptPolicyOptions(base: any, policyOptions: any) {
  if (policyOptions === undefined) return base;
  const merged = { ...base };
  for (const key of ATTEMPT_POLICY_OPTION_KEYS) {
    if (!Object.hasOwn(policyOptions, key)) continue;
    if (policyOptions[key] === undefined) delete merged[key];
    else merged[key] = policyOptions[key];
  }
  return merged;
}

function withoutAttemptScopedOptions(options: { [x: string]: any; }): { [x: string]: any; } {
  const projected = { ...options };
  for (const key of ATTEMPT_SCOPED_OPTION_KEYS) delete projected[key];
  return projected;
}

function assertRuntimeLike(runtime: RuntimeAttempt) {
  if (runtime === null || typeof runtime !== "object" || typeof runtime.run !== "function") {
    throw new Error("route attempt resolver runtime must expose run()");
  }
}

function applyEntryEffort(options: { [x: string]: any; }, effort: string | null | undefined) {
  if (effort === null) {
    delete options.effort;
  } else if (typeof effort === "string") {
    options.effort = effort;
  }
}

function attemptResolutionFailureResult(error: unknown): RuntimeAttemptResult {
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

/**
 * Normalized tool activity: a started/admitted tool call (`tool_use`, Pi's raw
 * `tool_execution_start`) or its result. Pi emits its `tool_use` block only
 * when execution starts, so a model that merely requested a tool before the
 * provider failed does not count.
 */
function isToolActivityEvent(event: any): boolean {
  if (!event || typeof event !== "object") return false;
  const type = event.type;
  if (type === "tool_use" || type === "tool_result" || type === "tool_execution_start") return true;
  if ((type !== "assistant" && type !== "user") || !Array.isArray(event.message?.content)) return false;
  return event.message.content.some((block: any) => block?.type === "tool_use" || block?.type === "tool_result");
}

const LIVE_INPUT_TAKEN_EVENTS = new Set([
  "live_input_consumed", "live_input_applied", "live_input_uncertain", "live_input_settlement_unconfirmed",
]);

/**
 * Event evidence for consumed/uncertain live input on marker-less runtimes.
 * Their removed, unconsumed inputs remain mailbox-replay-safe. Real Pi also
 * gates on liveInputTaken at iterator yield, even if native later removes it;
 * only never-yielded inputs can reach another Pi attempt.
 */
function isLiveInputTakenEvent(event: any): boolean {
  return typeof event?.type === "string" && LIVE_INPUT_TAKEN_EVENTS.has(event.type);
}

function sideEffectReason(effects: AttemptSideEffects): "tool_already_executed" | "live_input_consumed" | null {
  if (effects.tool) return "tool_already_executed";
  return effects.liveInput ? "live_input_consumed" : null;
}

/**
 * End the logical run with the failed attempt's own result plus a warning.
 */
function failoverBlockedResult(result: RuntimeAttemptResult, model: string, reason: "tool_already_executed" | "live_input_consumed") {
  const effect = reason === "tool_already_executed" ? "a tool already ran" : "a live input was already consumed";
  const warning = {
    warning_kind: "provider_failover_blocked",
    source: "router",
    reason,
    model,
    message: `${model} failed after ${effect}; no retry or backup model was started so nothing runs twice (${reason}).`,
  };
  return {
    warning,
    result: {
      ...result,
      runtimeWarnings: [...(Array.isArray(result.runtimeWarnings) ? result.runtimeWarnings : []), warning],
    },
  };
}

function isMidTurnSafetyFailure(failureKind: string | null | undefined) {
  return typeof failureKind === "string"
    && (failureKind.startsWith("sandbox_") || failureKind.startsWith("safety_"));
}

/**
 * Merge progress into one bounded snapshot so prompts never accumulate nested
 * resume blocks across a long provider chain.
 */
function mergeResumeSnapshots(previous: any, next: any) {
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
  ].map((entry: any) => String(entry?.summary ?? "").slice(0, 320)).filter(Boolean);
  const droppedSummaries = dropped.map(summarizeSnapshotTurn);
  const summaries = [...existingSummaries, ...droppedSummaries].slice(-9);
  const turnCount = Math.max(
    turns.length + summaries.length,
    Number(previous.turn_count || 0) + Number(next.turn_count || 0),
  );
  return {
    ...next,
    turn_count: turnCount,
    earlier_turn_summaries: summaries.map((summary: string, index: number) => ({
      turn_index: Math.max(1, turnCount - turns.length - summaries.length + index + 1),
      summary,
    })),
    turns,
  };
}

function summarizeSnapshotTurn(turn: any) {
  const assistant = typeof turn?.assistant_text === "string" ? turn.assistant_text.trim() : "";
  const tools = Array.isArray(turn?.tool_uses)
    ? turn.tool_uses.map((tool: any) => tool?.name).filter(Boolean).slice(0, 5)
    : [];
  const pieces: string[] = [];
  if (assistant) pieces.push(assistant.split(/\r?\n/u)[0]!.slice(0, 220));
  if (tools.length > 0) pieces.push(`tools: ${tools.join(", ")}`);
  return (pieces.join("; ") || "provider attempt made progress").slice(0, 320);
}

function entrySatisfiesRequirements(entry: RouterChainEntry, options: Partial<RuntimeAttemptRunOptions>): boolean {
  const requires = entry.requires;
  // Synthesize effective requirements: merge the entry's own `requires` with
  // requirements inferred from per-run options, so a chain entry that carries
  // no explicit `requires` (the host integration paths cannot carry
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
    caps = runtimeCapabilities();
  } catch {
    return false;
  }
  for (const [key, expected] of Object.entries(effectiveRequires)) {
    if (caps[key as keyof typeof caps] !== expected) return false;
  }
  return true;
}

/**
 * Session identifiers belong to the route that created them. Never forward one
 * into a route whose capabilities declare no resume support, including when
 * that route is reached through fallback. Unknown model references retain the
 * existing fail-later behavior.
 */
function entrySupportsSessionResume(entry: RouterChainEntry): boolean {
  try {
    return runtimeCapabilities().supports_session_resume === true;
  } catch {
    return true;
  }
}

function emit(callOptions: Partial<RuntimeAttemptRunOptions>, event: RuntimeEvent): void {
  try { callOptions.onEvent?.(event); } catch { /* swallow */ }
}

function normalizeProviderAuthFailure(result: RuntimeAttemptResult): RuntimeAttemptResult {
  if (result.cancelled) return result;
  const failureKind = result.failureKind || null;
  if (failureKind && failureKind !== "provider_unavailable") return result;
  const haystack = `${result.error || ""}\n${result.stderrTail || ""}`;
  if (!isProviderAuthFailureText(haystack)) return result;
  return { ...result, failureKind: "provider_auth" };
}

/**
 * Normalize every attempt result, including a failed detach acknowledgement.
 * Stateless attempts must never synchronize or recover the primary session.
 */
function normalizeAttemptResult(result: RuntimeAttemptResult, sessionEligibleAttempt: boolean): RuntimeAttemptResult {
  const normalized = normalizeProviderAuthFailure(result);
  if (sessionEligibleAttempt) return normalized;
  const { providerSessionRecovery: _receipt, providerSessionId: _sessionId, ...unownedResult } = normalized;
  return unownedResult;
}

/**
 * Freeze the private replay snapshot, including nested attachment data.
 */
function freezeDetachedContext<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDetachedContext);
    Object.freeze(value);
  }
  return value;
}

export type RouterOptions = {
    host?: TurnHostOptions;
    chain?: ReadonlyArray<RuntimeModelRef | RouterChainEntryInput>;
    resolveAttempt?: (input: {
        model: RuntimeModelRef;
        attemptIndex: number;
        retryIndex: number;
    }) => (RouterAttemptResolution | Promise<RouterAttemptResolution>);
    /**
     * Backoff shape for same-model
     * retries. Per-route retry counts live on each chain entry's `attempts`.
     */
    retry?: Partial<RouterRetryPolicy>;
    /**
     * Explicit ownership assertion for a custom resolver that preserves the native owner.
     */
    sessionTurnReconciliation?: "v1";
};
export type HostRouterAttemptResolution = Omit<RouterAttemptResolution, "runtime"> & {
    runtime?: import("../contracts/runtime.js").RuntimeAttempt;
};
export type HostRouterOptions = Omit<RouterOptions, "resolveAttempt"> & {
    resolveAttempt?: (input: {
        model: RuntimeModelRef;
        attemptIndex: number;
        retryIndex: number;
    }) => (HostRouterAttemptResolution | undefined | Promise<HostRouterAttemptResolution | undefined>);
};
export type HostRouterRuntime = Omit<AgentRuntimeInstance, "run" | "prepareNativeDispatch"> & {
    run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult>;
    prepareNativeDispatch?(systemPrompt: string, options: RuntimeRunOptions): Promise<import("../contracts/runtime.js").RuntimeAttemptPreparedDispatch>;
    chain(): Array<RouterChainEntry>;
};
/**
 * Evidence that one attempt had effects another attempt would repeat.
 */
export type AttemptSideEffects = {
    tool: boolean;
    liveInput: boolean;
};
export type RuntimeModelRef = import("../contracts/model.js").RuntimeModelRef;
export type TurnHostOptions = import("../contracts/runtime.js").TurnHostOptions;
export type AgentRuntimeInstance = import("../contracts/runtime.js").AgentRuntimeInstance;
export type RuntimeRunOptions = import("../contracts/runtime.js").RuntimeAttemptRunOptions;
export type RuntimeResult = import("../contracts/runtime.js").RuntimeAttemptResult;
/**
 * A chain entry as accepted by createRouterRuntime: either the shorthand bare
 * RuntimeModelRef, or the full `{model, effort?, requires?, attempts?}` form.
 */
export type RouterChainEntryInput = {
    model: RuntimeModelRef;
    effort?: string | null;
    requires?: {
        [x: string]: any;
    };
    attempts?: number;
};
export type RouterChainEntry = {
    model: RuntimeModelRef;
    effort: string | null | undefined;
    requires: {
        [x: string]: any;
    } | null;
    /**
     * Total attempts on this route including the first.
     */
    attempts: number;
};
export type RouterRetryPolicy = {
    /**
     * Delay before the first retry; doubles per retry.
     */
    backoffMs: number;
    /**
     * Ceiling for the doubled delay.
     */
    maxBackoffMs: number;
};
/**
 * Private host seam for route-specific provider options/runtime ownership.
 * Returned options are never copied into router telemetry.
 */
export type RouterAttemptResolution = {
    /**
     * Must emit its tool events and
     * settle every live-input lease before run() returns: the router re-checks a
     * failed attempt's side effects only until it admits the next attempt.
     */
    runtime?: AgentRuntimeInstance;
    options?: {
        [x: string]: any;
    };
    /**
     * Provider-specific projection of the logical tool policy. This deliberately
     * cannot replace any other protected request field.
     */
    policyOptions?: {
        allowedTools?: ReadonlyArray<string>;
        disallowedTools?: ReadonlyArray<string>;
    };
    cleanup?: () => (void | Promise<void>);
};
