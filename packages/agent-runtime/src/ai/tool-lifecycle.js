// Provider-neutral lifecycle persistence gate. Provider bridges may emit their
// own exact `tool_lifecycle` hint; absent fidelity falls back conservatively to
// success/error and never infers terminal state from prose.

// @ts-check

const FAILURE_KINDS = new Set([
  "provider_unavailable", "provider_unavailable_exhausted", "provider_auth", "skipped_capability_mismatch",
  "context_limit", "usage_limit", "process_death", "runtime_error", "cancelled", "cancelled_user",
  "cancelled_stale", "cancelled_shutdown", "cancelled_signal",
]);
const HOST_HISTORY_METADATA = Symbol("mono-agent.host-tool-history");
const HOST_TOOL_LIFECYCLE_METADATA = Symbol("mono-agent.host-tool-lifecycle");

/**
 * @param {{sink?: (event: any) => Promise<any>, onObserve?: (event: any) => void, onEvent?: (event: any) => void, abortSignal?: AbortSignal}} options
 */
export function createToolLifecycleEventGate({ sink, onObserve, onEvent, abortSignal }) {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  let pendingDeliveries = 0;
  /** @type {Map<string, any>} */
  const timing = new Map();
  /** @type {Map<string, any>} */
  const approvals = new Map();

  const emit = (event) => {
    stripProviderLifecycleMetadata(event);
    try { onObserve?.(event); } catch { /* observer callback semantics remain best-effort */ }
    const requiresPersistence = typeof sink === "function" && eventNeedsPersistence(event);
    if (!requiresPersistence && pendingDeliveries === 0) {
      observeClassification(event, timing, approvals);
      try { onEvent?.(event); } catch { /* host callback semantics remain best-effort */ }
      return;
    }

    pendingDeliveries += 1;
    const delivery = tail.then(async () => {
      observeClassification(event, timing, approvals);
      if (requiresPersistence) {
        await persistEvent(event, sink, { timing, approvals, abortSignal });
      }
      try { onEvent?.(event); } catch { /* host callback semantics remain best-effort */ }
    }).catch((error) => {
      if (requiresPersistence) attachPersistenceFailure(event, error);
      try { onEvent?.(event); } catch { /* host callback semantics remain best-effort */ }
    });
    tail = delivery.finally(() => { pendingDeliveries -= 1; });
  };

  return {
    emit,
    async flush() { await tail; },
  };
}

/** @param {any} event */
function eventNeedsPersistence(event) {
  if (!record(event) || (event.type !== "assistant" && event.type !== "user")) return false;
  const message = event.message;
  if (!record(message) || !Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (!record(block) || hostHistoryMetadata(block.history)) return false;
    if (event.type === "assistant" && block.type === "tool_use") {
      return typeof block.id === "string" && typeof block.name === "string";
    }
    if (event.type === "user" && block.type === "tool_result") {
      return typeof block.tool_use_id === "string" || typeof block.tool_call_id === "string";
    }
    return false;
  });
}

/**
 * Pi-native exact classifier. It consumes structured tool result details, not
 * error text, so timeout/signal/non-zero/cancellation fidelity cannot drift
 * with provider wording.
 * @param {{result?: any,isError?: boolean,aborted?: boolean,approval?: any}} input
 */
export function classifyPiToolResult(input) {
  const outcome = input.result?.details?.outcome;
  const outcomeFailureKind = failureKind(outcome?.failureKind);
  if (input.approval?.reason === "approval_timeout") {
    return terminal("timeout", "runtime_error", "approval_timeout");
  }
  if (input.approval?.decision === "deny") {
    return terminal("rejected", "runtime_error", boundedCode(input.approval.reason || "approval_denied"));
  }
  if (outcome?.timedOut === true || outcome?.timed_out === true || outcome?.code === "timeout") {
    return terminal("timeout", "runtime_error", "tool_timeout");
  }
  if (typeof outcome?.signal === "string" && outcome.signal.length > 0) {
    return terminal("signal", "process_death", boundedCode(outcome.signal));
  }
  const exitCode = Number(outcome?.exitCode ?? outcome?.exit_code);
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    return terminal("exit_nonzero", "runtime_error", `exit_${String(exitCode)}`);
  }
  if (outcome?.code === "aborted" || input.aborted && input.isError && !failureOutranksAbort(outcomeFailureKind)) {
    return terminal("cancelled", "cancelled", "abort_signal");
  }
  if (input.isError || outcome?.status === "error") {
    return terminal("error", outcomeFailureKind, boundedCode(outcome?.code || "runtime_error"));
  }
  return terminal("success", undefined, undefined);
}

/** @param {any} event @param {Map<string,any>} timing @param {Map<string,any>} approvals */
function observeClassification(event, timing, approvals) {
  if (!record(event)) return;
  if (event.type === "tool_timing" && typeof event.tool_use_id === "string") {
    timing.set(event.tool_use_id, event);
  }
  if (event.type === "tool_approval_denied" && typeof event.toolUseId === "string") {
    approvals.set(event.toolUseId, event);
  }
}

/** @param {any} event @param {(event:any)=>Promise<any>} sink @param {{timing:Map<string,any>,approvals:Map<string,any>,abortSignal?:AbortSignal}} context */
async function persistEvent(event, sink, context) {
  if (!record(event) || (event.type !== "assistant" && event.type !== "user")) return;
  const message = event.message;
  if (!record(message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!record(block)) continue;
    if (event.type === "assistant" && block.type === "tool_use") {
      if (hostHistoryMetadata(block.history)) continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      const persisted = await safePersist(sink, {
        phase: "invocation",
        toolCallId: block.id,
        toolName: block.name,
        ...(Object.hasOwn(block, "input") ? { arguments: block.input } : {}),
      });
      block.history = historyMetadata(persisted, undefined);
      continue;
    }
    if (event.type === "user" && block.type === "tool_result") {
      if (hostHistoryMetadata(block.history)) continue;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id
        : typeof block.tool_call_id === "string" ? block.tool_call_id : undefined;
      if (id === undefined) continue;
      const classified = classifyGenericResult(block, context.timing.get(id), context.approvals.get(id), context.abortSignal);
      const persisted = await safePersist(sink, {
        phase: "result",
        toolCallId: id,
        ...(typeof block.name === "string" ? { toolName: block.name } : {}),
        ...(Object.hasOwn(block, "content") ? { content: block.content } : {}),
        ...classified,
        ...(typeof context.timing.get(id)?.execution_ms === "number"
          ? { executionMs: context.timing.get(id).execution_ms }
          : {}),
        artifacts: artifactPaths(block),
      });
      block.history = historyMetadata(persisted, classified.state);
      context.timing.delete(id);
      context.approvals.delete(id);
    }
  }
}

/** @param {any} block @param {any} timing @param {any} approval @param {AbortSignal|undefined} abortSignal */
function classifyGenericResult(block, timing, approval, abortSignal) {
  const explicit = hostToolLifecycleMetadata(block.tool_lifecycle)
    ? block.tool_lifecycle
    : hostToolLifecycleMetadata(timing?.tool_lifecycle)
      ? timing.tool_lifecycle
      : undefined;
  // A failure kind only outranks host cancellation when its trusted hint also
  // supplies the terminal error state required by the lifecycle contract.
  const explicitFailureOutranksAbort = record(explicit)
    && explicit.state === "error"
    && failureOutranksAbort(explicit.failure_kind);
  if (approval?.reason === "approval_timeout") return terminal("timeout", "runtime_error", "approval_timeout");
  if (approval?.decision === "deny") return terminal("rejected", "runtime_error", boundedCode(approval.reason || "approval_denied"));
  if (record(explicit) && terminalState(explicit.state) && explicit.state !== "error") {
    return explicit.state === "success"
      ? terminal("success", undefined, undefined)
      : terminal(
          explicit.state,
          explicit.state === "cancelled" && abortSignal?.aborted
            ? cancellationFailureKind(abortSignal)
            : lifecycleFailureKind(explicit.state, explicit.failure_kind),
          boundedCode(explicit.detail_code || explicit.state),
        );
  }
  if (timing?.timed_out === true) return terminal("timeout", "runtime_error", "tool_timeout");
  if (typeof timing?.signal === "string" && timing.signal.length > 0) return terminal("signal", "process_death", boundedCode(timing.signal));
  if (Number.isFinite(Number(timing?.exit_code)) && Number(timing.exit_code) !== 0) {
    return terminal("exit_nonzero", "runtime_error", `exit_${String(Number(timing.exit_code))}`);
  }
  if (
    abortSignal?.aborted
    && block.is_error === true
    && !explicitFailureOutranksAbort
  ) {
    return terminal("cancelled", cancellationFailureKind(abortSignal), "abort_signal");
  }
  if (record(explicit) && explicit.state === "error") {
    return terminal("error", failureKind(explicit.failure_kind), boundedCode(explicit.detail_code || "provider_error"));
  }
  if (block.is_error === true || timing?.is_error === true) return terminal("error", failureKind(explicit?.failure_kind), boundedCode(explicit?.detail_code || "provider_error"));
  return terminal("success", undefined, undefined);
}

/** @param {(event:any)=>Promise<any>} sink @param {any} event */
async function safePersist(sink, event) {
  try {
    return await sink(event) ?? { persistence: "failed", errorCode: "history_writer_unavailable" };
  } catch (error) {
    return { persistence: "failed", errorCode: error?.code || "history_write_failed" };
  }
}

/** @param {any} persisted @param {string|undefined} terminalStateValue */
export function historyMetadata(persisted, terminalStateValue) {
  const metadata = {
    ...(typeof persisted?.recordId === "string" ? { recordId: persisted.recordId } : {}),
    ...(Number.isFinite(Number(persisted?.sequence)) ? { sequence: Number(persisted.sequence) } : {}),
    persistence: persisted?.persistence === "persisted" ? "persisted" : "failed",
    ...(terminalStateValue === undefined ? {} : { terminalState: terminalStateValue }),
    ...(typeof persisted?.truncated === "boolean" ? { truncated: persisted.truncated } : {}),
    ...(Number.isFinite(Number(persisted?.originalBytes)) ? { originalBytes: Number(persisted.originalBytes) } : {}),
    ...(Number.isFinite(Number(persisted?.retainedBytes)) ? { retainedBytes: Number(persisted.retainedBytes) } : {}),
    ...(Array.isArray(persisted?.artifactReferences) ? { artifactReferences: persisted.artifactReferences } : {}),
    ...(typeof persisted?.errorCode === "string" ? { errorCode: persisted.errorCode } : {}),
    untrusted: true,
  };
  Object.defineProperty(metadata, HOST_HISTORY_METADATA, { value: true });
  return metadata;
}

/** Mark a provider adapter's host-derived structured outcome as trusted input to the gate. @param {any} value */
export function toolLifecycleMetadata(value) {
  const metadata = record(value) ? { ...value } : {};
  Object.defineProperty(metadata, HOST_TOOL_LIFECYCLE_METADATA, { value: true });
  return metadata;
}

/** Provider payloads cannot assert host persistence or choose a terminal state. @param {any} event */
function stripProviderLifecycleMetadata(event) {
  if (!record(event) || !record(event.message) || !Array.isArray(event.message.content)) return;
  for (const block of event.message.content) {
    if (!record(block) || (block.type !== "tool_use" && block.type !== "tool_result")) continue;
    if (Object.hasOwn(block, "history") && !hostHistoryMetadata(block.history)) delete block.history;
    if (Object.hasOwn(block, "tool_lifecycle") && !hostToolLifecycleMetadata(block.tool_lifecycle)) {
      delete block.tool_lifecycle;
    }
  }
}

/** @param {any} value */
function hostHistoryMetadata(value) {
  return record(value) && value[HOST_HISTORY_METADATA] === true;
}

/** @param {any} value */
function hostToolLifecycleMetadata(value) {
  return record(value) && value[HOST_TOOL_LIFECYCLE_METADATA] === true;
}

/** @param {any} event @param {unknown} error */
function attachPersistenceFailure(event, error) {
  if (!record(event) || !record(event.message) || !Array.isArray(event.message.content)) return;
  for (const block of event.message.content) {
    if (record(block) && (block.type === "tool_use" || block.type === "tool_result")) {
      const candidate = /** @type {any} */ (error);
      const code = record(candidate) && typeof candidate.code === "string" ? candidate.code : "history_write_failed";
      block.history = historyMetadata({ persistence: "failed", errorCode: code }, undefined);
    }
  }
}

/** @param {any} block */
function artifactPaths(block) {
  const paths = new Set();
  collectPaths(block.raw_result?.details?.tool_payload_saved_paths, paths);
  collectPaths(block.raw_result?.tool_payload_saved_paths, paths);
  collectPaths(block.tool_payload_saved_paths, paths);
  return [...paths].slice(0, 32).map((path) => ({ path }));
}

/** @param {any} value @param {Set<string>} paths */
function collectPaths(value, paths) {
  if (typeof value === "string" && value.length > 0) paths.add(value);
  else if (Array.isArray(value)) for (const item of value) collectPaths(item, paths);
}

/** @param {string} state @param {string|undefined} failureKindValue @param {string|undefined} detailCode */
function terminal(state, failureKindValue, detailCode) {
  return {
    state,
    ...(failureKindValue === undefined ? {} : { failureKind: failureKindValue }),
    ...(detailCode === undefined ? {} : { detailCode }),
  };
}

/** @param {any} value */
function failureKind(value) {
  return typeof value === "string" && FAILURE_KINDS.has(value) ? value : "runtime_error";
}

/** @param {string} state @param {any} value */
function lifecycleFailureKind(state, value) {
  if (typeof value === "string" && FAILURE_KINDS.has(value)) return value;
  if (state === "signal" || state === "interrupted") return "process_death";
  return state === "cancelled" ? "cancelled" : "runtime_error";
}

/** @param {any} value */
function failureOutranksAbort(value) {
  const kind = failureKind(value);
  return kind !== "runtime_error" && !kind.startsWith("cancelled");
}

/** @param {AbortSignal} signal */
function cancellationFailureKind(signal) {
  const reason = String(signal.reason?.kind || signal.reason?.code || signal.reason || "").toLocaleLowerCase();
  if (reason.includes("shutdown")) return "cancelled_shutdown";
  if (reason.includes("stale")) return "cancelled_stale";
  if (reason.includes("signal")) return "cancelled_signal";
  if (reason.includes("user")) return "cancelled_user";
  return "cancelled";
}

/** @param {any} value */
function terminalState(value) {
  return ["success", "rejected", "error", "exit_nonzero", "timeout", "signal", "cancelled", "interrupted"].includes(value);
}

/** @param {any} value */
function boundedCode(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160) || "unknown";
}

/** @param {any} value */
function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
