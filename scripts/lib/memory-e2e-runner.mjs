import { mkdir, mkdtemp, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ARMS, digest, sourceOnly, contextFor, questionsFor } from "./memory-e2e-dataset.mjs";
import { Budget, BenchmarkError, bounded, codeOf, failureKindOf, captureLlm, meteredEmbeddings, meteredRuntime } from "./memory-e2e-providers.mjs";
import { lexicalDiagnostic, summarize } from "./memory-e2e-report.mjs";

/** Repository-local built imports: deliberately not a new public app API. */
export async function productionModules() {
  const [harness, bujo, captureIntake, store, search, runtime, retrieval, journal, extensions] = await Promise.all([
    import("../../packages/agent-harness/dist/index.js"), import("../../packages/memory/dist/bujo/index.js"),
    import("../../packages/memory/dist/bujo/capture-intake.js"), import("../../packages/memory/dist/store/index.js"),
    import("../../packages/memory/dist/search/index.js"), import("../../packages/runtime-adapter/dist/index.js"),
    import("../../packages/agent-app/dist/memory-retrieval.js"), import("../../packages/agent-app/dist/memory-journal.js"),
    import("../../packages/agent-app/dist/runtime-option-extensions.js"),
  ]);
  return { harness, bujo, captureIntake, store, search, runtime, retrieval, journal, extensions };
}

export function automaticRecallObservation({ block, outcome, query, selectHits, failure }) {
  const selected = outcome === null ? null : selectHits(outcome.hits, { query });
  return {
    content: block?.content ?? null,
    source: block?.source ?? null,
    bytes: block === undefined ? 0 : Buffer.byteLength(block.content, "utf8"),
    hitCount: selected?.length ?? (block === undefined && outcome === null ? 0 : null),
    truncated: block?.truncated ?? false,
    retrievalMode: outcome?.retrievalMode ?? null,
    degradation: outcome?.degradation?.code ?? null,
    status: failure === undefined ? "completed" : codeOf(failure),
  };
}

export function readySnapshot(snapshot) {
  const intake = snapshot.intake;
  if (!intake || ["pending", "dead", "due", "transitioning", "retrying"].some((key) => intake[key] !== 0)) return false;
  if (snapshot.capture !== undefined || snapshot.shutdown?.timedOut || snapshot.shutdown?.discarded > 0) return false;
  const index = snapshot.index;
  return !index || ["queued", "inFlight", "remainingBacklog", "recoveryFilesRemaining", "failed", "dropped", "discarded"].every((key) => index[key] === 0);
}

/**
 * Classify only evaluator-proven capture failures that may follow the production
 * durable intake schedule. The caller supplies the latest capture event from the
 * current attempt; this function never searches historical/global events.
 */
export function captureRetryCause(item, captureAttempt) {
  if (item.lastError === "model_output") {
    return captureAttempt?.status === "capture_timeout_settled"
      ? "settled_capture_timeout" : "model_output";
  }
  if (item.lastError === "provider"
    && captureAttempt?.status === "capture_step_budget_exhausted"
    && captureAttempt?.failureKind === "budget_exceeded"
    && captureAttempt?.providerReportedFailureKind === "usage_limit"
    && captureAttempt?.maxTurnsHit === true) {
    return "finite_capture_step";
  }
  return null;
}

export function currentCaptureRetryCause(events, cursor, tag, item) {
  const captureAttempt = events.slice(cursor).findLast((entry) => (
    entry.groupId === tag.groupId && entry.arm === tag.arm
    && ["extraction", "reconciliation"].includes(entry.stage)
  ));
  return { cause: captureRetryCause(item, captureAttempt), nextCursor: events.length };
}

/** A timeout returns no success; the caller must close/settle the owned store before deletion. */
export async function awaitReady(store, timeoutMs, budget, recovery = null) {
  let timer;
  let scheduledRetries = 0;
  let previousSchedule = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BenchmarkError("readiness_timeout")), timeoutMs);
  });
  try {
    for (;;) {
      const flush = Promise.resolve().then(() => store.flush());
      await Promise.race([budget ? budget.track(flush) : flush, timeout]);
      const snapshot = store.queueSnapshot();
      if (readySnapshot(snapshot)) {
        if (recovery !== null) {
          const inspection = await recovery.inspect();
          const item = inspection.items.find((candidate) => candidate.id === recovery.id);
          if (item?.state !== "resolved" || item.attempt !== scheduledRetries) {
            throw new BenchmarkError("capture_recovery_invalid");
          }
          recovery.onReady?.({
            attempt: item.attempt + 1,
            priorFailures: item.attempt,
            status: item.attempt === 0 ? "first_attempt_success" : "recovered_success",
          });
        }
        return snapshot;
      }
      if (recovery === null) throw new BenchmarkError("capture_not_ready");
      const inspection = await recovery.inspect();
      const failed = inspection.items.filter((item) => ["pending", "dead"].includes(item.state));
      if (failed.length !== 1 || failed[0].id !== recovery.id || failed[0].attempt < 1) {
        throw new BenchmarkError("capture_not_ready");
      }
      const recoveryCause = recovery.retryCause?.(failed[0])
        ?? (failed[0].lastError === "model_output" ? "model_output" : null);
      if (recoveryCause === null) throw new BenchmarkError("capture_not_ready");
      if (!["model_output", "settled_capture_timeout", "finite_capture_step"].includes(recoveryCause)) {
        throw new BenchmarkError("capture_recovery_invalid");
      }
      if (failed[0].state === "dead" || failed[0].attempt >= recovery.maxAttempts) {
        recovery.onExhausted?.({
          attempt: failed[0].attempt, failureKind: failed[0].lastError, recoveryCause,
        });
        throw new BenchmarkError("capture_not_ready");
      }
      if (scheduledRetries >= recovery.maxAttempts - 1) throw new BenchmarkError("capture_recovery_invalid");
      const persisted = await recovery.persistedSchedule(failed[0]);
      if (persisted.id !== failed[0].id || persisted.attempt !== failed[0].attempt
        || !Number.isFinite(Date.parse(persisted.nextAttemptAt))) {
        throw new BenchmarkError("capture_recovery_invalid");
      }
      const scheduleIdentity = `${persisted.id}:${persisted.attempt}:${persisted.nextAttemptAt}`;
      if (scheduleIdentity === previousSchedule) throw new BenchmarkError("capture_recovery_stalled");
      const advanceMs = recovery.advanceClock(persisted.nextAttemptAt);
      if (!Number.isFinite(advanceMs) || advanceMs <= 0) throw new BenchmarkError("capture_recovery_invalid");
      previousSchedule = scheduleIdentity;
      scheduledRetries += 1;
      recovery.onRetry({
        attempt: failed[0].attempt,
        failureKind: failed[0].lastError,
        recoveryCause,
        nextAttemptAt: persisted.nextAttemptAt,
        advanceMs,
      });
    }
  } finally { clearTimeout(timer); }
}

/** Read only the retry coordinates from the evaluator-owned durable intake record. */
export async function persistedCaptureRetrySchedule(source, expected) {
  let record;
  try { record = JSON.parse(await readFile(source, "utf8")); } catch {
    throw new BenchmarkError("capture_recovery_invalid");
  }
  if (record?.state !== "pending" || record.id !== expected.id || record.attempt !== expected.attempt
    || typeof record.nextAttemptAt !== "string" || !Number.isFinite(Date.parse(record.nextAttemptAt))) {
    throw new BenchmarkError("capture_recovery_invalid");
  }
  return { id: record.id, attempt: record.attempt, nextAttemptAt: record.nextAttemptAt };
}

/**
 * Latest structured capture (extraction/reconciliation) failure category for a
 * trial tag, or null. Readiness status stays primary; this preserves the second
 * fact instead of replacing it.
 */
export function captureFailureKindFor(events, tag) {
  const found = events.findLast((entry) => entry.groupId === tag.groupId && entry.arm === tag.arm
    && ["extraction", "reconciliation", "capture_recovery"].includes(entry.stage) && typeof entry.failureKind === "string");
  return found?.failureKind ?? null;
}

const INTAKE_FAILURES = new Set(["model_output", "provider", "processing"]);
const EMBEDDING_ERROR_PATTERNS = Object.freeze([
  ["vector_count", /embedding provider returned \d+ vectors for \d+/u],
  ["vector_dimension", /embedding dimension mismatch/u],
  ["vector_numeric", /embedding vector .* non-finite/u],
]);

/** Fixed-vocabulary classification only; raw exception text is never retained. */
function embeddingAcceptanceErrorClass(error, operation) {
  const message = error instanceof Error ? error.message : "";
  const known = EMBEDDING_ERROR_PATTERNS.find(([, pattern]) => pattern.test(message));
  if (known) return known[0];
  if (operation === "knn" && (error?.name === "SqliteError" || /sqlite/iu.test(message))) return "knn_query";
  return "embedding_processing";
}

/**
 * Closed-benchmark instrumentation around the store's existing DB methods.
 * The wrappers rethrow the identical error and never inspect or retain texts,
 * records, vectors, SQL, paths, or exception messages.
 */
export function instrumentCaptureStoreDiagnostics(store, { budget, tag }) {
  const db = store?.db;
  if (!db || typeof db !== "object") return false;
  for (const [method, operation] of [["findSimilarMany", "knn"], ["prepareUpsertVectors", "persistence"]]) {
    if (typeof db[method] !== "function") continue;
    const original = db[method].bind(db);
    db[method] = async (...args) => {
      const row = { ...tag, stage: "embedding_acceptance", operation, status: "started", errorClass: null, durationMs: null };
      budget.events.push(row);
      const started = performance.now();
      try {
        const value = await original(...args);
        row.status = "accepted";
        return value;
      } catch (error) {
        row.status = "rejected";
        row.errorClass = embeddingAcceptanceErrorClass(error, operation);
        throw error;
      } finally { row.durationMs = performance.now() - started; }
    };
  }
  return true;
}

function sanitizedIntakeDiagnostic(inspection) {
  const failures = Array.isArray(inspection?.items) ? inspection.items.flatMap((item) => {
    if (!INTAKE_FAILURES.has(item?.lastError)) return [];
    return [{
      state: typeof item.state === "string" ? item.state : "unknown",
      attempt: Number.isSafeInteger(item.attempt) && item.attempt >= 0 ? item.attempt : null,
      lastError: item.lastError,
    }];
  }) : [];
  return {
    status: "captured",
    itemCount: Array.isArray(inspection?.items) ? inspection.items.length : null,
    temporaryCount: Number.isSafeInteger(inspection?.temporary) ? inspection.temporary : null,
    failures,
  };
}

function latestCaptureBoundary(events, tag) {
  const taggedRejection = (entry, stage) => entry.groupId === tag.groupId && entry.arm === tag.arm
    && entry.status === "rejected" && entry.stage === stage;
  // A reconciliation guard happens after accepted KNN and is the most precise
  // terminal boundary even though the store later reduces it to intake/provider.
  const reconciliation = events.findLast((entry) => taggedRejection(entry, "reconciliation_preflight"));
  if (reconciliation) {
    return {
      errorStage: "reconciliation_preflight",
      errorClass: reconciliation.errorClass === "capture_context_budget_exceeded"
        ? reconciliation.errorClass : null,
    };
  }
  // The store acceptance wrapper is the outer semantic boundary and is more
  // precise than its nested vector-shape observation, regardless of push order.
  const row = events.findLast((entry) => taggedRejection(entry, "embedding_acceptance"))
    ?? events.findLast((entry) => taggedRejection(entry, "embedding_validation"));
  if (!row) return { errorStage: "capture_intake", errorClass: null };
  return {
    errorStage: row.stage === "embedding_validation" ? "embedding_vector_validation"
      : row.operation === "knn" ? "embedding_knn" : "embedding_persistence",
    errorClass: typeof row.errorClass === "string" ? row.errorClass : null,
  };
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
  const selected = corpus.groups.filter((group) => plan.groupIds.includes(group.id));
  if (selected.some((group) => Array.isArray(group.questions))) {
    return runConversationBatchedBenchmark({ corpus, plan, directory, modules, providerFactory, kind, hooks });
  }
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
        await writeFile(identityPath, plan.readerPrompt?.text ?? "You are a helpful assistant. Answer the current request concisely using available evidence. Do not invent personal details.\n", { mode: 0o600 });
        providers = await event(tag, "provider_setup", () => providerFactory({ workspace, sessionsRoot, tag, source, modules, plan }));
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
        if (arm === "full-history" && ["context_budget_exceeded", "native_context_limit"].includes(trial.status)) {
          trial.status = "not_applicable";
          trial.reason = trial.runtimeFailureKind === "context_limit" ? "native_context_limit" : "full_history_does_not_fit";
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
      manifest: { ...plan, executionKind: kind, reservations: budget.used, actualTransportAttempts: null, inputAccounting: "conservative-reservations-chat-framing-and-bounded-embedding-text-not-actual-spend", providerQuality: "unmeasured", trialsNotStarted: plan.workload.trials - trials.length + trials.filter((trial) => trial.status === "unstarted").length, admissionStopped: budget.providerStop !== null || budget.admissionStopped || budget.controller.signal.aborted, providerStop: budget.providerStop },
      trials, capture, events: budget.events, summary: summarize(trials, budget.events, kind, capture),
      review: { status: "pending", reviewerKind: null, rubric: "Judge source-supported correctness, stale claims, abstention, preference usefulness and capture propositions. A small stratified sample suffices; AI review is not human annotation.", groups: groups.map((group) => ({ groupId: group.id, source: sourceOnly(group), evaluation: group.evaluation })) },
    };
  } finally { budget.close(); }
}

export function semanticReviewExport({ groups, trials, plan }) {
  if (typeof plan.locomo?.protocolIdentity !== "string") return {
    status: "pending", reviewerKind: null,
    rubric: "Judge source-supported correctness, stale claims, abstention, preference usefulness and capture propositions. AI review is not human annotation.",
    groups: groups.map((group) => ({ groupId: group.id, source: sourceOnly(group), questions: questionsFor(group).map((question) => ({ id: question.id, evaluation: question.evaluation })) })),
  };
  const swap = Number.parseInt(plan.locomo.protocolIdentity.slice(0, 1), 16) % 2 === 1;
  const blindLabel = (arm) => (arm === "bujo") === swap ? "A" : "B";
  const questionById = new Map(groups.flatMap((group) => questionsFor(group).map((question) => [question.id, question])));
  return {
    schemaVersion: 1,
    status: "pending_human_review",
    rubric: {
      identity: "human-semantic-v1",
      labels: ["correct", "partial", "incorrect", "abstained"],
      instruction: "Grade whether the answer is supported by the supplied source. Partial means materially incomplete but not contradicted. Abstained means the answer declines for insufficient evidence; assess whether abstention was appropriate.",
      paidAutomaticJudge: false,
    },
    armLabelsBlinded: true,
    sources: groups.map((group) => ({ groupIdentity: digest(group.id), source: sourceOnly(group) })),
    items: trials.filter((trial) => trial.answer !== null).map((trial) => {
      const question = questionById.get(trial.questionId);
      return {
        reviewId: digest(`${plan.locomo.protocolIdentity}:${trial.questionId}:${blindLabel(trial.arm)}`),
        blindArm: blindLabel(trial.arm),
        questionId: trial.questionId,
        question: question?.source.text ?? null,
        reference: question?.evaluation.accepted?.[0] ?? null,
        answer: trial.answer,
        answerable: question?.evaluation.answerable ?? null,
        category: question?.evaluation.locomoCategory ?? null,
        imageAssociated: (question?.evaluation.imageAssociation?.imageAssociatedEvidenceCount ?? 0) > 0,
        imageDependency: question?.evaluation.imageAssociation?.dependency ?? "unknown",
        grade: null,
        notes: null,
      };
    }).sort((left, right) => left.questionId.localeCompare(right.questionId) || left.blindArm.localeCompare(right.blindArm)),
  };
}

/**
 * Conversation-batched variant for external adapters: capture a conversation
 * once per memory arm, then answer each selected question with a fresh harness
 * history while the same disposable store remains open.
 */
async function runConversationBatchedBenchmark({ corpus, plan, directory, modules, providerFactory, kind, hooks = {} }) {
  if (plan.arms.some((arm) => !["full-history", "bujo"].includes(arm))) throw new BenchmarkError("batched_arms_unsupported");
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
  let stop = false;
  try {
    for (const group of groups) for (const arm of plan.arms) {
      if (stop || budget.providerStop !== null) { stop = true; break; }
      const source = sourceOnly(group);
      const captureTurns = source.captureTurns ?? source.turns;
      const providerSource = { id: source.id, turns: source.turns, ...(source.contextPolicy === undefined ? {} : { contextPolicy: source.contextPolicy }) };
      const questions = questionsFor(group);
      if (questions.length === 0) continue;
      const armTrials = questions.map((question) => ({
        groupId: group.id, questionId: question.id, arm, category: question.evaluation.category,
        locomoCategory: question.evaluation.locomoCategory ?? null,
        status: "unstarted", reason: null, answer: null, automatic: [], rawRetrievals: [], tools: [], warnings: [], readiness: [], inventory: [],
        semanticGrade: null, humanGrade: null, runtimeFailureKind: null, captureFailureKind: null,
      }));
      trials.push(...armTrials);
      const work = await mkdtemp(join(directory, "work-"));
      let providers, store, ingest, service;
      let activeRetrievalTag = null;
      let activeAutomaticObservation = null;
      const readers = [];
      let cleanupOk = true;
      let now = new Date(source.turns[0].timestamp);
      const memoryRoot = join(work, "memory");
      const sessionsRoot = join(work, "sessions");
      const workspace = join(work, "reader-workspace");
      const identityPath = join(workspace, "IDENTITY.md");
      const sharedWarnings = [];
      const sharedReadiness = [];
      const sharedInventory = [];
      let sharedHealth;
      let sharedStorageBytes;
      const baseTag = { groupId: group.id, arm };
      try {
        budget.reserve({});
        await mkdir(workspace, { mode: 0o700 });
        await mkdir(sessionsRoot, { mode: 0o700 });
        await writeFile(identityPath, plan.readerPrompt?.text ?? "You are a helpful assistant. Answer the current request concisely using available evidence. Do not invent personal details.\n", { mode: 0o600 });
        providers = await event(baseTag, "provider_setup", () => providerFactory({ workspace, sessionsRoot, tag: baseTag, source: providerSource, modules, plan }));
        if (providers.kind !== kind) throw new BenchmarkError("provider_mode_mismatch");
        const base = {
          identityPath, cwd: workspace, model: providers.readerModel, now: () => now,
          historyStore: modules.harness.createInMemoryHistoryStore({ maxMessages: 100 }),
          onMemoryWarning: () => sharedWarnings.push("memory_warning"),
          createRunId: (() => { let run = 0; return () => `${group.id}-${arm}-${++run}`; })(),
          runtimeOptions: { piSessionsRoot: sessionsRoot, compaction: { enabled: false }, piMaxRetries: 0, effort: "none" },
          toolPolicy: modules.harness.createToolPolicy({ allowedTools: [] }),
        };
        if (arm === "bujo") {
          const embeddings = meteredEmbeddings(providers.embeddings, { budget, tag: baseTag, dimension: providers.dim });
          const llm = captureLlm(providers.extractor, { model: providers.extractorModel, workspace, sessionsRoot, budget, tag: baseTag, capture: (entry) => capture.push(entry) });
          await event(baseTag, "setup", () => modules.bujo.safeRebuildMemoryIndex({ root: memoryRoot, tier: arm, embeddings, dim: providers.dim }));
          store = modules.bujo.createBujoMemoryStore({ root: memoryRoot, tier: arm, clock: () => now, embeddings, dim: providers.dim, llm, logger: { warn: () => sharedWarnings.push("store_warning") }, backgroundDrainTimeoutMs: 10000 });
          instrumentCaptureStoreDiagnostics(store, { budget, tag: baseTag });
          hooks.store?.(store, baseTag);
          let historicalAssistant = "";
          let admitted = 0;
          // The harness is reused across turns, so its callback must close over
          // shared per-turn slots rather than the first loop iteration's bindings.
          let admissionStarted = 0;
          let admission = null;
          for (const turn of captureTurns) {
            // Each completed source turn owns its admission clock. The prior
            // turn has fully resolved before this loop advances, so a virtual
            // retry clock must not leak into the next source observation.
            now = new Date(turn.timestamp);
            historicalAssistant = turn.assistant;
            admissionStarted = 0;
            admission = null;
            ingest = ingest ?? modules.harness.createAgentHarness({
              ...base, runtime: { async run() { return { text: historicalAssistant }; } },
              memoryWriteMode: "capture",
              memory: {
                async load() { return undefined; },
                async persistCompletedTurn(completed) {
                  hooks.admission?.(completed, baseTag);
                  admissionStarted = performance.now();
                  const result = await event(baseTag, "admission", () => store.persistCompletedTurn(completed));
                  admission = result;
                  if (result.admissionStatus !== "duplicate") admitted += 1;
                  return result;
                },
              },
            });
            // Scope capture-failure evidence to this turn before admission can
            // start its background worker. Later retries advance this cursor.
            let captureEventCursor = budget.events.length;
            const response = await event(baseTag, "replay", () => ingest.run({ conversationId: `${group.id}-${turn.sessionId}`, userMessage: turn.user, sender: { displayName: turn.speaker }, abortSignal: budget.controller.signal }));
            if (response.failure || sharedWarnings.includes("memory_warning")) throw new BenchmarkError("admission_failed");
            const recoveryConfig = plan.locomo?.captureRecovery;
            // Recovery is a bounded plan capability, not a protocol-name side
            // effect. Only the native durable intake chooses retry timing.
            const hasCaptureRecovery = Number.isSafeInteger(recoveryConfig?.maxAttempts)
              && recoveryConfig.maxAttempts > 1
              && recoveryConfig?.policy === "native_persisted_exponential_v1";
            const recovery = hasCaptureRecovery && admission !== null ? {
              id: admission.id,
              maxAttempts: recoveryConfig.maxAttempts,
              inspect: () => modules.captureIntake.inspectCompletedTurnIntake(memoryRoot, now),
              persistedSchedule: (item) => persistedCaptureRetrySchedule(admission.source, item),
              advanceClock: (nextAttemptAt) => {
                const target = Date.parse(nextAttemptAt);
                const advanceMs = target - now.getTime();
                if (!Number.isFinite(target) || advanceMs <= 0) return Number.NaN;
                now = new Date(target);
                return advanceMs;
              },
              retryCause: (item) => {
                const classified = currentCaptureRetryCause(
                  budget.events, captureEventCursor, baseTag, item,
                );
                captureEventCursor = classified.nextCursor;
                if (classified.cause === "finite_capture_step"
                  && recoveryConfig.finiteStepPolicy !== "current_attempt_capture_max_turns_only") {
                  return null;
                }
                return classified.cause;
              },
              onRetry: ({ attempt, failureKind, recoveryCause, nextAttemptAt, advanceMs }) => {
                budget.events.push({
                  ...baseTag, stage: "capture_recovery", status: "scheduled", attempt,
                  failureKind, recoveryCause, nextAttemptAt, advanceMs, durationMs: 0,
                });
              },
              onReady: ({ attempt, priorFailures, status }) => budget.events.push({
                ...baseTag, stage: "capture_recovery", status, attempt, priorFailures, durationMs: 0,
              }),
              onExhausted: ({ attempt, failureKind, recoveryCause }) => budget.events.push({
                ...baseTag, stage: "capture_recovery", status: "exhausted", attempt,
                failureKind, recoveryCause, durationMs: 0,
              }),
            } : null;
            if (hasCaptureRecovery && (admission === null
              || modules.captureIntake?.inspectCompletedTurnIntake === undefined)) {
              throw new BenchmarkError("capture_recovery_unavailable");
            }
            const snapshot = await event(baseTag, "readiness_wait", () => awaitReady(
              store, plan.perCall.readinessTimeoutMs, budget, recovery,
            ));
            budget.events.push({ ...baseTag, stage: "admission_to_ready", status: "completed", durationMs: performance.now() - admissionStarted });
            if (snapshot.intake.resolved < admitted) throw new BenchmarkError("admission_unaccounted");
            sharedReadiness.push({ turnId: turn.id, snapshot });
            const db = modules.store.openMemoryDb({ path: modules.bujo.resolveActiveMemoryDbPath(memoryRoot), readOnly: true, embeddings, dim: providers.dim, clock: () => now });
            try {
              const inventory = { ...baseTag, stage: "inventory", turnId: turn.id, records: db.allMemories().map(({ id, text, status, createdAt }) => ({ id, text, status, createdAt })) };
              capture.push(inventory); sharedInventory.push(inventory);
            } finally { db.close(); }
          }
          sharedHealth = await event(baseTag, "audit", async () => modules.bujo.auditBujoMemoryHealth({ root: memoryRoot, mode: arm, now, configuredEmbeddingModel: embeddings.id, configuredDimension: providers.dim }));
          if (sharedHealth.status !== "healthy") throw new BenchmarkError("health_not_ready");
          sharedStorageBytes = await directoryBytes(memoryRoot);
          const backendMethod = typeof store.recallWithOutcome === "function" ? "recallWithOutcome" : "recall";
          const backendRecall = store[backendMethod].bind(store);
          store[backendMethod] = async (...args) => {
            const tag = activeRetrievalTag ?? baseTag;
            const value = await event(tag, "backend_retrieval", () => backendRecall(...args));
            const outcome = backendMethod === "recallWithOutcome"
              ? value : { hits: value, retrievalMode: "hybrid" };
            if (activeAutomaticObservation !== null) activeAutomaticObservation.outcome = outcome;
            const attributedTrial = armTrials.find((candidate) => candidate.questionId === tag.questionId);
            if (attributedTrial !== undefined) attributedTrial.rawRetrievals.push({
              method: backendMethod,
              status: "completed",
              hits: Array.isArray(outcome?.hits) ? outcome.hits : null,
              retrievalMode: outcome?.retrievalMode ?? null,
              degradation: outcome?.degradation ?? null,
            });
            const row = budget.events.findLast((entry) => entry.groupId === tag.groupId
              && entry.questionId === tag.questionId && entry.arm === tag.arm && entry.stage === "backend_retrieval");
            if (row !== undefined) {
              row.hitCount = Array.isArray(outcome?.hits) ? outcome.hits.length : null;
              row.retrievalMode = typeof outcome?.retrievalMode === "string" ? outcome.retrievalMode : null;
              row.degradation = typeof outcome?.degradation?.code === "string" ? outcome.degradation.code : null;
            }
            return value;
          };
          service = new modules.retrieval.MemoryRetrievalService(store);
          const load = service.load.bind(service);
          service.load = async (...args) => {
            const tag = activeRetrievalTag ?? baseTag;
            const observation = { outcome: null };
            activeAutomaticObservation = observation;
            let block;
            let failure;
            try {
              block = await event(tag, "automatic_recall", () => load(...args));
            } catch (error) {
              failure = error;
            } finally {
              activeAutomaticObservation = null;
            }
            const trial = armTrials.find((candidate) => candidate.questionId === tag.questionId);
            if (trial === undefined) throw new BenchmarkError("automatic_recall_unattributed");
            const query = typeof args[1] === "string" ? args[1] : args[0];
            trial.automatic.push(automaticRecallObservation({
              block,
              outcome: observation.outcome,
              query,
              selectHits: modules.bujo.selectAutomaticRecallHits,
              failure,
            }));
            if (failure !== undefined) throw failure;
            return block;
          };
        }
        for (const [index, question] of questions.entries()) {
          const trial = armTrials[index];
          const tag = { groupId: group.id, questionId: question.id, arm };
          let reader;
          trial.status = "started";
          activeRetrievalTag = tag;
          try {
            now = new Date(question.source.timestamp);
            const projectedMessages = source.turns.length * 2;
            const history = modules.harness.createInMemoryHistoryStore({
              maxMessages: projectedMessages + plan.perCall.readerHistoryHeadroomMessages,
            });
            await history.append(`question-${question.id}`, contextFor(source, arm));
            const extension = arm === "bujo" ? modules.extensions.composeRuntimeOptionExtensions([
              modules.retrieval.createSharedMemoryRecallRuntimeExtension(service, { onUnavailable: () => trial.warnings.push("recall_unavailable") }),
              modules.journal.createMemoryJournalRuntimeExtension(service, { clock: () => now, env: { TZ: "UTC" }, onUnavailable: () => trial.warnings.push("journal_unavailable") }),
            ]) : undefined;
            const toolStarts = new Map();
            const metered = meteredRuntime(providers.reader, { budget, stage: "reader", tag });
            reader = modules.harness.createAgentHarness({
              ...base, historyStore: history, memory: service, memoryWriteMode: "disabled",
              toolPolicy: modules.harness.createToolPolicy({ allowedTools: arm === "bujo" ? ["MemoryRecall", "MemoryJournal"] : [] }),
              runtimeOptionsForRequest: extension,
              runtime: { async run(system, options) {
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
              } },
            });
            readers.push(reader);
            const response = await event(tag, "question_total", () => reader.run({ conversationId: `question-${question.id}`, userMessage: question.source.text, abortSignal: budget.controller.signal }));
            if (response.failure) throw new BenchmarkError(trial.runtimeFailure ?? "reader_failed");
            trial.answer = response.text;
            trial.lexicalDiagnostic = lexicalDiagnostic(response.text, question.evaluation, kind);
            trial.status = "completed";
          } catch (error) {
            trial.status = codeOf(error);
            if (arm === "full-history" && ["context_budget_exceeded", "native_context_limit"].includes(trial.status)) {
              trial.status = "not_applicable";
              trial.reason = trial.runtimeFailureKind === "context_limit" ? "native_context_limit" : "full_history_does_not_fit";
            }
          } finally {
            activeRetrievalTag = null;
          }
          if (budget.controller.signal.aborted || budget.providerStop !== null) break;
        }
        const stopReason = budget.providerStop?.code ?? (budget.controller.signal.aborted ? "runtime_budget_exhausted" : null);
        if (stopReason !== null) for (const trial of armTrials.filter((value) => value.status === "unstarted")) {
          trial.reason = `batch_stopped_before_start:${stopReason}`;
        }
        for (const trial of armTrials) {
          trial.warnings.push(...sharedWarnings);
          trial.readiness = sharedReadiness;
          trial.inventory = sharedInventory;
          if (sharedHealth !== undefined) trial.health = sharedHealth;
          if (sharedStorageBytes !== undefined) trial.storageBytes = sharedStorageBytes;
        }
      } catch (error) {
        const status = codeOf(error);
        let captureFailureKind = captureFailureKindFor(budget.events, baseTag);
        if (arm === "bujo" && store && typeof modules.captureIntake?.inspectCompletedTurnIntake === "function") {
          const boundary = latestCaptureBoundary(budget.events, baseTag);
          try {
            const diagnostic = sanitizedIntakeDiagnostic(modules.captureIntake.inspectCompletedTurnIntake(memoryRoot, now));
            const intakeClass = diagnostic.failures.at(-1)?.lastError ?? null;
            captureFailureKind ??= intakeClass;
            budget.events.push({
              ...baseTag, stage: "capture_diagnostic", status: diagnostic.status,
              errorStage: boundary.errorStage,
              errorClass: boundary.errorClass ?? intakeClass,
              intake: diagnostic,
              durationMs: 0,
            });
          } catch {
            budget.events.push({
              ...baseTag, stage: "capture_diagnostic", status: "inspection_unavailable",
              errorStage: boundary.errorStage, errorClass: boundary.errorClass,
              intake: null, durationMs: 0,
            });
          }
        }
        for (const trial of armTrials) {
          // A shared capture failure happens before any question starts, but it is
          // still the reason every unstarted arm trial was blocked. Preserve the
          // sanitized second fact without pretending those readers ran.
          if (captureFailureKind !== null) trial.captureFailureKind = captureFailureKind;
          if (trial.status === "started") {
            trial.status = status;
            if (store) trial.failureReadiness = store.queueSnapshot();
          } else if (trial.status === "unstarted") {
            trial.reason = `batch_failed_before_start:${status}`;
          }
        }
      } finally {
        const cleanupEvent = { ...baseTag, stage: "cleanup", status: "started", durationMs: null };
        const cleanupStarted = performance.now(); budget.events.push(cleanupEvent);
        const compositeReader = { dispose: async () => {
          const results = await Promise.allSettled(readers.map((value) => value.dispose()));
          if (results.some((result) => result.status === "rejected")) throw new BenchmarkError("cleanup_failed");
        } };
        try {
          await cleanupTrial({ reader: compositeReader, ingest, service, store, providers, budget }, plan.perCall.cleanupTimeoutMs ?? 10000);
          cleanupEvent.status = "completed";
        } catch (error) {
          cleanupEvent.status = codeOf(error); cleanupOk = false;
          for (const trial of armTrials) {
            if (trial.status === "unstarted") trial.reason = `${trial.reason ?? "batch_stopped_before_start"};cleanup_failed`;
            else { trial.primaryStatus = trial.status; trial.status = "cleanup_failed"; }
          }
        } finally { cleanupEvent.durationMs = performance.now() - cleanupStarted; }
        if (cleanupOk) await rm(work, { recursive: true, force: true });
        for (const trial of armTrials) trial.cleanup = cleanupOk ? "removed_owned_store" : "retained_unsettled_owned_store";
      }
      if (!cleanupOk || budget.controller.signal.aborted || budget.providerStop !== null) stop = true;
    }
    return {
      manifest: { ...plan, executionKind: kind, reservations: budget.used, actualTransportAttempts: null, inputAccounting: "conservative-reservations-chat-framing-and-bounded-embedding-text-not-actual-spend", providerQuality: "unmeasured", trialsNotStarted: plan.workload.trials - trials.length + trials.filter((trial) => trial.status === "unstarted").length, admissionStopped: budget.providerStop !== null || budget.admissionStopped || budget.controller.signal.aborted, providerStop: budget.providerStop },
      trials, capture, events: budget.events, summary: summarize(trials, budget.events, kind, capture),
      review: semanticReviewExport({ groups, trials, plan }),
    };
  } finally { budget.close(); }
}
