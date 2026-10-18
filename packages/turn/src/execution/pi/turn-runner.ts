import type { Models } from "@earendil-works/pi-ai";
import type { RuntimeDispatchProgress } from "../../contracts/runtime.js";
import type { RuntimeLiveInputMessage } from "../../contracts/live-input.js";
import type { PiRunState, PiOptions, PiToolParams, PiSession, PiModel, PiTool, PiEventSink, PiToolLimits, PiWarning, PiPromptEpoch, PiMcpClient } from "./types.js";
type Harness = Awaited<ReturnType<typeof createHarnessAdapter>>;
import { assertNativeSessionAccess } from "../../engine/session-authority.js";
// @ts-check
// Turn execution for the pi-native bridge.
//
// Pure moves out of execution/pi/run.js: effort→thinkingLevel mapping, harness
// construction + stream-subscriber wiring + abort wiring, the live-input
// steering consumer, and the prompt/waitForIdle run. No module-level mutable
// state; run state (harness, removeAbortHandler, externalAbort) lives on the
// caller-owned runState.

import { createStructuredOutputTool, getPiBuiltinTools } from "../../tools/pi-tools.js";
import { initPiMcpTools, closePiMcpClients } from "../../tools/mcp/tools.js";
import { createNodeReplController } from "../../tools/commands/node-repl.js";
import { createWebToolController } from "../../tools/web/web-controller.js";
import { formatLiveInputGuidance } from "../../runtime/live-input-prompt.js";
import { createHarnessAdapter } from "./driver-adapter.js";
import { requestRetryPolicy } from "./request-retry.js";
import { appendStructuredOutputInstruction } from "./structured-output.js";
import { createStreamSubscriber } from "./events.js";

/**
 * Build the turn's tool set: the sandboxed/allowlisted/bloat-guarded builtin
 * tools, the MCP tool bridge, and the StructuredOutput tool (whose callback
 * writes runState.structuredResult). Surfaces MCP init/list failures to both the
 * event stream and runtimeWarnings. Returns the assembled tools plus the MCP
 * clients (closed by the caller's finally), run-owned tool cleanup, and the
 * structured tool.
 * @param {any} runState
 * @param {any} params
 * @returns {Promise<{tools: any[], structuredTool: any, mcpClients: any[], closeRunTools: () => Promise<void>}>}
 */
export function buildTurnTools(runState: any, { options, capabilities, toolLimits, approvalManager, runtime, resolved, onEvent, runtimeWarnings, toolExecutionMode, }: any): Promise<{
    tools: any[];
    structuredTool: any;
    mcpClients: any[];
    closeRunTools: () => Promise<void>;
}>;
export async function buildTurnTools(runState: PiRunState, {
  options,
  capabilities,
  toolLimits,
  approvalManager,
  runtime,
  resolved,
  onEvent,
  runtimeWarnings,
  toolExecutionMode = "safe-parallel",
}: PiToolParams) {
  const onTruncate = (info: any) => {
    try {
      onEvent({
        type: "runtime_warning",
        warning_kind: "tool_payload_truncated",
        source: "tool_bloat_guard",
        ...info,
      });
    } catch { /* best-effort */ }
  };
  const persistArtifact = options.persistArtifact || null;
  const qaOutputDir = options.qaOutputDir || options.runArtifactDir || null;

  // Per-run sandbox override (item 7): precedence run impl > host impl >
  // passthrough. When the run supplies its own RuntimeSandbox, thread a ctx copy
  // whose `.sandbox` is that impl so this run's tools/MCP-stdio launcher enforce
  // through it; otherwise the host/default ToolContext is used unchanged. The
  // per-run policy DATA (sandboxPolicy) still merges monotonically inside
  // resolveSandboxPolicy (I13) regardless of which impl is chosen.
  //
  // The run-bound artifact sink rides on the same copy: the per-tool output
  // caps (capChars / formatSearchLines) spill their full text through
  // `ctx.persistArtifact`, which is the only sink a configured app provides
  // (`toolArtifactDir` is never set there). A snapshot is safe because the
  // router projects configureTools before each attempt, never mid-run.
  const runCtx = options.sandbox || persistArtifact
    ? {
      ...options.toolContext,
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(persistArtifact ? { persistArtifact } : {}),
    }
    : options.toolContext;
  const sandboxEngine = options.sandboxEngine ?? runCtx?.sandboxEngine;
  const nodeReplController = capabilities.tool_use === false
    ? null
    : createNodeReplController({
      cwd: options.cwd,
      maxOutputChars: toolLimits.bashOutputLimitChars || toolLimits.toolTextLimitChars,
      sandboxPolicy: options.sandboxPolicy,
      sandboxEngine,
      ctx: runCtx,
    } as Parameters<typeof createNodeReplController>[0]);
  const webController = capabilities.tool_use === false
    ? null
    : createWebToolController({
      searchConfig: options.webSearchConfig,
      searchState: options.webSearchState,
      coordinator: options.webRequestCoordinator,
      fetchConfig: options.webFetchConfig,
      sandboxPolicy: options.sandboxPolicy,
      sandboxEngine,
      ctx: runCtx,
    });

  // REUSED custom pieces: built-in tool sandboxing + allowlist/bloat filter +
  // approval gates. These are identical to the legacy bridge.
  // Cast: pi-tools' tool-builder option bags are not precisely typed (their
  // no-default destructured keys drop out of structural inference), so the
  // caller's full bag is passed through an `any` boundary — matching how the
  // pre-split (non-@ts-check) orchestrator called these.
  let pendingMcpClients: PiMcpClient[] = [];
  try {
    const builtIns = capabilities.tool_use === false
      ? []
      : getPiBuiltinTools(options.allowedTools, /** @type {any} */ (({
        // deny-wins filter applied over the built-ins + ReadSkill inside pi-tools.
        disallowedTools: options.disallowedTools,
        skillNames: (options.skills || []).map((/** @type {{name: string}} */ skill) => skill.name),
        // Full skill objects so ReadSkill can honor pi's neutral Skill shape
        // ({name, filePath, ...}) and derive each skill's root from its own
        // filePath when no shared skillsRoot is threaded.
        skills: options.skills || [],
        // Progressive skill disclosure: when the harness threads the skills root
        // (the directory holding `<name>/SKILL.md`) the ReadSkill tool resolves
        // bodies directly from there. `dataDir` (skills under `<dataDir>/skills`)
        // remains the back-compat fallback; a per-skill filePath is the third path.
        skillsRoot: options.skillsRoot,
        dataDir: options.dataDir,
        cwd: options.cwd,
        onEvent,
        persistArtifact,
        onTruncate,
        toolLimits,
        toolPayloadMaxBytes: toolLimits.toolPayloadMaxBytes,
        imageInlineMaxBytes: toolLimits.imageInlineMaxBytes,
        toolPolicy: options.toolPolicy,
        sandboxPolicy: options.sandboxPolicy,
        sandboxEngine,
        approvalManager,
        approvalModel: runtime.model?.id || runtime.model?.name || resolved.model,
        nodeReplController,
        webController,
        processJobsController: options.processJobs,
        ownedForegroundProcessController: options.ownedForegroundProcesses?.forAttempt(),
        processJobsAvailability: options.processJobsAvailability,
        toolExecutionMode,
        subagents: options.subagents,
        askParentController: options.askParentController,
        finishSilentlyController: options.finishSilentlyController,
        silentTurnState: runState.silentTurn,
    onEffectiveEffort: options.onEffectiveEffort,
        toolExposure: options.toolExposure,
        // The child inherits the parent's route and workspace unless its profile
        // pins a model; the tool closure reads these to build each child request.
        subagentContext: {
          model: options.model,
          effort: options.effort,
          cwd: options.cwd,
          parentRunId: runCtx?.runId,
          // Same policy + engine this turn's own tools are confined by, so a
          // child is never less sandboxed than the parent that spawned it.
          sandboxPolicy: options.sandboxPolicy,
          sandboxEngine,
          // The same skills this turn was disclosed. A child runs OUTSIDE the
          // harness, so without this it gets no index and — because ReadSkill is
          // only built when `skills` is non-empty — no way to read one either. It
          // then rediscovers by trial and error whatever its parent could simply
          // have looked up. Pass-through only: whether the child actually receives
          // them is the host's decision, not this layer's.
          skills: options.skills,
          skillsRoot: options.skillsRoot,
          toolEnvironment: options.toolEnvironment,
          webSearchConfig: options.webSearchConfig,
          webRequestCoordinator: options.webRequestCoordinator,
          webFetchConfig: options.webFetchConfig,
        },
        ctx: runCtx,
      }) as any));

    const structuredTool = createStructuredOutputTool(options.outputSchema, (value: unknown) => {
      runState.structuredResult = value;
    });
    const reservedNames = new Set(builtIns.map((/** @type {{name: string}} */ toolDef) => toolDef.name));
    if (structuredTool) reservedNames.add(structuredTool.name);

    // REUSED MCP tool bridge: same initPiMcpTools sandboxing path (see the cast
    // note above — the option bag crosses the same untyped tool-builder boundary).
    const mcpInit = capabilities.tool_use === false
      ? { clients: [], tools: [], warnings: [] }
      : await initPiMcpTools(options.mcpServers || {}, reservedNames, /** @type {any} */ (({
        cwd: options.cwd,
        persistArtifact,
        qaOutputDir,
        onTruncate,
        limits: toolLimits,
        mcpCallNoTotalTimeoutTools: options.mcpCallNoTotalTimeoutTools,
        toolPayloadMaxBytes: toolLimits.toolPayloadMaxBytes,
        sandboxPolicy: options.sandboxPolicy,
        sandboxEngine,
        ctx: runCtx,
        mcpApps: options.mcpApps,
        onRichOutput: () => { runState.silentTurn.visibleContent = true; },
        runId: runCtx?.runId,
      }) as any));
    // Surface MCP init/list failures BOTH to the live event stream and to runtimeWarnings, so a
    // failed server (e.g. an stdio adapter-send child that closed on startup) lands in the run
    // summary's runtimeWarnings instead of being buried as a transient event the summary drops.
    pendingMcpClients = mcpInit.clients;
    for (const warning of mcpInit.warnings || []) {
      onEvent(warning);
      runtimeWarnings.push(warning);
    }

    const tools = [
      ...builtIns,
      ...mcpInit.tools.map((tool) => ({ ...tool, executionMode: "sequential" })),
      ...(structuredTool ? [structuredTool] : []),
    ];
    return {
      tools,
      structuredTool,
      mcpClients: mcpInit.clients,
      closeRunTools: async () => {
        await Promise.allSettled([
          nodeReplController?.close(),
          webController?.close(),
        ].filter(Boolean));
      },
    };
  } catch (error) {
    await Promise.allSettled([nodeReplController?.close(), webController?.close(), closePiMcpClients(pendingMcpClients)].filter(Boolean));
    throw error;
  }
}

/**
 * Map an effort level to the harness thinkingLevel, respecting model reasoning
 * capability (no reasoning / reasoning_mode "none" → "off").
 * @param {string} effort
 * @param {any} capabilities
 * @returns {string}
 */
export function thinkingLevelForEffort(effort: string, capabilities: any): string {
  if (!capabilities?.reasoning || capabilities.reasoning_mode === "none") return "off";
  if (effort === "none") return "off";
  // Pi <0.80.6 and older/custom model metadata do not advertise native max.
  // Preserve the historical xhigh ceiling for those models, but pass max
  // through when the resolved model explicitly declares it.
  if (effort === "max") {
    return Array.isArray(capabilities.reasoning_levels)
      && capabilities.reasoning_levels.includes("max")
      ? "max"
      : "xhigh";
  }
  if (effort === "xhigh") return "xhigh";
  if (effort === "high") return "high";
  if (effort === "medium") return "medium";
  if (effort === "minimal") return "minimal";
  return "low";
}

/**
 * Construct the engine adapter for this turn, subscribe the stream-subscriber, and
 * wire the external abort handler. Sets runState.harness and
 * runState.removeAbortHandler; the abort handler sets runState.externalAbort and
 * aborts the harness. Returns the harness.
 * @param {any} runState
 * @param {any} params
 * @returns {any}
 */
/**
 * Restore the error flag on a tool result pi resolved successfully.
 *
 * pi hardcodes `isError: false` for every `execute()` that returns rather than
 * throws, so any tool that reports failure in its payload needs this hook or
 * the model is told the call succeeded.
 *
 * @param {*} details Tool-result details recorded by the bridge.
 * @returns {{isError: true}|undefined}
 */
export function toolResultErrorOverride(details: any): {
    isError: true;
} | undefined {
  const subagentStatus = details?.subagent?.status;
  const failed = details?.mcp_result_is_error === true
    || details?.outcome?.status === "error"
    // A failed subagent returns its answer-plus-log instead of throwing,
    // precisely so a failed delegation keeps its activity log.
    || (typeof subagentStatus === "string" && !["ok", "awaiting_reply"].includes(subagentStatus));
  return failed ? { isError: true } : undefined;
}

export function buildTurnHarness(runState: any, { session, piModels, model, thinkingLevel, systemPrompt, outputSchema, tools, toolExecutionMode, transport, maxRetries, maxRetryDelayMs, steeringMode, options, }: {
    session: any;
    piModels: any;
    model: any;
    thinkingLevel: any;
    systemPrompt: any;
    outputSchema: any;
    tools: any;
    toolExecutionMode: any;
    transport: any;
    maxRetries: any;
    maxRetryDelayMs: any;
    steeringMode: any;
    options: any;
}): Promise<{
    models: any;
    getPromptCacheRequest: () => any;
    getModel: () => any;
    getThinkingLevel: () => any;
    getEffectiveEffort: () => any;
    getActiveTools: () => any;
    setActiveTools(names: any): Promise<void>;
    setCompactionSettings(settings: any): Promise<void>;
    setMidRunCompactionArmed(value: any): void;
    appendMessage: (message: any) => any;
    beginTurn: (id: any, source: any, descriptor: any) => Promise<void>;
    endTurn: (status: any, result: any) => Promise<void>;
    prompt(text: any, promptOptions: any): Promise<{
        tipId: any;
        deferred?: any;
        operationId: `${string}-${string}-${string}-${string}-${string}`;
        status: string;
        error: {
            code: string;
            message: any;
        };
    }>;
    steer: (message: any, identity: any) => Promise<`${string}-${string}-${string}-${string}-${string}`>;
    cancelQueued: (entryId: any) => Promise<any>;
    abort(): Promise<void>;
    waitForIdle: () => Promise<void>;
    compact: () => Promise<any>;
    on(type: any, handler: any): () => any;
    subscribe: (listener: any) => () => boolean;
    abortOpenOperations(): Promise<void>;
    repairOpenOperations(): Promise<void>;
    close(): Promise<void>;
}>;
export async function buildTurnHarness(runState: PiRunState, {
  session,
  piModels,
  model,
  thinkingLevel,
  systemPrompt,
  outputSchema,
  tools,
  toolExecutionMode,
  transport,
  maxRetries,
  maxRetryDelayMs,
  steeringMode,
  options,
}: { session: PiSession; piModels: Models; model: PiModel; thinkingLevel: string; systemPrompt: string; outputSchema: any; tools: PiTool[]; toolExecutionMode: string; transport: string; maxRetries: number; maxRetryDelayMs: number; steeringMode: string; options: PiOptions }) {
  const providerCheck = Number.isSafeInteger(options.providerCheckMaxTokens) && options.providerCheckMaxTokens! > 0;
  // Codex auto transport can resend via SSE even with a zero retry budget.
  const harness = await createHarnessAdapter(session, {
    session,
    models: piModels,
    model,
    thinkingLevel,
    systemPrompt: appendStructuredOutputInstruction(systemPrompt, outputSchema, options.prompts),
    tools,
    toolExecutionMode,
    silentTurnState: runState.silentTurn,
    onEffectiveEffort: options.onEffectiveEffort,
    streamOptions: { transport: providerCheck ? "sse" : transport, maxRetries: providerCheck ? 0 : maxRetries, maxRetryDelayMs,
      ...(model.api === "anthropic-messages" && options.cacheRetention !== undefined ? { cacheRetention: options.cacheRetention } : {}),
    },
    // Pi providers retry SDK-policy failures only before a response starts. The
    // driver re-issues only a transient failure after the response started; the
    // journaled partial keeps its usage and never reaches the retried context.
    retry: requestRetryPolicy({ maxRetries, maxRetryDelayMs, providerCheck }),
    steeringMode,
    followUpMode: steeringMode,
    assertSessionCurrent: options.nativeSessionAuthority ? () => assertNativeSessionAccess(options.nativeSessionAuthority, "open", options.sessionsRoot) : undefined,
    inheritedProjection: options.nativeSessionProjection?.inherited,
    inheritedProjectionRef: options.nativeSessionProjection?.artifact,
    handoffDispatchBudget: options.nativeSessionProjection?.dispatchBudget,
    promptCacheDiagnostics: options.promptCacheDiagnostics,
    cacheRetention: options.cacheRetention,
    onEvent: options.onEvent,
  });
  // MCP `CallToolResult.isError` is a successful protocol response, so pi's
  // execute() promise resolves. The bridge records that bit in result details;
  // this after-tool hook restores the error flag while preserving the already
  // bounded content/details verbatim. Downstream tool_execution_end and timing
  // events therefore report the failure accurately.
  //
  // A failed subagent is the same shape of problem: the `Agent` tool returns
  // its formatted answer-plus-activity-log rather than throwing, precisely so a
  // failed delegation keeps its log — but pi hardcodes `isError: false` for
  // every resolved execute(), so without this the model would be told a failed,
  // timed-out, or empty delegation succeeded.
  harness.on("tool_result", (event: any) => toolResultErrorOverride(event?.details));
  // Reconcile native evidence without executing a provider/tool or claiming a
  // successful receipt. Do this before subscription: repair is old evidence,
  // not output or spend from the next user turn. Deferred suspension is
  // accounted as suspended-not-resumed, never continued.
  try {
    await harness.repairOpenOperations();
  } catch (error) {
    try { await harness.close(); } catch { /* best-effort */ }
    throw error;
  }

  runState.harness = harness;

  return harness;
}

/**
 * Subscribe only after prior history has been seeded. Pi emits message
 * lifecycle events for manual appendMessage() calls; subscribing earlier makes
 * restored assistant messages look like fresh output boundaries.
 * @param {any} runState
 * @param {{harness: any, onEvent: (event: any) => void, options: any, toolLimits: any, sdk: string, reference: string, runtimeWarnings?: any[]}} deps
 */
export function activateTurnHarness(runState: any, { harness, onEvent, options, toolLimits, sdk, reference, runtimeWarnings, }: {
    harness: any;
    onEvent: (event: any) => void;
    options: any;
    toolLimits: any;
    sdk: string;
    reference: string;
    runtimeWarnings?: any[];
}): void;
export function activateTurnHarness(runState: PiRunState, {
  harness,
  onEvent,
  options,
  toolLimits,
  sdk,
  reference,
  runtimeWarnings,
}: { harness: Harness; onEvent: PiEventSink; options: PiOptions; toolLimits: PiToolLimits; sdk: string; reference: string; runtimeWarnings?: PiWarning[] }): void {
  if (runState.dispatchProgress) {
    // Conservative admission: later hooks may block execution, but reaching
    // this boundary still forbids another attempt.
    harness.on("before_tool", () => { runState.dispatchProgress.toolAdmitted = true; });
    runState.dispatchProgress.armed = true;
  }
  harness.subscribe(createStreamSubscriber(runState, {
    onEvent,
    options,
    toolLimits,
    harness,
    sdk,
    model: reference,
    runtimeWarnings,
  } as Parameters<typeof createStreamSubscriber>[1]));

  const abortHandler = () => {
    runState.externalAbort = true;
    void harness.abort().catch(() => {});
  };
  if (options.abortSignal) {
    options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    runState.removeAbortHandler = () => options.abortSignal!.removeEventListener?.("abort", abortHandler);
  }
}

/**
 * Start the live-input steering consumer. Consumes follow-up messages and steers
 * the harness mid-run; the consumer is tied to run completion (an internal
 * runComplete flag) so it stops steering once the run finishes and does not
 * swallow a follow-up meant for a later turn. Returns a `stop()` teardown.
 * @param {{harness: any, options: any, onEvent: (event: any) => void, promptEpoch?: any, dispatchProgress?: any}} deps
 * @returns {{stop: () => Promise<void>}}
 */
export function startLiveInput({ harness, options, onEvent, promptEpoch, dispatchProgress }: {
    harness: any;
    options: any;
    onEvent: (event: any) => void;
    promptEpoch?: any;
    dispatchProgress?: any;
}): {
    stop: () => Promise<void>;
};
export function startLiveInput({ harness, options, onEvent, promptEpoch, dispatchProgress }: { harness: Harness; options: PiOptions; onEvent: PiEventSink; promptEpoch?: PiPromptEpoch; dispatchProgress?: RuntimeDispatchProgress }) {
  if (!options.liveInput) return { stop: async () => {} };
  const iterator = typeof (options.liveInput as AsyncIterable<RuntimeLiveInputMessage>)[Symbol.asyncIterator] === "function"
    ? (options.liveInput as AsyncIterable<RuntimeLiveInputMessage>)[Symbol.asyncIterator]()
    : options.liveInput as AsyncIterator<RuntimeLiveInputMessage>;
  let runComplete = false;
  /** @type {() => void} */
  let signalStop = () => {};
  const stopped = new Promise<void>((resolve) => { signalStop = () => resolve(); });
  /** @type {Array<{entryId: string, message: any}>} */
  const acceptedEntries: Array<{ entryId: string; message: RuntimeLiveInputMessage }> = [];
  const task = (async () => {
    try {
      while (!runComplete && !options.abortSignal?.aborted) {
        const next = await Promise.race([
          Promise.resolve(iterator.next()).then((next) => {
            if (!next.done && dispatchProgress?.armed) dispatchProgress.liveInputTaken = true;
            return next;
          }),
          stopped.then(() => ({ done: true as const, value: undefined })),
        ]);
        if (next.done || runComplete || options.abortSignal?.aborted) break;
        try {
          const entryId = await harness.steer(formatLiveInputGuidance(next.value.body, options.prompts),
            options.sessionTurn?.reconciliation ? { inputId: next.value.id } : undefined);
          if (typeof entryId !== "string" || entryId.length === 0) {
            next.value.accepted?.();
            next.value.uncertain?.({ reason: "delivery_uncertain" });
            continue;
          }
          const evidence = {
            providerEntryId: entryId,
            ...(promptEpoch?.ownedRunId() === undefined ? {} : { providerRunId: promptEpoch.ownedRunId()! }),
          };
          acceptedEntries.push({ entryId, message: next.value });
          next.value.accepted?.(evidence);
          promptEpoch?.register(entryId, next.value);
        } catch (err) {
          next.value.reject?.(err);
          throw err;
        }
      }
    } catch (err) {
      onEvent({
        type: "runtime_warning",
        warning_kind: "live_input_failed",
        message: (/** @type {any} */ (((err)) as any))?.message || String(err),
      });
    }
  })();
  /** @type {Promise<void>|undefined} */
  let stopPromise: Promise<void> | undefined;
  return {
    // The run is done: stop the live-steering consumer so it cannot steer a
    // finished harness or swallow a follow-up meant for the next turn. We signal
    // completion, then best-effort return() the iterator. The explicit stop
    // race releases the task even when a third-party iterator's return() does
    // not unblock its pending next(); awaiting the task still closes any steer
    // acknowledgement already in progress.
    stop: () => {
      stopPromise ??= performStop();
      return stopPromise;
    },
  };

  async function performStop() {
      runComplete = true;
      signalStop();
      if (iterator && typeof iterator.return === "function") {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* best-effort */ }
      }
      await task;
      for (const accepted of acceptedEntries) {
        if (promptEpoch?.isConsumed(accepted.entryId)) continue;
        try {
          if (typeof harness.cancelQueued !== "function") {
            accepted.message.uncertain?.({
              reason: "delivery_uncertain",
              providerEntryId: accepted.entryId,
              ...(promptEpoch?.ownedRunId() === undefined ? {} : { providerRunId: promptEpoch.ownedRunId()! }),
            });
            continue;
          }
          const cancellation = await harness.cancelQueued(accepted.entryId);
          if (cancellation?.kind === "cancelled") {
            accepted.message.reject?.({ code: "native_queue_removed" });
          } else if (!promptEpoch?.isConsumed(accepted.entryId)) {
            accepted.message.uncertain?.({
              reason: "delivery_uncertain",
              providerEntryId: accepted.entryId,
              ...(promptEpoch?.ownedRunId() === undefined ? {} : { providerRunId: promptEpoch.ownedRunId()! }),
            });
          }
        } catch {
          accepted.message.uncertain?.({
            reason: "delivery_uncertain",
            providerEntryId: accepted.entryId,
            ...(promptEpoch?.ownedRunId() === undefined ? {} : { providerRunId: promptEpoch.ownedRunId()! }),
          });
          onEvent({
            type: "runtime_warning",
            warning_kind: "live_input_cancellation_failed",
            message: "Unable to prove whether queued live input was removed.",
          });
        }
      }
  }
}

/**
 * Own exact Pi run/entry correlation for the one main prompt in this Mono run.
 * @param {{harness: any, onEvent: (event: any) => void}} deps
 */
export function createLiveInputPromptEpoch({ harness, onEvent }: {
    harness: any;
    onEvent: (event: any) => void;
}): {
    ownedRunId: () => string;
    consumedInputIds: () => any[];
    silenceEligible: () => boolean;
    silenceRefusalReason: () => "live_input_consumed" | "live_input_uncertain";
    register(entryId: any, message: any): void;
    isConsumed: (entryId: any) => boolean;
    /**
     * Own the admitted operation as soon as Pi reports its id, before the run
     * settles, so entries consumed mid-run are acknowledged when their
     * message_end arrives rather than in one batch at the end of the run.
     * Safe in either order with run_start; a conflicting id invalidates.
     */
    confirm(operationId: any): void;
    finish(operationId: any): void;
    close(): void;
};
export function createLiveInputPromptEpoch({ harness, onEvent }: { harness: Harness; onEvent: PiEventSink }) {
  const BUFFER_LIMIT = 101;
  /** @type {string|undefined} */
  let runId: string | undefined;
  let eventWindowClosed = false;
  let invalid = false;
  /** @type {Array<{entryId: string, runId: string}>} */
  const buffered: Array<{ entryId: string; runId: string }> = [];
  /** @type {Map<string, {message: any, observed: boolean, consumed: boolean}>} */
  const entries = new Map<string, { message: RuntimeLiveInputMessage; observed: boolean; consumed: boolean }>();
  // The operation id Pi admitted for the main prompt (via confirm) or that the
  // settled prompt reported (via finish). Consumption is only acknowledged once
  // the observed main-lane run_start carries this exact id.
  /** @type {string|undefined} */
  let admittedOperationId: string | undefined;
  let operationConfirmed = false;

  const remove = harness.subscribe((event: any) => {
    if (!event || event.lane !== "main") return;
    if (event.type === "run_start" && typeof event.runId === "string" && event.runId.length > 0) {
      if (runId === undefined) {
        runId = event.runId;
        if (admittedOperationId !== undefined && admittedOperationId !== runId) {
          invalidate("operation_mismatch");
          return;
        }
        if (admittedOperationId !== undefined) operationConfirmed = true;
        consumeBuffered();
      } else if (runId !== event.runId) {
        invalidate("multiple_run_start");
      }
      return;
    }
    if (event.type === "run_end" && event.runId === runId) {
      eventWindowClosed = true;
      return;
    }
    if (
      event.type !== "message_end"
      || eventWindowClosed
      || event.message?.role !== "user"
      || typeof event.entryId !== "string"
      || event.entryId.length === 0
      || typeof event.runId !== "string"
      || event.runId.length === 0
    ) return;
    if (buffered.some((item) => item.entryId === event.entryId && item.runId === event.runId)) {
      consumeBuffered();
      return;
    }
    if (buffered.length >= BUFFER_LIMIT) {
      invalidate("event_buffer_overflow");
      return;
    }
    buffered.push({ entryId: event.entryId, runId: event.runId });
    consumeBuffered();
  });

  return {
    ownedRunId: () => runId,
    consumedInputIds: () => invalid ? null : [...entries.values()].filter((entry) => entry.consumed).map((entry) => entry.message.id),
    // Keep recovery identities intact. Only trusted host-classified completion
    // wakes may be consumed without creating an obligation to answer a user.
    silenceEligible: () => silenceRefusalReason() === null,
    silenceRefusalReason,
    register(entryId: string, message: RuntimeLiveInputMessage) {
      if (!entries.has(entryId)) entries.set(entryId, { message, observed: false, consumed: false });
      if (invalid) {
        settleUncertain(entries.get(entryId), entryId);
        return;
      }
      consumeBuffered();
    },
    isConsumed: (entryId: string) => entries.get(entryId)?.consumed === true,
    /**
     * Own the admitted operation as soon as Pi reports its id, before the run
     * settles, so entries consumed mid-run are acknowledged when their
     * message_end arrives rather than in one batch at the end of the run.
     * Safe in either order with run_start; a conflicting id invalidates.
     */
    confirm(operationId: any) {
      if (invalid) return;
      if (
        typeof operationId !== "string"
        || operationId.length === 0
        || (admittedOperationId !== undefined && admittedOperationId !== operationId)
        || (runId !== undefined && runId !== operationId)
      ) {
        invalidate("operation_mismatch");
        return;
      }
      admittedOperationId = operationId;
      if (runId === undefined) return;
      operationConfirmed = true;
      confirmObserved();
    },
    finish(operationId: any) {
      if (
        typeof operationId !== "string"
        || operationId.length === 0
        || runId === undefined
        || operationId !== runId
        || (admittedOperationId !== undefined && admittedOperationId !== operationId)
      ) {
        invalidate("operation_mismatch");
        return;
      }
      admittedOperationId = operationId;
      operationConfirmed = true;
      confirmObserved();
    },
    close() {
      remove?.();
    },
  };

  function silenceRefusalReason() {
    if (invalid) return /** @type {const} */ (("live_input_uncertain") as const);
    return [...entries.values()].some((entry) => entry.observed
      && (!entry.consumed || entry.message.kind !== "process_job"))
      ? /** @type {const} */ (("live_input_consumed") as const) : null;
  }

  function consumeBuffered() {
    if (invalid || runId === undefined) return;
    for (const evidence of buffered) {
      if (evidence.runId !== runId) continue;
      const entry = entries.get(evidence.entryId);
      if (entry === undefined || entry.consumed) continue;
      entry.observed = true;
    }
    if (operationConfirmed) confirmObserved();
  }

  function confirmObserved() {
    if (!operationConfirmed || runId === undefined || invalid) return;
    for (const [entryId, entry] of entries) {
      if (!entry.observed || entry.consumed) continue;
      entry.consumed = true;
      entry.message.acknowledge?.({ providerEntryId: entryId, providerRunId: runId });
    }
  }

  function invalidate(reason: string) {
    if (invalid) return;
    invalid = true;
    try {
      onEvent({
        type: "runtime_warning",
        warning_kind: "live_input_correlation_invalid",
        message: "Live-input consumption could not be correlated to exactly one provider operation.",
        reason,
      });
    } catch { /* diagnostics do not alter settlement */ }
    for (const [entryId, entry] of entries) settleUncertain(entry, entryId);
  }

  function settleUncertain(entry: { message: RuntimeLiveInputMessage; consumed: boolean } | undefined, entryId: string) {
    if (entry === undefined || entry.consumed) return;
    entry.message.uncertain?.({
      reason: "delivery_uncertain",
      providerEntryId: entryId,
      ...(runId === undefined ? {} : { providerRunId: runId }),
    });
  }
}
