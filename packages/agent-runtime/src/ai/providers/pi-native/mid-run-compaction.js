// @ts-check
// Mid-run context compaction for the pi-native bridge.
//
// WHY: the bridge used to check the compaction trigger exactly once per run,
// before `harness.prompt()`. Inside one long prompt, tool results and repeated
// model turns then grew the request without limit until the run ended or the
// provider overflowed. For the Codex models the declared 272,000-token window is
// a PRICE step (above it the whole request bills at 2x input/cache and 1.5x
// output), so drifting across it mid-run is a real cost event, not only a
// robustness problem. The trigger itself is unchanged; this module only makes
// the existing trigger observable BETWEEN completed model/tool rounds.
//
// MECHANISM (validated against @earendil-works/pi-agent-core 0.87.0 in
// node_modules, citations are to its `dist/`):
//
//   * Pi already evaluates compaction at every durable run boundary:
//     `runCheckpoint` calls `prepareCompactionThreshold`, and when the lane's
//     captured compaction settings are enabled and `shouldCompact()` is true it
//     schedules a `reason: "threshold"` structural task whose boundary is
//     `resume_checkpoint` — i.e. the run CONTINUES afterwards
//     (harness/runtime/drive/checkpoint.js:59-108,
//     harness/runtime/drive/structural.js:836-870,
//     harness/runtime/drive/structural.js:224-283).
//   * That checkpoint is only reached once a whole tool batch is complete
//     (harness/runtime/drive/tool-placement.js:132-160 `complete`), so a
//     compaction can never cut across an unfinished tool call, and it is
//     evaluated once per round rather than per tool result.
//   * The decision point is Pi's `before_compaction` hook, which is AWAITED and
//     resolved first-wins (harness/hooks.js:235-254 `firstStructural`,
//     harness/runtime/drive/structural.js:492-511). Returning `{compaction}`
//     makes Pi commit OUR summary (`fromHook: true`), returning `{decline}` for
//     a threshold task simply resumes the run. Returning `undefined` would hand
//     the compaction to Pi's own summariser, so we never do.
//   * `lane.compact()` (manual compaction) is NOT usable here: it rejects with
//     `LaneBusy` while an operation is active
//     (harness/runtime/lane.js:481-493 `acceptCompaction`).
//   * The compaction runs inside the SAME operation as the prompt (same runId),
//     so the admitted prompt operation id and the live-input epoch are
//     untouched: no second `run_start`, no queued steer consumed, no new user
//     message.
//   * Compaction settings are captured into the operation state at accept time
//     (harness/runtime/lane.js:52-59 `capturedSettings`, :443-448), so they must
//     be armed BEFORE `harness.prompt()` and cannot be flipped mid-flight.
//
// COST: every attempt that gets past the guards pays for a summary request, so
// the guards below are deliberately strict — one attempt in flight, at most one
// evaluation per completed round, a re-check of the real trigger before paying,
// and required fresh assistant progress plus meaningful growth after any
// previous attempt.

import { randomUUID } from "node:crypto";
import { estimateTokens, shouldCompact } from "@earendil-works/pi-agent-core";
import { buildPiSessionContext } from "./harness-adapter.js";
import {
  createCompactionAccounting,
  createCompactionEmitter,
  createGuardedCompactionHook,
  piCompactionSettings,
  piSummaryReserveTokens,
  reportGuardedCompactionOutcome,
} from "./compaction-driver.js";
import { hasMeasuredUsage, usageFromMessages } from "./result-builder.js";

// Mid-run compactions are reported under the existing proactive trigger: they
// are the same non-overflow, policy-driven compaction, and every host contract
// (`context_compaction.trigger`, the persisted compaction row) keeps its current
// vocabulary. The mid-run distinction is carried in the accounting block and in
// the run's compaction diagnostics instead.
const MID_RUN_TRIGGER = "proactive";

// After an attempt, require at least this much additional transcript growth
// before paying for another summary. Scales with the policy minimum savings so a
// large window does not re-attempt after a trivial amount of new context.
const FLOOR_GROWTH_TOKENS = 1_000;

function transcriptTokensOf(messages) {
  return messages.reduce((total, message) => total + (Number(estimateTokens(message)) || 0), 0);
}

function assistantCountOf(messages) {
  return messages.reduce((total, message) => total + (message?.role === "assistant" ? 1 : 0), 0);
}

/**
 * The reserve that makes Pi's own checkpoint `shouldCompact()` fire at exactly
 * this bridge's trigger.
 *
 * Pi compares its usage-aware transcript estimate against
 * `contextWindow - reserveTokens` with a STRICT `>` (harness/compaction/
 * compaction.js:143-148), using the window of the model in its own collection.
 * The bridge's trigger is `estimate + fixedOverhead >= triggerTokens`, where the
 * fixed overhead (system prompt + tool schemas) is metered by the provider but
 * excluded from the transcript estimate. Both sides are non-negative integers,
 * so `x >= t` iff `x > t - 1` and the exact mapping is
 * `reserveTokens = piWindow - (triggerTokens - fixedOverhead) + 1`.
 * @param {number} piWindow
 * @param {number} triggerTokens
 * @param {number} fixedOverheadTokens
 * @returns {number|null} null when the trigger is not expressible in this window
 */
export function midRunReserveTokens(piWindow, triggerTokens, fixedOverheadTokens) {
  const window = Number(piWindow) || 0;
  const transcriptTrigger = Math.max(1, Math.floor((Number(triggerTokens) || 0) - (Number(fixedOverheadTokens) || 0)));
  if (window <= 0 || transcriptTrigger > window) return null;
  return window - transcriptTrigger + 1;
}

/**
 * The context window Pi itself will compare against at a checkpoint: the model
 * resolved from the harness's own `Models` collection when available (that is
 * what `prepareCompactionThreshold` uses via `lane.models.getModel`), falling
 * back to the bridge's live model.
 * @param {any} harness
 */
function piThresholdWindow(harness) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  let fromCollection;
  try {
    fromCollection = typeof harness?.models?.getModel === "function"
      ? harness.models.getModel(live?.provider, live?.id)
      : undefined;
  } catch { /* the collection is advisory here */ }
  return Number(fromCollection?.contextWindow) || Number(live?.contextWindow) || 0;
}

/**
 * Re-anchor the run's transcript slice across an applied compaction.
 *
 * `captureState` bills `transcript.slice(runState.sessionBaselineCount)`. A
 * compaction replaces the whole prefix with one summary message plus the
 * retained tail, so both the baseline and the usage of the run-owned messages
 * that just left the context have to move with it.
 *
 * The retained tail is a contiguous SUFFIX of the pre-compaction context (Pi
 * builds it from the same branch path — harness/compaction/compaction.js:
 * 457-462), and the rebuilt context is exactly `[summary, ...retainedTail]`
 * (harness-adapter.js buildPiSessionContext), so the run-owned messages that
 * survive are the last `min(retained, runOwned)` of them.
 * @param {Array<any>} contextBefore
 * @param {number} baseline
 * @param {number} retainedTailLength
 */
export function midRunBaselineAdjustment(contextBefore, baseline, retainedTailLength) {
  const before = contextBefore.length;
  const anchor = Math.min(Math.max(0, Number(baseline) || 0), before);
  const runOwned = before - anchor;
  const retained = Math.min(Math.max(0, Number(retainedTailLength) || 0), before);
  const survived = Math.min(retained, runOwned);
  const lost = contextBefore.slice(anchor, before - survived);
  return {
    baselineAfter: 1 + retained - survived,
    lostMessages: lost,
    carriedUsage: usageFromMessages(lost),
  };
}

function addCarriedUsage(target, addition) {
  const base = target || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  return {
    input: base.input + addition.input,
    output: base.output + addition.output,
    cacheRead: base.cacheRead + addition.cacheRead,
    cacheWrite: base.cacheWrite + addition.cacheWrite,
    cost: base.cost + addition.cost,
  };
}

/**
 * Arm Pi's checkpoint compaction for the lifetime of one prompt with this
 * bridge's guarded decision installed, and return the disarm handle. Must be
 * called BEFORE `harness.prompt()`; `disarm()` is idempotent and never throws.
 * @param {any} runState
 * @param {{harness: any, options: any, reference: string, onEvent: (event: any) => void, runtimeWarnings: Array<any>}} deps
 */
export async function armMidRunCompaction(runState, { harness, options, reference, onEvent, runtimeWarnings }) {
  const controller = createMidRunCompaction(runState, { harness, options, reference, onEvent, runtimeWarnings });
  await controller.arm();
  return controller;
}

/**
 * @param {any} runState
 * @param {{harness: any, options: any, reference: string, onEvent: (event: any) => void, runtimeWarnings: Array<any>}} deps
 */
export function createMidRunCompaction(runState, { harness, options, reference, onEvent, runtimeWarnings }) {
  const policy = runState.compaction?.policy || null;
  const diagnostics = runState.compaction?.diagnostics || {};
  // The transcript estimate already contains this run's user turn, so only the
  // stable system-prompt + tool-schema overhead may be added on top of it. The
  // proactive check adds the not-yet-appended user turn separately; adding it
  // again here would count it twice.
  const fixedOverheadTokens = Math.max(
    0,
    (Number(diagnostics.context_fixed_overhead_tokens) || 0) - (Number(diagnostics.context_user_message_tokens) || 0),
  );
  const growthRequirement = Math.max(
    FLOOR_GROWTH_TOKENS,
    Math.floor(Number(policy?.compactionMinSavingsTokens) || 0),
  );

  let armed = false;
  let disposed = false;
  /** @type {null | (() => void)} */
  let removeHook = null;
  /** @type {null | (() => void)} */
  let unsubscribe = null;
  let inFlight = false;
  /** @type {null | {transcriptTokens: number, assistantCount: number}} */
  let lastAttempt = null;
  /** @type {null | any} */
  let pending = null;
  let warnedIneffective = false;
  const stats = { evaluations: 0, attempts: 0, applied: 0, skipped: 0, failed: 0, ineffective: 0 };

  /**
   * Report ONCE per run that the transcript is over the trigger but its shape
   * cannot be reduced. Repeating it every round would be noise, and staying
   * completely silent would hide a run that is knowingly above the price step.
   * @param {number} projectedSavings
   * @param {number} summarizableTokens
   */
  function warnIneffectiveOnce(projectedSavings, summarizableTokens) {
    stats.ineffective += 1;
    diagnostics.context_compaction_midrun_ineffective = stats.ineffective;
    if (warnedIneffective) return;
    warnedIneffective = true;
    runtimeWarnings?.push({
      warning_kind: "context_compaction_midrun_ineffective",
      source: "pi",
      trigger: MID_RUN_TRIGGER,
      message: "The context is above the compaction trigger, but the retained recent messages hold almost all of it, so a mid-run summary could not save enough to be worth its own request.",
      projected_savings_tokens: projectedSavings,
      summarizable_tokens: summarizableTokens,
      minimum_savings_tokens: Number(policy.compactionMinSavingsTokens) || 0,
    });
  }

  const compactionSettings = policy
    ? {
      enabled: true,
      reserveTokens: piSummaryReserveTokens(policy.summaryMaxTokens, false),
      keepRecentTokens: policy.keepRecentTokens,
    }
    : null;

  function recordDiagnostics() {
    Object.assign(diagnostics, {
      context_compaction_midrun_attempts: stats.attempts,
      context_compaction_midrun_applied: stats.applied,
      ...(stats.applied > 0 ? { context_compaction_midrun: true } : {}),
    });
  }

  /**
   * Cheap vetoes evaluated before any paid summary request.
   * @param {any} event
   * @param {{contextBefore: Array<any>, transcriptTokens: number, assistantCount: number}} measured
   */
  function veto(event, measured) {
    if (options.abortSignal?.aborted || event?.signal?.aborted) return { reason: "aborted" };
    if (inFlight || pending) return { reason: "attempt_in_flight" };
    // Re-check the real trigger in this bridge's own terms. Pi's checkpoint may
    // fire earlier than the bridge's policy (different window metadata, a
    // learned ceiling, usage-based counting); a summary is a paid request, so it
    // is only worth issuing once the bridge's own trigger is actually crossed.
    if (!shouldCompact(
      measured.transcriptTokens + fixedOverheadTokens,
      policy.contextWindow,
      piCompactionSettings(policy),
    )) return { reason: "below_trigger" };
    if (lastAttempt) {
      if (measured.assistantCount <= lastAttempt.assistantCount) return { reason: "no_new_assistant" };
      if (measured.transcriptTokens - lastAttempt.transcriptTokens < growthRequirement) {
        return { reason: "insufficient_growth" };
      }
    }
    return undefined;
  }

  async function handler(event) {
    if (!armed || disposed) return { cancel: true };
    // Only Pi's in-run threshold task belongs to this controller. Anything else
    // (a manual `harness.compact()` driven by tryCompact) is deferred to the
    // hook registered by that path.
    if (event?.reason !== "threshold") return undefined;
    stats.evaluations += 1;

    const operationId = randomUUID();
    const started = performance.now();
    const accounting = createCompactionAccounting();
    accounting.midRun = true;
    accounting.policy = Object.fromEntries(
      ["contextWindow", "triggerTokens", "keepRecentTokens", "summaryMaxTokens", "compactionMinSavingsTokens"]
        .map((key) => [key, Number.isFinite(Number(policy[key])) ? Number(policy[key]) : null]),
    );
    const emit = createCompactionEmitter(accounting, started);

    /** @type {null | {contextBefore: Array<any>, transcriptTokens: number, assistantCount: number}} */
    let measured = null;
    const guarded = createGuardedCompactionHook({
      harness,
      trigger: MID_RUN_TRIGGER,
      operationId,
      effectivePolicy: policy,
      compactionSettings,
      accounting,
      fixedOverheadTokens,
      beforeAttempt: (hookEvent) => {
        const contextBefore = buildPiSessionContext(hookEvent.branchEntries || [], { includeFailed: true });
        measured = {
          contextBefore,
          transcriptTokens: transcriptTokensOf(contextBefore),
          assistantCount: assistantCountOf(contextBefore),
        };
        const skip = veto(hookEvent, measured);
        if (skip) return skip;
        inFlight = true;
        return undefined;
      },
      // Pi's cut keeps whole recent messages, so a transcript whose bulk is all
      // in the retained tail cannot be reduced no matter what the summary says.
      // Catching that from the preparation alone avoids paying for a summary
      // that the savings guard would then reject.
      beforeSummary: ({ prepared }) => {
        const summarizable = transcriptTokensOf([
          ...(prepared.messagesToSummarize || []),
          ...(prepared.turnPrefixMessages || []),
        ]);
        const projectedSavings = summarizable - (Number(policy.summaryMaxTokens) || 0);
        if (projectedSavings < (Number(policy.compactionMinSavingsTokens) || 0)) {
          warnIneffectiveOnce(projectedSavings, summarizable);
          return { reason: "projected_savings" };
        }
        emit(onEvent, { operationId, status: "running", trigger: MID_RUN_TRIGGER, model: reference });
        return undefined;
      },
    });

    let result;
    try {
      result = await guarded.handler(event);
    } catch (error) {
      // createGuardedCompactionHook never throws; this is belt-and-braces so a
      // hook fault can never reach Pi as "undefined" (which would hand the
      // compaction to Pi's own summariser).
      inFlight = false;
      reportGuardedCompactionOutcome({
        decision: { kind: "failed", error },
        error,
        trigger: MID_RUN_TRIGGER,
        model: reference,
        operationId,
        emit,
        onEvent,
        runtimeWarnings,
        effectivePolicy: policy,
      });
      stats.failed += 1;
      recordDiagnostics();
      return { cancel: true };
    }

    const decision = guarded.getDecision();
    if (decision?.kind === "guard_skipped") {
      // Silent by design: no lifecycle event and no provider request. Pi resumes
      // the run on a declined threshold task.
      inFlight = false;
      if (decision.reason === "projected_savings" && measured) {
        // Real (unpaid) work happened, and the shape will not change until the
        // transcript grows, so hold off until it does.
        lastAttempt = { transcriptTokens: measured.transcriptTokens, assistantCount: measured.assistantCount };
      }
      return { cancel: true };
    }

    stats.attempts += 1;
    if (decision?.kind === "accepted") {
      pending = { operationId, emit, decision, accounting, measured };
      recordDiagnostics();
      return result;
    }

    inFlight = false;
    const outcome = reportGuardedCompactionOutcome({
      decision,
      error: decision?.error,
      trigger: MID_RUN_TRIGGER,
      model: reference,
      operationId,
      emit,
      onEvent,
      runtimeWarnings,
      effectivePolicy: policy,
    });
    if (decision?.kind === "not_reducible" || decision?.kind === "insufficient_savings" || outcome.nothingToCompact) {
      stats.skipped += 1;
    } else {
      stats.failed += 1;
    }
    Object.assign(diagnostics, {
      context_compaction_tokens_before: outcome.tokensBefore,
      context_compaction_tokens_after: outcome.tokensAfter,
      context_compaction_reduced: outcome.reduced,
    });
    // A skipped or failed attempt still consumed real work, so require fresh
    // assistant progress AND meaningful growth before paying again.
    if (measured) lastAttempt = { transcriptTokens: measured.transcriptTokens, assistantCount: measured.assistantCount };
    recordDiagnostics();
    return { cancel: true };
  }

  /**
   * Pi commits a hook-supplied compaction in one durable transaction and only
   * then emits `compaction_end`, so the applied state is published here rather
   * than optimistically inside the hook. An aborted or declined task therefore
   * leaves nothing half-applied.
   * @param {any} event
   */
  function onCompactionEnd(event) {
    if (!event || event.type !== "compaction_end" || event.reason !== "threshold") return;
    if (event.lane !== undefined && event.lane !== "main") return;
    const attempt = pending;
    pending = null;
    inFlight = false;
    if (!attempt) return;
    const { operationId, emit, decision, measured } = attempt;
    if (event.status !== "completed") {
      // The compaction we handed Pi was not committed (cancelled run or a
      // durable failure). Report it and leave the run's accounting untouched.
      reportGuardedCompactionOutcome({
        decision: { kind: "failed", error: Object.assign(new Error("Mid-run compaction was not committed"), { code: event.status === "declined" ? "aborted" : "compaction" }) },
        error: undefined,
        trigger: MID_RUN_TRIGGER,
        model: reference,
        operationId,
        emit,
        onEvent,
        runtimeWarnings,
        effectivePolicy: policy,
      });
      stats.failed += 1;
      recordDiagnostics();
      return;
    }

    const adjustment = midRunBaselineAdjustment(
      measured?.contextBefore || [],
      runState.sessionBaselineCount,
      decision.retainedTailLength,
    );
    runState.sessionBaselineCount = adjustment.baselineAfter;
    runState.compaction.carriedUsage = addCarriedUsage(runState.compaction.carriedUsage, adjustment.carriedUsage);
    if (!runState.compaction.carriedUsageMeasured) {
      runState.compaction.carriedUsageMeasured = hasMeasuredUsage(adjustment.lostMessages);
    }
    runState.compaction.applied = true;
    runState.compaction.compactedThisRun = true;
    // Reactive recovery must distinguish an immediate overflow from one after
    // many more rounds. Use the same raw transcript estimate and growth budget
    // as the checkpoint guards, not provider usage that may predate this cut.
    runState.compaction.lastMidRunCompaction = {
      transcriptTokens: decision.tokensAfter,
      growthRequirement,
    };
    stats.applied += 1;
    // Deliberately NOT `context_compaction_proactive`: that diagnostic means the
    // pre-request pass fired. A mid-run compaction reports itself under the
    // midrun keys, and the run still reports `context_compaction_applied`.
    Object.assign(diagnostics, {
      context_compaction_tokens_before: decision.tokensBefore,
      context_compaction_tokens_after: decision.tokensAfter,
      context_compaction_reduced: decision.tokensBefore !== null && decision.tokensAfter !== null
        ? decision.tokensAfter < decision.tokensBefore
        : null,
    });
    recordDiagnostics();
    emit(onEvent, {
      operationId,
      status: "succeeded",
      trigger: MID_RUN_TRIGGER,
      model: reference,
      tokensBefore: decision.tokensBefore,
      tokensAfter: decision.tokensAfter,
    });
    if (typeof options.onCompactionRecorded === "function") {
      try {
        options.onCompactionRecorded({
          task_run_id: options.runId || null,
          trigger: MID_RUN_TRIGGER,
          provider_kind: "pi",
          model: reference || null,
          tokens_before: decision.tokensBefore,
          summary: decision.compaction?.summary || "",
          first_kept_entry_id: decision.firstKeptEntryId || null,
          status: "succeeded",
          created_at: Date.now(),
        });
      } catch (err) {
        runtimeWarnings?.push({
          warning_kind: "context_compaction_record_failed",
          source: "pi",
          message: err?.message || String(err),
        });
      }
    }
    // The next attempt measures growth from the compacted transcript.
    lastAttempt = {
      transcriptTokens: Number(decision.tokensAfter) || 0,
      assistantCount: assistantCountOf(decision.compaction?.retainedTail || []),
    };
  }

  return {
    get armed() { return armed; },
    stats,
    async arm() {
      if (armed || disposed) return armed;
      if (!policy?.enabled || !(policy.contextWindow > 0)) return false;
      if (typeof harness?.on !== "function"
        || typeof harness?.setCompactionSettings !== "function"
        || typeof harness?.setMidRunCompactionArmed !== "function"
        || typeof harness?.subscribe !== "function") {
        return false;
      }
      const reserveTokens = midRunReserveTokens(piThresholdWindow(harness), policy.triggerTokens, fixedOverheadTokens);
      if (reserveTokens === null) {
        runtimeWarnings?.push({
          warning_kind: "context_compaction_midrun_unavailable",
          source: "pi",
          message: "The compaction trigger is not expressible inside the provider-reported context window, so mid-run compaction stayed off.",
          trigger_tokens: policy.triggerTokens,
          context_window: piThresholdWindow(harness),
        });
        return false;
      }
      try {
        // Lane settings drive Pi's threshold decision only; the summary itself
        // is prepared by the guarded hook with the bridge's own settings.
        await harness.setCompactionSettings({
          enabled: true,
          reserveTokens,
          keepRecentTokens: policy.keepRecentTokens,
        });
        removeHook = harness.on("session_before_compact", handler);
        unsubscribe = harness.subscribe(onCompactionEnd);
        harness.setMidRunCompactionArmed(true);
        armed = true;
        diagnostics.context_compaction_midrun_armed = true;
        return true;
      } catch (err) {
        armed = false;
        try { removeHook?.(); } catch { /* best-effort */ }
        try { unsubscribe?.(); } catch { /* best-effort */ }
        removeHook = null;
        unsubscribe = null;
        runtimeWarnings?.push({
          warning_kind: "context_compaction_midrun_unavailable",
          source: "pi",
          message: err?.message || String(err),
        });
        return false;
      }
    },
    async disarm() {
      if (disposed) return;
      disposed = true;
      pending = null;
      inFlight = false;
      if (!armed) return;
      armed = false;
      try { harness.setMidRunCompactionArmed(false); } catch { /* best-effort */ }
      try { removeHook?.(); } catch { /* best-effort */ }
      try { unsubscribe?.(); } catch { /* best-effort */ }
      removeHook = null;
      unsubscribe = null;
      try {
        await harness.setCompactionSettings({ enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 });
      } catch { /* best-effort */ }
    },
  };
}
