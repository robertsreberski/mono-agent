import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { prepareRealBuild, sourceState, verifyRealBuild } from "./memory-e2e-build.mjs";
import { Budget } from "./memory-e2e-providers.mjs";
import { privateEmbeddingCache } from "./memory-e2e-private-cache.mjs";
import { productionModules, invokedMemoryObservation, awaitReady } from "./memory-e2e-runner.mjs";
import { PrivateError, privateCode, validatePrivateRoots, validatePrivateAuthPath, createPrivateOutput, loadPrivateInputs, readPrivateJson, validateRegistration, validateAnnotations, reconstructClone, LABELS, assertPrivateLocation } from "./memory-e2e-private-input.mjs";
import { PRIVATE_ARMS, newReviewSeed, reviewId, blindSheets, safeObservation, writePrivateArtifact, summarizePrivate } from "./memory-e2e-private-report.mjs";
import { validatePrivateRoute, privateCompletionRuntime, assertPrivateProviderEnvironment, privateEmbeddingFetch, assertPrivateBudget } from "./memory-e2e-private-providers.mjs";

import { judgePrivateItems, privateJudgeConcurrency } from "./memory-e2e-private-judge.mjs";

const switchPaths = ["recall.contextWindow", "profile.enabled", "recall.semanticOnly", "recall.intentExpiry"];
const armSwitches = {
  "current-only": [], "length-only-abstention": [], "follow-up-window": ["recall.contextWindow"],
  "profile-on": ["profile.enabled"], "window-profile-on": ["recall.contextWindow", "profile.enabled"], "semantic-only": ["recall.semanticOnly"], "intent-expiry": ["recall.intentExpiry"],
};
function put(memory, path, value) { const [section, key] = path.split("."); memory[section] ??= {}; memory[section][key] = value; }
function carried(config, path) { const [section, key] = path.split("."); return config?.memory?.[section]?.[key]; }
/** Arm support comes from production config normalization, not constructor
 * guessing or simulated feature results. Current/off arms remain available. */
export function resolvePrivateArm(modules, json, cwd, arm) {
  const supported = switchPaths.filter((path) => {
    const probe = structuredClone(json); put(probe.memory, path, true);
    try { return carried(modules.config.resolveJsonMonoAgentConfig({ json: probe, cwd }), path) === true; } catch { return false; }
  });
  if (armSwitches[arm].some((path) => !supported.includes(path))) return { status: "unsupported" };
  const selected = structuredClone(json);
  for (const path of supported) put(selected.memory, path, armSwitches[arm].includes(path));
  const config = modules.config.resolveJsonMonoAgentConfig({ json: selected, cwd });
  if (supported.some((path) => carried(config, path) !== armSwitches[arm].includes(path))) return { status: "unsupported" };
  return { status: "completed", config };
}
function baseConfig(work, store, flags, llm) {
  const dim = Number(flags["private-dimension"] ?? 768);
  if (!Number.isSafeInteger(dim) || dim < 1 || dim > 8192) throw new PrivateError("private_arguments_invalid");
  const model = flags["private-embedding-model"] ?? "nomic-embed-text:v1.5";
  if (!/^[A-Za-z0-9:._/-]{1,160}$/u.test(model) || model.includes("..")) throw new PrivateError("private_arguments_invalid");
  return { runtime: { model: "openai:gpt-4o", workspace: join(work, "workspace"), session: { enabled: false }, compaction: { enabled: false } },
    context: { identityPath: join(work, "workspace", "IDENTITY.md") }, artifacts: { dir: join(work, "artifacts") },
    memory: { backend: "bujo", mode: "bujo", path: store, writeMode: "disabled", maxBytes: 8000,
      embeddings: { provider: "ollama", model, endpoint: "http://127.0.0.1:11434", dim, timeoutMs: 10000 },
      llm: llm.provider === "ollama" ? { provider: "agent-host", model: `ollama:${llm.model}`, trace: false, timeoutMs: 60000 } : llm,
      consolidation: { enabled: false } } };
}
export function privateRepositories(root) {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return [...new Set([top, common.endsWith("/.git") ? common.slice(0, -5) : common])];
  } catch { throw new PrivateError("private_operation_failed"); }
}
function emptyRow(turn, arm, flags, contaminated, status = "completed", seed) {
  return { dayId: reviewId(seed, "day", turn.timestamp.slice(0, 10)), id: turn.id, conversationId: turn.conversationId, arm, followUp: turn.followUp, directQuestion: turn.directQuestion,
    flags, contaminated, status, bytes: 0, repeatedBytes: 0, latencyMs: 0, chatCalls: 0, embeddingRequests: 0, indexingEmbeddingRequests: 0, lines: [] };
}
async function snapshotBullets(root, grammar) {
  const map = new Map();
  for (const name of await readdir(join(root, "daily"))) for (const bullet of grammar.parseDailyFile(await readFile(join(root, "daily", name), "utf8")).bullets) map.set(bullet.id, bullet.text);
  return map;
}
function observedLines(observation, seed, turn, arm, offset = 0) {
  return observation.lines.map((line, index) => ({ id: reviewId(seed, turn.id, arm, offset + index), kind: line.kind, bytes: line.bytes, repeated: line.repeated, label: null }));
}

/** Content is shown only on an explicitly requested, non-logging local TTY;
 * stdout/stderr remain code-only. No review server, transcript or HTML file. */
export async function reviewOnTty(items) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new PrivateError("private_review_tty_required");
  const display = (text) => JSON.stringify(text).replace(/[\p{Cf}\p{Cs}]/gu, (character) => `\\u{${character.codePointAt(0).toString(16)}}`);
  let tty;
  try {
    tty = await open("/dev/tty", "r+");
    const result = [];
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      await tty.write(`\n${item.id}\n${display(item.ownerText)}\n\n${display(item.text)}\n\nuseful / partial / noise / stale (or skip): `);
      let answer = "";
      for (;;) {
        const buffer = Buffer.alloc(1); const { bytesRead } = await tty.read(buffer, 0, 1, null);
        if (bytesRead === 0) throw new PrivateError("private_review_tty_required");
        if (buffer[0] === 10) break;
        if (answer.length < 32) answer += buffer.toString("utf8");
      }
      const label = answer.trim();
      if (!LABELS.includes(label) && label !== "skip") throw new PrivateError("private_annotations_invalid");
      result.push({ id: item.id, label: label === "skip" ? null : label });
    }
    return result;
  } finally { await tty?.close(); }
}

/** Retrieval uses the UTC civil day's start, deliberately excluding even
 * earlier same-day facts. Present diagnostics and chronological capture keep
 * their single initial reconstruction semantics. Keys never enter artifacts. */
export function privateReplaySnapshot(turn, registration, mode) {
  if (registration.snapshot === "present_diagnostic") return { key: "present", asOf: turn.timestamp };
  if (mode === "capture") return { key: "capture", asOf: turn.timestamp };
  const date = new Date(turn.timestamp).toISOString().slice(0, 10);
  return { key: date, asOf: `${date}T00:00:00.000Z` };
}

async function runPrivateReplay({ roots, flags, turns, registration, modules, review, seed }) {
  const rows = [], reviewItems = [];
  const concurrency = privateJudgeConcurrency(flags["private-judge-concurrency"]);
  const maxRuntime = Number(flags["private-max-runtime-ms"] ?? 3600000);
  if (!Number.isSafeInteger(maxRuntime) || maxRuntime < 30000 || maxRuntime > 14400000) throw new PrivateError("private_arguments_invalid");
  const plan = { limits: { runtimeMs: maxRuntime, chatSteps: turns.length * 64, embeddingCalls: turns.length * 10000,
    estimatedInputTokens: turns.length * 1000000, embeddingInputTokens: turns.length * 1000000, outputTokens: turns.length * 100000 },
    perCall: { embeddingTimeoutMs: 10000 } };
  const allowed = flags["allow-private-provider-route"] ?? [];
  const llm = validatePrivateRoute(flags["private-capture-route"] ?? "ollama:private-unused", allowed, registration, modules.runtime);
  const judgeRoute = flags["private-judge"];
  if (judgeRoute !== undefined) validatePrivateRoute(judgeRoute, allowed, registration, modules.runtime);
  if (flags["private-mode"] === "capture" && flags["private-capture-route"] === undefined) throw new PrivateError("private_provider_route_refused");
  const budget = new Budget(plan); budget.privateChatCalls = 0;
  const cache = privateEmbeddingCache();
  let progress;
  const checkpoint = async (value) => {
    progress = { ...progress, ...value, elapsedMs: performance.now() - budget.started };
    await writePrivateArtifact(roots, "progress.json", "progress", progress);
  };
  let judge, judgeRuntime, judgeWork;
  try {
    if (judgeRoute !== undefined) {
      await assertPrivateLocation(roots.outputRoot, roots.repositories);
      judgeWork = await mkdtemp(join(roots.outputRoot, "judge-"));
      await assertPrivateLocation(judgeWork, roots.repositories);
      try {
        const llmConfig = validatePrivateRoute(judgeRoute, allowed, registration, modules.runtime);
        const config = modules.config.resolveJsonMonoAgentConfig({ json: baseConfig(judgeWork, join(judgeWork, "memory"), flags, llmConfig), cwd: judgeWork });
        await mkdir(config.runtime.workspace, { mode: 0o700 });
        await assertPrivateLocation(judgeWork, roots.repositories);
        judgeRuntime = privateCompletionRuntime(modules, judgeRoute, config.runtime.workspace, budget, { piAuthPath: flags["pi-auth-path"] });
        judge = await modules.app.createConfiguredCurationLlm(config, undefined, judgeRuntime);
        if (typeof judge?.complete !== "function") throw new PrivateError("private_judge_unavailable");
      } catch (error) {
        if (error instanceof PrivateError || privateCode(error) === "private_budget_exhausted") throw error;
        throw new PrivateError("private_judge_unavailable");
      }
      // Fail missing/unreadable hosted credentials before any snapshot/index.
      // Local Ollama needs no Pi auth. No completion or private text is sent here.
      if (!judgeRoute.startsWith("ollama:")) await judgeRuntime.checkAuth(judgeRoute.split(":", 1)[0]);
    }
    for (const arm of PRIVATE_ARMS.filter((name) => name !== "historical-baseline")) {
      budget.reserve({});
      const replayCheckpoint = (turnsDone) => checkpoint({ arm, turnsDone, turnsTotal: turns.length, phase: 0, judgedDone: 0, judgedTotal: 0, retries: 0 });
      await replayCheckpoint(0);
      await assertPrivateLocation(roots.outputRoot, roots.repositories);
      const work = await mkdtemp(join(roots.outputRoot, "clone-"));
      await assertPrivateLocation(work, roots.repositories);
      const workspace = join(work, "workspace"); await mkdir(workspace, { mode: 0o700 });
      await assertPrivateLocation(work, roots.repositories);
      await writeFile(join(workspace, "IDENTITY.md"), "Replay a completed owner turn. Do not invoke tools.\n", { mode: 0o600 });
      const memoryRoot = join(work, "memory");
      const json = baseConfig(work, memoryRoot, flags, llm);
      if (flags["private-mode"] === "capture") json.memory.writeMode = "capture";
      const resolved = resolvePrivateArm(modules, json, work, arm);
      if (resolved.status === "unsupported") {
        rows.push(...turns.map((turn) => emptyRow(turn, arm, [], true, "unsupported", seed)));
        await assertPrivateLocation(work, roots.repositories);
        await rm(work, { recursive: true, force: true }); await replayCheckpoint(turns.length); continue;
      }
      const config = resolved.config;
      let store, harness, memoryRuntime, service, currentTurn = turns[0], pendingBlock, invocation, evidence, memoryWarning, indexingEmbeddingRequests = 0, indexingEmbeddingCacheHits = 0, snapshotKey;
      const proxy = new Proxy({}, { get(_target, key) { const value = store?.[key]; return typeof value === "function" ? (...args) => store[key](...args) : value; } });
      const controller = { sharedMemoryRetrieval: undefined };
      const seenByConversation = new Map();
      try {
        memoryRuntime = privateCompletionRuntime(modules, flags["private-capture-route"] ?? "ollama:private-unused", workspace, budget, { piAuthPath: flags["pi-auth-path"] });
        const prepareStore = async (turn) => {
          try {
            const snapshot = privateReplaySnapshot(turn, registration, flags["private-mode"]);
            evidence = await reconstructClone({ source: roots.storeRoot, destination: memoryRoot, asOf: snapshot.asOf,
              grammar: modules.grammar, graph: modules.graph, repositories: roots.repositories, present: registration.snapshot === "present_diagnostic" });
            const indexingStart = budget.used.embeddingCalls, cacheStart = cache.stats.hits;
            const cacheOptions = { budget, tag: { arm }, dimension: config.memory.embeddings.dim, model: config.memory.embeddings.model };
            const embeddings = cache.wrap(modules.search.createEmbeddingProvider({ ...config.memory.embeddings }, privateEmbeddingFetch), cacheOptions);
            await assertPrivateLocation(memoryRoot, roots.repositories);
            await budget.wait(modules.bujo.safeRebuildMemoryIndex({ root: memoryRoot, tier: "bujo", embeddings, dim: config.memory.embeddings.dim }));
            indexingEmbeddingRequests = budget.used.embeddingCalls - indexingStart;
            indexingEmbeddingCacheHits = cache.stats.hits - cacheStart;
            await assertPrivateLocation(memoryRoot, roots.repositories);
            store = await modules.app.createConfiguredMemory(config, { cwd: work, clock: () => new Date(currentTurn.timestamp), embeddingsFetch: privateEmbeddingFetch, logger: { warn() {} },
              ...(memoryRuntime ? { memoryRuntime } : {}) });
            store.db.embeddings = cache.wrap(store.db.embeddings, cacheOptions);
            assertPrivateBudget(budget);
            snapshotKey = snapshot.key;
          } catch (error) {
            if (error instanceof PrivateError || privateCode(error) === "private_budget_exhausted") throw error;
            throw new PrivateError("private_snapshot_failed");
          }
        };
        await prepareStore(currentTurn);
        // Construct through app wiring only after the real BuJo store exists:
        // production options can legitimately feature-detect store.tier().
        service = modules.controllerMemory.ensureSharedMemoryRetrieval(controller, config, proxy);
        if (!service) throw new PrivateError("private_operation_failed");
        const observedMemory = new Proxy({
          async load(conversationId, query, options = {}) {
            pendingBlock = await service.load(conversationId, query, { ...options, traceContent: false, onWarning: () => { memoryWarning = true; } });
            assertPrivateBudget(budget);
            if (pendingBlock) pendingBlock = { ...pendingBlock, traceContent: false };
            if (arm === "length-only-abstention" && Array.from(currentTurn.ownerText.normalize("NFC").trim()).length <= registration.lengthAbstentionMaxCodePoints) pendingBlock = undefined;
            return pendingBlock;
          },
          releaseTurn: (...args) => service.releaseTurn(...args),
          ...(flags["private-mode"] === "capture" ? { async persistCompletedTurn(...args) { await assertPrivateLocation(memoryRoot, roots.repositories); return store.persistCompletedTurn(...args); } } : {}),
        }, { get(target, key) { if (Object.hasOwn(target, key)) return target[key]; const value = service[key]; return typeof value === "function" ? value.bind(service) : value; } });
        harness = modules.harness.createAgentHarness({ identityPath: json.context.identityPath, cwd: workspace,
          model: config.runtime.model, now: () => new Date(currentTurn.timestamp),
          historyStore: modules.harness.createInMemoryHistoryStore({ maxMessages: 100 }),
          memory: observedMemory, memoryWriteMode: config.memory.writeMode,
          onMemoryWarning: () => { memoryWarning = true; },
          createRunId: () => reviewId(seed, arm, currentTurn.id),
          toolPolicy: modules.harness.createToolPolicy({ allowedTools: [] }),
          runtimeOptions: { compaction: { enabled: false }, piMaxRetries: 0 },
          runtime: { async run(_system, options) {
            let seen = seenByConversation.get(currentTurn.conversationId);
            if (!seen) { seen = new Set(); seenByConversation.set(currentTurn.conversationId, seen); }
            const observed = invokedMemoryObservation({ block: pendingBlock, messages: options.messages, seen });
            if (!observed.invoked) throw new PrivateError("private_invocation_missing");
            invocation = observed;
            return { text: currentTurn.assistantText || "Acknowledged." };
          } },
        });
        for (const [index, turn] of turns.entries()) {
          budget.reserve({}); currentTurn = turn; pendingBlock = undefined; invocation = undefined; memoryWarning = false;
          if (index > 0) { indexingEmbeddingRequests = 0; indexingEmbeddingCacheHits = 0; }
          if (index > 0 && flags["private-mode"] === "retrieval" && privateReplaySnapshot(turn, registration, flags["private-mode"]).key !== snapshotKey) {
            await replayCheckpoint(index);
            if (store) { await assertPrivateLocation(memoryRoot, roots.repositories); await store.close(); store = undefined;
              await assertPrivateLocation(memoryRoot, roots.repositories); await rm(memoryRoot, { recursive: true, force: true }); }
            await prepareStore(turn);
          }
          const before = flags["private-mode"] === "capture" ? await snapshotBullets(memoryRoot, modules.grammar) : null;
          const start = performance.now(); const chatStart = budget.privateChatCalls, embeddingStart = budget.used.embeddingCalls, cacheStart = cache.stats.hits;
          await assertPrivateLocation(memoryRoot, roots.repositories);
          const response = await budget.wait(harness.run({ conversationId: turn.conversationId, userMessage: turn.ownerText,
            captureSpeakerKind: "human-turn", metadata: { source: "web" }, abortSignal: budget.controller.signal }));
          assertPrivateBudget(budget);
          if (response.failure || memoryWarning) throw new PrivateError("private_provider_failed");
          if (invocation?.error) throw new PrivateError(invocation.error);
          if (!invocation) throw new PrivateError("private_invocation_missing");
          if (flags["private-mode"] === "capture") await awaitReady(store, 60000, budget);
          assertPrivateBudget(budget);
          const row = emptyRow(turn, arm, evidence.flags, evidence.contaminated, "completed", seed);
          row.chatCalls = budget.privateChatCalls - chatStart; row.embeddingRequests = budget.used.embeddingCalls - embeddingStart; row.indexingEmbeddingRequests = indexingEmbeddingRequests;
          row.embeddingCacheHits = cache.stats.hits - cacheStart; row.indexingEmbeddingCacheHits = indexingEmbeddingCacheHits;
          row.bytes = invocation.bytes; row.repeatedBytes = invocation.repeatedBytes; row.latencyMs = performance.now() - start;
          row.lines = observedLines(invocation, seed, turn, arm);
          invocation.lines.forEach((line, index) => reviewItems.push({ id: row.lines[index].id, turnId: turn.id, ownerText: turn.ownerText, text: line.text }));
          if (before) {
            const after = await snapshotBullets(memoryRoot, modules.grammar);
            for (const [key, text] of after) if (before.get(key) !== text) {
              const line = { id: reviewId(seed, turn.id, arm, "capture", key), kind: "capture", bytes: Buffer.byteLength(text), repeated: false, label: null };
              row.lines.push(line); reviewItems.push({ id: line.id, turnId: turn.id, ownerText: turn.ownerText, text });
            }
          }
          rows.push(row);
          if (index === turns.length - 1 || turns[index + 1].timestamp.slice(0, 10) !== turn.timestamp.slice(0, 10)) await replayCheckpoint(index + 1);
        }
      } finally {
        try { await assertPrivateLocation(work, roots.repositories); } catch (error) { budget.controller.abort(); throw error; }
        const cleanup = [];
        for (const close of [() => harness?.dispose?.(), () => store?.close(), () => memoryRuntime?.disposeAllSessions()]) cleanup.push(...await Promise.allSettled([Promise.resolve().then(close)]));
        service?.releaseAllTurns();
        // Native intake/plan caches belong to this disposable clone, not reports.
        // Do not delete while a provider operation still has access to it.
        await Promise.allSettled([...budget.pending]);
        if (cleanup.some((result) => result.status === "rejected")) throw new PrivateError("private_cleanup_failed");
        await assertPrivateLocation(work, roots.repositories);
        await rm(work, { recursive: true, force: true });
      }
    }
    const baselineSeen = new Map();
    for (const turn of turns) if (turn.baselineLines !== undefined) {
      const row = emptyRow(turn, "historical-baseline", [], false, "completed", seed);
      const seen = baselineSeen.get(turn.conversationId) ?? new Set(); baselineSeen.set(turn.conversationId, seen);
      row.lines = turn.baselineLines.map((line, index) => {
        const bytes = Buffer.byteLength(line.text); const repeated = seen.has(line.text); seen.add(line.text);
        const id = reviewId(seed, turn.id, "historical-baseline", index);
        reviewItems.push({ id, turnId: turn.id, ownerText: turn.ownerText, text: line.text });
        row.bytes += bytes; if (repeated) row.repeatedBytes += bytes;
        return { id, kind: line.kind, bytes, repeated, label: null };
      }); rows.push(row);
    }
    if (flags["private-review"]) {
      const annotations = validateAnnotations(await review(reviewItems));
      await writePrivateArtifact(roots, "human-review.json", "review", annotations);
      const labels = new Map(annotations.map((row) => [row.id, row.label]));
      for (const row of rows) for (const line of row.lines) line.label = labels.get(line.id) ?? null;
    }
    if (judgeRoute !== undefined) {
      const annotations = await judgePrivateItems({ items: reviewItems, definitions: registration.definitions, judge, budget, concurrency,
        onProgress: (value) => checkpoint(value) });
      // Model annotations are separate and NEVER silently substitute for humans.
      await writePrivateArtifact(roots, "model-review.json", "review", annotations);
    }
    return rows;
  } catch (error) {
    // Harness/provider wrappers may report a generic failure after global abort.
    // Preserve privacy/cleanup refusals; trusted exhaustion masks generic errors.
    if (["private_operation_failed", "private_provider_failed"].includes(privateCode(error))
      && (budget.exhausted || performance.now() - budget.started >= budget.plan.limits.runtimeMs - 10000)) throw new PrivateError("private_budget_exhausted");
    throw error;
  } finally {
    try {
      if (judgeWork) {
        await assertPrivateLocation(judgeWork, roots.repositories);
        // Never remove a workspace while a provider can still access it.
        await Promise.allSettled([...budget.pending]);
        try { await judgeRuntime?.disposeAllSessions(); }
        catch { throw new PrivateError("private_cleanup_failed"); }
        finally { await assertPrivateLocation(judgeWork, roots.repositories); await rm(judgeWork, { recursive: true, force: true }); }
      }
    } finally { cache.clear(); budget.close(); }
  }
}

export async function privateMain(flags, { root, stdout = console.log, env = process.env, repositories,
  loadModules = () => productionModules({ privateEvaluation: true }), loadInputs = loadPrivateInputs, review = reviewOnTty,
  prepareBuild = prepareRealBuild, verifyBuild = verifyRealBuild } = {}) {
  // CI refusal precedes git inspection, input loading, builds and providers.
  if (Object.hasOwn(env, "CI")) throw new PrivateError("private_ci_refused");
  assertPrivateProviderEnvironment(env);
  let roots, outputCreated = false;
  try {
    if (!["retrieval", "capture", "analyze"].includes(flags["private-mode"])) throw new PrivateError("private_arguments_invalid");
    const permitted = new Set(["private", "private-mode", "private-input-root", "private-output-root", "private-store-root", "private-embedding-model", "private-dimension", "private-capture-route", "private-judge", "private-judge-concurrency", "private-review", "private-max-runtime-ms", "allow-private-provider-route", "pi-auth-path"]);
    if (Object.keys(flags).some((key) => !permitted.has(key))) throw new PrivateError("private_arguments_invalid");
    privateJudgeConcurrency(flags["private-judge-concurrency"]);
    roots = await validatePrivateRoots({ inputRoot: flags["private-input-root"], outputRoot: flags["private-output-root"], storeRoot: flags["private-store-root"], repositories: repositories ?? privateRepositories(root), env });
    if (flags["pi-auth-path"] !== undefined) flags = { ...flags, "pi-auth-path": await validatePrivateAuthPath(flags["pi-auth-path"], roots.repositories) };
    if (flags["private-mode"] === "analyze") {
      const registration = validateRegistration(await readPrivateJson(join(roots.inputRoot, "preregistration.json")));
      const seed = (await readPrivateJson(join(roots.outputRoot, "review-seed.json"))).seed;
      const protocol = await readPrivateJson(join(roots.outputRoot, "protocol.json"));
      if (typeof seed !== "string" || !/^[a-f0-9]{64}$/u.test(seed) || protocol.id !== reviewId(seed, "registration", registration)) throw new PrivateError("private_preregistration_changed");
      const rows = (await readPrivateJson(join(roots.outputRoot, "observations.json"))).map(safeObservation);
      const annotations = validateAnnotations(await readPrivateJson(join(roots.inputRoot, "annotations.json")));
      const knownIds = new Set(rows.flatMap((row) => row.lines.map((line) => line.id)));
      if (annotations.some((row) => !knownIds.has(row.id))) throw new PrivateError("private_annotations_invalid");
      const labels = new Map(annotations.map((row) => [row.id, row.label]));
      for (const row of rows) for (const line of row.lines) line.label = labels.get(line.id) ?? null;
      await writePrivateArtifact(roots, "summary.json", "summary", [summarizePrivate(rows, registration, "strict"), summarizePrivate(rows, registration)]);
    } else {
      await createPrivateOutput(roots.outputRoot, roots.repositories); outputCreated = true;
      const { head } = sourceState(root);
      const build = await prepareBuild(root, head);
      if (build) await verifyBuild(root, build);
      for (const path of [roots.inputRoot, roots.storeRoot, roots.outputRoot]) await assertPrivateLocation(path, roots.repositories);
      const { turns, registration } = await loadInputs(roots.inputRoot);
      if (flags["private-review"] && review === reviewOnTty && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new PrivateError("private_review_tty_required");
      // Everything above is provider-free; imports cannot load consumer config.
      const modules = await loadModules();
      if (build) await verifyBuild(root, build);
      const seed = newReviewSeed();
      await writePrivateArtifact(roots, "review-seed.json", "seed", { seed });
      await writePrivateArtifact(roots, "protocol.json", "protocol", { id: reviewId(seed, "registration", registration) });
      const rows = await runPrivateReplay({ roots, flags, turns, registration, modules, review, seed });
      if (build) { await verifyBuild(root, build); await writePrivateArtifact(roots, "code.json", "code", { head, buildDigest: build.outputSha256 }); }
      await writePrivateArtifact(roots, "observations.json", "observations", rows);
      await writePrivateArtifact(roots, "review.json", "review", blindSheets(rows));
      await writePrivateArtifact(roots, "summary-unjudged.json", "summary", [summarizePrivate(rows, registration, "strict"), summarizePrivate(rows, registration)]);
    }
    stdout("private_completed"); return 0;
  } catch (error) {
    const code = privateCode(error);
    if (outputCreated) await writePrivateArtifact(roots, "error.json", "error", { code }).catch(() => {});
    throw new PrivateError(code);
  }
}
