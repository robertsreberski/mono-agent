import type { prepareHarnessContext } from "./context-preparation.js";
import { randomUUID } from "node:crypto";
import { createPendingInitialInput, createPendingLiveInput, assertDetachedTurnDescriptor } from "../durable-turn-contract.js";
import { sessionModelKey } from "../session-runtime.js";
import type { RunRecorder, RuntimeEventLike } from "@mono-agent/observability";
import {
  monoRuntimeSupportsLiveInput,
  sandboxPolicyToRuntimeOptions,
  type RuntimeMessage,
  type RuntimeResult,
  type RuntimeRunOptions,
  type RuntimeNativePreparedDispatch, type RuntimeNativeDispatchSnapshot, type RuntimeNativeDispatchBinding,
  type RuntimeHandoffProducerRequest, type RuntimeHandoffProducerResult, type RuntimeHandoffFit,
} from "@mono-agent/runtime-adapter";

import type { BuiltAgentContext, ContextBlockInput, HistoryMessage, SkillIndexSummary } from "../context/index.js";
import { composeHostTurnEnvelope, formatHostCapabilities, neutralizeTurnEnvelope } from "../context/turn-envelope.js";
import type { Semaphore } from "../semaphore.js";
import type {
  AgentHarnessContinuationClaimCapability,
  AgentHarnessOptions,
  AgentHarnessProgressCapability,
  AgentHarnessRequest,
  AgentHarnessRuntimeOptionsExtension,
  ConversationHistoryTurnReconciliation,
} from "../types.js";
import type { SessionRuntimeResolver } from "../session-runtime.js";
import type { LiveInputMailbox } from "../live-input.js";
import { failClosedToolPolicy, toolPolicyToRuntimeOptions } from "../tool-policy/index.js";
import type { AttachmentRequestContext } from "./attachments.js";
import type { UncommittedTurnCollector } from "./turn-continuity.js";
import { AgentHarnessError } from "./error.js";
import { injectMcpContinuationContext, injectMcpRequestContext } from "./mcp-context.js";
import {
  isRuntimeModelReference,
  mergeRuntimeOptions,
  withoutToolPolicyOptions,
} from "./runtime-options.js";
import {
  composeUserMessageWithSpeakerContext,
  neutralizeSpeakerMarkup,
  speakerTurnContextFields,
} from "./speaker-context.js";
import { buildTurnContextEvent, composeUserMessageWithMemory } from "./turn-context.js";

interface HarnessRuntimeRouting {
  readonly modelKey: string;
  readonly runtimeForSession: SessionRuntimeResolver;
  readonly recoveryRevision?: number | undefined;
  readonly turnRevision?: number | undefined;
  readonly reconciliation?: ConversationHistoryTurnReconciliation | undefined;
  readonly onRuntimeSelected: (modelKey: string) => void;
}

type PreparedContext = Awaited<ReturnType<typeof prepareHarnessContext>>;
export interface HarnessPreparedBinding extends RuntimeNativeDispatchBinding {
  readonly reconciliation: ConversationHistoryTurnReconciliation;
  readonly turnRevision: number;
  readonly recoveryRevision?: number;
  readonly assertOwned: () => Promise<void>;
}
export interface PreparedHarnessRuntime {
  readonly snapshot: RuntimeNativeDispatchSnapshot;
  readonly context: PreparedContext;
  assertReady(): void;
  checkHandoffSummary(input: RuntimeHandoffProducerRequest): RuntimeHandoffFit;
  produceHandoffSummary(input: RuntimeHandoffProducerRequest): Promise<RuntimeHandoffProducerResult>;
  run(binding: HarnessPreparedBinding | (() => Promise<HarnessPreparedBinding>)): Promise<RuntimeResult>;
  close(): Promise<void>;
}
export interface HarnessRuntimePreparationInput {
  readonly options: AgentHarnessOptions; readonly runLimiter?: Semaphore; readonly sessionsEnabled: boolean;
  readonly request: AgentHarnessRequest; readonly recorder: RunRecorder; readonly runId: string;
  readonly durablePiSessionsRoot: string; readonly routing: HarnessRuntimeRouting;
  readonly attachmentContext: AttachmentRequestContext;
  readonly continuationCapabilities: AgentHarnessContinuationClaimCapability[];
  readonly turnContinuityCollector: UncommittedTurnCollector;
  readonly liveInputMailbox?: LiveInputMailbox; readonly onProviderStart?: () => void;
  readonly assertOwned: () => Promise<void>;
  /** Called once under the permit and outgoing conversation claim. No P2 admission. */
  readonly prepareContext: (request: AgentHarnessRequest, options: AgentHarnessOptions) => Promise<PreparedContext>;
}
interface PreparationControl {
  assertOwned(): Promise<void>;
  prepareContext(request: AgentHarnessRequest, options: AgentHarnessOptions): Promise<PreparedContext>;
  abort(reason: unknown): void;
  ready(lease: RuntimeNativePreparedDispatch, context: PreparedContext): Promise<HarnessPreparedBinding>;
}
/** Copy request/config data, retaining privileged functions/controllers by identity. */
function copyPreparationData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyPreparationData) as T;
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyPreparationData(item)])) as T;
  }
  return value;
}
function freezePreparationData<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezePreparationData); Object.freeze(value); }
  return value;
}
/** Opt-in substrate only. No caller/config activation. Hold the permit until all
 * native and extension resources settle, including close/abort during production.
 * The original claim is used during preparation; run receives the transferred P2 owner. */
export function prepareHarnessRuntime(input: HarnessRuntimePreparationInput): Promise<PreparedHarnessRuntime> {
  // Metadata identity carries out-of-band capability bindings; do not clone it.
  const request = { ...copyPreparationData(input.request), ...(input.request.metadata ? { metadata: input.request.metadata } : {}) }, options: AgentHarnessOptions = { ...input.options,
    model: { ...input.options.model },
    ...(input.options.runtimeOptions ? { runtimeOptions: copyPreparationData(input.options.runtimeOptions) } : {}),
    ...(input.options.toolPolicy ? { toolPolicy: copyPreparationData(input.options.toolPolicy) } : {}),
    ...(input.options.sandboxPolicy ? { sandboxPolicy: copyPreparationData(input.options.sandboxPolicy) } : {}),
    ...(input.options.session ? { session: copyPreparationData(input.options.session) } : {}),
    ...(input.options.selectedSkills ? { selectedSkills: [...input.options.selectedSkills] } : {}) };
  let resolvePrepared!: (value: PreparedHarnessRuntime) => void, rejectPrepared!: (error: unknown) => void;
  const prepared = new Promise<PreparedHarnessRuntime>((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, expired = false, admitting = false, deferredAbort: unknown;
  let resume!: (binding: HarnessPreparedBinding) => void, stop!: (reason: unknown) => void, state = "preparing", producing = false;
  const binding = new Promise<HarnessPreparedBinding>((resolve, reject) => { resume = resolve; stop = reject; });
  void binding.catch(() => {});
  const abort = (reason: unknown) => { if (state === "preparing" || state === "prepared") { state = "closed"; clearTimeout(expiryTimer); if (admitting) deferredAbort = reason; else stop(reason); } };
  const outcome = executeHarnessRuntime({ assertOwned: input.assertOwned, prepareContext: input.prepareContext, abort,
    ready: async (lease, context) => {
      if (state === "closed") throw new Error("Host preparation closed before readiness");
      if (!lease.assertReady || !lease.checkHandoffSummary || !lease.produceHandoffSummary) throw new Error("Pinned handoff producer capability unavailable");
      if (!Number.isSafeInteger(lease.snapshot.expiresAt)) throw new Error("Native prepared lease expiry unavailable");
      const expiresAt = Math.min(lease.snapshot.expiresAt, Date.now() + 5 * 60_000);
      const assertStart = (allowance: number): void => {
        if (Date.now() >= expiresAt || expiresAt - Date.now() < allowance) throw new Error("Host preparation expired or has insufficient start allowance");
        lease.assertReady!(allowance);
      };
      state = "prepared";
      expiryTimer = setTimeout(() => { expired = true; if (state === "prepared" && !producing && !admitting) abort(new Error("Host preparation expired")); },
        Math.max(0, expiresAt - Date.now()));
      expiryTimer.unref();
      const start = (value: HarnessPreparedBinding, allowance: number): Promise<RuntimeResult> => {
        if (state !== "prepared" || producing || admitting) return Promise.reject(new Error("Host preparation is no longer available"));
        if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some((key) => !["reconciliation", "turnRevision", "recoveryRevision", "assertOwned", "sessionId", "providerSessionId", "providerAttributionSessionId", "sessionKeepAlive", "sessionIdleTimeoutMs", "sessionTurn", "sessionRecovery", "nativeSessionAuthority", "nativeSessionProjection", "nativeProvenanceRecording"].includes(key as string))
          || typeof value.assertOwned !== "function" || value.reconciliation?.descriptor.reconciliation?.purpose !== "execution"
          || value.turnRevision !== value.reconciliation.descriptor.baseRevision) return Promise.reject(new TypeError("Host preparation accepts only owned P2/session binding"));
        let captured; try { assertStart(allowance); captured = copyPreparationData(value); } catch (error) { return Promise.reject(error); }
        state = "running"; clearTimeout(expiryTimer); resume(captured); return outcome;
      };
      resolvePrepared({ snapshot: lease.snapshot, context,
        assertReady: () => { if (state !== "prepared" || producing || admitting) throw new Error("Host preparation is no longer available"); assertStart(30_000); },
        checkHandoffSummary: (request) => { if (state !== "prepared") throw new Error("Host preparation is no longer available"); return lease.checkHandoffSummary!(request); },
        produceHandoffSummary: async (request) => { if (state !== "prepared" || producing || admitting) throw new Error("Host producer is no longer available");
          const captured = structuredClone(request); producing = true;
          try { await input.assertOwned(); if (state !== "prepared") throw new Error("Host preparation closed before production");
            const result = await lease.produceHandoffSummary!(captured); await input.assertOwned(); return result; }
          finally { producing = false; if (expired && state === "prepared") abort(new Error("Host preparation expired")); } },
        run: (value) => {
          if (typeof value !== "function") return start(value, 30_000);
          // Preferred before-P2 entry: reject before invoking host admission.
          if (state !== "prepared" || producing || admitting) return Promise.reject(new Error("Host preparation is no longer available"));
          try { assertStart(30_000); } catch (error) { return Promise.reject(error); }
          admitting = true;
          return Promise.resolve().then(() => input.assertOwned()).then(value).then((bound) => {
            admitting = false; return start(bound, 5_000);
          }).finally(() => { admitting = false;
            if (deferredAbort !== undefined) stop(deferredAbort);
            else if (expired && state === "prepared") abort(new Error("Host preparation expired"));
          });
        },
        close: async () => { abort(new Error("Host preparation closed")); await outcome.catch(() => {}); },
      });
      return await binding;
    } }, options, input.runLimiter, input.sessionsEnabled, request, input.recorder,
    undefined as unknown as BuiltAgentContext, undefined, input.runId, undefined, undefined, input.durablePiSessionsRoot,
    false, { ...input.routing }, [], [], false, false, undefined, copyPreparationData(input.attachmentContext), input.continuationCapabilities,
    input.turnContinuityCollector, input.liveInputMailbox, input.onProviderStart);
  void outcome.then(() => { if (state === "preparing" || state === "closed") rejectPrepared(new Error("Host preparation did not complete")); }, rejectPrepared)
    .finally(() => { state = "closed"; clearTimeout(expiryTimer); });
  return prepared;
}
type ExecutionArguments = Parameters<typeof executeHarnessRuntime> extends [unknown, ...infer Rest] ? Rest : never;
/** Existing paths never enter preparation and retain their original ordering. */
export function runHarnessRuntime(...args: ExecutionArguments): Promise<RuntimeResult> { return executeHarnessRuntime(undefined, ...args); }

async function executeHarnessRuntime(preparation: PreparationControl | undefined,

  options: AgentHarnessOptions,
  runLimiter: Semaphore | undefined,
  sessionsEnabled: boolean,
  request: AgentHarnessRequest,
  recorder: RunRecorder,
  context: BuiltAgentContext,
  memory: ContextBlockInput | undefined,
  runId: string,
  resumeSessionId: string | undefined,
  providerAttributionSessionId: string | undefined,
  durablePiSessionsRoot: string | undefined,
  sessionIsolated: boolean,
  routing: HarnessRuntimeRouting,
  skillDisclosureEntries: readonly SkillIndexSummary[],
  history: readonly HistoryMessage[],
  historyOmitted: boolean,
  historyAsMessages: boolean,
  toolHistoryProjection: string | undefined,
  attachmentContext: AttachmentRequestContext,
  continuationCapabilities: AgentHarnessContinuationClaimCapability[],
  turnContinuityCollector: UncommittedTurnCollector,
  liveInputMailbox?: LiveInputMailbox,
  onProviderStart?: () => void,
): Promise<RuntimeResult> {
  const hostOnEvent = request.onEvent;
  const emitRuntimeEvent = (event: RuntimeEventLike): void => {
    if (!turnContinuityCollector.observeRuntimeEvent(event)) return;
    recorder.onEvent(event);
    hostOnEvent?.(event);
  };
    let requestExtension: AgentHarnessRuntimeOptionsExtension | undefined;
    let nativeLease: RuntimeNativePreparedDispatch | undefined;
    let preparedContext: PreparedContext | undefined;
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
        runLimiter?.release();
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
      if (preparation) { preparation.abort(request.abortSignal.reason ?? new Error("Host preparation aborted")); return; }
      void cleanupRequestExtension().catch(() => undefined).finally(releaseSlot);
    };
    try {
      if (runLimiter !== undefined) {
        await runLimiter.acquire(request.abortSignal);
        acquired = true;
      }
      if (preparation) {
        await preparation.assertOwned();
        preparedContext = freezePreparationData(structuredClone(await preparation.prepareContext(request, options)));
        ({ context, memory, skillDisclosureEntries, history, historyOmitted, historyAsMessages, toolHistoryProjection } = preparedContext);
        await preparation.assertOwned();
      }
      requestExtension = await options.runtimeOptionsForRequest?.({ request, runId, context });
      if (preparation && requestExtension) requestExtension = { ...requestExtension };
      const policyOptions = toolPolicyToRuntimeOptions(
        requestExtension?.toolPolicyOverride
        ?? options.toolPolicy
        ?? failClosedToolPolicy(),
      );
      const sandboxOptions = options.sandboxPolicy === undefined
        ? {}
        : sandboxPolicyToRuntimeOptions(options.sandboxPolicy);
      const staticRuntimeOptions = requestExtension?.toolPolicyOverride === undefined
        ? options.runtimeOptions
        : withoutToolPolicyOptions(options.runtimeOptions);
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
      delete merged.nativeSessionAuthority;
      delete merged.nativeSessionProjection;
      delete merged.nativeProvenanceRecording;
      delete merged.sessionTurn;
      delete merged.onSessionTurnDetached;
      // Lifecycle persistence is host-owned and cannot be injected or replaced
      // by static/request extensions.
      delete merged.toolLifecycleSink;
      // Provider transport is a host reliability policy. A trigger/request
      // extension may supply it only when the host left it unset; it cannot
      // switch an explicitly configured host away from its selected transport.
      if (options.runtimeOptions?.piTransport !== undefined) {
        merged.piTransport = options.runtimeOptions.piTransport;
      }
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
        options: options.mcpRequestContext,
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
        options: options.continuationContext,
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
      const effectiveModel = overrideModel ?? options.model;
      if (
        !sessionIsolated
        && sessionsEnabled
        && sessionModelKey(effectiveModel) !== routing.modelKey
      ) {
        // A session-capable non-isolated call must execute the canonical primary
        // selected before history assembly; reject late extension mismatches.
        throw new AgentHarnessError(
          "undeclared_model_override",
          "A model-changing runtimeOptionsForRequest result must be declared in request metadata before context assembly.",
        );
      }
      const overrideEffort = typeof merged.effort === "string" ? merged.effort : undefined;
      const effortOverridden = overrideEffort !== undefined || merged.effort === null;
      const effectiveEffort = merged.effort === null ? undefined : overrideEffort ?? options.effort;
      // `null` is the request-extension sentinel for provider default. The
      // runtime contract itself does not accept that sentinel, so remove the
      // merged value and materialize only the resolved string below.
      delete merged.effort;
      const useManagedLiveInput = liveInputMailbox !== undefined && merged.liveInput === undefined;
      let supportsLiveInput = false;
      if (liveInputMailbox !== undefined) {
        if (useManagedLiveInput) {
          try {
            supportsLiveInput = monoRuntimeSupportsLiveInput();
          } catch {
            supportsLiveInput = false;
          }
        }
        if (!useManagedLiveInput || !supportsLiveInput) liveInputMailbox.markUnsupported();
      }
      const effectiveModelKey = sessionModelKey(effectiveModel);
      const runtime = routing.runtimeForSession(effectiveModelKey);
      routing.onRuntimeSelected(effectiveModelKey);
      // Speaker/group context wraps the user's words FIRST (it is chronologically
      // prior and identity-scoping); recalled memory still appends last. Composing
      // HERE rather than mutating request.userMessage is load-bearing: that field
      // is the memory recall query (see loadHarnessMemory in prepareContext), so
      // folding this into applyHarnessAttachments would silently make BuJo retrieve
      // against third-party chatter instead of the user's actual ask. It also keeps
      // the transcript out of persistUserMessage, so it can never reach history or
      // long-term memory. A continuation turn has a host-synthesized prompt and no
      // live speaker, so it is skipped -- the same guard memory uses.
      const capabilityContext = formatHostCapabilities(merged as Partial<RuntimeRunOptions>);
      const currentTurnContext = `${context.turnContext}\n\n${capabilityContext}`;
      const speakerMessage = request.continuation === undefined
        ? composeUserMessageWithSpeakerContext(
            request.userMessage,
            request.sender,
            request.precedingMessages,
          )
        : request.userMessage;
      // Standing host context (a project's shared instructions) decorates the
      // prompt copy only; persistUserMessage already stored the canonical text.
      // Continuation synthesis gets it too: the destination's instructions still
      // apply to the host-synthesized prompt, which is never persisted either.
      const decorate = requestExtension?.decorateUserMessage;
      const currentUserMessage: RuntimeMessage = {
        role: "user",
        content: composeHostTurnEnvelope(currentTurnContext, composeUserMessageWithMemory(
          decorate === undefined ? speakerMessage : decorate(speakerMessage),
          memory,
        )),
      };
      let reconciliation = routing.reconciliation;
      if (!preparation && reconciliation !== undefined && routing.turnRevision !== undefined && durablePiSessionsRoot !== undefined) {
        const id = reconciliation.descriptor.reconciliation!.initialInputId!;
        // Replace the provisional pre-context digest before any native dispatch.
        await reconciliation.admit(createPendingInitialInput({ id, persistText: request.userMessage, timestamp: new Date().toISOString() }, currentUserMessage.content));
      }
      let runtimeOptions: RuntimeRunOptions = {
        ...merged,
        ...(routing.turnRevision !== undefined && sessionsEnabled && !sessionIsolated
          && durablePiSessionsRoot !== undefined && (resumeSessionId ?? providerAttributionSessionId) !== undefined
          ? { sessionTurn: reconciliation?.descriptor ?? { kind: "host" as const, ownerKey: options.toolHistory?.logicalConversationId(request.conversationId) ?? request.conversationId,
              historyBucket: request.conversationId, turnId: runId,
              handleId: (resumeSessionId ?? providerAttributionSessionId)!, baseRevision: routing.turnRevision } } : {}),
        sessionRecovery: routing.recoveryRevision !== undefined && typeof runtime.recoverSession === "function"
          && sessionsEnabled && !sessionIsolated && durablePiSessionsRoot !== undefined
          ? { runId, revision: routing.recoveryRevision } : undefined,
        model: effectiveModel,
        // Recalled memory is appended to the user message (NOT the system prompt) so
        // it reaches the model on every turn, including resumed turns. See
        // prepareContext for why.
        messages: [
          ...(historyAsMessages ? coldReplayMessages(history, toolHistoryProjection) : []),
          currentUserMessage,
        ],
        abortSignal: request.abortSignal,
        ...(request.toolEnvironment === undefined ? {} : { toolEnvironment: request.toolEnvironment }),
        ...(useManagedLiveInput && supportsLiveInput && liveInputMailbox !== undefined
          ? { liveInput: liveInputMailbox }
          : {}),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        observers: [...(Array.isArray(merged.observers) ? merged.observers : []), {
          recordEvent: (event: RuntimeEventLike) => turnContinuityCollector.observeNativeEvent(event),
          recordToolLifecycle: (event: import("@mono-agent/runtime-adapter").RuntimeToolLifecycleEvent) => turnContinuityCollector.admitToolLifecycle(event),
        }],
        toolLifecycleSink: turnContinuityCollector.wrapToolLifecycleSink(
          options.toolHistory?.writer.createSink({
              conversationId: request.conversationId,
              logicalConversationId: options.toolHistory?.logicalConversationId(request.conversationId)
                ?? request.conversationId,
              runId,
              isolated: sessionIsolated,
          }),
        ),
        // Durable provider-session root is forwarded only for a host-history
        // coordinated turn. Custom stores and isolated runs cannot safely make
        // provider JSONL authoritative across a crash, so they stay in-memory.
        ...(durablePiSessionsRoot === undefined
          ? {}
          : { piSessionsRoot: durablePiSessionsRoot }),
        // Progressive skill disclosure (index mode): pass the discovered skills
        // and the skills root so pi-native's getPiBuiltinTools creates the on-demand
        // `ReadSkill` tool. These live after the merge so request extensions cannot
        // clobber them. Empty in 'full' mode / when no skillsRoot is set, so the
        // tool is not created and behavior matches the legacy path.
        //
        // Each entry carries its description as well as its name: this is also
        // what a subagent inherits (agent-app forwards it down the Agent tool
        // seam), and a child renders its own index from these entries.
        ...(skillDisclosureEntries.length > 0 && options.skillsRoot !== undefined
          ? {
            skills: skillDisclosureEntries.map(({ name, description }) => ({ name, description })),
            skillsRoot: options.skillsRoot,
          }
          : {}),
        // Session keys live after the merge so request extensions cannot
        // clobber the harness's session decision — including forcing the keys
        // back to undefined on fresh runs.
        //
        // The model-bound owner receives the same host-owned session keys for
        // default and override turns; isolated turns remain one-shot.
        ...(sessionsEnabled && !sessionIsolated
          ? {
            ...(providerAttributionSessionId === undefined ? {} : { providerAttributionSessionId }),
            sessionKeepAlive: true,
            sessionIdleTimeoutMs: options.session?.idleTimeoutMs,
            sessionId: resumeSessionId,
            providerSessionId: resumeSessionId,
          }
          : {}),
        onEvent: (event: RuntimeEventLike) => {
          emitRuntimeEvent(event);
        },
      };
      if (reconciliation !== undefined || preparation) {
        const nativeOptions = runtimeOptions, live = nativeOptions.liveInput;
        runtimeOptions = { ...nativeOptions,
          onSessionTurnDetached: async (attempt) => {
            assertDetachedTurnDescriptor(attempt.descriptor, reconciliation!.descriptor);
            await reconciliation!.claim("detached");
          },
          ...(live === undefined ? {} : { liveInput: { async *[Symbol.asyncIterator]() {
            for await (const message of live) {
              const input = useManagedLiveInput && liveInputMailbox ? liveInputMailbox.durableAdmission(message, nativeOptions.prompts)
                : createPendingLiveInput({ id: message.id ?? `wake:${randomUUID()}`, persistText: "", receivedAt: message.receivedAt ?? new Date().toISOString() }, message.body, "wake", nativeOptions.prompts);
              try { await reconciliation!.admit(input); } // Durable before yielding to native bridge.
              catch (error) { try { message.reject?.(); } catch { /* No native handoff occurred. */ } throw error; }
              yield { ...message, id: input.id };
            }
          } } }),
        };
      }
      if (preparation) {
        if (runtime.nativePreparedDispatch !== "v1" || !runtime.prepareNativeDispatch) throw new Error("Native prepared dispatch capability unavailable");
        nativeLease = await runtime.prepareNativeDispatch(context.systemPrompt, runtimeOptions);
        await preparation.assertOwned();
        const bound = await preparation.ready(nativeLease, preparedContext!);
        await bound.assertOwned(); reconciliation = bound.reconciliation;
        const id = reconciliation.descriptor.reconciliation!.initialInputId!;
        await reconciliation.admit(createPendingInitialInput({ id, persistText: request.userMessage, timestamp: new Date().toISOString() }, currentUserMessage.content));
        const { assertOwned: _owned, reconciliation: _reconciliation, turnRevision: _revision, recoveryRevision, ...keys } = bound;
        runtimeOptions = { ...runtimeOptions, ...keys, sessionTurn: reconciliation.descriptor,
          ...(recoveryRevision === undefined ? {} : { sessionRecovery: { runId, revision: recoveryRevision } }) };
      }
      // The provider call is starting: this run has left the admission-pending
      // tier (it now holds a provider slot rather than waiting for one), so
      // release its maxPendingRuns slot. Idempotent at the run() scope, so the
      // resume-retry's second runRuntime does not double-release.
      onProviderStart?.();
      // Synthetic run_config event: tells live/recorded consumers (TUI, replay)
      // the per-run resolved model/effort — including per-request
      // overrides (cron job / webhook per-trigger model+effort) — so they never
      // have to re-derive it from scattered runtime_telemetry fields. Delivered
      // to both sinks the same way as the provider_bridge_latency event below.
      const runConfigEvent: RuntimeEventLike = {
        type: "run_config",
        model: sessionModelKey(effectiveModel),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        overridden: overrideModel !== undefined || effortOverridden,
        timestamp: new Date().toISOString(),
      };
      emitRuntimeEvent(runConfigEvent);
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
      const turnContextEvent = buildTurnContextEvent(
        history,
        historyOmitted,
        memory,
        speakerTurnContextFields(request.sender, request.precedingMessages),
      );
      emitRuntimeEvent({ ...turnContextEvent, hostCapabilities: capabilityContext });
      // Bracket the provider call so observability can separate provider+tool+IO
      // time (this event's durationMs) from harness overhead (context build,
      // attachment persistence, compaction, admission wait).
      const bridgeStartMs = Date.now();
      try {
        // Normalized initial input and owned-P2 checks may themselves take time.
        // Recheck immediately before consumption; reject with the dirty fence
        // still owned for explicit host recovery, never rely on expiry cancellation.
        nativeLease?.assertReady?.(5_000);
        const result = nativeLease ? await nativeLease.run({ sessionId: runtimeOptions.sessionId, providerSessionId: runtimeOptions.providerSessionId,
          ...(runtimeOptions.providerAttributionSessionId === undefined ? {} : { providerAttributionSessionId: runtimeOptions.providerAttributionSessionId }), sessionKeepAlive: runtimeOptions.sessionKeepAlive,
          sessionIdleTimeoutMs: runtimeOptions.sessionIdleTimeoutMs, sessionTurn: runtimeOptions.sessionTurn, sessionRecovery: runtimeOptions.sessionRecovery,
          ...(runtimeOptions.nativeSessionAuthority ? { nativeSessionAuthority: runtimeOptions.nativeSessionAuthority } : {}),
          ...(runtimeOptions.nativeSessionProjection ? { nativeSessionProjection: runtimeOptions.nativeSessionProjection } : {}),
          ...(runtimeOptions.nativeProvenanceRecording === true ? { nativeProvenanceRecording: true as const } : {}) })
          : await runtime.run(context.systemPrompt, runtimeOptions);
        if (reconciliation !== undefined) {
          const outcome = result.cancelled ? "cancelled" : result.error || result.failureKind ? "failed" : "completed";
          await reconciliation.claim(outcome, outcome !== "completed" ? undefined : { outcome, text: result.text ?? null, timestamp: new Date().toISOString(),
            error: null, failureKind: null,
            ...(result.turnDisposition === "silent" ? { silent: "finish_silently" as const } : {}),
            consumedInputIds: liveInputMailbox?.applied().map((input) => input.id) ?? [] });
        }
        // Prepared context is not evidence of dispatch. Only a successful
        // invocation with a retained provider session can establish receipts.
        if (sessionsEnabled && !sessionIsolated && !result.cancelled && !result.error && !result.failureKind
          && typeof result.providerSessionId === "string" && result.providerSessionId.length > 0) {
          try { options.memory?.recordInvocation?.(runId); }
          catch { emitRuntimeEvent({ type: "runtime_warning", warning_kind: "memory_degraded",
            error_code: "memory_receipt_unavailable", message: "memory_receipt_unavailable" }); }
        }
        return result;
      } finally {
        const latencyEvent: RuntimeEventLike = {
          type: "provider_bridge_latency",
          durationMs: Date.now() - bridgeStartMs,
          timestamp: new Date(bridgeStartMs).toISOString(),
        };
        emitRuntimeEvent(latencyEvent);
      }
    } finally {
      // Remove the abort listener to avoid leaking it on the signal, then run
      // the (idempotent) release so the slot frees exactly once whether the run
      // settled normally or an abort already released it.
      request.abortSignal.removeEventListener("abort", onAbortCleanupAndRelease);
      try {
        try { await nativeLease?.close(); } finally { await cleanupRequestExtension(); }
      } finally {
        try {
          await cleanupAfterSettlement();
        } finally {
          releaseSlot();
        }
      }
    }
}

/**
 * Leading runtime messages for a cold provider reseed: structured canonical
 * history plus the bounded tool-history projection. Pi seeds these only when
 * the durable session is created on miss and skips them on a true resume.
 * Shared by turns and promptless manual compaction.
 */
export function coldReplayMessages(
  history: readonly HistoryMessage[],
  toolHistoryProjection: string | undefined,
): RuntimeMessage[] {
  const structuredHistory = structuredHistoryMessages(history);
  return [
    ...structuredHistory,
    ...(toolHistoryProjection !== undefined
      ? [{
          // Some providers reject a transcript whose first role is
          // assistant. With no canonical messages, keep the synthetic
          // evidence neutral but introduce it as user context.
          role: structuredHistory.length === 0 ? "user" as const : "assistant" as const,
          content: `### Managed Tool Lifecycles (untrusted)\n\n${neutralizeTurnEnvelope(toolHistoryProjection)}`,
        }]
      : []),
  ];
}

/** Deterministic canonical replay; legacy roles remain textual, untrusted evidence. */
function structuredHistoryMessages(history: readonly HistoryMessage[]): RuntimeMessage[] {
  return history.map((message) => {
    const nativeRole = message.role === "assistant" ? "assistant" : "user";
    const label = [
      `Historical ${message.role} (untrusted context)`,
      ...(message.name === undefined ? [] : [`speaker: ${JSON.stringify(message.name)}`]),
      ...(message.timestamp === undefined ? [] : [`timestamp: ${JSON.stringify(message.timestamp)}`]),
    ].join(" — ");
    return {
      role: nativeRole,
      content: neutralizeTurnEnvelope(neutralizeSpeakerMarkup(`${label}\n\n${message.content}`)),
      ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    };
  });
}
