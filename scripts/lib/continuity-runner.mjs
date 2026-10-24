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
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { armById, checkpointKey, mergePatch, pressureMetrics, verifyBoundary, verifyPressure } from "./continuity-arms.mjs";
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
  const [config, app, hostRuntime, hostConfig, turnRoot, pi] = await Promise.all([
    import(pathToFileURL(join(root, "packages/config/dist/index.js")).href),
    import(pathToFileURL(join(root, "packages/app/dist/index.js")).href),
    import("@mono-agent/turn/host"),
    import("@mono-agent/turn/host/config"),
    import("@mono-agent/turn"),
    import(pathToFileURL(join(root, "packages/turn/node_modules/@earendil-works/pi-ai", entry)).href),
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
  return { config, app, host, pi };
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
      session: { root: join(work, "sessions"), mode: "continuous", idleTimeoutMs: 3_600_000 },
    },
    providers: { piAuthPath: authPath },
    context: { identityPath: join(work, "IDENTITY.md") },
    tools: { allowedTools: [], ...(tools ? { mcpConfigPath: join(work, "fixture-mcp.json") } : {}) },
    artifacts: { dir: join(work, "artifacts") },
  }, configPatch ?? {});
}

async function openHarness({ modules, work, authPath, model, effort, tools, configPatch, route, clock }) {
  const json = configJson({ work, authPath, model, effort, tools, configPatch });
  const config = modules.config.resolveJsonMonoAgentConfig({ json, cwd: work });
  const runtime = controlledRuntime(modules.app.createConfiguredAgentRuntime({ config, cwd: work, model: config.runtime.model }), route);
  const harness = await modules.app.createConfiguredConversationHarness({ config, cwd: work, runtime, now: () => clock.value });
  return { harness, config };
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
  const observed = { boundaries: [], compactions: [], warnings: 0, steersAccepted: 0 };
  let steerWaiter = null;
  return {
    observed,
    onEvent(event) {
      if (event?.type === "session_boundary") {
        observed.boundaries.push({ kind: event.kind ?? null, reason: event.reason ?? null, context: event.context ?? null,
          replayedMessageCount: finite(event.replayedMessageCount), toolProjectionRecords: finite(event.toolProjectionRecords), toolProjectionBytes: finite(event.toolProjectionBytes) });
      } else if (event?.type === "context_compaction" && event.status !== "running") {
        observed.compactions.push({ status: event.status ?? null, trigger: event.trigger ?? null, tokensBefore: finite(event.tokensBefore), tokensAfter: finite(event.tokensAfter) });
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
    metadata: { source: "web" }, sender: { displayName: owner }, onEvent: watch.onEvent,
  });
  if (failure) throw failure;
  if (response.failure) throw new ContinuityError("replay_turn_failed", turn.id);
  if (cursor !== turn.steps.length) throw new ContinuityError("replay_step_mismatch", turn.id);
  if (tools.pending() !== 0 || tools.mismatches().length > 0) throw new ContinuityError("replay_tool_mismatch", turn.id);
  if (watch.observed.boundaries.some((row) => row.kind === "resume_replay")) throw new ContinuityError("replay_unexpected_boundary", turn.id);
  return { toolCalls: turn.steps.filter((step) => step.call).length, steers: watch.observed.steersAccepted };
}

/** One live turn (probe or mid-trace checkpoint) through a tool-free production harness. */
function liveRoute(modules, mode, refs) {
  if (mode !== "offline") return () => ({});
  const scripted = scriptedModels(modules.pi, refs);
  for (const ref of refs) scripted.respondWith(ref, (context) => modules.pi.fauxAssistantMessage(String(context.systemPrompt ?? "").includes(SUMMARY_MARKER) ? OFFLINE_SUMMARY : OFFLINE_ANSWER));
  return (options) => { const { model } = scripted.route(options); return { piResolvedModel: model, piResolvedModels: scripted.models }; };
}

export async function runLiveTurn({ modules, work, authPath, plan, mode, configPatch, userMessage, clock, conversationId, owner }) {
  const reader = modules.host.parseMonoRuntimeModelReference(plan.reader.model);
  const route = liveRoute(modules, mode, [reader]);
  const watch = observer();
  const { harness } = await openHarness({ modules, work, authPath, model: plan.reader.model, effort: plan.reader.effort, tools: false, configPatch, route, clock });
  const started = performance.now();
  let response;
  try {
    response = await harness.run({
      conversationId, userMessage, abortSignal: AbortSignal.timeout(plan.limits.perLiveTurnTimeoutMs),
      metadata: { source: "web" }, sender: { displayName: owner }, onEvent: watch.onEvent,
    });
  } finally { await harness.dispose?.(); }
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
export async function buildCheckpoint({ modules, trace, arm, repeat, dir, plan, mode, authPath }) {
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
  const record = { key, conversationId, traceId: source.id, arm: arm.midCheckpoint === null ? null : arm.id, repeat: arm.midCheckpoint === null ? null : repeat,
    binding: binding.reference, turns: 0, toolCalls: 0, steers: 0, mid: null, durationMs: 0 };
  const started = performance.now();
  let open = null;
  try {
    for (const turn of source.turns) {
      clock.value = new Date(turn.at);
      if (arm.midCheckpoint !== null && turn.id === source.midCheckpoint) {
        // Promptless manual compaction before the mid-trace turn: the same
        // guarded production summary driver, with no live reply in history.
        if (open) { await open.harness.dispose?.(); open = null; }
        record.mid = await manualCompaction({ modules, work, authPath, plan, mode, binding, configPatch: arm.midCheckpoint.config, clock, conversationId, turnId: turn.id });
        if (!record.mid.boundary.verified) throw new ContinuityError("mid_checkpoint_boundary_unverified", record.mid.boundary.reasons.join(","));
      }
      open ??= await openHarness({ modules, work, authPath, model: binding.reference, effort: undefined, tools: true, configPatch: {}, route, clock });
      const result = await replayScriptedTurn({ harness: open.harness, scripted, tools, turn, binding, conversationId, owner: source.owner.displayName, pi: modules.pi });
      record.turns += 1; record.toolCalls += result.toolCalls; record.steers += result.steers;
    }
  } finally {
    if (open) await open.harness.dispose?.();
    await tools.close();
    record.durationMs = Math.round(performance.now() - started);
  }
  return { work, record };
}

/** `harness.compactConversation()` through a tool-free configured harness on the bound model. */
async function manualCompaction({ modules, work, authPath, plan, mode, binding, configPatch, clock, conversationId, turnId }) {
  const route = liveRoute(modules, mode, [binding]);
  const { harness } = await openHarness({ modules, work, authPath, model: binding.reference, effort: plan.reader.effort, tools: false, configPatch, route, clock });
  const started = performance.now();
  let result;
  try {
    if (typeof harness.compactConversation !== "function") throw new ContinuityError("manual_compaction_unavailable");
    result = await harness.compactConversation(conversationId, undefined, AbortSignal.timeout(plan.limits.perLiveTurnTimeoutMs));
  } finally { await harness.dispose?.(); }
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
  child.stderr.on("data", () => {});
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
export async function runProbe({ modules, trace, arm, repeat, probe, checkpointWork, checkpointConversationId, forkDir, plan, mode, authPath, keepWork = false, mid = null, root }) {
  const work = join(forkDir, "work");
  await mkdir(forkDir, { recursive: true, mode: 0o700 });
  await cp(checkpointWork, work, { recursive: true, verbatimSymlinks: true });
  const clock = { value: new Date(trace.probeAt) };
  const trial = { traceId: trace.id, arm: arm.id, repeat, probeId: probe.id, category: probe.category, status: "started",
    answer: null, score: null, judge: null, boundary: null, usage: null, compactionUsage: null, durationMs: null, failure: null };
  try {
    const turn = { work, authPath, plan, mode, configPatch: arm.probeConfig, userMessage: probePrompt(probe),
      conversationId: checkpointConversationId, owner: trace.owner.displayName };
    const live = arm.restart
      ? await runLiveTurnInChild({ ...turn, root, clockIso: clock.value.toISOString() }, { timeoutMs: plan.limits.perLiveTurnTimeoutMs })
      : await runLiveTurn({ modules, ...turn, clock });
    trial.usage = live.usage; trial.compactionUsage = live.compactionUsage; trial.durationMs = live.durationMs;
    const boundary = verifyBoundary({ boundary: arm.expect.probeBoundary, compactions: arm.expect.probeCompactions, restart: arm.restart }, live.observed);
    const metrics = pressureMetrics(live.observed, { usage: live.usage, traceToolRecords: traceShape(trace).toolCalls, mid });
    const pressure = verifyPressure(arm, traceFamily(trace), metrics);
    trial.boundary = { ...boundary, observed: live.observed };
    trial.pressure = { ...pressure, metrics };
    if (live.failureKind !== null || live.text === null) {
      trial.status = "failed"; trial.failure = live.failureKind ?? "empty_answer";
      return trial;
    }
    trial.answer = live.text;
    trial.score = scoreAnswer(probe, live.text);
    trial.status = !trial.boundary.verified ? "boundary_unverified" : !trial.pressure.verified ? "pressure_unverified" : "completed";
    return trial;
  } catch (error) {
    trial.status = "failed"; trial.failure = codeOf(error);
    return trial;
  } finally {
    if (!keepWork) await rm(forkDir, { recursive: true, force: true });
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
