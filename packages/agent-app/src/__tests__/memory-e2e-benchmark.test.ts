import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import * as harness from "@mono-agent/agent-harness";
import * as bujo from "@mono-agent/memory/bujo";
import * as store from "@mono-agent/memory/store";
import * as search from "@mono-agent/memory/search";
import * as runtime from "@mono-agent/runtime-adapter";
import * as retrieval from "../memory-retrieval.js";
import * as journal from "../memory-journal.js";
import * as extensions from "../runtime-option-extensions.js";

// Non-publishable script modules intentionally have no package exports/declarations.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const script = (name: string): Promise<any> => import(new URL(`../../../../scripts/lib/${name}.mjs`, import.meta.url).href);
const modules = { harness, bujo, captureIntake: bujo, store, search, runtime, retrieval, journal, extensions };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function withStructuredExtractor<T extends { extractor: { run(system: string, options: any): Promise<any> } }>(value: T): T {
  const run = value.extractor.run.bind(value.extractor);
  return {
    ...value,
    extractor: {
      ...value.extractor,
      async run(system: string, options: any) {
        const result = await run(system, options);
        if (options.outputSchema === undefined || typeof result.text !== "string") return result;
        const parsed = JSON.parse(result.text);
        const decisions = options.outputSchema?.properties?.decisions;
        return {
          ...result,
          structuredResult: decisions === undefined ? parsed : { decisions: parsed },
        };
      },
    },
  };
}

async function fixture() {
  const dataset = await script("memory-e2e-dataset");
  const providers = await script("memory-e2e-providers");
  const runner = await script("memory-e2e-runner");
  const loaded = await dataset.loadCorpus();
  const plan = dataset.makePlan(loaded);
  await mkdir(join(root, ".worklab-tmp"), { recursive: true });
  const directory = await mkdtemp(join(root, ".worklab-tmp", "memory-e2e-test-")); dirs.push(directory);
  return {
    ...loaded,
    plan,
    directory,
    modules,
    kind: "scripted",
    providerFactory: (args: any) => withStructuredExtractor(providers.scriptedProviders(args)),
    runner,
    providers,
  };
}

describe("fictional E2E production-path contract, not model quality", () => {
  it("keeps scripted extraction text-only without a schema and supplies structuredResult when selected", async () => {
    const provider = withStructuredExtractor({
      extractor: { run: async (_system: string, _options: any) => ({ text: '{"memories":[],"entities":[],"relations":[]}' }) },
    });
    await expect(provider.extractor.run("system", {})).resolves.toEqual({
      text: '{"memories":[],"entities":[],"relations":[]}',
    });
    await expect(provider.extractor.run("system", { outputSchema: { type: "object" } })).resolves.toMatchObject({
      structuredResult: { memories: [], entities: [], relations: [] },
    });
  });

  it("replays strong completed turns, drains real SQLite, shares Recall and never captures QA", async () => {
    const input = await fixture();
    const admissions: any[] = []; const requests: any[] = []; const stores: bujo.BujoMemoryStore[] = [];
    const legacy = vi.spyOn(bujo.BujoMemoryStore.prototype, "capture").mockRejectedValue(new Error("legacy forbidden"));
    const schedule = vi.spyOn(bujo.BujoMemoryStore.prototype, "scheduleCapture").mockImplementation(() => { throw new Error("legacy forbidden"); });
    const report = await input.runner.runBenchmark({ ...input, hooks: {
      store: (value: bujo.BujoMemoryStore) => stores.push(value),
      admission: (turn: unknown) => admissions.push(turn),
      readerInput: (_system: string, options: any, tag: any) => requests.push({ ...tag, options }),
    } });
    expect(report.trials).toHaveLength(10);
    expect(report.trials.map((trial: any) => trial.status)).toEqual(Array(10).fill("completed"));
    expect(admissions).toHaveLength(24); // 2 histories × 4 turns × 3 memory tiers; no QA write.
    expect(admissions.filter((turn) => turn.captureText !== undefined)).toHaveLength(8);
    expect(admissions[0].summary).toContain("User (Mira):");
    expect(admissions[8].captureText).toContain("Assistant: Thanks for telling me.");
    expect(legacy).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled();
    expect(report.summary.qualityMeasured).toBe(false);
    expect(report.summary.semanticQA.value).toBeNull();
    const memory = report.trials.filter((trial: any) => ["lite", "journal", "bujo"].includes(trial.arm));
    for (const trial of memory) {
      expect(trial.health.status).toBe("healthy");
      expect(trial.readiness).toHaveLength(4);
      expect(trial.tools).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "MemoryRecall", phase: "result", state: "success" })]));
      expect(trial.cleanup).toBe("removed_owned_store");
      expect(trial.health.counts.missingVectors).toBe(0);
    }
    for (const arm of ["recent-only", "full-history"]) {
      const request = requests.find((row) => row.arm === arm);
      expect(Object.keys(request.options.mcpServers ?? {})).toHaveLength(0);
      expect(report.trials.find((trial: any) => trial.arm === arm).tools).toHaveLength(0);
    }
    // Same QA query goes through automatic retrieval and actual MCP Recall, using one query vector.
    const queryEmbeddings = report.events.filter((event: any) => event.groupId === "dev-fact" && event.arm === "journal" && event.stage === "embedding");
    expect(queryEmbeddings).toHaveLength(5); // four captured vectors + one shared query
    expect(report.capture.find((row: any) => row.arm === "lite" && row.stage === "inventory").records[0].createdAt).toBe("2025-01-10T12:00:00.000Z");
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
    expect(stores).toHaveLength(6);
  }, 30000);

  it("captures a batched conversation once and answers independent question contexts", async () => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const group = {
      id: original.id,
      split: "development",
      source: { turns: original.source.turns, contextPolicy: "memory-only" },
      questions: [
        { id: "q-one", source: { text: "First synthetic question?", timestamp: original.source.question.timestamp }, evaluation: { ...original.evaluation, accepted: ["REFERENCE_CANARY"], forbidden: ["ADVERSARIAL_CANARY"], category: "multi-hop", locomoCategory: 1 } },
        { id: "q-two", source: { text: "Second synthetic question?", timestamp: original.source.question.timestamp }, evaluation: { ...original.evaluation, accepted: ["REFERENCE_CANARY"], forbidden: ["ADVERSARIAL_CANARY"], category: "multi-hop", locomoCategory: 1 } },
      ],
    };
    const corpus = { schemaVersion: 1, name: "fictional-v1", arms: ["full-history", "bujo"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-batch" });
    plan.readerPrompt = { id: "synthetic-reader-v1", text: "SHARED_READER_PROMPT with insufficient-evidence abstention.\n", sha256: "synthetic" };
    const providerSources: any[] = [];
    const providerFactory = vi.fn((args: any) => { providerSources.push(args.source); return input.providers.scriptedProviders(args); });
    const admissions: any[] = []; const readerInputs: any[] = [];
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, providerFactory, hooks: {
      admission: (turn: unknown) => admissions.push(turn),
      readerInput: (system: string, options: any, tag: any) => readerInputs.push({ tag, system, messages: options.messages }),
    } });
    expect(report.trials).toHaveLength(4);
    expect(report.trials.every((trial: any) => trial.status === "completed")).toBe(true);
    expect(providerFactory).toHaveBeenCalledTimes(2); // once per arm, never once per question
    expect(JSON.stringify(providerSources)).not.toMatch(/First synthetic question|Second synthetic question|REFERENCE_CANARY|ADVERSARIAL_CANARY/u);
    expect(admissions).toHaveLength(4); // four sessions captured once for the single BuJo arm
    expect(report.capture.filter((row: any) => row.arm === "bujo" && row.stage === "inventory")).toHaveLength(4);
    const bujoTrials = report.trials.filter((trial: any) => trial.arm === "bujo");
    expect(bujoTrials.every((trial: any) => trial.automatic.length === 1)).toBe(true);
    expect(bujoTrials.every((trial: any) => trial.rawRetrievals.length === 2)).toBe(true);
    expect(bujoTrials.flatMap((trial: any) => trial.rawRetrievals).every((entry: any) => entry.status === "completed" && Array.isArray(entry.hits))).toBe(true);
    expect(bujoTrials.map((trial: any) => trial.automatic[0])).toEqual([
      expect.objectContaining({ status: "completed", content: null, source: null, bytes: 0, hitCount: 0, truncated: false, retrievalMode: "hybrid", degradation: null }),
      expect.objectContaining({ status: "completed", content: null, source: null, bytes: 0, hitCount: 0, truncated: false, retrievalMode: "hybrid", degradation: null }),
    ]);
    // Both automatic and scripted explicit requests use recallWithOutcome and
    // are attributed to their question; wrapping recall() alone would miss them.
    const backendEvents = report.events.filter((row: any) => row.arm === "bujo" && row.stage === "backend_retrieval");
    expect(backendEvents).toHaveLength(4);
    expect(backendEvents.every((row: any) => row.status === "completed"
      && typeof row.hitCount === "number" && row.retrievalMode === "hybrid" && row.degradation === null)).toBe(true);
    expect(backendEvents.map((row: any) => row.questionId)).toEqual(["q-one", "q-one", "q-two", "q-two"]);
    expect(readerInputs).toHaveLength(4);
    expect(readerInputs.every((row) => row.system.includes("SHARED_READER_PROMPT"))).toBe(true);
    expect(report.summary.diagnosticFunnel).toMatchObject({
      status: "complete",
      capture: { complete: true, candidates: { availability: "available_private_artifact" }, committedSnapshots: { records: 4 } },
      retrieval: { raw: { availability: "available_private_artifact", records: 4 }, automaticDelivered: { complete: true, records: 2 } },
      readerAnswers: { complete: true, records: 4 },
    });
    for (const row of readerInputs) {
      const bytes = JSON.stringify(row.messages);
      const current = row.tag.questionId === "q-one" ? "First synthetic question?" : "Second synthetic question?";
      const other = row.tag.questionId === "q-one" ? "Second synthetic question?" : "First synthetic question?";
      expect(bytes).toContain(current);
      expect(bytes).not.toContain(other);
      expect(bytes).not.toMatch(/REFERENCE_CANARY|ADVERSARIAL_CANARY/u);
    }
    // Non-LoCoMo synthetic batches retain the generic review shape; the LoCoMo
    // adapter test separately pins blinded arm labels and the four-way rubric.
    expect(report.review.status).toBe("pending");
  }, 30000);

  it("preserves the first and last projected messages across a 64-session full-history question", async () => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const turns = Array.from({ length: 64 }, (_, index) => ({
      id: `session-${index + 1}`,
      sessionId: `session-${index + 1}`,
      timestamp: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
      speaker: "Synthetic",
      user: index === 0 ? "FIRST_HISTORY_SENTINEL" : index === 63 ? "LAST_HISTORY_SENTINEL" : `middle-${index}`,
      assistant: `recorded-${index}`,
    }));
    const group = {
      id: "conv-64",
      split: "development",
      source: { turns, contextPolicy: "memory-only" },
      questions: [{ id: "q", source: { text: "Bounded history question?", timestamp: new Date(Date.UTC(2025, 0, 1, 2)).toISOString() }, evaluation: { ...original.evaluation, evidenceTurnIds: ["session-1"] } }],
    };
    const corpus = { schemaVersion: 1, name: "locomo-v1", turnsPerGroup: { min: 1, max: 64 }, arms: ["full-history"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-64" });
    const readerInputs: any[] = [];
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, hooks: {
      readerInput: (_system: string, options: any) => readerInputs.push(options.messages),
    } });
    expect(report.trials).toMatchObject([{ status: "completed" }]);
    expect(readerInputs).toHaveLength(1);
    expect(JSON.stringify(readerInputs[0])).toContain("FIRST_HISTORY_SENTINEL");
    expect(JSON.stringify(readerInputs[0])).toContain("LAST_HISTORY_SENTINEL");
  }, 30000);

  it("leaves later batched questions unstarted after a fatal first reader failure and still cleans up", async () => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const group = {
      id: original.id,
      split: "development",
      source: { turns: original.source.turns, contextPolicy: "memory-only" },
      questions: [
        { id: "fatal-first", source: { text: "First?", timestamp: original.source.question.timestamp }, evaluation: original.evaluation },
        { id: "must-not-start", source: { text: "Second?", timestamp: original.source.question.timestamp }, evaluation: original.evaluation },
      ],
    };
    const corpus = { schemaVersion: 1, name: "fictional-v1", arms: ["full-history"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-fatal-batch" });
    const close = vi.fn(async () => {});
    const failing = vi.fn(async () => ({ failureKind: "provider_auth", error: "private", text: "" }));
    const providerFactory = (args: any) => ({ ...input.providers.scriptedProviders(args), reader: { run: failing }, close });
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, providerFactory });
    expect(failing).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(report.trials[0]).toMatchObject({ questionId: "fatal-first", status: "provider_failed", cleanup: "removed_owned_store" });
    expect(report.trials[1]).toMatchObject({ questionId: "must-not-start", status: "unstarted", reason: "batch_stopped_before_start:provider_failed", cleanup: "removed_owned_store" });
    expect(report.manifest.trialsNotStarted).toBe(1);
    expect(report.summary.arms["full-history"]).toMatchObject({ scheduled: 2, started: 1, unstarted: 1 });
    expect(report.summary.arms["full-history"].failures).toHaveLength(1);
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it("malformed strict extraction leaves a visible not-ready trial despite successful flush", async () => {
    const input = await fixture();
    const report = await input.runner.runBenchmark({ ...input, providerFactory: (args: any) => {
      const value = input.providers.scriptedProviders(args);
      return { ...value, extractor: { run: async () => ({ text: "{malformed" }) } };
    } });
    expect(report.trials.filter((trial: any) => trial.arm === "bujo").map((trial: any) => trial.status)).toEqual(["capture_not_ready", "capture_not_ready"]);
    expect(report.trials.filter((trial: any) => trial.arm !== "bujo").every((trial: any) => trial.status === "completed")).toBe(true);
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it("records sanitized post-transport vector rejection before cleanup without changing failure semantics", async () => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const group = {
      id: original.id,
      split: "evaluation",
      source: { turns: original.source.turns, contextPolicy: "memory-only" },
      questions: [{
        id: "q-vector-diagnostic", source: original.source.question,
        evaluation: { ...original.evaluation, category: "multi-hop", locomoCategory: 1 },
      }],
    };
    const corpus = { schemaVersion: 1, name: "locomo-v1", arms: ["bujo"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-vector-diagnostic", split: "evaluation" });
    plan.perCall.readinessTimeoutMs = 5_000;
    const memoryTexts = [
      "Atlas launches in August.", "Morgan prefers quiet mornings.",
      "The archive uses cobalt labels.", "River finished the migration.",
      "Tuesday meetings happen remotely.", "The garden contains three maples.",
      "Quartz reports are retained yearly.", "Winter backups use sealed media.",
    ];
    const memories = memoryTexts.map((text) => ({
      type: "note", text, salience: 0.5, isInsight: false, entityIds: [],
    }));
    const providerFactory = (args: any) => {
      const value = input.providers.scriptedProviders(args);
      return {
        ...value,
        embeddings: {
          id: "fixture:invalid-vector-dimension",
          async embed(texts: string[]) {
            return texts.map(() => Array.from({ length: texts.length === 8 ? 7 : 8 }, () => 0.25));
          },
        },
        extractor: {
          run: async () => ({ text: JSON.stringify({ memories, entities: [], relations: [] }) }),
        },
      };
    };
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, providerFactory });
    expect(report.trials).toMatchObject([{
      status: "unstarted", reason: "batch_failed_before_start:capture_not_ready", cleanup: "removed_owned_store",
    }]);
    expect(report.events).toContainEqual(expect.objectContaining({
      stage: "embedding", status: "completed", textCount: 8,
    }));
    expect(report.events).toContainEqual(expect.objectContaining({
      stage: "embedding_validation", status: "rejected", errorClass: "vector_dimension",
      textCount: 8, vectorCount: 8, expectedDimension: 8,
    }));
    expect(report.events).toContainEqual(expect.objectContaining({
      stage: "embedding_acceptance", operation: "knn", status: "rejected", errorClass: "vector_dimension",
    }));
    expect(report.events).toContainEqual(expect.objectContaining({
      stage: "capture_diagnostic", status: "captured", errorStage: "embedding_knn",
      errorClass: "vector_dimension",
      intake: { status: "captured", itemCount: 1, temporaryCount: 0,
        failures: [{ state: "pending", attempt: 1, lastError: "provider" }] },
    }));
    expect(JSON.stringify(report)).not.toContain("dimension mismatch in findSimilarMany");
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it("retains a sanitized reconciliation preflight boundary after durable intake coarsens the failure", async () => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const group = {
      id: original.id,
      split: "evaluation",
      source: { turns: original.source.turns.slice(0, 2), contextPolicy: "memory-only" },
      questions: [{
        id: "q-reconciliation-preflight", source: original.source.question,
        evaluation: { ...original.evaluation, category: "multi-hop", locomoCategory: 1 },
      }],
    };
    const corpus = { schemaVersion: 1, name: "locomo-v1", turnsPerGroup: { min: 1, max: 64 }, arms: ["bujo"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-reconciliation-preflight", split: "evaluation" });
    plan.perCall.readinessTimeoutMs = 5_000;
    plan.perCall.reconciliationEstimatedInputTokens = 1;
    const reconciliationDispatch = vi.fn();
    const providerFactory = (args: any) => {
      const value = input.providers.scriptedProviders(args);
      return { ...value, extractor: { run: async (system: string, options: any) => {
        if (options.messages[0].content.includes("\nTURN:\n")) return value.extractor.run(system, options);
        reconciliationDispatch();
        return { text: "[]" };
      } } };
    };
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, providerFactory });
    expect(reconciliationDispatch).not.toHaveBeenCalled();
    expect(report.events).toContainEqual(expect.objectContaining({
      stage: "reconciliation_preflight", status: "rejected",
      errorClass: "capture_context_budget_exceeded", estimatedInputTokensLimit: 1,
    }));
    expect(report.events).toContainEqual(expect.objectContaining({
      stage: "capture_diagnostic", status: "captured",
      errorStage: "reconciliation_preflight", errorClass: "capture_context_budget_exceeded",
      intake: expect.objectContaining({
        failures: [{ state: "pending", attempt: 1, lastError: "provider" }],
        itemCount: 2, temporaryCount: 0, status: "captured",
      }),
    }));
    expect(report.trials).toMatchObject([{
      status: "unstarted", reason: "batch_failed_before_start:capture_not_ready",
      cleanup: "removed_owned_store",
    }]);
    expect(JSON.stringify(report.events)).not.toMatch(/Classify each candidate|private|existing memories/u);
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it("separately budgets the actual maximum reconciliation prompt and rejects over-limit input before dispatch", async () => {
    const input = await fixture();
    const locomo = await script("memory-e2e-locomo");
    const widest = "\u{10FFFF}";
    const entityIds = Array.from({ length: 16 }, (_unused, index) => (
      `a:${String(index).padStart(2, "0")}${"a".repeat(92)}`
    ));
    const candidates = Array.from({ length: 8 }, (_unused, index) => ({
      type: "event" as const,
      text: widest.repeat(159) + String.fromCodePoint(0x10000 + index),
      salience: 0.0000053654130385272225,
      isInsight: false,
      entityIds,
    }));
    const neighbours = candidates.map((_candidate, candidateIndex) => Array.from({ length: 5 }, (_unused, neighbourIndex) => ({
      record: {
        id: `C-${candidateIndex.toString(16).repeat(64)}-${String(neighbourIndex).padStart(2, "0")}`,
        type: "event" as const,
        status: "open" as const,
        text: widest.repeat(279) + String.fromCodePoint(0x10020 + neighbourIndex),
        salience: 1,
        isInsight: false,
        createdAt: "2025-01-01T00:00:00.000Z",
        accessCount: 0,
        tags: [],
        source: {},
      },
      distance: 0.499999,
    })));
    const memoryRoot = join(input.directory, "reconciliation-budget-memory");
    const embeddings = input.providers.scriptedProviders({}).embeddings;
    await bujo.safeRebuildMemoryIndex({ root: memoryRoot, tier: "bujo", embeddings, dim: 8 });
    const memory = bujo.createBujoMemoryStore({
      root: memoryRoot, tier: "bujo", embeddings, dim: 8,
      llm: { id: "unused", complete: async () => "[]" },
    });
    const canonicalRoot = (memory as any).root as string;
    const realDb = (memory as any).db;
    vi.spyOn(realDb as any, "findSimilarMany").mockImplementation(async (...args: any[]) => {
      expect(args[1]).toBe(5);
      return neighbours;
    });
    vi.spyOn(realDb as any, "prepareUpsertVectors").mockImplementation(async (...args: any[]) => (
      (args[0] as readonly unknown[]).map(() => Array(8).fill(0.25))
    ));
    const runAtLimit = async (limit: number | null) => {
      const plan = structuredClone(input.plan);
      plan.limits.chatSteps = 1;
      plan.limits.outputTokens = plan.perCall.extractorOutputTokens;
      plan.limits.estimatedInputTokens = 1_000_000;
      if (limit === null) delete plan.perCall.reconciliationEstimatedInputTokens;
      else plan.perCall.reconciliationEstimatedInputTokens = limit;
      const budget = new input.providers.Budget(plan);
      const dispatch = vi.fn(async () => ({
        text: JSON.stringify(candidates.map((_candidate, index) => ({ index, action: "add" }))),
      }));
      let nextId = 0;
      try {
        await bujo.reconcileBatch(candidates, {
          db: realDb,
          root: canonicalRoot,
          llm: input.providers.captureLlm({ run: dispatch }, {
            model: { provider: "fixture", model: "extractor", reference: "fixture:extractor" },
            workspace: input.directory,
            sessionsRoot: join(input.directory, "reconciliation-budget-sessions"),
            budget,
            tag: { groupId: "synthetic-budget", arm: "bujo" },
          }),
          nextId: () => `C-${"f".repeat(64)}-${String(nextId++).padStart(2, "0")}`,
          now: () => new Date("2025-01-01T00:00:00.000Z"),
          strictModelOutput: true,
          beforeBatchCommit: () => {},
          deferBatchCommit: true,
        });
        return { budget, dispatch, error: null };
      } catch (error) {
        return { budget, dispatch, error };
      }
    };
    try {
      // Historical behavior: reconciliation fell back to the 8,192-token
      // extraction ceiling and failed before a meter/provider dispatch.
      const old = await runAtLimit(null);
      const oldPreflight = old.budget.events.find((event: any) => event.stage === "reconciliation_preflight");
      expect(old.error).toBeInstanceOf(Error);
      expect(old.dispatch).not.toHaveBeenCalled();
      expect(oldPreflight).toMatchObject({
        status: "rejected", errorClass: "capture_context_budget_exceeded",
        estimatedInputTokensLimit: 8_192,
      });
      expect(oldPreflight.estimatedInputTokens).toBe(27_867);

      const corrected = await runAtLimit(locomo.LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS);
      expect(corrected.error).toBeNull();
      expect(corrected.dispatch).toHaveBeenCalledOnce();
      const reconciliationMeter = corrected.budget.events.find((event: any) => event.stage === "reconciliation");
      expect(reconciliationMeter).toMatchObject({ status: "completed", configuredStepsReserved: 1 });
      expect(reconciliationMeter.estimatedInputTokensReserved).toBe(oldPreflight.estimatedInputTokens);
      expect(reconciliationMeter.estimatedInputTokensReserved)
        .toBeLessThanOrEqual(locomo.LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS);
      expect(corrected.budget.used.estimatedInputTokens).toBe(reconciliationMeter.estimatedInputTokensReserved);

      const overLimit = await runAtLimit(oldPreflight.estimatedInputTokens - 1);
      expect(overLimit.error).toBeInstanceOf(Error);
      expect(overLimit.dispatch).not.toHaveBeenCalled();
      expect(overLimit.budget.events).toContainEqual(expect.objectContaining({
        stage: "reconciliation_preflight", status: "rejected",
        errorClass: "capture_context_budget_exceeded",
        estimatedInputTokens: oldPreflight.estimatedInputTokens,
        estimatedInputTokensLimit: oldPreflight.estimatedInputTokens - 1,
      }));
      expect(JSON.stringify(overLimit.budget.events)).not.toMatch(/C-f{16}|a:00|\u{10FFFF}/u);
      for (const result of [old, corrected, overLimit]) result.budget.close();
    } finally {
      await memory.close();
    }
  }, 30000);

  it.each(["strict-recovery-2", "strict-recovery-2-full"])("uses the durable intake's bounded model-output retry for %s without relaxing strict capture", async (protocol) => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const group = {
      id: original.id,
      split: "evaluation",
      source: { turns: original.source.turns, contextPolicy: "memory-only" },
      questions: [{
        id: "q-recovery", source: original.source.question,
        evaluation: { ...original.evaluation, category: "multi-hop", locomoCategory: 1 },
      }],
    };
    const corpus = { schemaVersion: 1, name: "locomo-v1", arms: ["bujo"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-recovery", split: "evaluation" });
    plan.locomo = { experiment: {
      protocol, captureModelOutputAttempts: 2,
      captureModelOutputRetryDelayMs: 60_000,
    } };
    plan.perCall.readinessTimeoutMs = 5_000;
    plan.limits.chatSteps += 8;
    plan.limits.embeddingCalls += 8;
    plan.limits.estimatedInputTokens += 100_000;
    plan.limits.embeddingInputTokens += 100_000;
    plan.limits.outputTokens += 20_000;
    let extractionCalls = 0;
    const providerFactory = (args: any) => {
      const value = input.providers.scriptedProviders(args);
      return { ...value, extractor: { run: async () => {
        extractionCalls += 1;
        return { text: extractionCalls === 1 ? "{malformed" : '{"memories":[],"entities":[],"relations":[]}' };
      } } };
    };
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, providerFactory });
    expect(report.trials).toMatchObject([{ status: "completed", cleanup: "removed_owned_store" }]);
    expect(extractionCalls).toBe(original.source.turns.length + 1);
    expect(report.events.filter((event: any) => event.stage === "capture_recovery")).toEqual([
      expect.objectContaining({ status: "scheduled", attempt: 1, failureKind: "model_output", delayMs: 60_000 }),
    ]);
    expect(report.summary.locomoOfficial.byArm.bujo.overall).toMatchObject({
      status: "invalid_incomplete", scheduled: 1, completed: 0,
    }); // Scripted answers are never scored as provider quality.
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it.each(["reader", "capture"])("reports terminal provider admission after clean %s failure cleanup", async (stage) => {
    const input = await fixture();
    const failureKind = stage === "reader" ? "provider_auth" : "usage_limit";
    const failing = vi.fn(async () => ({ failureKind, error: "private-error-canary", text: "" }));
    const close = vi.fn(async () => {});
    const providerFactory = vi.fn((args: any) => {
      const value = input.providers.scriptedProviders(args);
      return { ...value, ...(stage === "reader" ? { reader: { run: failing } } : { extractor: { run: failing } }), close };
    });
    const report = await input.runner.runBenchmark({ ...input, providerFactory });
    const attempted = stage === "reader" ? 1 : 5;
    expect(report.trials).toHaveLength(attempted);
    expect(providerFactory).toHaveBeenCalledTimes(attempted);
    expect(failing).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(attempted);
    expect(report.manifest).toMatchObject({
      admissionStopped: true,
      trialsNotStarted: 10 - attempted,
      providerStop: { code: "provider_failed", failureKind },
    });
    const trial = report.trials.at(-1);
    expect(trial).toMatchObject(stage === "reader"
      ? { status: "provider_failed", runtimeFailureKind: failureKind }
      : { status: "capture_not_ready", captureFailureKind: failureKind });
    expect(report.trials.every((row: any) => row.cleanup === "removed_owned_store")).toBe(true);
    expect(report.summary.arms[trial.arm].failures).toContainEqual({ groupId: trial.groupId, status: trial.status, failureKind });
    expect(report.summary.qualityMeasured).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-error-canary");
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it("empty valid extraction is ready, not a fabricated capture success metric", async () => {
    const input = await fixture();
    const report = await input.runner.runBenchmark({
      ...input,
      providerFactory: (args: any) => withStructuredExtractor({
        ...input.providers.scriptedProviders(args),
        extractor: { run: async () => ({ text: '{"memories":[],"entities":[],"relations":[]}' }) },
      }),
    });
    for (const trial of report.trials.filter((trial: any) => trial.arm === "bujo")) {
      expect(trial.status).toBe("completed"); expect(trial.health.counts.memories).toBe(0);
    }
    expect(report.summary.capturePrecisionRecall.recall).toBeNull();
  }, 30000);

  it("reports a structured native context limit as full-history not-applicable", async () => {
    const input = await fixture();
    const dataset = await script("memory-e2e-dataset");
    const original = input.corpus.groups[0];
    const group = {
      id: original.id,
      split: "development",
      source: { turns: original.source.turns, contextPolicy: "memory-only" },
      questions: [{ id: "q-context", source: original.source.question, evaluation: original.evaluation }],
    };
    const corpus = { schemaVersion: 1, name: "fictional-v1", arms: ["full-history"], groups: [group] };
    dataset.validateCorpus(corpus);
    const plan = dataset.makePlan({ corpus, sha256: "synthetic-native-context" });
    const providerFactory = (args: any) => ({
      ...input.providers.scriptedProviders(args),
      reader: { run: async () => ({ failureKind: "context_limit", error: "private", text: "" }) },
    });
    const report = await input.runner.runBenchmark({ ...input, corpus, plan, providerFactory });
    expect(report.trials).toMatchObject([{ status: "not_applicable", reason: "native_context_limit", runtimeFailureKind: "context_limit" }]);
  }, 30000);

  it("does not truncate full history to pass an overflowing context budget", async () => {
    const input = await fixture();
    input.plan.groupIds = ["dev-fact"];
    input.corpus.groups[0].source.turns[0].user = "Long fictional background. ".repeat(2500);
    const report = await input.runner.runBenchmark(input);
    expect(report.trials.find((trial: any) => trial.arm === "full-history")).toMatchObject({ status: "not_applicable", reason: "full_history_does_not_fit", answer: null });
    expect(report.trials.find((trial: any) => trial.arm === "recent-only").status).toBe("completed");
    const firstLite = report.capture.find((row: any) => row.arm === "lite" && row.stage === "inventory");
    expect(firstLite.records[0].text.length).toBeLessThan(550); // real host summary's truncation
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toEqual([]);
  }, 30000);

  it("exact strong retry after reopening is duplicate and conflicting bytes fail closed", async () => {
    const input = await fixture(); const memoryRoot = join(input.directory, "retry");
    const turn = { runId: "r1", conversationId: "s1", summary: "Fictional repeat test." };
    let memory = bujo.createBujoMemoryStore({ root: memoryRoot, tier: "lite" });
    await memory.persistCompletedTurn(turn); await memory.flush(); await memory.close();
    memory = bujo.createBujoMemoryStore({ root: memoryRoot, tier: "lite" });
    try {
      expect((await memory.persistCompletedTurn(turn)).admissionStatus).toBe("duplicate");
      await expect(memory.persistCompletedTurn({ ...turn, summary: "Different bytes." })).rejects.toThrow(/conflict/u);
      await memory.flush();
      const db = store.openMemoryDb({ path: bujo.resolveActiveMemoryDbPath(memoryRoot), readOnly: true });
      try { expect(db.allMemories()).toHaveLength(1); } finally { db.close(); }
    } finally { await memory.close(); }
  });

  it("enforces the private output cap at real Pi dispatch and tool continuation, without compaction", async () => {
    const input = await fixture();
    const { generatePiNativeResponse } = await import(new URL("../../../agent-runtime/src/ai/providers/pi-native.js", import.meta.url).href);
    const faux = fauxProvider({ provider: "faux", models: [{ id: "e2e-cap", maxTokens: 32000, contextWindow: 32000 }] });
    const models = createModels(); models.setProvider(faux.provider);
    const dispatched: Array<{ modelCap: number; outputCap: number | undefined }> = [];
    const original = faux.provider.streamSimple.bind(faux.provider);
    faux.provider.streamSimple = (model, context, options) => {
      dispatched.push({ modelCap: model.maxTokens, outputCap: options?.maxTokens });
      return original(model, context, options);
    };
    const memory = bujo.createBujoMemoryStore({ root: join(input.directory, "cap-memory"), tier: "lite" });
    const service = new retrieval.MemoryRetrievalService(memory);
    const extension = await retrieval.createSharedMemoryRecallRuntimeExtension(service)({ runId: "cap-run" });
    const budget = new input.providers.Budget(input.plan);
    try {
      faux.setResponses([
        (context) => {
          const tool = context.tools?.find((value) => value.name.includes("MemoryRecall"));
          expect(tool).toBeDefined();
          return fauxAssistantMessage([fauxToolCall(tool!.name, { query: "What color did Mira select?" }, { id: "cap-tool" })]);
        },
        fauxAssistantMessage([fauxText("No evidence was present in this test store.")]),
      ]);
      const events: any[] = [];
      const result = await input.providers.meteredRuntime({ run: generatePiNativeResponse }, { budget, stage: "reader", tag: {} }).run("Answer from evidence.", {
        model: { provider: "faux", model: "e2e-cap", reference: "faux:e2e-cap" },
        piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "fictional-test-key",
        cwd: input.directory, piSessionsRoot: join(input.directory, "cap-sessions"),
        messages: [{ role: "user", content: "What color did Mira select?" }],
        allowedTools: ["MemoryRecall"], mcpServers: extension.runtimeOptions.mcpServers,
        abortSignal: new AbortController().signal, onEvent: (event: any) => events.push(event),
      });
      expect(result.text).toContain("No evidence");
      expect(dispatched).toHaveLength(2);
      // Pi's check cap is on the dispatched Model (providers derive their native output
      // limit from it), not a generic stream option. Both re-resolved turns must carry it.
      expect(dispatched).toEqual([{ modelCap: 512, outputCap: undefined }, { modelCap: 512, outputCap: undefined }]);
      expect(faux.getModel().maxTokens).toBe(32000); // never mutate the shared catalog
      expect(events.filter((value) => /compact/iu.test(value.type ?? ""))).toEqual([]);
      faux.setResponses([fauxAssistantMessage([fauxText("{}")])]);
      await input.providers.captureLlm({ run: (system: string, options: any) => generatePiNativeResponse(system, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "fictional-test-key" }) }, {
        model: { provider: "faux", model: "e2e-cap", reference: "faux:e2e-cap" }, workspace: input.directory,
        sessionsRoot: join(input.directory, "extract-sessions"), budget, tag: {},
      }).complete("Return an empty object.", { label: "capture:extract" });
      expect(dispatched.at(-1)).toEqual({ modelCap: 2048, outputCap: undefined });
    } finally { budget.close(); await extension.cleanup(); service.releaseAllTurns(); await memory.close(); }
  }, 30000);

  it.each(["deadline", "global abort"])("bounds the production embedding response body after headers: %s", async (mode) => {
    const input = await fixture();
    input.plan.perCall.embeddingTimeoutMs = mode === "deadline" ? 10 : 1000;
    let rejectBody!: (error: Error) => void;
    const body = new Promise((_, reject) => { rejectBody = reject; });
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const text = vi.fn(() => { bodyStarted(); return body; });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, text } as unknown as Response);
    const budget = new input.providers.Budget(input.plan);
    try {
      const raw = search.createEmbeddingProvider({ provider: "ollama", model: "fixture", timeoutMs: 5 });
      const embeddings = input.providers.meteredEmbeddings(raw, { budget, tag: {} });
      const pending = embeddings.embed(["fictional body"]);
      const rejected = expect(pending).rejects.toThrow("embedding_timeout_or_cancelled");
      await started;
      expect(text).toHaveBeenCalledOnce();
      if (mode === "global abort") budget.controller.abort();
      await rejected;
      expect(fetch).toHaveBeenCalledOnce();
      expect(budget.pending.size).toBe(1);
      await expect(budget.settle(5)).rejects.toThrow("provider_settlement_unknown");
      rejectBody(new Error("late synthetic failure")); await budget.settle(100);
    } finally { budget.close(); }
  });

  it("reports a non-cooperative reader boundedly, retains owned state, and stops trials", async () => {
    const input = await fixture(); input.plan.perCall.callTimeoutMs = 10; input.plan.perCall.cleanupTimeoutMs = 30;
    let rejectRun!: (error: Error) => void;
    const raw = new Promise((_, reject) => { rejectRun = reject; });
    const factory = vi.fn((args: any) => ({ ...input.providers.scriptedProviders(args), reader: { run: () => raw } }));
    const report = await input.runner.runBenchmark({ ...input, providerFactory: factory });
    expect(factory).toHaveBeenCalledOnce(); expect(report.trials).toHaveLength(1);
    expect(report.trials[0]).toMatchObject({ status: "cleanup_failed", primaryStatus: "provider_timeout_or_cancelled", cleanup: "retained_unsettled_owned_store" });
    expect(report.manifest).toMatchObject({ admissionStopped: true, trialsNotStarted: 9 });
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toHaveLength(1);
    rejectRun(new Error("late synthetic failure")); await new Promise((resolve) => setImmediate(resolve));
  });

  it.each([{ timedOut: true, discarded: 0 }, { timedOut: false, discarded: 1 }])("retains owned store on resolved but abandoned shutdown %j", async (shutdown) => {
    const input = await fixture();
    const factory = vi.fn(input.providerFactory);
    const report = await input.runner.runBenchmark({ ...input, providerFactory: factory, hooks: {
      store: (memory: bujo.BujoMemoryStore) => {
        const close = memory.close.bind(memory); const snapshot = memory.queueSnapshot.bind(memory);
        memory.close = async () => { await close(); memory.queueSnapshot = () => ({ ...snapshot(), shutdown: { ...snapshot().shutdown, ...shutdown } }); };
      },
    } });
    expect(factory).toHaveBeenCalledTimes(3); expect(report.trials).toHaveLength(3);
    expect(report.trials[2]).toMatchObject({ arm: "lite", status: "cleanup_failed", cleanup: "retained_unsettled_owned_store" });
    expect(report.events.at(-1)).toMatchObject({ stage: "cleanup", status: "store_shutdown_unsettled" });
    expect((await readdir(input.directory)).filter((name) => name.startsWith("work-"))).toHaveLength(1);
  });

  it("fails real/scripted mode mismatch without constructing a substitute provider", async () => {
    const input = await fixture();
    const report = await input.runner.runBenchmark({ ...input, kind: "real" });
    expect(report.trials.every((trial: any) => trial.status === "provider_mode_mismatch")).toBe(true);
  });
});
