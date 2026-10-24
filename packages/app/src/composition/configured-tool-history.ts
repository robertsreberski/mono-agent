import { createContinuityParticipant, acquireToolHistoryWriter, ToolHistoryReader, toolHistoryLogicalConversationId } from "@mono-agent/conversation";
import type { ContinuityPublicationWriter, ConversationHistoryContinuityParticipant, ConversationHarnessToolHistoryOptions, ToolHistoryWriterHandle } from "@mono-agent/conversation";

interface LazyConfiguredToolHistoryOptions {
  readonly root: string;
  readonly artifactRoot: string;
  readonly continuityEnabled?: boolean;
  readonly rollover: "none" | "daily" | undefined;
  readonly onWarning?: (message: string) => void;
  /** Internal seam for deterministic acquisition-retry tests. */
  readonly acquireWriter?: typeof acquireToolHistoryWriter;
  /** Internal seam for deterministic progressive post-failure backoff tests. */
  readonly acquisitionFailureBackoffMs?: number;
  /** Internal seam for the bounded progressive-backoff ceiling. */
  readonly acquisitionFailureBackoffMaxMs?: number;
  /** Internal monotonic-enough clock seam; production uses wall time. */
  readonly now?: () => number;
}

interface ConfiguredWriterAttempt {
  promise: Promise<ToolHistoryWriterHandle>;
  failurePromise?: Promise<ToolHistoryWriterHandle>;
  handle?: ToolHistoryWriterHandle;
  failed: boolean;
  retryAtMs?: number;
  retired: boolean;
}

interface ConfiguredTurnWriterState {
  readonly generation: number;
  attempt?: ConfiguredWriterAttempt;
  failure?: Promise<ToolHistoryWriterHandle>;
}

const TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MS = 30_000;
const TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export function lazyConfiguredToolHistory(
  options: LazyConfiguredToolHistoryOptions,
): ConversationHarnessToolHistoryOptions & { readonly continuity?: ConversationHistoryContinuityParticipant } {
  const failureBackoffMs = options.acquisitionFailureBackoffMs
    ?? TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MS;
  if (!Number.isSafeInteger(failureBackoffMs) || failureBackoffMs < 1) {
    throw new TypeError("tool history acquisition failure backoff must be a positive integer.");
  }
  const failureBackoffMaxMs = options.acquisitionFailureBackoffMaxMs
    ?? Math.max(TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MAX_MS, failureBackoffMs);
  if (
    !Number.isSafeInteger(failureBackoffMaxMs)
    || failureBackoffMaxMs < failureBackoffMs
  ) {
    throw new TypeError("tool history acquisition failure backoff maximum must be an integer at least as large as the initial backoff.");
  }
  const now = options.now ?? Date.now;
  let sharedAttempt: ConfiguredWriterAttempt | undefined;
  let latestTurnGeneration = 0;
  const turnStates = new Map<string, ConfiguredTurnWriterState>();
  let resetTail: Promise<void> = Promise.resolve();
  let retirementTail: Promise<void> = Promise.resolve();
  let acquisitionOutage = false;
  let consecutiveAcquisitionFailures = 0;
  const reader = new ToolHistoryReader(options.root);
  const warn = (message: string): void => {
    try { options.onWarning?.(message); } catch { /* diagnostics are best-effort */ }
  };
  const turnKey = (conversationId: string, runId: string): string =>
    JSON.stringify([conversationId, runId]);
  const stateFor = (conversationId: string, runId: string): ConfiguredTurnWriterState => {
    const key = turnKey(conversationId, runId);
    const existing = turnStates.get(key);
    if (existing !== undefined) return existing;
    const state: ConfiguredTurnWriterState = { generation: ++latestTurnGeneration };
    if (
      sharedAttempt?.failed === true
      && sharedAttempt.retryAtMs !== undefined
      && now() < sharedAttempt.retryAtMs
    ) {
      state.attempt = sharedAttempt;
    }
    turnStates.set(key, state);
    return state;
  };
  const failedPromise = (code: string): Promise<ToolHistoryWriterHandle> => {
    const error = Object.assign(new Error("Tool history writer became unavailable; a fresh boundary must reacquire it."), { code });
    const failure = Promise.reject<ToolHistoryWriterHandle>(error);
    void failure.catch(() => undefined);
    return failure;
  };
  const nextFailureBackoffMs = (): number => {
    let backoffMs = failureBackoffMs;
    for (let index = 0; index < consecutiveAcquisitionFailures && backoffMs < failureBackoffMaxMs; index += 1) {
      backoffMs = backoffMs > Math.floor(failureBackoffMaxMs / 2)
        ? failureBackoffMaxMs
        : Math.min(failureBackoffMaxMs, backoffMs * 2);
    }
    consecutiveAcquisitionFailures += 1;
    return backoffMs;
  };
  const retire = (attempt: ConfiguredWriterAttempt): void => {
    if (attempt.retired || attempt.handle === undefined) return;
    attempt.retired = true;
    retirementTail = retirementTail.then(async () => {
      try { await attempt.handle?.release(); } catch { /* replacement acquisition must remain armed */ }
    });
  };
  const latchExistingTurns = (
    attempt: ConfiguredWriterAttempt,
    failure: Promise<ToolHistoryWriterHandle>,
  ): void => {
    const failedThrough = latestTurnGeneration;
    for (const state of turnStates.values()) {
      if (state.generation > failedThrough) continue;
      if (state.attempt === undefined || state.attempt === attempt) state.failure = failure;
    }
  };
  const invalidate = (attempt: ConfiguredWriterAttempt, code: string): Promise<ToolHistoryWriterHandle> => {
    if (attempt.failed) return attempt.failurePromise ?? attempt.promise;
    const failure = failedPromise(code);
    attempt.failed = true;
    attempt.failurePromise = failure;
    attempt.retryAtMs = now() + nextFailureBackoffMs();
    latchExistingTurns(attempt, failure);
    retire(attempt);
    if (sharedAttempt === attempt) {
      sharedAttempt = {
        promise: failure,
        failurePromise: failure,
        failed: true,
        retryAtMs: attempt.retryAtMs,
        retired: true,
      };
    }
    acquisitionOutage = true;
    return failure;
  };
  const startAttempt = (): ConfiguredWriterAttempt => {
    const acquisition = retirementTail.then(async () => await (options.acquireWriter ?? acquireToolHistoryWriter)({
      root: options.root,
      ...(options.continuityEnabled === true ? { continuityEnabled: true } : {}),
      artifactRoot: options.artifactRoot,
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    }));
    const attempt: ConfiguredWriterAttempt = {
      promise: acquisition,
      failed: false,
      retired: false,
    };
    attempt.promise = acquisition.then((handle) => {
      attempt.handle = handle;
      consecutiveAcquisitionFailures = 0;
      if (acquisitionOutage) {
        warn("Tool history writer acquisition recovered; lifecycle persistence resumed.");
      }
      acquisitionOutage = false;
      return handle;
    }).catch((error: unknown) => {
      attempt.failed = true;
      attempt.failurePromise = attempt.promise;
      const retryBackoffMs = nextFailureBackoffMs();
      attempt.retryAtMs = now() + retryBackoffMs;
      latchExistingTurns(attempt, attempt.promise);
      if (!acquisitionOutage) {
        acquisitionOutage = true;
        warn(`Tool history writer acquisition failed (${toolHistoryAcquisitionErrorCode(error)}); new turns fail fast for ${String(retryBackoffMs)} ms and repeated failures back off to ${String(failureBackoffMaxMs)} ms, while explicit reset may retry immediately.`);
      }
      throw error;
    });
    void attempt.promise.catch(() => undefined);
    sharedAttempt = attempt;
    return attempt;
  };
  const selectAttempt = (bypassFailureBackoff: boolean): ConfiguredWriterAttempt => {
    if (sharedAttempt !== undefined) {
      if (sharedAttempt.handle?.writer.isClosed === true) {
        invalidate(sharedAttempt, "history_writer_closed");
      }
      const withinFailureBackoff = sharedAttempt.retryAtMs !== undefined
        && now() < sharedAttempt.retryAtMs;
      if (
        !sharedAttempt.failed
        || (!bypassFailureBackoff && withinFailureBackoff)
      ) {
        return sharedAttempt;
      }
      sharedAttempt = undefined;
    }
    return startAttempt();
  };
  const acquireForTurn = async (state: ConfiguredTurnWriterState): Promise<ToolHistoryWriterHandle> => {
    if (state.failure !== undefined) return await state.failure;
    state.attempt ??= selectAttempt(false);
    const handle = await state.attempt.promise;
    if (handle.writer.isClosed) {
      state.failure = invalidate(state.attempt, "history_writer_closed");
      return await state.failure;
    }
    return handle;
  };
  const writer: ConversationHarnessToolHistoryOptions["writer"] = {
    createSink(binding) {
      const state = stateFor(binding.conversationId, binding.runId);
      return async (event) => {
        const handle = await acquireForTurn(state);
        try {
          const result = await handle.writer.persist(binding, event);
          const terminalCode = terminalToolHistoryWriterFailureCode(result, handle);
          if (terminalCode !== undefined && state.attempt !== undefined) {
            state.failure = invalidate(state.attempt, terminalCode);
          }
          return result;
        } catch (error) {
          const terminalCode = terminalToolHistoryWriterFailureCode(error, handle);
          if (terminalCode !== undefined && state.attempt !== undefined) {
            state.failure = invalidate(state.attempt, terminalCode);
          }
          throw error;
        }
      };
    },
    async finishRun(binding, status, failureKind, cancellationReasonCode) {
      const key = turnKey(binding.conversationId, binding.runId);
      const state = turnStates.get(key);
      try {
        if (state?.attempt === undefined || state.failure !== undefined) return;
        const handle = await state.attempt.promise.catch(() => undefined);
        try {
          await handle?.writer.finishRun(binding, status, failureKind, cancellationReasonCode);
        } catch (error) {
          if (handle === undefined) return;
          const terminalCode = terminalToolHistoryWriterFailureCode(error, handle);
          if (terminalCode === undefined) throw error;
          invalidate(state.attempt, terminalCode);
          return;
        }
        const terminalCode = handle === undefined
          ? undefined
          : terminalToolHistoryWriterFailureCode(undefined, handle);
        if (terminalCode !== undefined) invalidate(state.attempt, terminalCode);
      } finally {
        turnStates.delete(key);
      }
    },
    async resetConversation(logicalConversationId) {
      const reset = resetTail.then(async () => {
        if (!await reader.exists()) return;
        // Reset is serialized and host-explicit, so it may bypass only the
        // progressive post-failure cooldown. It still reuses a healthy/pending handle
        // and every fresh acquisition keeps the full restart-handoff ceiling.
        const observedAttempt = sharedAttempt;
        if (observedAttempt !== undefined && !observedAttempt.failed) {
          await observedAttempt.promise.catch(() => undefined);
        }
        let recoveryRetriesRemaining = 1;
        for (;;) {
          const attempt = selectAttempt(true);
          const handle = await attempt.promise;
          try {
            await handle.writer.resetConversation(logicalConversationId);
          } catch (error) {
            const terminalCode = reportedToolHistoryWriterFailureCode(error);
            if (terminalCode === undefined) {
              if (handle.writer.isClosed) invalidate(attempt, "history_writer_closed");
              throw error;
            }
            invalidate(attempt, terminalCode);
            if (recoveryRetriesRemaining === 0) throw error;
            recoveryRetriesRemaining -= 1;
            continue;
          }
          const terminalCode = terminalToolHistoryWriterFailureCode(undefined, handle);
          if (terminalCode !== undefined) invalidate(attempt, terminalCode);
          // A resolved reset was acknowledged only after its transaction
          // committed. Retire a concurrently closed handle, but never open a
          // second destructive reset window for an operation that succeeded.
          return;
        }
      });
      resetTail = reset.then(
        () => undefined,
        () => undefined,
      );
      await reset;
    },
  };
  const continuityCall = async <T>(operation: (writer: ToolHistoryWriterHandle["writer"]) => Promise<T>): Promise<T> => {
    const attempt = selectAttempt(false), handle = await attempt.promise;
    if (handle.writer.isClosed) {
      await invalidate(attempt, "history_writer_closed");
      throw new Error("Tool history writer closed before continuity mutation.");
    }
    try { return await operation(handle.writer); }
    catch (error) {
      const terminalCode = terminalToolHistoryWriterFailureCode(error, handle);
      if (terminalCode !== undefined) invalidate(attempt, terminalCode);
      throw error;
    }
  };
  const continuityWriter: ContinuityPublicationWriter = {
    prepareContinuity: async (input) => await continuityCall(async (writer) => await writer.prepareContinuity(input)),
    commitContinuity: async (input) => await continuityCall(async (writer) => await writer.commitContinuity(input)),
    reconcileContinuity: async (input) => await continuityCall(async (writer) => await writer.reconcileContinuity(input)),
    resetConversation: async (id) => await writer.resetConversation!(id),
  };
  return {
    ...(options.continuityEnabled === true ? { continuity: createContinuityParticipant({ writer: continuityWriter,
      logicalConversationId: (id) => toolHistoryLogicalConversationId(id, options.rollover),
      protectedConversations: () => reader.protectedContinuityConversations(), onWarning: warn }) } : {}),
    writer,
    reader,
    logicalConversationId: (conversationId) =>
      toolHistoryLogicalConversationId(conversationId, options.rollover),
    async release(): Promise<void> {
      const attempt = sharedAttempt;
      sharedAttempt = undefined;
      if (attempt !== undefined) {
        await attempt.promise.catch(() => undefined);
        retire(attempt);
      }
      await retirementTail;
    },
  };
}

function terminalToolHistoryWriterFailureCode(
  value: unknown,
  handle: ToolHistoryWriterHandle,
): string | undefined {
  return reportedToolHistoryWriterFailureCode(value)
    ?? (handle.writer.isClosed ? "history_writer_closed" : undefined);
}

function reportedToolHistoryWriterFailureCode(value: unknown): string | undefined {
  const candidate = typeof value === "object" && value !== null
    ? "errorCode" in value
      ? (value as { readonly errorCode?: unknown }).errorCode
      : "code" in value
        ? (value as { readonly code?: unknown }).code
        : undefined
    : undefined;
  if (candidate === "history_writer_closed") return candidate;
  return undefined;
}

function toolHistoryAcquisitionErrorCode(error: unknown): string {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof candidate === "string" && /^history_[a-z0-9_]+$/u.test(candidate)
    ? candidate
    : "history_writer_unavailable";
}
