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
const modules = { harness, bujo, store, search, runtime, retrieval, journal, extensions };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dataset = await script("memory-e2e-dataset");
  const providers = await script("memory-e2e-providers");
  const runner = await script("memory-e2e-runner");
  const loaded = await dataset.loadCorpus();
  const plan = dataset.makePlan(loaded);
  await mkdir(join(root, ".worklab-tmp"), { recursive: true });
  const directory = await mkdtemp(join(root, ".worklab-tmp", "memory-e2e-test-")); dirs.push(directory);
  return { ...loaded, plan, directory, modules, kind: "scripted", providerFactory: providers.scriptedProviders, runner, providers };
}

describe("fictional E2E production-path contract, not model quality", () => {
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

  it("empty valid extraction is ready, not a fabricated capture success metric", async () => {
    const input = await fixture();
    const report = await input.runner.runBenchmark({ ...input, providerFactory: (args: any) => ({ ...input.providers.scriptedProviders(args), extractor: { run: async () => ({ text: '{"memories":[],"entities":[],"relations":[]}' }) } }) });
    for (const trial of report.trials.filter((trial: any) => trial.arm === "bujo")) {
      expect(trial.status).toBe("completed"); expect(trial.health.counts.memories).toBe(0);
    }
    expect(report.summary.capturePrecisionRecall.recall).toBeNull();
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

  it("fails real/scripted mode mismatch without constructing a substitute provider", async () => {
    const input = await fixture();
    const report = await input.runner.runBenchmark({ ...input, kind: "real" });
    expect(report.trials.every((trial: any) => trial.status === "provider_mode_mismatch")).toBe(true);
  });
});
