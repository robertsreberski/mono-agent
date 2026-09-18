import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, loadCorpus, makePlan, sourceOnly, contextFor, validateCorpus } from "../lib/memory-e2e-dataset.mjs";
import { Budget, captureLlm, meteredRuntime, scriptedProviders, usageOf } from "../lib/memory-e2e-providers.mjs";
import { percentiles, ratio, lexicalDiagnostic, safeArtifact, ownedParent } from "../lib/memory-e2e-report.mjs";
import { awaitReady, readySnapshot } from "../lib/memory-e2e-runner.mjs";
import { main, parseArguments, profileFrom } from "../memory-e2e-benchmark.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const budgets = [];
const dirs = [];
afterEach(async () => { for (const b of budgets.splice(0)) b.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function setup() { const loaded = await loadCorpus(); const plan = makePlan(loaded); const budget = new Budget(plan); budgets.push(budget); return { ...loaded, plan, budget }; }
const ready = { intake: { pending: 0, dead: 0, due: 0, transitioning: 0, retrying: 0, resolved: 1 }, shutdown: { timedOut: false, discarded: 0 } };

describe("memory E2E benchmark contracts (not model quality)", () => {
  it("freezes the fictional corpus and covers the five arms/six evaluation categories", async () => {
    const { corpus, sha256, plan } = await setup();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(corpus.groups).toHaveLength(8);
    expect(new Set(corpus.groups.filter((g) => g.split === "evaluation").map((g) => g.evaluation.category)).size).toBe(6);
    expect(plan.arms).toEqual(ARMS);
    expect(plan.workload).toEqual({ questions: 2, trials: 10, historicalTurnsPerMemoryArm: 8, captureStepsMaximum: 16, readerStepsMaximum: 30 });
    expect(makePlan({ corpus, sha256, split: "evaluation" }).limits.chatSteps).toBe(138);
  });
  it("keeps labels and arbitrary gold fields out of the closed source projection", async () => {
    const { corpus } = await setup(); const group = structuredClone(corpus.groups[0]);
    group.answer = "GOLD_CANARY"; group.source.answer = "GOLD_CANARY"; group.source.turns[0].has_answer = "GOLD_CANARY"; group.source.question.evidence = "GOLD_CANARY"; group.evaluation.answer = "GOLD_CANARY";
    const source = sourceOnly(group);
    expect(JSON.stringify(source)).not.toContain("GOLD_CANARY");
    expect(source.turns[0]).toMatchObject({ speaker: "Mira", timestamp: "2025-01-10T12:00:00.000Z", sessionId: "s1" });
    expect(contextFor(source, "recent-only")).toEqual(contextFor(source, "bujo"));
    expect(contextFor(source, "recent-only")).toHaveLength(2);
    expect(contextFor(source, "full-history")).toHaveLength(8);
  });
  it("rejects reordered dates and ambiguous timestamps", async () => {
    const { corpus } = await setup(); const bad = structuredClone(corpus);
    bad.groups[0].source.turns[0].timestamp = "01/10/2025";
    expect(() => validateCorpus(bad)).toThrow("invalid_turn");
  });
  it("does not construct providers or touch credentials in dry run / refused real run", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const output = [];
    expect(await main(["--dry-run"], { stdout: (text) => output.push(JSON.parse(text)) })).toBe(0);
    expect(output[0].confirmation).toMatch(/^[0-9a-f]{64}$/u);
    await expect(main(["--real"])).rejects.toThrow("real_execution_requires_confirmed_profile");
    expect(network).not.toHaveBeenCalled();
    expect(() => parseArguments(["--memory-path", "/private"])).toThrow();
    expect(() => parseArguments(["--real", "--real"])).toThrow();
    expect(() => profileFrom({ reader: "openai:model" })).toThrow("incomplete_profile");
  });
  it("flush alone cannot certify pending, dead, dropped, delayed or missing index work", async () => {
    expect(readySnapshot(ready)).toBe(true);
    for (const key of ["pending", "dead", "due", "transitioning", "retrying"]) expect(readySnapshot({ ...ready, intake: { ...ready.intake, [key]: 1 } })).toBe(false);
    expect(readySnapshot({ ...ready, capture: {} })).toBe(false);
    const index = { queued: 0, inFlight: 0, remainingBacklog: 0, recoveryFilesRemaining: 0, failed: 0, dropped: 0, discarded: 0 };
    expect(readySnapshot({ ...ready, index })).toBe(true);
    for (const key of Object.keys(index)) expect(readySnapshot({ ...ready, index: { ...index, [key]: 1 } })).toBe(false);
    await expect(awaitReady({ flush: async () => {}, queueSnapshot: () => ({ ...ready, intake: { ...ready.intake, pending: 1 } }) }, 20)).rejects.toThrow("capture_not_ready");
    await expect(awaitReady({ flush: () => new Promise(() => {}) }, 5)).rejects.toThrow("readiness_timeout");
  });
  it("caps steps/output, disables retries and compaction, and records unknown actual usage", async () => {
    const { budget } = await setup(); const run = vi.fn(async () => ({ text: "answer", model: "faux:observed" }));
    await meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("system", { model: { reference: "faux:requested" }, messages: [{ role: "user", content: "question" }], abortSignal: new AbortController().signal });
    expect(run.mock.calls[0][1]).toMatchObject({ maxTurns: 3, providerCheckMaxTokens: 512, compaction: { enabled: false }, piMaxRetries: 0, effort: "none" });
    expect(budget.used.chatSteps).toBe(3);
    expect(budget.events[0]).toMatchObject({ transportAttempts: null, costUsd: null, executedModel: "faux:observed", usage: { inputTokens: null } });
    expect(usageOf({ input: 0 })).toMatchObject({ inputTokens: 0, outputTokens: null });
  });
  it("rejects hidden compaction and does not execute after exhausted reservations", async () => {
    const { budget } = await setup();
    const run = vi.fn(async (_s, o) => { o.onEvent({ type: "compaction_started" }); return { text: "answer" }; });
    const options = { messages: [], abortSignal: new AbortController().signal };
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options)).rejects.toThrow("unexpected_compaction");
    budget.used.chatSteps = budget.plan.limits.chatSteps;
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options)).rejects.toThrow("budget_exhausted");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not confuse an aborted signal with provider settlement", async () => {
    const { budget } = await setup(); let finish;
    budget.track(new Promise((resolve) => { finish = resolve; }));
    budget.controller.abort();
    await expect(budget.settle(5)).rejects.toThrow("provider_settlement_unknown");
    finish(); await budget.settle(10);
    expect(budget.pending.size).toBe(0);
  });
  it("preserves capture prompt and no-tool provider shape, rejects provider failures", async () => {
    const { budget } = await setup(); const run = vi.fn(async () => ({ text: "{}" }));
    const llm = captureLlm({ run }, { model: { reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions", budget, tag: {} });
    await llm.complete("STRICT_PROMPT", { label: "capture:extract" });
    expect(run.mock.calls[0][1]).toMatchObject({ messages: [{ role: "user", content: "STRICT_PROMPT" }], allowedTools: [], mcpServers: {}, maxTurns: 1, providerCheckMaxTokens: 2048, compaction: { enabled: false } });
    const production = await readFile(new URL("../../packages/agent-app/src/configured-agent.ts", import.meta.url), "utf8");
    for (const phrase of run.mock.calls[0][0].split(/(?<=\.) /u)) expect(production).toContain(phrase);
    await expect(meteredRuntime({ run: async () => ({ error: "secret error", text: "" }) }, { budget, stage: "reader", tag: {} }).run("s", { messages: [], abortSignal: new AbortController().signal })).rejects.toThrow("provider_failed");
  });
  it("labels unknown/empty populations, tiny-sample latency, and lexical diagnostics honestly", () => {
    expect(percentiles([])).toMatchObject({ n: 0, p50: null, p95: null });
    expect(percentiles([5, 1, 2, 3, 4, 6])).toMatchObject({ n: 6, p50: 3, p95: 6, exploratory: true });
    expect(ratio(0, 0).value).toBeNull();
    const gold = { accepted: ["amber"], forbidden: ["violet"] };
    expect(lexicalDiagnostic("It is not amber", gold, "real").value).toBe(false);
    expect(lexicalDiagnostic("amber", gold, "scripted").value).toBeNull();
    expect(lexicalDiagnostic("amber or violet", gold, "real").value).toBe(false);
  });
  it("redacts path/credential/endpoint canaries without treating unknown values as zero", () => {
    const safe = JSON.stringify(safeArtifact({ prompt: "/Users/private/memory sk-123456789012 https://host/?token=secret", headers: { Authorization: "Bearer canary" }, cost: null, answer: "Fictional cobalt." }));
    expect(safe).not.toMatch(/private|123456789012|Bearer|host\//u);
    expect(JSON.parse(safe)).toMatchObject({ cost: null, answer: "Fictional cobalt." });
  });
  it("refuses symlinked output ancestors", async () => {
    await mkdir(join(root, ".worklab-tmp"), { recursive: true });
    const dir = await mkdtemp(join(root, ".worklab-tmp", "e2e-safety-")); dirs.push(dir);
    await symlink(root, join(dir, ".worklab-tmp"));
    await expect(ownedParent(dir)).rejects.toThrow("unsafe_output_root");
  });
  it("scripted extractor is independent of gold and never claims a real provider", async () => {
    const providers = scriptedProviders();
    expect(providers.kind).toBe("scripted");
    const result = await providers.extractor.run("", { messages: [{ content: "\nTURN:\nUser (Fiction): A green cup.\nAssistant: Noted." }] });
    expect(JSON.parse(result.text).memories[0].text).toBe("Fiction said: A green cup.");
  });
});
