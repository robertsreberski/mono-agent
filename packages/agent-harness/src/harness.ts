import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentAttachment } from "@mono-agent/agent-contracts";
import { loadContextFromFiles } from "@mono-agent/context";
import type { BuiltAgentContext, ContextBlockInput, HistoryMessage } from "@mono-agent/context";
import type { RunRecorder, RunSummary, RuntimeEventLike } from "@mono-agent/observability";
import { monoRuntimeSupportsSessionResume } from "@mono-agent/runtime-adapter";
import type { RuntimeExecutionMode, RuntimeResult, RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { createSkillsCache } from "@mono-agent/skills";
import type { SkillsCache } from "@mono-agent/skills";
import { mergeSandboxPolicies, sandboxPolicyToRuntimeOptions } from "@mono-agent/sandbox";
import type { SandboxPolicy } from "@mono-agent/sandbox";
import { failClosedToolPolicy, toolPolicyToRuntimeOptions } from "@mono-agent/tool-policy";

import { NoopRunRecorder } from "./recorder.js";
import { createLiveSessionManager } from "./live-session.js";
import type { LiveSessionManager } from "./live-session.js";
import { createSemaphore } from "./semaphore.js";
import type { Semaphore } from "./semaphore.js";
import { createRuntimeSessionStore } from "./sessions.js";
import type { RuntimeSessionRecord, RuntimeSessionStore } from "./sessions.js";
import type {
  AgentHarness,
  AgentHarnessFailure,
  AgentHarnessOptions,
  AgentHarnessRequest,
  AgentHarnessResponse,
  AgentHarnessRuntimeOptionsExtension,
} from "./types.js";

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
        onEvict: async (record) => {
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

  async run(request: AgentHarnessRequest): Promise<AgentHarnessResponse> {
    validateRequest(request);
    const runId = this.options.createRunId?.() ?? createDefaultRunId();
    const recorder = this.options.recorderFactory?.({ runId, conversationId: request.conversationId, userInput: request.userMessage }) ?? new NoopRunRecorder({ runId, conversationId: request.conversationId });
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
    const sessionRecord = this.sessionsEnabled() ? this.sessionStore?.acquire(request.conversationId) : undefined;
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
      let resumeSessionId = sessionRecord?.providerSessionId
        ?? (this.sessionsEnabled() && this.options.piSessionsRoot !== undefined
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
        runtimeResult = await this.runRuntime(activeRequest, recorder, context, runId, resumeSessionId, leavePending);
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
        recorder.onEvent(warning);
        request.onEvent?.(warning);
        await this.sessionStore?.evict(request.conversationId, "stale", resumeSessionId);
        resumeSessionId = undefined;
        prepared = await this.prepareContext(activeRequest, { omitHistory: false }, emit);
        context = prepared.context;
        runtimeResult = await this.runRuntime(activeRequest, recorder, context, runId, undefined, leavePending);
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
        const summary = await recorder.finish({ ...runtimeResult, cancelled: true, failureKind: "cancelled" });
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
      const summary = await recorder.finish(failure === undefined ? runtimeResult : { ...runtimeResult, failureKind: failure.kind, error: failure.message });
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

      this.saveSession(request.conversationId, runtimeResult.providerSessionId, sessionRecord);

      // Persist the ORIGINAL caption + redacted attachment metadata (persistText),
      // NOT the expanded prompt with inlined document text.
      await this.persistSuccessfulTurn(request.conversationId, persistText, text);
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
        this.sessionStore?.release(request.conversationId, sessionRecord);
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
  ): Promise<{ readonly context: BuiltAgentContext }> {
    const history = options.omitHistory ? [] : await this.loadHistory(request.conversationId);
    const memory = await this.loadMemory(request.conversationId, emit);
    const selectedSkills = await this.loadSkills();
    const context = await loadContextFromFiles({
      identityPath: this.options.identityPath,
      userMessage: request.userMessage,
      ...(this.options.soulPath === undefined ? {} : { soulPath: this.options.soulPath }),
      ...(memory === undefined ? {} : { memory }),
      ...(history.length === 0 ? {} : { history }),
      ...(selectedSkills.index.length > 0 ? { skills: selectedSkills.index } : this.options.skillsRoot === undefined ? {} : { skillsRoot: this.options.skillsRoot }),
      ...(selectedSkills.instructions.length === 0 ? {} : { skillInstructions: selectedSkills.instructions }),
    });
    return { context };
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
    emit?: (event: RuntimeEventLike) => void,
  ): Promise<ContextBlockInput | undefined> {
    let block;
    try {
      block = await this.options.memory?.load(conversationId);
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
    return {
      kind: "markdown",
      content: block.content,
      source: block.source,
    };
  }

  private async loadSkills(): Promise<{ readonly index: readonly import("@mono-agent/context").SkillIndexEntry[]; readonly instructions: readonly ContextBlockInput[] }> {
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
    runId: string,
    resumeSessionId: string | undefined,
    onProviderStart?: () => void,
  ): Promise<RuntimeResult> {
    const hostOnEvent = request.onEvent;
    const policyOptions = toolPolicyToRuntimeOptions(this.options.toolPolicy ?? failClosedToolPolicy());
    const sandboxOptions = this.options.sandboxPolicy === undefined
      ? {}
      : sandboxPolicyToRuntimeOptions(this.options.sandboxPolicy);
    const requestExtension = await this.options.runtimeOptionsForRequest?.({ request, runId, context });
    const runtimeOptions: RuntimeRunOptions = {
      ...mergeRuntimeOptions(
        policyOptions,
        sandboxOptions,
        this.options.runtimeOptions,
        requestExtension?.runtimeOptions,
      ),
      model: this.options.model,
      messages: [{ role: "user", content: request.userMessage }],
      abortSignal: request.abortSignal,
      ...(this.options.executionMode === undefined ? {} : { executionMode: this.options.executionMode }),
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
      // Durable provider-session root (pi-native): when set, sessions persist to
      // disk so resume recovers from there instead of re-sending full history.
      ...(this.options.piSessionsRoot === undefined ? {} : { piSessionsRoot: this.options.piSessionsRoot }),
      // Session keys live after the merge so request extensions cannot
      // clobber the harness's session decision — including forcing the keys
      // back to undefined on fresh runs.
      ...(this.sessionsEnabled()
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
      // Bracket the provider call so observability can separate provider+tool+IO
      // time (this event's durationMs) from harness overhead (context build,
      // attachment persistence, compaction, admission wait).
      const bridgeStartMs = Date.now();
      try {
        return await this.options.runtime.run(context.prompt, runtimeOptions);
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
  private async persistSuccessfulTurn(conversationId: string, userMessage: string, assistantText: string): Promise<void> {
    const timestamp = this.options.now?.().toISOString() ?? new Date().toISOString();
    await this.options.historyStore?.append(conversationId, [
      { role: "user", content: userMessage, timestamp },
      { role: "assistant", content: assistantText, timestamp },
    ]);

    const mode = this.options.memoryWriteMode;
    if (this.options.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      // Always write the deterministic rapid-log line (sync, durable).
      await this.options.memory.appendHostSummary(
        conversationId,
        deterministicHostSummary(userMessage, assistantText),
      );
      // 'capture' additionally enqueues a best-effort intelligent capture (async, non-blocking).
      if (mode === "capture") {
        this.options.memory.scheduleCapture?.(conversationId, captureTurnText(userMessage, assistantText));
      }
    }
  }
}

export function createAgentHarness(options: AgentHarnessOptions): AgentHarness {
  return new MonoAgentHarness(options);
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
  return {
    runId,
    conversationId: request.conversationId,
    contextSources: context?.metadata.sources ?? [],
    contextSectionIds: context?.sections.map((section) => section.id) ?? [],
    ...(runtimeResult === undefined ? {} : { runtime: runtimeMetadata(runtimeResult) }),
    ...(summary === undefined ? {} : { summary }),
  };
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
    metadata: {
      runId: input.runId,
      conversationId: input.request.conversationId,
      contextSources: [],
      contextSectionIds: [],
      summary: input.summary,
    },
    failure: {
      kind: input.kind,
      message: input.message,
    },
  };
}

function deterministicHostSummary(userMessage: string, assistantText: string): string {
  return [
    "Host-observed completed turn.",
    `User: ${compactOneLine(userMessage, 240)}`,
    `Assistant: ${compactOneLine(assistantText, 240)}`,
  ].join("\n");
}

function captureTurnText(userMessage: string, assistantText: string): string {
  // Richer than the compacted host summary: the distiller wants the real turn content.
  return `User: ${userMessage}\nAssistant: ${assistantText}`;
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
