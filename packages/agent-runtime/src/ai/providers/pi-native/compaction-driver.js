// @ts-check
// Context auto-compaction for the pi-native bridge.
//
// AUTO-COMPACTION. pi-agent-core performs NO automatic in-loop compaction
// (shouldCompact/compact are exported helpers its loop never calls), so this
// bridge drives it: proactively before a turn when the running model's context
// is near the window, and reactively (compact + single re-prompt) if a turn
// still overflows. The window auto-tracks the model actually serving the request
// and self-corrects from any real ceiling stated in an overflow error.
//
// Pure moves out of pi-native.js: the discovered-window cache (kept at MODULE
// scope, matching its bridge-level scope before the split), context estimation,
// the guarded tryCompact, the reactive candidate test, the live compaction
// policy resolution, and the proactive+reactive hooks. Per-run compaction state
// (applied / reactiveAttempted / compactedThisRun / policy / diagnostics) lives
// on the caller-owned runState.compaction.

import {
  calculateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
} from "@earendil-works/pi-agent-core";
import {
  estimateFixedOverheadTokens,
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "../../../agent/compaction.js";
import {
  isContextLimitError,
  normalizePiErrorMessage,
  parseContextLimitFromError,
} from "../pi-errors.js";
import { appendStructuredOutputInstruction } from "./structured-output.js";
import { runHarnessPrompt } from "./turn-runner.js";

// Per-process cache of real context-window ceilings discovered from overflow
// errors, keyed by model reference/id. The long-running host re-learns quickly
// after a restart; this just spares repeated first-overflow round-trips.
const discoveredContextWindows = new Map();

function modelWindowKey(harness, runtime, resolved) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  return resolved?.reference || runtime?.model?.id || live?.id || "unknown";
}

// The window of the model that ACTUALLY serves this request: prefer the harness's
// live model (authoritative for native pi models), fall back to the resolved
// runtime model. Returns 0 when unknown so callers can skip the proactive trigger.
function liveModelContextWindow(harness, runtime) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  const win = Number(live?.contextWindow) || Number(runtime?.model?.contextWindow) || 0;
  return win > 0 ? win : 0;
}

function effectiveContextWindow(harness, runtime, resolved) {
  const declared = liveModelContextWindow(harness, runtime);
  const discovered = discoveredContextWindows.get(modelWindowKey(harness, runtime, resolved));
  if (Number.isFinite(discovered) && discovered > 0) {
    return declared > 0 ? Math.min(declared, discovered) : discovered;
  }
  return declared;
}

function recordDiscoveredContextWindow(harness, runtime, resolved, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = modelWindowKey(harness, runtime, resolved);
  const existing = discoveredContextWindows.get(key);
  discoveredContextWindows.set(key, Number.isFinite(existing) && existing > 0 ? Math.min(existing, n) : n);
}

// Best-effort estimate of the current session's context size. The last assistant
// usage is authoritative (it reflects what the provider actually counted,
// including cache reads), but it can be stale/zero (e.g. seeded history), so we
// take the MAX of the usage-based count and a raw per-message estimate. Either
// being large is a reason to compact; overcounting only compacts slightly early.
//
// `fixedOverheadTokens` is the system-prompt + tool-schema + per-turn user
// message overhead the provider meters but the raw per-message estimate (which
// sums only the transcript via session.buildContext().messages) excludes. It is
// added to the RAW branch ONLY: the usage-based count already includes that
// overhead (it is what the provider actually counted), so adding it there would
// double-count. With a stale/0 usage and a seeded session the raw branch wins,
// and without this the trigger under-counts and the real request overflows.
export async function estimateCurrentContextTokens(session, fixedOverheadTokens = 0) {
  let usageTokens = 0;
  let rawTokens = 0;
  try {
    const usage = getLastAssistantUsage(await session.getEntries());
    if (usage) usageTokens = Number(calculateContextTokens(usage)) || 0;
  } catch { /* ignore — fall back to the raw estimate */ }
  try {
    const context = await session.buildContext();
    for (const message of context?.messages || []) rawTokens += Number(estimateTokens(message)) || 0;
  } catch { /* ignore — usage-based estimate stands */ }
  // Apply the fixed overhead to the raw estimate only (see note above). Done
  // after the loop so it lands once, not per message.
  rawTokens += Number(fixedOverheadTokens) || 0;
  if (usageTokens === 0 && rawTokens === 0) return { tokens: 0, source: "unavailable" };
  return usageTokens >= rawTokens
    ? { tokens: usageTokens, source: "usage" }
    : { tokens: rawTokens, source: "estimate" };
}

// Run a single guarded compaction. Requires the harness idle (callers
// waitForIdle first). Never throws — classifies AgentHarnessError into a warning
// and reports back whether anything was compacted. Fires onCompactionRecorded on
// success so a host can persist the compaction row.
export async function tryCompact(harness, { trigger, onEvent, runtimeWarnings, onCompactionRecorded, runId, model }) {
  try {
    const result = await harness.compact();
    const tokensBefore = Number(result?.tokensBefore) || null;
    onEvent?.({
      type: "runtime_warning",
      warning_kind: "context_compaction_applied",
      source: "pi",
      trigger,
      tokens_before: tokensBefore,
    });
    if (typeof onCompactionRecorded === "function") {
      try {
        onCompactionRecorded({
          task_run_id: runId || null,
          trigger,
          provider_kind: "pi",
          model: model || null,
          tokens_before: tokensBefore,
          summary: result?.summary || "",
          first_kept_entry_id: result?.firstKeptEntryId || null,
          status: "succeeded",
          created_at: Date.now(),
        });
      } catch (err) {
        runtimeWarnings.push({
          warning_kind: "context_compaction_record_failed",
          source: "pi",
          message: err?.message || String(err),
        });
      }
    }
    return { applied: true, tokensBefore, nothingToCompact: false };
  } catch (err) {
    const message = err?.message || String(err);
    const code = err?.code;
    const nothingToCompact = code === "compaction" && /nothing to compact/i.test(message);
    const warningKind = nothingToCompact
      ? "context_compaction_nothing_to_compact"
      : code === "auth"
        ? "context_compaction_auth_failed"
        : code === "busy"
          ? "context_compaction_busy"
          : "context_compaction_failed";
    runtimeWarnings.push({ warning_kind: warningKind, source: "pi", trigger, message });
    return { applied: false, tokensBefore: null, nothingToCompact };
  }
}

function isReactiveCompactionCandidate(errorMessage, diagnostics) {
  if (!errorMessage) return false;
  return isContextLimitError(errorMessage) || isLikelyContextTermination(errorMessage, diagnostics);
}

/**
 * Resolve the compaction policy against the LIVE model's context window
 * (auto-recognized from the model actually serving the request, lowered by any
 * ceiling learned from a prior overflow). Drives the proactive trigger +
 * reactive recovery.
 * @param {{harness: any, runtime: any, resolved: any, settings: any}} params
 */
export function resolveLiveCompactionPolicy({ harness, runtime, resolved, settings }) {
  return resolveAgentCompactionPolicy(
    settings || {},
    { contextWindow: effectiveContextWindow(harness, runtime, resolved) },
  );
}

/**
 * Proactive compaction: if the session is already near the window, compact
 * BEFORE issuing the request so a long-lived session never overflows. Mutates
 * runState.compaction (applied / compactedThisRun / diagnostics) and re-anchors
 * runState.sessionBaselineCount when it fires.
 * @param {any} runState
 * @param {any} params
 */
export async function runProactiveCompaction(runState, {
  harness,
  systemPrompt,
  options,
  tools,
  promptText,
  promptImages,
  reference,
  onEvent,
  runtimeWarnings,
}) {
  const policy = runState.compaction.policy;
  if (!(policy.enabled && policy.contextWindow > 0 && !options.abortSignal?.aborted)) return;
  // Fixed per-request overhead the provider meters but the raw transcript
  // estimate excludes (system prompt + tool/MCP schemas + per-turn user
  // message + memory). Computed ONCE here from the same inputs the harness
  // sends to the provider, then folded into the raw estimate so the trigger
  // reflects the real request size. ON by default (this corrects a real
  // undercount that lets seeded sessions overflow); set
  // agent_compaction_fixed_overhead_enabled:false to restore the prior
  // transcript-only trigger (overhead = 0). See estimateFixedOverheadTokens.
  //
  // Only the TRAILING per-turn user message is passed here, NOT
  // options.messages. The prior transcript is already summed by the raw
  // branch via session.buildContext().messages (priorMessages were seeded
  // into the session above), so passing the whole history would double-count
  // it. promptText/promptImages (from splitPromptMessages at the run head)
  // ARE the per-turn turn, so reconstruct that single message for the
  // estimate — matching estimateFixedOverheadTokens' "per-turn user
  // message(s)" contract.
  const perTurnContent = Array.isArray(promptImages) && promptImages.length > 0
    ? [{ type: "text", text: promptText }, ...promptImages]
    : promptText;
  const fixedOverhead = options.settings?.agent_compaction_fixed_overhead_enabled !== false
    ? estimateFixedOverheadTokens({
      systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema),
      tools,
      messages: [{ role: "user", content: perTurnContent }],
    })
    : { systemPromptTokens: 0, toolSchemaTokens: 0, userMessageTokens: 0, fixedOverheadTokens: 0 };
  const est = await estimateCurrentContextTokens(runState.session, fixedOverhead.fixedOverheadTokens);
  if (est.tokens >= policy.triggerTokens) {
    await harness.waitForIdle();
    if (!options.abortSignal?.aborted) {
      const res = await tryCompact(harness, {
        trigger: "proactive",
        onEvent,
        runtimeWarnings,
        onCompactionRecorded: options.onCompactionRecorded,
        runId: options.runId,
        model: reference,
      });
      if (res.applied) {
        runState.compaction.applied = true;
        runState.compaction.compactedThisRun = true;
        Object.assign(runState.compaction.diagnostics, {
          context_compaction_proactive: true,
          context_compaction_tokens_before: res.tokensBefore,
          context_compaction_estimate_source: est.source,
          context_window: policy.contextWindow,
          // Additive observability (A4): the overhead components folded into
          // the trigger comparison, the trigger itself (read back by
          // isLikelyContextTermination but otherwise never set), and the
          // transcript-plus-overhead estimate that fired this compaction.
          context_fixed_overhead_tokens: fixedOverhead.fixedOverheadTokens,
          context_system_prompt_tokens: fixedOverhead.systemPromptTokens,
          context_tool_schema_tokens: fixedOverhead.toolSchemaTokens,
          context_compaction_trigger_tokens: policy.triggerTokens,
          context_transcript_estimate: est.tokens,
        });
        // Compaction collapses the transcript prefix, so the pre-run baseline
        // no longer aligns. Re-anchor it to the compacted length so the run's
        // own turns (issued next) slice out correctly in captureState.
        runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
      }
    }
  }
}

/**
 * Reactive recovery: if the turn ended in a context overflow and we have not
 * already compacted-and-retried this run, compact once and re-prompt once.
 * Learns the real ceiling from the overflow error. Returns the (possibly
 * re-captured) state + runError.
 * @param {any} runState
 * @param {any} params
 * @returns {Promise<{state: any, runError: any}>}
 */
export async function runReactiveCompaction(runState, {
  harness,
  runtime,
  resolved,
  options,
  promptText,
  promptImages,
  reference,
  onEvent,
  runtimeWarnings,
  state,
  runError,
  captureState,
}) {
  const c = runState.compaction;
  if (!(
    c.policy?.enabled
    && !c.reactiveAttempted
    && !runState.externalAbort
    && !runState.maxTurnsHit
    && !options.abortSignal?.aborted
  )) {
    return { state, runError };
  }
  const provisionalRaw = state.stopReason === "error" || state.stopReason === "aborted"
    ? state.lastAssistant?.errorMessage || runError?.message || null
    : (runError ? runError.message || String(runError) : null);
  const provisionalError = normalizePiErrorMessage(provisionalRaw);
  if (provisionalError && isReactiveCompactionCandidate(provisionalError, c.diagnostics)) {
    c.reactiveAttempted = true;
    // Learn the real ceiling from the error so future runs trigger
    // proactively at it even when the configured contextWindow was wrong.
    recordDiscoveredContextWindow(harness, runtime, resolved, parseContextLimitFromError(provisionalError));
    // A second compaction immediately after a fresh proactive one is almost
    // always "nothing to compact"; skip it and surface the original error.
    if (!c.compactedThisRun) {
      await harness.waitForIdle();
      const res = await tryCompact(harness, {
        trigger: "reactive_overflow",
        onEvent,
        runtimeWarnings,
        onCompactionRecorded: options.onCompactionRecorded,
        runId: options.runId,
        model: reference,
      });
      if (res.applied) {
        c.applied = true;
        c.compactedThisRun = true;
        Object.assign(c.diagnostics, {
          context_compaction_reactive: true,
          context_compaction_tokens_before: res.tokensBefore,
        });
        // Re-anchor the transcript baseline to the compacted length so the
        // re-prompt's turn (and its stopReason/usage) slices out correctly.
        runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
        // Re-prompt ONCE in the now-compacted session. The trailing user turn
        // is already persisted, so a fresh prompt continues against it.
        const rerun = await runHarnessPrompt(harness, promptText, promptImages);
        runError = rerun.runError;
        state = await captureState();
      }
    }
  }
  return { state, runError };
}
