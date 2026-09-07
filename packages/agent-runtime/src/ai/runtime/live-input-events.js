// Metadata-only live-input lifecycle instrumentation and logical-run replay fencing.
// Stable ids identify one logical delivery across provider retries. The first
// occurrence owns the body and callbacks; later same-id occurrences are invalid
// duplicates. Anonymous input remains legal but is never replayed.

// @ts-check

const LIVE_INPUT_INSTRUMENTED = Symbol("mono-agent.live-input-instrumented");
const MAX_DIAGNOSTICS_PER_KIND = 100;

/**
 * @typedef {{providerEntryId?: string, providerRunId?: string}} RuntimeLiveInputEvidence
 * @typedef {{reason: "delivery_uncertain", providerEntryId?: string, providerRunId?: string}} RuntimeLiveInputUncertainty
 * @typedef {{body: string, id?: string, receivedAt?: string, accepted?: (evidence?: RuntimeLiveInputEvidence) => unknown, acknowledge?: (evidence?: RuntimeLiveInputEvidence) => unknown, uncertain?: (details: RuntimeLiveInputUncertainty) => unknown, reject?: (reason?: unknown) => unknown}} RuntimeLiveInputMessage
 * @typedef {{message: RuntimeLiveInputMessage, inputId: string, receivedAt?: string, phase: "available"|"leased"|"native_accepted"|"consumed"|"uncertain", attempt: number, generation: number}} LiveInputOwner
 * @typedef {{type: string, [key: string]: unknown}} LiveInputEvent
 */

/**
 * @param {AsyncIterable<RuntimeLiveInputMessage>|undefined} liveInput
 * @param {(event: LiveInputEvent) => void} onEvent
 * @returns {AsyncIterable<RuntimeLiveInputMessage>|undefined}
 */
export function instrumentLiveInputAppliedEvents(liveInput, onEvent) {
  if (liveInput === undefined || isInstrumented(liveInput)) return liveInput;

  /** @type {Map<string, LiveInputOwner>} */
  const owners = new Map();
  const diagnosticCounts = new Map();
  let generation = 0;

  const instrumented = {
    [LIVE_INPUT_INSTRUMENTED]: true,
    [Symbol.asyncIterator]() {
      generation += 1;
      const iteratorGeneration = generation;
      const iterator = liveInput[Symbol.asyncIterator]();
      const yieldedIds = new Set();
      let ordinal = 0;

      return {
        async next() {
          while (true) {
            const next = await iterator.next();
            if (next.done === true) return next;
            ordinal += 1;
            const message = next.value;
            const stableId = normalizedStableId(message?.id);

            if (stableId === undefined) {
              if (iteratorGeneration > 1) {
                emitBounded("anonymous_identity", {
                  type: "live_input_replay_suppressed",
                  reason: "anonymous_identity",
                  generation: iteratorGeneration,
                  ordinal,
                });
                continue;
              }
              const owner = createOwner(message, `anonymous:${iteratorGeneration}:${ordinal}`, iteratorGeneration);
              return { done: false, value: lease(owner) };
            }

            const existing = owners.get(stableId);
            if (existing === undefined) {
              const owner = createOwner(message, stableId, iteratorGeneration);
              owners.set(stableId, owner);
              yieldedIds.add(stableId);
              return { done: false, value: lease(owner) };
            }

            emitBounded("duplicate_id", {
              type: "live_input_duplicate_suppressed",
              inputId: stableId,
              generation: iteratorGeneration,
            });
            if (
              iteratorGeneration > existing.generation
              && existing.phase === "available"
              && !yieldedIds.has(stableId)
            ) {
              // Suppress the later occurrence itself. It merely reveals that the
              // first owner is present in this replay generation; replay the
              // first owner's immutable body and callbacks.
              yieldedIds.add(stableId);
              existing.generation = iteratorGeneration;
              return { done: false, value: lease(existing) };
            }
          }
        },
        async return(value) {
          return typeof iterator.return === "function"
            ? iterator.return(value)
            : { done: true, value };
        },
        async throw(error) {
          if (typeof iterator.throw === "function") return iterator.throw(error);
          throw error;
        },
      };
    },
  };

  return /** @type {AsyncIterable<RuntimeLiveInputMessage>} */ (instrumented);

  /** @param {RuntimeLiveInputMessage} message @param {string} inputId @param {number} ownerGeneration */
  function createOwner(message, inputId, ownerGeneration) {
    const receivedAt = validString(message?.receivedAt);
    return {
      message,
      inputId,
      ...(receivedAt === undefined ? {} : { receivedAt }),
      phase: /** @type {const} */ ("available"),
      attempt: 0,
      generation: ownerGeneration,
    };
  }

  /** @param {LiveInputOwner} owner */
  function lease(owner) {
    owner.phase = "leased";
    owner.attempt += 1;
    const attempt = owner.attempt;
    const host = owner.message;
    const base = eventBase(owner);

    /** @type {RuntimeLiveInputMessage} */
    const wrapped = {
      ...host,
      accepted(evidence) {
        if (!isCurrent(owner, attempt, "leased")) return "ignored";
        owner.phase = "native_accepted";
        const disposition = callHost(host.accepted, host, evidence);
        emit({
          type: "live_input_native_accepted",
          ...base,
          ...safeEvidence(evidence),
          settlementDisposition: disposition,
        });
        return publicDisposition(disposition);
      },
      acknowledge(evidence) {
        if (!isCurrent(owner, attempt, "leased", "native_accepted")) {
          emit({ type: "live_input_consumed", ...base, ...safeEvidence(evidence), late: true });
          return "ignored";
        }
        owner.phase = "consumed";
        emit({ type: "live_input_consumed", ...base, ...safeEvidence(evidence) });
        const disposition = callHost(host.acknowledge, host, evidence);
        if (disposition === "recorded") {
          emit({ type: "live_input_applied", ...base, ...safeEvidence(evidence) });
        } else {
          emit({
            type: "live_input_settlement_unconfirmed",
            ...base,
            phase: "consumed",
            settlementDisposition: disposition,
          });
        }
        return publicDisposition(disposition);
      },
      uncertain(details) {
        if (!isCurrent(owner, attempt, "leased", "native_accepted")) return "ignored";
        owner.phase = "uncertain";
        const normalized = {
          reason: /** @type {const} */ ("delivery_uncertain"),
          ...safeEvidence(details),
        };
        const disposition = callHost(host.uncertain, host, normalized);
        emit({
          type: "live_input_uncertain",
          ...base,
          ...normalized,
          settlementDisposition: disposition,
        });
        return publicDisposition(disposition);
      },
      reject(reason) {
        if (!isCurrent(owner, attempt, "leased", "native_accepted")) return "ignored";
        if (owner.phase === "native_accepted" && !isNativeQueueRemoved(reason)) {
          return wrapped.uncertain?.({ reason: "delivery_uncertain" });
        }
        owner.phase = "available";
        const disposition = callHost(host.reject, host, reason);
        return publicDisposition(disposition);
      },
    };
    return wrapped;
  }

  /** @param {string} kind @param {LiveInputEvent} event */
  function emitBounded(kind, event) {
    const count = diagnosticCounts.get(kind) ?? 0;
    if (count >= MAX_DIAGNOSTICS_PER_KIND) return;
    diagnosticCounts.set(kind, count + 1);
    emit(event);
  }

  /** @param {LiveInputEvent} event */
  function emit(event) {
    try { onEvent(event); } catch { /* telemetry never changes delivery */ }
  }
}

/** @param {unknown} callback @param {RuntimeLiveInputMessage} receiver @param {unknown} argument */
function callHost(callback, receiver, argument) {
  if (typeof callback !== "function") return "unconfirmed";
  try {
    const result = callback.call(receiver, argument);
    return result === "recorded" || result === "ignored" ? result : "unconfirmed";
  } catch {
    return "threw";
  }
}

/** @param {string} disposition */
function publicDisposition(disposition) {
  return disposition === "recorded" || disposition === "ignored" ? disposition : undefined;
}

/** @param {LiveInputOwner} owner */
function eventBase(owner) {
  return {
    inputId: owner.inputId,
    ...(owner.receivedAt === undefined ? {} : { receivedAt: owner.receivedAt }),
  };
}

/** @param {LiveInputOwner} owner @param {number} attempt @param  {...string} phases */
function isCurrent(owner, attempt, ...phases) {
  return owner.attempt === attempt && phases.includes(owner.phase);
}

/** @param {unknown} value */
function normalizedStableId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** @param {unknown} value */
function validString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** @param {unknown} value */
function safeEvidence(value) {
  if (typeof value !== "object" || value === null) return {};
  const evidence = /** @type {{providerEntryId?: unknown, providerRunId?: unknown}} */ (value);
  return {
    ...(validString(evidence.providerEntryId) === undefined ? {} : { providerEntryId: evidence.providerEntryId }),
    ...(validString(evidence.providerRunId) === undefined ? {} : { providerRunId: evidence.providerRunId }),
  };
}

/** @param {unknown} reason */
function isNativeQueueRemoved(reason) {
  return typeof reason === "object"
    && reason !== null
    && /** @type {{code?: unknown}} */ (reason).code === "native_queue_removed";
}

/** @param {unknown} value */
function isInstrumented(value) {
  return typeof value === "object"
    && value !== null
    && value[LIVE_INPUT_INSTRUMENTED] === true;
}
