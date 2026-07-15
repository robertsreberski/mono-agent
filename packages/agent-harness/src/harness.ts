import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentAttachment, AgentContinuationOriginContext } from "@mono-agent/agent-contracts";
import {
  AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES,
  assertAgentContinuationOriginContext,
  isChannelUserCancelReason,
  NOTHING_TO_REPORT_SENTINEL,
} from "@mono-agent/agent-contracts";
import { deriveRunSource } from "@mono-agent/observability";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";
import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
  isValidMcpServerName,
  modelReferenceKey,
  monoRuntimeSupportsSessionResume,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type { RuntimeExecutionMode, RuntimeModelReference, RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { mergeSandboxPolicies, sandboxPolicyToRuntimeOptions } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/runtime-adapter";

import { loadContextFromFiles, loadSkillIndexFromDirectory } from "./context/index.js";
import type { BuiltAgentContext, ContextBlockInput, HistoryMessage, SkillIndexEntry } from "./context/index.js";
import { NoopRunRecorder } from "./recorder.js";
import { createLiveSessionManager } from "./live-session.js";
import type { LiveSessionManager, LiveSessionRunLifecycle } from "./live-session.js";
import { classifyContinuationMcpServerTransport, isStdioMcpServerSpec } from "./mcp-server-transport.js";
import { createSemaphore } from "./semaphore.js";
import type { Semaphore } from "./semaphore.js";
import { createRuntimeSessionStore } from "./sessions.js";
import type { RuntimeSessionRecord, RuntimeSessionSnapshot, RuntimeSessionStore } from "./sessions.js";
import type {
  AgentHarness,
  AgentHarnessFailure,
  AgentHarnessOptions,
  AgentHarnessRequest,
  AgentHarnessResponse,
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessSessionBoundary,
  AgentHarnessSessionEvent,
  ConversationHistoryProviderSessionTurn,
  ExternalRunSummary,
  PreparedHistoryAppend,
} from "./types.js";
import type {
  AgentHarnessContinuationClaimCapability,
  AgentHarnessContinuationContextOptions,
  AgentHarnessMcpRequestContextOptions,
  AgentHarnessProgressCapability,
} from "./types.js";
import { createSkillsCache } from "./skills/index.js";
import type { SkillsCache } from "./skills/index.js";
import { failClosedToolPolicy, toolPolicyToRuntimeOptions } from "./tool-policy/index.js";

export class AgentHarnessError extends Error {
  readonly failureKind: string;
  readonly details?: unknown;

  constructor(failureKind: string, message: string, details?: unknown) {
    super(message);
    this.name = "AgentHarnessError";
    this.failureKind = failureKind;
    this.details = details;
  }
}

/**
 * The synthetic "user" turn recorded alongside a verbatim notification so durable
 * history keeps role alternation and a resumed session reads the delivery as the
 * assistant's own prior message. Never shown to the user; it only frames the
 * delivered text for a later reply.
 */
const VERBATIM_DELIVERY_STIMULUS = "[A scheduled or triggered task produced the message below, delivered to you proactively.]";
const MEMORY_PERSISTENCE_WARNING = "Memory persistence was not confirmed after the provider answer; the provider response was preserved.";

interface AttachmentRequestContext {
  /** Canonical attachment root, or an authoritative empty string when absent. */
  readonly root: string;
  /** Exact lexical paths persisted successfully for this request only. */
  readonly allowedPaths: readonly string[];
  /** File identities captured from the descriptors that wrote this request's attachments. */
  readonly allowedIdentities: readonly AttachmentFileIdentity[];
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface AttachmentFileIdentity extends FileIdentity {
  readonly path: string;
}

export class MonoAgentHarness implements AgentHarness {
  private readonly options: AgentHarnessOptions;
  private readonly sessionStore: RuntimeSessionStore | undefined;
  private readonly liveSessionManager: LiveSessionManager | undefined;
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

  constructor(options: AgentHarnessOptions) {
    validateOptions(options);
    this.options = options;
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
    if (this.liveSessionManager !== undefined) {
      return this.liveSessionManager.enqueue(request.conversationId, request);
    }
    return this.run(request);
  }

  cancel(conversationId: string, reason?: unknown): void {
    this.liveSessionManager?.cancel(conversationId, reason);
  }

  /**
   * Record a message a channel posted VERBATIM into `conversationId` (native
   * cron/webhook notification) without running a turn, so a later user reply
   * resumes with the delivered message in context. Two effects, in this order:
   *  1. evict any WARM provider session for the conversation — that session
   *     bypassed the model so it does not know about this post, and a reply
   *     would otherwise omit history (`omitHistory` is true while warm). Doing it
   *     FIRST means a reply that cold-loads after this returns reads the history
   *     appended below. Best-effort: a failed eviction (which only leaves a warm
   *     session that idles out) must not block the durable record.
   *  2. append it to durable history (a synthetic trigger turn + the assistant
   *     text) — the cold-start source `prepareContext` replays.
   * Same-conversation replies are serialized with this call by the channel's
   * per-conversation admission queue, so none can acquire the session between the
   * evict and the append. No model call; memory capture is deliberately skipped
   * (a delivered notification is conversation history, not a recall-worthy fact).
   */
  async appendVerbatimTurn(
    conversationId: string,
    text: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void> {
    const idempotencyKey = options?.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      const history = await this.options.historyStore?.load(conversationId) ?? [];
      const prior = history.find((message) => message.idempotencyKey === idempotencyKey);
      if (prior !== undefined) {
        if (prior.role !== "assistant" || prior.content !== text) {
          throw new Error("Verbatim history idempotency key conflicts with existing content.");
        }
        return;
      }
    }
    try {
      await this.sessionStore?.evict(conversationId, "stale");
    } catch {
      // Eviction is best-effort; the durable history append below is what matters.
    }
    const timestamp = this.options.now?.().toISOString() ?? new Date().toISOString();
    await this.options.historyStore?.append(conversationId, [
      {
        role: "user",
        content: VERBATIM_DELIVERY_STIMULUS,
        timestamp,
      },
      {
        role: "assistant",
        content: text,
        timestamp,
        ...(idempotencyKey === undefined || idempotencyKey.length === 0 ? {} : { idempotencyKey }),
      },
    ]);
  }

  async run(request: AgentHarnessRequest, lifecycle?: LiveSessionRunLifecycle): Promise<AgentHarnessResponse> {
    validateRequest(request);
    const runId = this.options.createRunId?.() ?? createDefaultRunId();
    const runSource = runSourceFromRequest(request);
    // Proactive isolation (opt-in): a cron/proactive run is treated as a one-shot
    // ephemeral turn — it neither resumes nor persists the shared continuous
    // session, so its large tool dumps stay out of the interactive transcript.
    // Computed before recorder construction so even running/early-failed summaries
    // carry the run's session identity.
    //
    // A per-trigger MODEL override is isolated, regardless of the opt-in, ONLY
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
    const sessionRecord = !isolated && this.sessionsEnabled() ? this.sessionStore?.acquire(request.conversationId) : undefined;
    let context: BuiltAgentContext | undefined;
    const emit = (event: RuntimeEventLike): void => {
      recorder.onEvent(event);
      request.onEvent?.(event);
    };
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
      } = await this.applyAttachments(request, runId, emit);
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
        && this.options.model.sdk === "pi"
        && this.options.piSessionsRoot !== undefined
        && historyStore?.providerSessionRetirement === "fail-closed"
        && beginProviderSessionTurn !== undefined;
      if (durableProviderSessionsEnabled) {
        providerHistoryTurn = await beginProviderSessionTurn(request.conversationId, runId);
        coordinatedProviderSessionId = providerHistoryTurn.providerSessionId;
        coordinatedProviderSessionRevision = providerHistoryTurn.providerSessionRevision;
      }

      let resumeSessionId = providerHistoryTurn?.providerSessionId ?? sessionRecord?.providerSessionId;
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
          await this.retireRunResultSession(
            request.conversationId,
            sessionRecord,
            sessionRecord.providerSessionId,
          );
        }
      }

      // Omit history only for a confirmed live mapping to the exact epoch-owned
      // provider id. A cold cross-restart reopen still receives canonical history
      // so create-on-miss can seed a complete transcript.
      let prepared = await this.prepareContext(activeRequest, { omitHistory: confirmedWarmSession, turnId: runId }, emit);
      context = prepared.context;

      let resumeError: unknown;
      try {
        coordinatedProviderAttemptEligibleForSync = providerHistoryTurn !== undefined
          && resumeSessionId === providerHistoryTurn.providerSessionId;
        runtimeResult = await this.runRuntime(
          activeRequest,
          recorder,
          context,
          prepared.memory,
          runId,
          resumeSessionId,
          providerHistoryTurn === undefined ? undefined : this.options.piSessionsRoot,
          isolated,
          prepared.skillDisclosureNames,
          prepared.history,
          prepared.historyOmitted,
          attachmentContext,
          continuationCapabilities,
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
        await this.retireRunResultSession(
          request.conversationId,
          sessionRecord,
          ...providerAttemptSessionIds,
          resumeSessionId,
        );
        resumeSessionId = undefined;
        coordinatedProviderAttemptEligibleForSync = false;
        prepared = await this.prepareContext(activeRequest, { omitHistory: false, turnId: runId }, emit);
        context = prepared.context;
        runtimeResult = await this.runRuntime(
          activeRequest,
          recorder,
          context,
          prepared.memory,
          runId,
          undefined,
          undefined,
          isolated,
          prepared.skillDisclosureNames,
          prepared.history,
          prepared.historyOmitted,
          attachmentContext,
          continuationCapabilities,
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
        await this.retireRunResultSession(
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
        await this.retireRunResultSession(
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
        await this.retireRunResultSession(
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
        await this.retireRunResultSession(
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
        if (!isolated) {
          await this.retireRunResultSession(
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
      let completedTurn: Awaited<ReturnType<MonoAgentHarness["buildSuccessfulTurn"]>> | undefined;
      const claimedContinuationCapabilities = request.continuation?.deferHistoryCommit === true
        ? []
        : await continuationCapabilitiesRequiringOriginContext(continuationCapabilities);
      if (request.continuation?.deferHistoryCommit !== true) {
        completedTurn = await this.buildSuccessfulTurn(
          request.conversationId,
          persistText,
          text,
          runId,
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
              await this.retireRunResultSession(
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
              ? await this.loadHistory(request.conversationId)
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
            await this.retireRunResultSession(
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
        if (!isolated) {
          await this.retireRunResultSession(
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
            await this.retireRunResultSession(
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
        await this.persistSuccessfulMemory(
          request.conversationId,
          persistText,
          text,
          { runId, ...(runSource.source === undefined ? {} : { source: runSource.source }), emit },
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
      return {
        text,
        metadata: responseMetadata(runId, request, context, summary, runtimeResult),
      };
    } catch (error) {
      // A provider may already have persisted its transcript before any of the
      // host's pre-commit stages (recorder preparation, continuation binding,
      // or history staging) fail. Invalidate that cache generically so a later
      // warm or durable resume cannot replay an answer absent from canonical
      // conversation history.
      if (!conversationCommitStarted && providerAttemptStarted) {
        await this.retireRunResultSession(
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
    }
  }

  async dispose(): Promise<void> {
    // Reject any in-flight/queued turns first so callers stop waiting, then
    // retire sessions. Only this harness's tracked sessions are retired (the
    // store's onEvict disposes each provider session individually).
    // runtime.disposeAllSessions is intentionally NOT called here: the provider
    // registries are process-global and other harnesses may share them.
    await this.liveSessionManager?.dispose();
    await this.sessionStore?.disposeAll();
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
          this.supportsResumeCache = monoRuntimeSupportsSessionResume(
            this.options.model,
            this.options.executionMode as RuntimeExecutionMode | undefined,
          );
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

  /**
   * Invalidates the provider session attached to a turn that will NOT be committed
   * (cancelled mid-turn or empty-text). Evicts a confirmed warm sessionRecord
   * via the store and permanently discards its provider transcript, otherwise
   * invalidates the freshly returned providerSessionId directly. Ordinary
   * disposal deliberately preserves durable provider caches; invalidation is
   * required here because canonical host history rejected this turn. Shared by all
   * three non-commit exits (post-runtime abort guard, the empty-text branch,
   * and the pre-commit abort recheck) so they stay consistent.
   */
  private async retireRunResultSession(
    conversationId: string,
    sessionRecord: RuntimeSessionRecord | undefined,
    ...providerSessionIds: readonly unknown[]
  ): Promise<void> {
    if (!this.sessionsEnabled()) return;
    const ids = new Set<string>();
    if (sessionRecord !== undefined) ids.add(sessionRecord.providerSessionId);
    for (const providerSessionId of providerSessionIds) {
      if (typeof providerSessionId === "string" && providerSessionId.trim().length > 0) {
        ids.add(providerSessionId);
      }
    }
    for (const id of ids) {
      try {
        if (this.options.runtime.invalidateSession !== undefined) {
          await this.options.runtime.invalidateSession(id);
        } else {
          await this.options.runtime.disposeSession?.(id);
        }
      } catch {
        // Provider cleanup is best-effort; the host session mapping is still
        // evicted below so this process cannot warm-resume rejected state.
      }
    }
    if (sessionRecord !== undefined) {
      await this.sessionStore?.evict(conversationId, "stale", sessionRecord.providerSessionId);
    }
  }

  private async prepareContext(
    request: AgentHarnessRequest,
    options: { readonly omitHistory: boolean; readonly turnId: string },
    emit?: (event: RuntimeEventLike) => void,
  ): Promise<{
    readonly context: BuiltAgentContext;
    readonly memory: ContextBlockInput | undefined;
    readonly skillDisclosureNames: readonly string[];
    // Raw loaded history (empty when omitted) + the omit decision, returned so the
    // caller can emit a `turn_context` event describing exactly what the model saw
    // this turn. Local to prepareContext otherwise.
    readonly history: readonly HistoryMessage[];
    readonly historyOmitted: boolean;
  }> {
    const history = options.omitHistory
      ? []
      : await this.loadHistory(request.conversationId, request.continuation);
    // Recalled memory deliberately does NOT go into the system prompt. It rides on
    // the per-turn USER MESSAGE instead (see runRuntime): the user message is the
    // one field every runtime re-sends verbatim each turn, so memory survives
    // session resume even on runtimes that drop the system prompt on a resumed
    // turn (e.g. codex-app sends developerInstructions only on a fresh thread).
    // Keeping it out of the system prompt also leaves that prompt stable across a
    // session, which is better for provider prompt caching.
    const memory = request.continuation === undefined
      ? await this.loadMemory(request.conversationId, request.userMessage, options.turnId, emit)
      : undefined;
    const selectedSkills = await this.loadSkills();
    const context = await loadContextFromFiles({
      identityPath: this.options.identityPath,
      userMessage: request.userMessage,
      session: sessionContextBlock(request, this.options.memory !== undefined),
      ...(this.options.soulPath === undefined ? {} : { soulPath: this.options.soulPath }),
      ...(history.length === 0 ? {} : { history }),
      ...(this.options.skillsRoot !== undefined
        ? { skillsRoot: this.options.skillsRoot }
        : selectedSkills.index.length > 0
          ? { skills: selectedSkills.index }
          : {}),
      ...(selectedSkills.instructions.length === 0 ? {} : { skillInstructions: selectedSkills.instructions }),
    });
    // Progressive skill disclosure (index mode, opt-in): the index is in the
    // prompt but the bodies are not — so expose a `ReadSkill` tool whose enum is
    // the discovered skill names, letting the agent pull a full body on demand.
    // 'full' mode (the default) keeps today's behavior (selectedSkills bodies
    // inlined up front) and does NOT add ReadSkill. Names load only when a
    // skillsRoot is set.
    const skillDisclosureNames = await this.loadSkillDisclosureNames();
    return { context, memory, skillDisclosureNames, history, historyOmitted: options.omitHistory };
  }

  /**
   * Discovers the skill names the `ReadSkill` tool may load (its enum) for
   * progressive disclosure. Returns [] in "full" disclosure mode or when no
   * skillsRoot is configured, so the runtime never creates the tool there —
   * preserving the legacy index-only-without-ReadSkill behavior in those cases.
   */
  private async loadSkillDisclosureNames(): Promise<readonly string[]> {
    if (this.skillDisclosureMode() !== "index" || this.options.skillsRoot === undefined) {
      return [];
    }
    const entries = await loadSkillIndexFromDirectory(this.options.skillsRoot);
    return entries.map((entry) => entry.name);
  }

  private skillDisclosureMode(): "index" | "full" {
    return this.options.skillDisclosure ?? "full";
  }

  private async loadHistory(
    conversationId: string,
    continuation?: AgentHarnessRequest["continuation"],
  ): Promise<readonly HistoryMessage[]> {
    if (continuation?.originContext !== undefined) {
      const snapshot = continuation.originContext;
      assertAgentContinuationOriginContext(snapshot);
      if (snapshot.conversationId !== conversationId
        || snapshot.originRunId !== continuation.originRunId
        || snapshot.historyBoundary !== continuation.historyBoundary) {
        throw new AgentHarnessError(
          "origin_context_binding_mismatch",
          "The pinned continuation origin context does not match this synthesis turn.",
          { continuationId: continuation.continuationId },
        );
      }
      return snapshot.messages.map((message) => ({ ...message }));
    }
    const history = await this.options.historyStore?.load(conversationId) ?? [];
    if (continuation === undefined) {
      return history;
    }
    const boundary = continuation.historyBoundary;
    if (boundary === undefined) {
      return history;
    }
    let boundaryIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.runId === boundary) {
        boundaryIndex = index;
        break;
      }
    }
    if (boundaryIndex < 0) {
      throw new AgentHarnessError(
        "history_boundary_not_found",
        "The continuation history boundary is no longer available.",
        { continuationId: continuation.continuationId, historyBoundary: boundary },
      );
    }
    return history.slice(0, boundaryIndex + 1);
  }

  /**
   * Saves inbound attachments to `attachmentsDir` and returns a request whose
   * userMessage references the saved paths (and inlines extracted document
   * text) for the PROVIDER call. The agent then opens the files with its own
   * tools, so no provider multimodal contract is needed. Persistence failures
   * degrade to a warning.
   *
   * Also returns `persistUserMessage`: the ORIGINAL caption plus a redacted,
   * metadata-only attachment suffix (saved path + mime type + size + name, NEVER
   * the extracted document body). This is what is written to durable
   * history/memory so a sensitive document's content is not baked into future
   * prompts or memory — only an actionable file reference is retained.
   */
  private async applyAttachments(
    request: AgentHarnessRequest,
    runId: string,
    emit: (event: RuntimeEventLike) => void,
  ): Promise<{
    readonly request: AgentHarnessRequest;
    readonly persistUserMessage: string;
    readonly attachmentContext: AttachmentRequestContext;
  }> {
    const attachments = request.attachments;
    const configuredDir = this.options.attachmentsDir;
    let canonicalDir: string | undefined;
    if (configuredDir !== undefined
      && ((attachments !== undefined && attachments.length > 0) || this.options.mcpRequestContext !== undefined)) {
      try {
        await mkdir(configuredDir, { recursive: true });
        canonicalDir = await realpath(configuredDir);
      } catch (error) {
        if (attachments !== undefined && attachments.length > 0) {
          emit({
            type: "runtime_warning",
            warning_kind: "attachment_persist_failed",
            message: `Could not prepare the attachment directory: ${errorMessageText(error)}`,
          });
        }
      }
    }
    const allowedPaths: string[] = [];
    const allowedIdentities: AttachmentFileIdentity[] = [];
    const attachmentContext = (): AttachmentRequestContext => ({
      root: canonicalDir ?? "",
      allowedPaths: [...allowedPaths],
      allowedIdentities: [...allowedIdentities],
    });
    if (attachments === undefined || attachments.length === 0) {
      return { request, persistUserMessage: request.userMessage, attachmentContext: attachmentContext() };
    }
    const promptLines: string[] = [];
    const persistLines: string[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment === undefined) {
        continue;
      }
      let savedPath: string | undefined;
      if (canonicalDir !== undefined) {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          savedPath = join(canonicalDir, attachmentFileName(runId, index, attachment));
          // Capture authority from the descriptor that created and wrote the
          // file. Never canonicalize the file path itself: realpath would turn
          // a post-write symlink swap into authority for its target.
          handle = await open(savedPath, "wx", 0o600);
          await handle.writeFile(Buffer.from(attachment.data, "base64"));
          await handle.sync();
          const persisted = await handle.stat();
          if (!persisted.isFile() || persisted.nlink !== 1) {
            throw new Error("persisted attachment is not a uniquely linked regular file");
          }
          allowedPaths.push(savedPath);
          allowedIdentities.push({ path: savedPath, ...fileIdentity(persisted) });
        } catch (error) {
          emit({
            type: "runtime_warning",
            warning_kind: "attachment_persist_failed",
            message: `Could not save attachment ${attachment.name ?? `#${index}`}: ${errorMessageText(error)}`,
          });
          savedPath = undefined;
        } finally {
          if (handle !== undefined) {
            await handle.close().catch(() => undefined);
          }
        }
      }
      promptLines.push(describeAttachment(attachment, savedPath, { includeText: true }));
      persistLines.push(describeAttachment(attachment, savedPath, { includeText: false }));
    }
    if (promptLines.length === 0) {
      return { request, persistUserMessage: request.userMessage, attachmentContext: attachmentContext() };
    }
    const header = configuredDir !== undefined
      ? `[The user attached ${attachments.length} file(s) — saved to disk so you can open them with your tools:]`
      : `[The user attached ${attachments.length} file(s):]`;
    return {
      request: { ...request, userMessage: `${request.userMessage}\n\n${header}\n${promptLines.join("\n")}` },
      persistUserMessage: `${request.userMessage}\n\n${header}\n${persistLines.join("\n")}`,
      attachmentContext: attachmentContext(),
    };
  }

  private async loadMemory(
    conversationId: string,
    query: string,
    turnId: string,
    emit?: (event: RuntimeEventLike) => void,
  ): Promise<ContextBlockInput | undefined> {
    let block;
    try {
      block = await this.options.memory?.load(conversationId, query, { turnId });
    } catch (error) {
      // A slow or failing memory backend (e.g. embeddings timeout / circuit
      // breaker open) must never block or fail the turn — degrade to empty
      // memory and surface a warning so the turn proceeds.
      emit?.({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
        message: `Memory recall failed; continuing without memory. ${errorMessageText(error)}`,
      });
      return undefined;
    }
    if (block === undefined) {
      return undefined;
    }
    // Memory leaves the system-prompt trace once it moves onto the user message, so
    // emit a lightweight diagnostic (source + byte size, not the content) to keep
    // the fact that recall fired — and how much it surfaced — visible in run traces.
    emit?.({
      type: "memory_recalled",
      ...(block.source === undefined ? {} : { source: block.source }),
      bytes: Buffer.byteLength(block.content, "utf8"),
    });
    return {
      kind: "markdown",
      content: block.content,
      source: block.source,
    };
  }

  private async loadSkills(): Promise<{ readonly index: readonly SkillIndexEntry[]; readonly instructions: readonly ContextBlockInput[] }> {
    if (this.options.selectedSkills === undefined || this.options.selectedSkills.length === 0) {
      return { index: [], instructions: [] };
    }
    if (this.options.skillsRoot === undefined) {
      throw new AgentHarnessError("invalid_skill_selection", "selectedSkills requires skillsRoot.");
    }
    return await this.skillsCache.loadSelectedSkillsCached({
      skillsRoot: this.options.skillsRoot,
      names: this.options.selectedSkills,
      ...(this.options.skillMaxBytes === undefined ? {} : { maxBytes: this.options.skillMaxBytes }),
    });
  }

  private async runRuntime(
    request: AgentHarnessRequest,
    recorder: RunRecorder,
    context: BuiltAgentContext,
    memory: ContextBlockInput | undefined,
    runId: string,
    resumeSessionId: string | undefined,
    durablePiSessionsRoot: string | undefined,
    sessionIsolated: boolean,
    skillDisclosureNames: readonly string[],
    history: readonly HistoryMessage[],
    historyOmitted: boolean,
    attachmentContext: AttachmentRequestContext,
    continuationCapabilities: AgentHarnessContinuationClaimCapability[],
    onProviderStart?: () => void,
  ): Promise<RuntimeResult> {
    const hostOnEvent = request.onEvent;
    let requestExtension: AgentHarnessRuntimeOptionsExtension | undefined;
    let requestExtensionCleanup: Promise<void> | undefined;
    let mcpProgressCapability: AgentHarnessProgressCapability | undefined;
    let mcpContinuationCapabilities: readonly AgentHarnessContinuationClaimCapability[] = [];
    let mcpRunOutputCleanup: (() => Promise<void>) | undefined;
    let settlementCleanup: Promise<void> | undefined;
    // Admission precedes per-request extension setup. Extensions may allocate
    // loopback MCP listeners or other bounded resources, so queued runs must
    // hold none of them while waiting for a provider slot.
    let acquired = false;
    // Release-on-abort (R10): once a slot is held, an abort frees it after its
    // request-scoped resources close, even if the provider ignores cancellation.
    // Keeping cleanup inside the permit lifetime prevents repeated cancel/new-run
    // cycles from accumulating loopback MCP listeners beyond concurrency.
    let released = false;
    const releaseSlot = (): void => {
      if (acquired && !released) {
        released = true;
        this.runLimiter?.release();
      }
    };
    const cleanupRequestExtension = (): Promise<void> => {
      requestExtensionCleanup ??= Promise.resolve()
        .then(async () => {
          const failures: unknown[] = [];
          try {
            await requestExtension?.cleanup?.();
          } catch (error) {
            failures.push(error);
          }
          try {
            await mcpProgressCapability?.release();
          } catch (error) {
            failures.push(error);
          }
          for (const capability of mcpContinuationCapabilities) {
            try {
              await capability.release();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) {
            throw failures[0];
          }
        })
        .then(() => undefined);
      return requestExtensionCleanup;
    };
    const cleanupAfterSettlement = (): Promise<void> => {
      settlementCleanup ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        try {
          await requestExtension?.settleCleanup?.();
        } catch (error) {
          failures.push(error);
        }
        try {
          await mcpRunOutputCleanup?.();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) throw failures[0];
      });
      return settlementCleanup;
    };
    const onAbortCleanupAndRelease = (): void => {
      void cleanupRequestExtension().catch(() => undefined).finally(releaseSlot);
    };
    try {
      if (this.runLimiter !== undefined) {
        await this.runLimiter.acquire(request.abortSignal);
        acquired = true;
      }
      requestExtension = await this.options.runtimeOptionsForRequest?.({ request, runId, context });
      const policyOptions = toolPolicyToRuntimeOptions(
        requestExtension?.toolPolicyOverride
        ?? this.options.toolPolicy
        ?? failClosedToolPolicy(),
      );
      const sandboxOptions = this.options.sandboxPolicy === undefined
        ? {}
        : sandboxPolicyToRuntimeOptions(this.options.sandboxPolicy);
      const staticRuntimeOptions = requestExtension?.toolPolicyOverride === undefined
        ? this.options.runtimeOptions
        : withoutToolPolicyOptions(this.options.runtimeOptions);
      const requestRuntimeOptions = requestExtension?.toolPolicyOverride === undefined
        ? requestExtension?.runtimeOptions
        : withoutToolPolicyOptions(requestExtension.runtimeOptions);
      const merged = mergeRuntimeOptions(
        policyOptions,
        sandboxOptions,
        staticRuntimeOptions,
        requestRuntimeOptions,
      );
      // Provider-session identity and durable storage are host-owned. Strip all
      // extension/static values unconditionally, then add only the decisions
      // made by the coordinated harness below. Conditional object spreads do
      // not remove pre-existing keys when their guard is false.
      delete merged.piSessionsRoot;
      delete merged.sessionKeepAlive;
      delete merged.sessionIdleTimeoutMs;
      delete merged.sessionId;
      delete merged.providerSessionId;
      if (request.continuation?.toolsDisabled === true) {
        // Host-authoritative continuation synthesis is side-effect free. This
        // final override runs after every static/request policy layer so neither
        // a model nor an app extension can re-enable built-ins or MCP tools.
        merged.allowedTools = [];
        merged.disallowedTools = ["*"];
        merged.mcpServers = {};
        delete merged.mcpConfigPath;
      }
      const requestContext = await injectMcpRequestContext({
        options: this.options.mcpRequestContext,
        mcpServers: merged.mcpServers,
        conversationId: request.conversationId,
        runId,
        attachmentsRoot: attachmentContext.root,
        allowedAttachmentPaths: attachmentContext.allowedPaths,
        allowedAttachmentIdentities: attachmentContext.allowedIdentities,
      });
      if (requestContext !== undefined) {
        merged.mcpServers = requestContext.mcpServers;
        mcpProgressCapability = requestContext.progressCapability;
        mcpRunOutputCleanup = requestContext.cleanup;
      }
      const continuationContext = await injectMcpContinuationContext({
        options: this.options.continuationContext,
        mcpServers: merged.mcpServers,
        conversationId: request.conversationId,
        replyTo: request.replyTo,
        runId,
      });
      if (continuationContext !== undefined) {
        merged.mcpServers = continuationContext.mcpServers;
        mcpContinuationCapabilities = continuationContext.capabilities;
        continuationCapabilities.push(...continuationContext.capabilities);
      }
      // Register abort cleanup only after every run-scoped resource is assigned;
      // otherwise an abort racing capability issuance could memoize cleanup before
      // the token exists and leave that token live.
      request.abortSignal.addEventListener("abort", onAbortCleanupAndRelease, { once: true });
      if (request.abortSignal.aborted) {
        onAbortCleanupAndRelease();
        await cleanupRequestExtension();
        throw request.abortSignal.reason ?? new Error("Agent request was cancelled before provider start.");
      }
      // Per-request overrides (cron job / webhook per-trigger model + effort) win
      // over the harness defaults. These are applied AFTER the `...merged` spread so
      // the precedence is explicit. Non-override turns are byte-for-byte unchanged.
      const overrideModel = isRuntimeModelReference(merged.model) ? merged.model : undefined;
      const effectiveModel = overrideModel ?? this.options.model;
      if (
        !sessionIsolated
        && this.sessionsEnabled()
        && overrideModel !== undefined
        && !sameRuntimeModel(overrideModel, this.options.model)
      ) {
        // Context/session isolation must be decided before history assembly. A
        // model-changing extension that was not declared by the request's
        // cron/webhook/TUI metadata arrives too late: a warm turn may already
        // have omitted canonical history. Fail before provider execution rather
        // than mixing model lineage or saving an id owned by another runtime.
        throw new AgentHarnessError(
          "undeclared_model_override",
          "A model-changing runtimeOptionsForRequest result must be declared in request metadata before context assembly.",
        );
      }
      // executionMode for an override turn: keep the host's configured mode when the
      // override model supports it (so a host running e.g. claude in cli mode is not
      // silently flipped to sdk for a same-family override), else fall back to that
      // model's default mode (so a codex override under an sdk host correctly runs
      // cli). executionMode is harness/runtime-owned — extensions cannot set it.
      const effectiveExecutionMode = overrideModel === undefined
        ? this.options.executionMode
        : executionModeForOverride(overrideModel, this.options.executionMode);
      const overrideEffort = typeof merged.effort === "string" ? merged.effort : undefined;
      const effectiveEffort = overrideEffort ?? this.options.effort;
      // When the override names a DIFFERENT model, run it on a runtime built for
      // that model (override as the fallback-chain primary, configured backups
      // after) so failover is preserved. Falls back to the shared runtime when no
      // factory is wired (the app wires it only when fallbacks exist; a plain
      // runtime honors the per-run model) or the model is unchanged.
      const runtime =
        overrideModel !== undefined &&
        this.options.runtimeForModel !== undefined &&
        !sameRuntimeModel(overrideModel, this.options.model)
          ? this.options.runtimeForModel(effectiveModel, effectiveExecutionMode)
          : this.options.runtime;
      const runtimeOptions: RuntimeRunOptions = {
        ...merged,
        model: effectiveModel,
        // Recalled memory is appended to the user message (NOT the system prompt) so
        // it reaches the model on every turn, including resumed turns. See
        // prepareContext for why.
        messages: [{ role: "user", content: composeUserMessageWithMemory(request.userMessage, memory) }],
        abortSignal: request.abortSignal,
        ...(effectiveExecutionMode === undefined ? {} : { executionMode: effectiveExecutionMode }),
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
        // Durable provider-session root is forwarded only for a host-history
        // coordinated turn. Custom stores and isolated runs cannot safely make
        // provider JSONL authoritative across a crash, so they stay in-memory.
        ...(durablePiSessionsRoot === undefined || runtime !== this.options.runtime
          ? {}
          : { piSessionsRoot: durablePiSessionsRoot }),
        // Progressive skill disclosure (index mode): pass the discovered skill names
        // and the skills root so pi-native's getPiBuiltinTools creates the on-demand
        // `ReadSkill` tool. These live after the merge so request extensions cannot
        // clobber them. Empty in 'full' mode / when no skillsRoot is set, so the
        // tool is not created and behavior matches the legacy path.
        ...(skillDisclosureNames.length > 0 && this.options.skillsRoot !== undefined
          ? {
            skills: skillDisclosureNames.map((name) => ({ name })),
            skillsRoot: this.options.skillsRoot,
          }
          : {}),
        // Session keys live after the merge so request extensions cannot
        // clobber the harness's session decision — including forcing the keys
        // back to undefined on fresh runs.
        //
        // Omitted entirely when running on a per-turn OVERRIDE runtime (a model
        // override built via runtimeForModel): that runtime is not the one the
        // shared session store / disposal is keyed to, so keeping a session alive
        // on it would leak (the store disposes against the base runtime). An
        // override turn is one-shot, so it runs stateless. Non-override turns
        // (runtime === this.options.runtime) are byte-for-byte unchanged.
        ...(this.sessionsEnabled() && runtime === this.options.runtime
          ? {
            sessionKeepAlive: true,
            sessionIdleTimeoutMs: this.options.session?.idleTimeoutMs,
            sessionId: resumeSessionId,
            providerSessionId: resumeSessionId,
          }
          : {}),
        onEvent: (event: RuntimeEventLike) => {
          recorder.onEvent(event);
          hostOnEvent?.(event);
        },
      };
      // The provider call is starting: this run has left the admission-pending
      // tier (it now holds a provider slot rather than waiting for one), so
      // release its maxPendingRuns slot. Idempotent at the run() scope, so the
      // resume-retry's second runRuntime does not double-release.
      onProviderStart?.();
      // Synthetic run_config event: tells live/recorded consumers (TUI, replay)
      // the per-run RESOLVED model/effort/executionMode — including per-request
      // overrides (cron job / webhook per-trigger model+effort) — so they never
      // have to re-derive it from scattered runtime_telemetry fields. Delivered
      // to both sinks the same way as the provider_bridge_latency event below.
      const runConfigEvent: RuntimeEventLike = {
        type: "run_config",
        model: modelReferenceKey(effectiveModel),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        ...(effectiveExecutionMode === undefined ? {} : { executionMode: effectiveExecutionMode }),
        overridden: overrideModel !== undefined || overrideEffort !== undefined,
        timestamp: new Date().toISOString(),
      };
      recorder.onEvent(runConfigEvent);
      hostOnEvent?.(runConfigEvent);
      // Synthetic turn_context event: describes the context this specific turn was
      // driven with — the loaded conversation history (or the fact it was omitted
      // because the provider session carries the transcript) and the recalled
      // long-term memory block. The user message is intentionally omitted (it is
      // already the run's userInput). Emitted right after run_config and delivered
      // to both sinks identically. Like run_config it double-fires on the
      // resume-replay retry (the second carries the replayed history); consumers are
      // last-wins.
      //
      // `historyOmitted` is true only for a confirmed live warm mapping. A cold
      // epoch-owned reopen may create its JSONL on miss, so an empty canonical
      // history must remain distinguishable from intentionally omitted history.
      const turnContextEvent = buildTurnContextEvent(history, historyOmitted, memory);
      recorder.onEvent(turnContextEvent);
      hostOnEvent?.(turnContextEvent);
      // Bracket the provider call so observability can separate provider+tool+IO
      // time (this event's durationMs) from harness overhead (context build,
      // attachment persistence, compaction, admission wait).
      const bridgeStartMs = Date.now();
      try {
        return await runtime.run(context.prompt, runtimeOptions);
      } finally {
        const latencyEvent: RuntimeEventLike = {
          type: "provider_bridge_latency",
          durationMs: Date.now() - bridgeStartMs,
          timestamp: new Date(bridgeStartMs).toISOString(),
        };
        recorder.onEvent(latencyEvent);
        hostOnEvent?.(latencyEvent);
      }
    } finally {
      // Remove the abort listener to avoid leaking it on the signal, then run
      // the (idempotent) release so the slot frees exactly once whether the run
      // settled normally or an abort already released it.
      request.abortSignal.removeEventListener("abort", onAbortCleanupAndRelease);
      try {
        await cleanupRequestExtension();
      } finally {
        try {
          await cleanupAfterSettlement();
        } finally {
          releaseSlot();
        }
      }
    }
  }

  /** Build the redacted, enriched bytes shared by history and continuation snapshots. */
  private async buildSuccessfulTurn(
    conversationId: string,
    userMessage: string,
    assistantText: string,
    runId: string,
  ): Promise<{
    readonly capturedAt: string;
    readonly messages: readonly [HistoryMessage, HistoryMessage];
  }> {
    const capturedAt = this.options.now?.().toISOString() ?? new Date().toISOString();
    let assistantHistoryText = assistantText;
    try {
      assistantHistoryText = await this.options.turnHistoryEnricher?.enrichAssistantHistory({
        runId,
        conversationId,
        assistantText,
      }) ?? assistantText;
    } catch {
      // Enrichment is additive. A successful provider answer still commits its
      // original bytes when the optional app-owned enrichment fails.
    }
    return {
      capturedAt,
      messages: [
        { role: "user", content: userMessage, timestamp: capturedAt, runId },
        { role: "assistant", content: assistantHistoryText, timestamp: capturedAt, runId },
      ],
    };
  }

  /**
   * Persists additive memory after durable conversation history commits. `userMessage` here is the
   * PERSIST text (original caption + redacted attachment metadata), NOT the
   * provider-facing expanded prompt — see applyAttachments. Keeping the
   * expanded prompt (absolute paths + up to 8KB extracted document body) out of
   * durable history/memory prevents sensitive content leaking into future
   * prompts replayed from history or into memory recall.
   */
  private async persistSuccessfulMemory(
    conversationId: string,
    userMessage: string,
    assistantText: string,
    options: {
      readonly runId: string;
      readonly source?: string;
      readonly emit?: (event: RuntimeEventLike) => void;
    },
  ): Promise<void> {
    const mode = this.options.memoryWriteMode;
    if (this.options.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      if (shouldSkipMemoryPersistence(userMessage, assistantText, options)) {
        return;
      }
      const memory = this.options.memory;
      const summary = deterministicHostSummary(userMessage, assistantText, options);
      try {
        const persistCompletedTurn = memory.persistCompletedTurn;
        if (persistCompletedTurn !== undefined) {
          // A strong store owns the entire write. Its stable run id makes a
          // retry idempotent, and awaiting it keeps successful completion behind
          // the store's admission boundary without replaying either legacy call.
          await persistCompletedTurn.call(memory, {
            runId: options.runId,
            conversationId,
            summary,
            ...(mode === "capture"
              ? { captureText: captureTurnText(userMessage, assistantText, options) }
              : {}),
          });
        } else {
          // Legacy stores retain the deterministic rapid log plus optional
          // best-effort curation queue exactly as before.
          await memory.appendHostSummary(conversationId, summary);
          if (mode === "capture") {
            memory.scheduleCapture?.(conversationId, captureTurnText(userMessage, assistantText, options));
          }
        }
      } catch {
        // The provider answer already succeeded. Memory is additive and must
        // never retroactively turn that answer into a failed turn. Keep this
        // diagnostic constant: backend errors can contain secrets, paths,
        // model content, hostile accessors, or control characters.
        const message = MEMORY_PERSISTENCE_WARNING;
        try {
          options.emit?.({
            type: "runtime_warning",
            warning_kind: "memory_persistence_degraded",
            message,
          });
        } catch {
          // User event callbacks are untrusted and cannot fail the turn.
        }
        try {
          this.options.onMemoryWarning?.(message);
        } catch {
          // Host diagnostics are best-effort.
        }
      }
    }
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new MonoAgentHarness(options);
}

function withSessionBoundaryTimestamp(event: AgentHarnessSessionBoundary, timestamp: string): RuntimeEventLike {
  return event.timestamp === undefined ? { ...event, timestamp } : { ...event };
}

function sessionEventFromRecord(
  kind: AgentHarnessSessionEvent["kind"],
  record: RuntimeSessionRecord | RuntimeSessionSnapshot,
  reason: string | undefined,
  snapshot: AgentHarnessSessionEvent["snapshot"],
): AgentHarnessSessionEvent {
  return {
    kind,
    conversationId: record.conversationId,
    providerSessionId: record.providerSessionId,
    ...(record.providerSessionRevision === undefined
      ? {}
      : { providerSessionRevision: record.providerSessionRevision }),
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    busy: record.busy,
    ...(reason === undefined ? {} : { reason }),
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

function validateOptions(options: AgentHarnessOptions): void {
  if (typeof options.identityPath !== "string" || options.identityPath.trim().length === 0) {
    throw new TypeError("identityPath must be a non-empty path.");
  }
  if (typeof options.runtime?.run !== "function") {
    throw new TypeError("runtime must expose run().");
  }
  if (typeof options.model !== "object" || options.model === null) {
    throw new TypeError("model must be a parsed runtime model reference.");
  }
  if (
    options.executionMode !== undefined &&
    (typeof options.executionMode !== "string" || options.executionMode.length === 0)
  ) {
    throw new TypeError("executionMode must be an optional non-empty string.");
  }
  if (options.mcpRequestContext !== undefined) {
    if (!Array.isArray(options.mcpRequestContext.serverNames)
      || options.mcpRequestContext.serverNames.some((name) => typeof name !== "string" || name.trim().length === 0)) {
      throw new TypeError("mcpRequestContext.serverNames must contain non-empty strings.");
    }
    if (typeof options.mcpRequestContext.runOutputRoot !== "string"
      || options.mcpRequestContext.runOutputRoot.trim().length === 0) {
      throw new TypeError("mcpRequestContext.runOutputRoot must be a non-empty path.");
    }
  }
  if (options.continuationContext !== undefined) {
    if (!Array.isArray(options.continuationContext.serverNames)
      || options.continuationContext.serverNames.some((name) => typeof name !== "string" || name.trim().length === 0)) {
      throw new TypeError("continuationContext.serverNames must contain non-empty strings.");
    }
    if (typeof options.continuationContext.capabilityIssuer?.issueContinuationClaimCapability !== "function") {
      throw new TypeError("continuationContext.capabilityIssuer must issue continuation claim capabilities.");
    }
  }
}

const SAFE_RUN_OUTPUT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const MCP_REQUEST_CONTEXT_RESERVED_ENV = {
  conversationId: "MONO_AGENT_MCP_PRODUCING_CONVERSATION_ID",
  runId: "MONO_AGENT_MCP_PRODUCING_RUN_ID",
  runOutputDir: "MONO_AGENT_MCP_RUN_OUTPUT_DIR",
  progressUrl: "MONO_AGENT_INTERACTION_PROGRESS_URL",
  progressToken: "MONO_AGENT_INTERACTION_PROGRESS_TOKEN",
  attachmentsRoot: "MONO_AGENT_MCP_ATTACHMENTS_ROOT",
  allowedAttachmentPaths: "MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS",
  allowedAttachmentIdentities: "MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES",
} as const;

const MCP_CONTINUATION_RESERVED_ENV = {
  url: "MONO_AGENT_CONTINUATION_CLAIM_URL",
  token: "MONO_AGENT_CONTINUATION_CLAIM_TOKEN",
  fingerprint: "MONO_AGENT_CONTINUATION_CLAIM_FINGERPRINT",
  mode: "MONO_AGENT_CONTINUATION_CLAIM_MODE",
} as const;

const MCP_CONTINUATION_RESERVED_HEADERS = {
  url: "x-mono-agent-continuation-claim-url",
  token: "x-mono-agent-continuation-claim-token",
  fingerprint: "x-mono-agent-continuation-claim-fingerprint",
  mode: "x-mono-agent-continuation-claim-mode",
} as const;

async function injectMcpRequestContext(input: {
  readonly options: AgentHarnessMcpRequestContextOptions | undefined;
  readonly mcpServers: unknown;
  readonly conversationId: string;
  readonly runId: string;
  readonly attachmentsRoot: string;
  readonly allowedAttachmentPaths: readonly string[];
  readonly allowedAttachmentIdentities: readonly AttachmentFileIdentity[];
}): Promise<{
  readonly mcpServers: Record<string, unknown>;
  readonly progressCapability?: AgentHarnessProgressCapability;
  readonly cleanup: () => Promise<void>;
} | undefined> {
  if (input.options === undefined || input.options.serverNames.length === 0 || !isRecord(input.mcpServers)) {
    return undefined;
  }
  const selected = new Set(input.options.serverNames);
  const selectedStdio = Object.entries(input.mcpServers).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      selected.has(entry[0]) && isValidMcpServerName(entry[0]) && isStdioMcpServerSpec(entry[1]),
  );
  if (selectedStdio.length === 0) {
    return undefined;
  }
  if (!SAFE_RUN_OUTPUT_SEGMENT.test(input.runId)) {
    throw new AgentHarnessError(
      "invalid_run_id",
      "The run id is not safe for request-scoped MCP output isolation.",
      { runId: input.runId },
    );
  }
  const outputRoot = resolve(input.options.runOutputRoot);
  const runOutputDir = join(outputRoot, input.runId);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  try {
    await mkdir(runOutputDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await lstat(runOutputDir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new AgentHarnessError(
        "unsafe_run_output",
        "The request-scoped MCP output path is not a real directory.",
        { runOutputDir },
      );
    }
  }
  const runOutputIdentity = fileIdentity(await lstat(runOutputDir));

  const cleanup = async (): Promise<void> => {
    await removeOwnedDirectory(runOutputDir, runOutputIdentity);
  };
  let progressCapability: AgentHarnessProgressCapability | undefined;
  try {
    progressCapability = input.options.progressCapabilityIssuer === undefined
      ? undefined
      : await input.options.progressCapabilityIssuer.issueProgressCapability({
          conversationId: input.conversationId,
          runId: input.runId,
        });
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  const trustedEnv: Record<string, string> = {
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.conversationId]: input.conversationId,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.runId]: input.runId,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.runOutputDir]: runOutputDir,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.progressUrl]: progressCapability?.url ?? "",
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.progressToken]: progressCapability?.token ?? "",
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.attachmentsRoot]: input.attachmentsRoot,
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.allowedAttachmentPaths]: JSON.stringify(input.allowedAttachmentPaths),
    [MCP_REQUEST_CONTEXT_RESERVED_ENV.allowedAttachmentIdentities]: JSON.stringify(input.allowedAttachmentIdentities),
    // Opted project MCPs receive a scoped progress capability, never the bridge's
    // all-routes master bearer even if the host process has stale ambient values.
    MONO_AGENT_INTERACTION_BRIDGE_URL: "",
    MONO_AGENT_INTERACTION_BRIDGE_TOKEN: "",
  };
  let mcpServers: Record<string, unknown>;
  try {
    mcpServers = { ...input.mcpServers };
    for (const [name, spec] of selectedStdio) {
      mcpServers[name] = cloneStdioMcpServerWithEnv(spec, trustedEnv);
    }
  } catch (error) {
    await progressCapability?.release();
    await cleanup().catch(() => undefined);
    throw error;
  }
  return {
    mcpServers,
    ...(progressCapability === undefined ? {} : { progressCapability }),
    cleanup,
  };
}

async function injectMcpContinuationContext(input: {
  readonly options: AgentHarnessContinuationContextOptions | undefined;
  readonly mcpServers: unknown;
  readonly conversationId: string;
  readonly replyTo: AgentHarnessRequest["replyTo"];
  readonly runId: string;
}): Promise<{
  readonly mcpServers: Record<string, unknown>;
  readonly capabilities: readonly AgentHarnessContinuationClaimCapability[];
} | undefined> {
  if (input.options === undefined || input.options.serverNames.length === 0 || !isRecord(input.mcpServers)) {
    return undefined;
  }

  const selected = new Set(input.options.serverNames);
  const entries = Object.entries(input.mcpServers).filter(([name]) => selected.has(name));
  if (entries.length === 0) {
    return undefined;
  }

  const capabilities: AgentHarnessContinuationClaimCapability[] = [];
  const mcpServers: Record<string, unknown> = { ...input.mcpServers };
  try {
    for (const [serverName, rawSpec] of entries) {
      if (!isValidMcpServerName(serverName) || !isRecord(rawSpec)) {
        throw unsupportedContinuationServer(serverName);
      }
      const transport = classifyContinuationMcpServerTransport(rawSpec);
      if (transport === "unsupported") {
        throw unsupportedContinuationServer(serverName);
      }

      const capability = await input.options.capabilityIssuer.issueContinuationClaimCapability({
        runId: input.runId,
        serverName,
        conversationId: input.conversationId,
        ...(input.replyTo === undefined
          ? {}
          : { replyTo: input.replyTo, historyBoundary: input.runId }),
      });
      if (capability !== undefined) {
        capabilities.push(capability);
        validateContinuationCapability(capability, serverName);
      }

      if (transport === "stdio") {
        const trustedEnv = {
          [MCP_CONTINUATION_RESERVED_ENV.url]: capability?.url ?? "",
          [MCP_CONTINUATION_RESERVED_ENV.token]: capability?.token ?? "",
          [MCP_CONTINUATION_RESERVED_ENV.fingerprint]: capability?.fingerprint ?? "",
          [MCP_CONTINUATION_RESERVED_ENV.mode]: capability?.mode ?? "",
        };
        mcpServers[serverName] = cloneStdioMcpServerWithEnv(rawSpec, trustedEnv);
      } else {
        mcpServers[serverName] = cloneHttpMcpServerWithContinuationHeaders(rawSpec, capability);
      }
    }
  } catch (error) {
    await Promise.allSettled(capabilities.map(async (capability) => capability.release()));
    throw error;
  }

  return { mcpServers, capabilities };
}

function unsupportedContinuationServer(serverName: string): AgentHarnessError {
  return new AgentHarnessError(
    "unsupported_continuation_server",
    `Continuation server ${serverName} must use stdio or loopback HTTP.`,
    { serverName },
  );
}

function validateContinuationCapability(
  capability: AgentHarnessContinuationClaimCapability,
  serverName: string,
): void {
  if (typeof capability.url !== "string" || !isLoopbackUrl(capability.url)) {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must use a loopback HTTP URL.",
      { serverName },
    );
  }
  if (typeof capability.token !== "string" || capability.token.trim().length === 0
    || typeof capability.fingerprint !== "string" || capability.fingerprint.trim().length === 0
    || !(["reply", "notify_if_actionable", "silent", "capture"] as const).includes(capability.mode)) {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must include a token, fingerprint, and supported mode.",
      { serverName },
    );
  }
  if (typeof capability.release !== "function") {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must provide release().",
      { serverName },
    );
  }
  if (typeof capability.finalizeOriginContext !== "function"
    || typeof capability.requiresOriginContext !== "function"
    || typeof capability.activateOriginContext !== "function"
    || typeof capability.abandonOriginContext !== "function") {
    throw new AgentHarnessError(
      "invalid_continuation_capability",
      "Continuation claim capabilities must provide durable origin-context finalization.",
      { serverName },
    );
  }
}

async function continuationCapabilitiesRequiringOriginContext(
  capabilities: readonly AgentHarnessContinuationClaimCapability[],
): Promise<AgentHarnessContinuationClaimCapability[]> {
  const required = await Promise.all(capabilities.map(async (capability) => ({
    capability,
    required: await capability.requiresOriginContext(),
  })));
  return required.filter((entry) => entry.required).map((entry) => entry.capability);
}

async function activateContinuationOriginContexts(
  capabilities: readonly AgentHarnessContinuationClaimCapability[],
): Promise<void> {
  await Promise.all(capabilities.map(async (capability) => {
    await capability.activateOriginContext();
  }));
}

async function finalizeContinuationOriginContexts(
  capabilities: readonly AgentHarnessContinuationClaimCapability[],
  snapshot: AgentContinuationOriginContext,
): Promise<void> {
  // One origin run may expose more than one continuation-capable MCP server.
  // Every issuer must durably pin the same completed snapshot before the origin
  // answer is returned; partial success is treated as a failed origin turn.
  await Promise.all(capabilities.map(async (capability) => {
    await capability.finalizeOriginContext(snapshot);
  }));
}

function buildContinuationOriginContext(input: {
  readonly conversationId: string;
  readonly runId: string;
  readonly capturedAt: string;
  readonly priorHistory: readonly HistoryMessage[];
  readonly completedTurn: readonly [HistoryMessage, HistoryMessage];
}): AgentContinuationOriginContext {
  // Preserve exact bytes for the newest bounded host-history projection. An
  // overlarge/invalid older message is omitted as a whole; content is never
  // silently truncated. The completed origin turn itself must fit or the run
  // fails closed before reporting success.
  const availableMessages = AGENT_CONTINUATION_ORIGIN_CONTEXT_MAX_MESSAGES - input.completedTurn.length;
  const priorGroups = continuationSnapshotHistoryGroups(input.priorHistory)
    .filter((group) => group.every(isContinuationSnapshotHistoryMessage));
  const selectedGroups: HistoryMessage[][] = [];
  let selectedCount = 0;
  for (let index = priorGroups.length - 1; index >= 0; index -= 1) {
    const group = priorGroups[index] as HistoryMessage[];
    if (selectedCount + group.length > availableMessages) break;
    selectedGroups.unshift(group);
    selectedCount += group.length;
  }
  while (true) {
    const prior = selectedGroups.flat();
    const snapshot: AgentContinuationOriginContext = {
      schemaVersion: 1,
      conversationId: input.conversationId,
      originRunId: input.runId,
      historyBoundary: input.runId,
      capturedAt: input.capturedAt,
      messages: [...prior, ...input.completedTurn],
    };
    try {
      assertAgentContinuationOriginContext(snapshot);
      return snapshot;
    } catch (error) {
      if (selectedGroups.length === 0) throw error;
      // Size pressure evicts an entire oldest host turn. Never leave an
      // assistant reply without its user message (or vice versa).
      selectedGroups.shift();
    }
  }
}

function continuationSnapshotHistoryGroups(messages: readonly HistoryMessage[]): HistoryMessage[][] {
  const groups: HistoryMessage[][] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index] as HistoryMessage;
    if (typeof message.runId === "string" && message.runId.length > 0) {
      const group = [message];
      index += 1;
      while (index < messages.length && messages[index]?.runId === message.runId) {
        group.push(messages[index] as HistoryMessage);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    const next = messages[index + 1];
    if (message.role === "user" && next?.role === "assistant" && next.runId === undefined) {
      groups.push([message, next]);
      index += 2;
      continue;
    }
    // Legacy history can contain standalone system/tool entries. Retain them
    // atomically; only user/assistant pairs are inferred as a turn.
    groups.push([message]);
    index += 1;
  }
  return groups;
}

function isContinuationSnapshotHistoryMessage(message: HistoryMessage): boolean {
  try {
    const timestamp = "2026-01-01T00:00:00.000Z";
    assertAgentContinuationOriginContext({
      schemaVersion: 1,
      conversationId: "validation",
      originRunId: "validation-run",
      historyBoundary: "validation-run",
      capturedAt: timestamp,
      messages: [
        { ...message },
        { role: "user", content: "validation", timestamp, runId: "validation-run" },
        { role: "assistant", content: "validation", timestamp, runId: "validation-run" },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:")
      && (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1");
  } catch {
    return false;
  }
}

function cloneHttpMcpServerWithContinuationHeaders(
  spec: Record<string, unknown>,
  capability: AgentHarnessContinuationClaimCapability | undefined,
): Record<string, unknown> {
  const reserved = new Set<string>(Object.values(MCP_CONTINUATION_RESERVED_HEADERS));
  const configuredHeaders = isRecord(spec.headers)
    ? Object.fromEntries(
        Object.entries(spec.headers).filter(([name]) => !reserved.has(name.toLowerCase())),
      )
    : {};
  const trustedHeaders = capability === undefined
    ? {}
    : {
        [MCP_CONTINUATION_RESERVED_HEADERS.url]: capability.url,
        [MCP_CONTINUATION_RESERVED_HEADERS.token]: capability.token,
        [MCP_CONTINUATION_RESERVED_HEADERS.fingerprint]: capability.fingerprint,
        [MCP_CONTINUATION_RESERVED_HEADERS.mode]: capability.mode,
      };
  return { ...spec, headers: { ...configuredHeaders, ...trustedHeaders } };
}

function fileIdentity(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(
  stats: { readonly dev: number; readonly ino: number },
  expected: FileIdentity,
): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

/** Delete only the directory object this request created; never follow swaps. */
async function removeOwnedDirectory(path: string, expected: FileIdentity): Promise<void> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, expected)) {
    return;
  }
  await rm(path, { recursive: true, force: true });
}

function cloneStdioMcpServerWithEnv(
  spec: Record<string, unknown>,
  trustedEnv: Readonly<Record<string, string>>,
): Record<string | symbol, unknown> {
  const configuredEnv = isRecord(spec.env) ? spec.env : {};
  return { ...spec, env: { ...configuredEnv, ...trustedEnv } };
}

function validateRequest(request: AgentHarnessRequest): void {
  if (typeof request.conversationId !== "string" || request.conversationId.trim().length === 0) {
    throw new TypeError("conversationId must be a non-empty string.");
  }
  if (typeof request.userMessage !== "string") {
    throw new TypeError("userMessage must be a string.");
  }
  // Attachment-only turns (e.g. a Slack/Telegram file upload with no caption)
  // are valid: applyAttachments() synthesizes a non-empty prompt referencing the
  // files. Only reject when there is neither text nor any attachment.
  const hasAttachments = Array.isArray(request.attachments) && request.attachments.length > 0;
  if (request.userMessage.trim().length === 0 && !hasAttachments) {
    throw new TypeError("userMessage must be a non-empty string unless attachments are provided.");
  }
  if (!(request.abortSignal instanceof AbortSignal)) {
    throw new TypeError("abortSignal is required.");
  }
  if (request.replyTo !== undefined
    && (typeof request.replyTo.conversationId !== "string" || request.replyTo.conversationId.trim().length === 0)) {
    throw new TypeError("replyTo.conversationId must be a non-empty string.");
  }
  if (request.continuation !== undefined) {
    const continuation = request.continuation;
    if (typeof continuation.continuationId !== "string" || continuation.continuationId.trim().length === 0
      || typeof continuation.originRunId !== "string" || continuation.originRunId.trim().length === 0
      || (continuation.originContextPolicy !== "pinned" && continuation.originContextPolicy !== "detached_latest")
      || (continuation.historyBoundary !== undefined
        && (typeof continuation.historyBoundary !== "string" || continuation.historyBoundary.trim().length === 0))
      || (continuation.originContextPolicy === "pinned" && continuation.originContext === undefined)
      || (continuation.originContextPolicy === "detached_latest" && continuation.originContext !== undefined)
      || continuation.toolsDisabled !== true
      || continuation.deferHistoryCommit !== true) {
      throw new TypeError("continuation must contain valid host-only synthesis controls.");
    }
    if (continuation.originContext !== undefined) assertAgentContinuationOriginContext(continuation.originContext);
  }
}

/**
 * Local-provider endpoint keys a per-request model override OWNS. On these keys
 * an explicit `null` from a LATER options object CLEARS an earlier value (the
 * key is deleted from the merge); `undefined` still means "leave untouched".
 * This lets a cloud / unconfigured-local model override explicitly drop the host
 * default's local `customProvider` block so the pi runtime — which routes on
 * `customProvider` PRESENCE alone — does not send a cloud model to the default
 * local endpoint. See request-model-override.ts for who emits the null.
 */
const ENDPOINT_CLEAR_KEYS: ReadonlySet<string> = new Set([
  "customProvider",
  "customModel",
  "modelCapabilities",
  "isPrivateProvider",
]);

const TOOL_POLICY_OPTION_KEYS: ReadonlySet<string> = new Set([
  "allowedTools",
  "disallowedTools",
  "mcpServers",
  "mcpConfigPath",
]);

function withoutToolPolicyOptions(
  options: AgentHarnessRuntimeOptionsExtension["runtimeOptions"] | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (options === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !TOOL_POLICY_OPTION_KEYS.has(key)),
  );
}

function mergeRuntimeOptions(
  ...optionsList: readonly (AgentHarnessRuntimeOptionsExtension["runtimeOptions"] | Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (value === null && ENDPOINT_CLEAR_KEYS.has(key)) {
        delete merged[key];
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      if (key === "sandboxPolicy") {
        merged[key] = mergeSandboxPolicies(asSandboxPolicy(merged[key]), asSandboxPolicy(value));
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function asSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  return isRecord(value) ? value as unknown as SandboxPolicy : undefined;
}

/** Narrow a merged-options value to a RuntimeModelReference (a per-request model override). */
function isRuntimeModelReference(value: unknown): value is RuntimeModelReference {
  return isRecord(value) && typeof value.sdk === "string" && typeof value.model === "string";
}

function sameRuntimeModel(a: RuntimeModelReference, b: RuntimeModelReference): boolean {
  return modelReferenceKey(a) === modelReferenceKey(b);
}

/**
 * Execution mode for an override model: keep the host's configured mode when the
 * override model supports it, otherwise the override model's default mode.
 */
function executionModeForOverride(
  model: RuntimeModelReference,
  hostMode: string | undefined,
): RuntimeExecutionMode {
  if (hostMode !== undefined) {
    try {
      assertExecutionModeCompatible(model, hostMode);
      return hostMode as RuntimeExecutionMode;
    } catch {
      // Host mode is incompatible with the override model — use the model default.
    }
  }
  return defaultExecutionModeForModel(model);
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const SESSION_RESUME_RETRY_FAILURE_KINDS = new Set(["session_not_found", "session_busy"]);

function shouldRetrySessionResumeError(error: unknown): boolean {
  return SESSION_RESUME_RETRY_FAILURE_KINDS.has(failureKindFromUnknown(error));
}

function shouldRetryWithoutSession(result: RuntimeResult | undefined, aborted: boolean): boolean {
  if (result === undefined || aborted || result.cancelled === true) {
    return false;
  }
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return SESSION_RESUME_RETRY_FAILURE_KINDS.has(result.failureKind);
  }
  return false;
}

function failureKindFromUnknown(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const direct = value.failureKind;
  if (typeof direct === "string") {
    return direct.trim();
  }
  const details = value.details;
  if (isRecord(details) && typeof details.failureKind === "string") {
    return details.failureKind.trim();
  }
  return "";
}

function failureFromRuntimeResult(result: RuntimeResult): AgentHarnessFailure | undefined {
  if (result.cancelled === true) {
    return {
      kind: "cancelled",
      message: "Agent runtime run was cancelled.",
      details: result,
    };
  }
  if (typeof result.failureKind === "string" && result.failureKind.trim().length > 0) {
    return {
      kind: result.failureKind,
      message: typeof result.error === "string" && result.error.trim().length > 0 ? result.error : "Agent runtime failed.",
      details: result.errorDetails ?? result,
    };
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return {
      kind: "runtime_error",
      message: result.error,
      details: result.errorDetails ?? result,
    };
  }
  return undefined;
}

function failureFromThrownError(error: unknown, wasAborted: boolean): AgentHarnessFailure {
  if (wasAborted) {
    return { kind: "cancelled", message: "Agent request was cancelled.", details: errorToDetails(error) };
  }
  if (error instanceof AgentHarnessError) {
    return { kind: error.failureKind, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { kind: error.name || "exception", message: error.message, details: errorToDetails(error) };
  }
  return { kind: "exception", message: String(error), details: error };
}

function cancellationFailureKind(signal: AbortSignal): "cancelled" | "cancelled_user" {
  return isChannelUserCancelReason(signal.reason) ? "cancelled_user" : "cancelled";
}

async function safeRecorderCancel(
  recorder: RunRecorder,
  failureKind: "cancelled" | "cancelled_user",
): Promise<RunSummary | undefined> {
  try {
    return await recorder.finish({ cancelled: true, failureKind });
  } catch {
    return undefined;
  }
}

async function safeRecorderFail(recorder: RunRecorder, error: unknown): Promise<RunSummary | undefined> {
  try {
    return await recorder.fail(error);
  } catch {
    return undefined;
  }
}

async function commitRecorderFinish(recorder: RunRecorder, result: RuntimeResultLike): Promise<RunSummary> {
  return recorder.commitFinish === undefined
    ? await recorder.finish(result)
    : await recorder.commitFinish(result);
}

async function safeRecorderCommitFinish(
  recorder: RunRecorder,
  result: RuntimeResultLike,
): Promise<RunSummary | undefined> {
  try {
    return await commitRecorderFinish(recorder, result);
  } catch {
    return undefined;
  }
}

function normalizeAssistantText(text: unknown): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  return text.trim().length === 0 ? undefined : text;
}

function responseMetadata(
  runId: string,
  request: AgentHarnessRequest,
  context: BuiltAgentContext | undefined,
  summary: RunSummary | undefined,
  runtimeResult?: RuntimeResult,
): AgentHarnessResponse["metadata"] {
  const externalSummary = summary === undefined ? undefined : externalResponseSummary(summary);
  return {
    runId,
    conversationId: request.conversationId,
    contextSources: context?.metadata.sources ?? [],
    contextSectionIds: context?.sections.map((section) => section.id) ?? [],
    ...(runtimeResult === undefined ? {} : { runtime: runtimeMetadata(runtimeResult) }),
    ...(externalSummary === undefined ? {} : { summary: externalSummary }),
  };
}

/**
 * Recorder summaries stay complete for local artifacts and session-web, but a
 * harness response crosses a channel boundary. The compiled system prompt can
 * contain identity and context, so it is never returned to channel callers.
 */
function externalResponseSummary(summary: RunSummary): ExternalRunSummary | undefined {
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(summary);
    prototype = Object.getPrototypeOf(summary);
  } catch {
    return undefined;
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const runId = summaryDataProperty(descriptors, "runId");
  const conversationId = summaryDataProperty(descriptors, "conversationId");
  const status = summaryDataProperty(descriptors, "status");
  const durationMs = summaryDataProperty(descriptors, "durationMs");
  const eventCount = summaryDataProperty(descriptors, "eventCount");
  const rawArtifactPaths = summaryDataProperty(descriptors, "artifactPaths");
  const artifactPaths = cloneExternalSummaryValue(rawArtifactPaths);
  if (
    typeof runId !== "string" ||
    typeof conversationId !== "string" ||
    !isExternalSummaryStatus(status) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    typeof eventCount !== "number" ||
    !Number.isFinite(eventCount) ||
    !Array.isArray(artifactPaths) ||
    !Array.from(artifactPaths).every((value) => typeof value === "string")
  ) {
    return undefined;
  }

  const external = Object.create(null) as Record<string, unknown>;
  external.runId = runId;
  external.conversationId = conversationId;
  external.status = status;
  external.durationMs = durationMs;
  external.eventCount = eventCount;
  external.artifactPaths = artifactPaths;
  // This allowlist is deliberately explicit. Recorder implementations are a
  // public injection seam, so a rest spread could copy a callable `toJSON`
  // hook that reconstructs the omitted systemPrompt during channel JSON
  // serialization. Unknown-valued fields are cloned without invoking toJSON,
  // getters, or custom prototypes; an unsafe value is omitted fail-closed.
  for (const key of EXTERNAL_SUMMARY_OPTIONAL_KEYS) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) continue;
    const value = descriptor.value;
    if (value === undefined) continue;
    const cloned = cloneExternalSummaryValue(value);
    if (cloned !== UNSAFE_EXTERNAL_SUMMARY_VALUE) {
      external[key] = cloned;
    }
  }
  return external as unknown as ExternalRunSummary;
}

const UNSAFE_EXTERNAL_SUMMARY_VALUE = Symbol("unsafe-external-summary-value");
const MAX_EXTERNAL_SUMMARY_DEPTH = 64;
const EXTERNAL_SUMMARY_STATUSES = new Set(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const EXTERNAL_SUMMARY_OPTIONAL_KEYS = [
  "failureKind",
  "error",
  "failoverHistory",
  "startedAt",
  "endedAt",
  "updatedAt",
  "usage",
  "cost",
  "providerSessionId",
  "isolated",
  "runtimeWarnings",
  "diagnostics",
  "capabilitiesUsed",
  "userInput",
  "model",
  "effort",
  "source",
  "sourceDetail",
] as const;

function summaryDataProperty(
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown | typeof UNSAFE_EXTERNAL_SUMMARY_VALUE {
  const descriptor = descriptors[key];
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : UNSAFE_EXTERNAL_SUMMARY_VALUE;
}

function isExternalSummaryStatus(value: unknown): value is RunSummary["status"] {
  return typeof value === "string" && EXTERNAL_SUMMARY_STATUSES.has(value);
}

/** Clone JSON-shaped recorder data without honoring executable serialization hooks. */
function cloneExternalSummaryValue(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown | typeof UNSAFE_EXTERNAL_SUMMARY_VALUE {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : UNSAFE_EXTERNAL_SUMMARY_VALUE;
  if (typeof value !== "object" || depth >= MAX_EXTERNAL_SUMMARY_DEPTH) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  if (ancestors.has(value)) return UNSAFE_EXTERNAL_SUMMARY_VALUE;

  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  }
  const isArray = Array.isArray(value);
  if (
    (isArray && prototype !== Array.prototype && prototype !== null) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  }
  const toJson = descriptors.toJSON;
  if (toJson !== undefined && (!("value" in toJson) || typeof toJson.value === "function")) {
    return UNSAFE_EXTERNAL_SUMMARY_VALUE;
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (!Number.isSafeInteger(length) || length < 0) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
      const cloned: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
        const item = cloneExternalSummaryValue(descriptor.value, ancestors, depth + 1);
        if (item === UNSAFE_EXTERNAL_SUMMARY_VALUE) return item;
        cloned[index] = item;
      }
      return cloned;
    }

    const cloned = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || key === "toJSON") continue;
      if (!("value" in descriptor)) return UNSAFE_EXTERNAL_SUMMARY_VALUE;
      const item = cloneExternalSummaryValue(descriptor.value, ancestors, depth + 1);
      if (item === UNSAFE_EXTERNAL_SUMMARY_VALUE) return item;
      Object.defineProperty(cloned, key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Host-owned delivery guidance for the current turn. Physical channel and thread
 * identities deliberately stay out of model context: an opted-in MCP server gets
 * an opaque destination-bound claim capability instead. A model may promise a
 * later reply only after such a tool confirms that the continuation was registered.
 */
function sessionContextBlock(
  request: Pick<AgentHarnessRequest, "metadata" | "replyTo">,
  hostManagedMemory = false,
): string {
  const deliverable = request.replyTo !== undefined && !hasRequestDrivenTrigger(request.metadata);
  const memoryGuidance = hostManagedMemory ? HOST_MANAGED_MEMORY_GUIDANCE : undefined;
  if (deliverable) {
    return [
      "You are handling an interactive push conversation. The host owns its exact channel and thread destination.",
      "Never copy, request, infer, or pass a conversation id, channel id, callback URL, or delivery token. You may promise a later reply only after a continuation-capable tool explicitly confirms that a destination-bound continuation was registered; otherwise finish synchronously or explain that background delivery was not scheduled.",
      memoryGuidance,
    ].filter((part) => part !== undefined).join("\n\n");
  }
  const base = "This is a request-driven run (scheduled, webhook, or API) with no interactive user attached to a deliverable push conversation. Do not invent or infer a callback destination.";
  const notifyGuidance = notifyDeliveryGuidance(request.metadata);
  return [base, notifyGuidance, memoryGuidance]
    .filter((part) => part !== undefined)
    .join("\n\n");
}

function hasRequestDrivenTrigger(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.cron !== undefined || metadata?.webhook !== undefined;
}

const HOST_MANAGED_MEMORY_GUIDANCE = [
  "Long-term memory state is owned by the host; its configured memory pipeline decides whether and how qualifying successful turns are persisted.",
  "To remember something, acknowledge it in your reply and let the host handle capture; never edit memory Markdown, SQLite databases, indexes, manifests, or other internal memory state with file or shell tools.",
  "Use the available recall/search tools to read memory.",
].join(" ");

/**
 * Guidance for a notify-enabled cron/webhook turn (its trigger metadata carries
 * `nativeNotify.enabled`): the agent's final reply is delivered to the user
 * VERBATIM by the host, so it should read as the finished message and there is no
 * tool to call. Returns undefined for any non-notify turn.
 */
function notifyDeliveryGuidance(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined || !(nativeNotifyEnabled(metadata.cron) || nativeNotifyEnabled(metadata.webhook))) {
    return undefined;
  }
  return [
    "This run was triggered on a schedule or by a webhook, and your final reply is delivered to the user on their channel exactly as you write it.",
    "Write your final message as the finished notification: no preface, no meta-commentary, no narration of your steps, and do NOT call any tool to send it — delivery is automatic and posts your reply verbatim.",
    `If there is nothing worth telling the user, reply with exactly \`${NOTHING_TO_REPORT_SENTINEL}\` and nothing else; no notification is sent.`,
  ].join("\n\n");
}

function nativeNotifyEnabled(trigger: unknown): boolean {
  if (typeof trigger !== "object" || trigger === null) {
    return false;
  }
  const nativeNotify = (trigger as { nativeNotify?: unknown }).nativeNotify;
  return (
    typeof nativeNotify === "object" &&
    nativeNotify !== null &&
    (nativeNotify as { enabled?: unknown }).enabled === true
  );
}

function runtimeMetadata(result: RuntimeResult): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of ["model", "sdk", "effort", "numTurns", "durationMs", "usage", "cost", "providerSessionId", "runtimeWarnings", "diagnostics", "capabilitiesUsed"] as const) {
    if (result[key] !== undefined) {
      metadata[key] = result[key];
    }
  }
  return metadata;
}

function failureResponse(input: {
  readonly runId: string;
  readonly request: AgentHarnessRequest;
  readonly summary: RunSummary;
  readonly kind: string;
  readonly message: string;
}): AgentHarnessResponse {
  return {
    metadata: responseMetadata(input.runId, input.request, undefined, input.summary),
    failure: {
      kind: input.kind,
      message: input.message,
    },
  };
}

function deterministicHostSummary(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): string {
  if (isTriggerSource(options.source)) {
    return [
      "Host-observed completed trigger turn.",
      `Assistant: ${compactOneLine(assistantText, 240)}`,
    ].join("\n");
  }
  return [
    "Host-observed completed turn.",
    `User: ${compactOneLine(userMessage, 240)}`,
    `Assistant: ${compactOneLine(assistantText, 240)}`,
  ].join("\n");
}

function captureTurnText(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): string {
  // Richer than the compacted host summary: the distiller wants the real turn content.
  if (isTriggerSource(options.source)) {
    return `Assistant: ${assistantText}`;
  }
  return `User: ${userMessage}\nAssistant: ${assistantText}`;
}

function isTriggerSource(source: string | undefined): boolean {
  return source === "cron" || source === "webhook";
}

const MAX_TRIVIAL_MEMORY_TURN_CHARS = 48;
const TRIVIAL_MEMORY_ANCHOR_TOKENS = new Set([
  "ping",
  "pong",
  "test",
  "testing",
]);
const TRIVIAL_MEMORY_FILLER_TOKENS = new Set([
  "ok",
  "okay",
  "works",
]);

function shouldSkipMemoryPersistence(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): boolean {
  return isNothingToReportSentinel(assistantText) || isTrivialMemoryTurn(userMessage, assistantText, options);
}

function isNothingToReportSentinel(assistantText: string): boolean {
  return assistantText.trim().toUpperCase() === NOTHING_TO_REPORT_SENTINEL;
}

function isTrivialMemoryTurn(
  userMessage: string,
  assistantText: string,
  options: { readonly source?: string } = {},
): boolean {
  const candidate = isTriggerSource(options.source) ? assistantText : `${userMessage} ${assistantText}`;
  const compact = candidate.replace(/\s+/gu, " ").trim();
  if (compact.length === 0 || compact.length > MAX_TRIVIAL_MEMORY_TURN_CHARS) {
    return false;
  }
  const tokens = compact
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  return (
    tokens.some((token) => TRIVIAL_MEMORY_ANCHOR_TOKENS.has(token)) &&
    tokens.every((token) => TRIVIAL_MEMORY_ANCHOR_TOKENS.has(token) || TRIVIAL_MEMORY_FILLER_TOKENS.has(token))
  );
}

function compactOneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

function errorToDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
}

function errorMessageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extracts the renderable text of a recalled-memory context block, or undefined
 * when there is nothing to inject. loadMemory always produces a markdown block,
 * but the ContextBlockInput type is broader, so handle the string and typed-block
 * shapes defensively (a json block carries no `content`, so it yields undefined).
 */
function memoryBlockText(memory: ContextBlockInput | undefined): string | undefined {
  if (memory === undefined) {
    return undefined;
  }
  const content = typeof memory === "string"
    ? memory
    : (typeof memory === "object" && memory !== null && "content" in memory && typeof memory.content === "string"
      ? memory.content
      : undefined);
  if (content === undefined || content.trim().length === 0) {
    return undefined;
  }
  return content;
}

/**
 * Appends the recalled-memory block to the user message (after the user's text and
 * any attachment block applyAttachments already merged in), clearly delimited so
 * the model reads it as injected background context rather than the user's words.
 * Returns the message unchanged when there is no memory to inject.
 */
function composeUserMessageWithMemory(userMessage: string, memory: ContextBlockInput | undefined): string {
  const text = memoryBlockText(memory);
  if (text === undefined) {
    return userMessage;
  }
  return `${userMessage}\n\n[Recalled long-term memory — background context for this turn, not the user's words:]\n${text}`;
}

// Per-entry display caps for the turn_context event. Content is clamped by BOTH a
// CHARACTER cap (below) and a BYTE cap so THIS clamp — not the downstream recorder
// redactor — decides every cut. The recorder truncates string values by UTF-8 byte
// length (redactJsonValue → truncateString at DEFAULT_MAX_STRING_BYTES, 4096); by
// clamping to that same byte budget here, `truncated` stays accurate and the
// redactor never re-truncates heavy multibyte content (2000 chars of 3-byte CJK is
// ~6000 bytes > 4096, and 2000 4-byte emoji is ~8000 bytes). For single-byte
// content the char cap still bites first, so those clamps are unchanged.
const TURN_CONTEXT_MESSAGE_MAX_CHARS = 2_000;
const TURN_CONTEXT_MEMORY_MAX_CHARS = 4_000;
// Mirrors @mono-agent/observability's DEFAULT_MAX_STRING_BYTES (the recorder's
// per-value UTF-8 truncation cap). Kept as a local constant rather than importing
// it, to avoid widening that package's public API for a single number.
const TURN_CONTEXT_MAX_BYTES = 4_096;
const TURN_CONTEXT_ENCODER = new TextEncoder();
const TURN_CONTEXT_DECODER = new TextDecoder();

/**
 * Builds the synthetic `turn_context` event: what context THIS turn was driven
 * with. `historyCount` is the number of loaded prior messages (0 when omitted);
 * `historyOmitted` is true only when a confirmed live warm provider session
 * carries the transcript, so no host history was replayed. A cold durable reopen
 * reports the canonical history it loaded (including an authoritative empty
 * history) because its epoch-owned JSONL may be created on miss. The
 * `history`/`memory` keys are omitted entirely when empty. Each entry is clamped
 * for display, flagging `truncated`. The current user message is deliberately NOT
 * included (it is the run's userInput).
 */
function buildTurnContextEvent(
  history: readonly HistoryMessage[],
  historyOmitted: boolean,
  memory: ContextBlockInput | undefined,
): RuntimeEventLike {
  const mappedHistory = history.map(clampTurnContextMessage);
  const mem = turnContextMemory(memory);
  return {
    type: "turn_context",
    historyCount: history.length,
    historyOmitted,
    ...(mappedHistory.length === 0 ? {} : { history: mappedHistory }),
    ...(mem === undefined ? {} : { memory: mem }),
    timestamp: new Date().toISOString(),
  };
}

function clampTurnContextMessage(message: HistoryMessage): Record<string, unknown> {
  const clamp = clampTurnContextText(message.content, TURN_CONTEXT_MESSAGE_MAX_CHARS);
  return {
    role: message.role,
    content: clamp.text,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(clamp.truncated ? { truncated: true } : {}),
  };
}

/**
 * Maps the recalled-memory ContextBlockInput (loadMemory returns `{kind, content,
 * source}`) to the event's `memory` field, clamped. Returns undefined when there
 * is nothing to show (no recall / empty content), so the caller omits the key.
 */
function turnContextMemory(
  memory: ContextBlockInput | undefined,
): { readonly content: string; readonly source?: string; readonly truncated?: true } | undefined {
  const text = memoryBlockText(memory);
  if (text === undefined) {
    return undefined;
  }
  const source =
    typeof memory === "object" && memory !== null && "source" in memory && typeof memory.source === "string"
      ? memory.source
      : undefined;
  const clamp = clampTurnContextText(text, TURN_CONTEXT_MEMORY_MAX_CHARS);
  return {
    content: clamp.text,
    ...(source === undefined ? {} : { source }),
    ...(clamp.truncated ? { truncated: true } : {}),
  };
}

function clampTurnContextText(value: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const byChars = value.length > maxChars ? value.slice(0, maxChars) : value;
  const truncatedByChars = byChars.length < value.length;
  const bytes = TURN_CONTEXT_ENCODER.encode(byChars);
  if (bytes.length <= TURN_CONTEXT_MAX_BYTES) {
    return { text: byChars, truncated: truncatedByChars };
  }
  // Walk back from the byte cap to a UTF-8 code-point boundary (past any
  // 0b10xxxxxx continuation byte) so a multi-byte char is never split.
  let end = TURN_CONTEXT_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return { text: TURN_CONTEXT_DECODER.decode(bytes.subarray(0, end)), truncated: true };
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  // Audio/video: nameless media (Telegram voice notes) must still save with a
  // usable suffix — ffmpeg and transcription tools sniff format by extension.
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

const ATTACHMENT_TEXT_MAX_CHARS = 8_000;

function attachmentFileName(runId: string, index: number, attachment: AgentAttachment): string {
  const sanitized = sanitizeAttachmentName(attachment.name);
  const base = sanitized ?? `attachment-${index}${MIME_EXTENSIONS[attachment.mimeType] ?? ""}`;
  // runId may come from a caller-supplied createRunId(); sanitize it too so it
  // cannot inject path separators or leading dots and escape attachmentsDir.
  const safeRunId = sanitizeAttachmentName(runId) ?? `run-${index}`;
  return `${safeRunId}-${index}-${base}`;
}

function sanitizeAttachmentName(name: string | undefined): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const cleaned = name.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * One line per attachment. The prompt variant (`includeText: true`) inlines the
 * extracted document body so the current turn sees it one-shot. The persistence
 * variant (`includeText: false`) keeps ONLY the redacted metadata (saved path,
 * mime type, size, original name) — never the extracted body — so durable
 * history/memory retain an actionable file reference without baking the
 * (potentially sensitive) document content into future prompts.
 */
function describeAttachment(
  attachment: AgentAttachment,
  savedPath: string | undefined,
  options: { readonly includeText: boolean } = { includeText: true },
): string {
  const parts: string[] = [];
  if (savedPath !== undefined) {
    parts.push(savedPath);
  }
  parts.push(attachment.mimeType);
  if (typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes)) {
    parts.push(formatAttachmentBytes(attachment.sizeBytes));
  }
  if (typeof attachment.durationSeconds === "number" && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0) {
    parts.push(formatAttachmentDuration(attachment.durationSeconds));
  }
  let line = `- ${parts.join(" — ")}`;
  if (typeof attachment.name === "string" && attachment.name.length > 0) {
    line += ` (original: ${attachment.name})`;
  }
  if (options.includeText && attachment.kind === "document" && typeof attachment.text === "string" && attachment.text.trim().length > 0) {
    const text = attachment.text.length > ATTACHMENT_TEXT_MAX_CHARS
      ? `${attachment.text.slice(0, ATTACHMENT_TEXT_MAX_CHARS)}…[truncated]`
      : attachment.text;
    line += `\n  --- extracted text ---\n${text}\n  --- end of extracted text ---`;
  }
  return line;
}

function formatAttachmentDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")} min`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function createDefaultRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derives a run's `source` (and optional `sourceDetail`) from its request
 * metadata, for the recorder factory input. Priority order mirrors how each
 * channel/trigger stamps `request.metadata`:
 *  1. `metadata.source === "tui"` (the operator-adapter TUI endpoint injects this) → "tui"
 *  2. `metadata.cron` present → "cron", detail = `metadata.cron.jobId` (string)
 *  3. `metadata.webhook` present → "webhook", detail = `metadata.webhook.endpointName` (string)
 *  4. `metadata.slack` / `metadata.telegram` present → that channel name
 *  5. otherwise falls back to {@link deriveRunSource}'s conversationId-prefix
 *     derivation, so unrecognized/legacy metadata still gets a best-effort source.
 * Never throws — `metadata` is `Record<string, unknown> | undefined` and any
 * unexpected shape (e.g. `cron` not itself a record) just falls through.
 */
export function runSourceFromRequest(
  request: Pick<AgentHarnessRequest, "conversationId" | "metadata">,
): { readonly source?: string; readonly sourceDetail?: string } {
  const metadata = request.metadata;
  if (isRecord(metadata)) {
    if (metadata.source === "tui") {
      return { source: "tui" };
    }
    if (isRecord(metadata.cron)) {
      const jobId = metadata.cron.jobId;
      return { source: "cron", ...(typeof jobId === "string" ? { sourceDetail: jobId } : {}) };
    }
    if (isRecord(metadata.webhook)) {
      const endpointName = metadata.webhook.endpointName;
      return { source: "webhook", ...(typeof endpointName === "string" ? { sourceDetail: endpointName } : {}) };
    }
    if (isRecord(metadata.slack)) {
      return { source: "slack" };
    }
    if (isRecord(metadata.telegram)) {
      return { source: "telegram" };
    }
  }
  return { source: deriveRunSource(request.conversationId) };
}

/**
 * A cron/proactive request carries a `cron` metadata block (set by the cron
 * scheduler when it fires a job). Used to scope the proactive-session-isolation
 * opt-in to scheduled runs without touching interactive turns.
 */
function isCronRequest(request: AgentHarnessRequest): boolean {
  return isRecord(request.metadata) && request.metadata.cron !== undefined;
}

/**
 * Whether the request carries a per-turn MODEL override that resolves to a
 * model DIFFERENT from the harness default. The override may be pinned by a
 * trigger (`metadata.webhook`/`metadata.cron`) or picked interactively from the
 * TUI (`metadata.tui`). Only a different model forces session isolation — it
 * runs on a different model (often a different runtime), and the provider session
 * is keyed by conversationId + bound to a model, so resuming or persisting it
 * against the shared session would mix two models' lineage (durable-session
 * corruption / wrong-runtime disposal).
 *
 * A SAME-MODEL override (e.g. an endpoint redundantly naming the host default)
 * leaves the runtime/model chain unchanged, so it must keep the shared continuous
 * session like an ordinary turn. An effort-only override carries no model string;
 * an unparseable string is ignored downstream (warn+ignore → the turn runs on the
 * default), so both are treated as "no model override" here. This keys off the
 * SAME canonical `modelReferenceKey` comparison the harness uses to decide whether
 * to switch runtimes (`sameRuntimeModel`), so the isolation decision and the
 * runtime/session-key decision can never disagree.
 */
export function requestOverridesModel(request: AgentHarnessRequest, defaultModel: RuntimeModelReference): boolean {
  const metadata = request.metadata;
  if (!isRecord(metadata)) {
    return false;
  }
  const source = isRecord(metadata.webhook)
    ? metadata.webhook
    : isRecord(metadata.cron)
      ? metadata.cron
      : isRecord(metadata.tui)
        ? metadata.tui
        : undefined;
  if (source === undefined || typeof source.model !== "string" || source.model.trim().length === 0) {
    return false;
  }
  try {
    return modelReferenceKey(parseMonoRuntimeModelReference(source.model)) !== modelReferenceKey(defaultModel);
  } catch {
    // An unparseable override is warned-and-ignored downstream, so the turn runs
    // on the default model — i.e. no model change, no isolation.
    return false;
  }
}
