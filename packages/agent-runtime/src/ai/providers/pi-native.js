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
//     retry/backoff is delegated to pi-ai via streamOptions.maxRetries instead
//     of the legacy manual loop.
//   * Tool sandboxing, approval gates, allowlist/bloat filtering, and the MCP
//     tool bridge are reused shared pieces — they are wired into the harness
//     via its `tools` option, never reimplemented.
//
// The result/event contract is the package's unified runtime-result shape, so
// callers and the test suite see the same artifact the retired bridge produced.

import {
  AgentHarness,
  calculateContextTokens,
  estimateTokens,
  getLastAssistantUsage,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { randomUUID } from "node:crypto";
import { estimateCost } from "../cost.js";
import { retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import {
  estimateFixedOverheadTokens,
  isLikelyContextTermination,
  resolveAgentCompactionPolicy,
} from "../../agent/compaction.js";
import {
  closePiMcpClients,
  createStructuredOutputTool,
  getPiBuiltinTools,
  initPiMcpTools,
} from "../../agent/tools/pi-bridge.js";
import { createApprovalManager } from "../../agent/approval.js";
import { buildCapabilitiesUsed, toolCompactionAppliedFromWarnings } from "../runtime/capabilities-used.js";
import { resolvePiRuntimeModel } from "./pi-models.js";
import {
  textFromContent,
  thinkingFromContent,
  toAgentMessages,
} from "./pi-messages.js";
import { emitCaptured } from "./pi-events.js";
import {
  isContextLimitError,
  normalizePiErrorMessage,
  parseContextLimitFromError,
} from "./pi-errors.js";
import {
  appendStructuredOutputInstruction,
  runStructuredOutputFinalizationRetry,
  shouldRetryStructuredOutputFinalization,
} from "./pi-native/structured-output.js";
import { createStreamSubscriber } from "./pi-native/stream-subscriber.js";
import {
  abortedResult,
  buildDiagnostics,
  buildErrorDetails,
  buildErrorResult,
  buildSuccessResult,
  emitCapabilitiesResolved,
  emitUsageCostEvents,
  usageFromMessages,
} from "./pi-native/result-builder.js";
import {
  cleanupSessionOnThrow,
  commitSession,
  discardUncommittedSession,
  resolveDurableNativeSessionRepo,
  resolveSession,
  rollbackAbortedTurn,
} from "./pi-native/session-lifecycle.js";

function thinkingLevelForEffort(effort, capabilities) {
  if (!capabilities?.reasoning || capabilities.reasoning_mode === "none") return "off";
  if (effort === "none") return "off";
  if (effort === "max") return "xhigh";
  if (effort === "xhigh") return "xhigh";
  if (effort === "high") return "high";
  if (effort === "medium") return "medium";
  return "low";
}

// AUTO-COMPACTION. pi-agent-core performs NO automatic in-loop compaction
// (shouldCompact/compact are exported helpers its loop never calls), so this
// bridge drives it: proactively before a turn when the running model's context
// is near the window, and reactively (compact + single re-prompt) if a turn
// still overflows. The window auto-tracks the model actually serving the request
// and self-corrects from any real ceiling stated in an overflow error.

// Per-process cache of real context-window ceilings discovered from overflow
// errors, keyed by model reference/id. The long-running host re-learns quickly
// after a restart; this just spares repeated first-overflow round-trips.
const discoveredContextWindows = new Map();

function modelWindowKey(harness, runtime, resolved) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  return resolved?.reference || runtime?.model?.id || live?.id || "unknown";
}

// The window of the model that ACTUALLY serves this request: prefer the harness's
// live model (authoritative for native pi models), fall back to the resolved
// runtime model. Returns 0 when unknown so callers can skip the proactive trigger.
function liveModelContextWindow(harness, runtime) {
  const live = typeof harness?.getModel === "function" ? harness.getModel() : null;
  const win = Number(live?.contextWindow) || Number(runtime?.model?.contextWindow) || 0;
  return win > 0 ? win : 0;
}

function effectiveContextWindow(harness, runtime, resolved) {
  const declared = liveModelContextWindow(harness, runtime);
  const discovered = discoveredContextWindows.get(modelWindowKey(harness, runtime, resolved));
  if (Number.isFinite(discovered) && discovered > 0) {
    return declared > 0 ? Math.min(declared, discovered) : discovered;
  }
  return declared;
}

function recordDiscoveredContextWindow(harness, runtime, resolved, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return;
  const key = modelWindowKey(harness, runtime, resolved);
  const existing = discoveredContextWindows.get(key);
  discoveredContextWindows.set(key, Number.isFinite(existing) && existing > 0 ? Math.min(existing, n) : n);
}

// Best-effort estimate of the current session's context size. The last assistant
// usage is authoritative (it reflects what the provider actually counted,
// including cache reads), but it can be stale/zero (e.g. seeded history), so we
// take the MAX of the usage-based count and a raw per-message estimate. Either
// being large is a reason to compact; overcounting only compacts slightly early.
//
// `fixedOverheadTokens` is the system-prompt + tool-schema + per-turn user
// message overhead the provider meters but the raw per-message estimate (which
// sums only the transcript via session.buildContext().messages) excludes. It is
// added to the RAW branch ONLY: the usage-based count already includes that
// overhead (it is what the provider actually counted), so adding it there would
// double-count. With a stale/0 usage and a seeded session the raw branch wins,
// and without this the trigger under-counts and the real request overflows.
async function estimateCurrentContextTokens(session, fixedOverheadTokens = 0) {
  let usageTokens = 0;
  let rawTokens = 0;
  try {
    const usage = getLastAssistantUsage(await session.getEntries());
    if (usage) usageTokens = Number(calculateContextTokens(usage)) || 0;
  } catch { /* ignore — fall back to the raw estimate */ }
  try {
    const context = await session.buildContext();
    for (const message of context?.messages || []) rawTokens += Number(estimateTokens(message)) || 0;
  } catch { /* ignore — usage-based estimate stands */ }
  // Apply the fixed overhead to the raw estimate only (see note above). Done
  // after the loop so it lands once, not per message.
  rawTokens += Number(fixedOverheadTokens) || 0;
  if (usageTokens === 0 && rawTokens === 0) return { tokens: 0, source: "unavailable" };
  return usageTokens >= rawTokens
    ? { tokens: usageTokens, source: "usage" }
    : { tokens: rawTokens, source: "estimate" };
}

// Run a single guarded compaction. Requires the harness idle (callers
// waitForIdle first). Never throws — classifies AgentHarnessError into a warning
// and reports back whether anything was compacted. Fires onCompactionRecorded on
// success so a host can persist the compaction row.
async function tryCompact(harness, { trigger, onEvent, runtimeWarnings, onCompactionRecorded, runId, model }) {
  try {
    const result = await harness.compact();
    const tokensBefore = Number(result?.tokensBefore) || null;
    onEvent?.({
      type: "runtime_warning",
      warning_kind: "context_compaction_applied",
      source: "pi",
      trigger,
      tokens_before: tokensBefore,
    });
    if (typeof onCompactionRecorded === "function") {
      try {
        onCompactionRecorded({
          task_run_id: runId || null,
          trigger,
          provider_kind: "pi",
          model: model || null,
          tokens_before: tokensBefore,
          summary: result?.summary || "",
          first_kept_entry_id: result?.firstKeptEntryId || null,
          status: "succeeded",
          created_at: Date.now(),
        });
      } catch (err) {
        runtimeWarnings.push({
          warning_kind: "context_compaction_record_failed",
          source: "pi",
          message: err?.message || String(err),
        });
      }
    }
    return { applied: true, tokensBefore, nothingToCompact: false };
  } catch (err) {
    const message = err?.message || String(err);
    const code = err?.code;
    const nothingToCompact = code === "compaction" && /nothing to compact/i.test(message);
    const warningKind = nothingToCompact
      ? "context_compaction_nothing_to_compact"
      : code === "auth"
        ? "context_compaction_auth_failed"
        : code === "busy"
          ? "context_compaction_busy"
          : "context_compaction_failed";
    runtimeWarnings.push({ warning_kind: warningKind, source: "pi", trigger, message });
    return { applied: false, tokensBefore: null, nothingToCompact };
  }
}

function isReactiveCompactionCandidate(errorMessage, diagnostics) {
  if (!errorMessage) return false;
  return isContextLimitError(errorMessage) || isLikelyContextTermination(errorMessage, diagnostics);
}

async function resolveApiKey(provider, { apiKeys, resolvePiApiKey, runtimeWarnings }) {
  if (apiKeys?.has(provider)) return apiKeys.get(provider);
  if (typeof resolvePiApiKey !== "function") return undefined;
  try {
    return await resolvePiApiKey(provider);
  } catch (err) {
    runtimeWarnings.push({
      warning_kind: "pi_auth_failed",
      provider,
      message: err?.message || String(err),
    });
    return undefined;
  }
}

// pi 0.80 removed the harness `getApiKeyAndHeaders` hook: request auth now
// resolves through a `Models` collection's `CredentialStore`. This store keeps
// the bridge's per-run key-resolution contract intact — an `apiKeys` map entry
// wins, else the host `resolvePiApiKey(provider)` callback is consulted, and a
// callback failure emits a `pi_auth_failed` runtime warning and proceeds
// keyless. Returning no credential lets a builtin provider fall back to its own
// env vars, exactly as returning `undefined` from the old hook did. `read`
// never throws, so pi never escalates a soft auth miss into a hard
// `ModelsError` stream failure.
export function createDynamicCredentialStore(apiKeys, resolvePiApiKey, runtimeWarnings) {
  const read = async (providerId) => {
    const key = await resolveApiKey(providerId, { apiKeys, resolvePiApiKey, runtimeWarnings });
    return typeof key === "string" && key.length > 0 ? { type: "api_key", key } : undefined;
  };
  return {
    read,
    // api-key providers only ever `read`; pi drives `modify` for OAuth refresh
    // (unused here). Implemented faithfully so the store honors the interface:
    // return the post-write credential, or the current one when `fn` leaves it
    // unchanged (resolves undefined).
    async modify(providerId, fn) {
      const current = await read(providerId);
      return (await fn(current)) ?? current;
    },
    async delete() {},
  };
}

// Assemble the pi 0.80 `Models` collection serving this run. Builtin models
// reuse pi's own provider factories (correct per-provider baseUrl/headers and
// env-var fallback); a custom OpenAI-completions provider is registered from the
// resolved model. `piResolvedModels` is an advanced/test seam mirroring
// `piResolvedModel`: when supplied it is used verbatim (the model dispatched via
// `piResolvedModel` may live outside pi's builtin catalog, e.g. a faux model).
function buildRunModels(runtime, options, runtimeWarnings) {
  if (options.piResolvedModels) return options.piResolvedModels;
  const credentials = createDynamicCredentialStore(runtime.apiKeys, options.resolvePiApiKey, runtimeWarnings);
  if (options.customProvider) {
    const model = runtime.model;
    const models = createModels({ credentials });
    models.setProvider(createProvider({
      id: model.provider,
      name: model.name || model.provider,
      baseUrl: model.baseUrl,
      auth: { apiKey: envApiKeyAuth(model.name || model.provider, []) },
      models: [model],
      api: openAICompletionsApi(),
    }));
    return models;
  }
  return builtinModels({ credentials });
}

// Normalize the incoming runtime messages into AgentMessages the harness can
// seed/prompt. Returns the prior messages (appended to the session before the
// run) and the final user text used to drive `harness.prompt`.
export function splitPromptMessages(messages, model) {
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
function splitUserContent(content) {
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

export async function generatePiNativeResponse(systemPrompt, options = {}) {
  const resolved = options.model;
  const start = Date.now();
  const events = [];
  const runtimeWarnings = [];
  let structuredResult = null;
  let mcpClients = [];
  let externalAbort = false;
  let harness = null;
  let removeAbortHandler = null;
  // Mutable run state the extracted modules read/write. Grows across the
  // decomposition (compaction fields land here in the next commit); today it
  // carries the stream subscriber's counters/dedup keys/tool timings and the
  // session-lifecycle handles. `toolStartTimes` maps toolCallId -> start
  // timestamp so per-tool execution latency can be emitted.
  const runState = {
    assistantTexts: [],
    assistantThinking: [],
    textDeltaIndexes: new Set(),
    thinkingDeltaIndexes: new Set(),
    toolStartTimes: new Map(),
    turnCount: 0,
    toolResultsSeen: 0,
    lastToolName: null,
    maxTurnsHit: false,
    session: null,
    sessionEntry: null,
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
  };

  const providerSessionId = options.sessionId
    || options.providerSessionId
    || options.runId
    || randomUUID();
  // Prefer the explicit sessionId, but fall back to providerSessionId so a caller
  // that only supplies providerSessionId still resumes the prior session instead
  // of being treated as a fresh run (which would drop prior context).
  const requestedSessionId = typeof options.sessionId === "string" && options.sessionId.trim()
    ? options.sessionId
    : (typeof options.providerSessionId === "string" && options.providerSessionId.trim()
      ? options.providerSessionId
      : null);
  // Bridge TTL is a backstop behind the host's session policy; the grace
  // keeps host-side lazy expiry firing first.
  const sessionTtlMs = Number.isFinite(Number(options.sessionIdleTimeoutMs))
    ? Number(options.sessionIdleTimeoutMs) + 60_000
    : undefined;
  let structuredOutputFinalizationRetryAttempts = 0;
  let structuredOutputFinalizationRetryReason = null;
  let structuredOutputFinalizationRetryFailed = false;

  const onEvent = (event) => emitCaptured(events, options.onEvent, event);
  const approvalManager = options.onToolApprovalRequest
    ? createApprovalManager({
      onToolApprovalRequest: options.onToolApprovalRequest,
      defaultRiskTier: options.approvalDefaultRiskTier,
      timeoutMs: options.approvalTimeoutMs,
      onEvent,
      riskTiersByTool: options.toolRiskTiers,
      alwaysAllowTools: options.approvalAlwaysAllowTools,
    })
    : null;

  if (options.abortSignal?.aborted) {
    return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId });
  }

  const durableRepo = resolveDurableNativeSessionRepo(options.piSessionsRoot);

  try {
    // Resume the session (warm registry hit, durable cold reopen, or
    // create-on-miss for a durable cross-restart first turn) or create a fresh
    // one. resolveSession mutates runState.session / sessionEntry / createdOnMiss
    // / reservation, and returns an early fast-fail result (session_not_found /
    // session_busy) to return verbatim. Its liveness claims (I1 busy-claim, R8
    // reservation, F4 cold-reopen re-read) are await-free by construction. A
    // session miss stays cheap: no tool/MCP/harness init runs before this
    // fast-fail.
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
    });
    if (resolvedSession.done) return resolvedSession.result;

    // `piResolvedModel` is an advanced/test seam: when supplied it provides a
    // ready pi-ai Model (e.g. a registered faux provider model) plus optional
    // capabilities, bypassing the static model-registry lookup. Production
    // callers leave it undefined and resolve through pi-ai's registry.
    const runtime = options.piResolvedModel
      ? {
        model: options.piResolvedModel,
        capabilities: options.piResolvedCapabilities || {
          tool_use: true,
          reasoning: !!options.piResolvedModel.reasoning,
          reasoning_mode: options.piResolvedModel.reasoning ? "effort" : "none",
          json_mode: true,
        },
        apiKeys: new Map(),
      }
      : resolvePiRuntimeModel(resolved, options);
    const capabilities = runtime.capabilities || {};
    const effectiveThinkingLevel = thinkingLevelForEffort(options.effort || "medium", capabilities);
    const reference = resolved.reference
      || (resolved.sdk === "pi" ? `pi:${resolved.provider}:${resolved.model}` : `${resolved.sdk}:${resolved.model}`);

    // Tool-output limits (settings-driven clamps for tool/MCP payloads). The
    // legacy pi-sdk bridge wired these via the compaction manager's `.policy`;
    // resolveAgentCompactionPolicy is pure (no manager/Agent), so we compute the
    // same policy directly and pass it into the tool builders + display
    // normalization. Restores configurable clamping (agent_tool_text_limit_chars,
    // agent_search_result_limit, ...) on top of the 256KB hard ceiling.
    const toolLimits = resolveAgentCompactionPolicy(options.settings || {}, runtime.model);

    // Auto-compaction state. The compaction policy is (re)computed at the
    // decision point (Hook B) against the model actually serving the request, so
    // it is declared there; these flags track whether a compaction fired so the
    // run reports context_compaction_applied honestly and never double-compacts.
    let contextCompactionApplied = false;
    let contextCompactionReactiveAttempted = false;
    let contextCompactedThisRun = false;
    let compactionPolicy = null;
    const contextCompactionDiagnostics = {};

    const onTruncate = (info) => {
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

    // REUSED custom pieces: built-in tool sandboxing + allowlist/bloat filter +
    // approval gates. These are identical to the legacy bridge.
    const builtIns = capabilities.tool_use === false
      ? []
      : getPiBuiltinTools(options.allowedTools, {
        skillNames: (options.skills || []).map((skill) => skill.name),
        // Progressive skill disclosure: when the harness threads the skills root
        // (the directory holding `<name>/SKILL.md`) the read_skill tool resolves
        // bodies directly from there. `dataDir` (skills under `<dataDir>/skills`)
        // remains the back-compat fallback.
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
        sandboxEngine: options.sandboxEngine,
        approvalManager,
        approvalModel: runtime.model?.id || runtime.model?.name || resolved.model,
        ctx: options.toolContext,
      });

    const structuredTool = createStructuredOutputTool(options.outputSchema, (value) => {
      structuredResult = value;
    });
    const reservedNames = new Set(builtIns.map((toolDef) => toolDef.name));
    if (structuredTool) reservedNames.add(structuredTool.name);

    // REUSED MCP tool bridge: same initPiMcpTools sandboxing path.
    const mcpInit = capabilities.tool_use === false
      ? { clients: [], tools: [], warnings: [] }
      : await initPiMcpTools(options.mcpServers || {}, reservedNames, {
        cwd: options.cwd,
        persistArtifact,
        qaOutputDir,
        onTruncate,
        limits: toolLimits,
        toolPayloadMaxBytes: toolLimits.toolPayloadMaxBytes,
        sandboxPolicy: options.sandboxPolicy,
        sandboxEngine: options.sandboxEngine,
        ctx: options.toolContext,
      });
    mcpClients = mcpInit.clients;
    // Surface MCP init/list failures BOTH to the live event stream and to runtimeWarnings, so a
    // failed server (e.g. an stdio adapter-send child that closed on startup) lands in the run
    // summary's runtimeWarnings instead of being buried as a transient event the summary drops.
    for (const warning of mcpInit.warnings || []) {
      onEvent(warning);
      runtimeWarnings.push(warning);
    }

    const tools = [
      ...builtIns,
      ...mcpInit.tools,
      ...(structuredTool ? [structuredTool] : []),
    ];

    // Provider retry/backoff is delegated to pi-ai via streamOptions, replacing
    // the legacy hand-rolled stream-retry loop.
    const maxRetries = Number.isFinite(Number(options.piMaxRetries))
      ? Math.max(0, Math.min(8, Number(options.piMaxRetries)))
      : 2;
    const maxRetryDelayMs = Number.isFinite(Number(options.maxRetryDelayMs))
      ? Number(options.maxRetryDelayMs)
      : 60_000;
    // Tool steering: default "one-at-a-time" (safe, deterministic ordering).
    // Opt-in "all" lets pi-agent-core run a model step's tool calls concurrently
    // (QueueMode). Only enable when tools in a step are independent.
    const toolSteeringMode = options.piToolParallelismMode === "all" ? "all" : "one-at-a-time";

    const piModels = buildRunModels(runtime, options, runtimeWarnings);

    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: options.cwd || process.cwd() }),
      session: runState.session,
      models: piModels,
      model: runtime.model,
      thinkingLevel: effectiveThinkingLevel,
      systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema),
      tools,
      streamOptions: { maxRetries, maxRetryDelayMs },
      steeringMode: toolSteeringMode,
      followUpMode: toolSteeringMode,
    });

    harness.subscribe(createStreamSubscriber(runState, { onEvent, options, toolLimits, harness }));

    const abortHandler = () => {
      externalAbort = true;
      harness.abort();
    };
    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", abortHandler, { once: true });
      removeAbortHandler = () => options.abortSignal.removeEventListener?.("abort", abortHandler);
    }

    // Seed prior transcript (everything before the trailing user turn) into the
    // harness-owned session. On a true resume the session already holds the
    // transcript, so prior messages are skipped; a fresh run AND a create-on-miss
    // (requestedSessionId set but the durable session was just created empty)
    // both seed, since their on-disk transcript is empty.
    const { priorMessages, promptText, promptImages } = splitPromptMessages(options.messages, runtime.model);
    runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
    if (!requestedSessionId || runState.createdOnMiss) {
      for (const message of priorMessages) {
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
    if (requestedSessionId && !runState.createdOnMiss) {
      try { runState.baselineLeafId = await runState.session.getLeafId(); } catch { /* best-effort */ }
    }

    // Live steering: consume follow-up messages and steer the harness mid-run.
    // The consumer is tied to run completion (runComplete) so it stops steering
    // once the run finishes and does not swallow messages meant for a later turn.
    let liveInputIterator = null;
    let liveInputTask = null;
    let runComplete = false;
    if (options.liveInput) {
      liveInputIterator = typeof options.liveInput[Symbol.asyncIterator] === "function"
        ? options.liveInput[Symbol.asyncIterator]()
        : options.liveInput;
      liveInputTask = (async () => {
        try {
          while (!runComplete && !options.abortSignal?.aborted) {
            const next = await liveInputIterator.next();
            if (next.done || runComplete || options.abortSignal?.aborted) break;
            await harness.steer(formatLiveInputGuidance(next.value.body));
          }
        } catch (err) {
          onEvent({
            type: "runtime_warning",
            warning_kind: "live_input_failed",
            message: err?.message || String(err),
          });
        }
      })();
    }

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
      await discardUncommittedSession(runState, { durableRepo });
      return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId });
    }

    // Compaction policy against the LIVE model's context window (auto-recognized
    // from the model actually serving the request, lowered by any ceiling learned
    // from a prior overflow). Drives the proactive trigger + reactive recovery.
    compactionPolicy = resolveAgentCompactionPolicy(
      options.settings || {},
      { contextWindow: effectiveContextWindow(harness, runtime, resolved) },
    );

    // Proactive compaction: if the session is already near the window, compact
    // BEFORE issuing the request so a long-lived session never overflows.
    if (compactionPolicy.enabled && compactionPolicy.contextWindow > 0 && !options.abortSignal?.aborted) {
      // Fixed per-request overhead the provider meters but the raw transcript
      // estimate excludes (system prompt + tool/MCP schemas + per-turn user
      // message + memory). Computed ONCE here from the same inputs the harness
      // sends to the provider, then folded into the raw estimate so the trigger
      // reflects the real request size. ON by default (this corrects a real
      // undercount that lets seeded sessions overflow); set
      // agent_compaction_fixed_overhead_enabled:false to restore the prior
      // transcript-only trigger (overhead = 0). See estimateFixedOverheadTokens.
      //
      // Only the TRAILING per-turn user message is passed here, NOT
      // options.messages. The prior transcript is already summed by the raw
      // branch via session.buildContext().messages (priorMessages were seeded
      // into the session above), so passing the whole history would double-count
      // it. promptText/promptImages (from splitPromptMessages at the run head)
      // ARE the per-turn turn, so reconstruct that single message for the
      // estimate — matching estimateFixedOverheadTokens' "per-turn user
      // message(s)" contract.
      const perTurnContent = Array.isArray(promptImages) && promptImages.length > 0
        ? [{ type: "text", text: promptText }, ...promptImages]
        : promptText;
      const fixedOverhead = options.settings?.agent_compaction_fixed_overhead_enabled !== false
        ? estimateFixedOverheadTokens({
          systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema),
          tools,
          messages: [{ role: "user", content: perTurnContent }],
        })
        : { systemPromptTokens: 0, toolSchemaTokens: 0, userMessageTokens: 0, fixedOverheadTokens: 0 };
      const est = await estimateCurrentContextTokens(runState.session, fixedOverhead.fixedOverheadTokens);
      if (est.tokens >= compactionPolicy.triggerTokens) {
        await harness.waitForIdle();
        if (!options.abortSignal?.aborted) {
          const res = await tryCompact(harness, {
            trigger: "proactive",
            onEvent,
            runtimeWarnings,
            onCompactionRecorded: options.onCompactionRecorded,
            runId: options.runId,
            model: reference,
          });
          if (res.applied) {
            contextCompactionApplied = true;
            contextCompactedThisRun = true;
            Object.assign(contextCompactionDiagnostics, {
              context_compaction_proactive: true,
              context_compaction_tokens_before: res.tokensBefore,
              context_compaction_estimate_source: est.source,
              context_window: compactionPolicy.contextWindow,
              // Additive observability (A4): the overhead components folded into
              // the trigger comparison, the trigger itself (read back by
              // isLikelyContextTermination but otherwise never set), and the
              // transcript-plus-overhead estimate that fired this compaction.
              context_fixed_overhead_tokens: fixedOverhead.fixedOverheadTokens,
              context_system_prompt_tokens: fixedOverhead.systemPromptTokens,
              context_tool_schema_tokens: fixedOverhead.toolSchemaTokens,
              context_compaction_trigger_tokens: compactionPolicy.triggerTokens,
              context_transcript_estimate: est.tokens,
            });
            // Compaction collapses the transcript prefix, so the pre-run baseline
            // no longer aligns. Re-anchor it to the compacted length so the run's
            // own turns (issued next) slice out correctly in captureState.
            runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
          }
        }
      }
    }

    onEvent({
      type: "provider_request_started",
      sdk: resolved.sdk,
      model: reference,
      runtime: "pi",
      timestamp: Date.now(),
    });

    let runError = null;
    try {
      // Pass structured images (when present) so multimodal input reaches the
      // model as image blocks rather than stringified text. AgentHarness.prompt
      // takes them under an options object (`{ images }`); a bare array would be
      // read as `options` and silently dropped (options?.images === undefined).
      if (Array.isArray(promptImages) && promptImages.length > 0) {
        await harness.prompt(promptText, { images: promptImages });
      } else {
        await harness.prompt(promptText);
      }
    } catch (err) {
      runError = err;
    }
    await harness.waitForIdle();

    // The run is done: stop the live-steering consumer so it cannot steer a
    // finished harness or swallow a follow-up meant for the next turn. We signal
    // completion, then best-effort return() the iterator to unblock a pending
    // next(). We do NOT await the task (it could block on next() if the source
    // has no return()), but the runComplete guard prevents any further steering.
    runComplete = true;
    if (liveInputIterator && typeof liveInputIterator.return === "function") {
      try { await liveInputIterator.return(); } catch { /* best-effort */ }
    }
    void liveInputTask;

    externalAbort ||= !!options.abortSignal?.aborted;

    const captureState = async () => {
      const context = await runState.session.buildContext();
      const transcript = context.messages || [];
      const runTranscript = transcript.slice(runState.sessionBaselineCount);
      const assistantMessages = runTranscript.filter((message) => message?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      return {
        transcript,
        runTranscript,
        assistantMessages,
        lastAssistant,
        stopReason: lastAssistant?.stopReason || null,
        finalText: textFromContent(lastAssistant?.content) || runState.assistantTexts.join(""),
        finalThinking: thinkingFromContent(lastAssistant?.content) || runState.assistantThinking.join(""),
      };
    };

    let state = await captureState();

    // Structured-output finalization retry: if the turn ended with neither
    // text nor a StructuredOutput call, re-prompt ONCE in the same session with
    // only StructuredOutput active so the model can submit the required result.
    // This replicates the legacy bridge's single re-prompt via the harness's
    // followUp + setActiveTools instead of the low-level agent.continue() loop.
    if (!runError && shouldRetryStructuredOutputFinalization({
      outputSchema: options.outputSchema,
      structuredResult,
      finalText: state.finalText,
      stopReason: state.stopReason,
      externalAbort,
      maxTurnsHit: runState.maxTurnsHit,
    })) {
      const retry = await runStructuredOutputFinalizationRetry({ harness, structuredTool, runtimeWarnings });
      structuredOutputFinalizationRetryAttempts = retry.attempts;
      structuredOutputFinalizationRetryReason = retry.reason;
      structuredOutputFinalizationRetryFailed = structuredResult === null || structuredResult === undefined;
      state = await captureState();
    }

    // Reactive recovery: if the turn ended in a context overflow and we have not
    // already compacted-and-retried this run, compact once and re-prompt once.
    if (
      compactionPolicy?.enabled
      && !contextCompactionReactiveAttempted
      && !externalAbort
      && !runState.maxTurnsHit
      && !options.abortSignal?.aborted
    ) {
      const provisionalRaw = state.stopReason === "error" || state.stopReason === "aborted"
        ? state.lastAssistant?.errorMessage || runError?.message || null
        : (runError ? runError.message || String(runError) : null);
      const provisionalError = normalizePiErrorMessage(provisionalRaw);
      if (provisionalError && isReactiveCompactionCandidate(provisionalError, contextCompactionDiagnostics)) {
        contextCompactionReactiveAttempted = true;
        // Learn the real ceiling from the error so future runs trigger
        // proactively at it even when the configured contextWindow was wrong.
        recordDiscoveredContextWindow(harness, runtime, resolved, parseContextLimitFromError(provisionalError));
        // A second compaction immediately after a fresh proactive one is almost
        // always "nothing to compact"; skip it and surface the original error.
        if (!contextCompactedThisRun) {
          await harness.waitForIdle();
          const res = await tryCompact(harness, {
            trigger: "reactive_overflow",
            onEvent,
            runtimeWarnings,
            onCompactionRecorded: options.onCompactionRecorded,
            runId: options.runId,
            model: reference,
          });
          if (res.applied) {
            contextCompactionApplied = true;
            contextCompactedThisRun = true;
            Object.assign(contextCompactionDiagnostics, {
              context_compaction_reactive: true,
              context_compaction_tokens_before: res.tokensBefore,
            });
            // Re-anchor the transcript baseline to the compacted length so the
            // re-prompt's turn (and its stopReason/usage) slices out correctly.
            runState.sessionBaselineCount = (await runState.session.buildContext()).messages.length;
            // Re-prompt ONCE in the now-compacted session. The trailing user turn
            // is already persisted, so a fresh prompt continues against it.
            runError = null;
            try {
              if (Array.isArray(promptImages) && promptImages.length > 0) {
                await harness.prompt(promptText, { images: promptImages });
              } else {
                await harness.prompt(promptText);
              }
            } catch (err) {
              runError = err;
            }
            await harness.waitForIdle();
            state = await captureState();
          }
        }
      }
    }

    const { runTranscript, lastAssistant, stopReason, finalText, finalThinking } = state;
    const runAssistantCount = state.assistantMessages.length;

    const usage = usageFromMessages(runTranscript);
    const estimatedCost = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    });
    emitUsageCostEvents({ onEvent, resolved, reference, usage, estimatedCost, start, externalAbort });

    const rawErrorMessage = externalAbort
      ? null
      : runState.maxTurnsHit
        ? "Pi agent stopped before final output: max turns reached"
        : (stopReason === "error" || stopReason === "aborted"
          ? lastAssistant?.errorMessage || runError?.message || "Pi agent aborted before final output"
          : (runError ? runError.message || String(runError) : null));
    const errorMessage = normalizePiErrorMessage(rawErrorMessage);

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
      externalAbort,
      maxRetries,
      lastToolName: runState.lastToolName,
      structuredRetry,
      contextCompactionDiagnostics,
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
      contextCompactionDiagnostics,
    });

    const capabilitiesUsed = buildCapabilitiesUsed({
      promptCacheActive: usage.cacheRead > 0 || usage.cacheWrite > 0,
      thinkingEnabled: effectiveThinkingLevel !== "off" && effectiveThinkingLevel !== "low",
      structuredOutputEnforced: !!options.outputSchema,
      subagentInvoked: false,
      mcpServersUsed: mcpClients.map((entry) => entry?.name).filter(Boolean),
      nativeSubagentsUsed: [],
      toolCompactionApplied: toolCompactionAppliedFromWarnings(runtimeWarnings),
      // Tristate: true = a compaction fired this run (proactive or reactive),
      // false = the path is enabled but did not need to fire, null = disabled via
      // agent_compaction_enabled. See docs/reference/feature-registry.md runtime.context-compaction.
      contextCompactionApplied: compactionPolicy?.enabled ? contextCompactionApplied : null,
    });
    emitCapabilitiesResolved(onEvent, { sdk: resolved.sdk, model: reference, capabilitiesUsed });

    // Re-check the abort signal: a cancel can land during the post-run work above
    // (live-input teardown, structured-output finalization retry) after the line
    // ~780 check. Pick it up here so the lifecycle decision below rolls back the
    // cancelled turn instead of committing it into a durable transcript a later
    // resume would replay.
    externalAbort ||= !!options.abortSignal?.aborted;

    // Session lifecycle parity with the legacy bridge. The harness already
    // durably persisted the transcript into its session object (in-memory for
    // the default repo, jsonl on disk when piSessionsRoot is set); commitSession
    // tracks LIVENESS so disposeProviderSession / idle-TTL eviction can reach
    // native sessions, keep-alive registers the session, and a failed/aborted
    // resumed turn rolls back to its pre-turn leaf.
    await commitSession(runState, {
      options,
      requestedSessionId,
      providerSessionId,
      durableRepo,
      sessionTtlMs,
      externalAbort,
      errorMessage,
      onEvent,
    });

    // Final abort guard (durable cancel TOCTOU): if a cancel raced the lifecycle
    // commit above — landing AFTER the keep-alive/!externalAbort decision but
    // before this return — the cancelled turn is still in the durable transcript
    // and (for keep-alive) the live registry. Roll it back so the next resume sees
    // the pre-turn state (rollbackAbortedTurn: a resumed session moves to its
    // baseline leaf and drops its live entry; a fresh durable session deletes its
    // jsonl). The abort re-check + return stay inline with NO await between the
    // false-branch check and the return, so an external cancel cannot newly fire
    // past it (I10).
    if (!externalAbort && options.abortSignal?.aborted) {
      externalAbort = true;
      await rollbackAbortedTurn(runState, { requestedSessionId, providerSessionId, durableRepo });
    }

    return buildSuccessResult({
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
      externalAbort,
      errorMessage,
      errorDetails,
      diagnostics,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      runtimeWarnings,
      capabilitiesUsed,
      structuredResult,
    });
  } catch (err) {
    externalAbort ||= !!options.abortSignal?.aborted;
    // Drop a just-created fresh durable session, release a create-on-miss
    // reservation placeholder, and roll a resumed session back to its pre-turn
    // leaf for host/runtime-side throws that landed after the harness already
    // mutated the live session (guards preserved in cleanupSessionOnThrow).
    await cleanupSessionOnThrow(runState, { durableRepo });
    const errorMessage = normalizePiErrorMessage(err?.message || String(err));
    const isRetryable = retryableProviderFailureInfo({
      errorText: errorMessage,
      failureKind: "provider_unavailable",
    }).retryable;
    return buildErrorResult({
      assistantTexts: runState.assistantTexts,
      events,
      start,
      turnCount: runState.turnCount,
      resolved,
      options,
      externalAbort,
      errorMessage,
      lastToolName: runState.lastToolName,
      toolResultsSeen: runState.toolResultsSeen,
      maxTurnsHit: runState.maxTurnsHit,
      providerSessionId,
      runtimeWarnings,
      isRetryable,
    });
  } finally {
    if (runState.sessionEntry) runState.sessionEntry.busy = false;
    removeAbortHandler?.();
    await closePiMcpClients(mcpClients);
  }
}

export const piNativeRuntimeBridge = {
  id: "pi",
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  supports: (ref) => ref?.sdk === "pi",
  execute: generatePiNativeResponse,
};
