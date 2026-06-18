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

import { AgentHarness, InMemorySessionRepo, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { randomUUID } from "node:crypto";
import { estimateCost } from "../cost.js";
import { retryableProviderFailureInfo } from "../failure.js";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import { createSessionRegistry } from "../runtime/sessions.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import { isLikelyContextTermination, resolveAgentCompactionPolicy } from "../../agent/compaction.js";
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
  toolResultContent,
} from "./pi-messages.js";
import {
  compactToolRawResult,
  emitCaptured,
  eventToolArgs,
  jsonSerializable,
  streamContentKey,
} from "./pi-events.js";
import {
  isContextLimitError,
  normalizePiErrorMessage,
} from "./pi-errors.js";

function usageFromMessages(messages = []) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages) {
    if (message?.role !== "assistant") continue;
    const next = message.usage || {};
    usage.input += Number(next.input) || 0;
    usage.output += Number(next.output) || 0;
    usage.cacheRead += Number(next.cacheRead) || 0;
    usage.cacheWrite += Number(next.cacheWrite) || 0;
    usage.cost += Number(next.cost?.total) || 0;
  }
  return usage;
}

function thinkingLevelForEffort(effort, capabilities) {
  if (!capabilities?.reasoning || capabilities.reasoning_mode === "none") return "off";
  if (effort === "none") return "off";
  if (effort === "max") return "xhigh";
  if (effort === "xhigh") return "xhigh";
  if (effort === "high") return "high";
  if (effort === "medium") return "medium";
  return "low";
}

function appendStructuredOutputInstruction(systemPrompt, outputSchema) {
  if (!outputSchema) return systemPrompt;
  return [
    systemPrompt,
    "",
    "Structured output is available through the `StructuredOutput` tool.",
    "When the final result is ready, call `StructuredOutput` with the complete JSON object matching the requested schema.",
    "Do not also print the same JSON as prose unless tool calling is unavailable.",
  ].join("\n");
}

function toolStartProgressText(toolName) {
  if (typeof toolName !== "string" || toolName.trim().length === 0) return null;
  return `Running ${toolName}...`;
}

function structuredOutputFinalizationPrompt() {
  return [
    "The previous assistant turn ended without submitting the required structured result.",
    "Do not run tools, inspect files, or redo work.",
    "Call only `StructuredOutput` once with the final object matching the requested schema, based on the completed transcript above.",
    "Do not print prose before or after the tool call.",
  ].join("\n");
}

function shouldRetryStructuredOutputFinalization({
  outputSchema,
  structuredResult,
  finalText,
  stopReason,
  externalAbort,
  maxTurnsHit,
}) {
  if (!outputSchema) return false;
  if (structuredResult !== null && structuredResult !== undefined) return false;
  if (String(finalText || "").trim()) return false;
  if (externalAbort || maxTurnsHit) return false;
  return stopReason !== "error" && stopReason !== "aborted";
}

function structuredOutputRetryDiagnostics(attempts, reason, failed) {
  if (!attempts) return {};
  return {
    structured_output_finalization_retry_attempts: attempts,
    structured_output_finalization_retry_reason: reason,
    structured_output_finalization_retry_failed: !!failed,
  };
}

function failureKindForPiError(message, diagnostics, { maxTurnsHit = false } = {}) {
  if (!message) return null;
  if (maxTurnsHit || isContextLimitError(message) || isLikelyContextTermination(message, diagnostics)) {
    return "usage_limit";
  }
  return "provider_unavailable";
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

// Live pi-native sessions, keyed by provider session id. Entries are
// { session, metadata, repo, durable, busy } — identical shape and lifecycle
// policy to the (now-retired) pi-sdk bridge: in-memory transcripts are freed
// when the registry evicts them; durable (jsonl) transcripts survive eviction
// so a later resume can reopen them from disk. Registering here gives
// runtime.disposeSession / disposeProviderSession + idle-TTL eviction the same
// reach over native pi sessions that the legacy bridge had.
const nativeSessionRepo = new InMemorySessionRepo();
const nativeSessions = createSessionRegistry({
  isBusy: (entry) => entry.busy === true,
  onEvict: async (entry) => {
    if (entry.durable) return;
    try {
      await entry.repo.delete(entry.metadata);
    } catch { /* best-effort */ }
  },
});

const durableNativeSessionRepos = new Map();

function resolveDurableNativeSessionRepo(piSessionsRoot) {
  if (typeof piSessionsRoot !== "string" || !piSessionsRoot.trim()) return null;
  const root = piSessionsRoot.trim();
  let repo = durableNativeSessionRepos.get(root);
  if (!repo) {
    repo = new JsonlSessionRepo({
      fs: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessionsRoot: root,
    });
    durableNativeSessionRepos.set(root, repo);
  }
  return repo;
}

// Defense in depth (R4): create-on-miss passes the caller-controlled session id
// straight to durableRepo.create({ id }), and JsonlSessionRepo writes
// `${createdAt}_${id}.jsonl` — so an id like "../../../../tmp/pwn" would escape
// piSessionsRoot and name a file anywhere on disk. The harness-derived id is a
// sha256 hex (always safe), but the public runtime API is caller-controlled.
// Only an id that is a single safe filename component may CREATE a session;
// anything else falls through to the existing session_not_found fast-fail, so a
// malicious id can never name a file. (A genuinely on-disk session reopened by
// reopenDurableNativeSession is matched by `.id`, never used to build a path, so
// this gate is confined to the create path.)
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeSessionId(id) {
  return typeof id === "string"
    && SAFE_SESSION_ID.test(id)
    && !id.includes("..")
    && !id.includes("/")
    && !id.includes("\\");
}

async function reopenDurableNativeSession(repo, sessionId) {
  try {
    const metadata = (await repo.list()).find((entry) => entry?.id === sessionId);
    if (!metadata) return null;
    const session = await repo.open(metadata);
    return { session, metadata, repo, durable: true, busy: false };
  } catch {
    return null;
  }
}

function sessionUnavailableResult({
  resolved,
  options,
  events,
  runtimeWarnings,
  start,
  sessionId,
  errorMessage,
  failureKind,
  piErrorCode,
}) {
  return {
    text: null,
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: resolved?.reference || resolved?.model || null,
    effort: options.effort || null,
    sdk: resolved?.sdk || "pi",
    cancelled: false,
    error: errorMessage,
    failureKind,
    providerSessionId: sessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: sessionId,
      pi_error_code: piErrorCode,
      pi_engine: "native",
    },
  };
}

function abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId }) {
  return {
    text: null,
    thinking: "",
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: resolved?.reference || resolved?.model || null,
    effort: options.effort || null,
    sdk: resolved?.sdk || "pi",
    cancelled: true,
    error: null,
    failureKind: null,
    providerSessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: providerSessionId,
      pi_stop_reason: "aborted",
      pi_engine: "native",
      external_abort: true,
    },
  };
}

export async function generatePiNativeResponse(systemPrompt, options = {}) {
  const resolved = options.model;
  const start = Date.now();
  const events = [];
  const runtimeWarnings = [];
  const assistantTexts = [];
  const assistantThinking = [];
  const textDeltaIndexes = new Set();
  const thinkingDeltaIndexes = new Set();
  let structuredResult = null;
  let mcpClients = [];
  let externalAbort = false;
  let maxTurnsHit = false;
  let turnCount = 0;
  let toolResultsSeen = 0;
  let lastToolName = null;
  // toolCallId -> start timestamp, so we can emit per-tool execution latency.
  const toolStartTimes = new Map();
  let harness = null;
  let removeAbortHandler = null;

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
  let session = null;
  let sessionEntry = null;
  // True when a requestedSessionId had no live entry AND no durable transcript,
  // so a fresh durable session was created under that id (cross-restart resume,
  // first turn for the conversation). Distinct from a true resume (sessionEntry
  // set): the on-disk transcript is empty, so prior messages must still be
  // seeded — unlike a resume, where the session already holds them.
  let createdOnMiss = false;
  // True once the create-on-miss path inserted its BUSY placeholder into the
  // registry (R8 concurrent-first-turn reservation). Used to clean the
  // placeholder up on the drop/error/abort paths, since createdOnMiss leaves
  // sessionEntry null so the finally's busy-clear does not cover it.
  let createdOnMissPlaceholder = false;
  let sessionBaselineCount = 0;
  // Leaf captured before a resumed turn runs, so a failed resume can be rolled
  // back to the last good transcript via moveTo. Hoisted to function scope so
  // the OUTER catch (host/runtime-side throws after the session mutated) can
  // roll back too, not just the success path.
  let baselineLeafId = null;

  try {
    // Resume check first: a session miss must stay cheap (no tool/MCP/harness
    // init). This mirrors the legacy bridge's fail-fast contract.
    if (requestedSessionId) {
      let entry = nativeSessions.get(requestedSessionId);
      if (!entry && durableRepo) {
        entry = await reopenDurableNativeSession(durableRepo, requestedSessionId);
        if (entry) {
          // TOCTOU guard: the reopen above is an AWAIT, so a second concurrent
          // cold resume could have reopened+inserted its own entry in this
          // window. Re-read the registry and adopt any entry already present so
          // the busy-claim below collapses back to the warm path's synchronous
          // semantics (the loser sees the winner's shared entry with busy===true
          // and returns session_busy). The discarded reopen is just an in-memory
          // jsonl handle (no subprocess/socket), so dropping it is safe.
          const concurrent = nativeSessions.get(requestedSessionId);
          if (concurrent) {
            entry = concurrent;
          } else {
            nativeSessions.set(requestedSessionId, entry, { idleTimeoutMs: sessionTtlMs });
          }
        }
      }
      if (!entry) {
        if (durableRepo && isSafeSessionId(providerSessionId)) {
          // Create-on-miss (durable resume only): the requested id has no live
          // registry entry AND no JSONL on disk under piSessionsRoot. This is
          // the cross-restart resume case — the harness derives a stable id from
          // the conversationId and passes it before any session exists on a
          // fresh process. Rather than fail with session_not_found (which would
          // make the harness re-send full history into yet another fresh,
          // randomly-named session and orphan future resumes), create a durable
          // session UNDER the requested id so this and every later turn for the
          // conversation resolve to the same on-disk transcript. sessionEntry
          // stays null so this proceeds exactly like a fresh run (prior messages
          // are seeded, the keep-alive success path registers + persists it).
          // The IN-MEMORY resume miss (no durableRepo) — and a create-on-miss
          // with an UNSAFE id (R4) — keep fast-failing below, preserving the
          // existing per-process session_not_found contract.
          //
          // Concurrent-first-turn race (R8): two concurrent first turns for the
          // same durable id would BOTH miss here and BOTH create, producing two
          // transcripts for one logical id (JsonlSessionRepo names files by
          // `${createdAt}_${id}`, so there is no fs-level dedup). Mirror the
          // cold-reopen-race defense: synchronously (NO await) re-check the
          // registry, then reserve the id with a BUSY placeholder before the
          // create await. The get→check→set span MUST stay await-free, so the
          // loser observes the busy placeholder and returns session_busy via the
          // same busy-claim path below — exactly one create per durable id.
          const concurrent = nativeSessions.get(requestedSessionId);
          if (concurrent) {
            // A concurrent caller already reserved/created this id in the window
            // since the miss above. Adopt its entry and fall into the busy-claim
            // logic (session_busy if its turn is in flight, else resume).
            entry = concurrent;
          } else {
            // Reserve the id with a busy placeholder BEFORE the create await so a
            // second concurrent first turn observes busy and returns session_busy.
            // The keep-alive success path (set(providerSessionId, ...) with
            // busy:false) overwrites this placeholder on success; the drop/abort/
            // catch paths delete it by requestedSessionId/providerSessionId (they
            // are equal here). Keyed by requestedSessionId === providerSessionId.
            nativeSessions.set(requestedSessionId, {
              session: null,
              metadata: null,
              repo: durableRepo,
              durable: true,
              busy: true,
            }, { idleTimeoutMs: sessionTtlMs });
            createdOnMissPlaceholder = true;
            session = await durableRepo.create({ id: providerSessionId, cwd: options.cwd || process.cwd() });
            createdOnMiss = true;
          }
        } else {
          return sessionUnavailableResult({
            resolved,
            options,
            events,
            runtimeWarnings,
            start,
            sessionId: requestedSessionId,
            errorMessage: `Pi session ${requestedSessionId} is not live`,
            failureKind: "session_not_found",
            piErrorCode: "pi_session_not_found",
          });
        }
      }
      if (entry && !createdOnMiss) {
        // The busy claim MUST stay await-free between the registry adoption
        // above and `entry.busy = true` below: get/set + this check/claim are
        // all synchronous, which is what makes the cold-resume race (F4) safe.
        // Do not introduce any await in this span or the TOCTOU window reopens.
        if (entry.busy) {
          return sessionUnavailableResult({
            resolved,
            options,
            events,
            runtimeWarnings,
            start,
            sessionId: requestedSessionId,
            errorMessage: `Pi session ${requestedSessionId} is busy with another turn`,
            failureKind: "session_busy",
            piErrorCode: "pi_session_busy",
          });
        }
        entry.busy = true;
        sessionEntry = entry;
        session = entry.session;
      }
    } else {
      // Fresh runs persist into the durable jsonl repo when piSessionsRoot is
      // set, so a kept-alive session can be reopened from disk after the live
      // entry is evicted; otherwise the in-memory repo is used.
      session = await (durableRepo || nativeSessionRepo)
        .create({ id: providerSessionId, cwd: options.cwd || process.cwd() });
    }

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
        dataDir: options.dataDir,
        cwd: options.cwd,
        onEvent,
        persistArtifact,
        onTruncate,
        toolLimits,
        toolPayloadMaxBytes: toolLimits.toolPayloadMaxBytes,
        toolPolicy: options.toolPolicy,
        sandboxPolicy: options.sandboxPolicy,
        sandboxEngine: options.sandboxEngine,
        approvalManager,
        approvalModel: runtime.model?.id || runtime.model?.name || resolved.model,
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
      });
    mcpClients = mcpInit.clients;
    for (const warning of mcpInit.warnings || []) onEvent(warning);

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

    harness = new AgentHarness({
      env: new NodeExecutionEnv({ cwd: options.cwd || process.cwd() }),
      session,
      model: runtime.model,
      thinkingLevel: effectiveThinkingLevel,
      systemPrompt: appendStructuredOutputInstruction(systemPrompt, options.outputSchema),
      tools,
      streamOptions: { maxRetries, maxRetryDelayMs },
      getApiKeyAndHeaders: async (model) => {
        const apiKey = await resolveApiKey(model.provider, {
          apiKeys: runtime.apiKeys,
          resolvePiApiKey: options.resolvePiApiKey,
          runtimeWarnings,
        });
        return apiKey ? { apiKey } : undefined;
      },
      steeringMode: toolSteeringMode,
      followUpMode: toolSteeringMode,
    });

    harness.subscribe((event) => {
      if (event.type === "message_update") {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent?.type === "text_delta" && streamEvent.delta) {
          textDeltaIndexes.add(streamContentKey(streamEvent, "text"));
          assistantTexts.push(streamEvent.delta);
          onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.delta }] } });
        } else if (streamEvent?.type === "text_end" && streamEvent.content) {
          const key = streamContentKey(streamEvent, "text");
          if (!textDeltaIndexes.has(key)) {
            assistantTexts.push(streamEvent.content);
            onEvent({ type: "assistant", message: { content: [{ type: "text", text: streamEvent.content }] } });
          }
        } else if (streamEvent?.type === "thinking_delta" && streamEvent.delta) {
          thinkingDeltaIndexes.add(streamContentKey(streamEvent, "thinking"));
          assistantThinking.push(streamEvent.delta);
          onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.delta }] } });
        } else if (streamEvent?.type === "thinking_end" && streamEvent.content) {
          const key = streamContentKey(streamEvent, "thinking");
          if (!thinkingDeltaIndexes.has(key)) {
            assistantThinking.push(streamEvent.content);
            onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: streamEvent.content }] } });
          }
        }
      } else if (event.type === "tool_execution_start") {
        if (event.toolName) lastToolName = event.toolName;
        if (event.toolCallId) toolStartTimes.set(event.toolCallId, Date.now());
        const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
        const progressText = toolStartProgressText(event.toolName);
        if (progressText) {
          onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: progressText }] } });
        }
        onEvent({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: event.toolCallId, name: event.toolName, input }] },
        });
      } else if (event.type === "tool_execution_update") {
        const input = eventToolArgs(event.toolName, event.args, { cwd: options.cwd, toolLimits });
        onEvent({
          type: "tool_update",
          tool_use_id: event.toolCallId,
          name: event.toolName,
          input,
          partial_result: jsonSerializable(event.partialResult, String(event.partialResult ?? "")),
        });
      } else if (event.type === "tool_execution_end") {
        const resultContent = toolResultContent(event.result);
        if (!event.isError) toolResultsSeen += 1;
        const startedAt = toolStartTimes.get(event.toolCallId);
        if (startedAt !== undefined) {
          toolStartTimes.delete(event.toolCallId);
          onEvent({
            type: "tool_timing",
            tool_use_id: event.toolCallId,
            name: event.toolName,
            execution_ms: Date.now() - startedAt,
            is_error: !!event.isError,
          });
        }
        onEvent({
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: event.toolCallId,
              content: resultContent,
              raw_result: compactToolRawResult(jsonSerializable(event.result, resultContent), resultContent),
              is_error: !!event.isError,
            }],
          },
        });
      } else if (event.type === "turn_end") {
        turnCount += 1;
        if (Number.isFinite(Number(options.maxTurns))
          && Number(options.maxTurns) > 0
          && turnCount >= Number(options.maxTurns)
          && event.message?.stopReason === "toolUse") {
          maxTurnsHit = true;
          harness.abort();
        }
      }
    });

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
    sessionBaselineCount = (await session.buildContext()).messages.length;
    if (!requestedSessionId || createdOnMiss) {
      for (const message of priorMessages) {
        await harness.appendMessage(message);
        sessionBaselineCount += 1;
      }
    }
    // The harness persists each turn INLINE into the live session. To preserve
    // the legacy "a failed resumed turn does not corrupt the session" contract,
    // remember the leaf before the run so a failed resume can be rolled back to
    // the last good transcript via the session tree's moveTo primitive. Only a
    // TRUE resume needs this: a create-on-miss session is fresh, so a failure
    // drops it entirely via the fresh-run path (no leaf to roll back to).
    if (requestedSessionId && !createdOnMiss) {
      try { baselineLeafId = await session.getLeafId(); } catch { /* best-effort */ }
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
      // Drop a freshly-created non-keep-alive session so an aborted-before-run
      // turn does not leave an orphan jsonl on disk. Guarded `session &&
      // !sessionEntry` so a resumed (user-owned) session is NEVER deleted —
      // identical to the outer catch guard. The finally block clears
      // sessionEntry.busy, removes the abort handler, and closes MCP clients.
      // For a resume no transcript was appended yet (prompt never ran), so the
      // live session is already at its pre-turn leaf and needs no rollback.
      if (session && !sessionEntry) {
        try { await (durableRepo || nativeSessionRepo).delete(await session.getMetadata()); } catch { /* best-effort */ }
      }
      // Drop the create-on-miss BUSY reservation too. The finally only clears
      // sessionEntry.busy (null here), so without this the busy placeholder leaks
      // and every future resume of this conversation's stable id returns
      // session_busy forever (busy entries are never idle-evicted). Mirrors the
      // lifecycle drop branch + outer catch cleanup.
      if (createdOnMissPlaceholder) nativeSessions.delete(providerSessionId);
      return abortedResult({ resolved, options, events, runtimeWarnings, start, providerSessionId });
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
      const context = await session.buildContext();
      const transcript = context.messages || [];
      const runTranscript = transcript.slice(sessionBaselineCount);
      const assistantMessages = runTranscript.filter((message) => message?.role === "assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      return {
        transcript,
        runTranscript,
        assistantMessages,
        lastAssistant,
        stopReason: lastAssistant?.stopReason || null,
        finalText: textFromContent(lastAssistant?.content) || assistantTexts.join(""),
        finalThinking: thinkingFromContent(lastAssistant?.content) || assistantThinking.join(""),
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
      maxTurnsHit,
    })) {
      structuredOutputFinalizationRetryAttempts = 1;
      structuredOutputFinalizationRetryReason = "empty_final_output";
      runtimeWarnings.push({
        warning_kind: "structured_output_finalization_retry",
        source: "pi",
        reason: structuredOutputFinalizationRetryReason,
        message: "Pi stopped without text or structured output; retrying once in the same session with only StructuredOutput enabled.",
      });
      const previousActive = harness.getActiveTools().map((toolDef) => toolDef.name);
      try {
        // The harness is idle after waitForIdle(), so re-prompt (not followUp,
        // which only queues onto an active run) with only StructuredOutput
        // active. This re-prompts ONCE in the same session, matching the legacy
        // single agent.continue() finalization re-prompt.
        await harness.setActiveTools(structuredTool ? [structuredTool.name] : []);
        await harness.prompt(structuredOutputFinalizationPrompt());
        await harness.waitForIdle();
      } catch (err) {
        runtimeWarnings.push({
          warning_kind: "structured_output_finalization_retry_failed",
          source: "pi",
          message: err?.message || String(err),
        });
      } finally {
        try { await harness.setActiveTools(previousActive); } catch { /* best-effort */ }
      }
      structuredOutputFinalizationRetryFailed = structuredResult === null || structuredResult === undefined;
      state = await captureState();
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
    if (usage.cacheRead > 0) {
      onEvent({ type: "cache_hit", sdk: resolved.sdk, model: reference, tokens: usage.cacheRead, source: "prompt_cache" });
    }
    if (usage.cacheWrite > 0) {
      onEvent({ type: "cache_miss", sdk: resolved.sdk, model: reference, tokens: usage.cacheWrite, source: "prompt_cache" });
    }
    onEvent({
      type: "cost_accumulated",
      sdk: resolved.sdk,
      model: reference,
      cumulativeUsd: Number(usage.cost) || Number(estimatedCost) || 0,
      tokens: {
        input: Number(usage.input) || 0,
        output: Number(usage.output) || 0,
        cacheReadTokens: Number(usage.cacheRead) || 0,
        cacheCreationTokens: Number(usage.cacheWrite) || 0,
      },
    });
    onEvent({
      type: "provider_request_completed",
      sdk: resolved.sdk,
      model: reference,
      runtime: "pi",
      timestamp: Date.now(),
      durationMs: Date.now() - start,
      cancelled: externalAbort,
    });

    const rawErrorMessage = externalAbort
      ? null
      : maxTurnsHit
        ? "Pi agent stopped before final output: max turns reached"
        : (stopReason === "error" || stopReason === "aborted"
          ? lastAssistant?.errorMessage || runError?.message || "Pi agent aborted before final output"
          : (runError ? runError.message || String(runError) : null));
    const errorMessage = normalizePiErrorMessage(rawErrorMessage);

    const diagnostics = {
      provider_session_id: providerSessionId,
      pi_stop_reason: stopReason,
      pi_engine: "native",
      max_turns_hit: maxTurnsHit,
      max_turns: Number.isFinite(Number(options.maxTurns)) ? Number(options.maxTurns) : null,
      turn_count: turnCount || runAssistantCount,
      external_abort: externalAbort,
      pi_max_retries: maxRetries,
      ...(lastToolName ? { last_tool_name: lastToolName } : {}),
      ...structuredOutputRetryDiagnostics(
        structuredOutputFinalizationRetryAttempts,
        structuredOutputFinalizationRetryReason,
        structuredOutputFinalizationRetryFailed,
      ),
    };
    const errorDetails = errorMessage ? {
      pi_stop_reason: stopReason || "error",
      last_tool_name: lastToolName,
      tool_results_seen: toolResultsSeen,
      turn_count: turnCount || runAssistantCount,
      max_turns_hit: maxTurnsHit,
      provider_session_id: providerSessionId,
      pi_engine: "native",
      ...structuredOutputRetryDiagnostics(
        structuredOutputFinalizationRetryAttempts,
        structuredOutputFinalizationRetryReason,
        structuredOutputFinalizationRetryFailed,
      ),
    } : null;

    const capabilitiesUsed = buildCapabilitiesUsed({
      promptCacheActive: usage.cacheRead > 0 || usage.cacheWrite > 0,
      thinkingEnabled: effectiveThinkingLevel !== "off" && effectiveThinkingLevel !== "low",
      structuredOutputEnforced: !!options.outputSchema,
      subagentInvoked: false,
      mcpServersUsed: mcpClients.map((entry) => entry?.name).filter(Boolean),
      nativeSubagentsUsed: [],
      toolCompactionApplied: toolCompactionAppliedFromWarnings(runtimeWarnings),
      // null = unknown/unsupported (tristate). AgentHarness performs no automatic
      // in-loop compaction (no transformContext hook), so we cannot honestly
      // assert it "did not apply" — false would imply a compaction path exists
      // and chose not to fire. See docs/feature-registry.md runtime.context-compaction.
      contextCompactionApplied: null,
    });
    onEvent({ type: "capabilities_resolved", sdk: resolved.sdk, model: reference, capabilitiesUsed });

    // Re-check the abort signal: a cancel can land during the post-run work above
    // (live-input teardown, structured-output finalization retry) after the line
    // ~780 check. Pick it up here so the lifecycle decision below rolls back the
    // cancelled turn instead of committing it into a durable transcript a later
    // resume would replay.
    externalAbort ||= !!options.abortSignal?.aborted;

    // Session lifecycle parity with the legacy bridge. The harness already
    // durably persisted the transcript into its session object (in-memory for
    // the default repo, jsonl on disk when piSessionsRoot is set); the registry
    // tracks LIVENESS so disposeProviderSession / idle-TTL eviction can reach
    // native sessions, and a resume miss reports session_not_found.
    if (options.sessionKeepAlive === true && !externalAbort && !errorMessage) {
      try {
        if (sessionEntry) {
          // Resumed run: the harness appended this run's turns onto the live
          // session; just re-arm the idle window.
          nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs });
          // Surface a write failure the harness swallowed: a session that can
          // no longer persist must not pretend to be resumable.
          await session.buildContext();
        } else {
          const metadata = await session.getMetadata();
          nativeSessions.set(providerSessionId, {
            session,
            metadata,
            repo: durableRepo || nativeSessionRepo,
            durable: !!durableRepo,
            busy: false,
          }, { idleTimeoutMs: sessionTtlMs });
        }
      } catch (err) {
        // Session persistence must never fail the run; drop the (now
        // inconsistent) session instead of resuming from a broken transcript.
        onEvent({
          type: "runtime_warning",
          warning_kind: "pi_session_persist_failed",
          message: err?.message || String(err),
        });
        nativeSessions.delete(providerSessionId);
        if (requestedSessionId) nativeSessions.delete(requestedSessionId);
        const broken = sessionEntry;
        if (broken) {
          try { await broken.repo.delete(broken.metadata); } catch { /* best-effort */ }
        }
      }
    } else if (sessionEntry) {
      // Resumed run that errored (or was aborted): roll the live session back to
      // the leaf captured before this turn so the failed turn never leaks into a
      // later resume. The next resume then sees the last good transcript. The
      // entry stays live (busy is cleared in finally) and its idle TTL re-arms.
      if (baselineLeafId && (errorMessage || externalAbort)) {
        try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
      }
      nativeSessions.touch(requestedSessionId, { idleTimeoutMs: sessionTtlMs });
    } else {
      // Fresh, non-keep-alive (or failed first) run: never leave a live session
      // behind. A durable jsonl transcript on disk is dropped too, matching the
      // legacy default contract that a non-keep-alive run is not resumable.
      // A create-on-miss BUSY placeholder (R8) is keyed under
      // requestedSessionId === providerSessionId; drop it here too so a
      // non-keep-alive / errored / aborted first turn never leaks a busy entry
      // (the success keep-alive path overwrites it with the finalized entry, so
      // it is only this drop branch that must clean it up).
      if (createdOnMissPlaceholder) nativeSessions.delete(providerSessionId);
      try {
        await (durableRepo || nativeSessionRepo).delete(await session.getMetadata());
      } catch { /* best-effort */ }
    }

    // Final abort guard (durable cancel TOCTOU): if a cancel raced the lifecycle
    // commit above — landing AFTER the keep-alive/!externalAbort decision but
    // before this return — the cancelled turn is still in the durable transcript
    // and (for keep-alive) the live registry. Roll it back so the next resume sees
    // the pre-turn state: a resumed session moves to its baseline leaf and drops
    // its live entry; a fresh durable session deletes its jsonl. There is no await
    // between here and the return, so an external cancel cannot newly fire past it.
    if (!externalAbort && options.abortSignal?.aborted) {
      externalAbort = true;
      if (sessionEntry) {
        if (baselineLeafId) {
          try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
        }
        nativeSessions.delete(requestedSessionId);
      } else {
        nativeSessions.delete(providerSessionId);
        try { await (durableRepo || nativeSessionRepo).delete(await session.getMetadata()); } catch { /* best-effort */ }
      }
    }

    return {
      text: finalText,
      thinking: finalThinking,
      events,
      usage: {
        input_tokens: usage.input || null,
        output_tokens: usage.output || null,
        cache_read_tokens: usage.cacheRead || null,
        cache_creation_tokens: usage.cacheWrite || null,
        cache_write_tokens: usage.cacheWrite || null,
        cost_usd: usage.cost || estimatedCost,
      },
      durationMs: Date.now() - start,
      numTurns: turnCount || runAssistantCount,
      model: resolved.reference || `pi:${resolved.provider}:${resolved.model}`,
      effort: options.effort || null,
      sdk: resolved.sdk,
      cancelled: externalAbort,
      error: errorMessage,
      errorDetails,
      failureKind: errorMessage
        ? failureKindForPiError(errorMessage, diagnostics, { maxTurnsHit })
        : null,
      providerSessionId,
      runtimeWarnings,
      diagnostics,
      capabilitiesUsed,
      ...(structuredResult !== null && structuredResult !== undefined
        ? { structuredResult, structuredResultSource: "StructuredOutput" }
        : { structuredResult: undefined, structuredResultSource: null }),
    };
  } catch (err) {
    externalAbort ||= !!options.abortSignal?.aborted;
    // Drop a just-created FRESH durable session so a setup/run failure does not
    // leave a resumable orphan jsonl on disk (the success path drops it at ~905;
    // the catch must mirror that). Guarded: `session && !sessionEntry` fires only
    // for fresh runs that actually created a session — NEVER for resumes
    // (sessionEntry is non-null only on resume; deleting a resumed user session
    // here would be data loss) and never when the throw preceded session create.
    if (session && !sessionEntry) {
      try { await (durableRepo || nativeSessionRepo).delete(await session.getMetadata()); } catch { /* best-effort */ }
    }
    // Drop a create-on-miss BUSY placeholder (R8) left in the registry by a throw
    // during/after the reservation — including a throw inside the create await
    // itself, where `session` is still null so the jsonl-delete above is skipped.
    // Keyed under requestedSessionId === providerSessionId; never set on a resume
    // (sessionEntry would be non-null), so this never deletes a live user session.
    if (createdOnMissPlaceholder && !sessionEntry) nativeSessions.delete(providerSessionId);
    // Resumed-session rollback for host/runtime-side throws (e.g. a throwing
    // custom pricing resolver / bridge event callback) that land here AFTER the
    // harness already mutated the live session. Mirrors the success-path
    // rollback at ~:925-932: move the live session back to the pre-turn leaf so
    // the failed turn never leaks into a later resume. Gated on `sessionEntry &&
    // baselineLeafId` so it only fires for resumes that captured a baseline.
    if (sessionEntry && baselineLeafId) {
      try { await session.moveTo(baselineLeafId); } catch { /* best-effort */ }
    }
    const errorMessage = normalizePiErrorMessage(err?.message || String(err));
    const isRetryable = retryableProviderFailureInfo({
      errorText: errorMessage,
      failureKind: "provider_unavailable",
    }).retryable;
    return {
      text: assistantTexts.join("") || null,
      events,
      usage: {},
      durationMs: Date.now() - start,
      numTurns: turnCount,
      model: resolved?.reference || resolved?.model || null,
      effort: options.effort || null,
      sdk: resolved?.sdk || "pi",
      cancelled: externalAbort,
      error: externalAbort ? null : errorMessage,
      errorDetails: externalAbort ? null : {
        pi_stop_reason: "error",
        last_tool_name: lastToolName,
        tool_results_seen: toolResultsSeen,
        turn_count: turnCount,
        max_turns_hit: maxTurnsHit,
        provider_session_id: providerSessionId,
        pi_engine: "native",
        pi_error_retryable: isRetryable,
      },
      failureKind: externalAbort ? null : failureKindForPiError(errorMessage, {}, { maxTurnsHit }),
      providerSessionId,
      runtimeWarnings,
      diagnostics: {
        provider_session_id: providerSessionId,
        pi_stop_reason: externalAbort ? "aborted" : "error",
        pi_engine: "native",
        max_turns_hit: maxTurnsHit,
        turn_count: turnCount,
        external_abort: externalAbort,
      },
    };
  } finally {
    if (sessionEntry) sessionEntry.busy = false;
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
