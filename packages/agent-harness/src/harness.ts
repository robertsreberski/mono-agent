import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentAttachment } from "@mono-agent/agent-contracts";
import { NOTHING_TO_REPORT_SENTINEL } from "@mono-agent/agent-contracts";
import { deriveRunSource } from "@mono-agent/observability";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
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
import type { LiveSessionManager } from "./live-session.js";
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
  ExternalRunSummary,
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
      ? createLiveSessionManager({ run: (request) => this.run(request) })
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
  async appendVerbatimTurn(conversationId: string, text: string): Promise<void> {
    try {
      await this.sessionStore?.evict(conversationId, "stale");
    } catch {
      // Eviction is best-effort; the durable history append below is what matters.
    }
    const timestamp = this.options.now?.().toISOString() ?? new Date().toISOString();
    await this.options.historyStore?.append(conversationId, [
      { role: "user", content: VERBATIM_DELIVERY_STIMULUS, timestamp },
      { role: "assistant", content: text, timestamp },
    ]);
  }

  async run(request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
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
    const isolated = proactiveIsolated || modelOverrideIsolated;
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
      const summary = await recorder.finish({ cancelled: true, failureKind: "cancelled" });
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
    const leavePending = (): void => {
      if (!left) {
        left = true;
        this.pendingRuns -= 1;
      }
    };
    try {
      if (request.sessionBoundary !== undefined) {
        emit(withSessionBoundaryTimestamp(request.sessionBoundary, this.nowIso()));
      }
      if (isolated) {
        const reason = proactiveIsolated ? "proactive" : "model_override";
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
      const { request: activeRequest, persistUserMessage: persistText } = await this.applyAttachments(request, runId, emit);
      // Resume id: prefer a live in-memory session record; otherwise, when
      // durable pi sessions are configured, derive a STABLE fs-safe id from the
      // conversationId so a turn resumes the on-disk JSONL transcript across a
      // restart (the in-memory conversationId→providerSessionId map is lost on
      // restart). pi-native creates-on-miss with this id, so a first turn for a
      // never-seen conversation still opens a durable session under this id.
      // An isolated proactive run skips the durable resume-id derivation entirely
      // (sessionRecord is already undefined), so resumeSessionId stays undefined
      // and the turn opens no shared/durable session to resume.
      let resumeSessionId = sessionRecord?.providerSessionId
        ?? (!isolated && this.sessionsEnabled() && this.options.piSessionsRoot !== undefined
          ? deriveDurableSessionId(request.conversationId)
          : undefined);
      // Omit history ONLY for a confirmed LIVE session record — it already holds
      // the conversation, so replaying history would double-count (the warm-resume
      // optimization). For a DERIVED durable id (cold/cross-restart resume) we do
      // NOT know whether the on-disk session exists, so we still send history:
      // pi-native ignores it when it successfully resumes the JSONL (the session
      // carries the transcript) and SEEDS it when it creates-on-miss — so a
      // create-on-miss on an existing conversation never loses prior context.
      let prepared = await this.prepareContext(activeRequest, { omitHistory: sessionRecord !== undefined }, emit);
      context = prepared.context;

      let runtimeResult: RuntimeResult | undefined;
      let resumeError: unknown;
      try {
        runtimeResult = await this.runRuntime(activeRequest, recorder, context, prepared.memory, runId, resumeSessionId, prepared.skillDisclosureNames, prepared.history, prepared.historyOmitted, leavePending);
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
        await this.sessionStore?.evict(request.conversationId, "stale", resumeSessionId);
        resumeSessionId = undefined;
        prepared = await this.prepareContext(activeRequest, { omitHistory: false }, emit);
        context = prepared.context;
        runtimeResult = await this.runRuntime(activeRequest, recorder, context, prepared.memory, runId, undefined, prepared.skillDisclosureNames, prepared.history, prepared.historyOmitted, leavePending);
      }
      if (runtimeResult === undefined) {
        throw resumeError ?? new Error("Runtime did not produce a result.");
      }

      // Post-runtime cancellation guard (TOCTOU race): the live-session cancel
      // signal can land AFTER runRuntime() returns a success-shaped result but
      // BEFORE we commit it. Committing a cancelled turn would bake it into the
      // warm session + history + memory, diverging from what the caller (whose
      // promise the LiveSessionManager rejects) believes happened. So when the
      // signal is aborted here, skip saveSession + persistSuccessfulTurn,
      // evict/dispose any returned provider session (mirrors the empty-turn
      // retirement below), and return a cancelled failure instead.
      if (request.abortSignal.aborted) {
        await this.retireRunResultSession(request.conversationId, sessionRecord, runtimeResult.providerSessionId);
        const summary = await recorder.finish({ ...runtimeResult, systemPrompt: context.prompt, isolated, cancelled: true, failureKind: "cancelled" });
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
      // Persist the compiled system prompt (identity + skills + recalled memory)
      // onto the run so the trace shows what the model was instructed with. It is
      // redacted+capped at the recorder and sensitive-gated at export.
      const summary = await recorder.finish(
        failure === undefined
          ? { ...runtimeResult, systemPrompt: context.prompt, isolated }
          : { ...runtimeResult, systemPrompt: context.prompt, isolated, failureKind: failure.kind, error: failure.message },
      );
      const baseMetadata = responseMetadata(runId, request, context, summary, runtimeResult);

      if (failure !== undefined) {
        if (sessionRecord !== undefined && shouldRetireSessionAfterFailure(failure.kind)) {
          await this.sessionStore?.evict(request.conversationId, "stale", sessionRecord.providerSessionId);
        }
        return { metadata: baseMetadata, failure };
      }

      const text = normalizeAssistantText(runtimeResult.text);
      if (text === undefined) {
        // Empty turns are not appended to history, so a retained provider
        // session would diverge from the history store. Retire it instead;
        // the next message replays history into a fresh session.
        await this.retireRunResultSession(request.conversationId, sessionRecord, runtimeResult.providerSessionId);
        return {
          metadata: baseMetadata,
          failure: {
            kind: "empty_response",
            message: "Runtime completed without assistant text.",
            details: runtimeResult,
          },
        };
      }

      // Final cancellation recheck immediately before the commit (R9): the
      // line-221 guard and the empty-text branch are point-in-time checks, but
      // `await recorder.finish()` above yields to the event loop (real disk I/O
      // in production), during which a live-session cancel()/request-signal
      // abort can flip request.abortSignal.aborted. Committing here would bake a
      // cancelled turn into the warm session + history + memory, diverging from
      // what the caller (whose promise the LiveSessionManager already rejected)
      // believes happened. So retire the session and return a cancelled failure
      // WITHOUT saveSession/persistSuccessfulTurn. The summary from finish()
      // above is reused as-is (calling finish() a second time would double-write
      // artifacts); the only cosmetic cost is the recorded artifact says
      // 'succeeded' for a turn that returns cancelled.
      if (request.abortSignal.aborted) {
        await this.retireRunResultSession(request.conversationId, sessionRecord, runtimeResult.providerSessionId);
        return {
          metadata: baseMetadata,
          failure: {
            kind: "cancelled",
            message: "Agent request was cancelled during the turn.",
            details: runtimeResult,
          },
        };
      }

      if (isolated) {
        // An isolated proactive turn must not warm the shared conversation's
        // session, so it is never saved. Any provider session the runtime opened
        // for this one-shot turn is retired here so it does not leak (sessionRecord
        // is undefined, so this disposes the freshly returned providerSessionId).
        await this.retireRunResultSession(request.conversationId, sessionRecord, runtimeResult.providerSessionId);
      } else {
        this.saveSession(request.conversationId, runtimeResult.providerSessionId, sessionRecord);
      }

      // Persist the ORIGINAL caption + redacted attachment metadata (persistText),
      // NOT the expanded prompt with inlined document text.
      await this.persistSuccessfulTurn(
        request.conversationId,
        persistText,
        text,
        runSource.source === undefined ? {} : { source: runSource.source },
      );
      return {
        text,
        metadata: baseMetadata,
      };
    } catch (error) {
      const failure = failureFromThrownError(error, request.abortSignal.aborted);
      const summary = await safeRecorderFail(recorder, error);
      return {
        metadata: responseMetadata(runId, request, context, summary),
        failure,
      };
    } finally {
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
    this.liveSessionManager?.dispose();
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

  private saveSession(conversationId: string, providerSessionId: unknown, owner: RuntimeSessionRecord | undefined): void {
    if (!this.sessionsEnabled()) {
      return;
    }
    if (typeof providerSessionId !== "string" || providerSessionId.trim().length === 0) {
      return;
    }
    this.sessionStore?.save(conversationId, providerSessionId, owner);
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
   * Retires the provider session attached to a turn that will NOT be committed
   * (cancelled mid-turn or empty-text). Evicts a confirmed warm sessionRecord
   * via the store (its onEvict disposes the provider session), otherwise
   * disposes the freshly returned providerSessionId directly. Shared by all
   * three non-commit exits (post-runtime abort guard, the empty-text branch,
   * and the pre-commit abort recheck) so they stay consistent.
   */
  private async retireRunResultSession(
    conversationId: string,
    sessionRecord: RuntimeSessionRecord | undefined,
    providerSessionId: unknown,
  ): Promise<void> {
    if (sessionRecord !== undefined) {
      await this.sessionStore?.evict(conversationId, "stale", sessionRecord.providerSessionId);
    } else if (this.sessionsEnabled() && typeof providerSessionId === "string" && providerSessionId.trim().length > 0) {
      try {
        await this.options.runtime.disposeSession?.(providerSessionId);
      } catch {
        // Bridge TTL backstop reclaims it eventually.
      }
    }
  }

  private async prepareContext(
    request: AgentHarnessRequest,
    options: { readonly omitHistory: boolean },
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
    const history = options.omitHistory ? [] : await this.loadHistory(request.conversationId);
    // Recalled memory deliberately does NOT go into the system prompt. It rides on
    // the per-turn USER MESSAGE instead (see runRuntime): the user message is the
    // one field every runtime re-sends verbatim each turn, so memory survives
    // session resume even on runtimes that drop the system prompt on a resumed
    // turn (e.g. codex-app sends developerInstructions only on a fresh thread).
    // Keeping it out of the system prompt also leaves that prompt stable across a
    // session, which is better for provider prompt caching.
    const memory = await this.loadMemory(request.conversationId, request.userMessage, emit);
    const selectedSkills = await this.loadSkills();
    const context = await loadContextFromFiles({
      identityPath: this.options.identityPath,
      userMessage: request.userMessage,
      session: sessionContextBlock(request.conversationId, request.metadata),
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

  private async loadHistory(conversationId: string): Promise<readonly HistoryMessage[]> {
    return this.options.historyStore?.load(conversationId) ?? [];
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
  ): Promise<{ readonly request: AgentHarnessRequest; readonly persistUserMessage: string }> {
    const attachments = request.attachments;
    if (attachments === undefined || attachments.length === 0) {
      return { request, persistUserMessage: request.userMessage };
    }
    const dir = this.options.attachmentsDir;
    const promptLines: string[] = [];
    const persistLines: string[] = [];
    let dirEnsured = false;
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment === undefined) {
        continue;
      }
      let savedPath: string | undefined;
      if (dir !== undefined) {
        try {
          if (!dirEnsured) {
            await mkdir(dir, { recursive: true });
            dirEnsured = true;
          }
          savedPath = join(dir, attachmentFileName(runId, index, attachment));
          await writeFile(savedPath, Buffer.from(attachment.data, "base64"));
        } catch (error) {
          emit({
            type: "runtime_warning",
            warning_kind: "attachment_persist_failed",
            message: `Could not save attachment ${attachment.name ?? `#${index}`}: ${errorMessageText(error)}`,
          });
          savedPath = undefined;
        }
      }
      promptLines.push(describeAttachment(attachment, savedPath, { includeText: true }));
      persistLines.push(describeAttachment(attachment, savedPath, { includeText: false }));
    }
    if (promptLines.length === 0) {
      return { request, persistUserMessage: request.userMessage };
    }
    const header = dir !== undefined
      ? `[The user attached ${attachments.length} file(s) — saved to disk so you can open them with your tools:]`
      : `[The user attached ${attachments.length} file(s):]`;
    return {
      request: { ...request, userMessage: `${request.userMessage}\n\n${header}\n${promptLines.join("\n")}` },
      persistUserMessage: `${request.userMessage}\n\n${header}\n${persistLines.join("\n")}`,
    };
  }

  private async loadMemory(
    conversationId: string,
    query: string,
    emit?: (event: RuntimeEventLike) => void,
  ): Promise<ContextBlockInput | undefined> {
    let block;
    try {
      block = await this.options.memory?.load(conversationId, query);
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
    skillDisclosureNames: readonly string[],
    history: readonly HistoryMessage[],
    historyOmitted: boolean,
    onProviderStart?: () => void,
  ): Promise<RuntimeResult> {
    const hostOnEvent = request.onEvent;
    const policyOptions = toolPolicyToRuntimeOptions(this.options.toolPolicy ?? failClosedToolPolicy());
    const sandboxOptions = this.options.sandboxPolicy === undefined
      ? {}
      : sandboxPolicyToRuntimeOptions(this.options.sandboxPolicy);
    const requestExtension = await this.options.runtimeOptionsForRequest?.({ request, runId, context });
    const merged = mergeRuntimeOptions(
      policyOptions,
      sandboxOptions,
      this.options.runtimeOptions,
      requestExtension?.runtimeOptions,
    );
    // Per-request overrides (cron job / webhook per-trigger model + effort) win
    // over the harness defaults. These are applied AFTER the `...merged` spread so
    // the precedence is explicit. Non-override turns are byte-for-byte unchanged.
    const overrideModel = isRuntimeModelReference(merged.model) ? merged.model : undefined;
    const effectiveModel = overrideModel ?? this.options.model;
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
      // Durable provider-session root (pi-native): when set, sessions persist to
      // disk so resume recovers from there instead of re-sending full history.
      ...(this.options.piSessionsRoot === undefined ? {} : { piSessionsRoot: this.options.piSessionsRoot }),
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
    // Admission control: acquire a slot only around the actual provider run.
    // A blocked acquire holds nothing, so per-conversation queued follow-ups
    // never occupy a concurrency slot while they wait. The acquire is abortable
    // so a cancelled turn does not hang waiting for a slot to free up. The
    // acquire lives INSIDE the cleanup try/finally so a rejected admission
    // (aborted while queued) still runs requestExtension.cleanup(); release()
    // is guarded by `acquired` so it only fires when a slot was actually taken.
    let acquired = false;
    // Release-on-abort (R10): the permit's lifetime is otherwise coupled to
    // runtime.run() settlement, but a /cancel severs the caller without forcing
    // settlement. An abort-ignoring, never-resolving runtime.run would then
    // retain its maxConcurrentRuns slot forever, stalling all subsequent turns.
    // So once a slot is held, an abort frees it promptly and lets the orphaned
    // run finish detached — the same "settle the resource on cancel, let the
    // zombie finish" tradeoff the live-session queue already makes. `released`
    // makes release idempotent so the finally never double-releases (and so the
    // resume-retry's second runRuntime at run() scope is unaffected).
    let released = false;
    const releaseSlot = (): void => {
      if (acquired && !released) {
        released = true;
        this.runLimiter?.release();
      }
    };
    const onAbortReleaseSlot = (): void => releaseSlot();
    try {
      if (this.runLimiter !== undefined) {
        await this.runLimiter.acquire(request.abortSignal);
        acquired = true;
        request.abortSignal.addEventListener("abort", onAbortReleaseSlot, { once: true });
      }
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
      // Durable cross-restart resume: a restart wipes the in-memory history store,
      // so prepareContext loads 0 messages, but the harness still resumes the
      // on-disk provider session (resumeSessionId set) which carries the full prior
      // transcript. Reporting historyOmitted:false there would read as "history
      // loaded and empty" (an empty conversation), which is wrong — the model saw
      // the transcript via the provider session. So treat a resume with no locally
      // loaded history as omitted too.
      const contextCarriedByProviderSession = resumeSessionId !== undefined && history.length === 0;
      const turnContextEvent = buildTurnContextEvent(history, historyOmitted || contextCarriedByProviderSession, memory);
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
      request.abortSignal.removeEventListener("abort", onAbortReleaseSlot);
      releaseSlot();
      await requestExtension?.cleanup?.();
    }
  }

  /**
   * Persists the turn to history + memory. `userMessage` here is the
   * PERSIST text (original caption + redacted attachment metadata), NOT the
   * provider-facing expanded prompt — see applyAttachments. Keeping the
   * expanded prompt (absolute paths + up to 8KB extracted document body) out of
   * durable history/memory prevents sensitive content leaking into future
   * prompts replayed from history or into memory recall.
   */
  private async persistSuccessfulTurn(
    conversationId: string,
    userMessage: string,
    assistantText: string,
    options: { readonly source?: string } = {},
  ): Promise<void> {
    const timestamp = this.options.now?.().toISOString() ?? new Date().toISOString();
    await this.options.historyStore?.append(conversationId, [
      { role: "user", content: userMessage, timestamp },
      { role: "assistant", content: assistantText, timestamp },
    ]);

    const mode = this.options.memoryWriteMode;
    if (this.options.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      if (shouldSkipMemoryPersistence(userMessage, assistantText, options)) {
        return;
      }
      // Always write the deterministic rapid-log line (sync, durable).
      await this.options.memory.appendHostSummary(
        conversationId,
        deterministicHostSummary(userMessage, assistantText, options),
      );
      // 'capture' additionally enqueues a best-effort intelligent capture (async, non-blocking).
      if (mode === "capture") {
        this.options.memory.scheduleCapture?.(conversationId, captureTurnText(userMessage, assistantText, options));
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

function shouldRetireSessionAfterFailure(kind: string): boolean {
  return kind !== "cancelled";
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

async function safeRecorderFail(recorder: RunRecorder, error: unknown): Promise<RunSummary | undefined> {
  try {
    return await recorder.fail(error);
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
 * A small "Session" context block telling the agent the conversationId of the turn
 * it is currently handling. When that id is a deliverable push destination
 * (`telegram:`/`slack:`), a live agent that kicks off a long-running external
 * operation can embed this id in the callback it asks the service to make, so the
 * eventual result can be delivered back to THIS conversation (the inbound webhook
 * turn reads the id from the payload and routes a follow-up here). For non-push
 * conversations (cron/webhook/openai-api/a2a) the block instead clarifies that this
 * conversation cannot itself receive a proactive follow-up. The daily-rollover
 * bucket suffix is stripped so the id is the stable, deliverable one.
 */
function sessionContextBlock(conversationId: string, metadata?: Record<string, unknown>): string {
  const baseId = conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "");
  const deliverable = baseId.startsWith("telegram:") || baseId.startsWith("slack:");
  if (deliverable) {
    return [
      `You are currently handling the conversation \`${baseId}\`.`,
      `If you start a long-running external operation and want its result delivered back to THIS conversation later, have the service include \`"conversationId": "${baseId}"\` in the JSON body of its callback to your inbound webhook — the follow-up will be routed here.`,
    ].join("\n\n");
  }
  const base = `You are currently handling the conversation \`${baseId}\`. This is a request-driven run (scheduled, webhook, or API) with no interactive user attached to this conversation.`;
  const notifyGuidance = notifyDeliveryGuidance(metadata);
  return notifyGuidance === undefined ? base : `${base}\n\n${notifyGuidance}`;
}

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
 * `historyOmitted` is true when the provider session carries the transcript (a
 * warm in-process session, or a durable cross-restart resume with no locally
 * loaded history) so no history was replayed here. Known accepted edge: the very
 * first turn of a brand-new conversation with a derived durable id
 * (create-on-miss) also reports `historyOmitted:true` with 0 history — acceptable,
 * as the provider session is the transcript's home from that turn on. The
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

/**
 * Derives a STABLE, fs-safe, collision-resistant provider-session id from a
 * conversationId. Used (only when durable pi sessions are configured) as the
 * resume id so a conversation reopens its on-disk JSONL transcript across a
 * process restart — the in-memory conversationId→providerSessionId map is lost
 * on restart, so without a deterministic id the harness would orphan the JSONL
 * and start a fresh session. The output is sha256 hex (lowercase a-f0-9 only),
 * which is always a safe filename component for pi's JsonlSessionRepo
 * (`${timestamp}_${id}.jsonl`); 32 hex chars = 128 bits, far below any realistic
 * collision risk.
 */
function deriveDurableSessionId(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 32);
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
