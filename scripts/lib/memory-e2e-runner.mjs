import { mkdir, mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ARMS, sourceOnly, contextFor } from "./memory-e2e-dataset.mjs";
import { Budget, BenchmarkError, bounded, codeOf, failureKindOf, captureLlm, meteredEmbeddings, meteredRuntime } from "./memory-e2e-providers.mjs";
import { lexicalDiagnostic, summarize } from "./memory-e2e-report.mjs";

/** Repository-local built imports: deliberately not a new public app API. */
export async function productionModules() {
  const [harness, bujo, store, search, runtime, retrieval, journal, extensions] = await Promise.all([
    import("../../packages/agent-harness/dist/index.js"), import("../../packages/memory/dist/bujo/index.js"),
    import("../../packages/memory/dist/store/index.js"), import("../../packages/memory/dist/search/index.js"),
    import("../../packages/runtime-adapter/dist/index.js"), import("../../packages/agent-app/dist/memory-retrieval.js"),
    import("../../packages/agent-app/dist/memory-journal.js"), import("../../packages/agent-app/dist/runtime-option-extensions.js"),
  ]);
  return { harness, bujo, store, search, runtime, retrieval, journal, extensions };
}

export function readySnapshot(snapshot) {
  const intake = snapshot.intake;
  if (!intake || ["pending", "dead", "due", "transitioning", "retrying"].some((key) => intake[key] !== 0)) return false;
  if (snapshot.capture !== undefined || snapshot.shutdown?.timedOut || snapshot.shutdown?.discarded > 0) return false;
  const index = snapshot.index;
  return !index || ["queued", "inFlight", "remainingBacklog", "recoveryFilesRemaining", "failed", "dropped", "discarded"].every((key) => index[key] === 0);
}

/** A timeout returns no success; the caller must close/settle the owned store before deletion. */
export async function awaitReady(store, timeoutMs, budget) {
  let timer;
  try {
    await Promise.race([
      budget ? budget.track(store.flush()) : store.flush(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new BenchmarkError("readiness_timeout")), timeoutMs); }),
    ]);
    const snapshot = store.queueSnapshot();
    if (!readySnapshot(snapshot)) throw new BenchmarkError("capture_not_ready");
    return snapshot;
  } finally { clearTimeout(timer); }
}
/**
 * Latest structured capture (extraction/reconciliation) failure category for a
 * trial tag, or null. Readiness status stays primary; this preserves the second
 * fact instead of replacing it.
 */
export function captureFailureKindFor(events, tag) {
  const found = events.findLast((entry) => entry.groupId === tag.groupId && entry.arm === tag.arm
    && (entry.stage === "extraction" || entry.stage === "reconciliation") && typeof entry.failureKind === "string");
  return found?.failureKind ?? null;
}
/** One overall cleanup deadline; no deletion unless producers and raw work settle. */
export async function cleanupTrial({ reader, ingest, service, store, providers, budget }, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  const step = async (fn) => {
    if (remaining() <= 0) throw new BenchmarkError("cleanup_timeout");
    return await bounded(Promise.resolve().then(fn), { timeoutMs: remaining(), code: "cleanup_timeout" });
  };
  const all = async (resources) => {
    const results = await Promise.allSettled(resources.map((fn) => budget.track(Promise.resolve().then(fn))));
    if (results.some((result) => result.status === "rejected")) throw new BenchmarkError("cleanup_failed");
  };
  try {
    // Harness disposal drains admitted runs before the store can finish its own
    // downstream intake/capture/index producers. Never snapshot settlement concurrently.
    await step(() => all([() => reader?.dispose(), () => ingest?.dispose()]));
    service?.releaseAllTurns();
    await step(() => all([() => store?.close()]));
    const shutdown = store?.queueSnapshot().shutdown;
    if (store && (!shutdown || shutdown.timedOut || shutdown.discarded > 0)) throw new BenchmarkError("store_shutdown_unsettled");
    budget.stopAdmission();
    await step(() => all([() => providers?.close()]));
    await step(() => budget.settle(remaining()));
    // Only a proven clean boundary can reopen admission for the next trial.
    if (!budget.controller.signal.aborted) budget.admissionStopped = false;
  } catch (error) {
    budget.stopAdmission();
    budget.controller.abort();
    throw error;
  }
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new BenchmarkError("unsafe_store_entry");
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

export async function runBenchmark({ corpus, plan, directory, modules, providerFactory, kind, hooks = {} }) {
  const budget = new Budget(plan);
  const trials = [], capture = [];
  const groups = corpus.groups.filter((group) => plan.groupIds.includes(group.id));
  const event = async (tag, stage, fn) => {
    const row = { ...tag, stage, status: "started", durationMs: null };
    budget.events.push(row);
    const start = performance.now();
    try { const result = await budget.wait(Promise.resolve().then(() => { budget.reserve({}); return fn(); })); row.status = "completed"; return result; }
    catch (error) { row.status = codeOf(error); throw error; }
    finally { row.durationMs = performance.now() - start; }
  };
  try {
    // Arms come from the confirmed plan, so a corpus that exercises a narrower
    // set cannot silently run combinations its budget never reserved.
    trialsLoop: for (const group of groups) for (const arm of plan.arms ?? ARMS) {
      // Terminal provider stop (fatal auth/quota): no further provider
      // factory, store, model or embedding work. Remaining trials stay
      // unpushed so trialsNotStarted counts them as unstarted, never as
      // successes or attempted failures.
      if (budget.providerStop !== null) break trialsLoop;
      const source = sourceOnly(group);
      const tag = { groupId: group.id, arm };
      const trial = { ...tag, category: group.evaluation.category, status: "started", answer: null, automatic: [], tools: [], warnings: [], readiness: [], inventory: [], semanticGrade: null, humanGrade: null, runtimeFailureKind: null, captureFailureKind: null };
      trials.push(trial);
      const work = await mkdtemp(join(directory, "work-"));
      let providers, store, ingest, reader, service;
      let cleanupOk = true;
      let now = new Date(source.turns[0].timestamp);
      const memoryRoot = join(work, "memory");
      const sessionsRoot = join(work, "sessions");
      const workspace = join(work, "reader-workspace");
      const identityPath = join(workspace, "IDENTITY.md");
      try {
        budget.reserve({});
        await mkdir(workspace, { mode: 0o700 });
        await mkdir(sessionsRoot, { mode: 0o700 });
        await writeFile(identityPath, "You are a helpful assistant. Answer the current request concisely using available evidence. Do not invent personal details.\n", { mode: 0o600 });
        providers = await event(tag, "provider_setup", () => providerFactory({ workspace, sessionsRoot, tag, source, modules }));
        if (providers.kind !== kind) throw new BenchmarkError("provider_mode_mismatch");
        const memoryArm = ["lite", "journal", "bujo"].includes(arm);
        const base = {
          identityPath, cwd: workspace, model: providers.readerModel, now: () => now,
          historyStore: modules.harness.createInMemoryHistoryStore({ maxMessages: 100 }),
          onMemoryWarning: () => trial.warnings.push("memory_warning"),
          createRunId: (() => { let run = 0; return () => `${group.id}-${arm}-${++run}`; })(),
          runtimeOptions: { piSessionsRoot: sessionsRoot, compaction: { enabled: false }, piMaxRetries: 0, effort: "none" },
          toolPolicy: modules.harness.createToolPolicy({ allowedTools: [] }),
        };
        if (memoryArm) {
          const embeddings = arm === "lite" ? undefined : meteredEmbeddings(providers.embeddings, { budget, tag });
          const llm = arm === "bujo" ? captureLlm(providers.extractor, { model: providers.extractorModel, workspace, sessionsRoot, budget, tag, capture: (entry) => capture.push(entry) }) : undefined;
          // Fresh semantic stores need a managed generation for the strict health contract.
          // Empty initialization, before any admitted data: never rebuild captured facts to hide loss.
          if (embeddings) await event(tag, "setup", () => modules.bujo.safeRebuildMemoryIndex({ root: memoryRoot, tier: arm, embeddings, dim: providers.dim }));
          store = modules.bujo.createBujoMemoryStore({ root: memoryRoot, tier: arm, clock: () => now, ...(embeddings ? { embeddings, dim: providers.dim } : {}), ...(llm ? { llm } : {}), logger: { warn: () => trial.warnings.push("store_warning") }, backgroundDrainTimeoutMs: 10000 });
          hooks.store?.(store, tag);
          let historicalAssistant = "";
          let admitted = 0;
          let admissionStarted = 0;
          ingest = modules.harness.createAgentHarness({
            ...base, runtime: { async run() { return { text: historicalAssistant }; } },
            memoryWriteMode: arm === "bujo" ? "capture" : "append-host-summary",
            memory: {
              async load() { return undefined; },
              async appendHostSummary() { throw new BenchmarkError("legacy_capture_used"); },
              async persistCompletedTurn(turn) {
                hooks.admission?.(turn, tag);
                admissionStarted = performance.now();
                const result = await event(tag, "admission", () => store.persistCompletedTurn(turn));
                if (result.admissionStatus !== "duplicate") admitted += 1;
                return result;
              },
            },
          });
          for (const turn of source.turns) {
            now = new Date(turn.timestamp);
            historicalAssistant = turn.assistant;
            const response = await event(tag, "replay", () => ingest.run({
              conversationId: `${group.id}-${turn.sessionId}`, userMessage: turn.user,
              sender: { displayName: turn.speaker }, abortSignal: budget.controller.signal,
            }));
            if (response.failure || trial.warnings.includes("memory_warning")) throw new BenchmarkError("admission_failed");
            const snapshot = await event(tag, "readiness_wait", () => awaitReady(store, plan.perCall.readinessTimeoutMs, budget));
            budget.events.push({ ...tag, stage: "admission_to_ready", status: "completed", durationMs: performance.now() - admissionStarted });
            if (snapshot.intake.resolved < admitted) throw new BenchmarkError("admission_unaccounted");
            trial.readiness.push({ turnId: turn.id, snapshot });
            const db = modules.store.openMemoryDb({ path: modules.bujo.resolveActiveMemoryDbPath(memoryRoot), readOnly: true, ...(embeddings ? { embeddings, dim: providers.dim } : {}), clock: () => now });
            try {
              capture.push({ ...tag, stage: "inventory", turnId: turn.id, records: db.allMemories().map(({ id, text, status, createdAt }) => ({ id, text, status, createdAt })) });
            } finally { db.close(); }
          }
          trial.health = await event(tag, "audit", async () => modules.bujo.auditBujoMemoryHealth({ root: memoryRoot, mode: arm, now, ...(embeddings ? { configuredEmbeddingModel: embeddings.id, configuredDimension: providers.dim } : {}) }));
          if (trial.health.status !== "healthy") throw new BenchmarkError("health_not_ready");
          trial.storageBytes = await directoryBytes(memoryRoot);
          const recall = store.recall.bind(store);
          store.recall = async (...args) => {
            try { return await event(tag, "backend_retrieval", () => recall(...args)); }
            catch (error) { trial.warnings.push("retrieval_failed"); throw error; }
          };
          service = new modules.retrieval.MemoryRetrievalService(store);
          const load = service.load.bind(service);
          service.load = async (...args) => {
            const block = await event(tag, "automatic_recall", () => load(...args));
            trial.automatic.push(block ? { content: block.content } : { content: null });
            return block;
          };
        }
        now = new Date(source.question.timestamp);
        const history = modules.harness.createInMemoryHistoryStore({ maxMessages: 100 });
        await history.append("question", contextFor(source, arm));
        const extension = memoryArm ? modules.extensions.composeRuntimeOptionExtensions([
          modules.retrieval.createSharedMemoryRecallRuntimeExtension(service, { onUnavailable: () => trial.warnings.push("recall_unavailable") }),
          modules.journal.createMemoryJournalRuntimeExtension(service, { clock: () => now, env: { TZ: "UTC" }, onUnavailable: () => trial.warnings.push("journal_unavailable") }),
        ]) : undefined;
        const toolStarts = new Map();
        const metered = meteredRuntime(providers.reader, { budget, stage: "reader", tag });
        reader = modules.harness.createAgentHarness({
          ...base, historyStore: history, memory: service, memoryWriteMode: "disabled",
          toolPolicy: modules.harness.createToolPolicy({ allowedTools: memoryArm ? ["MemoryRecall", "MemoryJournal"] : [] }),
          runtimeOptionsForRequest: extension,
          runtime: {
            async run(system, options) {
              if (trial.warnings.some((warning) => warning.endsWith("unavailable"))) throw new BenchmarkError("tool_unavailable");
              hooks.readerInput?.(system, options, tag);
              const wrapped = { ...options, toolLifecycleSink: async (value) => {
                if (value.phase === "invocation") toolStarts.set(value.toolCallId, performance.now());
                else {
                  const started = toolStarts.get(value.toolCallId);
                  budget.events.push({ ...tag, stage: "explicit_tool", status: value.state === "success" ? "completed" : "tool_failed", durationMs: started === undefined ? null : performance.now() - started });
                }
                trial.tools.push({ phase: value.phase, toolCallId: value.toolCallId, toolName: value.toolName ?? null, ...(value.phase === "invocation" ? { arguments: value.arguments } : { state: value.state, content: value.content }) });
                return await options.toolLifecycleSink?.(value);
              } };
              try { return await metered.run(system, wrapped); }
              catch (error) { trial.runtimeFailure = codeOf(error); trial.runtimeFailureKind = failureKindOf(error); throw error; }
            },
          },
        });
        const response = await event(tag, "question_total", () => reader.run({ conversationId: "question", userMessage: source.question.text, abortSignal: budget.controller.signal }));
        if (response.failure) {
          const failed = budget.events.findLast((entry) => entry.groupId === group.id && entry.arm === arm && entry.stage === "reader" && entry.status !== "completed");
          throw new BenchmarkError(trial.runtimeFailure ?? failed?.status ?? "reader_failed");
        }
        if (trial.warnings.length) throw new BenchmarkError("degraded_trial");
        trial.answer = response.text;
        trial.lexicalDiagnostic = lexicalDiagnostic(response.text, group.evaluation, kind);
        trial.status = "completed";
      } catch (error) {
        trial.status = codeOf(error);
        // A capture failure behind a readiness status is a second fact, not a
        // replacement: keep both, never call the failed capture healthy.
        const captureFailureKind = captureFailureKindFor(budget.events, tag);
        if (captureFailureKind !== null) trial.captureFailureKind = captureFailureKind;
        if (store) trial.failureReadiness = store.queueSnapshot();
        if (arm === "full-history" && trial.status === "context_budget_exceeded") {
          trial.status = "not_applicable"; trial.reason = "full_history_does_not_fit";
        }
      } finally {
        const cleanupEvent = { ...tag, stage: "cleanup", status: "started", durationMs: null };
        const cleanupStarted = performance.now();
        budget.events.push(cleanupEvent);
        try {
          await cleanupTrial({ reader, ingest, service, store, providers, budget }, plan.perCall.cleanupTimeoutMs ?? 10000);
          cleanupEvent.status = "completed";
        } catch (error) {
          cleanupEvent.status = codeOf(error);
          cleanupOk = false; trial.primaryStatus = trial.status; trial.status = "cleanup_failed";
        } finally { cleanupEvent.durationMs = performance.now() - cleanupStarted; }
        if (cleanupOk) await rm(work, { recursive: true, force: true });
        trial.cleanup = cleanupOk ? "removed_owned_store" : "retained_unsettled_owned_store";
      }
      if (!cleanupOk || budget.controller.signal.aborted || budget.providerStop !== null) break trialsLoop;
    }
    return {
      manifest: { ...plan, executionKind: kind, reservations: budget.used, actualTransportAttempts: null, inputAccounting: "estimated-controlled-text-plus-allowance", providerQuality: "unmeasured", trialsNotStarted: plan.workload.trials - trials.length, admissionStopped: budget.providerStop !== null || budget.admissionStopped || budget.controller.signal.aborted, providerStop: budget.providerStop },
      trials, capture, events: budget.events, summary: summarize(trials, budget.events, kind),
      review: { status: "pending", reviewerKind: null, rubric: "Judge source-supported correctness, stale claims, abstention, preference usefulness and capture propositions. A small stratified sample suffices; AI review is not human annotation.", groups: groups.map((group) => ({ groupId: group.id, source: sourceOnly(group), evaluation: group.evaluation })) },
    };
  } finally { budget.close(); }
}
