// Conversation-continuity benchmark runner.
//
// Every turn goes through the production configured host path:
// resolveJsonMonoAgentConfig -> createConfiguredAgentRuntime ->
// createConfiguredConversationHarness (durable canonical history, tool-history
// sidecar, continuous durable Pi sessions). Scripted history turns are served by
// Pi's faux provider posing as the bound model through the runtime's
// `piResolvedModel` seam; tools are real MCP calls to a loopback fixture server.
// Live turns (probes, the mid-trace checkpoint of arm d) use the real provider in
// paid mode and a scripted contract reader offline.
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile, realpath, lstat } from "node:fs/promises";
import { dirname, join, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { armById, checkpointKey, mergePatch, pressureMetrics, verifyBoundary, verifyPressure, verifyStore } from "./continuity-arms.mjs";
import { traceShape } from "./continuity-generator.mjs";
import { probePrompt, scoreAnswer, judgePrompt, parseJudgeVerdict } from "./continuity-score.mjs";
import { sourceOnly, traceFamily } from "./continuity-dataset.mjs";
import { FIXTURE_SERVER_NAME, startFixtureTools } from "./continuity-tools.mjs";

export const OFFLINE_ANSWER = "Scripted contract response; semantic correctness is not evaluated.";
export const OFFLINE_SUMMARY = "Scripted offline compaction summary for the contract run; it carries no conversation facts.";
const SUMMARY_MARKER = "Mono-agent summary focus";
const CHILD_ENTRY = fileURLToPath(new URL("./continuity-probe-child.mjs", import.meta.url));
const SCRIPTED_API_PREFIX = "continuity-scripted";
const FATAL_FAILURE_KINDS = new Set(["provider_auth", "usage_limit"]);
const IDENTITY = [
  "You are Mono, the owner's personal assistant in an ongoing chat.",
  "Follow the owner's standing instructions for the whole conversation unless they explicitly change them.",
  "Be concise. When asked for a specific value, give just that value.",
].join("\n");

export class ContinuityError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.code = code;
  }
}
export function codeOf(error) { return error instanceof ContinuityError ? error.code : "operation_failed"; }

/** Repository-local built imports, plus Pi's faux provider from the runtime's own exact dependency. */
export async function productionModules(root) {
  const piPackage = JSON.parse(await readFile(join(root, "packages/turn/node_modules/@earendil-works/pi-ai/package.json"), "utf8"));
  const entry = piPackage.exports?.["."]?.import;
  if (typeof entry !== "string") throw new ContinuityError("pi_ai_entry_unavailable");
  const [config, app, hostRuntime, hostConfig, turnRoot, pi, coordinator, providers] = await Promise.all([
    import(pathToFileURL(join(root, "packages/config/dist/index.js")).href),
    import(pathToFileURL(join(root, "packages/app/dist/index.js")).href),
    import("@mono-agent/turn/host"),
    import("@mono-agent/turn/host/config"),
    import("@mono-agent/turn"),
    import(pathToFileURL(join(root, "packages/turn/node_modules/@earendil-works/pi-ai", entry)).href),
    import(pathToFileURL(join(root, "packages/app/dist/durable-state/agent-root-coordinator.js")).href),
    import(pathToFileURL(join(root, "packages/turn/node_modules/@earendil-works/pi-ai", piPackage.exports["./providers/*"].import.replace("*", "all"))).href),
  ]);
  for (const name of ["createConfiguredConversationHarness", "createConfiguredAgentRuntime"]) {
    if (typeof app[name] !== "function") throw new ContinuityError("production_module_missing", name);
  }
  const host = { createMonoRuntime: hostRuntime.createMonoRuntime, parseMonoRuntimeModelReference: hostConfig.parseMonoRuntimeModelReference,
    createPiOAuthApiKeyResolver: turnRoot.createPiOAuthApiKeyResolver };
  for (const name of ["createMonoRuntime", "createPiOAuthApiKeyResolver", "parseMonoRuntimeModelReference"]) {
    if (typeof host[name] !== "function") throw new ContinuityError("production_module_missing", name);
  }
  if (typeof config.resolveJsonMonoAgentConfig !== "function" || typeof pi.fauxProvider !== "function") throw new ContinuityError("production_module_missing");
  const conversation = await import("@mono-agent/conversation");
  if (typeof conversation.ToolHistoryReader !== "function") throw new ContinuityError("production_module_missing", "ToolHistoryReader");
  return { config, app, host, pi: { ...pi, builtinModels: providers.builtinModels }, conversation, coordinator };
}

/** Faux models posing as the given bound references (one faux provider per provider id). */
export function scriptedModels(pi, refs) {
  const models = pi.createModels();
  const byProvider = new Map();
  for (const ref of refs) {
    const ids = byProvider.get(ref.provider) ?? new Set();
    ids.add(ref.model); byProvider.set(ref.provider, ids);
  }
  const fauxByProvider = new Map();
  for (const [provider, ids] of byProvider) {
    const faux = pi.fauxProvider({
      provider, api: `${SCRIPTED_API_PREFIX}-${provider}`, tokensPerSecond: undefined,
      models: [...ids].map((id) => ({ id, contextWindow: 272000, maxTokens: 128000, reasoning: false })),
    });
    models.setProvider(faux.provider);
    fauxByProvider.set(provider, faux);
  }
  return {
    models,
    route(options) {
      const ref = options.model;
      const faux = fauxByProvider.get(ref?.provider);
      const model = faux?.getModel(ref?.model);
      if (!model) throw new ContinuityError("scripted_route_unbound");
      return { faux, model };
    },
    /** Install one dispatcher for every call this faux may receive in the next run. */
    respondWith(ref, dispatcher, count = 64) {
      const faux = fauxByProvider.get(ref.provider);
      if (!faux) throw new ContinuityError("scripted_route_unbound");
      faux.setResponses(Array.from({ length: count }, () => dispatcher));
    },
  };
}

function controlledRuntime(base, route) {
  return new Proxy(base, {
    get(target, key) {
      if (key === "run") return async (prompt, options) => target.run(prompt, { ...options, ...route(options) });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Base config for one workspace; the arm's `configPatch` is merged last. */
export function configJson({ work, authPath, model, effort, tools, configPatch }) {
  return mergePatch({
    runtime: {
      model, workspace: work,
      ...(effort ? { effort } : {}),
      session: { root: join(work, "sessions"), mode: "continuous", idleTimeoutMs: 3_600_000, continuity: { ledgerEnabled: false, upkeep: { enabled: false } } },
    },
    providers: { piAuthPath: authPath },
    context: { identityPath: join(work, "IDENTITY.md") },
    tools: { allowedTools: [], ...(tools ? { mcpConfigPath: join(work, "fixture-mcp.json") } : {}) },
    artifacts: { dir: join(work, "artifacts") },
  }, configPatch ?? {});
}

async function openHarness({ modules, work, authPath, model, effort, tools, configPatch, route, clock, onHistoryWarning = () => {}, hostOptions = {} }) {
  const json = configJson({ work, authPath, model, effort, tools, configPatch });
  const config = modules.config.resolveJsonMonoAgentConfig({ json, cwd: work });
  // Existing reentrant ownership seam: establish the isolated physical lease
  // before either configured runtime can lazily acquire its own reference.
  const homeDir = join(dirname(work), "lease-home");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const ownership = await modules.coordinator.acquireAgentRootOwnership(work, { homeDir });
  let runtime, harness, closing;
  // The harness does not own an injected runtime. Close both exactly once,
  // then release the isolated physical lease, including failed setup paths.
  const close = () => closing ??= (async () => {
    try { await harness?.dispose?.(); }
    finally {
      try { await runtime?.disposeAllSessions?.(); }
      finally { await modules.coordinator.releaseAgentRootOwnershipWhenIdle(ownership); }
    }
  })();
  try {
    runtime = controlledRuntime(modules.app.createConfiguredAgentRuntime({ config, cwd: work, model: config.runtime.model }), route);
    // Tool-history/continuity outages are fail-open in production (warnings only);
    // the benchmark counts them so a degraded store invalidates the sample.
    harness = await modules.app.createConfiguredConversationHarness({ config, cwd: work, runtime, now: () => clock.value, ...hostOptions,
      onToolHistoryWarning: () => onHistoryWarning() });
    return { harness, config, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Retained-evidence statistics for a workspace's sidecar (content-free counts only). */
export function continuityStats(modules, work) {
  const stats = new modules.conversation.ToolHistoryReader(join(work, "history")).stats();
  const continuity = stats?.continuity;
  return continuity === undefined ? null : { records: continuity.records, generations: continuity.generations, prepared: continuity.prepared,
    retainedBytes: continuity.retainedBytes, degraded: continuity.degraded === true, coverageGaps: continuity.coverageGaps };
}

const HISTORY_TOOL = /(?:^|__)ConversationHistory$/u;
/** Classify one ConversationHistory result from its model-visible text. */
export function classifyHistoryResult(text, isError) {
  const body = String(text ?? "");
  const unavailable = body.includes('"status":"unavailable"') || body.includes('"available":false');
  if (unavailable && (!/"code":"/u.test(body) || body.includes('"code":"history_unavailable"'))) return { outcome: "unavailable", count: null };
  if (isError || unavailable) return { outcome: "error", count: null };
  const count = /"count":(\d+)/u.exec(body);
  return { outcome: "success", count: count ? Number(count[1]) : null };
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
export function runUsage(usage) {
  return {
    calls: 1,
    inputTokens: finite(usage?.input_tokens),
    outputTokens: finite(usage?.output_tokens),
    cacheReadTokens: finite(usage?.cache_read_tokens),
    cacheWriteTokens: finite(usage?.cache_write_tokens ?? usage?.cache_creation_tokens),
    estimatedCostUsd: finite(usage?.cost_usd),
  };
}
/** The compaction slice is already included once in the run totals. */
export function compactionUsageOf(usage) {
  const requests = Array.isArray(usage?.compaction?.requests) ? usage.compaction.requests : [];
  const total = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, unknownCostCalls: 0, unknownTokenCalls: 0 };
  for (const row of requests) {
    if (row?.providerInvoked === false) continue;
    total.calls += 1;
    let unknown = false;
    for (const [field, keys] of [["inputTokens", ["input_tokens", "input"]], ["outputTokens", ["output_tokens", "output"]],
      ["cacheReadTokens", ["cache_read_tokens", "cacheRead"]], ["cacheWriteTokens", ["cache_write_tokens", "cacheWrite"]]]) {
      const value = keys.map((key) => finite(row?.[key])).find((candidate) => candidate !== null) ?? null;
      if (value === null) unknown = true; else total[field] += value;
    }
    if (unknown) total.unknownTokenCalls += 1;
    const cost = finite(row?.cost_usd) ?? finite(row?.costUsd);
    if (cost === null) total.unknownCostCalls += 1; else total.estimatedCostUsd += cost;
  }
  return total;
}

function observer() {
  const observed = { boundaries: [], compactions: [], warnings: 0, steersAccepted: 0, historyWarnings: 0, toolsOffered: [],
    conversationHistory: { calls: 0, search: 0, get: 0, success: 0, unavailable: 0, error: 0, hits: 0 }, continuityPacks: [], upkeep: [], offlineProviderPackCounts: [], offlineLedgerCounts: [] };
  const historyCalls = new Map();
  let steerWaiter = null;
  return {
    observed,
    noteOffered(options) {
      const offered = new Set(observed.toolsOffered);
      if (Object.keys(options?.mcpServers ?? {}).includes("mono-agent-conversation-history")) offered.add("ConversationHistory");
      observed.toolsOffered = [...offered];
    },
    noteHistoryWarning() { observed.historyWarnings += 1; },
    noteOfflineContext(context) {
      observed.offlineLedgerCounts.push((context.messages ?? []).filter(message => textOfContent(message.content).includes("### Continuity ledger")).length);
      observed.offlineProviderPackCounts.push((context.messages ?? []).filter(message => textOfContent(message.content).includes("### Conversation continuity pack")).length);
    },
    onEvent(event) {
      for (const block of Array.isArray(event?.message?.content) ? event.message.content : []) {
        if (event.type === "assistant" && block?.type === "tool_use" && HISTORY_TOOL.test(String(block.name ?? ""))) {
          const input = block.input && typeof block.input === "object" ? block.input : {};
          const action = input.action ?? (input.recordId === undefined ? "search" : "get");
          historyCalls.set(block.id, action);
          observed.conversationHistory.calls += 1;
          observed.conversationHistory[action === "get" ? "get" : "search"] += 1;
        } else if (event.type === "user" && block?.type === "tool_result" && historyCalls.has(block.tool_use_id)) {
          const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          const { outcome, count } = classifyHistoryResult(text, block.is_error === true);
          observed.conversationHistory[outcome] += 1;
          if (count !== null) observed.conversationHistory.hits += count;
        }
      }
      if (event?.type === "continuity_pack_injected") {
        observed.continuityPacks.push(Object.fromEntries(["reason", "ownerEntries", "toolEntries", "summaryEntries", "evidenceEntries", "omittedCount", "unknownOverlap", "ownerDeduped", "toolReserved", "ledgerEntries", "tokens", "degradedReason"].map(key => [key, event[key]])));
      } else if (event?.type === "continuity_upkeep") {
        observed.upkeep.push({ ...event });
      } else if (event?.type === "session_boundary") {
        observed.boundaries.push({ kind: event.kind ?? null, reason: event.reason ?? null, context: event.context ?? null,
          replayedMessageCount: finite(event.replayedMessageCount), toolProjectionRecords: finite(event.toolProjectionRecords), toolProjectionBytes: finite(event.toolProjectionBytes) });
      } else if (event?.type === "context_compaction" && event.status !== "running") {
        observed.compactions.push({ status: event.status ?? null, trigger: event.trigger ?? null, tokensBefore: finite(event.tokensBefore), tokensAfter: finite(event.tokensAfter),
          ...(typeof event.reason === "string" ? { reason: event.reason } : {}), ...(event.midRun === true || event.accounting?.midRun === true ? { midRun: true } : {}) });
        if (process.env.CONTINUITY_DEBUG === "1" && event.status !== "succeeded") process.stderr.write(`compaction ${JSON.stringify(event).slice(0, 1500)}\n`);
      } else if (event?.type === "runtime_warning") {
        observed.warnings += 1;
      } else if (event?.type === "live_input_native_accepted") {
        observed.steersAccepted += 1;
        steerWaiter?.();
      }
    },
    waitForSteer(timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { steerWaiter = null; reject(new ContinuityError("replay_steer_not_accepted")); }, timeoutMs);
        steerWaiter = () => { clearTimeout(timer); steerWaiter = null; resolve(); };
      });
    },
  };
}

function textOfContent(content) {
  return typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : "";
}

/** Opaque per-checkpoint conversation identity; the arm name never becomes model-visible. */
function conversationIdFor(traceId, key) {
  return `web:continuity-${traceId}-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}

async function prepareWorkspace(work) {
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "IDENTITY.md"), `${IDENTITY}\n`, { mode: 0o600 });
}

/** One scripted owner turn through the production harness. */
async function replayScriptedTurn({ harness, scripted, tools, turn, binding, conversationId, owner, pi }) {
  let cursor = 0;
  let failure = null;
  let pendingSteer = null;
  const watch = observer();
  const dispatcher = async (context) => {
    try {
      const step = turn.steps[cursor];
      cursor += 1;
      if (!step) throw new ContinuityError("replay_step_overflow", turn.id);
      if (pendingSteer !== null) {
        const last = context.messages?.at(-1);
        if (last?.role !== "user" || !textOfContent(last.content).includes(pendingSteer)) throw new ContinuityError("replay_steer_not_delivered", turn.id);
        pendingSteer = null;
      }
      if (step.call) {
        tools.expect(step.call.tool, step.call.args, step.call.result);
        if (step.steer) {
          const offer = harness.offerLiveInput?.({ conversationId, id: `${turn.id}-steer`, text: step.steer,
            receivedAt: new Date(Date.parse(turn.at) + 60_000).toISOString() });
          if (offer?.status !== "accepted") throw new ContinuityError("replay_steer_refused", turn.id);
          await watch.waitForSteer();
          pendingSteer = step.steer;
        }
        return pi.fauxAssistantMessage([
          ...(step.say ? [pi.fauxText(step.say)] : []),
          pi.fauxToolCall(step.call.tool, step.call.args, { id: `call_${turn.id}_${cursor}` }),
        ], { stopReason: "toolUse" });
      }
      return pi.fauxAssistantMessage(step.reply);
    } catch (error) {
      failure ??= error instanceof ContinuityError ? error : new ContinuityError("replay_dispatch_failed", turn.id);
      throw failure;
    }
  };
  scripted.respondWith(binding, dispatcher, turn.steps.length + 4);
  const response = await harness.run({
    conversationId, userMessage: turn.user, abortSignal: AbortSignal.timeout(60_000),
    captureSpeakerKind: "human-turn", metadata: { source: "web" }, sender: { displayName: owner }, onEvent: watch.onEvent,
  });
  if (failure) throw failure;
  if (response.failure) throw new ContinuityError("replay_turn_failed", turn.id);
  if (cursor !== turn.steps.length) throw new ContinuityError("replay_step_mismatch", turn.id);
  if (tools.pending() !== 0 || tools.mismatches().length > 0) throw new ContinuityError("replay_tool_mismatch", turn.id);
  if (watch.observed.boundaries.some((row) => row.kind === "resume_replay")) throw new ContinuityError("replay_unexpected_boundary", turn.id);
  return { toolCalls: turn.steps.filter((step) => step.call).length, steers: watch.observed.steersAccepted };
}

/** One live turn (probe or mid-trace checkpoint) through a tool-free production harness. */
function liveRoute(modules, mode, refs, watch = null) {
  if (mode !== "offline") return (options) => { watch?.noteOffered(options); return {}; };
  const scripted = scriptedModels(modules.pi, refs);
  // The offline contract reader calls ConversationHistory once when it is
  // offered, so CI exercises the real tool, store and recording path.
  const dispatcher = (context) => {
    // Summary requests carry Pi's summary focus in the system prompt or a system message.
    const system = [context.systemPrompt, ...(context.messages ?? []).filter((message) => message.role === "system").map((message) => textOfContent(message.content))].join("\n");
    if (system.includes(SUMMARY_MARKER)) return modules.pi.fauxAssistantMessage(OFFLINE_SUMMARY);
    watch?.noteOfflineContext(context);
    const last = context.messages?.at(-1);
    if (watch?.observed.toolsOffered.includes("ConversationHistory") && last?.role !== "toolResult") {
      return modules.pi.fauxAssistantMessage([modules.pi.fauxToolCall("ConversationHistory", { action: "search", query: "order", limit: 3 }, { id: "call_offline_history" })], { stopReason: "toolUse" });
    }
    return modules.pi.fauxAssistantMessage(OFFLINE_ANSWER);
  };
  for (const ref of refs) scripted.respondWith(ref, dispatcher);
  return (options) => { watch?.noteOffered(options); const { model } = scripted.route(options); return { piResolvedModel: model, piResolvedModels: scripted.models }; };
}

export async function runLiveTurn({ modules, work, authPath, plan, mode, configPatch, userMessage, clock, conversationId, owner }) {
  const reader = modules.host.parseMonoRuntimeModelReference(plan.reader.model);
  const watch = observer();
  const route = liveRoute(modules, mode, [reader], watch);
  const { harness, close } = await openHarness({ modules, work, authPath, model: plan.reader.model, effort: plan.reader.effort, tools: false, configPatch, route, clock,
    onHistoryWarning: () => watch.noteHistoryWarning() });
  const started = performance.now();
  let response;
  try {
    response = await harness.run({
      conversationId, userMessage, abortSignal: AbortSignal.timeout(plan.limits.perLiveTurnTimeoutMs),
      captureSpeakerKind: "human-turn", metadata: { source: "web" }, sender: { displayName: owner }, onEvent: watch.onEvent,
    });
  } finally { await close(); }
  const usage = response.metadata?.runtime?.usage;
  return {
    text: typeof response.text === "string" ? response.text : null,
    failureKind: response.failure ? String(response.failure.kind ?? "unknown") : null,
    observed: watch.observed,
    usage: runUsage(usage),
    compactionUsage: compactionUsageOf(usage),
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * Replay a trace into a fresh workspace up to its checkpoint. Arms without a
 * live mid-trace turn produce identical scripted state and share one checkpoint.
 */
export async function buildCheckpoint({ modules, trace, arm, repeat, dir, plan, mode, authPath, captureUpkeepOutput }) {
  const source = sourceOnly(trace);
  const work = join(dir, "work");
  await prepareWorkspace(work);
  const reader = modules.host.parseMonoRuntimeModelReference(plan.reader.model);
  const alternate = modules.host.parseMonoRuntimeModelReference(plan.alternateBinding.model);
  const binding = arm.replayBinding === "alternate" ? alternate : reader;
  const scripted = scriptedModels(modules.pi, [reader, alternate]);
  const route = (options) => {
    const { model } = scripted.route(options);
    // A scripted turn cannot produce a real summary: never compact while replaying.
    return { piResolvedModel: model, piResolvedModels: scripted.models, compaction: { ...(options.compaction ?? {}), enabled: false } };
  };
  const tools = await startFixtureTools();
  await writeFile(join(work, "fixture-mcp.json"), JSON.stringify({ mcpServers: { [FIXTURE_SERVER_NAME]: { type: "http", url: tools.url } } }), { mode: 0o600 });
  const clock = { value: new Date(source.turns[0].at) };
  const key = checkpointKey(arm, repeat);
  const conversationId = conversationIdFor(source.id, key);
  const record = { key, conversationId, traceId: source.id, arm: arm.midCheckpoint === null && !arm.ledgerUpkeep ? null : arm.id, repeat: arm.midCheckpoint === null && !arm.ledgerUpkeep ? null : repeat,
    binding: binding.reference, turns: 0, toolCalls: 0, steers: 0, mid: null, durationMs: 0 };
  const started = performance.now();
  let open = null;
  let replayHistoryWarnings = 0;
  try {
    try {
      for (const turn of source.turns) {
        clock.value = new Date(turn.at);
        if (arm.midCheckpoint !== null && turn.id === source.midCheckpoint) {
          // Promptless manual compaction before the mid-trace turn: the same
          // guarded production summary driver, with no live reply in history.
          if (open) { await open.close(); open = null; }
          record.mid = await manualCompaction({ modules, work, authPath, plan, mode, binding, configPatch: mergePatch(arm.sessionConfig ?? {}, arm.midCheckpoint.config), clock, conversationId, turnId: turn.id });
          if (!record.mid.boundary.verified) throw new ContinuityError("mid_checkpoint_boundary_unverified", record.mid.boundary.reasons.join(","));
        }
        open ??= await openHarness({ modules, work, authPath, model: binding.reference, effort: undefined, tools: true, configPatch: arm.sessionConfig ?? {}, route, clock,
          onHistoryWarning: () => { replayHistoryWarnings += 1; } });
        const result = await replayScriptedTurn({ harness: open.harness, scripted, tools, turn, binding, conversationId, owner: source.owner.displayName, pi: modules.pi });
        record.turns += 1; record.toolCalls += result.toolCalls; record.steers += result.steers;
      }
      if (arm.ledgerUpkeep) {
        if (open) { await open.close(); open = null; }
        record.upkeep = await prepareLedgerCheckpoint({ modules, work, authPath, plan, mode, reader, alternate, scripted, route, clock, conversationId, captureUpkeepOutput });
      }
    } finally {
      try { if (open) await open.close(); }
      finally { await tools.close(); }
      record.durationMs = Math.round(performance.now() - started);
    }
    if (arm.sessionConfig?.runtime?.session?.continuity?.enabled === true) {
      record.continuity = { ...continuityStats(modules, work), replayHistoryWarnings };
    }
    if (arm.fork === "in-place") {
      // The sidecar pins this absolute root; probes restore the snapshot here.
      const snapshot = join(dir, "snapshot");
      await cp(work, snapshot, { recursive: true, verbatimSymlinks: true });
      return { work, snapshot, record };
    }
    return { work, record };
  } catch (error) {
    // Preserve paid work even when cleanup, statistics or fork publication fails.
    const failure = new ContinuityError(error?.code ?? "checkpoint_failed");
    failure.checkpointRecord = record;
    throw failure;
  }
}

async function prepareCapturePath(path) {
  if (!isAbsolute(path)) throw new ContinuityError("capture_requires_external_output");
  const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  const outside = value => { const rel = relative(root, value); return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel); };
  let ancestor = dirname(resolve(path));
  for (;;) {
    try { if (!outside(await realpath(ancestor))) throw new ContinuityError("capture_requires_external_output"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!outside(await realpath(dirname(path)))) throw new ContinuityError("capture_requires_external_output");
  try { await lstat(path); throw new ContinuityError("capture_already_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

/** Benchmark-only tee: keeps the real model, auth, cap options and SSE unchanged. */
export function captureUpkeepModels(models, capture) {
  return new Proxy(models, { get(target, key) {
    if (key === "streamSimple") return (...args) => {
      const stream = target.streamSimple(...args);
      return new Proxy(stream, { get(source, field) {
        if (field === "result") return async () => { const message = await source.result(); capture(typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("")); return message; };
        const value = Reflect.get(source, field, source); return typeof value === "function" ? value.bind(source) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** One upkeep, no real answer call, before read-only probe forks. No probe/answer data enter extraction. */
export async function prepareLedgerCheckpoint({ modules, work, authPath, plan, mode, reader, alternate, scripted, route, clock, conversationId, captureUpkeepOutput }) {
  if (captureUpkeepOutput) await prepareCapturePath(captureUpkeepOutput);
  const watch = observer(); const hostOptions = {}; let capturedText;
  if (mode === "offline") {
    const ref = modules.host.parseMonoRuntimeModelReference(plan.upkeep.model);
    const faux = modules.pi.fauxProvider({ provider: ref.provider, api: ref.provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
      models: [{ id: ref.model, contextWindow: 272000, maxTokens: 8192 }], tokensPerSecond: 1000000 });
    const models = modules.pi.createModels(); models.setProvider(faux.provider);
    faux.setResponses([context => {
      const prompt = textOfContent(context.messages.at(-1)?.content);
      const spans = prompt.split("\n").flatMap(line => { try { const row = JSON.parse(line); return typeof row.id === "string" && typeof row.text === "string" ? [row] : []; } catch { return []; } });
      if (!spans.length) throw new ContinuityError("offline_upkeep_source_missing");
      return modules.pi.fauxAssistantMessage(JSON.stringify({ entries: [{ kind: "open_work", value: "Offline scripted ledger; not model quality.", status: "unknown", sources: [spans[0].id] }], covered: spans.map(span => span.id) }));
    }]);
    hostOptions.runtimeOptions = { piResolvedModels: models };
  }
  if (captureUpkeepOutput) {
    let models = hostOptions.runtimeOptions?.piResolvedModels;
    if (!models) {
      const resolver = modules.host.createPiOAuthApiKeyResolver({ path: authPath });
      models = modules.pi.builtinModels({ credentials: { read: resolver.readCredential, modify: resolver.modifyCredential, delete: resolver.deleteCredential } });
    }
    hostOptions.runtimeOptions = { ...(hostOptions.runtimeOptions ?? {}), piResolvedModels: captureUpkeepModels(models, text => { capturedText = text; }) };
  }
  // Configured runtime.model remains reader (or explicit extractionModel).
  // Only the scripted answer switches binding, leaving probes a real cold boundary.
  hostOptions.runtimeOptionsForRequest = () => ({ runtimeOptions: { model: alternate, piResolvedModel: scripted.route({ model: alternate }).model, piResolvedModels: scripted.models } });
  scripted.respondWith(alternate, () => modules.pi.fauxAssistantMessage("Continuity preparation complete."));
  let opened, failure = null, generation, receipt = null;
  try {
    opened = await openHarness({ modules, work, authPath, model: reader.reference, tools: false, route, clock, hostOptions,
      configPatch: { runtime: { compaction: { enabled: false }, session: { continuity: { enabled: true, packEnabled: true, upkeep: { enabled: true, requireRequestCap: plan.upkeep.requireRequestCap, extractionModel: plan.upkeep.model } } } } } });
    const response = await opened.harness.run({ conversationId, userMessage: "Prepare continuity for the next request.", captureSpeakerKind: "human-turn", metadata: { source: "web", web: { model: alternate.reference } }, abortSignal: AbortSignal.timeout(plan.limits.perLiveTurnTimeoutMs), onEvent: watch.onEvent });
    failure = response.failure?.kind ?? null;
    generation = new modules.conversation.ToolHistoryReader(join(work, "history")).ledger({ logicalConversationId: conversationId, currentConversationId: conversationId, currentRunId: "benchmark" });
  } catch { failure = "upkeep_preparation_failed"; }
  finally {
    try { await opened?.close(); } catch { failure ??= "upkeep_close_failed"; }
    receipt = watch.observed.upkeep.find(row => row.providerInvoked) ?? watch.observed.upkeep[0] ?? null;
  }
  if (captureUpkeepOutput) {
    try {
      await mkdir(dirname(captureUpkeepOutput), { recursive: true, mode: 0o700 });
      await writeFile(captureUpkeepOutput, JSON.stringify({ text: capturedText ?? null, failure: receipt?.failure ?? null, status: receipt?.status ?? null }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch { failure ??= "upkeep_capture_failed"; }
  }
  const calls = receipt?.providerInvoked ? 1 : 0;
  const estimatedPaid = calls > 0 && receipt.costUsd == null && typeof receipt.estimatedInputCostUsd === "number";
  return { valid: !failure && receipt?.status === "valid" && !!generation?.generation.entries.length && generation.generation.id === receipt.generationId,
    failure, receipt, usage: { calls, estimatedInputTokens: calls ? receipt?.estimatedInputTokens ?? null : 0, inputTokens: calls ? receipt?.inputTokens ?? null : 0, outputTokens: calls ? receipt?.outputTokens ?? null : 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: calls ? receipt?.costUsd ?? receipt?.estimatedInputCostUsd ?? null : 0,
      estimatedPaidCalls: estimatedPaid ? 1 : 0, estimatedPaidInputCostUsd: estimatedPaid ? receipt.estimatedInputCostUsd : 0 } };
}

/** `harness.compactConversation()` through a tool-free configured harness on the bound model. */
async function manualCompaction({ modules, work, authPath, plan, mode, binding, configPatch, clock, conversationId, turnId }) {
  const route = liveRoute(modules, mode, [binding]);
  const { harness, close } = await openHarness({ modules, work, authPath, model: binding.reference, effort: plan.reader.effort, tools: false, configPatch, route, clock });
  const started = performance.now();
  let result;
  try {
    if (typeof harness.compactConversation !== "function") throw new ContinuityError("manual_compaction_unavailable");
    result = await harness.compactConversation(conversationId, undefined, AbortSignal.timeout(plan.limits.perLiveTurnTimeoutMs));
  } finally { await close(); }
  const observed = { boundaries: [], compactions: [{ status: result?.status ?? null, trigger: result?.trigger ?? null, tokensBefore: finite(result?.tokensBefore), tokensAfter: finite(result?.tokensAfter) }], warnings: 0, steersAccepted: 0 };
  const usage = compactionUsageOf({ compaction: { requests: result?.accounting?.requests ?? [] } });
  return {
    turnId, kind: "manual-compaction", status: result?.status ?? null, reason: result?.reason ?? null,
    tokensBefore: finite(result?.tokensBefore), tokensAfter: finite(result?.tokensAfter),
    boundary: { ...verifyBoundary({ boundary: null, compactions: 1 }, observed), observed },
    usage: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      estimatedCostUsd: usage.unknownCostCalls > 0 ? null : usage.estimatedCostUsd },
    compactionUsage: usage, durationMs: Math.round(performance.now() - started),
  };
}

/**
 * Run a live turn in a fresh Node process over the same durable roots: an
 * actual process restart, so no in-process runtime, session or cache survives.
 */
async function runLiveTurnInChild(input, { timeoutMs }) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [CHILD_ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => { if (process.env.CONTINUITY_DEBUG === "1") process.stderr.write(chunk); });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs + 30_000);
    child.on("exit", (exit) => { clearTimeout(timer); resolve(exit); });
  });
  if (code !== 0) throw new ContinuityError(code === "timeout" ? "restart_child_timeout" : "restart_child_failed");
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return { ...parsed, observed: { ...parsed.observed, restart: { processRestart: parsed.pid !== process.pid, pid: parsed.pid } } };
}

/** Fork the checkpoint into a new workspace and ask one probe in a fresh continuation turn. */
export async function runProbe({ modules, trace, arm, repeat, probe, checkpointWork, checkpointSnapshot = null, checkpointContinuity = null, checkpointUpkeep = null, checkpointConversationId, forkDir, plan, mode, authPath, keepWork = false, mid = null, root }) {
  const inPlace = arm.fork === "in-place";
  if (inPlace && checkpointSnapshot === null) throw new ContinuityError("in_place_fork_requires_snapshot");
  // In-place: restore the pristine snapshot at the checkpoint's own absolute
  // root (callers never overlap forks of one checkpoint) and probe in a fresh
  // process, so the sidecar's pinned artifact root matches. Copy: a new root.
  const work = inPlace ? checkpointWork : join(forkDir, "work");
  if (inPlace) {
    await rm(work, { recursive: true, force: true });
    await cp(checkpointSnapshot, work, { recursive: true, verbatimSymlinks: true });
  } else {
    await mkdir(forkDir, { recursive: true, mode: 0o700 });
    await cp(checkpointWork, work, { recursive: true, verbatimSymlinks: true });
  }
  const clock = { value: new Date(trace.probeAt) };
  const trial = { traceId: trace.id, arm: arm.id, repeat, probeId: probe.id, category: probe.category, status: "started",
    answer: null, score: null, judge: null, boundary: null, usage: null, compactionUsage: null, durationMs: null, failure: null };
  try {
    const turn = { work, authPath, plan, mode, configPatch: mergePatch(arm.sessionConfig ?? {}, arm.probeConfig), userMessage: probePrompt(probe),
      conversationId: checkpointConversationId, owner: trace.owner.displayName };
    const live = arm.restart || inPlace
      ? await runLiveTurnInChild({ ...turn, root, clockIso: clock.value.toISOString() }, { timeoutMs: plan.limits.perLiveTurnTimeoutMs })
      : await runLiveTurn({ modules, ...turn, clock });
    trial.usage = live.usage; trial.compactionUsage = live.compactionUsage; trial.durationMs = live.durationMs;
    const boundary = verifyBoundary({ boundary: arm.expect.probeBoundary, compactions: arm.expect.probeCompactions, restart: arm.restart }, live.observed);
    if (arm.ledgerUpkeep && (!checkpointUpkeep?.valid || !live.observed.continuityPacks.some(pack => pack.ledgerEntries > 0) || live.observed.upkeep.some(row => row.providerInvoked))) { boundary.reasons.push("ledger_treatment_unverified"); boundary.verified = false; }
    const metrics = pressureMetrics(live.observed, { usage: live.usage, traceToolRecords: traceShape(trace).toolCalls, mid });
    const pressure = verifyPressure(arm, traceFamily(trace), metrics);
    trial.boundary = { ...boundary, observed: live.observed };
    trial.pressure = { ...pressure, metrics };
    trial.store = verifyStore(arm, { checkpointContinuity, observed: live.observed });
    if (live.failureKind !== null || live.text === null) {
      trial.status = "failed"; trial.failure = live.failureKind ?? "empty_answer";
      return trial;
    }
    trial.answer = live.text;
    trial.score = scoreAnswer(probe, live.text);
    // A degraded store is an invalid trial, never a scored miss.
    trial.status = !trial.store.healthy ? "store_degraded" : !trial.boundary.verified ? "boundary_unverified"
      : !trial.pressure.verified ? "pressure_unverified" : "completed";
    return trial;
  } catch (error) {
    trial.status = "failed"; trial.failure = codeOf(error);
    return trial;
  } finally {
    if (!keepWork && !inPlace) await rm(forkDir, { recursive: true, force: true });
  }
}

/** Optional next-action judge through the production Pi host runtime. */
export function createJudge({ modules, plan, mode, workspace, authPath }) {
  if (plan.judge === null) return null;
  const ref = modules.host.parseMonoRuntimeModelReference(plan.judge.model);
  const hostOptions = mode === "offline" || authPath === undefined
    ? { workspace }
    : { workspace, resolvePiApiKey: modules.host.createPiOAuthApiKeyResolver({ path: authPath }) };
  const runtime = modules.host.createMonoRuntime(hostOptions);
  return {
    async judge(probe, answer) {
      let extra = {};
      if (mode === "offline") {
        const scripted = scriptedModels(modules.pi, [ref]);
        scripted.respondWith(ref, () => modules.pi.fauxAssistantMessage('{"verdict":"fail"}'), 4);
        extra = { piResolvedModel: scripted.route({ model: ref }).model, piResolvedModels: scripted.models };
      }
      const started = performance.now();
      try {
        const result = await runtime.run("You are a strict, terse grader. Output only the requested JSON.", {
          model: ref, effort: plan.judge.effort, messages: [{ role: "user", content: judgePrompt(probe, answer) }],
          cwd: workspace, allowedTools: [], disallowedTools: [], mcpServers: {}, maxTurns: 1,
          compaction: { enabled: false }, abortSignal: AbortSignal.timeout(120_000), ...extra,
        });
        const verdict = result?.failureKind || result?.error ? null : parseJudgeVerdict(result?.text);
        return { verdict: verdict ?? "invalid", kind: mode === "offline" ? "scripted" : "model", model: ref.reference,
          usage: runUsage(result?.usage), durationMs: Math.round(performance.now() - started) };
      } catch {
        return { verdict: "invalid", kind: mode === "offline" ? "scripted" : "model", model: ref.reference, usage: { calls: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, estimatedCostUsd: null }, durationMs: Math.round(performance.now() - started) };
      }
    },
    async close() { await runtime.disposeAllSessions?.(); },
  };
}

export function isFatalFailure(trial) { return FATAL_FAILURE_KINDS.has(trial?.failure); }

/**
 * Bounded promise pool. `admit()` returning false stops new work; items whose
 * `exclusiveKey(item)` is already running wait, so forks of one checkpoint
 * (one provider session identity) never overlap.
 */
export async function pool(items, concurrency, worker, admit = () => true, exclusiveKey = () => null) {
  const results = new Array(items.length).fill(undefined);
  const waiting = items.map((_, index) => index);
  const running = new Set();
  let wake = () => {};
  const take = () => {
    const position = waiting.findIndex((index) => { const key = exclusiveKey(items[index]); return key === null || !running.has(key); });
    return position < 0 ? null : waiting.splice(position, 1)[0];
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (waiting.length > 0) {
      const index = take();
      if (index === null) { await new Promise((resolve) => { const previous = wake; wake = () => { previous(); resolve(); }; }); continue; }
      const key = exclusiveKey(items[index]);
      if (key !== null) running.add(key);
      try {
        results[index] = admit() ? await worker(items[index], index) : undefined;
      } finally {
        if (key !== null) running.delete(key);
        const notify = wake; wake = () => {}; notify();
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

export { armById };
