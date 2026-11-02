import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { aggregate, main, profileFrom } from "../continuity-benchmark.mjs";
import { CALL_CAP, MAX_TURNS, freezeBudget } from "../continuity-lookup-budget.mjs";
import { armById, checkpointKey, verifyStore, mergePatch } from "../lib/continuity-arms.mjs";
import { digest, loadTraces, makePlan } from "../lib/continuity-dataset.mjs";
import { probePrompt } from "../lib/continuity-score.mjs";
import { LOOKUP_MODE, LOOKUP_BUDGET, SOUL_BINDING, HISTORY_SERVER, assertLookupContract, assertLookupServers, assertSoul, historyBody, lookupMeter, lookupForwarder, lookupWitness, lookupPrompt, sha256, referenceFeasibility, sourceAnnotation, resolveSource, witnessedRecovery, referenceReader, scriptedLookupReader } from "../lib/continuity-lookup.mjs";
import { summarizeLookup, renderLookupMarkdown } from "../lib/continuity-lookup-score.mjs";
import { buildCheckpoint, runLiveTurn, runProbe, productionModules, lookupConfig, decodeBoundaryChildResult } from "../lib/continuity-runner.mjs";
import { startFixtureTools, TOOL_DEFINITIONS } from "../lib/continuity-tools.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dirs = [], closers = [];
beforeEach(() => vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --import=${join(root, "scripts/__tests__/fixtures/reject-account-home.mjs")}`));
afterEach(async () => { vi.unstubAllEnvs(); for (const close of closers.splice(0).reverse()) await close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() { const path = await mkdtemp(join(tmpdir(), "continuity-lookup-")); dirs.push(path); return path; }
const corpus = () => loadTraces();
const planFor = async () => makePlan({ ...await corpus(), probeMode: LOOKUP_MODE, profile: { judge: null } });

describe("recall-only byte compatibility", () => {
  it.each([
    ["original", "57a020b13fee82fdf562424b8961ce8d2ec5237790cbbad5efa8bd1483a2c27d", "47be8b5ac34262c16d3cf38cb6e751da5b0e76f4902aaed4dd5f3c9799d4d560"],
    ["hard", "d5ba902171e4a38063b5713df78dc7b58581847a993da4f0c7107bba1bbe4dc9", "f3daaefaf9caa549595a6a7585305b5bef117b733636a8d35f70e477f46f426e"],
    ["hard-distractors", "81e4dc058ee3fc0c9f1b7187d59a50620b191006ef589374ecaf9fa92439f356", "f3daaefaf9caa549595a6a7585305b5bef117b733636a8d35f70e477f46f426e"],
  ])("pins %s prompts, full plans, selected arms and confirmations at the base revision", async (suite, planDigest, promptsDigest) => {
    // Recorded before implementation at f9dcd55; not regenerated from modified expectations.
    const loaded = await loadTraces({ suite }), plan = makePlan({ ...loaded, codeRevision: "f9dcd55e945bb411697e0c3f2a37b9ce5ce8d8f9" });
    expect(digest(plan)).toBe(planDigest);
    expect(digest(loaded.traces.map(trace => trace.probes.map(probePrompt)))).toBe(promptsDigest);
    expect(plan).not.toHaveProperty("probeMode"); expect(plan).not.toHaveProperty("lookup");
    const { confirmation, ...body } = plan; expect(digest(body)).toBe(confirmation);
  });
});

describe("lookup registration and native fairness", () => {
  it("is explicit, Sol-first and never paid or a legacy holdout", async () => {
    const plan = await planFor();
    expect(plan.arms.map(row => row.id)).toEqual(["native-lookup", "continuity-pack-cold"]);
    expect(plan.baselineArm).toBe("native-lookup"); expect(plan.reader.model).toBe("openai-codex:gpt-6.1-sol");
    expect(plan.lookup).toMatchObject({ soul: SOUL_BINDING, budget: LOOKUP_BUDGET, deadlineMs: 600000, cleanupAllowanceMs: 60000, turnTimeoutMs: 690000, childWatchdogMs: 720000, maxTurns: 10 });
    expect(plan.limits.perLiveTurnTimeoutMs).toBe(690000);
    expect(profileFrom({ "probe-mode": LOOKUP_MODE }).probeMode).toBe(LOOKUP_MODE);
    expect(() => profileFrom({ "probe-mode": "unknown" })).toThrow("invalid_probe_mode");
    expect(() => profileFrom({ "probe-mode": LOOKUP_MODE, suite: "holdout" })).toThrow("lookup_not_legacy_holdout");
    const loader = vi.fn();
    await expect(main(["--probe-mode", LOOKUP_MODE, "--real", "--pi-auth-path", "/does-not-exist"], { env: {}, modulesLoader: loader })).rejects.toThrow("lookup_real_not_authorized");
    expect(loader).not.toHaveBeenCalled();
    await expect(main(["--probe-mode", LOOKUP_MODE, "--real"], { env: { CI: "1" } })).rejects.toThrow("lookup_real_not_authorized");
  });

  it("guards native lookup and namespaces checkpoints while preserving the server's identity", async () => {
    const loaded = await corpus();
    expect(() => makePlan({ ...loaded, arms: ["native", "native-lookup"] })).toThrow("native_lookup_requires_lookup_mode");
    expect(() => makePlan({ ...loaded, probeMode: LOOKUP_MODE, arms: ["native-lookup", "continuity-ledger-cold"] })).toThrow("lookup_arm_not_supported");
    const arm = armById("native-lookup");
    expect(arm).toMatchObject({ fork: "in-place", replayBinding: "reader", sessionConfig: { runtime: { session: { continuity: { enabled: true, packEnabled: false } } } }, probeConfig: { tools: { allowedTools: ["ConversationHistory"] }, runtime: { compaction: { enabled: false } } } });
    expect(checkpointKey(arm, 1, LOOKUP_MODE)).toBe("lookup-v1-scripted-native-lookup");
    expect(checkpointKey(armById("continuity-pack-cold"), 1, LOOKUP_MODE)).not.toBe(checkpointKey(armById("continuity-pack-cold"), 1));
    const evidence = { checkpointContinuity: { records: 3, degraded: false }, observed: { toolsOffered: ["ConversationHistory"], historyWarnings: 0, continuityPacks: [] } };
    expect(verifyStore(arm, evidence).healthy).toBe(true);
    expect(verifyStore(arm, { ...evidence, observed: { ...evidence.observed, continuityPacks: [{ tokens: 1 }] } }).reasons).toContain("unexpected_pack_injected");
    expect(verifyStore(arm, { ...evidence, checkpointContinuity: null }).healthy).toBe(false);
    expect(verifyStore(arm, { ...evidence, observed: { ...evidence.observed, toolsOffered: [] } }).healthy).toBe(false);
  });

  it("binds frozen soul raw bytes and the production-normalized core; refuses changes rather than fallback", async () => {
    const bytes = await readFile(join(root, "scripts/fixtures/continuity-soul-v1.md"));
    const { loadContextFromFiles } = await import("../../packages/conversation/dist/context/file-loader.js");
    const plan = await planFor();
    expect(plan.lookup.soul).toEqual(LOOKUP_BUDGET.soul);
    expect(sha256(bytes)).toBe(SOUL_BINDING.rawSha256);
    expect(() => assertSoul(Buffer.from(`${bytes}changed`), plan.lookup.soul)).toThrow("lookup_soul_digest_mismatch");
    const { installSoul } = await import("../lib/continuity-lookup.mjs");
    const work = await scratch(); await installSoul(work, plan.lookup.soul);
    const { writeFile } = await import("node:fs/promises"); await writeFile(join(work, "IDENTITY.md"), "Fictional benchmark agent.");
    const context = await loadContextFromFiles({ identityPath: join(work, "IDENTITY.md"), soulPath: join(work, "BENCHMARK-SOUL.md"), userMessage: "Check." });
    expect(sha256(context.sections.find(section => section.id === "core").content)).toBe(SOUL_BINDING.coreSha256);
    const { confirmation, ...body } = plan;
    expect(digest({ ...body, lookup: { ...body.lookup, soul: { ...SOUL_BINDING, rawSha256: "0".repeat(64) } } })).not.toBe(confirmation);
    await writeFile(join(work, "BENCHMARK-SOUL.md"), "changed");
    await expect(runLiveTurn({ modules: {}, work, plan, mode: "offline" })).rejects.toThrow("lookup_soul_digest_mismatch");
    await expect(runLiveTurn({ modules: {}, work, plan, mode: "real" })).rejects.toThrow("lookup_real_not_authorized");
    expect(() => assertLookupContract({ suite: "original", sha256: "changed" })).toThrow("lookup_requires_frozen_corpus_and_budget");
  });
});

describe("measured frozen budgets and two independent feasibility constraints", () => {
  it("pins the measured inventory and derives its call cap from maxTurns", () => {
    expect(MAX_TURNS).toBe(100); expect(CALL_CAP).toBe(Math.min(96, MAX_TURNS - 2));
    expect(LOOKUP_BUDGET.callBudget + 2).toBeLessThanOrEqual(100);
    expect(LOOKUP_BUDGET).toMatchObject({ callBudget: 8, byteBudget: 126976, inventorySha256: "6c45a457f926af1d259c4b53bc3b45821b939ca3fdfd1a830b38b538f415a6b9", measurement: { paths: 112, largestResponse: 32608, maxPathBytes: 61718, maxPathCalls: 6 } });
    expect(LOOKUP_BUDGET.byteBudget).toBe(Math.ceil((61718 + 2 * 32608) / 1024) * 1024);
    expect(LOOKUP_BUDGET.paths).toHaveLength(112);
    expect(new Set(LOOKUP_BUDGET.paths.map(row => row.arm))).toEqual(new Set(["native-lookup", "continuity-pack-cold"]));
    expect(LOOKUP_BUDGET.paths.filter(row => row.feasibility.classification === "feasible")).toHaveLength(64);
    expect(LOOKUP_BUDGET.paths.filter(row => row.feasibility.classification === "budget-infeasible")).toHaveLength(48);
    expect(LOOKUP_BUDGET.paths.filter(row => row.feasibility.classification === "budget-infeasible").every(row => row.arm === "native-lookup" && row.feasibility.reasons.includes("reader_context"))).toBe(true);
  });

  it("freezes before trials, never silently widens caps, and classes reference infeasibility separately", () => {
    const inventory = { corpus: {}, retained: [{ retainedBytes: 10 }], paths: [{ traceId: "fiction", probeId: "p01", arm: "native-lookup", calls: 110, bytes: 9000000, cumulativeBytes: 9000000, responseBytes: [9000000], discovered: true, initialTokens: 150000, admissionCap: 6000000 }] };
    const budget = freezeBudget(inventory);
    expect(budget).toMatchObject({ callBudget: CALL_CAP, byteBudget: 8388608, inventorySha256: digest(inventory) });
    expect(budget.paths[0].feasibility).toMatchObject({ classification: "budget-infeasible", reasons: ["calls", "bytes", "reader_context", "observed_input_admission"] });
    const path = { calls: 8, bytes: 100, cumulativeBytes: 500, discovered: true };
    const cap = { callBudget: 10, byteBudget: 1000, contextWindowTokens: 272000, contextMarginTokens: 16000 };
    // A native round fits the context, but repeated input violates admission. Counting it only once would pass.
    expect(referenceFeasibility(path, cap, { initialTokens: 150000, admissionCap: 1000000 }).reasons).toEqual(["observed_input_admission"]);
    expect(referenceFeasibility(path, { ...cap, contextWindowTokens: 160000 }, { initialTokens: 150000, admissionCap: 6000000 }).reasons).toEqual(["reader_context"]);
    expect(referenceFeasibility({ ...path, discovered: false }, cap, { initialTokens: 150000, admissionCap: 6000000 }).reasons).toEqual(["reference_source_not_discovered"]);
  });
});

async function forwarding({ callBudget = 2, byteBudget = 10000, now, beforeResult } = {}) {
  const tools = await startFixtureTools({ beforeResult }); closers.push(tools.close);
  const meter = lookupMeter({ callBudget, byteBudget, ...(now ? { now, deadlineMs: 10 } : {}) });
  const forwarder = await lookupForwarder({ meter }); closers.push(() => forwarder.close());
  const options = { marker: "unchanged", mcpServers: { [HISTORY_SERVER]: { type: "http", url: tools.url }, other: { type: "http", url: "http://127.0.0.1:1/untouched" } } };
  const rewritten = await forwarder.rewrite(options);
  const client = new Client({ name: "fiction-lookup-test", version: "1" }); closers.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(rewritten.mcpServers[HISTORY_SERVER].url)));
  return { tools, meter, options, rewritten, client };
}

describe("real-loopback URL-only forwarding and admission", () => {
  it("preserves key, schema, handler and multibyte result; counts ONLY content bytes", async () => {
    const f = await forwarding();
    expect(Object.keys(f.rewritten.mcpServers)).toEqual(Object.keys(f.options.mcpServers));
    expect(f.rewritten.mcpServers.other).toBe(f.options.mcpServers.other);
    expect({ ...f.rewritten.mcpServers[HISTORY_SERVER], url: f.options.mcpServers[HISTORY_SERVER].url }).toEqual(f.options.mcpServers[HISTORY_SERVER]);
    expect(f.options.mcpServers[HISTORY_SERVER].url).toBe(f.tools.url);
    expect((await f.client.listTools()).tools).toEqual(TOOL_DEFINITIONS);
    f.tools.expect("mail_read", { id: 1 }, "Fictional 🔷 evidence");
    const result = await f.client.callTool({ name: "mail_read", arguments: { id: 1 } });
    expect(result.content).toEqual([{ type: "text", text: "Fictional 🔷 evidence" }]);
    expect(f.meter.state).toMatchObject({ calls: 1, bytes: Buffer.byteLength(JSON.stringify(result.content)), responses: 1, exhausted: null });
    const meter = lookupMeter({ callBudget: 1, byteBudget: 1000 }); meter.dispatch();
    const full = { content: result.content, structuredContent: { omittedFromAccounting: "z".repeat(10000) } };
    expect(meter.deliver(full)).toBe(full); expect(meter.state.bytes).toBe(f.meter.state.bytes);
  });

  it("rejects calls before dispatch and oversized results before delivery; never clips", async () => {
    const f = await forwarding({ callBudget: 1 });
    f.tools.expect("mail_read", {}, "unchanged");
    await f.client.callTool({ name: "mail_read", arguments: {} });
    await expect(f.client.callTool({ name: "mail_read", arguments: {} })).rejects.toThrow("lookup_budget_calls"); expect(f.tools.served()).toBe(1); expect(f.meter.state.exhausted).toBe("calls");
    const g = await forwarding({ byteBudget: 50 });
    g.tools.expect("mail_read", {}, "🔷".repeat(100));
    await expect(g.client.callTool({ name: "mail_read", arguments: {} })).rejects.toThrow("lookup_budget_bytes");
    expect(g.meter.state).toMatchObject({ calls: 1, bytes: 0, responses: 0, exhausted: "bytes" });
    expect(g.tools.served()).toBe(1);
  });

  it("uses atomic reservations and a test clock for latency, including in-flight response exhaustion", () => {
    let clock = 0; const abort = vi.fn();
    const meter = lookupMeter({ callBudget: 1, byteBudget: 100, deadlineMs: 600000, now: () => clock, onExhaustion: abort });
    meter.dispatch(); expect(() => meter.dispatch()).toThrow("lookup_budget_calls");
    const timed = lookupMeter({ callBudget: 2, byteBudget: 100, deadlineMs: 600000, now: () => clock, onExhaustion: abort });
    timed.dispatch(); clock = 600000;
    expect(() => timed.deliver({ content: [] })).toThrow("lookup_budget_latency");
    expect(timed.state).toMatchObject({ calls: 1, bytes: 0, exhausted: "latency" }); expect(abort).toHaveBeenCalled();
  });
});

it("requires absent + retained + digest-witnessed + correct for recovery, not provenance guesses", () => {
  const lookup = { initiallyPresent: false, source: { availability: "retained" }, sourceReturned: true };
  expect(witnessedRecovery(lookup, true)).toBe(true);
  for (const changed of [{ initiallyPresent: true }, { initiallyPresent: "unknown" }, { source: { availability: "protected" } }, { source: { availability: "unknown" } }, { sourceReturned: false }]) expect(witnessedRecovery({ ...lookup, ...changed }, true)).toBe(false);
  expect(witnessedRecovery(lookup, false)).toBe(false);
  const witness = lookupWitness({ availability: "protected" }, { value: "FICTIONAL-SECRET" });
  witness.initial({ messages: [{ content: "not present" }] });
  expect(JSON.stringify(witness.snapshot())).not.toContain("FICTIONAL-SECRET");
});

it("retains planned slots and per-arm availability, feasibility, exact accuracy and all exhaustion kinds", async () => {
  const plan = await planFor(), trace = plan.corpus.traces[0];
  const trial = { traceId: trace.id, probeId: trace.probes[0], arm: "native-lookup", repeat: 1, status: "completed", durationMs: 12,
    lookup: { source: { availability: "retained" }, budgetFeasibility: { classification: "feasible" }, exactAccuracy: true, witnessedRecovery: false, calls: 8, bytes: 100, exhausted: "latency" } };
  const report = summarizeLookup([trial], plan);
  expect(report.slots).toHaveLength(plan.corpus.traces.reduce((sum, row) => sum + row.probes.length, 0) * 2);
  expect(report.arms["native-lookup"]).toMatchObject({ exact: { correct: 1, n: 1 }, latencyExhaustion: 1, calls: { total: 8 }, bytes: { total: 100 } });
  expect(report.arms["continuity-pack-cold"].statuses.missing).toBeGreaterThan(0);
  const infeasible = { ...trial, status: "failed", failure: "restart_child_timeout", lookup: { ...trial.lookup, budgetFeasibility: { classification: "budget-infeasible" } } };
  expect(summarizeLookup([infeasible], plan).arms["native-lookup"]).toMatchObject({ readerFailures: 0, hardWatchdogFailures: 1, budgetFeasibility: { "budget-infeasible": 1 } });
});

it("runs >=8 faux reader rounds through real packed-id get, query pagination, multibyte cursors, digest verification and cleanup", async () => {
  const modules = await productionModules(root), plan = await planFor(), dir = await scratch();
  const text = "Order 🔷 cobalt evidence. ".repeat(1200), value = "MORGAN-QLK-42";
  const trace = { id: "lookup-fiction", owner: { displayName: "Morgan" }, midCheckpoint: "t02", probeAt: "2026-05-18T10:00:00.000Z",
    turns: [{ id: "t01", at: "2026-05-17T10:00:00.000Z", user: "Read the fictional documents.", steps: [
      ...[0, 1, 2].map(index => ({ call: { tool: "doc_read", args: { index }, result: `Fictional order header ${index}.\n\n${text}${index === 1 ? value : "end"}` } })), { reply: "Ready." }],
    }], probes: [{ id: "p01", category: "tool_identifier", question: "What is the fictional reference?", format: "Only the reference.", abstainOption: true, score: { kind: "identifier", accept: [value] } }] };
  // The test intentionally permits both complete traversals. Registered trials remain bound to 8/126976.
  plan.lookup.budget = { ...plan.lookup.budget, callBudget: 20, byteBudget: 200000 }; plan.lookup.maxTurns = 22;
  const arm = armById("continuity-pack-cold");
  const checkpoint = await buildCheckpoint({ modules, trace, arm, repeat: 1, dir, plan, mode: "offline" });
  const source = resolveSource(modules, checkpoint.work, checkpoint.record.conversationId, sourceAnnotation(trace, trace.probes[0]));
  const live = await runLiveTurn({ modules, work: checkpoint.work, authPath: join(dir, "no-credentials.json"), plan, mode: "offline",
    configPatch: mergePatch(arm.sessionConfig, arm.probeConfig), userMessage: lookupPrompt(trace.probes[0]), clock: { value: new Date(trace.probeAt) },
    conversationId: checkpoint.record.conversationId, owner: "Morgan", lookupSource: source, lookupAnnotation: sourceAnnotation(trace, trace.probes[0]) });
  expect(live.failureKind).toBeNull(); expect(live.lookup.rounds).toBeGreaterThanOrEqual(9);
  expect(live.lookup).toMatchObject({ sourceReturned: true, exhausted: null, initiallyPresent: false });
  expect(live.lookup.searchPages).toBeGreaterThanOrEqual(2); expect(live.lookup.getChunks).toBeGreaterThanOrEqual(5);
  expect(live.lookup.records.some(row => row.chunks >= 4 && row.verified)).toBe(true);
  expect(live.observed.offlineProviderPackCounts.every(count => count === 1)).toBe(true);
  expect(JSON.stringify(live.lookup)).not.toContain("Order 🔷"); expect(JSON.stringify(live.lookup)).not.toContain(value);
  // A fresh in-place child can restore and reuse the lease after all forwarding clients close.
  const trial = await runProbe({ modules, trace, arm, repeat: 1, probe: trace.probes[0], checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot,
    checkpointContinuity: checkpoint.record.continuity, checkpointConversationId: checkpoint.record.conversationId,
    forkDir: join(dir, "probe"), plan, mode: "offline", root });
  expect(trial.status, JSON.stringify(trial)).toBe("completed"); expect(trial.lookup.sourceReturned).toBe(true);
  plan.lookup.budget = { ...plan.lookup.budget, callBudget: 1, byteBudget: 1 }; plan.lookup.maxTurns = 3;
  const exhausted = await runProbe({ modules, trace, arm, repeat: 1, probe: trace.probes[0], checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot,
    checkpointContinuity: checkpoint.record.continuity, checkpointConversationId: checkpoint.record.conversationId,
    forkDir: join(dir, "exhausted"), plan, mode: "offline", root });
  expect(exhausted.status, JSON.stringify(exhausted)).toBe("failed"); expect(exhausted.failure).toBe("lookup_budget_bytes");
  expect(exhausted.lookup).toMatchObject({ calls: 1, exhausted: "bytes" });
  const input = { modules, trace, arm, repeat: 1, probe: trace.probes[0], checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot,
    checkpointContinuity: checkpoint.record.continuity, checkpointConversationId: checkpoint.record.conversationId, forkDir: join(dir, "failure"), plan, mode: "offline", root };
  plan.lookup.maxTurns = 101;
  const invalid = await runProbe(input);
  expect(invalid.failure).toBe("invalid_lookup_child_contract");
  plan.lookup.maxTurns = 3;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(checkpoint.snapshot, "BENCHMARK-SOUL.md"), "changed fixture soul");
  const mismatch = await runProbe(input);
  expect(mismatch.failure, JSON.stringify(mismatch)).toBe("lookup_soul_digest_mismatch");
  expect(mismatch.lookup).toMatchObject({ calls: 0, bytes: 0, initiallyPresent: "unknown", source: { availability: "retained" } });
}, 120000);

it("uses packed ids or exactly one source-derived query for sizing, not an unfiltered scan", () => {
  const source = { availability: "retained", recordId: `chr1_${"a".repeat(43)}` }, query = "Fictional order source annotation";
  const packed = referenceReader({ source, query });
  expect(packed.next({ messages: [{ content: `### Conversation continuity pack\n${source.recordId}` }] })).toEqual({ action: "get", recordId: source.recordId, chunkBytes: 8192 });
  const searched = referenceReader({ source, query }), context = { messages: [] };
  expect(searched.next(context)).toEqual({ action: "search", query, limit: 10 });
  expect(searched.next(context, { action: "search", items: [], nextCursor: "not-a-linear-scan" })).toBeNull();
  const found = referenceReader({ source, query }); found.next(context);
  expect(found.next(context, { action: "search", items: [source] })).toMatchObject({ action: "get", recordId: source.recordId });
  expect(found.next(context, { action: "get", record: source, nextCursor: "opaque" })).toEqual({ action: "get", cursor: "opaque" });
});

it("verifies contiguous UTF-8 digests from model-visible blocks, ignoring forged structuredContent", () => {
  const text = "Fictional 🔷 evidence", source = { availability: "retained", recordId: "opaque", sha256: sha256(text) };
  const response = (chunk, chunkOffset, patch = {}) => {
    const body = { action: "get", status: "available", record: { ...source, retainedBytes: Buffer.byteLength(text) }, chunk, chunkOffset, ...patch };
    const wire = `Notice\n${JSON.stringify(body)}`;
    const split = wire.includes("🔷") ? wire.indexOf("🔷") + 1 : 32;
    return { content: [{ type: "text", text: "navigation" }, { type: "text", text: `[continued section 1 of 2]\n${wire.slice(0, split)}` }, { type: "text", text: `[continued section 2 of 2]\n${wire.slice(split)}` }], structuredContent: { ...body, chunk: text } };
  };
  const witness = lookupWitness(source); witness.initial({});
  const result = JSON.parse(JSON.stringify(response(text, 0)));
  expect(result.content[1].text.charCodeAt(result.content[1].text.length - 1)).toBe(0xd83d);
  expect(result.content[2].text.replace(/^.*\n/u, "").charCodeAt(0)).toBe(0xdd37);
  expect(historyBody(result).chunk).toBe(text); witness.delivered(result);
  expect(witness.snapshot()).toMatchObject({ sourceReturned: true, initiallyPresent: "unknown", records: [{ verified: true, chunks: 1 }] });
  const forged = lookupWitness(source); forged.delivered(response("wrong", 0));
  expect(forged.snapshot().sourceReturned).toBe(false);
  const outOfOrder = lookupWitness(source); outOfOrder.delivered(response(text, 1));
  expect(outOfOrder.snapshot().sourceReturned).toBe(false);
});


it("keeps completed and unstarted lookup slots from incomplete units during aggregation", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const loaded = await corpus(), plan = await planFor(), output = await scratch(), trace = plan.corpus.traces[0];
  await mkdir(join(output, "units"));
  const key = { traceId: trace.id, arm: "native-lookup", repeat: 1 };
  const trials = [{ ...key, probeId: trace.probes[0], category: "tool_identifier", status: "completed", score: { pass: false, outcome: "wrong" },
    lookup: { source: { availability: "retained" }, calls: 1, bytes: 100, exactAccuracy: false } },
    { ...key, probeId: trace.probes[1], category: "tool_identifier", status: "not_started" }];
  await writeFile(join(output, "units/partial.json"), JSON.stringify({ ...key, confirmation: plan.confirmation, executionKind: "offline", complete: false, trials }));
  const result = await aggregate({ plan, traces: loaded.traces, output, mode: "offline" });
  expect(result.coverage.unitsComplete).toBe(0);
  expect(result.summary.lookup.arms["native-lookup"]).toMatchObject({ statuses: { completed: 1, not_started: 1 }, calls: { total: 1 }, bytes: { total: 100 } });
});


it("does not upgrade unknown tool-source provenance into retained retrieval recovery", () => {
  const record = { kind: "tool", provenance: "unknown", recordId: "opaque", sha256: sha256("MORGAN-42") };
  class Reader {
    searchContinuity() { return { available: true, items: [record] }; }
    getContinuity() { return { status: "available", record, chunk: "MORGAN-42" }; }
  }
  expect(resolveSource({ conversation: { ToolHistoryReader: Reader } }, "/fiction", "web:fiction", { availability: "annotated", value: "MORGAN-42" }).availability).toBe("unknown");
});


it("rejects wrong forwarder paths and non-loopback/incorrect-port Host values", async () => {
  const { request } = await import("node:http");
  const f = await forwarding(), url = new URL(f.rewritten.mcpServers[HISTORY_SERVER].url);
  expect(url.pathname).toMatch(/^\/mcp\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  const status = (path, host) => new Promise((resolve, reject) => {
    const req = request(url, { path, headers: { Host: host } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    req.on("error", reject); req.end();
  });
  expect(await status("/wrong-path", url.host)).toBe(404);
  for (const host of ["attacker.invalid", "localhost:" + url.port, "127.0.0.1:1"]) expect(await status(url.pathname, host)).toBe(403);
  expect(f.meter.state.calls).toBe(0);
});

it("bounds even a six-chunk packed traversal plus search/page/get by the planned call budget", () => {
  const callBudget = 8, reader = scriptedLookupReader({ callBudget });
  const context = { messages: [{ content: `### Conversation continuity pack\nchr1_${"a".repeat(43)}` }] };
  const meter = lookupMeter({ callBudget, byteBudget: 10000 });
  const args = [];
  const next = body => { const call = reader.next(context, body); if (call) { meter.dispatch(); args.push(call); } return call; };
  expect(next(null).action).toBe("get");
  for (let chunk = 1; chunk < 6; chunk++) expect(next({ action: "get", nextCursor: `cursor-${chunk}` }).cursor).toBe(`cursor-${chunk}`);
  expect(next({ action: "get" }).action).toBe("search");
  expect(next({ action: "search", items: [{ recordId: "opaque" }], navigation: { nextActions: [{ kind: "next_search_page", arguments: { action: "search", cursor: "page" } }] } }).cursor).toBe("page");
  expect(next({ action: "search", items: [{ recordId: "opaque" }] })).toBeNull();
  expect(args).toHaveLength(callBudget); expect(meter.state.exhausted).toBeNull();
});

it("fails closed on every extra effective probe MCP server, including history aliases", () => {
  expect(() => assertLookupServers({ mcpServers: { [HISTORY_SERVER]: {} } })).not.toThrow();
  for (const alias of ["mono-agent-session-history", "mono-agent-tool-history", "mono-agent-run-history", "SessionHistory", "custom-history", "other"]) {
    expect(() => assertLookupServers({ mcpServers: { [HISTORY_SERVER]: {}, [alias]: {} } })).toThrow("lookup_unmetered_mcp_server");
  }
});

it("scopes the lookup maxTurns ceiling to probe turns, not scripted checkpoint replay", async () => {
  const plan = await planFor();
  expect(lookupConfig("/fiction", plan, {}).runtime.maxTurns).toBeUndefined();
  expect(lookupConfig("/fiction", plan, {}, true).runtime.maxTurns).toBe(10);
});

it("excludes completed-infeasible slots from exact accuracy but retains their status, costs and coverage", async () => {
  const plan = await planFor(), trace = plan.corpus.traces[0];
  const base = { traceId: trace.id, arm: "native-lookup", repeat: 1, status: "completed", durationMs: 7 };
  const report = summarizeLookup([
    { ...base, probeId: trace.probes[0], lookup: { exactAccuracy: true, budgetFeasibility: { classification: "budget-infeasible" }, calls: 6, bytes: 123 } },
    { ...base, probeId: trace.probes[1], lookup: { exactAccuracy: false, budgetFeasibility: { classification: "feasible" }, calls: 2, bytes: 45 } },
  ], plan);
  expect(report.arms["native-lookup"]).toMatchObject({ statuses: { completed: 2 }, exact: { n: 1, correct: 0, accuracy: 0 }, budgetFeasibility: { "budget-infeasible": 1 }, calls: { total: 8 }, bytes: { total: 168 }, latencyMs: { total: 14 } });
  expect(report.slots.filter(row => row.status === "completed")).toHaveLength(2);
});

it("derives uncapped measured maxima, recomputes every frozen feasibility result and pins the entire fixture", async () => {
  const inventory = { corpus: {}, retained: [], paths: [{ traceId: "fiction", probeId: "p01", arm: "native-lookup", calls: 6, bytes: 61718,
    cumulativeBytes: 100000, responseBytes: [32608], discovered: true, initialTokens: 150000, admissionCap: 6000000 }] };
  const derived = freezeBudget(inventory);
  expect(derived).toMatchObject({ callBudget: 8, byteBudget: 126976 });
  for (const path of LOOKUP_BUDGET.paths) {
    expect(referenceFeasibility(path, LOOKUP_BUDGET, path), `${path.traceId}/${path.probeId}/${path.arm}`).toEqual(path.feasibility);
  }
  const bytes = await readFile(join(root, "scripts/fixtures/continuity-lookup-budget-v1.json"));
  expect(sha256(bytes)).toBe("34260285a54202c7cf6f93dc546b122c6c9b570480bbab36324665cb3b51b865");
});

it("surfaces failed-child codes and nonzero meter/witness receipts without confusing hard watchdogs", () => {
  const lookup = { calls: 3, bytes: 123, records: [{ recordId: "opaque", sha256: sha256("fiction"), bytes: 123, chunks: 2, verified: true }], exhausted: null };
  const raw = JSON.stringify({ failure: "lookup_cleanup_timeout", lookup });
  let failure;
  try { decodeBoundaryChildResult(1, raw, LOOKUP_MODE); } catch (error) { failure = error; }
  expect(failure.code).toBe("lookup_cleanup_timeout"); expect(failure.lookup).toEqual(lookup);
  expect(() => decodeBoundaryChildResult("timeout", raw, LOOKUP_MODE)).toThrow("restart_child_timeout");
  expect(() => decodeBoundaryChildResult(1, "not JSON", LOOKUP_MODE)).toThrow("restart_child_failed");
  expect(() => decodeBoundaryChildResult(1, raw)).toThrow("restart_child_failed");
});

it("atomically admits only one concurrent in-flight call at the budget edge", async () => {
  let entered, release;
  const seen = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await forwarding({ callBudget: 1, beforeResult: async () => { entered(); await gate; } });
  f.tools.expect("mail_read", {}, "fictional result");
  const first = f.client.callTool({ name: "mail_read", arguments: {} });
  const firstOutcome = first.catch(error => error);
  try {
    await seen;
    await expect(f.client.callTool({ name: "mail_read", arguments: {} })).rejects.toThrow("lookup_budget_calls");
    expect(f.tools.served()).toBe(1); expect(f.meter.state.calls).toBe(1);
  } finally { release(); }
  expect((await firstOutcome).message).toContain("lookup_budget_calls");
  expect(f.meter.state).toMatchObject({ calls: 1, responses: 0, bytes: 0, exhausted: "calls" });
});


it("retries a failed upstream handshake rather than caching a poisoned forwarding route", async () => {
  const tools = await startFixtureTools(); closers.push(tools.close);
  const forwarder = await lookupForwarder({ meter: lookupMeter({ callBudget: 1, byteBudget: 10000 }) }); closers.push(() => forwarder.close());
  const options = { mcpServers: { [HISTORY_SERVER]: { type: "http", url: tools.url } } };
  const connect = vi.spyOn(Client.prototype, "connect").mockRejectedValueOnce(new Error("fictional handshake failure"));
  let rewritten;
  try {
    await expect(forwarder.rewrite(options)).rejects.toThrow("fictional handshake failure");
    rewritten = await forwarder.rewrite(options);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally { connect.mockRestore(); }
  const client = new Client({ name: "fictional-retry", version: "1" }); closers.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(rewritten.mcpServers[HISTORY_SERVER].url)));
  expect((await client.listTools()).tools).toEqual(TOOL_DEFINITIONS);
});

it("requires an explicit soul binding on assertions and installation", async () => {
  const bytes = await readFile(join(root, "scripts/fixtures/continuity-soul-v1.md"));
  for (const binding of [undefined, null, {}]) {
    let error; try { assertSoul(bytes, binding); } catch (caught) { error = caught; }
    expect(error.code).toBe("lookup_soul_binding_missing");
  }
  const plan = await planFor();
  expect(() => assertSoul(bytes, plan.lookup.soul)).not.toThrow();
  const { installSoul } = await import("../lib/continuity-lookup.mjs");
  await expect(installSoul(await scratch())).rejects.toMatchObject({ code: "lookup_soul_binding_missing" });
});

it("reports exact accuracy both with and without failed feasible slots, without charging missing/not-run coverage", async () => {
  const plan = await planFor(), trace = plan.corpus.traces[0];
  const base = { traceId: trace.id, arm: "native-lookup", repeat: 1 };
  const summary = summarizeLookup([
    { ...base, probeId: trace.probes[0], status: "completed", lookup: { exactAccuracy: true, budgetFeasibility: { classification: "feasible" } } },
    { ...base, probeId: trace.probes[1], status: "failed", lookup: { budgetFeasibility: { classification: "feasible" } } },
    { ...base, probeId: trace.probes[2], status: "not_started" },
    { ...base, probeId: trace.probes[3], status: "failed", lookup: { budgetFeasibility: { classification: "budget-infeasible" } } },
    { ...base, probeId: trace.probes[4], status: "failed", lookup: { budgetFeasibility: { classification: "unknown" } } },
  ], plan);
  expect(summary.arms["native-lookup"]).toMatchObject({ exact: { n: 1, correct: 1, accuracy: 1 }, exactWithFailures: { n: 2, correct: 1, accuracy: .5 }, failedFeasible: 1 });
  expect(summary.arms["native-lookup"].statuses.missing).toBeGreaterThan(0);
  const markdown = renderLookupMarkdown(summary);
  expect(markdown).toContain("Exact with failures correct/n"); expect(markdown).toContain("Failed feasible");
  expect(markdown).toContain("| 1/1 | 1/2 | 1 |");
});

it("reserves an identical fixture result before awaiting the concurrency barrier", async () => {
  let entered, release, secondHook;
  const seen = new Promise(resolve => { entered = resolve; });
  const seenSecond = new Promise(resolve => { secondHook = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let invocations = 0;
  const f = await forwarding({ callBudget: 2, beforeResult: async () => { if (++invocations === 1) entered(); else secondHook(); await gate; } });
  f.tools.expect("mail_read", {}, "reserved fictional result");
  const first = f.client.callTool({ name: "mail_read", arguments: {} });
  await seen;
  const second = f.client.callTool({ name: "mail_read", arguments: {} });
  try {
    // Old code could let the second call reach the same non-empty queue before either shifted.
    await Promise.race([second, seenSecond]);
  } finally { release(); }
  expect((await second).isError).toBe(true);
  expect((await first).content).toEqual([{ type: "text", text: "reserved fictional result" }]);
  expect(f.tools.served()).toBe(1); expect(invocations).toBe(1);
});

it("gives a non-frozen lookup corpus a stable refusal code, including at the CLI boundary", async () => {
  const loaded = await corpus();
  expect(() => makePlan({ ...loaded, sha256: "not-frozen", probeMode: LOOKUP_MODE })).toThrowError(expect.objectContaining({ code: "lookup_requires_frozen_corpus_and_budget" }));
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [join(root, "scripts/continuity-benchmark.mjs"), "--probe-mode", LOOKUP_MODE, "--suite", "hard", "--seeds", "109", "--dry-run"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(1); expect(result.stderr).toContain("continuity-benchmark: lookup_requires_frozen_corpus_and_budget");
});
