import type { RuntimeEventLike } from "@mono-agent/observability";
import type { AgentLiveInputOffer, AgentLiveInputRequest } from "@mono-agent/agent-contracts";
import { randomUUID } from "node:crypto";
import {
  monoRuntimeSupportsSessionResume,
  type RuntimeResult,
} from "@mono-agent/runtime-adapter";

import type { BuiltAgentContext } from "./context/index.js";
import { NoopRunRecorder } from "./recorder.js";
import { createLiveSessionManager } from "./live-session.js";
import type { LiveSessionManager, LiveSessionRunLifecycle } from "./live-session.js";
import { createLiveInputMailbox } from "./live-input.js";
import type { LiveInputMailbox } from "./live-input.js";
import { createSemaphore } from "./semaphore.js";
import type { Semaphore } from "./semaphore.js";
import { createRuntimeSessionStore } from "./sessions.js";
import type {
  RuntimeSessionRecord,
  RuntimeSessionSnapshot,
  RuntimeSessionStore,
} from "./sessions.js";
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessRequest,
  AgentHarnessResponse,
  AgentHarnessSessionEvent,
  ConversationHistoryProviderSessionTurn,
  PreparedHistoryAppend,
} from "./types.js";
import type { AgentHarnessContinuationClaimCapability } from "./types.js";
import { createSkillsCache } from "./skills/index.js";
import type { SkillsCache } from "./skills/index.js";
import { applyHarnessAttachments } from "./harness/attachments.js";
import { loadHarnessHistory, prepareHarnessContext } from "./harness/context-preparation.js";
import { AgentHarnessError } from "./harness/error.js";
import {
  activateContinuationOriginContexts,
  buildContinuationOriginContext,
  continuationCapabilitiesRequiringOriginContext,
  finalizeContinuationOriginContexts,
} from "./harness/mcp-context.js";
import { buildSuccessfulTurn, persistSuccessfulMemory } from "./harness/memory-persistence.js";
import {
  createDefaultRunId,
  isCronRequest,
  requestOverridesModel,
  runSourceFromRequest,
} from "./harness/request-routing.js";
import {
  cancellationFailureKind,
  commitRecorderFinish,
  failureFromRuntimeResult,
  failureFromThrownError,
  failureResponse,
  normalizeAssistantText,
  responseMetadata,
  safeRecorderCancel,
  safeRecorderCommitFinish,
  safeRecorderFail,
  shouldRetrySessionResumeError,
  shouldRetryWithoutSession,
} from "./harness/run-results.js";
import { runHarnessRuntime } from "./harness/runtime-execution.js";
import { sessionEventFromRecord, withSessionBoundaryTimestamp } from "./harness/session-events.js";
import { retireRunResultSession } from "./harness/session-retirement.js";
import { validateOptions, validateRequest } from "./harness/validation.js";
import { appendVerbatimHistoryTurn } from "./harness/verbatim-history.js";

export { AgentHarnessError };
export { requestOverridesModel, runSourceFromRequest };

const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_WARNING =
  "Agent shutdown timed out while draining active runs; provider sessions and tool-history persistence were forcibly released.";

interface MonoAgentHarnessInternalOptions {
  /** Deterministic test seam; production callers use the bounded default. */
  readonly shutdownDrainTimeoutMs?: number;
}

export class MonoAgentHarness implements AgentHarness {
  private readonly options: AgentHarnessOptions;
  private readonly sessionStore: RuntimeSessionStore | undefined;
  private readonly liveSessionManager: LiveSessionManager | undefined;
  private readonly activeLiveInputs = new Map<string, LiveInputMailbox>();
  private readonly skillsCache: SkillsCache;
  private readonly runLimiter: Semaphore | undefined;
  // Admission bound (maxPendingRuns): a cheap synchronous counter of runs that
  // are admitted but have NOT yet begun their provider call (still doing — or
  // waiting to do — the expensive pre-provider work: attachment persistence +
  // context prep, then waiting for a provider slot). It gates BEFORE that work
  // so over-capacity requests fail fast. This is deliberately NOT the runLimiter
  // semaphore, whose waiter queue is unbounded — see the concurrency JSDoc on
  // AgentHarnessOptions.
  private readonly maxPendingRuns: number | undefined;
  private pendingRuns = 0;
  private supportsResumeCache: boolean | undefined;
  private activeRuns = 0;
  private readonly activeRunWaiters = new Set<() => void>();
  private readonly activeRunWarningSinks = new Set<(event: RuntimeEventLike) => void>();
  private readonly shutdownDrainTimeoutMs: number;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(options: AgentHarnessOptions, internalOptions: MonoAgentHarnessInternalOptions = {}) {
    validateOptions(options);
    this.options = options;
    const shutdownDrainTimeoutMs = internalOptions.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(shutdownDrainTimeoutMs) || shutdownDrainTimeoutMs <= 0) {
      throw new TypeError("shutdownDrainTimeoutMs must be a positive safe integer.");
    }
    this.shutdownDrainTimeoutMs = shutdownDrainTimeoutMs;
    // Skills are otherwise re-read from disk every turn. A per-harness cache
    // (or a shared one passed in) skips unchanged reads across turns.
    this.skillsCache = options.skillsCache ?? createSkillsCache();
    this.sessionStore = options.session?.mode === "continuous"
      ? createRuntimeSessionStore({
        idleTimeoutMs: options.session.idleTimeoutMs,
        onEvict: async (record, reason) => {
          this.publishSessionEvent(sessionEventFromRecord("evicted", record, reason, this.sessionStoreSnapshot()));
          await this.options.runtime.disposeSession?.(record.providerSessionId);
        },
      })
      : undefined;
    // Continuous mode serializes same-conversation turns through a queue so a
    // follow-up arriving mid-run is answered on the warm session after the
    // current turn (queue-after-turn), instead of racing fresh.
    this.liveSessionManager = options.session?.mode === "continuous"
      ? createLiveSessionManager({ run: (request, lifecycle) => this.run(request, lifecycle) })
      : undefined;
    const maxConcurrentRuns = options.concurrency?.maxConcurrentRuns;
    this.runLimiter = typeof maxConcurrentRuns === "number" && maxConcurrentRuns > 0
      ? createSemaphore(maxConcurrentRuns)
      : undefined;
    const maxPendingRuns = options.concurrency?.maxPendingRuns;
    this.maxPendingRuns = typeof maxPendingRuns === "number" && maxPendingRuns > 0
      ? Math.floor(maxPendingRuns)
      : undefined;
  }

  async submit(request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
    this.assertAcceptingRuns();
    if (this.liveSessionManager !== undefined) {
      return this.liveSessionManager.enqueue(request.conversationId, request);
    }
    return this.run(request);
  }

  offerLiveInput(request: AgentLiveInputRequest): AgentLiveInputOffer {
    return this.activeLiveInputs.get(request.conversationId)?.offer(request)
      ?? { status: "unavailable", reason: "inactive" };
  }

  cancel(conversationId: string, reason?: unknown): void {
    this.activeLiveInputs.get(conversationId)?.cancel();
    this.liveSessionManager?.cancel(conversationId, reason);
  }

  async resetConversation(conversationId: string): Promise<void> {
    if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
      throw new TypeError("conversationId must be a non-empty string.");
    }
    const normalized = conversationId.trim();
    const historyStore = this.options.historyStore;
    const logicalConversationId = this.options.toolHistory?.logicalConversationId(normalized) ?? normalized;
    if (
      historyStore !== undefined
      && logicalConversationId === normalized
      && historyStore.reset === undefined
    ) {
      throw new Error("The configured conversation history store does not support session reset.");
    }
    if (
      historyStore !== undefined
      && logicalConversationId !== normalized
      && historyStore.resetLogicalConversation === undefined
    ) {
      throw new Error("The configured conversation history store does not support logical session reset for rollover buckets.");
    }
    // The responder serializes this behind the cancelled turn. Evict the warm
    // handle first, then clear canonical message history and tool history for
    // the same logical session. The stores are deliberately separate (tool
    // records can exist without messages), so a partial failure is surfaced and
    // a retry is idempotent rather than acknowledged as success.
    await this.sessionStore?.evict(normalized, "stale");
    if (logicalConversationId === normalized) await historyStore?.reset?.(normalized);
    else await historyStore?.resetLogicalConversation?.(logicalConversationId);
    await this.options.toolHistory?.writer.resetConversation(logicalConversationId);
    // Identity/soul are already read per turn. Clearing the skill cache forces
    // installed skill metadata and content to be re-read on the next turn too.
    this.skillsCache.clear();
  }

  async appendVerbatimTurn(
    conversationId: string,
    text: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void> {
    await appendVerbatimHistoryTurn(this.options, this.sessionStore, conversationId, text, options);
  }

  async run(request: AgentHarnessRequest, lifecycle?: LiveSessionRunLifecycle): Promise<AgentHarnessResponse> {
    this.assertAcceptingRuns();
    this.activeRuns += 1;
    try {
      return await this.runActive(request, lifecycle);
    } finally {
      this.activeRuns -= 1;
      if (this.activeRuns === 0) {
        for (const resolve of this.activeRunWaiters) resolve();
        this.activeRunWaiters.clear();
      }
    }
  }

  private async runActive(
    request: AgentHarnessRequest,
    lifecycle?: LiveSessionRunLifecycle,
  ): Promise<AgentHarnessResponse> {
    validateRequest(request);
    const runId = this.options.createRunId?.() ?? createDefaultRunId();
    const runSource = runSourceFromRequest(request);
    // Proactive isolation (opt-in): a cron/proactive run is treated as a one-shot
    // ephemeral turn — it neither resumes nor persists the shared continuous
    // session, so its large tool dumps stay out of the interactive transcript.
    // Computed before recorder construction so even running/early-failed summaries
    // carry the run's session identity.
    //
    // A per-request MODEL override is isolated, regardless of the opt-in, ONLY
    // when it names a model DIFFERENT from the harness default: the turn runs on a
    // different model (often a different runtime) and the provider session is keyed
    // by conversationId + bound to a model, so resuming or persisting it against
    // the shared session would mix two models' lineage (durable-session corruption
    // / wrong-runtime disposal). Effort-only, same-model, and invalid overrides
    // leave the model chain unchanged, so they keep the shared session — matching
    // the runtime/session-key decision taken later in runRuntime.
    const proactiveIsolated = this.isProactiveIsolated(request);
    const modelOverrideIsolated = requestOverridesModel(request, this.options.model);
    const continuationIsolated = request.continuation !== undefined;
    const isolated = proactiveIsolated || modelOverrideIsolated || continuationIsolated;
    let liveInputMailbox: LiveInputMailbox | undefined;
    let liveInputCloseReason: "closed" | "failed" = "failed";
    let toolHistoryStatus: "succeeded" | "failed" | "cancelled" = "failed";
    const recorder = this.options.recorderFactory?.({
      runId,
      conversationId: request.conversationId,
      userInput: request.userMessage,
      isolated,
      ...(runSource.source === undefined ? {} : { source: runSource.source }),
      ...(runSource.sourceDetail === undefined ? {} : { sourceDetail: runSource.sourceDetail }),
    }) ?? new NoopRunRecorder({ runId, conversationId: request.conversationId, isolated });
    await recorder.start?.();

    if (request.abortSignal.aborted) {
      const summary = await recorder.finish({
        cancelled: true,
        failureKind: cancellationFailureKind(request.abortSignal),
      });
      return failureResponse({ runId, request, summary, kind: "cancelled", message: "Agent request was cancelled before runtime execution." });
    }

    // Global admission bound (maxPendingRuns): a cheap SYNCHRONOUS check before
    // any expensive pre-provider work (applyAttachments persists bytes to disk;
    // prepareContext loads history/recalls memory/reads skills/builds the
    // prompt). `pendingRuns` counts runs that are admitted but have NOT yet begun
    // their provider call — i.e. the requests simultaneously holding persisted
    // attachments + built context in memory while waiting for a provider slot in
    // the otherwise-unbounded semaphore queue. A request arriving when that
    // counter is already at the bound fails fast here instead of doing the
    // expensive work and parking. (A run executing at the provider does not count
    // — it left "pending" the moment its provider call started.)
    if (this.maxPendingRuns !== undefined && this.pendingRuns >= this.maxPendingRuns) {
      try {
        throw new AgentHarnessError(
          "capacity_exceeded",
          `Agent is at capacity (max ${this.maxPendingRuns} pending runs).`,
          { maxPendingRuns: this.maxPendingRuns },
        );
      } catch (error) {
        const failure = failureFromThrownError(error, false);
        const summary = await safeRecorderFail(recorder, error);
        return { metadata: responseMetadata(runId, request, undefined, summary), failure };
      }
    }
    liveInputMailbox = isolated || this.activeLiveInputs.has(request.conversationId)
      ? undefined
      : createLiveInputMailbox(runId);
    if (liveInputMailbox !== undefined) {
      this.activeLiveInputs.set(request.conversationId, liveInputMailbox);
    }
    const sessionRecord = !isolated && this.sessionsEnabled() ? this.sessionStore?.acquire(request.conversationId) : undefined;
    let context: BuiltAgentContext | undefined;
    const emit = (event: RuntimeEventLike): void => {
      recorder.onEvent(event);
      request.onEvent?.(event);
    };
    const emitShutdownWarning = (event: RuntimeEventLike): void => {
      try { recorder.onEvent(event); } catch { /* shutdown diagnostics are best-effort */ }
      try { request.onEvent?.(event); } catch { /* an event sink cannot block shutdown */ }
    };
    this.activeRunWarningSinks.add(emitShutdownWarning);
    // Admitted: count this run as pending until it begins its provider call (via
    // leavePending, fired from runRuntime) or exits before getting there. `left`
    // makes the release idempotent so exactly one decrement happens per run, on
    // every exit path including a throw in applyAttachments/prepareContext.
    this.pendingRuns += 1;
    let left = false;
    let conversationCommitStarted = false;
    const continuationCapabilities: AgentHarnessContinuationClaimCapability[] = [];
    let continuationOriginSettled = false;
    let preparedHistoryAppend: PreparedHistoryAppend | undefined;
    let providerHistoryTurn: ConversationHistoryProviderSessionTurn | undefined;
    let coordinatedProviderSessionId: string | undefined;
    let coordinatedProviderSessionRevision: number | undefined;
    let providerHistoryOwnershipTransferred = false;
    let providerSessionSynced = false;
    let coordinatedProviderAttemptEligibleForSync = false;
    let providerAttemptStarted = false;
    const providerAttemptSessionIds = new Set<string>();
    let runtimeResult: RuntimeResult | undefined;
    const leavePending = (): void => {
      if (!left) {
        left = true;
        this.pendingRuns -= 1;
      }
    };
    const noteProviderStart = (providerSessionId: string | undefined): void => {
      providerAttemptStarted = true;
      if (providerSessionId !== undefined) providerAttemptSessionIds.add(providerSessionId);
      leavePending();
    };
    const noteProviderResultSession = (providerSessionId: unknown): void => {
      if (typeof providerSessionId === "string" && providerSessionId.trim().length > 0) {
        providerAttemptSessionIds.add(providerSessionId);
      }
    };
    try {
      if (request.sessionBoundary !== undefined) {
        emit(withSessionBoundaryTimestamp(request.sessionBoundary, this.nowIso()));
      }
      if (isolated) {
        const reason = continuationIsolated
          ? "continuation"
          : proactiveIsolated
            ? "proactive"
            : "model_override";
        emit({
          type: "session_boundary",
          kind: "isolated",
          conversationId: request.conversationId,
          reason,
          timestamp: this.nowIso(),
        });
        this.publishSessionEvent({
          kind: "isolated",
          conversationId: request.conversationId,
          reason,
          snapshot: this.sessionStoreSnapshot(),
        });
      } else if (this.sessionsEnabled()) {
        if (sessionRecord === undefined) {
          this.publishSessionEvent({
            kind: "cold",
            conversationId: request.conversationId,
            snapshot: this.sessionStoreSnapshot(),
          });
        } else {
          this.publishSessionEvent(sessionEventFromRecord("acquired", sessionRecord, undefined, this.sessionStoreSnapshot()));
        }
      }
      // Persist any inbound attachments to disk and reference them in the
      // prompt so the agent opens them with its own file tools. The expanded
      // request (absolute paths + inlined document text) feeds the provider
      // call; `persistText` (original caption + redacted attachment metadata
      // only) is what we write to durable history/memory so the extracted
      // document body never leaks into future prompts or memory recall.
      const {
        request: activeRequest,
        persistUserMessage: persistText,
        attachmentContext,
      } = await applyHarnessAttachments(this.options, request, runId, emit);
      // Durable Pi transcripts are safe to resume across a restart only when the
      // canonical history store owns their epoch and dirty/clean transaction.
      // Merely hashing a conversation id is insufficient: a crash can persist Pi
      // JSONL before host history, and the stale transcript would then resurrect.
      // Custom history stores keep process-local warm sessions, but never receive
      // piSessionsRoot unless they implement this coordinator contract.
      const historyStore = this.options.historyStore;
      const beginProviderSessionTurn = historyStore?.beginProviderSessionTurn?.bind(historyStore);
      const durableProviderSessionsEnabled = !isolated
        && this.sessionsEnabled()
        && this.options.piSessionsRoot !== undefined
        && historyStore?.providerSessionRetirement === "fail-closed"
        && beginProviderSessionTurn !== undefined;
      if (durableProviderSessionsEnabled) {
        providerHistoryTurn = await beginProviderSessionTurn(request.conversationId, runId);
        coordinatedProviderSessionId = providerHistoryTurn.providerSessionId;
        coordinatedProviderSessionRevision = providerHistoryTurn.providerSessionRevision;
      }

      let resumeSessionId = providerHistoryTurn?.providerSessionId ?? sessionRecord?.providerSessionId;
      let providerAttributionSessionId = !isolated && this.sessionsEnabled()
        ? resumeSessionId ?? randomUUID()
        : undefined;
      const confirmedWarmSession = sessionRecord !== undefined
        && sessionRecord.providerSessionId === resumeSessionId
        && (providerHistoryTurn === undefined
          || sessionRecord.providerSessionRevision === providerHistoryTurn.providerSessionRevision);

      if (providerHistoryTurn !== undefined && !confirmedWarmSession) {
        // A durable coordinator can prove which epoch/revision is canonical,
        // but it cannot see module-global provider handles. Every unconfirmed
        // resume therefore needs a strict runtime refresh, including a newly
        // constructed harness whose local RuntimeSessionStore is empty. Without
        // this barrier, that harness could adopt an older live Pi object for the
        // same epoch and silently bypass the now-current JSONL on disk.
        if (this.options.runtime.refreshSession === undefined) {
          if (sessionRecord?.providerSessionId === providerHistoryTurn.providerSessionId) {
            this.sessionStore?.forget(request.conversationId, sessionRecord.providerSessionId);
          }
          throw new AgentHarnessError(
            "provider_session_refresh_unavailable",
            "A durable provider session cannot be cold-reopened safely by this runtime.",
          );
        }
        try {
          await this.options.runtime.refreshSession(providerHistoryTurn.providerSessionId);
        } catch (error) {
          if (sessionRecord?.providerSessionId === providerHistoryTurn.providerSessionId) {
            this.sessionStore?.forget(request.conversationId, sessionRecord.providerSessionId);
          }
          throw error;
        }
        if (sessionRecord?.providerSessionId === providerHistoryTurn.providerSessionId) {
          this.sessionStore?.forget(request.conversationId, sessionRecord.providerSessionId);
        }
      }

      if (sessionRecord !== undefined && !confirmedWarmSession) {
        if (
          providerHistoryTurn !== undefined
          && sessionRecord.providerSessionId === providerHistoryTurn.providerSessionId
        ) {
          // The strict durable refresh above already dropped this exact stale
          // mapping while preserving its provider-owned transcript.
        } else {
          // A dirty/migrated/missing host record rotates the provider epoch. Drop a
          // stale process-local mapping immediately; it can never be authoritative
          // for the newly-issued durable provider id.
          await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
            request.conversationId,
            sessionRecord,
            sessionRecord.providerSessionId,
          );
        }
      }

      // Omit history only for a confirmed live mapping to the exact epoch-owned
      // provider id. A cold durable reopen sends canonical history as structured
      // leading runtime messages: Pi seeds it when the JSONL is missing and skips
      // it on a true resume, avoiding both loss and duplicate prompt replay.
      let prepared = await prepareHarnessContext(this.options, this.skillsCache, activeRequest, {
        historyMode: confirmedWarmSession
          ? "omitted"
          : providerHistoryTurn === undefined
            ? "prompt"
            : "messages",
        turnId: runId,
      }, emit);
      context = prepared.context;

      let resumeError: unknown;
      try {
        coordinatedProviderAttemptEligibleForSync = providerHistoryTurn !== undefined
          && resumeSessionId === providerHistoryTurn.providerSessionId;
        runtimeResult = await runHarnessRuntime(
          this.options,
          this.runLimiter,
          this.sessionsEnabled(),
          activeRequest,
          recorder,
          context,
          prepared.memory,
          runId,
          resumeSessionId,
          providerAttributionSessionId,
          providerHistoryTurn === undefined ? undefined : this.options.piSessionsRoot,
          isolated,
          prepared.skillDisclosureEntries,
          prepared.history,
          prepared.historyOmitted,
          prepared.historyAsMessages,
          prepared.toolHistoryProjection,
          attachmentContext,
          continuationCapabilities,
          liveInputMailbox,
          () => noteProviderStart(resumeSessionId),
        );
        noteProviderResultSession(runtimeResult.providerSessionId);
      } catch (error) {
        if (resumeSessionId === undefined || request.abortSignal.aborted) {
          throw error;
        }
        resumeError = error;
      }

      if (resumeSessionId !== undefined && (shouldRetrySessionResumeError(resumeError) || shouldRetryWithoutSession(runtimeResult, request.abortSignal.aborted))) {
        const warning: RuntimeEventLike = {
          type: "runtime_warning",
          warning_kind: "session_resume_retry",
          message: `Provider session ${resumeSessionId} could not be resumed; retrying with conversation history.`,
          provider_session_id: resumeSessionId,
        };
        emit(warning);
        emit({
          type: "session_boundary",
          kind: "resume_replay",
          conversationId: request.conversationId,
          providerSessionId: resumeSessionId,
          reason: shouldRetrySessionResumeError(resumeError) ? "resume_error" : "runtime_result",
          timestamp: this.nowIso(),
        });
        await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          resumeSessionId,
        );
        resumeSessionId = undefined;
        providerAttributionSessionId = randomUUID();
        coordinatedProviderAttemptEligibleForSync = false;
        prepared = await prepareHarnessContext(this.options, this.skillsCache, activeRequest, {
          historyMode: "prompt",
          turnId: runId,
        }, emit);
        context = prepared.context;
        runtimeResult = await runHarnessRuntime(
          this.options,
          this.runLimiter,
          this.sessionsEnabled(),
          activeRequest,
          recorder,
          context,
          prepared.memory,
          runId,
          undefined,
          providerAttributionSessionId,
          undefined,
          isolated,
          prepared.skillDisclosureEntries,
          prepared.history,
          prepared.historyOmitted,
          prepared.historyAsMessages,
          prepared.toolHistoryProjection,
          attachmentContext,
          continuationCapabilities,
          liveInputMailbox,
          () => noteProviderStart(undefined),
        );
        noteProviderResultSession(runtimeResult.providerSessionId);
      }
      if (runtimeResult === undefined) {
        throw resumeError ?? new Error("Runtime did not produce a result.");
      }

      // Post-runtime cancellation guard (TOCTOU race): the live-session cancel
      // signal can land AFTER runRuntime() returns a success-shaped result but
      // BEFORE we commit it. Committing a cancelled turn would bake it into the
      // warm session + history + memory, diverging from what the caller (whose
      // promise the LiveSessionManager rejects) believes happened. So when the
      // signal is aborted here, skip saveSession + durable turn persistence,
      // evict/dispose any returned provider session (mirrors the empty-turn
      // retirement below), and return a cancelled failure instead.
      if (request.abortSignal.aborted) {
        toolHistoryStatus = "cancelled";
        await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          runtimeResult?.providerSessionId,
        );
        const summary = await recorder.finish({
          ...runtimeResult,
          systemPrompt: context.prompt,
          isolated,
          cancelled: true,
          failureKind: cancellationFailureKind(request.abortSignal),
        });
        return {
          metadata: responseMetadata(runId, request, context, summary, runtimeResult),
          failure: {
            kind: "cancelled",
            message: "Agent request was cancelled during the turn.",
            details: runtimeResult,
          },
        };
      }

      const failure = failureFromRuntimeResult(runtimeResult);
      if (failure !== undefined) {
        // Failure-shaped results may still have appended provider transcript
        // state. Canonical history rejects the turn, so retire every attempted
        // identity and leave a durable coordinator turn dirty for epoch rotation.
        await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          runtimeResult.providerSessionId,
        );
        const summary = await recorder.finish({
          ...runtimeResult,
          systemPrompt: context.prompt,
          isolated,
          failureKind: failure.kind,
          error: failure.message,
        });
        return { metadata: responseMetadata(runId, request, context, summary, runtimeResult), failure };
      }

      const text = normalizeAssistantText(runtimeResult.text);
      if (text === undefined) {
        const summary = await recorder.finish({ ...runtimeResult, systemPrompt: context.prompt, isolated });
        // Empty turns are not appended to history, so a retained provider
        // session would diverge from the history store. Retire it instead;
        // the next message replays history into a fresh session.
        await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          runtimeResult.providerSessionId,
        );
        return {
          metadata: responseMetadata(runId, request, context, summary, runtimeResult),
          failure: {
            kind: "empty_response",
            message: "Runtime completed without assistant text.",
            details: runtimeResult,
          },
        };
      }

      const successResult = { ...runtimeResult, systemPrompt: context.prompt, isolated };
      // Two-phase terminal lifecycle: preparation may yield, but is explicitly
      // non-terminal. It gives cancellation one final window before any durable
      // conversation state is committed and before `run_finished` is visible.
      await recorder.prepareFinish?.(successResult);

      if (isolated) {
        // An isolated proactive turn must not warm the shared conversation's
        // session. Retire its one-shot provider session before the final commit
        // check so an abort during disposal still persists no history/memory.
        await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          runtimeResult.providerSessionId,
        );
      }

      // Final pre-commit cancellation check (R9). After this synchronous check,
      // markCommitted() is the atomic boundary: cancellation is too late once
      // history/memory persistence starts, because those durable writes cannot be
      // rolled back safely.
      if (request.abortSignal.aborted) {
        toolHistoryStatus = "cancelled";
        if (!isolated) {
          await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
            request.conversationId,
            sessionRecord,
            ...providerAttemptSessionIds,
            runtimeResult.providerSessionId,
          );
        }
        const summary = await commitRecorderFinish(recorder, {
          ...successResult,
          cancelled: true,
          failureKind: cancellationFailureKind(request.abortSignal),
        });
        return {
          metadata: responseMetadata(runId, request, context, summary, runtimeResult),
          failure: {
            kind: "cancelled",
            message: "Agent request was cancelled during the turn.",
            details: runtimeResult,
          },
        };
      }

      // Build and durably prepare the bounded continuation snapshot before the
      // conversation commit boundary. A size/quota/storage failure must not
      // leave a warm provider session or history entry behind a failed reply.
      let completedTurn: Awaited<ReturnType<typeof buildSuccessfulTurn>> | undefined;
      const claimedContinuationCapabilities = request.continuation?.deferHistoryCommit === true
        ? []
        : await continuationCapabilitiesRequiringOriginContext(continuationCapabilities);
      if (request.continuation?.deferHistoryCommit !== true) {
        completedTurn = await buildSuccessfulTurn(this.options,
          request.conversationId,
          persistText,
          liveInputMailbox?.applied() ?? [],
          text,
          runId,
          request.sender,
        );
        try {
          if (providerHistoryTurn !== undefined) {
            const providerSessionId = typeof runtimeResult.providerSessionId === "string"
              ? runtimeResult.providerSessionId.trim()
              : "";
            if (
              providerSessionId.length > 0
              && providerSessionId === providerHistoryTurn.providerSessionId
              && coordinatedProviderAttemptEligibleForSync
              && this.options.runtime.syncSession !== undefined
            ) {
              try {
                providerSessionSynced = await this.options.runtime.syncSession(providerSessionId) === true;
              } catch {
                providerSessionSynced = false;
              }
            }
            if (!providerSessionSynced) {
              // The answer can still commit through canonical host history, but
              // this provider epoch must never resume. prepareCommit(false)
              // rotates the next epoch; destructive cleanup is only reclamation.
              await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
                request.conversationId,
                sessionRecord,
                ...providerAttemptSessionIds,
                providerHistoryTurn.providerSessionId,
                runtimeResult.providerSessionId,
              );
            }
            preparedHistoryAppend = await providerHistoryTurn.prepareCommit(
              completedTurn.messages,
              { providerSessionSynced },
            );
            providerHistoryOwnershipTransferred = true;
            providerHistoryTurn = undefined;
          } else {
            preparedHistoryAppend = await this.options.historyStore?.prepareAppend?.(
              request.conversationId,
              completedTurn.messages,
            );
          }
          if (claimedContinuationCapabilities.length > 0) {
            const priorHistory = prepared.historyOmitted
              ? await loadHarnessHistory(this.options, request.conversationId)
              : prepared.history;
            await finalizeContinuationOriginContexts(
              claimedContinuationCapabilities,
              buildContinuationOriginContext({
                conversationId: request.conversationId,
                runId,
                capturedAt: completedTurn.capturedAt,
                priorHistory,
                completedTurn: completedTurn.messages,
              }),
            );
          }
        } catch (error) {
          await preparedHistoryAppend?.abort().catch(() => undefined);
          preparedHistoryAppend = undefined;
          if (!isolated) {
            await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
              request.conversationId,
              sessionRecord,
              ...providerAttemptSessionIds,
              runtimeResult.providerSessionId,
            );
          }
          throw error;
        }
      }

      // Preparation above can perform bounded durable I/O. Cancellation still
      // wins until the synchronous commit marker below.
      if (request.abortSignal.aborted) {
        toolHistoryStatus = "cancelled";
        if (!isolated) {
          await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
            request.conversationId,
            sessionRecord,
            ...providerAttemptSessionIds,
            runtimeResult.providerSessionId,
          );
        }
        const summary = await commitRecorderFinish(recorder, {
          ...successResult,
          cancelled: true,
          failureKind: cancellationFailureKind(request.abortSignal),
        });
        return {
          metadata: responseMetadata(runId, request, context, summary, runtimeResult),
          failure: {
            kind: "cancelled",
            message: "Agent request was cancelled during the turn.",
            details: runtimeResult,
          },
        };
      }

      conversationCommitStarted = true;
      lifecycle?.markCommitted();
      if (completedTurn !== undefined) {
        try {
          if (preparedHistoryAppend !== undefined) {
            await preparedHistoryAppend.commit();
            preparedHistoryAppend = undefined;
          } else {
            await this.options.historyStore?.append(request.conversationId, completedTurn.messages);
          }
        } catch (error) {
          // A failed history publication must never leave a provider session
          // that contains an answer the durable conversation does not. Retire
          // both newly-created and already-warm session identities before the
          // failed turn is exposed.
          if (!isolated) {
            await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
              request.conversationId,
              sessionRecord,
              ...providerAttemptSessionIds,
              runtimeResult.providerSessionId,
            );
          }
          throw error;
        }
      }
      if (!isolated && (!providerHistoryOwnershipTransferred || providerSessionSynced)) {
        this.saveSession(
          request.conversationId,
          providerHistoryOwnershipTransferred ? coordinatedProviderSessionId : runtimeResult.providerSessionId,
          sessionRecord,
          providerHistoryOwnershipTransferred && providerSessionSynced
            ? (coordinatedProviderSessionRevision as number) + 1
            : undefined,
        );
      }

      // Persist memory from the ORIGINAL caption + redacted attachment
      // metadata (persistText), never the expanded provider prompt.
      if (completedTurn !== undefined) {
        await persistSuccessfulMemory(this.options,
          request.conversationId,
          completedTurn.userMemoryText,
          text,
          {
            runId,
            ...(runSource.source === undefined ? {} : { source: runSource.source }),
            ...(request.sender === undefined ? {} : { sender: request.sender }),
            emit,
          },
        );
      }
      // Memory persistence degradation is emitted above, while the recorder is
      // still open. Commit exactly one terminal summary only after every
      // run-scoped event has been recorded/exported/broadcast.
      // Durable history/session state is already authoritative here. Recorder
      // export failure must not retroactively turn the provider answer into a
      // failed response or abandon a continuation whose origin was committed.
      const summary = await safeRecorderCommitFinish(recorder, successResult);
      try {
        await activateContinuationOriginContexts(claimedContinuationCapabilities);
      } catch {
        // Recorder success is authoritative once committed. A failed activation
        // degrades only the callback: close still-pending claims so they take
        // the deterministic zero-model fallback instead of contradicting the
        // already-succeeded origin response.
        await Promise.allSettled(claimedContinuationCapabilities.map(async (capability) => {
          await capability.abandonOriginContext();
        }));
      }
      continuationOriginSettled = true;
      toolHistoryStatus = "succeeded";
      liveInputCloseReason = "closed";
      return {
        text,
        metadata: responseMetadata(runId, request, context, summary, runtimeResult),
      };
    } catch (error) {
      toolHistoryStatus = request.abortSignal.aborted ? "cancelled" : "failed";
      // A provider may already have persisted its transcript before any of the
      // host's pre-commit stages (recorder preparation, continuation binding,
      // or history staging) fail. Invalidate that cache generically so a later
      // warm or durable resume cannot replay an answer absent from canonical
      // conversation history.
      if (!conversationCommitStarted && providerAttemptStarted) {
        await retireRunResultSession(this.options, this.sessionStore, this.sessionsEnabled(),
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          providerHistoryTurn?.providerSessionId,
          runtimeResult?.providerSessionId,
        );
      }
      const cancelledBeforeCommit = request.abortSignal.aborted && !conversationCommitStarted;
      const failure = failureFromThrownError(error, cancelledBeforeCommit);
      const summary = cancelledBeforeCommit
        ? await safeRecorderCancel(recorder, cancellationFailureKind(request.abortSignal))
        : await safeRecorderFail(recorder, error);
      return {
        metadata: responseMetadata(runId, request, context, summary),
        failure,
      };
    } finally {
      try {
        await this.options.toolHistory?.writer.finishRun({
          conversationId: request.conversationId,
          logicalConversationId: this.options.toolHistory.logicalConversationId(request.conversationId),
          runId,
          isolated,
        }, toolHistoryStatus, toolHistoryStatus === "cancelled" ? cancellationFailureKind(request.abortSignal) : undefined);
      } finally {
        // A custom injected lifecycle writer may throw. It can retain its
        // failure semantics, but must never strand mailbox/session cleanup.
        await preparedHistoryAppend?.abort().catch(() => undefined);
        await providerHistoryTurn?.abort().catch(() => undefined);
        if (!continuationOriginSettled && continuationCapabilities.length > 0) {
          await Promise.allSettled(continuationCapabilities.map(async (capability) => {
            await capability.abandonOriginContext();
          }));
        }
        // App-owned retrieval services use this to discard the normalized query
        // cache after the whole logical turn (including any resume retry), not
        // after one provider attempt.
        try {
          await this.options.memory?.releaseTurn?.(runId);
        } catch {
          // Cache cleanup is best-effort and must not change the turn outcome.
        }
        try {
          await this.options.turnHistoryEnricher?.releaseRun({
            runId,
            conversationId: request.conversationId,
          });
        } catch {
          // Interaction-journal cleanup is best-effort and must not change the turn outcome.
        }
        if (liveInputMailbox !== undefined) {
          liveInputMailbox.close(liveInputCloseReason);
          if (this.activeLiveInputs.get(request.conversationId) === liveInputMailbox) {
            this.activeLiveInputs.delete(request.conversationId);
          }
        }
        // Release the admission-pending slot if the run never reached its provider
        // call (e.g. a throw in applyAttachments/prepareContext, or an aborted
        // admission). No-op when onProviderStart already released it.
        leavePending();
        if (sessionRecord !== undefined) {
          const released = this.sessionStore?.release(request.conversationId, sessionRecord);
          if (released !== false) {
            const snapshot = this.sessionStoreSnapshot();
            const live = snapshot.find((entry) =>
              entry.conversationId === sessionRecord.conversationId &&
              entry.providerSessionId === sessionRecord.providerSessionId
            );
            if (live !== undefined || released === undefined) {
              this.publishSessionEvent(sessionEventFromRecord("released", live ?? sessionRecord, undefined, snapshot));
            }
          }
        }
        this.activeRunWarningSinks.delete(emitShutdownWarning);
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    // Latch synchronously so a run cannot enter between shutdown admission and
    // the first asynchronous cleanup boundary. Disposal is terminal and
    // idempotent for this harness instance.
    this.disposed = true;
    this.disposePromise = this.disposeActiveResources();
    return this.disposePromise;
  }

  private async disposeActiveResources(): Promise<void> {
    // Reject queued work and cancel live input before draining every admitted
    // run through its complete finishRun() boundary. Only then may provider
    // sessions and the shared lifecycle writer be released.
    for (const mailbox of this.activeLiveInputs.values()) mailbox.cancel();
    this.activeLiveInputs.clear();
    const liveSessionDisposal = this.liveSessionManager?.dispose();
    void liveSessionDisposal?.catch(() => undefined);
    const drained = await this.waitForActiveRuns();
    const cleanupErrors: unknown[] = [];
    if (drained) {
      try {
        await liveSessionDisposal;
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      const warning: RuntimeEventLike = {
        type: "runtime_warning",
        warning_kind: "harness_shutdown_degraded",
        message: SHUTDOWN_DRAIN_WARNING,
      };
      for (const sink of this.activeRunWarningSinks) {
        try { sink(warning); } catch { /* shutdown diagnostics are best-effort */ }
      }
    }

    // On timeout this is a forced, harness-scoped provider cleanup. The runtime's
    // process-global disposeAllSessions remains intentionally out of bounds.
    try {
      await this.sessionStore?.disposeAll();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.options.toolHistory?.release?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Agent harness shutdown cleanup failed.");
  }

  private async waitForActiveRuns(): Promise<boolean> {
    if (this.activeRuns === 0) return true;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
    this.activeRunWaiters.add(resolveDrain);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      drained.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.shutdownDrainTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    this.activeRunWaiters.delete(resolveDrain);
    return outcome;
  }

  private assertAcceptingRuns(): void {
    if (this.disposed) {
      throw new AgentHarnessError("harness_disposed", "Agent harness has been disposed and cannot accept new runs.");
    }
  }

  /**
   * Whether THIS run should be handled as an isolated proactive turn: the
   * `session.isolateProactive` opt-in is on AND the request is a cron/proactive
   * request (it carries `metadata.cron`, set by the cron scheduler). When false,
   * the run uses the shared continuous-session machinery exactly as before.
   */
  private isProactiveIsolated(request: AgentHarnessRequest): boolean {
    return this.options.session?.isolateProactive === true && isCronRequest(request);
  }

  private sessionsEnabled(): boolean {
    if (this.sessionStore === undefined) {
      return false;
    }
    if (this.supportsResumeCache === undefined) {
      const override = this.options.session?.supportsResume;
      if (override !== undefined) {
        this.supportsResumeCache = override;
      } else {
        try {
          this.supportsResumeCache = monoRuntimeSupportsSessionResume();
        } catch {
          this.supportsResumeCache = false;
        }
      }
    }
    return this.supportsResumeCache;
  }

  private saveSession(
    conversationId: string,
    providerSessionId: unknown,
    owner: RuntimeSessionRecord | undefined,
    providerSessionRevision?: number,
  ): void {
    if (!this.sessionsEnabled()) {
      return;
    }
    if (typeof providerSessionId !== "string" || providerSessionId.trim().length === 0) {
      return;
    }
    this.sessionStore?.save(conversationId, providerSessionId, owner, providerSessionRevision);
    const snapshot = this.sessionStoreSnapshot();
    const saved = snapshot.find((entry) => entry.conversationId === conversationId && entry.providerSessionId === providerSessionId);
    if (saved !== undefined) {
      this.publishSessionEvent({ kind: "saved", ...saved, snapshot });
    }
  }

  private nowIso(): string {
    return this.options.now?.().toISOString() ?? new Date().toISOString();
  }

  private publishSessionEvent(event: AgentHarnessSessionEvent): void {
    try {
      const result = this.options.session?.onSessionEvent?.(event);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Session status is diagnostic; runtime cleanup and turn outcome must win.
    }
  }

  private sessionStoreSnapshot(): readonly RuntimeSessionSnapshot[] {
    return this.sessionStore?.list?.() ?? [];
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new MonoAgentHarness(options);
}
