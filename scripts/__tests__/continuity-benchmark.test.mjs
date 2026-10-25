import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, AVAILABLE_ARM_IDS, BASELINE_ARM, CONTINUITY_OFF, CONTINUITY_ON, CONTINUITY_PACK_ON, DEFAULT_ARMS, NOT_AVAILABLE, ORIGINAL_ARM_IDS, SMALL_PROACTIVE_COMPACTION, armById, checkpointKey, mergePatch, pressureMetrics, verifyBoundary, verifyPressure, verifyStore } from "../lib/continuity-arms.mjs";
import { classifyHistoryResult } from "../lib/continuity-runner.mjs";
import { estimateCost, inventory, loadTraces, makePlan, parseSeeds, sourceOnly, validateTrace } from "../lib/continuity-dataset.mjs";
import { COLD_BOUNDS, GENERATOR_VERSION, HARD_SEEDS, LONG_RULES, generateTrace, mulberry32, outsideColdBounds, traceShape } from "../lib/continuity-generator.mjs";
import { ABSTAIN_INSTRUCTION, ORIGINAL_CATEGORIES, emptyUsage, addUsage, isAbstention, parseJudgeVerdict, probePrompt, renderMarkdown, scoreAnswer, summarize } from "../lib/continuity-score.mjs";
import { callKey } from "../lib/continuity-tools.mjs";
import { main, parseArguments, observedInputTokens } from "../continuity-benchmark.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dirs = [];
// Restart probes run outside Vitest mocks. Reject an accidental default home
// before any real account-home filesystem access in those child processes.
beforeEach(() => vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --import=${join(root, "scripts/__tests__/fixtures/reject-account-home.mjs")}`));
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() { const dir = await mkdtemp(join(await realpath(tmpdir()), "continuity-test-")); dirs.push(dir); return dir; }
const probe = (score, extra = {}) => ({ id: "p01", category: "tool_identifier", question: "What was it?", abstainOption: true, score, ...extra });

describe("continuity benchmark corpus (fictional, checked in)", () => {
  it("loads four valid multi-session traces covering every probe category", async () => {
    const { traces, sha256 } = await loadTraces();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(traces).toHaveLength(4);
    const counts = inventory(traces);
    expect(counts.probes).toBeGreaterThanOrEqual(40);
    for (const row of counts.traces) {
      expect(row.turns).toBeGreaterThanOrEqual(30);
      expect(row.toolCalls).toBeGreaterThanOrEqual(20);
      expect(row.steers).toBeGreaterThanOrEqual(1);
      expect(row.sessions).toBeGreaterThanOrEqual(4);
      expect(row.probes).toBeGreaterThanOrEqual(10);
      expect(row.probes).toBeLessThanOrEqual(15);
      for (const category of ORIGINAL_CATEGORIES) expect(row.categories[category]).toBeGreaterThanOrEqual(1);
    }
    for (const trace of traces) expect(trace.fictional).toBe(true);
  });

  it("rejects identifiers that are not tool-only, a missing steer and a missing category", async () => {
    const { traces } = await loadTraces();
    const leaked = structuredClone(traces[0]);
    const identifier = leaked.probes.find((row) => row.category === "tool_identifier").score.accept[0];
    leaked.turns[0].user += ` (${identifier})`;
    expect(() => validateTrace(leaked)).toThrow("identifier_not_tool_only");
    const steerless = structuredClone(traces[0]);
    for (const turn of steerless.turns) for (const step of turn.steps) delete step.steer;
    expect(() => validateTrace(steerless)).toThrow("trace_missing_mid_turn_steer");
    const noAbstention = structuredClone(traces[0]);
    noAbstention.probes = noAbstention.probes.filter((row) => row.category !== "abstention");
    expect(() => validateTrace(noAbstention)).toThrow("trace_missing_probe_category");
    const real = structuredClone(traces[0]); real.fictional = false;
    expect(() => validateTrace(real)).toThrow("trace_not_marked_fictional");
  });

  it("keeps probes, expected answers and rubrics out of the replay projection", async () => {
    const { traces } = await loadTraces();
    const trace = structuredClone(traces[1]);
    trace.turns[0].gold = "GOLD_CANARY"; trace.turns[0].steps[0].answer = "GOLD_CANARY";
    const source = sourceOnly(trace);
    expect(JSON.stringify(source)).not.toContain("GOLD_CANARY");
    expect(JSON.stringify(source)).not.toContain("rubric");
    expect(source).not.toHaveProperty("probes");
    expect(source.turns).toHaveLength(trace.turns.length);
  });
});

describe("continuity scoring (deterministic)", () => {
  it("builds the reader prompt without evaluator data and offers UNKNOWN only when asked", () => {
    const withOption = probePrompt({ question: "What is the order number?", format: "Reply with only the order number.", abstainOption: true, score: { kind: "identifier", accept: ["SECRET-ANSWER"] } });
    expect(withOption).toContain(ABSTAIN_INSTRUCTION);
    expect(withOption).not.toContain("SECRET-ANSWER");
    expect(probePrompt({ question: "Draft a message.", abstainOption: false, score: { kind: "constraint_task", forbidden: ["x"] } })).not.toContain("UNKNOWN");
  });

  it("scores identifiers with normalisation and separates stale decoys", () => {
    const p = probe({ kind: "identifier", accept: ["BLH-58213-K"], reject: ["SWP-3390-1172"] });
    expect(scoreAnswer(p, "It was blh 58213 k.")).toMatchObject({ pass: true, outcome: "correct" });
    expect(scoreAnswer(p, "SWP-3390-1172")).toMatchObject({ pass: false, outcome: "stale" });
    expect(scoreAnswer(p, "BLH-58213-K or SWP-3390-1172")).toMatchObject({ pass: false, outcome: "conflicted" });
    expect(scoreAnswer(p, "UNKNOWN")).toMatchObject({ pass: false, outcome: "abstained", falseAbstention: true });
    expect(scoreAnswer(p, "")).toMatchObject({ pass: false, outcome: "empty" });
  });

  it("scores current versus superseded values", () => {
    const p = probe({ kind: "value", accept: ["74\\.50"], superseded: ["\\b89(?:\\.00)?\\b"] }, { category: "superseded_current" });
    expect(scoreAnswer(p, "£74.50").pass).toBe(true);
    expect(scoreAnswer(p, "£89.00").outcome).toBe("stale");
    expect(scoreAnswer(p, "£74.50 (down from £89)").outcome).toBe("conflicted");
  });

  it("takes the first status token for choice probes", () => {
    const p = probe({ kind: "choice", options: ["SENT", "DRAFTED", "NOT_STARTED"], expected: "DRAFTED" }, { category: "commitment_status" });
    expect(scoreAnswer(p, "DRAFTED — not sent yet").pass).toBe(true);
    expect(scoreAnswer(p, "Sent.").outcome).toBe("wrong");
    expect(scoreAnswer(p, "not started").selected).toBe("NOT_STARTED");
    const posted = probe({ kind: "choice", options: ["POSTED", "NOT_POSTED"], expected: "NOT_POSTED" }, { category: "commitment_status" });
    expect(scoreAnswer(posted, "Not posted yet").pass).toBe(true);
    expect(scoreAnswer(posted, "POSTED").pass).toBe(false);
  });

  it("detects constraint violations, recall, abstention and next-action proxies", () => {
    const task = probe({ kind: "constraint_task", forbidden: ["priya", "alder\\s+row"] }, { category: "active_constraint", abstainOption: false });
    expect(scoreAnswer(task, "My cousin Priya will hand it over.")).toMatchObject({ pass: false, outcome: "violation", violatedPatterns: 1 });
    expect(scoreAnswer(task, "Someone will be home to hand it over at the address on the order.").pass).toBe(true);
    const recall = probe({ kind: "constraint_recall", requireAll: [["priya", "cousin"], ["address", "live"]] }, { category: "active_constraint" });
    expect(scoreAnswer(recall, "Never mention your cousin; never state your address.").pass).toBe(true);
    expect(scoreAnswer(recall, "Never mention your cousin.").pass).toBe(false);
    const abstain = probe({ kind: "abstain" }, { category: "abstention" });
    expect(scoreAnswer(abstain, "UNKNOWN").pass).toBe(true);
    expect(scoreAnswer(abstain, "That never came up.").pass).toBe(true);
    expect(scoreAnswer(abstain, "4471").outcome).toBe("fabricated");
    expect(isAbstention("I don't have that information.")).toBe(true);
    const next = probe({ kind: "next_action", proxyAll: [["print"], ["label"], ["thursday"]], rubric: "Print the label before Thursday's collection." }, { category: "next_action" });
    expect(scoreAnswer(next, "Print the return label before Thursday.").pass).toBe(true);
    expect(scoreAnswer(next, "Send the complaint.").pass).toBe(false);
  });

  it("parses only a strict judge verdict", () => {
    expect(parseJudgeVerdict('{"verdict":"pass"}')).toBe("pass");
    expect(parseJudgeVerdict('Sure: {"verdict": "fail"}')).toBe("fail");
    expect(parseJudgeVerdict('{"verdict":"maybe"}')).toBeNull();
    expect(parseJudgeVerdict("pass")).toBeNull();
  });

  it("aggregates per-arm, per-category accuracy with deltas, repeat variance, flips, exclusions and spend", () => {
    const trial = (arm, repeat, probeId, category, pass, extra = {}) => ({ traceId: "t", arm, repeat, probeId, category, status: "completed",
      score: { pass, outcome: pass ? "correct" : "wrong", falseAbstention: false },
      usage: { calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001 }, ...extra });
    const trials = [
      trial("native", 1, "p01", "tool_identifier", true), trial("native", 2, "p01", "tool_identifier", true),
      trial("native", 1, "p02", "abstention", true), trial("native", 2, "p02", "abstention", false),
      trial("cold-rebuild", 1, "p01", "tool_identifier", false), trial("cold-rebuild", 2, "p01", "tool_identifier", true,
        { usage: { calls: 1, inputTokens: 50, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: 0, estimatedCostUsd: null } }),
      trial("cold-rebuild", 1, "p02", "abstention", false, { status: "boundary_unverified" }),
      { traceId: "t", arm: "cold-rebuild", repeat: 2, probeId: "p02", category: "abstention", status: "failed", failure: "provider_unavailable", score: null },
      trial("native", 1, "p03", "next_action", true, { judge: { verdict: "pass" } }), trial("native", 2, "p03", "next_action", false, { judge: { verdict: "pass" } }),
    ];
    const summary = summarize(trials, { arms: ["native", "cold-rebuild"], baselineArm: "native", repeats: [1, 2] });
    expect(summary.arms.native.categories.tool_identifier).toMatchObject({ n: 2, correct: 2, accuracy: 1 });
    expect(summary.arms.native.categories.abstention).toMatchObject({ accuracy: 0.5, repeatSd: 0.7071 });
    expect(summary.arms["cold-rebuild"].categories.tool_identifier.accuracy).toBe(0.5);
    expect(summary.arms["cold-rebuild"].deltaVsBaseline.categories.tool_identifier).toBe(-0.5);
    expect(summary.arms["cold-rebuild"].excluded).toEqual({ boundaryUnverified: 1, pressureUnverified: 0, storeDegraded: 0, failed: 1 });
    expect(summary.arms.native.flipRate).toBe(0.6667);
    expect(summary.arms["cold-rebuild"].usage).toMatchObject({ calls: 3, unknownCostCalls: 1, unknownTokenCalls: 1 });
    expect(summary.judge).toMatchObject({ judgedSamples: 2, agreementWithDeterministicProxy: 0.5, judgePassOnlyCount: 1 });
    const markdown = renderMarkdown(summary, { qualityMeasured: false });
    expect(markdown).toContain("NOT model quality");
    expect(markdown).toContain("next_action (proxy)");
  });
});

describe("continuity arms and plan", () => {
  it("declares production-config arms with the native baseline first and planned B arms unavailable", () => {
    expect(AVAILABLE_ARM_IDS).toEqual(["native", "cold-rebuild", "compaction-1", "compaction-2", "ceiling", "restart-switch-compact", "continuity-store", "continuity-ledger-cold", "continuity-store-compaction", "continuity-pack-cold", "continuity-pack-boundary"]);
    expect(ARMS.filter((arm) => !arm.available).map((arm) => arm.id)).toEqual(["continuity-pack-per-turn", "pack+stubs"]);
    for (const arm of ARMS) {
      expect(arm.probeConfig).toBeTypeOf("object");
      expect(arm.expect).toBeTypeOf("object");
      expect(Array.isArray(arm.pressure)).toBe(true);
      if (!arm.available) expect(arm.unavailableReason).toBe(NOT_AVAILABLE);
    }
    expect(BASELINE_ARM).toBe("native");
    expect(DEFAULT_ARMS.original).toEqual(ORIGINAL_ARM_IDS);
    expect(armById("native").probeConfig).toEqual({ runtime: { compaction: { maxInputTokens: 0 } } });
    expect(armById("ceiling").probeConfig).toEqual({});
    expect(armById("compaction-1").probeConfig).toEqual({ runtime: { compaction: SMALL_PROACTIVE_COMPACTION } });
    expect(armById("compaction-2").midCheckpoint.kind).toBe("manual-compaction");
    expect(armById("restart-switch-compact")).toMatchObject({ restart: true, replayBinding: "alternate", expect: { probeBoundary: "model_change", probeCompactions: 1 } });
    expect(checkpointKey(armById("native"), 2)).toBe("scripted-native");
    expect(checkpointKey(armById("compaction-2"), 2)).toBe("mid-compaction-2-r2");
    expect(mergePatch({ runtime: { model: "a", session: { mode: "continuous" } } }, { runtime: { compaction: { triggerRatio: 0.2 } } }))
      .toEqual({ runtime: { model: "a", session: { mode: "continuous" }, compaction: { triggerRatio: 0.2 } } });
  });

  it("verifies that the probe actually crossed the arm boundary", () => {
    const none = { boundaries: [], compactions: [] };
    expect(verifyBoundary({ boundary: null, compactions: 0 }, none).verified).toBe(true);
    expect(verifyBoundary({ boundary: "model_change", compactions: 0 }, none)).toMatchObject({ verified: false });
    expect(verifyBoundary({ boundary: "model_change", compactions: 0 }, { boundaries: [{ kind: "resume_replay", reason: "model_change", context: "reconstructed" }], compactions: [] }).verified).toBe(true);
    expect(verifyBoundary({ boundary: null, compactions: 0 }, { boundaries: [{ kind: "resume_replay", reason: "runtime_result" }], compactions: [] }).reasons[0]).toContain("unexpected_resume_replay");
    expect(verifyBoundary({ boundary: null, compactions: 1 }, { boundaries: [], compactions: [{ status: "succeeded" }] }).verified).toBe(true);
    expect(verifyBoundary({ boundary: null, compactions: 1 }, { boundaries: [], compactions: [{ status: "failed" }] }).verified).toBe(false);
    expect(verifyBoundary({ boundary: null, compactions: 0, restart: true }, none).reasons).toContain("expected_process_restart");
  });

  it("pins retained conversation evidence off for every pre-B1 arm and on for the B arms", () => {
    const bArms = new Set(["continuity-ledger-cold", "continuity-store", "continuity-store-compaction", "continuity-pack-cold", "continuity-pack-boundary", "continuity-pack-per-turn", "pack+stubs"]);
    for (const arm of ARMS) {
      const enabled = arm.sessionConfig?.runtime?.session?.continuity?.enabled;
      expect(enabled, arm.id).toBe(!bArms.has(arm.id) ? false : true);
      // A runnable arm's probe patch never overrides the session pin.
      if (arm.available && !arm.ledgerUpkeep) expect(arm.probeConfig.runtime?.session, arm.id).toBeUndefined();
      if (arm.ledgerUpkeep) expect(arm.probeConfig.runtime.session.continuity).toEqual({ ledgerEnabled: true, upkeep: { enabled: false } });
    }
    expect(CONTINUITY_OFF).toEqual({ runtime: { session: { continuity: { enabled: false } } } });
    const store = armById("continuity-store");
    expect(store).toMatchObject({ available: true, replayBinding: "alternate", fork: "in-place", expect: { probeBoundary: "model_change", probeCompactions: 0 } });
    expect(store.probeConfig).toEqual({ tools: { allowedTools: ["ConversationHistory"] } });
    expect(CONTINUITY_ON.runtime.session.continuity).toEqual({ enabled: true, packEnabled: false });
    for (const id of ["continuity-pack-cold", "continuity-pack-boundary", "continuity-pack-per-turn"]) {
      const pack = armById(id);
      expect(pack.sessionConfig).toEqual(CONTINUITY_PACK_ON);
      expect(pack.sessionConfig.runtime.session.continuity).toEqual({ enabled: true, packEnabled: true });
      expect(pack).toMatchObject({ replayBinding: "alternate", expect: { probeBoundary: "model_change", probeCompactions: 0 } });
    }
    expect(armById("continuity-store-compaction").probeConfig).toEqual({ tools: { allowedTools: ["ConversationHistory"] }, runtime: { compaction: SMALL_PROACTIVE_COMPACTION } });
  });

  it("requires actual cold pack receipts without turning expected overflow into a missing treatment", () => {
    const arm = armById("continuity-pack-cold"), checkpointContinuity = { records: 10, degraded: false };
    const observed = { toolsOffered: ["ConversationHistory"], historyWarnings: 0, continuityPacks: [] };
    expect(verifyStore(arm, { checkpointContinuity, observed }).reasons).toContain("continuity_pack_not_injected");
    observed.continuityPacks.push({ reason: "model_change", tokens: 8000, ownerEntries: 3, toolEntries: 2, summaryEntries: 0, evidenceEntries: 0, degradedReason: "overflow" });
    expect(verifyStore(arm, { checkpointContinuity, observed }).healthy).toBe(true);
    observed.continuityPacks[0].degradedReason = "purge_pending";
    expect(verifyStore(arm, { checkpointContinuity, observed }).healthy).toBe(false);
  });

  it("treats a degraded store as an invalid trial and classifies ConversationHistory results", () => {
    const store = armById("continuity-store");
    const healthy = { toolsOffered: ["ConversationHistory"], historyWarnings: 0, conversationHistory: { unavailable: 0 } };
    expect(verifyStore(store, { checkpointContinuity: { records: 10, degraded: false }, observed: healthy }).healthy).toBe(true);
    expect(verifyStore(store, { checkpointContinuity: { records: 0, degraded: false }, observed: healthy }).reasons).toContain("no_retained_records");
    expect(verifyStore(store, { checkpointContinuity: { records: 5, degraded: true }, observed: healthy }).reasons).toContain("checkpoint_store_degraded");
    expect(verifyStore(store, { checkpointContinuity: { records: 5, degraded: false }, observed: { ...healthy, historyWarnings: 2 } }).reasons).toContain("tool_history_warnings:2");
    expect(verifyStore(store, { checkpointContinuity: { records: 5, degraded: false }, observed: { ...healthy, toolsOffered: [] } }).reasons).toContain("conversation_history_not_offered");
    expect(verifyStore(store, { checkpointContinuity: { records: 5, degraded: false }, observed: { ...healthy, conversationHistory: { unavailable: 1 } } }).healthy).toBe(false);
    expect(verifyStore(armById("cold-rebuild"), { checkpointContinuity: null, observed: {} })).toEqual({ applicable: false, healthy: true, reasons: [] });
    expect(classifyHistoryResult('{"action":"search","status":"available","available":true,"count":3}', false)).toEqual({ outcome: "success", count: 3 });
    expect(classifyHistoryResult('{"action":"search","status":"unavailable","available":false,"count":0}', false).outcome).toBe("unavailable");
    expect(classifyHistoryResult('{"status":"unavailable","error":{"code":"history_unavailable"}}', true).outcome).toBe("unavailable");
    expect(classifyHistoryResult('{"status":"unavailable","error":{"code":"invalid_query"}}', true).outcome).toBe("error");
    expect(verifyBoundary({ boundary: null, compactions: 1 }, { boundaries: [], compactions: [{ status: "succeeded" }, { status: "succeeded", midRun: true }] }).verified).toBe(true);
  });

  it("verifies per-sample pressure on long traces only", () => {
    const observed = { boundaries: [{ kind: "resume_replay", reason: "model_change", replayedMessageCount: 64, toolProjectionRecords: 9 }], compactions: [{ status: "succeeded", tokensBefore: 221_000 }] };
    const metrics = pressureMetrics(observed, { usage: { inputTokens: 1000, cacheReadTokens: 181_000, cacheWriteTokens: 0 }, traceToolRecords: 70, mid: { tokensBefore: 120_000 } });
    expect(metrics).toEqual({ probeInputTokens: 182_000, compactionTokensBefore: 221_000, midCompactionTokensBefore: 120_000, replayedMessages: 64, projectionDroppedRecords: 61 });
    expect(verifyPressure(armById("ceiling"), "long", metrics).verified).toBe(true);
    expect(verifyPressure(armById("ceiling"), "long", { ...metrics, compactionTokensBefore: 150_000 }).reasons[0]).toContain("pressure_below_threshold:compactionTokensBefore");
    expect(verifyPressure(armById("native"), "long", { ...metrics, probeInputTokens: null }).reasons[0]).toContain("pressure_unobserved");
    expect(verifyPressure(armById("native"), "original", { probeInputTokens: 10 })).toEqual({ applicable: false, verified: true, reasons: [] });
  });

  it("binds the workload into one digest and computes the pilot workload", async () => {
    const { traces, sha256 } = await loadTraces();
    const pilot = makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 2 });
    expect(pilot.confirmation).toMatch(/^[0-9a-f]{64}$/u);
    expect(makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 2 }).confirmation).toBe(pilot.confirmation);
    expect(makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 1 }).confirmation).not.toBe(pilot.confirmation);
    expect(makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 2, profile: { reader: "openai-codex:gpt-6-sol" } }).confirmation).not.toBe(pilot.confirmation);
    const probes = inventory(traces).probes;
    expect(pilot.workload).toEqual({ probeTurns: probes * 4 * 2, midCheckpointCompactions: 4 * 2, liveTurns: probes * 8,
      expectedCompactions: 2 * (probes * 2 + 4), judgeCalls: 4 * 4 * 2 });
    expect(pilot.arms.map((arm) => arm.id)).toEqual(ORIGINAL_ARM_IDS);
    expect(() => makePlan({ traces, sha256, arms: ["native", "continuity-pack-per-turn"] })).toThrow("arm_not_available_at_revision:continuity-pack-per-turn");
    expect(() => makePlan({ traces, sha256, arms: ["native", "pack+stubs"] })).toThrow("arm_not_available_at_revision:pack+stubs");
    expect(() => makePlan({ traces, sha256, arms: ["native", "ceiling"] })).toThrow("arm_not_applicable_to_family:ceiling:original");
    const estimate = estimateCost(pilot, traces, { "openai-codex:gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 }, "openai-codex:gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1 } });
    expect(estimate.status).toBe("estimated");
    expect(estimate.upperUsd).toBeGreaterThanOrEqual(estimate.expectedUsd);
    expect(estimateCost(pilot, traces, {}).status).toBe("unknown_price");
    const paired = makePlan({ traces, sha256, arms: ["native", "cold-rebuild", "continuity-store", "continuity-pack-cold", "continuity-pack-boundary"] });
    const pairedEstimate = estimateCost(paired, traces, { [paired.reader.model]: { input: 0.1, output: 0.5, cacheRead: 0.01 } });
    expect(pairedEstimate.arms["continuity-pack-cold"].inputTokens - pairedEstimate.arms["continuity-store"].inputTokens).toBe(probes * 3 * 8000);
    expect(pairedEstimate.arms["continuity-pack-boundary"]).toEqual(pairedEstimate.arms["continuity-pack-cold"]);
    expect(pilot.reader).toEqual({ model: "openai-codex:gpt-6-luna", effort: "low" });
    expect(pilot.judge).toMatchObject({ model: "openai-codex:gpt-6.1-sol", scope: "next_action" });
    expect(() => makePlan({ traces, sha256, arms: ["cold-rebuild"] })).toThrow("baseline_arm_required");
    expect(() => makePlan({ traces, sha256, profile: { alternate: "openai-codex:gpt-6-luna" } })).toThrow("alternate_must_differ_from_reader");
  });

  it("keys fixture tool calls by canonical arguments", () => {
    expect(callKey("mail_read", { b: 1, a: { d: 2, c: 3 } })).toBe(callKey("mail_read", { a: { c: 3, d: 2 }, b: 1 }));
    expect(callKey("mail_read", { a: 1 })).not.toBe(callKey("mail_search", { a: 1 }));
  });
});

describe("continuity CLI guards", () => {
  it("aggregate-only never loads execution, whereas strict cap executes with its plan flag", async () => {
    const aggregate = await scratch(); let calls = 0;
    const modulesLoader = async () => { calls++; throw new Error("execution_reached"); };
    await main(["--aggregate-only", "--output", aggregate], { env: {}, stdout: () => {}, modulesLoader });
    expect(calls).toBe(0);
    const strict = await scratch();
    await expect(main(["--require-request-cap", "--output", strict], { env: {}, stdout: () => {}, modulesLoader })).rejects.toThrow("execution_reached");
    expect(calls).toBe(1); expect(JSON.parse(await readFile(join(strict, "plan.json"), "utf8")).upkeep.requireRequestCap).toBe(true);
  });

  it("parses flags strictly", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("invalid_arguments");
    expect(() => parseArguments(["--repeats"])).toThrow("missing_argument");
    expect(() => parseArguments(["--dry-run", "--real"])).toThrow("dry_run_and_real_are_exclusive");
    expect(parseArguments(["--trace", "a", "--trace", "b"]).trace).toEqual(["a", "b"]);
    expect(parseSeeds("101-103,110")).toEqual([101, 102, 103, 110]);
    expect(() => parseSeeds("101,101")).toThrow("invalid_seeds");
  });

  it("prints a provider-free dry-run plan without a build", () => {
    const child = spawnSync(process.execPath, [join(root, "scripts/continuity-benchmark.mjs"), "--dry-run", "--repeats", "2"], { cwd: root, encoding: "utf8", timeout: 15000 });
    expect(child.status).toBe(0);
    const plan = JSON.parse(child.stdout);
    expect(plan.confirmation).toMatch(/^[0-9a-f]{64}$/u);
    expect(plan.inventory.traces).toHaveLength(4);
    expect(plan.repeats).toBe(2);
  });

  it("refuses paid mode whenever CI is set, even when empty, and without a confirmed plan", async () => {
    await expect(main(["--real"], { env: { CI: "" }, stdout: () => {} })).rejects.toThrow("paid_mode_refused_in_ci");
    await expect(main(["--real"], { env: {}, stdout: () => {} })).rejects.toThrow("real_mode_requires_confirmed_plan");
    const dir = await scratch();
    const auth = join(dir, "auth.json");
    await writeFile(auth, "{}", { mode: 0o600 });
    await expect(main(["--pi-auth-path", auth], { env: {}, stdout: () => {} })).rejects.toThrow("credentials_require_real_mode");
    await expect(main(["--real", "--pi-auth-path", "relative/auth.json"], { env: {}, stdout: () => {} })).rejects.toThrow("invalid_pi_auth_path");
  });
});

describe("continuity offline contract run (production harness, scripted providers; not model quality)", () => {
  it("replays one trace through every arm and verifies each boundary", async () => {
    const output = await scratch();
    const lines = [];
    const arms = [...ORIGINAL_ARM_IDS, "restart-switch-compact", "continuity-store", "continuity-pack-cold", "continuity-ledger-cold"];
    const code = await main(["--trace", "brightline-return", "--probe-limit", "1", "--concurrency", "5", "--arms", arms.join(","), "--output", output], { env: {}, stdout: (line) => lines.push(line) });
    expect(code).toBe(1); // 8 of 32 units: the other traces were not selected.
    expect((await readdir(output)).includes("upkeep-output")).toBe(false);
  const results = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
    expect(results).toMatchObject({ executionKind: "offline", qualityMeasured: false, coverage: { unitsComplete: 8, unitsExpected: 32 } });
    const units = Object.fromEntries(await Promise.all((await readdir(join(output, "units"))).map(async (name) => {
      const unit = JSON.parse(await readFile(join(output, "units", name), "utf8"));
      return [unit.arm, unit];
    })));
    for (const arm of arms) {
      const unit = units[arm];
      expect(unit.complete).toBe(true);
      expect(unit.checkpoint).toMatchObject({ turns: 38, toolCalls: 29, steers: 1 });
      expect(unit.trials).toHaveLength(1);
      expect(unit.trials[0]).toMatchObject({ status: "completed", answer: "Scripted contract response; semantic correctness is not evaluated." });
      expect(unit.trials[0].boundary.verified).toBe(true);
    }
    expect(units.native.trials[0].boundary.observed).toMatchObject({ boundaries: [], compactions: [] });
    const reseed = units["cold-rebuild"].trials[0].boundary.observed.boundaries[0];
    expect(reseed).toMatchObject({ kind: "resume_replay", reason: "model_change", context: "reconstructed", replayedMessageCount: 64 });
    expect(reseed.toolProjectionRecords).toBeGreaterThan(0);
    expect(units["compaction-1"].trials[0].boundary.observed.compactions).toEqual([expect.objectContaining({ status: "succeeded", trigger: "proactive" })]);
    expect(units["compaction-2"].checkpoint.mid).toMatchObject({ turnId: "t25", kind: "manual-compaction", status: "succeeded", boundary: { verified: true } });
    expect(units["compaction-2"].trials[0].boundary.observed.compactions).toHaveLength(1);
    const restart = units["restart-switch-compact"].trials[0].boundary.observed;
    expect(restart.restart.processRestart).toBe(true);
    expect(restart.boundaries[0]).toMatchObject({ reason: "model_change" });
    expect(restart.compactions).toEqual([expect.objectContaining({ status: "succeeded" })]);
    // B1 store arm: healthy in-place fork, retained records, ConversationHistory offered and used.
    const store = units["continuity-store"];
    expect(store.checkpoint.continuity).toMatchObject({ degraded: false, replayHistoryWarnings: 0 });
    expect(store.checkpoint.continuity.records).toBeGreaterThan(0);
    const storeTrial = store.trials[0];
    expect(storeTrial.store).toEqual({ applicable: true, healthy: true, reasons: [] });
    expect(storeTrial.boundary.observed).toMatchObject({ toolsOffered: ["ConversationHistory"], historyWarnings: 0,
      conversationHistory: { calls: 1, search: 1, success: 1, unavailable: 0, error: 0 } });
    expect(storeTrial.boundary.observed.boundaries[0]).toMatchObject({ kind: "resume_replay", reason: "model_change" });
    expect(units["cold-rebuild"].trials[0].boundary.observed.toolsOffered).toEqual([]);
    expect(results.summary.arms["continuity-store"].toolUse).toMatchObject({ offered: 1, used: 1, rate: 1 });
    const packed = units["continuity-pack-cold"].trials[0];
    expect(packed.store).toEqual({ applicable: true, healthy: true, reasons: [] });
    expect(packed.boundary.observed.continuityPacks).toEqual([expect.objectContaining({ reason: "model_change" })]);
    const receipt = packed.boundary.observed.continuityPacks[0];
    expect(receipt.ownerEntries).toBeGreaterThan(0); expect(receipt.toolEntries).toBeGreaterThan(0);
    expect(receipt.ownerDeduped).toBeGreaterThanOrEqual(0); expect(receipt.toolReserved).toBeGreaterThan(0);
    expect(receipt.tokens).toBeGreaterThan(0); expect(receipt.tokens).toBeLessThanOrEqual(8000);
    expect(packed.boundary.observed.offlineProviderPackCounts).toEqual([1, 1]);
    expect(storeTrial.boundary.observed.continuityPacks).toEqual([]);
    expect(storeTrial.boundary.observed.offlineProviderPackCounts).toEqual([0, 0]);
    expect(units["cold-rebuild"].trials[0].boundary.observed.offlineProviderPackCounts).toEqual([0]);
    const ledger = units["continuity-ledger-cold"];
    expect(ledger.checkpoint.upkeep).toMatchObject({ valid: true, receipt: { status: "valid", providerInvoked: true, capEnforcement: "stream_abort" }, usage: { calls: 1 } });
    expect(ledger.checkpoint.upkeep.receipt.uncovered).toBeGreaterThan(0);
    expect(ledger.trials[0].boundary.observed.offlineLedgerCounts).toEqual([1, 1]);
    expect(ledger.trials[0].boundary.observed.upkeep.some(row => row.providerInvoked)).toBe(false);
    expect(results.upkeep).toHaveLength(1);
    expect(results.summary.arms["continuity-ledger-cold"].usage.calls).toBe(2); // one upkeep plus one probe, not upkeep per tool call.
    expect(await readFile(join(output, "summary.md"), "utf8")).toContain("NOT model quality");
    expect(await readdir(output)).not.toContain("work");
  }, 180_000);

  it("runs the offline judge through the production Pi host runtime", async () => {
    const { productionModules, createJudge } = await import("../lib/continuity-runner.mjs");
    const { traces, sha256 } = await loadTraces();
    const plan = makePlan({ traces, sha256 });
    const workspace = await scratch();
    const judge = createJudge({ modules: await productionModules(root.replace(/\/$/u, "")), plan, mode: "offline", workspace });
    const next = traces[0].probes.find((row) => row.category === "next_action");
    try {
      expect(await judge.judge(next, "Print the label before Thursday.")).toMatchObject({ verdict: "fail", kind: "scripted", model: "openai-codex:gpt-6.1-sol" });
    } finally { await judge.close(); }
  }, 60_000);
});

describe("continuity trace generator (deterministic, provider-free)", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const first = mulberry32(7); const second = mulberry32(7);
    expect(Array.from({ length: 5 }, first)).toEqual(Array.from({ length: 5 }, second));
    expect(JSON.stringify(generateTrace(103))).toBe(JSON.stringify(generateTrace(103)));
    expect(generateTrace(103).turns[1].steps[0].call.result).not.toBe(generateTrace(111).turns[1].steps[0].call.result);
    expect(() => generateTrace(0)).toThrow("invalid_seed");
  });

  it("generates the default hard suite within the long-trace bounds with out-of-bounds identifiers", async () => {
    const { traces, sha256, source } = await loadTraces({ suite: "hard" });
    expect(source).toMatchObject({ kind: "generated", generator: GENERATOR_VERSION, seeds: [...HARD_SEEDS] });
    expect(traces).toHaveLength(8);
    expect((await loadTraces({ suite: "hard" })).sha256).toBe(sha256);
    for (const trace of traces) {
      const shape = traceShape(trace);
      expect(trace).toMatchObject({ fictional: true, family: "long" });
      expect(shape.turns).toBeGreaterThanOrEqual(LONG_RULES.minTurns);
      expect(shape.turns).toBeLessThanOrEqual(LONG_RULES.maxTurns);
      expect(shape.toolCalls).toBeGreaterThanOrEqual(LONG_RULES.minToolCalls);
      expect(shape.toolCalls).toBeLessThanOrEqual(LONG_RULES.maxToolCalls);
      expect(shape.minResultBytes).toBeGreaterThanOrEqual(LONG_RULES.minResultBytes);
      expect(shape.maxResultBytes).toBeLessThanOrEqual(LONG_RULES.maxResultBytes);
      expect(shape.maxResultBytes).toBeGreaterThan(COLD_BOUNDS.recordResultBytes);
      expect(shape.messages).toBeGreaterThan(COLD_BOUNDS.canonicalMessages * 2);
      expect(trace.turns.reduce((sum, turn) => sum + turn.steps.filter((step) => step.steer).length, 0)).toBeGreaterThanOrEqual(2);
      const early = trace.probes.find((probe) => probe.pressure === "outside_window_and_projection");
      expect(outsideColdBounds(trace, early.sourceTurn)).toBe(true);
      expect(trace.probes.map((probe) => probe.category)).toContain("redaction");
      expect(trace.probes).toHaveLength(15);
    }
    expect(new Set(traces.map((trace) => trace.generated.scenario)).size).toBe(8);
  });

  it("scales to the E2 floor of 24 traces and scores the redaction case", async () => {
    const { traces } = await loadTraces({ suite: "hard", seeds: parseSeeds("101-124") });
    expect(traces).toHaveLength(24);
    expect(new Set(traces.map((trace) => trace.id)).size).toBe(24);
    const redaction = traces[0].probes.find((probe) => probe.category === "redaction");
    const secret = redaction.score.secret;
    expect(scoreAnswer(redaction, `Here you go: ${secret}`)).toMatchObject({ pass: false, outcome: "leaked" });
    expect(scoreAnswer(redaction, `It starts ${secret.slice(0, 9)}`).pass).toBe(false);
    expect(scoreAnswer(redaction, "The sign-in details are in the onboarding email; I won't paste the password here.")).toMatchObject({ pass: true, outcome: "correct" });
  });
});


describe("continuity lease isolation and runtime disposal", () => {
  it.each(["success", "startup-failure", "run-failure", "dispose-failure"])("keeps leases isolated and closes both owners after %s", async (scenario) => {
    const { runLiveTurn } = await import("../lib/continuity-runner.mjs");
    const coordinator = await import("../../packages/app/dist/durable-state/agent-root-coordinator.js");
    const dir = await scratch(), work = join(dir, "work");
    const { mkdir, lstat } = await import("node:fs/promises");
    await mkdir(work);
    const leasePath = coordinator.agentRootLeasePath(work, join(dir, "lease-home"));
    const disposeRuntime = vi.fn(async () => {});
    const disposeHarness = vi.fn(async () => { if (scenario === "dispose-failure") throw new Error("fixture-dispose"); });
    const modules = {
      coordinator,
      host: { parseMonoRuntimeModelReference: () => ({ provider: "fictional", model: "stub" }) },
      config: { resolveJsonMonoAgentConfig: ({ json }) => json },
      app: {
        createConfiguredAgentRuntime: () => ({ disposeAllSessions: disposeRuntime }),
        async createConfiguredConversationHarness() {
          // Fail before any provider work if pre-acquisition used the wrong home.
          expect((await lstat(leasePath)).isDirectory()).toBe(true);
          if (scenario === "startup-failure") throw new Error("fixture-startup");
          return { dispose: disposeHarness, async run() {
            if (scenario === "run-failure") throw new Error("fixture-run");
            return { text: "Fictional reply", metadata: {} };
          } };
        },
      },
    };
    const turn = runLiveTurn({ modules, work, plan: { reader: { model: "fictional:stub" }, limits: { perLiveTurnTimeoutMs: 1000 } },
      mode: "test", clock: { value: new Date("2026-01-01T00:00:00Z") }, conversationId: "fictional", owner: "Morgan", userMessage: "Hello" });
    if (scenario === "success") await expect(turn).resolves.toMatchObject({ text: "Fictional reply" });
    else await expect(turn).rejects.toThrow("fixture-");
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(disposeHarness).toHaveBeenCalledTimes(scenario === "startup-failure" ? 0 : 1);
    // The agent-root mutation gate is a permanent coordination file; only
    // leases and detached lease artifacts must be gone.
    expect((await readdir(join(dir, "lease-home/.mono-agent/agent-root-leases")))
      .filter((name) => name !== ".mutation-gate.sqlite")).toEqual([]);
  });
});

it("keeps distractor actual facts and byte pressure identical while pricing one explicit upkeep per trace/repeat", async () => {
  const base = await loadTraces({ suite: "hard", seeds: [101] });
  const harder = await loadTraces({ suite: "hard-distractors", seeds: [101] });
  expect(harder.traces[0].probes).toEqual(base.traces[0].probes);
  expect(traceShape(harder.traces[0])).toEqual(traceShape(base.traces[0]));
  expect(JSON.stringify(harder.traces[0].turns)).toContain("DECOY-");
  const plan = makePlan({ ...harder, repeats: 2, profile: { extractionModel: "openai:gpt-4o-mini" } });
  expect(plan.workload.upkeepCalls).toBe(2);
  expect(checkpointKey(armById("continuity-ledger-cold"), 1)).not.toBe(checkpointKey(armById("continuity-ledger-cold"), 2));
  expect(plan.upkeep).toMatchObject({ model: "openai:gpt-4o-mini", maxOutputTokens: 4096 });
  const price = { input: 1, output: 2, cacheRead: 0.1 };
  const cost = estimateCost(plan, harder.traces, { [plan.reader.model]: price, [plan.upkeep.model]: price, [plan.judge.model]: price });
  expect(cost.arms["continuity-ledger-cold"]).toMatchObject({ upkeepCalls: 2, upkeepBudgetUsd: 0.1444 });
});

it.each(["harness", "ledger", "skip"])("retains upkeep receipt/accounting after %s preparation", async point => {
  const { prepareLedgerCheckpoint } = await import("../lib/continuity-runner.mjs");
  const work = await scratch();
  const receipt = { type: "continuity_upkeep", providerInvoked: point !== "skip", status: "invalid", costUsd: null, inputTokens: null, outputTokens: null, estimatedInputCostUsd: 0.02, estimatedInputTokens: 15000 };
  const modules = {
    config: { resolveJsonMonoAgentConfig: () => ({ runtime: { model: {} } }) },
    coordinator: { acquireAgentRootOwnership: async () => ({}), releaseAgentRootOwnershipWhenIdle: async () => {} },
    app: { createConfiguredAgentRuntime: () => ({}), createConfiguredConversationHarness: async () => ({ run: async ({ onEvent }) => { onEvent(receipt); if (point === "harness") throw new Error("fictional"); return {}; } }) },
    conversation: { ToolHistoryReader: class { ledger() { throw new Error("fictional"); } } },
  };
  const result = await prepareLedgerCheckpoint({ modules, work, mode: "real", reader: { reference: "openai-codex:gpt-6-luna" }, alternate: { reference: "openai:gpt-4o-mini" }, scripted: { respondWith() {} }, clock: {}, plan: { upkeep: { model: "openai-codex:gpt-6-luna" }, limits: { perLiveTurnTimeoutMs: 10000 } } });
  expect(result.receipt).toEqual(receipt); expect(result.valid).toBe(false);
  expect(result.usage).toMatchObject(point === "skip" ? { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } : { calls: 1, estimatedInputTokens: 15000, estimatedCostUsd: 0.02, estimatedPaidCalls: 1, estimatedPaidInputCostUsd: 0.02 });
});

it("zero-call and estimated-paid upkeep accounting do not inflate unknown cost counters", () => {
  const usage = emptyUsage(); addUsage(usage, { calls: 0 });
  expect(usage).toMatchObject({ unknownCostCalls: 0, unknownTokenCalls: 0 });
  addUsage(usage, { calls: 1, inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.02, estimatedPaidCalls: 1, estimatedPaidInputCostUsd: 0.02 });
  expect(usage).toMatchObject({ calls: 1, estimatedPaidCalls: 1, estimatedPaidInputCostUsd: 0.02, estimatedCostUsd: 0.02, unknownCostCalls: 0, unknownTokenCalls: 1 });
});

it("accounts inclusive estimated paid input for admission when reported input is absent", () => {
  expect(observedInputTokens({ inputTokens: null, estimatedInputTokens: 15000, cacheReadTokens: 2000 })).toBe(15000);
  expect(observedInputTokens({ inputTokens: 100, estimatedInputTokens: 15000, cacheReadTokens: 2000 })).toBe(2100);
  expect(observedInputTokens({ inputTokens: null, cacheReadTokens: 2000 })).toBe(2000);
});
it("keeps paid upkeep in failed checkpoints, aggregate usage and observed input", async () => {
  const { productionModules } = await import("../lib/continuity-runner.mjs");
  const real = await productionModules(root.replace(/\/$/u, ""));
  const modules = { ...real, conversation: { ...real.conversation, ToolHistoryReader: class extends real.conversation.ToolHistoryReader { stats() { throw new Error("fictional post-upkeep statistics failure"); } } } };
  const output = await scratch();
  await main(["--trace", "brightline-return", "--probe-limit", "1", "--arms", "native,continuity-ledger-cold", "--output", output], { env: {}, stdout: () => {}, modulesLoader: async () => modules });
  const results = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
  expect(results.upkeep).toHaveLength(1); expect(results.upkeep[0]).toMatchObject({ receipt: { providerInvoked: true }, usage: { calls: 1 } });
  expect(results.summary.arms["continuity-ledger-cold"].usage.calls).toBe(1);
  const unit = JSON.parse(await readFile(join(output, "units", "r1-brightline-return-continuity-ledger-cold.json"), "utf8"));
  expect(unit.checkpoint.error).toBe("checkpoint_failed"); expect(unit.checkpoint.upkeep.receipt.providerInvoked).toBe(true);
  const baseline = JSON.parse(await readFile(join(output, "units", "r1-brightline-return-native.json"), "utf8"));
  expect(unit.manifest.observedInput).toBe(observedInputTokens(unit.checkpoint.upkeep.usage) + baseline.trials.reduce((n, trial) => n + observedInputTokens(trial.usage), 0));
}, 180_000);

it("tees only completion output without changing the model stream", async () => {
  const { captureUpkeepModels } = await import("../lib/continuity-runner.mjs");
  const message = { content: [{ type: "text", text: "fictional JSON" }] }, capture = vi.fn();
  const model = {}, stream = { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, async result() { return message; } };
  const models = { getModel: () => model, streamSimple: vi.fn(() => stream) }, wrapped = captureUpkeepModels(models, capture);
  expect(wrapped.getModel()).toBe(model); const result = wrapped.streamSimple(model, {}, { maxTokens: 4096 });
  for await (const event of result) expect(event.message).toBe(message);
  expect(await result.result()).toBe(message); expect(capture).toHaveBeenCalledWith("fictional JSON");
  expect(models.streamSimple).toHaveBeenCalledWith(model, {}, { maxTokens: 4096 });
});
it("requires an external output path for opt-in capture", async () => {
  await expect(main(["--capture-upkeep-output"], { env: {}, stdout: () => {} })).rejects.toThrow("capture_requires_external_output");
  await expect(main(["--capture-upkeep-output", "--output", join(root, "..capture")], { env: {}, stdout: () => {} })).rejects.toThrow("capture_requires_external_output");
});
it("captures fictional completion and stable validation failure only when explicitly enabled", async () => {
  const { productionModules } = await import("../lib/continuity-runner.mjs");
  const real = await productionModules(root.replace(/\/$/u, ""));
  const modules = { ...real, pi: { ...real.pi, fauxAssistantMessage(text, options) {
    if (typeof text === "string" && text.includes("Offline scripted ledger;")) text = JSON.stringify({ ...JSON.parse(text), forbidden: true });
    return real.pi.fauxAssistantMessage(text, options);
  } } };
  const output = await scratch();
  await main(["--trace", "brightline-return", "--probe-limit", "1", "--arms", "native,continuity-ledger-cold", "--output", output, "--capture-upkeep-output"], { env: {}, stdout: () => {}, modulesLoader: async () => modules });
  const captured = JSON.parse(await readFile(join(output, "upkeep-output", "r1-brightline-return.json"), "utf8"));
  expect(captured).toMatchObject({ failure: "output_schema", status: "invalid" }); expect(JSON.parse(captured.text)).toMatchObject({ forbidden: true });
}, 180_000);
