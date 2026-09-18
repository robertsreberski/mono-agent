import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, loadCorpus, makePlan, serializableProfile, sourceOnly, contextFor, validateCorpus } from "../lib/memory-e2e-dataset.mjs";
import { Budget, canonicalFailureKind, captureLlm, failureKindOf, isFatalFailureKind, meteredEmbeddings, meteredRuntime, realProviders, scriptedProviders, usageOf } from "../lib/memory-e2e-providers.mjs";
import { percentiles, ratio, lexicalDiagnostic, safeArtifact, ownedParent, summarize } from "../lib/memory-e2e-report.mjs";
import { awaitReady, captureFailureKindFor, cleanupTrial, readySnapshot } from "../lib/memory-e2e-runner.mjs";
import { prepareRealBuild, verifyRealBuild, BUILD_POLICY } from "../lib/memory-e2e-build.mjs";
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
    expect(sha256).toBe("db8fe538f1abbd94511f95c356b111e5eca33cdb2e15fb2ccdaee9681b6889c0");
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
  it("the direct confirmed real command cannot import production/providers before a required build", async () => {
    const profile = ["--reader", "fixture:reader", "--extractor", "fixture:extractor", "--embedding-provider", "ollama", "--embedding-model", "fixture", "--dimension", "8"];
    let plan;
    await main(["--dry-run", ...profile], { stdout: (text) => { plan = JSON.parse(text); } });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const prepareBuild = vi.fn(async () => { throw new Error("synthetic_build_refused"); });
    await expect(main(["--real", ...profile, "--confirm-plan", plan.confirmation], { prepareBuild })).rejects.toThrow("synthetic_build_refused");
    expect(prepareBuild).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
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
  it.each(["deadline", "global abort"])("bounds an embedding body pending after headers: %s", async (mode) => {
    const { budget } = await setup();
    budget.plan.perCall.embeddingTimeoutMs = mode === "deadline" ? 10 : 1000;
    let rejectBody;
    const body = new Promise((_, reject) => { rejectBody = reject; });
    const headers = vi.fn(async () => ({ json: () => body }));
    const embeddings = meteredEmbeddings({ id: "fixture", embed: async () => (await headers()).json() }, { budget, tag: {} });
    const pending = embeddings.embed(["fictional"]);
    const rejected = expect(pending).rejects.toThrow("embedding_timeout_or_cancelled");
    if (mode === "global abort") budget.controller.abort();
    await rejected;
    expect(headers).toHaveBeenCalledOnce();
    expect(budget.events[0].status).toBe("embedding_timeout_or_cancelled");
    expect(budget.pending.size).toBe(1);
    await expect(embeddings.embed(["not admitted"])).rejects.toThrow("provider_admission_stopped");
    await expect(budget.settle(5)).rejects.toThrow("provider_settlement_unknown");
    rejectBody(new Error("late private failure"));
    await budget.settle(100);
  });
  it("bounds a non-cooperative reader and retains its original promise", async () => {
    const { budget } = await setup(); budget.plan.perCall.callTimeoutMs = 10;
    let finish;
    const raw = new Promise((resolve) => { finish = resolve; });
    await expect(meteredRuntime({ run: () => raw }, { budget, stage: "reader", tag: {} }).run("s", { messages: [] })).rejects.toThrow("provider_timeout_or_cancelled");
    expect(budget.pending.has(raw)).toBe(true);
    expect(budget.controller.signal.aborted).toBe(true);
    finish({ text: "late answer" }); await budget.settle(100);
  });
  it("settlement follows promises created by a capture continuation", async () => {
    const { budget } = await setup(); let finishCapture, finishEmbedding;
    const capture = budget.track(new Promise((resolve) => { finishCapture = resolve; }));
    capture.then(() => budget.track(new Promise((resolve) => { finishEmbedding = resolve; })));
    const settlement = budget.settle(10);
    const rejected = expect(settlement).rejects.toThrow("provider_settlement_unknown");
    finishCapture(); await rejected;
    expect(budget.pending.size).toBe(1);
    finishEmbedding(); await budget.settle(100);
  });
  it.each([{ timedOut: true, discarded: 0 }, { timedOut: false, discarded: 1 }])("rejects resolved store close with abandoned drain %j", async (shutdown) => {
    const { budget } = await setup(); const close = vi.fn(async () => {});
    await expect(cleanupTrial({ budget, store: { close, queueSnapshot: () => ({ shutdown }) } }, 100)).rejects.toThrow("store_shutdown_unsettled");
    expect(close).toHaveBeenCalledOnce();
    expect(budget.admissionStopped).toBe(true);
  });
  it("quiesces producers before the final stable settlement check", async () => {
    const { budget } = await setup(); let finish;
    const order = [];
    const store = { queueSnapshot: () => ready, close: async () => {
      order.push("store");
      budget.track(new Promise((resolve) => { finish = resolve; }));
    } };
    const result = cleanupTrial({ budget, reader: { dispose: async () => { order.push("reader"); } }, store, providers: { close: async () => { order.push("providers"); } } }, 20);
    await expect(result).rejects.toThrow(/cleanup_timeout|provider_settlement_unknown/u);
    expect(order).toEqual(["reader", "store", "providers"]);
    expect(budget.pending.size).toBe(1);
    finish(); await budget.settle(100);
  });
  it("bounds harness/provider disposal under one cleanup deadline", async () => {
    for (const resource of ["reader", "providers"]) {
      const { budget } = await setup(); let fail;
      const raw = new Promise((_, reject) => { fail = reject; });
      await expect(cleanupTrial({ budget, [resource]: { dispose: () => raw, close: () => raw } }, 10)).rejects.toThrow("cleanup_timeout");
      expect(budget.admissionStopped).toBe(true);
      fail(new Error("late failure")); await budget.settle(100);
    }
  });
  it("necessarily removes stale dist and rebuilds the source-pinned closure before attesting outputs", async () => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-test-")); dirs.push(directory);
    const path = join(directory, "packages/agent-app"); await mkdir(join(path, "dist"), { recursive: true });
    await writeFile(join(path, "dist/stale.js"), "stale source");
    const calls = [];
    const exec = (command, args) => {
      calls.push([command, args]);
      if (command === "git") return args.includes("rev-parse") ? "HEAD_A" : "";
      if (args.includes("list")) return JSON.stringify([{ path }]);
      // The synchronous production build is replaced only by a local synthetic writer.
      expect(args).toEqual(["--filter", "@mono-agent/agent-app...", "run", "build"]);
      return "";
    };
    // No output from a purported successful build must fail, not certify stale bytes.
    await expect(prepareRealBuild(directory, "HEAD_A", { exec })).rejects.toThrow();
    await expect(readFile(join(path, "dist/stale.js"))).rejects.toThrow();
    expect(calls.some(([command, args]) => command === "pnpm" && args.includes("build"))).toBe(true);
    expect(BUILD_POLICY).toBe("fresh-clean-head-agent-app-closure-v1");
  });
  it("records fresh output/source identity after a successful synthetic closure build", async () => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-good-")); dirs.push(directory);
    const path = join(directory, "packages/agent-app"); await mkdir(path, { recursive: true });
    const exec = (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? "HEAD_A" : "";
      if (args.includes("list")) return JSON.stringify([{ path }]);
      mkdirSync(join(path, "dist")); writeFileSync(join(path, "dist/index.js"), "fresh output"); return "";
    };
    const build = await prepareRealBuild(directory, "HEAD_A", { exec });
    expect(build).toMatchObject({ policy: BUILD_POLICY, sourceHead: "HEAD_A", packages: ["packages/agent-app"] });
    expect(build.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect((await setup()).plan.realBuildPolicy).toBe(BUILD_POLICY);
    await verifyRealBuild(directory, build, { exec });
    await writeFile(join(path, "dist/index.js"), "changed after build");
    await expect(verifyRealBuild(directory, build, { exec })).rejects.toThrow("build_output_changed");
    await expect(verifyRealBuild(directory, build, { exec: (_command, args) => args.includes("rev-parse") ? "HEAD_B" : "" })).rejects.toThrow("build_source_changed_or_dirty");
  });
  it("handles the source-JavaScript runtime's generated declarations without requiring dist", async () => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-runtime-")); dirs.push(directory);
    const app = join(directory, "packages/agent-app"); const runtime = join(directory, "packages/agent-runtime");
    await mkdir(app, { recursive: true }); await mkdir(join(runtime, "src"), { recursive: true });
    await mkdir(join(runtime, "types")); await writeFile(join(runtime, "types/stale.d.ts"), "stale");
    await writeFile(join(runtime, "src/index.js"), "tracked source");
    const exec = (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? "HEAD_A" : "";
      if (args.includes("list")) return JSON.stringify([{ path: app }, { path: runtime }]);
      mkdirSync(join(app, "dist")); writeFileSync(join(app, "dist/index.js"), "fresh output");
      mkdirSync(join(runtime, "types")); writeFileSync(join(runtime, "types/index.d.ts"), "fresh types"); return "";
    };
    const build = await prepareRealBuild(directory, "HEAD_A", { exec });
    expect(build.outputRoots).toEqual(["packages/agent-app/dist", "packages/agent-runtime/types"]);
    await expect(readFile(join(runtime, "types/stale.d.ts"))).rejects.toThrow();
    expect(await readFile(join(runtime, "src/index.js"), "utf8")).toBe("tracked source");
    await verifyRealBuild(directory, build, { exec });
  });
  it.each(["head", "dirt"])("rejects source %s drift during build before provider admission", async (mode) => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-drift-")); dirs.push(directory);
    const path = join(directory, "packages/agent-app"); await mkdir(path, { recursive: true });
    let built = false;
    const exec = (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? (built && mode === "head" ? "HEAD_B" : "HEAD_A") : (built && mode === "dirt" ? " M source" : "");
      if (args.includes("list")) return JSON.stringify([{ path }]);
      built = true; return "";
    };
    await expect(prepareRealBuild(directory, "HEAD_A", { exec })).rejects.toThrow("build_source_changed_or_dirty");
    expect(built).toBe(true);
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
  it("retains a non-fatal returned failure kind without stopping admission", async () => {
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind: "provider_unavailable", error: "route down", text: "" }));
    const failure = await meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", { messages: [], abortSignal: new AbortController().signal }).catch((error) => error);
    expect(failure.message).toBe("provider_failed");
    expect(failureKindOf(failure)).toBe("provider_unavailable");
    expect(budget.events[0]).toMatchObject({ status: "provider_failed", failureKind: "provider_unavailable" });
    expect(budget.providerStop).toBeNull();
    expect(budget.admissionStopped).toBe(false);
  });
  it.each(["provider_auth", "usage_limit"])("stops provider admission after fatal reader failure: %s", async (failureKind) => {
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind, error: "route dead", text: "" }));
    const options = () => ({ messages: [], abortSignal: new AbortController().signal });
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_failed");
    expect(budget.events[0]).toMatchObject({ status: "provider_failed", failureKind });
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind });
    // Factory, model and embedding admissions share one reserve gate: the next
    // setup refuses before any of them run, and nothing dispatches again.
    const factory = vi.fn();
    expect(() => { budget.reserve({}); factory(); }).toThrow("provider_admission_stopped");
    expect(factory).not.toHaveBeenCalled();
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_admission_stopped");
    await expect(meteredEmbeddings({ id: "fixture", embed: async () => [] }, { budget, tag: {} }).embed(["fictional"])).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledTimes(1);
    expect(budget.events).toHaveLength(1);
  });
  it("keeps untrusted failure kinds and raw errors out of events", async () => {
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind: "EVIL sk-123456789012", error: "boom Bearer canary https://host/x /Users/example", text: "" }));
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", { messages: [], abortSignal: new AbortController().signal })).rejects.toThrow("provider_failed");
    expect(budget.events[0].failureKind).toBeNull();
    expect(JSON.stringify(budget.events[0])).not.toMatch(/EVIL|123456789012|Bearer|host\/|example/u);
    expect(budget.providerStop).toBeNull();
    expect(canonicalFailureKind("EVIL sk-123456789012")).toBeNull();
    expect(canonicalFailureKind("provider_auth")).toBe("provider_auth");
    expect(isFatalFailureKind("usage_limit")).toBe(true);
    expect(isFatalFailureKind("provider_unavailable")).toBe(false);
  });
  it("recognizes structured thrown failures and ignores hostile thrown values", async () => {
    const options = () => ({ messages: [], abortSignal: new AbortController().signal });
    const { budget } = await setup();
    const structured = Object.assign(new Error("private boom"), { failureKind: "usage_limit" });
    const fatal = await meteredRuntime({ run: async () => { throw structured; } }, { budget, stage: "extraction", tag: {} }).run("s", options()).catch((error) => error);
    expect(fatal.message).toBe("provider_failed");
    expect(failureKindOf(fatal)).toBe("usage_limit");
    expect(budget.events[0]).toMatchObject({ stage: "extraction", status: "provider_failed", failureKind: "usage_limit" });
    expect(budget.providerStop).toMatchObject({ failureKind: "usage_limit" });
    const hostileSetup = await setup();
    const hostile = Object.assign(new Error("boom"), { failureKind: { nested: "sk-123456789012" } });
    await expect(meteredRuntime({ run: async () => { throw hostile; } }, { budget: hostileSetup.budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_failed");
    expect(hostileSetup.budget.events[0].failureKind).toBeNull();
    expect(hostileSetup.budget.providerStop).toBeNull();
    const rawSetup = await setup();
    await expect(meteredRuntime({ run: async () => { throw "raw boom"; } }, { budget: rawSetup.budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_failed");
    expect(rawSetup.budget.events[0].failureKind).toBeNull();
    expect(rawSetup.budget.providerStop).toBeNull();
  });
  it("carries fatal extraction and reconciliation categories through capture", async () => {
    const tag = { groupId: "g", arm: "bujo" };
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind: "provider_auth", error: "dead", text: "" }));
    const llm = captureLlm({ run }, { model: { reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions", budget, tag });
    await expect(llm.complete("TURN:\nUser: hi\nAssistant: ho", {})).rejects.toThrow("provider_failed");
    expect(budget.events[0]).toMatchObject({ stage: "extraction", failureKind: "provider_auth" });
    expect(budget.providerStop).toMatchObject({ failureKind: "provider_auth" });
    expect(captureFailureKindFor(budget.events, tag)).toBe("provider_auth");
    expect(captureFailureKindFor(budget.events, { groupId: "other", arm: "bujo" })).toBeNull();
    const reconciled = await setup();
    const reconcile = captureLlm({ run }, { model: { reference: "fixture:model" }, workspace: "w", sessionsRoot: "s", budget: reconciled.budget, tag });
    await expect(reconcile.complete("batch", { label: "capture:reconcile-batch" })).rejects.toThrow("provider_failed");
    expect(reconciled.budget.events[0]).toMatchObject({ stage: "reconciliation", failureKind: "provider_auth" });
    expect(captureFailureKindFor(reconciled.budget.events, tag)).toBe("provider_auth");
  });
  it("keeps a terminal provider stop sticky through successful cleanup", async () => {
    const { budget } = await setup();
    budget.stopProviders("provider_failed", "provider_auth");
    const store = { queueSnapshot: () => ready, close: vi.fn(async () => {}) };
    await cleanupTrial({ budget, store, providers: { close: async () => {} } }, 100);
    expect(store.close).toHaveBeenCalledOnce();
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind: "provider_auth" });
    // Cleanup reopens its temporary gating, but the terminal stop still refuses.
    expect(budget.admissionStopped).toBe(false);
    expect(() => budget.reserve({})).toThrow("provider_admission_stopped");
    // First fatal evidence wins; later evidence neither clears nor overwrites it.
    budget.stopProviders("other", "usage_limit");
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind: "provider_auth" });
  });
  it("reports structured failure categories on summary failures", async () => {
    const trials = [
      { groupId: "g1", arm: "recent-only", status: "provider_failed", runtimeFailureKind: "provider_auth", captureFailureKind: null },
      { groupId: "g2", arm: "bujo", status: "capture_not_ready", runtimeFailureKind: null, captureFailureKind: "usage_limit" },
      { groupId: "g3", arm: "bujo", status: "provider_failed", runtimeFailureKind: null, captureFailureKind: null },
    ];
    const summary = summarize(trials, [], "real");
    expect(summary.arms["recent-only"].failures).toEqual([{ groupId: "g1", status: "provider_failed", failureKind: "provider_auth" }]);
    expect(summary.arms.bujo.failures).toEqual([
      { groupId: "g2", status: "capture_not_ready", failureKind: "usage_limit" },
      { groupId: "g3", status: "provider_failed", failureKind: null },
    ]);
  });
  it("parses the explicit Pi auth path consistently with other profile flags", () => {
    const full = { reader: "openai-codex:model", extractor: "openai-codex:model", "embedding-provider": "ollama", "embedding-model": "m", dimension: "8" };
    expect(profileFrom({ ...full, "pi-auth-path": " /tmp/fixture-auth.json " })).toMatchObject({ piAuthPath: "/tmp/fixture-auth.json" });
    expect(profileFrom(full).piAuthPath).toBeUndefined();
    expect(() => profileFrom({ "pi-auth-path": "/tmp/fixture-auth.json" })).toThrow("incomplete_profile");
    expect(() => profileFrom({ ...full, "pi-auth-path": "   " })).toThrow("invalid_pi_auth_path");
    expect(() => profileFrom({ ...full, "pi-auth-path": "/tmp/fixture\nauth.json" })).toThrow("invalid_pi_auth_path");
    expect(() => parseArguments(["--pi-auth-path", "a", "--pi-auth-path", "b"])).toThrow();
    expect(() => parseArguments(["--real", "--pi-auth-path"])).toThrow();
  });
  it("binds only the auth fingerprint into the confirmed plan, never the raw path", async () => {
    const { corpus, sha256 } = await setup();
    const base = { reader: "fixture:reader", extractor: "fixture:extractor", embeddingProvider: "ollama", embeddingModel: "m", dimension: 8 };
    const withAuth = { ...base, piAuthPath: "/tmp/fixture-auth.json" };
    const a = makePlan({ corpus, sha256, profile: withAuth });
    expect(a.profile.piAuthFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(a.profile.piAuthPath).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("fixture-auth");
    const again = makePlan({ corpus, sha256, profile: { ...withAuth } });
    expect(again.profile.piAuthFingerprint).toBe(a.profile.piAuthFingerprint);
    expect(again.confirmation).toBe(a.confirmation);
    const changed = makePlan({ corpus, sha256, profile: { ...withAuth, piAuthPath: "/tmp/other-auth.json" } });
    expect(changed.profile.piAuthFingerprint).not.toBe(a.profile.piAuthFingerprint);
    expect(changed.confirmation).not.toBe(a.confirmation);
    const ambient = makePlan({ corpus, sha256, profile: base });
    expect(ambient.profile).toEqual(base);
    expect(ambient.profile.piAuthFingerprint).toBeUndefined();
    expect(serializableProfile(null)).toBeNull();
  });
  it("wires one shared Pi auth resolver into both real runtimes, preserving ambient auth when omitted", async () => {
    const resolver = async () => "fixture-key";
    const modules = {
      runtime: { createMonoRuntime: vi.fn(() => ({})), parseMonoRuntimeModelReference: (value) => ({ reference: value }), createPiOAuthApiKeyResolver: vi.fn(() => resolver) },
      search: { createEmbeddingProvider: vi.fn(() => ({})), createCircuitBreakerEmbeddingProvider: vi.fn((raw) => raw) },
    };
    const profile = { reader: "fixture:reader", extractor: "fixture:extractor", embeddingProvider: "ollama", embeddingModel: "m", dimension: 8, piAuthPath: "/tmp/fixture-auth.json" };
    const provided = await realProviders(profile, { workspace: "workspace", modules });
    expect(provided.kind).toBe("real");
    expect(modules.runtime.createPiOAuthApiKeyResolver).toHaveBeenCalledOnce();
    expect(modules.runtime.createPiOAuthApiKeyResolver).toHaveBeenCalledWith({ path: "/tmp/fixture-auth.json" });
    expect(modules.runtime.createMonoRuntime).toHaveBeenCalledTimes(2);
    expect(modules.runtime.createMonoRuntime.mock.calls[0][0]).toMatchObject({ workspace: "workspace" });
    expect(modules.runtime.createMonoRuntime.mock.calls[0][0].resolvePiApiKey).toBe(resolver);
    expect(modules.runtime.createMonoRuntime.mock.calls[1][0].resolvePiApiKey).toBe(resolver);
    const ambientModules = { runtime: { createMonoRuntime: vi.fn(() => ({})), parseMonoRuntimeModelReference: (value) => ({ reference: value }) }, search: modules.search };
    await realProviders({ ...profile, piAuthPath: undefined }, { workspace: "workspace", modules: ambientModules });
    expect(ambientModules.runtime.createMonoRuntime.mock.calls[0][0]).toEqual({ workspace: "workspace" });
    expect(ambientModules.runtime.createMonoRuntime.mock.calls[1][0]).toEqual({ workspace: "workspace" });
    await expect(realProviders(profile, { workspace: "workspace", modules: ambientModules })).rejects.toThrow("pi_auth_resolver_unavailable");
  });
  it("dry-run binds the auth fingerprint without touching credentials or network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const profile = ["--reader", "fixture:reader", "--extractor", "fixture:extractor", "--embedding-provider", "ollama", "--embedding-model", "m", "--dimension", "8"];
    const output = [];
    expect(await main(["--dry-run", ...profile, "--pi-auth-path", "/tmp/fixture-auth.json"], { stdout: (text) => output.push(JSON.parse(text)) })).toBe(0);
    expect(output[0].profile.piAuthFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(output[0])).not.toContain("fixture-auth");
    expect(network).not.toHaveBeenCalled();
    // A confirmation taken without the auth selection does not authorize a run with it.
    const plain = [];
    await main(["--dry-run", ...profile], { stdout: (text) => plain.push(JSON.parse(text)) });
    await expect(main(["--real", ...profile, "--pi-auth-path", "/tmp/fixture-auth.json", "--confirm-plan", plain[0].confirmation])).rejects.toThrow("real_execution_requires_confirmed_profile");
    expect(network).not.toHaveBeenCalled();
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
    const safe = JSON.stringify(safeArtifact({ prompt: "/Users/example/memory sk-123456789012 https://host/?token=secret", headers: { Authorization: "Bearer canary" }, cost: null, answer: "Fictional cobalt." }));
    expect(safe).not.toMatch(/example|123456789012|Bearer|host\//u);
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
