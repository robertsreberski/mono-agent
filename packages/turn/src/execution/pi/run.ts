type CredentialInputs = { apiKeys: Map<string, string> | undefined; resolvePiApiKey: PiApiKeyResolver | undefined; runtimeWarnings: PiWarning[] };
import type { Models, Model, Api } from "@earendil-works/pi-ai";
import type { PiOptions, PiRunState, PiRuntime, PiPreparedControl, PiWarning, PiEventSink, PiMcpClient, PiTranscript } from "./types.js";
import type { PiCredential, PiApiKeyResolver } from "../../providers/pi/auth.js";
import { assertNoRetiredRunOptions } from "../../runtime/retired-options.js";
import { runHarnessPrompt } from "./prompt-operation.js";
import { canCertifySilentTurn } from "../../runtime/silent-turn.js";
import { createDispatchProgress, withDispatchProgress } from "./dispatch-progress.js";
import { validateSessionTurn } from "../../engine/journal-schema.js";
import { isJournalStorageError } from "../../engine/storage-error.js";
import { NativeSuspendedError } from "../../engine/interruption.js";
import { settleNativeSession } from "../../engine/session-settlement.js";
import { createToolContext } from "../../tools/shared/tool-context.js";
// Pi-NATIVE runtime bridge.
//
// This is the SOLE pi runtime path: the hand-rolled pi bridge (formerly
// pi-sdk.js, driving the low-level `Agent` with manual MCP init, transcript
// handling, compaction, a hand-rolled stream-retry loop, and session
// bookkeeping) was removed once this bridge reached parity. This bridge builds
// on pi-agent-core's high-level AgentHarness plus native primitives:
//
//   * AgentHarness OWNS a session and performs durable writes itself, so resume
//     is "open the session from a repo and hand it to a new harness". There is
//     no separate live-session registry here.
//   * The provider transport (pi-ai streamSimple) is invoked by the harness;
//     pre-response retry/backoff is owned by pi-ai provider transport; the
//     engine never retries a settled response or a partial paid stream.
//   * Tool sandboxing, approval gates, allowlist/bloat filtering, and the MCP
//     tool bridge are reused shared pieces — they are wired into the harness
//     via its `tools` option, never reimplemented.
//
// The result/event contract is the package's unified runtime-result shape, so
// callers and the test suite see the same artifact the retired bridge produced.

import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { randomUUID } from "node:crypto";
import { estimateTokens } from "../../engine/compaction-kit/compaction.js";
import { estimateCost } from "../../telemetry/cost.js";
import { retryableProviderFailureInfo } from "../../telemetry/failure.js";
import { runtimeCapabilities } from "../../runtime/capabilities.js";
import {
  resolveAgentCompactionPolicy, estimateFixedOverheadTokens,
} from "../../agent/compaction.js";
import { subagentInvocationCount, subagentUsageForRun } from "../../tools/delegation/agent-tool.js";
import { closePiMcpClients } from "../../tools/mcp/tools.js";
import { createApprovalManager } from "../../agent/approval.js";
import { buildCapabilitiesUsed, toolCompactionAppliedFromWarnings } from "../../telemetry/capabilities-used.js";
import { withContext1M, withContext1MModels } from "../../providers/pi/context-1m.js";
import { reasoningLevelsForPiModel, resolvePiRuntimeModel } from "../../providers/pi/models.js";
import {
  thinkingFromContent,
  toAgentMessages,
} from "../../providers/pi/messages.js";
import { emitCaptured } from "../../providers/pi/events.js";
import { normalizePiErrorMessage } from "../../providers/pi/errors.js";
import { annotateProviderErrorMessage, installTransportErrorProbe } from "../../providers/pi/transport-errors.js";
import {
  runStructuredOutputFinalizationRetry,
  shouldRetryStructuredOutputFinalization,
} from "./structured-output.js";
import {
  abortedResult,
  buildDiagnostics,
  buildErrorDetails,
  buildErrorResult,
  buildSuccessResult,
  failureKindForPiError,
  emitCapabilitiesResolved,
  emitUsageCostEvents,
  usageFromMessages,
  hasMeasuredUsage,
  withSubagentUsage,
} from "./result-builder.js";
import { captureSessionRecovery, cleanupSessionOnThrow, commitSession, discardUncommittedSession, resolveSession, rollbackAbortedTurn } from "./session-results.js";
import { resolveDurableNativeSessionRepo } from "../../engine/session-lifecycle.js";
import {
  resolveLiveCompactionPolicy,
  estimateSessionMessageTokens,
  tryCompact,
  runProactiveCompaction,
  runReactiveCompaction,
} from "./compaction/compaction-driver.js";
import { armMidRunCompaction } from "./compaction/mid-run-compaction.js";
import {
  activateTurnHarness,
  buildTurnHarness,
  buildTurnTools,
  createLiveInputPromptEpoch,
  startLiveInput,
  thinkingLevelForEffort,
} from "./turn-runner.js";
import { runEmptyReplyRetry, shouldRetryEmptyReply } from "./empty-reply.js";
import { finalReplyText } from "./reply-text.js";
import { resolvePiTransport } from "./transport.js";
import { withOpenCodeSessionHeaders } from "./provider-attribution.js";
import { appendStructuredOutputInstruction } from "./structured-output.js";
import { prepareNativeHandoffSummaryRequest, produceNativeHandoffSummary } from "./handoff-producer.js";
import { createPreparedDispatchLease, snapshotNativeDispatchOptions, prepareDispatchAuth, freezeDispatchData, copyDispatchData } from "./prepared-dispatch.js";

/**
 * Resolve mono-agent's programmatic mode once per run. Tool builders mark
 * stateful/mutating tools sequential; the harness adapter gates each invoked
 * call in safe-parallel mode, while the explicit sequential mode covers all calls.
 */
export function resolvePiToolExecutionMode(options?: {}): {
    mode: any;
    warnings: {
        warning_kind: string;
        message: string;
    }[];
};
export function resolvePiToolExecutionMode(options: PiOptions = {}) {
  assertNoRetiredRunOptions(options);
  const warnings = [];
  const requested = options.piToolExecutionMode;
  let mode = requested === "sequential" || requested === "safe-parallel"
    ? requested
    : null;
  if (requested !== undefined && mode === null) {
    warnings.push({
      warning_kind: "invalid_pi_tool_execution_mode",
      message: `Unknown piToolExecutionMode ${JSON.stringify(requested)}; using safe-parallel.`,
    });
  }
  return { mode: mode || "safe-parallel", warnings };
}

async function resolveApiKey(provider: string, { apiKeys, resolvePiApiKey, runtimeWarnings }: CredentialInputs) {
  if (apiKeys?.has(provider)) return apiKeys.get(provider);
  if (typeof resolvePiApiKey !== "function") return undefined;
  try {
    return await resolvePiApiKey(provider);
  } catch (err: any) {
    runtimeWarnings.push({
      warning_kind: "pi_auth_failed",
      provider,
      message: err?.message || String(err),
    });
    return undefined;
  }
}

async function readCredential(provider: string, { apiKeys, resolvePiApiKey, runtimeWarnings }: CredentialInputs): Promise<PiCredential | undefined> {
  if (apiKeys?.has(provider)) {
    const key = apiKeys.get(provider);
    return typeof key === "string" && key.length > 0 ? { type: "api_key", key } : undefined;
  }
  if (typeof resolvePiApiKey?.readCredential === "function") {
    const credential = await resolvePiApiKey.readCredential(provider);
    return isCredential(credential) ? credential : undefined;
  }
  const key = await resolveApiKey(provider, { apiKeys, resolvePiApiKey, runtimeWarnings });
  return typeof key === "string" && key.length > 0 ? { type: "api_key", key } : undefined;
}

function isCredential(credential: any): credential is PiCredential {
  return credential
    && typeof credential === "object"
    && (credential.type === "api_key" || credential.type === "oauth");
}

// pi 0.80 removed the harness `getApiKeyAndHeaders` hook: request auth now
// resolves through a `Models` collection's `CredentialStore`. This store keeps
// the bridge's per-run key-resolution contract intact — an `apiKeys` map entry
// wins, else an enhanced host resolver's credential-store methods are used, else
// the legacy `resolvePiApiKey(provider)` callback is consulted. Legacy callback
// failures remain soft (`pi_auth_failed` warning + keyless env fallback);
// credential-store read/modify failures reject so Pi can surface them as auth
// storage failures instead of silently treating a corrupt store as no credential.
export function createDynamicCredentialStore(apiKeys: any, resolvePiApiKey: any, runtimeWarnings: any): any;
export function createDynamicCredentialStore(apiKeys: Map<string, string> | undefined, resolvePiApiKey: PiApiKeyResolver | undefined, runtimeWarnings: PiWarning[]) {
  const read = async (providerId: string) => readCredential(providerId, { apiKeys, resolvePiApiKey, runtimeWarnings });
  return (({
    read,
    // The callback-only fallback below can derive auth but cannot persist an
    // OAuth rotation. Ordinary refresh requires a persisting resolver.
    async modify(providerId: string, fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>) {
      if (!apiKeys?.has(providerId) && typeof resolvePiApiKey?.modifyCredential === "function") {
        return resolvePiApiKey.modifyCredential(providerId, fn);
      }
      const current = await read(providerId);
      if (current?.type === "oauth") throw new Error("OAuth modification requires a persisting credential resolver");
      const next = await fn(current);
      if (apiKeys?.has(providerId) && next?.type === "api_key" && typeof next.key === "string") {
        apiKeys.set(providerId, next.key);
      }
      return next ?? current;
    },
    async delete(providerId: string) {
      if (apiKeys?.has(providerId)) {
        apiKeys.delete(providerId);
        return;
      }
      if (typeof resolvePiApiKey?.deleteCredential === "function") {
        await resolvePiApiKey.deleteCredential(providerId);
      }
    },
  }) as any);
}

// Assemble the pi 0.80 `Models` collection serving this run. Builtin models
// reuse pi's own provider factories (correct per-provider baseUrl/headers and
// env-var fallback); a custom OpenAI-completions provider is registered from the
// resolved model. `piResolvedModels` is an advanced/test seam mirroring
// `piResolvedModel`: when supplied it is used verbatim (the model dispatched via
// `piResolvedModel` may live outside pi's builtin catalog, e.g. a faux model).
function buildRunModels(runtime: PiRuntime, options: PiOptions, runtimeWarnings: PiWarning[]) {
  let models;
  if (options.piResolvedModels) {
    models = options.piResolvedModels;
  } else {
    const credentials = createDynamicCredentialStore(runtime.apiKeys, options.resolvePiApiKey, runtimeWarnings);
    if (options.customProvider) {
      const model = runtime.model;
      models = createModels({ credentials });
      models.setProvider(createProvider({
        id: model.provider,
        name: model.name || model.provider,
        baseUrl: model.baseUrl,
        auth: { apiKey: envApiKeyAuth(model.name || model.provider, []) },
        models: [model],
        api: openAICompletionsApi(),
      }));
    } else {
      models = builtinModels({
        credentials,
        ...(options.providerCheckAuthContext === undefined
          ? {}
          : { authContext: options.providerCheckAuthContext }),
      });
    }
  }
  return withContext1MModels(models, options.customProvider ? undefined : options.context1MModels);
}

const PROVIDER_CHECK_REQUEST_METHODS = new Set([
  "stream",
  "complete",
  "streamSimple",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
]);

/**
 * Pi's Agent resolves the transport model through `Models` again, so capping
 * only the model handed to the harness does not constrain the actual provider
 * request or the intended output limit used to classify length stops. Cap both
 * re-resolution and dispatch, leaving the shared model collection unchanged.
 * This wrapper is activated only for explicit provider checks.
 */
function withProviderCheckOutputCap(models: Models, requestedCap: unknown): Models {
  const cap = Number(requestedCap);
  if (!Number.isSafeInteger(cap) || cap <= 0) return models;
  const capped = (model: Model<Api> | undefined) => {
    if (model === undefined) return model;
    const current = Number(model.maxTokens);
    return { ...model, maxTokens: Number.isFinite(current) && current > 0 ? Math.min(current, cap) : cap };
  };
  const wrappers = new Map<string, (...args: any[]) => any>();
  return ((new Proxy(models, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") return value;
      if (property === "getModel") return (...args: any[]) => capped(value.apply(target, args));
      if (!PROVIDER_CHECK_REQUEST_METHODS.has(property)) return value.bind(target);
      let wrapper = wrappers.get(property);
      if (wrapper === undefined) {
        wrapper = (model: Model<Api>, ...args: any[]) => {
          return value.call(target, capped(model), ...args);
        };
        wrappers.set(property, wrapper);
      }
      return wrapper;
    },
  })) as import("@earendil-works/pi-ai").Models);
}

// Normalize the incoming runtime messages into AgentMessages the harness can
// seed/prompt. Returns the prior messages (appended to the session before the
// run) and the final user text used to drive `harness.prompt`.
export function splitPromptMessages(messages: any, model: any): {
    priorMessages: any[];
    promptText: string;
    promptImages: {
        type: string;
        data: any;
        mimeType: any;
    }[];
} {
  const source = Array.isArray(messages) && messages.length
    ? messages
    : [{ role: "user", content: "" }];
  // The harness `prompt` takes the trailing user turn; everything before it is
  // seeded as transcript context.
  let lastUserIndex = -1;
  for (let i = source.length - 1; i >= 0; i -= 1) {
    if (source[i]?.role === "user") { lastUserIndex = i; break; }
  }
  if (lastUserIndex === -1) {
    // No user turn: seed everything (structure preserved), nothing to prompt.
    return { priorMessages: toAgentMessages(source, model), promptText: "", promptImages: [] };
  }
  // Prior turns: preserve structure (incl. image blocks) via toAgentMessages
  // instead of stringifying — this is the format the harness seeds from.
  const priorMessages = lastUserIndex > 0 ? toAgentMessages(source.slice(0, lastUserIndex), model) : [];
  // Final user turn: split into plain text + structured images so harness.prompt
  // can receive them as ImageContent[] rather than a JSON-stringified blob.
  const { text, images } = splitUserContent(source[lastUserIndex].content);
  return { priorMessages, promptText: text, promptImages: images };
}

// Split a user message's content into joined text and ImageContent[] image
// parts ({ type, data, mimeType }), preserving multimodal input for the runtime.
function splitUserContent(content: any) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ""), images: [] };
  const texts = [];
  const images = [];
  for (const part of content) {
    if (typeof part === "string") { texts.push(part); continue; }
    if (part?.type === "text" && typeof part.text === "string") { texts.push(part.text); continue; }
    if (part?.type === "image" && part.data) {
      images.push({ type: "image", data: part.data, mimeType: part.mimeType || part.mime_type || "image/png" });
      continue;
    }
    texts.push(JSON.stringify(part ?? ""));
  }
  return { text: texts.join("\n"), images };
}

import { createCompactionUsage, withCompactionUsage, compactionCostEvent, manualCompactionAccounting } from "../../telemetry/compaction-usage.js";

export function generateEngineTurnResponse(systemPrompt: any, options?: {}): Promise<any>;
export async function generateEngineTurnResponse(systemPrompt: string, options: PiOptions = {}) {
  return await executePiNativeResponse(systemPrompt, options);
}

/** Additive preparation only. No configured host invokes it yet. */
export function preparePiNativeDispatch(systemPrompt: any, options?: {}, afterSettlement?: () => Promise<void>): Promise<import("../../contracts/runtime.js").NativePreparedDispatch>;
export function preparePiNativeDispatch(systemPrompt: string, options: PiOptions = {}, afterSettlement: () => Promise<void> = async () => {}) {
  if (Object.hasOwn(options, "piSessionsRoot")) throw new TypeError("piSessionsRoot was renamed to sessionsRoot; use sessionsRoot instead");
  assertNoRetiredRunOptions(options);
  const frozen = snapshotNativeDispatchOptions(options);
  return createPreparedDispatchLease((control) => executePiNativeResponse(systemPrompt, frozen, control).finally(afterSettlement), frozen.abortSignal);
}

async function executePiNativeResponse(systemPrompt: string, options: PiOptions = {}, control: PiPreparedControl | undefined = undefined) {
  if (Object.hasOwn(options, "piSessionsRoot")) throw new TypeError("piSessionsRoot was renamed to sessionsRoot; use sessionsRoot instead");
  assertNoRetiredRunOptions(options);
  const dispatchProgress = createDispatchProgress();
  try {
    const compactionUsage = createCompactionUsage();
    const observed = { ...options, onEvent: (event: any) => { compactionUsage.observe(event); options.onEvent?.(event); } };
    const result = withCompactionUsage(await executeTrackedPiNativeResponse(systemPrompt, observed, control, dispatchProgress), compactionUsage);
    if (options.manualCompaction && result.usage?.compaction) {
      const accounting = manualCompactionAccounting(result.usage.compaction)!;
      if (result.manualCompaction) result.manualCompaction.accounting = accounting;
      else if (!result.cancelled && !options.abortSignal?.aborted && accounting.requests.some((row) => row.input !== null || row.output !== null || row.costUsd !== null)) {
        result.manualCompaction = { status: "failed", trigger: "manual", operationId: accounting.requests[0]!.requestId.replace(/:\d+$/, ""), accounting, reason: "summary_failed" };
      }
    }
    if (result.usage?.compaction) {
      const event = compactionCostEvent(result);
      options.onEvent?.(event);
      result.events = [...(result.events || []), event];
    }
    return { ...result, dispatchProgress: Object.freeze({ ...dispatchProgress }) };
  } catch (error) {
    throw withDispatchProgress(error, dispatchProgress);
  }
}

async function executeTrackedPiNativeResponse(systemPrompt: string, options: PiOptions, control: PiPreparedControl | undefined, dispatchProgress: import("../../contracts/runtime.js").RuntimeDispatchProgress) {
  if (Object.hasOwn(options, "settings")) {
    throw new Error("runOptions.settings was removed; pass typed toolLimits and compaction instead.");
  }
  // Direct provider callers own a fresh context; createRuntime already binds
  // its instance context. Every internal execution path receives this object.
  if (!options.toolContext) {
    options = { ...options, toolContext: createToolContext({
      workspace: options.cwd,
      toolEnvironment: options.toolEnvironment,
      runtimeBrand: options.runtimeBrand,
      sandbox: options.sandbox,
      sandboxPolicy: options.sandboxPolicy,
      sandboxEngine: options.sandboxEngine,
    } as Parameters<typeof createToolContext>[0]) };
  }
  // Idempotent; arms the undici diagnostics-channel probe so a transport
  // failure during this run can be resolved back to a real reason even after
  // an intermediate layer flattens the Error to its message.
  installTransportErrorProbe();
  const resolved = options.model;
  if (
    typeof resolved?.provider !== "string"
    || resolved.provider.length === 0
    || typeof resolved.model !== "string"
    || resolved.model.length === 0
  ) {
    throw new Error("invalid pi model reference: provider and model are required");
  }
  const start = Date.now();
  const events: any[] = [];
  const runtimeWarnings: PiWarning[] = [];
  let mcpClients: PiMcpClient[] = [];
  let closeRunTools = async () => {};
  let harness: (Omit<Awaited<ReturnType<typeof buildTurnHarness>>, "endTurn"> & { compactionFailureKey?: string; endTurn: (status: string, result?: any) => Promise<void> }) | null = null;
  let midRunCompaction = null;
  // The ONE explicit runState the extracted modules (stream subscriber, session
  // lifecycle, compaction driver, turn runner, result builder) read/write.
  // Reassignable scalars/refs live here so a module can rebind them (an
  // orchestrator local cannot be reassigned from a module). `events` /
  // `runtimeWarnings` stay as consts shared by reference. `toolStartTimes` maps
  // toolCallId -> start timestamp so per-tool execution latency can be emitted.
  const runState: PiRunState = {
    dispatchProgress,
    assistantTexts: [],
    assistantThinking: [],
    textDeltaIndexes: new Set(),
    thinkingDeltaIndexes: new Set(),
    // Mid-stream request retries observed by the stream subscriber.
    requestRetry: { retries: 0, failedAttempts: null, textMark: 0, thinkingMark: 0 },
    toolStartTimes: new Map(),
    toolApprovals: new Map(),
    turnCount: 0,
    toolResultsSeen: 0,
    lastToolName: null,
    maxTurnsHit: false,
    toolExecutionsThisTurn: 0,
    toolFailureThisTurn: false,
    structuredOutputCompletedThisTurn: false,
    silentCompletedThisTurn: false,
    silentTurn: { soleCall: false, visibleContent: false, pendingQuestion: false, failed: false, accepted: false, completed: false },
    // Populated by the StructuredOutput tool callback (built in the turn runner);
    // read by the finalization retry predicate and the result assembly.
    structuredResult: null,
    // Set by the turn-runner abort handler; the OUTER catch and lifecycle
    // decisions re-check it (`externalAbort ||= aborted`). removeAbortHandler is
    // installed by the turn runner and cleared in finally; harness is set there
    // too.
    externalAbort: false,
    removeAbortHandler: null,
    harness: null,
    // Auto-compaction sub-state. The policy is (re)computed at the decision
    // point against the model actually serving the request; these flags track
    // whether a compaction fired so the run reports context_compaction_applied
    // honestly and suppresses redundant fresh compactions.
    compaction: {
      applied: false,
      reactiveAttempted: false,
      compactedThisRun: false,
      lastMidRunCompaction: null,
      policy: null,
      diagnostics: {},
      // Usage of this run's own transcript that a mid-run compaction summarized
      // away. Those tokens were billed to this run, so they are added back to
      // the sliced transcript usage (see mid-run-compaction.js).
      carriedUsage: null,
      carriedUsageMeasured: false,
    },
    session: null,
    // Fresh stateless calls own a private repo, even when attribution matches a
    // live primary session. Cleanup must never delete that primary's record.
    ephemeralSessionRepo: null,
    sessionEntry: null,
    // Fresh keep-alive sessions are registered busy until the harness closes;
    // this prevents another turn from reopening the same repo record while its
    // first handle is still live.
    registeredSessionEntry: null,
    // True when a requestedSessionId had no live entry AND no durable transcript,
    // so a fresh durable session was created under that id (cross-restart resume,
    // first turn for the conversation). Distinct from a true resume (sessionEntry
    // set): the on-disk transcript is empty, so prior messages must still be
    // seeded — unlike a resume, where the session already holds them.
    createdOnMiss: false,
    // The create-on-miss BUSY reservation handle (R8 concurrent-first-turn
    // reservation) when the create path inserted its placeholder; null
    // otherwise. Its release()/commit() clean the placeholder on the
    // drop/error/abort/keep-alive paths, since createdOnMiss leaves sessionEntry
    // null so the finally's busy-clear does not cover it.
    reservation: null,
    sessionBaselineCount: 0,
    // Leaf captured before a resumed turn runs, so a failed resume can be rolled
    // back to the last good transcript via moveTo. On runState so the OUTER catch
    // (host/runtime-side throws after the session mutated) can roll back too, not
    // just the success path.
    baselineLeafId: null,
    hasBaselineLeaf: false,
    recoveryOperationId: undefined,
    recoveryInputIds: null,
    retainRecoveryTail: false,
  };

  let providerSessionId = options.sessionId
    || options.providerSessionId
    || options.providerAttributionSessionId
    || options.runId
    || randomUUID();
  const validateProtectedTurn = () => {
    if (options.sessionTurn !== undefined) {
      try {
        validateSessionTurn(options.sessionTurn, providerSessionId);
        if (options.sessionTurn.reconciliation && (typeof options.sessionsRoot !== "string" || !options.sessionsRoot.trim()
          || options.sessionKeepAlive !== true || options.sessionTurn.reconciliation.purpose !== (options.manualCompaction ? "compaction" : "execution"))) {
          throw new TypeError("Reconciliation requires a durable kept-alive turn of matching purpose");
        }
        runState.preserveTurnEvidence = !!options.sessionTurn.reconciliation;
        if (options.sessionRecovery && (options.sessionRecovery.runId !== options.sessionTurn.turnId
          || (options.sessionTurn.baseRevision !== null && options.sessionRecovery.revision !== options.sessionTurn.baseRevision))) {
          throw new TypeError("sessionTurn and sessionRecovery identities disagree");
        }
      } catch {
        return { ...buildErrorResult({ assistantTexts: [], events, start, turnCount: 0, resolved, options,
          externalAbort: false, errorMessage: "Invalid protected sessionTurn host contract", providerSessionId,
          runtimeWarnings, isRetryable: false }), failureKind: "safety_session_turn_contract", retryable: false };
      }
    }
  };
  if (!control) { const invalid = validateProtectedTurn(); if (invalid) return invalid; }
  let providerAttributionSessionId = options.providerAttributionSessionId || providerSessionId;
  // Prefer the explicit sessionId, but fall back to providerSessionId so a caller
  // that only supplies providerSessionId still resumes the prior session instead
  // of being treated as a fresh run (which would drop prior context).
  let requestedSessionId = typeof options.sessionId === "string" && options.sessionId.trim()
    ? options.sessionId
    : (typeof options.providerSessionId === "string" && options.providerSessionId.trim()
      ? options.providerSessionId
      : null);
  // Bridge TTL is a backstop behind the host's session policy; the grace
  // keeps host-side lazy expiry firing first.
  let sessionTtlMs = Number.isFinite(Number(options.sessionIdleTimeoutMs))
    ? Number(options.sessionIdleTimeoutMs) + 60_000
    : undefined;
  let structuredOutputFinalizationRetryAttempts = 0;
  let structuredOutputFinalizationRetryReason = null;
  let structuredOutputFinalizationRetryFailed = false;
  const piTransport = resolvePiTransport(options.piTransport);

  const onEvent: PiEventSink = (event) => {
    if (event?.type === "tool_approval_denied" && typeof event.toolUseId === "string") {
      runState.toolApprovals.set(event.toolUseId, event);
    }
    emitCaptured(events, options.onEvent, event);
  };
  // Exec runs a command a host configured Bash's risk tier for.
  // Leaving it unmapped would let the same shell command take a lower
  // approval tier simply by being started through a different tool.
  const bashRiskTier = options.toolRiskTiers?.Bash;
  const approvalRiskTiers = {
    ...(options.toolRiskTiers || {}),
    ...(bashRiskTier !== undefined
      ? Object.fromEntries(["Exec"]
        .filter((name) => options.toolRiskTiers?.[name] === undefined)
        .map((name) => [name, bashRiskTier]))
      : {}),
  };
  const approvalManager = options.onToolApprovalRequest
    ? createApprovalManager({
      onToolApprovalRequest: options.onToolApprovalRequest,
      defaultRiskTier: options.approvalDefaultRiskTier,
      timeoutMs: options.approvalTimeoutMs,
      onEvent,
      riskTiersByTool: approvalRiskTiers,
      alwaysAllowTools: options.approvalAlwaysAllowTools,
    } as Parameters<typeof createApprovalManager>[0])
    : null;

  if (options.abortSignal?.aborted) {
    return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId, piTransport });
  }

  // Host-owned capabilities/content are snapshotted before any asynchronous
  // preparation; functions retain the held owner's original closure.
  if (options.nativeSessionAuthority || options.nativeSessionProjection) options = { ...options,
    nativeSessionAuthority: options.nativeSessionAuthority && { ...options.nativeSessionAuthority,
      hostAuthority: structuredClone(options.nativeSessionAuthority.hostAuthority) },
    nativeSessionProjection: options.nativeSessionProjection && structuredClone(options.nativeSessionProjection) };
  let durableRepo: ReturnType<typeof resolveDurableNativeSessionRepo>;

  const prepareRun = async () => {
    // `piResolvedModel` is an advanced/test seam: when supplied it provides a
    // ready pi-ai Model (e.g. a registered faux provider model) plus optional
    // capabilities, bypassing the static model-registry lookup. Production
    // callers leave it undefined and resolve through pi-ai's registry.
    let runtime: PiRuntime = options.piResolvedModel
      ? {
        model: withContext1M(options.piResolvedModel, options.customProvider ? undefined : options.context1MModels),
        capabilities: options.piResolvedCapabilities || {
          tool_use: true,
          reasoning: !!options.piResolvedModel.reasoning,
          reasoning_mode: options.piResolvedModel.reasoning ? "effort" : "none",
          reasoning_levels: options.piResolvedModel.reasoning
            ? reasoningLevelsForPiModel(options.piResolvedModel)
            : undefined,
          json_mode: true,
        },
        apiKeys: new Map(),
      }
      : resolvePiRuntimeModel(resolved, options) as PiRuntime;
    const providerCheckMaxTokens = options.providerCheckMaxTokens;
    if (typeof providerCheckMaxTokens === "number" && Number.isSafeInteger(providerCheckMaxTokens) && providerCheckMaxTokens > 0) {
      runtime = {
        ...runtime,
        model: {
          ...runtime.model,
          maxTokens: Math.min(runtime.model.maxTokens, providerCheckMaxTokens),
        },
      };
    }
    const capabilities = runtime.capabilities || {};
    const effectiveThinkingLevel = thinkingLevelForEffort(options.effort || "medium", capabilities);
    const reference = resolved.reference || `${resolved.provider}:${resolved.model}`;

    // One canonical clamp path consumes the typed policy inputs directly. The
    // deprecated flat `settings` bag is gone; hosts pass typed toolLimits and
    // compaction, and the per-run execution budget main added is overlaid here so
    // direct and Pi execution share one foreground ceiling.
    const toolLimits = {
      ...resolveAgentCompactionPolicy(options, runtime.model),
      // This per-run execution budget has no legacy settings equivalent.
      ...(options.toolLimits?.bashTimeoutMs === undefined ? {} : { bashTimeoutMs: options.toolLimits.bashTimeoutMs }),
    };
    const toolExecution = resolvePiToolExecutionMode(options);
    // The after_response gate refuses mixed batches before any tool executes.
    // Preserve normal parallel scheduling for all other admitted calls.
    const effectiveToolExecutionMode = toolExecution.mode;
    for (const warning of toolExecution.warnings) {
      runtimeWarnings.push(warning);
      onEvent({ type: "runtime_warning", ...warning });
    }

    // Build the turn's tools (builtins + MCP bridge + StructuredOutput). The
    // StructuredOutput callback writes runState.structuredResult; the MCP clients
    // are closed in the finally.
    const {
      tools,
      structuredTool,
      mcpClients: builtMcpClients,
      closeRunTools: builtCloseRunTools,
    } = options.manualCompaction === true
      ? { tools: [], structuredTool: null, mcpClients: [], closeRunTools: async () => {} }
      : await buildTurnTools(runState, {
      options,
      capabilities,
      toolLimits,
      approvalManager,
      runtime,
      resolved,
      onEvent,
      runtimeWarnings,
      toolExecutionMode: effectiveToolExecutionMode,
    });
    mcpClients = builtMcpClients;
    closeRunTools = builtCloseRunTools;

    // Preserve the legacy count; child outage profiles change ownership later.
    const retryValue = typeof options.piMaxRetries === "string" && options.piMaxRetries.trim() !== ""
      ? Number(options.piMaxRetries) : options.piMaxRetries;
    const maxRetries = Number.isFinite(retryValue) ? Math.max(0, Math.min(8, Math.trunc(retryValue as number))) : 2;
    const maxRetryDelayMs = Number.isFinite(Number(options.maxRetryDelayMs)) && Number(options.maxRetryDelayMs) > 0
      ? Number(options.maxRetryDelayMs)
      : 60_000;
    // Steering controls user follow-up delivery, not tool scheduling. Keep it
    // independent from piToolExecutionMode; the adapter gates invoked calls.
    const toolSteeringMode = "one-at-a-time";

    const basePiModels = buildRunModels(runtime, options, runtimeWarnings);
    const piModels = withProviderCheckOutputCap(withOpenCodeSessionHeaders(basePiModels, providerAttributionSessionId), options.providerCheckMaxTokens);

    return { runtime, capabilities, effectiveThinkingLevel, reference, toolLimits, effectiveToolExecutionMode,
      tools, structuredTool, maxRetries, maxRetryDelayMs, toolSteeringMode, basePiModels, piModels };
  };

  try {
    durableRepo = resolveDurableNativeSessionRepo(options.sessionsRoot);
    const prepared = control ? await prepareRun() : undefined;
    if (prepared) {
      if (runtimeWarnings.some((warning) => ["mcp_init_failed", "mcp_list_tools_failed"].includes(warning.warning_kind))) {
        throw new Error("Native dispatch preparation requires complete MCP declarations");
      }
      const auth = await prepareDispatchAuth(prepared.basePiModels, prepared.runtime.model, options.abortSignal);
      if (auth.model.provider !== resolved.provider || auth.model.id !== resolved.model) throw new Error("Prepared dispatch does not match its canonical requested model");
      prepared.runtime = { ...prepared.runtime, model: auth.model };
      // Pin actual declarations, not names/config guesses; execute closures stay
      // attached to this exact runState and are never initialized a second time.
      for (const tool of prepared.tools) tool.parameters = freezeDispatchData(copyDispatchData(tool.parameters));
      systemPrompt = appendStructuredOutputInstruction(systemPrompt, options.outputSchema, options.prompts);
      const binding = await control!.ready({ systemPrompt, messages: structuredClone(options.messages ?? []),
        model: { provider: auth.model.provider, id: auth.model.id, api: auth.model.api,
          contextWindow: auth.model.contextWindow, maxTokens: auth.model.maxTokens },
        tools: prepared.tools.map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) })),
        compactionSummaryMaxTokens: resolveAgentCompactionPolicy(options, auth.model).summaryMaxTokens,
        provenance: auth.provenance }, {
        assertReady: () => options.abortSignal?.throwIfAborted(),
        check: (input) => { options.abortSignal?.throwIfAborted(); const result = prepareNativeHandoffSummaryRequest({ ...input, model: auth.model });
          return result.status === "ready" ? { status: "ready" as const } : result as import("../../contracts/native-storage.js").RuntimeHandoffFit; },
        run: (input) => produceNativeHandoffSummary({ ...input, model: auth.model, completeSimple: prepared.piModels.completeSimple.bind(prepared.piModels),
          signal: options.abortSignal, completionOptions: { transport: options.piTransport ?? "sse" } }),
      });
      options.abortSignal?.throwIfAborted(); // Before any native lookup/open or incoming mutation.
      options = { ...options, ...binding };
      providerSessionId = options.sessionId || options.providerSessionId || options.providerAttributionSessionId || options.runId || providerSessionId;
      providerAttributionSessionId = options.providerAttributionSessionId || providerSessionId;
      requestedSessionId = options.sessionId || options.providerSessionId || null;
      sessionTtlMs = Number.isFinite(Number(options.sessionIdleTimeoutMs)) ? Number(options.sessionIdleTimeoutMs) + 60_000 : undefined;
      prepared.piModels = withProviderCheckOutputCap(withOpenCodeSessionHeaders(auth.models, providerAttributionSessionId), options.providerCheckMaxTokens);
      const invalid = validateProtectedTurn(); if (invalid) return invalid;
      options.abortSignal?.throwIfAborted();
    }
    // Resume the session (warm registry hit, durable cold reopen, or
    // create-on-miss for a durable cross-restart first turn) or create a fresh
    // one. resolveSession mutates runState.session / sessionEntry / createdOnMiss
    // / reservation, and returns an early fast-fail result (session_not_found /
    // session_busy) to return verbatim. Its liveness claims (I1 busy-claim, R8
    // reservation, F4 cold-reopen re-read) are await-free by construction. A
    // ordinary session miss stays cheap: no tool/MCP/harness init runs before
    // this fast-fail. The explicit prepared path has already resolved its tools.
    try {
      const resolvedSession = await resolveSession(runState, {
        requestedSessionId,
        providerSessionId,
        durableRepo,
        sessionTtlMs,
        cwd: options.cwd,
        resolved,
        options,
        events,
        runtimeWarnings,
        start,
        piTransport,
      });
      if (resolvedSession.done) return resolvedSession.result;
    } finally {
      if (durableRepo?.rootPermissionWarningPending) {
        durableRepo.rootPermissionWarningPending = false;
        const warning = { warning_kind: "sessions_root_permissions_tightened", source: "pi",
          message: "Owned durable sessions root permissions tightened to 0700; other-user read access removed." };
        runtimeWarnings.push(warning); onEvent({ type: "runtime_warning", ...warning });
      }
    }

    const { runtime, capabilities, effectiveThinkingLevel, reference, toolLimits, effectiveToolExecutionMode,
      tools, structuredTool, maxRetries, maxRetryDelayMs, toolSteeringMode, piModels } = prepared ?? await prepareRun();

    // Construct the harness and recover any interrupted durable operation.
    // Stream subscription and the external abort handler are activated only
    // after prior transcript seeding, so manual append lifecycle events cannot
    // surface as output from this run.
    harness = await buildTurnHarness(runState, {
      session: runState.session,
      piModels,
      model: runtime.model,
      thinkingLevel: effectiveThinkingLevel,
      systemPrompt,
      outputSchema: control ? undefined : options.outputSchema,
      tools,
      toolExecutionMode: effectiveToolExecutionMode,
      transport: piTransport,
      maxRetries,
      maxRetryDelayMs,
      steeringMode: toolSteeringMode,
      options: { ...options, onEffectiveEffort: (effectiveEffort: string | undefined) => onEvent({ type: "provider_execution_config", sdk: "pi", model: reference,
        ...(options.effort ? { effort: options.effort } : {}), ...(effectiveEffort ? { effectiveEffort } : {}), timestamp: Date.now() }) },
    });
    harness.compactionFailureKey = JSON.stringify([options.sessionsRoot || options.cwd || "runtime", requestedSessionId || providerSessionId]);

    if (options.nativeSessionProjection) {
      runState.session!.setInheritedProjection(options.nativeSessionProjection.inherited);
    }
    // Seed prior transcript (everything before the trailing user turn) into the
    // harness-owned session. On a true resume the session already holds the
    // transcript, so prior messages are skipped; a fresh run AND a create-on-miss
    // (requestedSessionId set but the durable session was just created empty)
    // both seed, since their on-disk transcript is empty.
    let { priorMessages, promptText, promptImages } = options.manualCompaction === true
      ? { priorMessages: toAgentMessages(options.messages || [], runtime.model), promptText: "", promptImages: [] }
      : splitPromptMessages(options.messages, runtime.model);
    runState.sessionBaselineCount = (await runState.session!.buildContext()).messages.length;
    if (!options.nativeSessionProjection && (!requestedSessionId || runState.createdOnMiss
      || control && options.nativeSessionAuthority && runState.sessionBaselineCount === 0)) {
      // Resolve optional continuity only after the real creation decision. The
      // resulting messages are persisted with the seed and included in ordinary
      // provider usage/context accounting, never appended on a true resume.
      let evidence: any[] = [];
      if (options.coldContext && options.manualCompaction !== true) {
        try {
          const policy = resolveLiveCompactionPolicy({ harness, runtime, resolved, compaction: options.compaction,
            contextWindowOverride: options.compaction?.contextWindowOverride });
          const fixed = estimateFixedOverheadTokens({ systemPrompt, tools }).fixedOverheadTokens;
          const messages = toAgentMessages(options.messages || [], runtime.model);
          const input = messages.reduce((sum, message) => sum + Number(estimateTokens(message)), 0);
          const window = Math.min(policy.contextWindow, Number(options.compaction?.contextWindowOverride) || runtime.model.contextWindow);
          const reserve = Math.max(4096, Number(runtime.model.maxTokens) || 0) + 4096;
          const maxTokens = Math.max(0, Math.min(8000, Math.floor(Math.min(window, policy.triggerTokens) - fixed - input - reserve)));
          const cold = await options.coldContext({ maxTokens: maxTokens < 500 ? 0 : maxTokens, reason: runState.createdOnMiss ? "created_on_miss" : "cold_rebuild" });
          evidence = toAgentMessages(cold.messages, runtime.model);
          if (evidence.reduce((sum, message) => sum + Number(estimateTokens(message)), 0) > maxTokens) {
            evidence = [];
            onEvent({ type: "runtime_warning", warning_kind: "continuity_pack_degraded", error_code: "headroom", message: "Continuity evidence omitted: target headroom." });
          } else if (cold.replayMessages && priorMessages.length > 0) {
            // Only replace replay already included in the input budget. Warm
            // clean-break and empty-baseline seeds must not acquire history here.
            priorMessages = toAgentMessages(cold.replayMessages, runtime.model);
          }
        } catch {
          onEvent({ type: "runtime_warning", warning_kind: "continuity_pack_degraded", error_code: "unavailable", message: "Continuity evidence unavailable; canonical replay continues." });
        }
      }
      for (const message of [...evidence, ...priorMessages]) {
        await harness.appendMessage(message);
        runState.sessionBaselineCount += 1;
      }
    }
    // The harness persists each turn INLINE into the live session. To preserve
    // the legacy "a failed resumed turn does not corrupt the session" contract,
    // remember the leaf before the run so a failed resume can be rolled back to
    // the last good transcript via the session tree's moveTo primitive. Only a
    // TRUE resume needs this: a create-on-miss session is fresh, so a failure
    // drops it entirely via the fresh-run path (no leaf to roll back to).
    if (requestedSessionId && (!runState.createdOnMiss || runState.sessionEntry)) {
      try { runState.baselineLeafId = await runState.session!.getLeafId(); runState.hasBaselineLeaf = true; } catch { /* best-effort */ }
    }

    // One logical turn encompasses proactive/manual compaction and every prompt
    // operation, including reactive overflow re-prompts. Bind ownership only from
    // the protected descriptor; recovery opt-in alone never binds an owner.
    const recoveryIdentity = options.sessionRecovery;
    const hasHostIdentity = typeof recoveryIdentity?.runId === "string" && recoveryIdentity.runId.length > 0
      && recoveryIdentity.runId.length <= 512 && Number.isSafeInteger(recoveryIdentity.revision) && recoveryIdentity.revision >= 0;
    const descriptor = options.sessionTurn;
    await harness.beginTurn(descriptor?.turnId ?? (options.manualCompaction ? undefined : hasHostIdentity ? recoveryIdentity.runId : undefined),
      options.manualCompaction ? "synthetic" : descriptor?.kind ?? (hasHostIdentity ? "host" : "synthetic"), descriptor);

    if (options.manualCompaction === true) {
      // The same resolve/reopen/seed path as a turn, but without a user prompt,
      // tool execution, turn telemetry, or response generation. The guarded
      // driver alone may request a summary from the current provider.
      const policy = resolveLiveCompactionPolicy({
        harness, runtime, resolved, toolLimits: options.toolLimits,
        compaction: options.compaction,
        contextWindowOverride: options.compaction?.contextWindowOverride,
      });
      const transcriptTokens = await estimateSessionMessageTokens(runState.session);
      // A prefix smaller than the retained recent tail cannot yield a useful
      // cut. Avoid spending a summary call merely to discover this afterward.
      const tooSmall = transcriptTokens !== null && transcriptTokens < policy.keepRecentTokens;
      // Host cancellation (e.g. shutdown) aborts the in-flight summary operation.
      if (options.abortSignal) {
        const abortManual = () => { void harness!.abort().catch(() => {}); };
        options.abortSignal.addEventListener("abort", abortManual, { once: true });
        runState.removeAbortHandler = () => options.abortSignal!.removeEventListener?.("abort", abortManual);
        if (options.abortSignal.aborted) throw new Error("Manual compaction was cancelled.");
      }
      let terminal: { status: string; operationId: string; reason?: string; tokensBefore?: number; tokensAfter?: number; tokenCountsExact?: boolean } | undefined = tooSmall
        ? { status: "skipped", operationId: randomUUID(), reason: "nothing_to_compact" }
        : undefined;
      const attempt = tooSmall ? undefined : await tryCompact(harness, {
        trigger: "manual",
        onEvent: (event: any) => {
          // Observe only this attempt, never infer native success from a UI
          // "skipped" event (the guarded driver may have declined the cut).
          if (event?.type === "context_compaction" && event.trigger === "manual" && event.status !== "running") terminal = event;
          onEvent(event);
        },
        runtimeWarnings,
        onCompactionRecorded: options.onCompactionRecorded,
        continuityRecording: options.continuityRecording,
        runId: options.runId,
        model: reference,
        session: runState.session,
        policy,
      });
      if (!terminal || !["succeeded", "skipped"].includes(terminal.status) || options.abortSignal?.aborted
        || (terminal.status === "succeeded" && attempt?.applied !== true)) {
        throw new Error("Manual compaction failed or was cancelled.");
      }
      // compact() closes a declined operation as failed, even for a benign
      // no-op. Preserve the public skipped result, but seal native evidence
      // consistently. Only the preflight no-op has no operation to close.
      await harness.endTurn(tooSmall || attempt?.applied === true ? "completed" : "failed",
        { text: "", error: null, failureKind: null, cancelled: false, stopReason: "compaction" });
      await commitSession(runState, {
        options,
        requestedSessionId,
        providerSessionId,
        durableRepo,
        sessionTtlMs,
        externalAbort: false,
        errorMessage: null,
        onEvent,
      });
      return {
        manualCompaction: {
          status: terminal.status,
          operationId: terminal.operationId,
          ...(terminal.reason ? { reason: terminal.reason } : {}),
          ...(terminal.tokensBefore === undefined ? {} : { tokensBefore: terminal.tokensBefore }),
          ...(terminal.tokensAfter === undefined ? {} : { tokensAfter: terminal.tokensAfter }),
          tokenCountsExact: terminal.tokenCountsExact === true,
        },
        providerSessionId,
      };
    }

    activateTurnHarness(runState, {
      harness,
      onEvent,
      options,
      toolLimits,
      sdk: "pi",
      reference,
      runtimeWarnings,
    });

    // Re-check abort right before issuing the provider request. The abort
    // handler is only installed at ~:639, AFTER a long stretch of awaited setup
    // (reopen, create, MCP init, buildContext, appendMessage, getLeafId). If
    // abort fired DURING any of those awaits the listener was not yet attached,
    // so the event was dropped and no run is active for harness.abort() to
    // target. Without this re-check a full provider/LLM request would be issued
    // for a run the caller already aborted (mirrors the entry pre-check at ~:356).
    if (options.abortSignal?.aborted) {
      // Drop a freshly-created non-keep-alive session (and any create-on-miss
      // reservation) so an aborted-before-run turn does not leave an orphan
      // jsonl / leaked busy placeholder. discardUncommittedSession guards
      // `session && !sessionEntry` so a resumed (user-owned) session is NEVER
      // deleted; the finally clears sessionEntry.busy, removes the abort handler,
      // and closes MCP clients. For a resume no transcript was appended yet
      // (prompt never ran), so the live session needs no rollback.
      await harness.endTurn("aborted", { text: null, error: null, failureKind: null, cancelled: true, stopReason: "aborted_before_prompt" });
      await discardUncommittedSession(runState, { durableRepo });
      return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId, piTransport });
    }

    // Compaction policy against the LIVE model's context window, then proactive
    // compaction: if the session is already near the window, compact BEFORE
    // issuing the request so a long-lived session never overflows.
    runState.compaction.policy = resolveLiveCompactionPolicy({
      harness,
      runtime,
      resolved,
      toolLimits: options.toolLimits,
      compaction: options.compaction,
      contextWindowOverride: options.compaction?.contextWindowOverride,
    });
    if (!options.nativeSessionProjection?.dispatchBudget) await runProactiveCompaction(runState, {
      harness,
      systemPrompt,
      options: control ? { ...options, outputSchema: undefined } : options,
      tools,
      promptText,
      promptImages,
      reference,
      onEvent,
      runtimeWarnings,
    });

    // Mid-run compaction: the proactive check above fires at most once, before
    // the request. Inside one long prompt the transcript keeps growing, so arm
    // Pi's own checkpoint compaction for the lifetime of this prompt with the
    // bridge's guarded session_before_compact decision installed. Pi captures
    // the lane's compaction settings into the operation at accept time, so this
    // must happen BEFORE harness.prompt(); the same-operation compaction never
    // starts a second run and so cannot disturb the live-input epoch below.
    midRunCompaction = options.nativeSessionProjection?.dispatchBudget ? { disarm: async () => {} } : await armMidRunCompaction(runState, {
      harness,
      options,
      reference,
      onEvent,
      runtimeWarnings,
    });

    // Arm the main-prompt epoch after proactive compaction so compaction and
    // transcript seeding cannot be mistaken for live-input consumption.
    runState.recoveryBaselineTipId = await runState.session!.getLeafId();

    // Last abort check before Pi admits the prompt. Proactive compaction,
    // mid-run arming and getLeafId all await after the pre-request check above;
    // an abort landing there finds no open Pi operation, so the handler's
    // harness.abort() is a no-op and the provider request would still run.
    // Everything from here to lane.accept is synchronous, and an abort during
    // accept is ordered after it, so Pi cancels the admitted operation itself.
    // The finally below disarms mid-run compaction.
    if (options.abortSignal?.aborted) {
      await harness.endTurn("aborted", { text: null, error: null, failureKind: null, cancelled: true, stopReason: "aborted_before_prompt" });
      await discardUncommittedSession(runState, { durableRepo });
      return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId, piTransport });
    }

    const liveInputEpoch = createLiveInputPromptEpoch({ harness, onEvent });
    runState.silentTurn.liveInputRefusalReason = liveInputEpoch.silenceRefusalReason;
    const liveInput = startLiveInput({ harness, options, onEvent, promptEpoch: liveInputEpoch, dispatchProgress });

    onEvent({ type: "provider_execution_config", sdk: "pi", model: reference,
      ...(options.effort ? { effort: options.effort } : {}), timestamp: Date.now() });

    onEvent({
      type: "provider_request_started",
      sdk: "pi",
      model: reference,
      runtime: "pi",
      timestamp: Date.now(),
    });

    let runError;
    try {
      // Own the operation at admission so steers consumed mid-run settle as
      // applied immediately; finish() re-checks the settled id at the end.
      const promptResult = await runHarnessPrompt(harness, promptText, promptImages, {
        onOperationAdmitted: (operationId) => {
          runState.recoveryOperationId = operationId;
          liveInputEpoch.confirm(operationId);
        },
      });
      if (promptResult.suspended) {
        await settleNativeSession(runState as Parameters<typeof settleNativeSession>[0], { action: "sync" });
        throw new NativeSuspendedError();
      }
      runError = promptResult.runError;
      liveInputEpoch.finish(promptResult.operationId);
    } finally {
      // Stop joins unresolved native enqueue and reconciles every returned
      // entry before the exact-operation subscription is removed. Mid-run
      // compaction is disarmed last so a compaction settled during teardown is
      // still accounted for, and so the harness returns to its
      // compaction-disabled default before any later prompt on this run.
      try {
        try { await liveInput.stop(); } finally {
          runState.recoveryInputIds = liveInputEpoch.consumedInputIds();
          liveInputEpoch.close();
        }
      } finally {
        await midRunCompaction.disarm();
      }
    }


    runState.externalAbort ||= !!options.abortSignal?.aborted;

    const captureState = async (): Promise<PiTranscript> => {
      const context = await runState.session!.buildContext();
      const transcript = context.messages || [];
      const runTranscript = transcript.slice(runState.sessionBaselineCount);
      const assistantMessages = runTranscript.filter((message: any) => message?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      return {
        transcript,
        runTranscript,
        assistantMessages,
        lastAssistant,
        stopReason: lastAssistant?.stopReason || null,
        finalText: finalReplyText(assistantMessages, runState.assistantTexts),
        finalThinking: thinkingFromContent(lastAssistant?.content) || runState.assistantThinking.join(""),
      };
    };

    let state = await captureState();
    const initialRunFailed = !!runError || state.stopReason === "error" || state.stopReason === "aborted";

    // Structured-output finalization retry: if the turn ended with neither
    // text nor a StructuredOutput call, re-prompt ONCE in the same session with
    // only StructuredOutput active so the model can submit the required result.
    // This replicates the legacy bridge's single re-prompt via the harness's
    // prompt + setActiveTools instead of the low-level agent.continue() loop.
    if (!runError && shouldRetryStructuredOutputFinalization({
      outputSchema: options.outputSchema,
      structuredResult: runState.structuredResult,
      finalText: state.finalText,
      stopReason: state.stopReason,
      externalAbort: runState.externalAbort,
      maxTurnsHit: runState.maxTurnsHit,
    })) {
      const retry = await runStructuredOutputFinalizationRetry({ harness, structuredTool, runtimeWarnings, prompts: options.prompts } as Parameters<typeof runStructuredOutputFinalizationRetry>[0]);
      structuredOutputFinalizationRetryAttempts = retry.attempts;
      structuredOutputFinalizationRetryReason = retry.reason;
      structuredOutputFinalizationRetryFailed = runState.structuredResult === null || runState.structuredResult === undefined;
      state = await captureState();
    }

    // Reactive recovery: if the turn ended in a context overflow and we have not
    // already compacted-and-retried this run, compact once and re-prompt once
    // (and re-capture state). Learns the real window ceiling from the error.
    if (!options.nativeSessionProjection?.dispatchBudget) ({ state, runError } = await runReactiveCompaction(runState, {
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
    }));

    // Plain-text finalization is separate from structured-output and continuity
    // recovery. Never turn an error/abort, terminal tool, or pending question
    // into another model request. This block executes at most once per run.
    if (!initialRunFailed && shouldRetryEmptyReply({
      finalText: state.finalText, stopReason: state.stopReason,
      outputSchema: options.outputSchema, runError,
      externalAbort: runState.externalAbort || !!options.abortSignal?.aborted,
      maxTurnsHit: runState.maxTurnsHit,
      silent: canCertifySilentTurn(runState.silentTurn, options.finishSilentlyController, {
        finalText: state.finalText, failed: !!runError,
        aborted: runState.externalAbort || !!options.abortSignal?.aborted,
      }),
      invalidatedSilentCompletion: runState.silentTurn.completed,
      pendingQuestion: runState.silentTurn.pendingQuestion,
    })) {
      const retry = await runEmptyReplyRetry({ harness, runtimeWarnings, abortSignal: options.abortSignal, prompts: options.prompts } as Parameters<typeof runEmptyReplyRetry>[0]);
      if (retry.error) runError = retry.error;
      runState.externalAbort ||= !!options.abortSignal?.aborted;
      state = await captureState();
      if (retry.attempted) runtimeWarnings.push({
        warning_kind: "empty_reply_retry", source: "pi", attempt: 1,
        reason: "empty_final_output",
        outcome: runState.externalAbort ? "cancelled"
          : runError || state.stopReason === "error" || state.stopReason === "aborted" ? "failed"
          : state.finalText.trim() ? "text" : "empty",
        message: "Pi same-session reply finalization settled.",
      });
    }

    const { runTranscript, lastAssistant, stopReason, finalText, finalThinking } = state;
    const runAssistantCount = state.assistantMessages.length;

    // Run-owned usage survives a mid-run compaction: the compaction collapses
    // part of this run's own transcript into a summary, so the usage of the
    // messages it removed is carried forward (and the baseline re-anchored) by
    // the mid-run controller instead of being silently lost here.
    const ownUsage = usageFromMessages(runTranscript, runState.compaction.carriedUsage);
    // Priced from this agent's own tokens: it is the fallback for a run the
    // provider did not price, and only these tokens are this model's.
    const estimatedCost = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: ownUsage.input,
      outputTokens: ownUsage.output,
      cachedTokens: ownUsage.cacheRead,
      cacheWriteTokens: ownUsage.cacheWrite,
    });
    // Keyed by the same parentRunId the Agent tool stamps its budget under, the
    // way `subagentInvoked` below reads its count.
    const usage = withSubagentUsage(
      ownUsage,
      subagentUsageForRun(options.subagents, options.toolContext?.runId),
      estimatedCost,
    );
    emitUsageCostEvents({
      onEvent,
      reference,
      usage,
      estimatedCost,
      start,
      externalAbort: runState.externalAbort,
    });

    const rawErrorMessage = runState.externalAbort
      ? null
      : runState.maxTurnsHit
        ? "Pi agent stopped before final output: max turns reached"
        : (stopReason === "error" || stopReason === "aborted"
          ? lastAssistant?.errorMessage || runError?.message || "Pi agent aborted before final output"
          : (runError ? runError.message || String(runError) : null));
    // pi-agent-core stores `error.message` on the failure assistant message and
    // discards the cause, so `runError` is usually the only object still
    // carrying one. When neither has a cause, fall back to the correlated
    // transport probe rather than surfacing a bare "terminated".
    const annotatedError = annotateProviderErrorMessage(
      normalizePiErrorMessage(rawErrorMessage),
      runError,
    );
    // A request that failed again after mid-stream retries names its attempt
    // count; the provider text (and thus its classification) stays first.
    const requestAttempts = stopReason === "error" ? runState.requestRetry.failedAttempts : null;
    const errorMessage = annotatedError.message && requestAttempts && !runState.requestRetry.outage
      ? `${annotatedError.message} (failed after ${requestAttempts} provider request attempts)`
      : annotatedError.message;

    const structuredRetry = {
      attempts: structuredOutputFinalizationRetryAttempts,
      reason: structuredOutputFinalizationRetryReason,
      failed: structuredOutputFinalizationRetryFailed,
    };
    const diagnostics = buildDiagnostics({
      providerSessionId,
      stopReason,
      maxTurnsHit: runState.maxTurnsHit,
      maxTurns: options.maxTurns,
      turnCount: runState.turnCount,
      runAssistantCount,
      externalAbort: runState.externalAbort,
      maxRetries,
      piTransport,
      lastToolName: runState.lastToolName,
      structuredRetry,
      contextCompactionDiagnostics: runState.compaction.diagnostics,
      transportErrorCode: annotatedError.causeCode,
      transportErrorSource: annotatedError.causeSource,
      requestRetries: runState.requestRetry.retries,
    });
    const errorDetails = buildErrorDetails({
      errorMessage,
      stopReason,
      lastToolName: runState.lastToolName,
      toolResultsSeen: runState.toolResultsSeen,
      turnCount: runState.turnCount,
      runAssistantCount,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      structuredRetry,
      contextCompactionDiagnostics: runState.compaction.diagnostics,
    });

    const capabilitiesUsed = buildCapabilitiesUsed({
      promptCacheActive: usage.cacheRead > 0 || usage.cacheWrite > 0,
      thinkingEnabled: effectiveThinkingLevel !== "off" && effectiveThinkingLevel !== "low",
      structuredOutputEnforced: !!options.outputSchema,
      // What actually happened, not what was configured. This used to be a
      // hardcoded `false`, which reported "no subagent ran" for runs that had
      // just spawned several — the one signal that would have shown delegation
      // working said it never happened.
      //
      // The count is keyed by the same parentRunId the Agent tool stamps its
      // budget under (turn-runner threads `runCtx?.runId`); `runId` survives the
      // sandbox-branch spread there, so reading it off the tool context directly
      // yields the same key.
      subagentInvoked: subagentInvocationCount(
        options.subagents,
        options.toolContext?.runId,
      ) > 0,
      mcpServersUsed: mcpClients.map((entry) => entry?.name).filter(Boolean),
      // Empty by contract, not by omission: "native" means provider-native
      // subagents (Claude's Task tool). mono-agent's `Agent` is its own, so pi
      // has none — `subagent_invoked` above is where pi delegation is reported.
      nativeSubagentsUsed: [],
      toolCompactionApplied: toolCompactionAppliedFromWarnings(runtimeWarnings),
      // Tristate: true = a compaction fired this run (proactive or reactive),
      // false = the path is enabled but did not need to fire, null = disabled via
      // runtime.compaction.enabled. See docs/reference/feature-registry.md runtime.context-compaction.
      contextCompactionApplied: runState.compaction.policy?.enabled ? runState.compaction.applied : null,
    });
    emitCapabilitiesResolved(onEvent, { sdk: "pi", model: reference, capabilitiesUsed });

    // Re-check the abort signal: a cancel can land during the post-run work above
    // (live-input teardown, structured-output finalization retry) after the line
    // ~780 check. Pick it up here so the lifecycle decision below rolls back the
    // cancelled turn instead of committing it into a durable transcript a later
    // resume would replay.
    runState.externalAbort ||= !!options.abortSignal?.aborted;

    // Session lifecycle parity with the legacy bridge. The harness already
    // durably persisted the transcript into its session object (in-memory for
    // the default repo, jsonl on disk when sessionsRoot is set); commitSession
    // tracks LIVENESS so disposeProviderSession / idle-TTL eviction can reach
    // native sessions, keep-alive registers the session, and a failed/aborted
    // resumed turn rolls back to its pre-turn leaf.
    runState.retainRecoveryTail = !runState.preserveTurnEvidence && !!durableRepo && options.sessionKeepAlive === true
      && !runState.maxTurnsHit
      && (!errorMessage || failureKindForPiError(errorMessage, diagnostics) === "provider_unavailable")
      && typeof options.sessionRecovery?.runId === "string" && options.sessionRecovery.runId.length > 0
      && options.sessionRecovery.runId.length <= 512
      && Number.isSafeInteger(options.sessionRecovery?.revision) && options.sessionRecovery.revision >= 0
      && typeof runState.recoveryOperationId === "string";
    const certifySilence = () => canCertifySilentTurn(runState.silentTurn, options.finishSilentlyController, {
      finalText, failed: !!errorMessage, aborted: runState.externalAbort,
    });
    const silentAtSeal = runState.preserveTurnEvidence && certifySilence();
    const buildFinalResult = () => buildSuccessResult({
      finalText,
      finalThinking,
      events,
      usage,
      estimatedCost,
      start,
      turnCount: runState.turnCount,
      runAssistantCount,
      resolved,
      options,
      externalAbort: runState.externalAbort,
      errorMessage,
      errorDetails,
      diagnostics,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      runtimeWarnings,
      capabilitiesUsed,
      usageMeasured: hasMeasuredUsage(runTranscript) || runState.compaction.carriedUsageMeasured === true,
      structuredResult: runState.structuredResult,
      effectiveEffort: harness!.getEffectiveEffort?.(),
    });
    const finalResult = buildFinalResult();
    await harness.endTurn(runState.externalAbort ? "aborted" : finalResult.error || finalResult.failureKind ? "failed" : "completed", {
      text: finalResult.text, error: finalResult.error ?? null, failureKind: finalResult.failureKind ?? null,
      cancelled: finalResult.cancelled === true, stopReason: diagnostics.pi_stop_reason ?? null,
      ...(silentAtSeal ? { turnDisposition: "silent" } : {}),
    });
    await commitSession(runState, {
      options,
      requestedSessionId,
      providerSessionId,
      durableRepo,
      sessionTtlMs,
      externalAbort: runState.externalAbort,
      errorMessage,
      onEvent,
    });

    // Uncoordinated calls keep their final rollback guard. Coordinated calls
    // retain the tail and close it before granting a recovery receipt; recheck
    // cancellation after that await as well.
    if (!runState.externalAbort && options.abortSignal?.aborted) {
      runState.externalAbort = true;
      if (!runState.retainRecoveryTail) await rollbackAbortedTurn(runState, { requestedSessionId, providerSessionId, durableRepo });
    }

    // A receipt is proof of a successfully closed native operation, never a
    // promise that the finally block will eventually close it.
    const providerSessionRecovery = runState.retainRecoveryTail
      ? await captureSessionRecovery(runState, { options, providerSessionId, modelKey: `${resolved.provider}:${resolved.model}`, model: runtime.model, pending: !!errorMessage || runState.externalAbort })
      : undefined;
    if (runState.retainRecoveryTail) runState.externalAbort ||= !!options.abortSignal?.aborted;
    const silentCertified = runState.preserveTurnEvidence ? silentAtSeal && !runState.externalAbort
      : certifySilence();
    return { ...(runState.preserveTurnEvidence ? finalResult : buildFinalResult()), cancelled: runState.externalAbort, ...(providerSessionRecovery ? { providerSessionRecovery } : {}),
    ...(silentCertified ? { turnDisposition: "silent" } : {}) };
  } catch (err: any) {
    runState.externalAbort ||= !!options.abortSignal?.aborted;
    // Drop a just-created fresh durable session, release a create-on-miss
    // reservation placeholder, and roll a resumed session back to its pre-turn
    // leaf for host/runtime-side throws that landed after the harness already
    // mutated the live session (guards preserved in cleanupSessionOnThrow).
    if (runState.preserveTurnEvidence) {
      try {
        if (err instanceof NativeSuspendedError) await settleNativeSession(runState as Parameters<typeof settleNativeSession>[0], { action: "repair-interrupted" });
        else await harness?.endTurn?.(runState.externalAbort ? "aborted" : "failed", {
          text: runState.assistantTexts.join("") || null, error: runState.externalAbort ? null : normalizePiErrorMessage(err?.message || String(err)),
          failureKind: runState.externalAbort ? null : isJournalStorageError(err) ? "safety_journal_storage_failed"
            : failureKindForPiError(normalizePiErrorMessage(err?.message || String(err)), {}, { maxTurnsHit: runState.maxTurnsHit }),
          cancelled: runState.externalAbort, stopReason: "error",
        });
      } catch (sealError) {
        if (isJournalStorageError(sealError)) err = sealError;
        // Unsealed evidence is preserved; storage uncertainty is always terminal.
      }
      try { await cleanupSessionOnThrow(runState, { durableRepo }); }
      catch (closeError) { if (isJournalStorageError(closeError)) err = closeError; }
    } else if (err instanceof NativeSuspendedError) {
      // Fresh suspension keeps disposal/reopen ownership without completion.
      // A resumed suspension has no host receipt: use failed-turn rollback,
      // not a retained recovery tail or deferred continuation.
      try {
        if (runState.sessionEntry) {
          // A resumed suspension is a failed unreceipted host turn: seal it
          // without projecting completion, then let normal commit roll back.
          await settleNativeSession(runState as Parameters<typeof settleNativeSession>[0], { action: "fail-suspended" });
        }
        await commitSession(runState, { options, requestedSessionId, providerSessionId, durableRepo, sessionTtlMs,
          externalAbort: false, errorMessage: runState.sessionEntry ? "Native provider suspended without a recovery receipt" : undefined, onEvent });

      } catch (cleanupError) {
        err = cleanupError;
        await cleanupSessionOnThrow(runState, { durableRepo });
      }
    } else {
      try { await harness?.endTurn?.(runState.externalAbort ? "aborted" : "failed"); } catch { /* preserve original error; reopen repairs unsealed work */ }
      await cleanupSessionOnThrow(runState, { durableRepo });
    }
    // The throw path still holds the original Error, so its cause chain is the
    // authoritative source here — no correlation guesswork needed.
    const errorMessage = annotateProviderErrorMessage(
      normalizePiErrorMessage(err?.message || String(err)),
      err,
    ).message;
    const isRetryable = retryableProviderFailureInfo({
      errorText: errorMessage,
      failureKind: "provider_unavailable",
    }).retryable;
    const failure = buildErrorResult({
      assistantTexts: runState.assistantTexts,
      events,
      start,
      turnCount: runState.turnCount,
      resolved,
      options,
      externalAbort: runState.externalAbort,
      errorMessage,
      lastToolName: runState.lastToolName,
      toolResultsSeen: runState.toolResultsSeen,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      runtimeWarnings,
      isRetryable,
      piTransport,
      effectiveEffort: harness?.getEffectiveEffort?.(),
    });
    if (err?.code === "ERR_NATIVE_SESSION_AUTHORITY" || err?.code === "ERR_HANDOFF_DISPATCH_BUDGET") {
      return { ...failure, failureKind: err.code === "ERR_NATIVE_SESSION_AUTHORITY" ? "safety_native_session_authority" : "safety_handoff_dispatch_budget",
        retryable: false, providerSessionRecovery: undefined };
    }
    if (err?.code === "ERR_SESSIONS_ROOT_UNSUPPORTED") {
      return { ...failure, failureKind: "safety_sessions_root_unsupported", retryable: false, providerSessionRecovery: undefined };
    }
    if (isJournalStorageError(err)) {
      return { ...failure, failureKind: "safety_journal_storage_failed", retryable: false, providerSessionRecovery: undefined,
        ...(runState.preserveTurnEvidence ? { providerSessionId: undefined } : {}) };
    }
    return err instanceof NativeSuspendedError
      ? { ...failure, failureKind: "safety_native_suspended", retryable: false, providerSessionRecovery: undefined } : failure;
  } finally {
    // Safety net for a throw between arming and the prompt: disarm is
    // idempotent, and it must run before the harness closes so the session's
    // compaction settings are restored while they still can be.
    try { await midRunCompaction?.disarm(); } catch { /* best-effort */ }
    try { await harness?.close?.(); } catch { /* best-effort */ }
    if (runState.sessionEntry) runState.sessionEntry.busy = false;
    if (runState.registeredSessionEntry) runState.registeredSessionEntry.busy = false;
    runState.removeAbortHandler?.();
    try {
      await closeRunTools();
    } finally {
      await closePiMcpClients(mcpClients);
    }
  }
}

export const engineTurnAdapter = {
  id: "pi",
  kind: "pi",
  capabilities: runtimeCapabilities(),
  supports: (ref: any) => Boolean(ref?.provider && ref?.model),
  execute: generateEngineTurnResponse,
  prepareNativeDispatch: preparePiNativeDispatch,
};
