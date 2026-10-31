import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, AVAILABLE_ARM_IDS, BASELINE_ARM, CONTINUITY_OFF, CONTINUITY_ON, CONTINUITY_PACK_ON, DEFAULT_ARMS, NOT_AVAILABLE, ORIGINAL_ARM_IDS, SMALL_PROACTIVE_COMPACTION, armById, checkpointKey, mergePatch, pressureMetrics, verifyBoundary, verifyPressure, verifyStore } from "../lib/continuity-arms.mjs";
import { classifyHistoryResult, boundedOfferHistory, preparationDisposition, preparationInputReserve, preparationIntegrity, preparationUsage, sumPreparationUsage, liveResponseUsage, verifyLedgerTreatment } from "../lib/continuity-runner.mjs";
import { digest, estimateCost, inventory, loadTraces, makePlan, parseSeeds, sourceOnly, validateTrace } from "../lib/continuity-dataset.mjs";
import { COLD_BOUNDS, GENERATOR_VERSION, HARD_SEEDS, LONG_RULES, generateTrace, mulberry32, outsideColdBounds, traceShape } from "../lib/continuity-generator.mjs";
import { ABSTAIN_INSTRUCTION, ORIGINAL_CATEGORIES, emptyUsage, addUsage, isAbstention, parseJudgeVerdict, probePrompt, renderMarkdown, scoreAnswer, summarize } from "../lib/continuity-score.mjs";
import { callKey } from "../lib/continuity-tools.mjs";
import { main, parseArguments, observedInputTokens } from "../continuity-benchmark.mjs";

import { fictionalTransitionRecords, replayLedgerSelection, selectionReplayRecords, selectionReplaySummary } from "../lib/continuity-selection-replay.mjs";

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
      expect(unit.trials[0], JSON.stringify({ arm, trial: unit.trials[0], upkeepValid: unit.checkpoint.upkeep?.valid })).toMatchObject({ status: "completed", answer: "Scripted contract response; semantic correctness is not evaluated." });
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
    expect(ledger.checkpoint.upkeep).toMatchObject({ valid: true, receipt: { status: "valid", providerInvoked: true, capEnforcement: "stream_abort" }, usage: { calls: 3 } });
    expect(ledger.checkpoint.upkeep.receipt.uncovered).toBeGreaterThan(0);
    const steps = ledger.checkpoint.upkeep.preparations;
    expect(new Set(steps.map(step => step.pid)).size).toBe(3);
    expect(steps.map(step => step.journal.operations)).toEqual([1, 2, 3]);
    expect(steps.map(step => step.journal.bootstrap)).toEqual([1, 1, 1]);
    const offered = steps.flatMap(step => step.journal.selection);
    expect(offered.every(key => offered.filter(other => other === key).length <= 2)).toBe(true);
    expect(steps.map(step => step.entriesAfter)).toEqual([1, 1, 2]);
    expect(steps.every(step => step.preserved && step.boundary.verified)).toBe(true);
    expect(new Set(steps.map(step => step.journal.operationId)).size).toBe(3);
    expect(new Set(steps.map(step => step.journal.databaseId)).size).toBe(1);
    expect(steps.map(step => step.journal.budget)).toEqual(["bootstrap", "incremental", "incremental"]);
    for (const step of steps) {
      expect(step.observed.upkeepScans).toEqual([expect.objectContaining({ complete: true, limits: { rows: 4096, bytes: 33554432, windows: 65536, ms: 5000 } })]);
      expect(step.observed.upkeepSelections).toEqual([expect.objectContaining({ reason: "fitted", deltaCap: 8 })]);
      expect(step.journal.offered.length).toBeGreaterThan(0); expect(step.journal.offered.length).toBeLessThanOrEqual(64);
      expect(step.journal.offerCounts.every(row => row.offer_count <= 2)).toBe(true);
      expect(step.journal.compact.identities).toBe(0);
      expect(JSON.parse(step.journal.frontier).ordinal).toBeGreaterThan(0);
    }
    expect(ledger.trials[0].boundary.observed.upkeep).toEqual([expect.objectContaining({ providerInvoked: false, reason: "read_only" })]);
    expect(ledger.trials[0].boundary.observed.offlineLedgerCounts).toEqual([1, 1]);
    expect(ledger.trials[0].boundary.observed.continuityPacks.some(pack => pack.ledgerEntries === 2)).toBe(true);
    expect(ledger.trials[0].boundary.observed.upkeep.some(row => row.providerInvoked)).toBe(false);
    expect(results.preparationHealth["continuity-ledger-cold"]).toMatchObject({ d6InputOverruns: 0, d6OutputOverruns: 0 });
  expect(results.upkeep).toHaveLength(1);
    expect(results.summary.arms["continuity-ledger-cold"].usage.calls).toBe(4); // three extractions plus one probe, counted once.
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

it("keeps distractor actual facts and byte pressure identical while pricing all three progressive extractions per trace/repeat", async () => {
  const base = await loadTraces({ suite: "hard", seeds: [101] });
  const harder = await loadTraces({ suite: "hard-distractors", seeds: [101] });
  expect(harder.traces[0].probes).toEqual(base.traces[0].probes);
  expect(traceShape(harder.traces[0])).toEqual(traceShape(base.traces[0]));
  expect(JSON.stringify(harder.traces[0].turns)).toContain("DECOY-");
  const plan = makePlan({ ...harder, repeats: 2, profile: { extractionModel: "openai:gpt-4o-mini" } });
  expect(plan.workload.upkeepCalls).toBe(6);
  expect(checkpointKey(armById("continuity-ledger-cold"), 1)).not.toBe(checkpointKey(armById("continuity-ledger-cold"), 2));
  expect(plan.upkeep).toMatchObject({ model: "openai:gpt-4o-mini", maxInputTokens: 128000, incrementalMaxInputTokens: 64000, maxOutputTokens: 4096 });
  const { confirmation, ...confirmed } = plan;
  expect(digest(confirmed)).toBe(confirmation);
  for (const field of ["maxInputTokens", "incrementalMaxInputTokens"]) {
    expect(digest({ ...confirmed, upkeep: { ...confirmed.upkeep, [field]: confirmed.upkeep[field] / 2 } })).not.toBe(confirmation);
  }
  const price = { input: 1, output: 2, cacheRead: 0.1 };
  const cost = estimateCost(plan, harder.traces, { [plan.reader.model]: price, [plan.upkeep.model]: price, [plan.judge.model]: price });
  expect(cost.arms["continuity-ledger-cold"]).toMatchObject({ upkeepCalls: 6, upkeepBudgetUsd: 0.5612 });
  expect(cost.arms["continuity-ledger-cold"].inputTokens - cost.arms["continuity-pack-cold"].inputTokens).toBe(2 * (128000 + 64000 + 64000));
});

it.each(["harness", "ledger", "skip", "read_only", "overrun", "output_overrun", "output_flag"])("retains upkeep receipt/accounting after %s preparation", async point => {
  const { prepareLedgerCheckpoint } = await import("../lib/continuity-runner.mjs");
  const work = await scratch(); let ledgerReads = 0;
  const receipt = { type: "continuity_upkeep", reason: point === "skip" ? "input_budget" : point === "read_only" ? "read_only" : point === "overrun" ? "input_overrun" : point === "output_overrun" ? "output_overrun" : "provider_output", providerInvoked: !["skip", "read_only"].includes(point), status: ["skip", "read_only"].includes(point) ? "skipped" : "invalid", costUsd: null, inputTokens: null, outputTokens: null, estimatedInputCostUsd: 0.02, estimatedInputTokens: 15000, outputOverrun: point === "output_flag" };
  const modules = {
    config: { resolveJsonMonoAgentConfig: () => ({ runtime: { model: {} } }) },
    coordinator: { acquireAgentRootOwnership: async () => ({}), releaseAgentRootOwnershipWhenIdle: async () => {} },
    app: { createConfiguredAgentRuntime: () => ({}), createConfiguredConversationHarness: async () => ({ run: async ({ onEvent }) => { onEvent(receipt); if (point === "harness") throw new Error("fictional"); return {}; } }) },
    host: { parseMonoRuntimeModelReference: reference => ({ reference }) },
    conversation: { ToolHistoryReader: class { ledger() { if (++ledgerReads === 2 && point === "ledger") throw new Error("fictional second ledger read"); } } },
  };
  const result = await prepareLedgerCheckpoint({ modules, work, mode: "real", reader: { reference: "openai-codex:gpt-6-luna" }, alternate: { reference: "openai:gpt-4o-mini" }, scripted: { respondWith() {} }, clock: {}, plan: { upkeep: { model: "openai-codex:gpt-6-luna", maxInputTokens: 128000, incrementalMaxInputTokens: 64000, maxOutputTokens: 4096, callsPerTraceRepeat: 3, preparations: [{ binding: "openai:gpt-4o-mini", maxInputTokens: 128000 }] }, limits: { perLiveTurnTimeoutMs: 10000 } } });
  expect(result.receipt).toEqual(receipt); expect(result.valid).toBe(["skip", "overrun", "output_overrun", "output_flag"].includes(point));
  expect(result.d6InputOverrun).toBe(point === "overrun");
  expect(result.d6OutputOverrun).toBe(["output_overrun", "output_flag"].includes(point));
  if (point === "read_only") expect(result.degraded).toBe(false);
  if (point === "ledger") { expect(ledgerReads).toBe(2); expect(result.failure).toBe("upkeep_preparation_failed"); }
  expect(result.usage).toMatchObject(["skip", "read_only"].includes(point) ? { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } : { calls: 1, estimatedInputTokens: 128000, estimatedCostUsd: null, conservativeCalls: 1, unpricedConservativeCalls: 1 });
});

it("zero-call and known-cost upkeep accounting do not inflate unknown cost counters", () => {
  const usage = emptyUsage(); addUsage(usage, { calls: 0 });
  expect(usage).toMatchObject({ unknownCostCalls: 0, unknownTokenCalls: 0 });
  addUsage(usage, { calls: 1, inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.02 });
  expect(usage).toMatchObject({ calls: 1, estimatedCostUsd: 0.02, unknownCostCalls: 0, unknownTokenCalls: 1 });
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
  expect(results.upkeep).toHaveLength(1); expect(results.upkeep[0]).toMatchObject({ receipt: { providerInvoked: true }, usage: { calls: 3 } });
  expect(results.summary.arms["continuity-ledger-cold"].usage.calls).toBe(3);
  const unit = JSON.parse(await readFile(join(output, "units", "r1-brightline-return-continuity-ledger-cold.json"), "utf8"));
  expect(unit.checkpoint.error).toBe("checkpoint_failed"); expect(unit.checkpoint.upkeep.receipt.providerInvoked).toBe(true);
  const baseline = JSON.parse(await readFile(join(output, "units", "r1-brightline-return-native.json"), "utf8"));
  expect(unit.manifest.observedInput).toBe(observedInputTokens(unit.checkpoint.upkeep.usage) + baseline.trials.reduce((n, trial) => n + observedInputTokens(trial.usage), 0));
}, 180_000);

it("tees only completion output without changing the model stream", async () => {
  const { captureUpkeepModels } = await import("../lib/continuity-runner.mjs");
  const message = { content: [{ type: "text", text: "fictional " }, { type: "thinking", thinking: "not captured" }, { type: "text", text: "JSON" }] }, capture = vi.fn();
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
it("captures each child completion and its merged ledger only when explicitly enabled", async () => {
  const output = await scratch();
  await main(["--trace", "brightline-return", "--probe-limit", "1", "--arms", "native,continuity-ledger-cold", "--output", output, "--capture-upkeep-output"], { env: {}, stdout: () => {} });
  for (let step = 1; step <= 3; step++) {
    const captured = JSON.parse(await readFile(join(output, "upkeep-output", `r1-brightline-return-p${step}.json`), "utf8"));
    expect(captured).toMatchObject({ status: "valid", failure: null });
    expect(JSON.parse(captured.text).entries).toHaveLength(step === 2 ? 0 : 1); expect(captured.ledger.entries).toHaveLength(step === 3 ? 2 : 1);
  }
}, 180_000);

it("loads the exact SDK builtin model collection for real capture without dispatch", async () => {
  const { productionModules, captureUpkeepModels } = await import("../lib/continuity-runner.mjs");
  const modules = await productionModules(root.replace(/\/$/u, ""));
  const models = modules.pi.builtinModels({ credentials: { read: async () => undefined } });
  const wrapped = captureUpkeepModels(models, () => { throw new Error("must not dispatch"); });
  expect(wrapped.getModel("openai-codex", "gpt-6-luna")).toBe(models.getModel("openai-codex", "gpt-6-luna"));
  expect(typeof wrapped.streamSimple).toBe("function");
});

it("refuses stale under-reserved upkeep plans before opening the configured harness", async () => {
  const { prepareLedgerCheckpoint } = await import("../lib/continuity-runner.mjs");
  await expect(prepareLedgerCheckpoint({ plan: { upkeep: { maxInputTokens: 64000, maxOutputTokens: 4096, callsPerTraceRepeat: 1 } } })).rejects.toThrow("upkeep_plan_budget_mismatch");
});

it("counts mixed known and unacknowledged child usage once, using inclusive estimates", () => {
  const usage = { calls: 2, components: [
    { calls: 1, inputTokens: 100, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 0, estimatedCostUsd: 0.01 },
    { calls: 1, inputTokens: null, outputTokens: null, cacheReadTokens: 500, estimatedInputTokens: 64000, estimatedCostUsd: null },
  ] };
  expect(observedInputTokens(usage)).toBe(64120);
  const total = addUsage(emptyUsage(), usage);
  expect(total).toMatchObject({ calls: 2, inputTokens: 100, estimatedCostUsd: 0.01, unknownCostCalls: 1, unknownTokenCalls: 1 });
});

it("confirms every preparation binding, budget and extraction reservation", async () => {
  const corpus = await loadTraces({ suite: "hard" });
  const plan = makePlan({ ...corpus, arms: ["native", "cold-rebuild", "continuity-pack-cold", "continuity-ledger-cold"], repeats: 2, profile: { judge: null } });
  expect(plan.workload).toMatchObject({ probeTurns: 960, upkeepCalls: 48, judgeCalls: 0 });
  expect(plan.upkeep.reservations).toHaveLength(48);
  expect(plan.upkeep.preparations.map(step => step.maxInputTokens)).toEqual([128000, 64000, 64000]);
  expect(plan.upkeep.preparations.map(step => step.binding)).toEqual([plan.alternateBinding.model, plan.reader.model, plan.alternateBinding.model]);
  const { confirmation, ...body } = plan;
  for (const path of ["preparations", "reservations"]) expect(digest({ ...body, upkeep: { ...body.upkeep, [path]: [] } })).not.toBe(confirmation);
});

it("does not manufacture another cold boundary by restarting the same answer binding", async () => {
  const { productionModules, buildCheckpoint } = await import("../lib/continuity-runner.mjs");
  const corpus = await loadTraces(), plan = makePlan({ ...corpus, arms: ["native", "continuity-ledger-cold"], profile: { judge: null } });
  plan.upkeep.preparations[1].binding = plan.alternateBinding.model;
  const checkpoint = await buildCheckpoint({ modules: await productionModules(root), trace: corpus.traces[0], arm: armById("continuity-ledger-cold"),
    repeat: 1, dir: await scratch(), plan, mode: "offline" });
  expect(checkpoint.record.upkeep.valid).toBe(false);
  expect(checkpoint.record.upkeep.preparations).toHaveLength(2);
  expect(checkpoint.record.upkeep.usage.calls).toBe(1);
  expect(checkpoint.record.upkeep.preparations[1].boundary.verified).toBe(false);
}, 180_000);

it("keeps three-child offer validation aligned with the shared two-offer policy", () => {
  expect(boundedOfferHistory([["first", "second"], ["first", "third"], ["second", "third"]])).toBe(true);
  expect(boundedOfferHistory([["first"], ["first"], ["first"]])).toBe(false);
  expect(boundedOfferHistory([["first", "first"]])).toBe(false);
  expect(boundedOfferHistory([["first"], []])).toBe(false);
});


it("charges unknown upkeep full reserved input plus output, separately from known catalog spend", () => {
  const price = { input: 2, output: 4 };
  const unknown = preparationUsage({ providerInvoked: true, estimatedInputTokens: 20, estimatedInputCostUsd: 0.00004 }, 64000, price);
  expect(unknown).toMatchObject({ calls: 1, estimatedInputTokens: 64000, estimatedCostUsd: null, conservativeCostUsd: 0.144384, conservativeCalls: 1 });
  const known = preparationUsage({ providerInvoked: true, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, costUsd: 0.01 }, 128000, price);
  const sum = addUsage(addUsage(emptyUsage(), known), unknown);
  expect(sum).toMatchObject({ calls: 2, estimatedCostUsd: 0.01, conservativeCostUsd: 0.144384, conservativeCalls: 1, unknownCostCalls: 1 });
  expect(addUsage(emptyUsage(), sum)).toMatchObject({ estimatedCostUsd: 0.01, conservativeCostUsd: 0.144384, unknownCostCalls: 1, unknownTokenCalls: 1 });
  expect(addUsage(emptyUsage(), { calls: 2, estimatedCostUsd: null, knownCatalogCostUsd: 0.02, unknownCostCalls: 1 })).toMatchObject({ estimatedCostUsd: 0.02, unknownCostCalls: 1 });
  expect(preparationUsage({ status: "uncertain", providerInvoked: false }, 128000, price).conservativeCostUsd).toBe(0.272384);
  expect(preparationUsage({ status: "skipped", providerInvoked: false }, 128000, price)).toMatchObject({ calls: 0, conservativeCostUsd: 0 });
});

it("distinguishes degraded stages from boundary, bootstrap, operation and injection integrity", () => {
  const steps = Array.from({ length: 3 }, (_, i) => ({ pid: i + 100, valid: true, preserved: true, boundary: { verified: true },
    receipt: { status: i === 1 ? "invalid" : "valid", reason: i === 1 ? "aborted" : "completed", providerInvoked: true, operationId: `op${i}` },
    journal: { operations: i + 1, bootstrap: 1, state: "terminal", budget: i ? "incremental" : "bootstrap", operationId: `op${i}`, selection: [`span${i}`],
      rows: Array.from({ length: i + 1 }, (_, n) => ({ operationId: `op${n}`, state: "terminal", budget: n ? "incremental" : "bootstrap", selection: [`span${n}`] })) } }));
  expect(preparationIntegrity(steps)).toBe(true);
  for (const mutate of [x => { x[1].boundary.verified = false; }, x => { x[1].journal.operations++; }, x => { x[2].journal.bootstrap++; }, x => { x[2].pid = x[1].pid; }, x => { x[2].preserved = false; }]) {
    const bad = structuredClone(steps); mutate(bad); expect(preparationIntegrity(bad)).toBe(false);
  }
  const observed = { continuityPacks: [{ ledgerEntries: 1 }], upkeep: [{ providerInvoked: false, reason: "read_only" }] };
  expect(verifyLedgerTreatment({ valid: true, expectedEntries: 1 }, observed)).toBe(true);
  expect(verifyLedgerTreatment({ valid: true, expectedEntries: 2 }, observed)).toBe(false);
  expect(verifyLedgerTreatment({ valid: true, expectedEntries: 1 }, { ...observed, upkeep: [{ providerInvoked: true }] })).toBe(false);
  expect(verifyLedgerTreatment({ valid: true, expectedEntries: 0 }, { continuityPacks: [{ ledgerEntries: 0, evidenceEntries: 3 }] })).toBe(true);
  expect(verifyLedgerTreatment({ valid: true, expectedEntries: 0 }, { continuityPacks: [{ ledgerEntries: 0, evidenceEntries: 0 }] })).toBe(false);
  const skipped = structuredClone(steps); skipped[1].receipt = { status: "skipped", reason: "input_budget", providerInvoked: false }; skipped[1].journal = { ...skipped[0].journal }; skipped[2].journal.rows.splice(1, 1); skipped[2].journal.operations = 2;
  expect(preparationIntegrity(skipped)).toBe(true);
});

it.each([false, true])("continues stage3 and probes after aborted stage2 (no ledger=%s)", async noLedger => {
  const { productionModules, buildCheckpoint, runProbe } = await import("../lib/continuity-runner.mjs");
  const corpus = await loadTraces(), plan = makePlan({ ...corpus, arms: ["native", "continuity-ledger-cold"], profile: { judge: null } });
  plan.upkeep.preparations[1].offlineAbort = true;
  if (noLedger) for (const step of plan.upkeep.preparations) step.offlineAbort = true;
  const modules = await productionModules(root), trace = corpus.traces[0], arm = armById("continuity-ledger-cold"), dir = await scratch();
  const checkpoint = await buildCheckpoint({ modules, trace, arm, repeat: 1, dir, plan, mode: "offline", upkeepPrice: { input: 2, output: 4 } });
  // Pin the runner offer itself through the production harness/store path.
  // A missing ownerText on replay steers must not silently change the treatment.
  const history = new modules.conversation.ToolHistoryReader(join(checkpoint.work, "history"));
  const scope = { logicalConversationId: checkpoint.record.conversationId, currentConversationId: checkpoint.record.conversationId, currentRunId: "steer-verification" };
  const retained = []; let before;
  for (;;) {
    const page = history.searchContinuity({ ...scope, limit: 10, ...(before === undefined ? {} : { before }) });
    retained.push(...page.items); if (page.next === undefined) break; before = page.next;
  }
  for (const turn of trace.turns) for (const step of turn.steps) if (step.steer) {
    expect(retained.find(record => record.inputId === `${turn.id}-steer`)).toMatchObject({
      kind: "owner", provenance: "host-owner", preview: step.steer,
      source: { attestation: { inputId: `${turn.id}-steer` } },
    });
  }
  const upkeep = checkpoint.record.upkeep;
  expect(upkeep).toMatchObject({ valid: true, expectedEntries: noLedger ? 0 : 1 });
  expect(upkeep.degradedStages).toBe(noLedger ? 3 : 2);
  expect(upkeep.degradedReasons).toContain("output_aborted");
  expect(upkeep.preparations).toHaveLength(3);
  expect(upkeep.preparations.map(s => s.entriesAfter)).toEqual(noLedger ? [0, 0, 0] : [1, 1, 1]);
  expect(upkeep.preparations.at(-1).journal.bootstrap).toBe(1);
  expect(upkeep.preparations.every(s => s.preserved)).toBe(true);
  const trial = await runProbe({ modules, trace, arm, repeat: 1, probe: trace.probes[0], checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot,
    checkpointConversationId: checkpoint.record.conversationId, checkpointContinuity: checkpoint.record.continuity, checkpointUpkeep: upkeep,
    forkDir: join(dir, "probe"), plan, mode: "offline", root });
  // Correct web attribution removes the former unknown steer from neutral
  // evidence. With every extraction aborted, this fixture now exhausts the
  // pack budget on owner/tool sections. Keep the exact no-ledger injection
  // check strict: no neutral evidence means this treatment is unverified.
  expect(trial.status, JSON.stringify(trial.store)).toBe(noLedger ? "store_degraded" : "completed");
  if (noLedger) {
    expect(trial.boundary.reasons).toContain("ledger_treatment_unverified");
    expect(trial.boundary.observed.continuityPacks.every(pack => pack.ledgerEntries === 0 && pack.evidenceEntries === 0)).toBe(true);
  }
  expect(trial.boundary.observed.offlineLedgerCounts).toEqual(noLedger ? [0, 0] : [1, 1]);
  expect(trial.boundary.observed.upkeep.every(row => !row.providerInvoked)).toBe(true);
}, 180_000);

it("invalidates every configuration/eligibility skip rather than calling it degraded", async () => {
  const { preparationDisposition } = await import("../lib/continuity-runner.mjs");
  for (const reason of ["read_only", "disabled", "detached_attempt", "continuation_boundary", "per_message", "isolated", "unowned_store", "history_unavailable", "model_unavailable", "model_identity", "trigger_headroom", "cap_unsupported", "ledger_integrity", "unexpected"]) {
    const receipt = { status: "skipped", reason, providerInvoked: false };
    expect(preparationDisposition(receipt), reason).toBe("integrity");
    expect(preparationIntegrity([1, 2, 3].map(pid => ({ pid, valid: true, boundary: { verified: true }, preserved: true, receipt, journal: { operations: 0, released: 0, bootstrap: 0 } }))), reason).toBe(false);
  }
  expect(preparationDisposition({ status: "valid", reason: "completed", providerInvoked: false })).toBe("integrity");
  expect(preparationDisposition({ status: "skipped", reason: "unavailable", providerInvoked: false })).toBe("integrity");
  expect(preparationDisposition({ status: "invalid", reason: "unavailable", providerInvoked: true })).toBe("degraded");
  expect(preparationDisposition({ status: "invalid", reason: "input_overrun", providerInvoked: true })).toBe("degraded");
  expect(preparationIntegrity([])).toBe(false);
});
it("allows a released non-invoked bootstrap row before the first real bootstrap", () => {
  const first = { pid: 10, valid: true, preserved: true, boundary: { verified: true },
    receipt: { status: "skipped", reason: "input_budget", providerInvoked: false, operationId: "released" },
    journal: { operations: 0, released: 1, state: "released", bootstrap: 0, budget: "bootstrap", operationId: "released", selection: ["shared"], rows: [{ operationId: "released", state: "released", budget: "bootstrap", selection: ["shared"] }] } };
  const second = { pid: 11, valid: true, preserved: true, boundary: { verified: true },
    receipt: { status: "valid", reason: "completed", providerInvoked: true, operationId: "bootstrap" },
    journal: { operations: 1, released: 1, state: "terminal", bootstrap: 1, budget: "bootstrap", operationId: "bootstrap", selection: ["shared"], rows: [...first.journal.rows, { operationId: "bootstrap", state: "terminal", budget: "bootstrap", selection: ["shared"] }] } };
  expect(preparationIntegrity([first, second])).toBe(true);
  const invoked = structuredClone(first); invoked.receipt.providerInvoked = true;
  expect(preparationIntegrity([invoked])).toBe(false);
  const wrongBudget = structuredClone(second); wrongBudget.journal.budget = "incremental";
  expect(preparationIntegrity([first, wrongBudget])).toBe(false);
});
it("charges the full inclusive reserve for incomplete uncached/cache usage", () => {
  const usage = preparationUsage({ providerInvoked: true, inputTokens: 30, outputTokens: null, costUsd: 0.01 }, 128000, { input: 2, output: 4 });
  expect(usage).toMatchObject({ estimatedCostUsd: null, conservativeCostUsd: 0.272384, conservativeInputTokens: 128000 });
  expect(observedInputTokens(usage)).toBe(128000);
  expect(addUsage(emptyUsage(), usage)).toMatchObject({ estimatedCostUsd: 0, conservativeCostUsd: 0.272384, unknownCostCalls: 1 });
});

it.each(["released", "reserved"])("reconciles native journal rows after a %s pre-invocation bootstrap", async initialState => {
  const { DatabaseSync } = await import("node:sqlite");
  const { prepareLedgerCheckpoint } = await import("../lib/continuity-runner.mjs");
  const work = await scratch(), path = join(work, "journal.sqlite"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE continuity_upkeep_operations(operation_id TEXT,reservation TEXT,state TEXT); CREATE TABLE continuity_upkeep_progress(logical_id TEXT,conversation_id TEXT,cursor TEXT); CREATE TABLE continuity_upkeep_offers(offer_count INTEGER,state TEXT); CREATE TABLE continuity_upkeep_retired(data BLOB)");
  let stage = 0;
  const modules = {
    config: { resolveJsonMonoAgentConfig: () => ({ runtime: { model: {} } }) },
    coordinator: { acquireAgentRootOwnership: async () => ({}), releaseAgentRootOwnershipWhenIdle: async () => {} },
    host: { parseMonoRuntimeModelReference: reference => ({ reference }) },
    conversation: { ToolHistoryReader: class { databasePath = path; ledger() {} } },
    app: { createConfiguredAgentRuntime: () => ({}), createConfiguredConversationHarness: async () => ({ run: async ({ onEvent }) => {
      const operationId = `operation-${++stage}`;
      db.prepare("UPDATE continuity_upkeep_operations SET state='released' WHERE state='reserved'").run();
      db.prepare("INSERT INTO continuity_upkeep_operations VALUES (?,?,?)").run(operationId, JSON.stringify({ budget: stage < 3 ? "bootstrap" : "incremental", progress: { spans: [{ key: "same-source" }] } }), stage === 1 ? initialState : "terminal");
      onEvent({ type: "continuity_upkeep", ...(stage === 1 && initialState === "reserved" ? {} : { operationId }), status: stage === 1 ? "skipped" : "valid", reason: stage === 1 ? initialState === "reserved" ? "ledger_scan_capacity" : "model_headroom" : "analyzed", providerInvoked: stage !== 1 }); return {};
    } }) },
  };
  const plan = { upkeep: { model: "fictional:base", maxInputTokens: 128000, incrementalMaxInputTokens: 64000, maxOutputTokens: 4096, callsPerTraceRepeat: 3 }, limits: { perLiveTurnTimeoutMs: 10000 } };
  try {
    const run = maxInputTokens => prepareLedgerCheckpoint({ modules, work, conversationId: "fictional", plan, step: { binding: "fictional:base", maxInputTokens }, mode: "real", reader: { reference: "fictional:base" }, scripted: { respondWith() {} }, clock: {} });
    const first = await run(128000);
    expect(preparationInputReserve([first])).toBe(128000);
    const second = await run(64000), third = await run(64000);
    expect(first.journal).toMatchObject({ operations: 0, released: Number(initialState === "released"), reserved: Number(initialState === "reserved"), bootstrap: 0, states: { [initialState]: 1 }, state: initialState });
    expect(first.usage.calls).toBe(0);
    expect(second.journal).toMatchObject({ operations: 1, released: 1, bootstrap: 1, states: { released: 1, terminal: 1 }, budget: "bootstrap" });
    expect(second.usage).toMatchObject({ estimatedInputTokens: 128000, conservativeInputTokens: 128000 });
    expect(third.usage).toMatchObject({ conservativeInputTokens: 64000 });
    expect(preparationIntegrity([first, second, third].map((step, i) => ({ ...step, pid: i + 100, boundary: { verified: true } })))).toBe(true);
  } finally { db.close(); }
});


// Inventory actual receipt-reason producers, not every exception/failure or scan diagnostic.
function productReasonLiterals(source) {
  const file = ts.createSourceFile("producer.ts", source, ts.ScriptTarget.Latest, true), reasons = new Set();
  const values = node => {
    if (!node) return;
    if (ts.isStringLiteralLike(node)) reasons.add(node.text);
    else if (ts.isConditionalExpression(node)) { values(node.whenTrue); values(node.whenFalse); }
    else if (ts.isParenthesizedExpression(node)) values(node.expression);
    else if (ts.isBinaryExpression(node)) { values(node.left); values(node.right); }
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(values);
    else if (ts.isUnionTypeNode(node)) node.types.forEach(values);
    else if (ts.isLiteralTypeNode(node)) values(node.literal);
  };
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "skip") values(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(file) === "localSkip") values(node.right);
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "NON_INVOCATION") values(node.initializer?.arguments?.[0]);
    if (ts.isCallExpression(node) && node.expression.getText(file) === "result") values(node.arguments[1]);
    if (ts.isPropertySignature(node) && node.name.getText(file) === "reason") values(node.type);
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "reason") {
      const eventType = node.parent.properties.find(p => p.name?.getText(file) === "type")?.initializer;
      if (!eventType || ts.isStringLiteral(eventType) && eventType.text === "continuity_upkeep") values(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return reasons;
}
it("partitions every product-emitted non-success reason exactly once and rejects producer drift", async () => {
  const files = ["packages/conversation/src/continuity/upkeep.ts", "packages/conversation/src/continuity/admission.ts", "packages/conversation/src/continuity/ledger.ts", "packages/turn/src/execution/pi/continuity-upkeep.ts"];
  const reasons = new Set();
  for (const file of files) for (const reason of productReasonLiterals(await readFile(join(root, file), "utf8"))) reasons.add(reason);
  const degraded = new Set(["input_budget", "model_headroom", "ledger_scan_capacity", "ledger_render_budget", "ledger_payload_budget", "ledger_lineage_budget", "ledger_aggregate_capacity", "ledger_quota_budget", "source_oversized", "upkeep_dispatch_rejected", "upkeep_repeat_suppressed", "already_covered", "unchanged", "no_source", "output_aborted", "aborted", "provider_output", "empty_output", "validation_or_publication", "input_overrun", "output_overrun", "unavailable", "dispatch_or_outcome_unacknowledged"]);
  const integrity = new Set(["disabled", "continuation_boundary", "history_unavailable", "per_message", "isolated", "unowned_store", "detached_attempt", "trigger_headroom", "ledger_integrity", "read_only", "model_unavailable", "model_identity", "cap_unsupported", "namespace_invalid"]);
  const success = new Set(["completed", "analyzed"]);
  expect(reasons.size).toBeGreaterThan(30);
  for (const reason of reasons) {
    if (success.has(reason)) { expect(preparationDisposition({ reason, status: "valid", providerInvoked: true })).toBe("applied"); continue; }
    expect(Number(degraded.has(reason)) + Number(integrity.has(reason)), reason).toBe(1);
    const status = reason === "dispatch_or_outcome_unacknowledged" ? "uncertain" : "skipped";
    expect(preparationDisposition({ reason, status, providerInvoked: true }), reason).toBe(degraded.has(reason) ? "degraded" : "integrity");
  }
  expect(preparationDisposition({ reason: "unavailable", status: "skipped", providerInvoked: false })).toBe("integrity");
  expect(preparationDisposition({ reason: "dispatch_or_outcome_unacknowledged", status: "skipped", providerInvoked: true })).toBe("integrity");
  const introduced = productReasonLiterals('const skip = condition ? "brand_new_reason" : undefined; const receipt = {reason: "another_reason"};');
  expect([...introduced].filter(r => !success.has(r) && !degraded.has(r) && !integrity.has(r))).toEqual(["brand_new_reason", "another_reason"]);
});

it("reconciles a never-acknowledged reservation released by a later claim without consuming bootstrap or offers", () => {
  const pending = { operationId: "unacknowledged", state: "reserved", budget: "bootstrap", selection: ["shared"] };
  const first = { pid: 20, valid: true, preserved: true, boundary: { verified: true }, receipt: { status: "skipped", reason: "ledger_scan_capacity", providerInvoked: false }, journal: { rows: [pending], operations: 0, reserved: 1, released: 0, bootstrap: 0, ...pending } };
  const boot = { operationId: "actual", state: "terminal", budget: "bootstrap", selection: ["shared"] };
  const second = { pid: 21, valid: true, preserved: true, boundary: { verified: true }, receipt: { status: "valid", reason: "analyzed", providerInvoked: true, operationId: "actual" }, journal: { rows: [{ ...pending, state: "released" }, boot], operations: 1, reserved: 0, released: 1, bootstrap: 1, ...boot } };
  const incremental = { operationId: "next", state: "terminal", budget: "incremental", selection: ["shared"] };
  const third = { ...second, pid: 22, receipt: { ...second.receipt, operationId: "next" }, journal: { rows: [...second.journal.rows, incremental], operations: 2, reserved: 0, released: 1, bootstrap: 1, ...incremental } };
  expect(preparationIntegrity([first, second, third])).toBe(true); // Only two dispatched offers, not three.
  expect(preparationInputReserve([first])).toBe(128000); // Lost stage 2 acknowledgement cannot under-reserve 64k.
  expect(preparationUsage({ providerInvoked: true }, preparationInputReserve([first]), { input: 2, output: 4 })).toMatchObject({ conservativeInputTokens: 128000, conservativeCostUsd: 0.272384 });
  expect(preparationInputReserve([first, second])).toBe(64000);
  for (const mutate of [x => { x[1].journal.rows[0].operationId = "replacement"; }, x => { x[1].journal.rows[1].budget = "incremental"; }, x => { x[1].journal.rows.push({ ...boot }); }, x => { x[2].journal.rows[1].state = "released"; }]) {
    const bad = structuredClone([first, second, third]); mutate(bad); expect(preparationIntegrity(bad)).toBe(false);
  }
});

it("counts uncached, cache-read and cache-write upkeep input toward spend admission", () => {
  const usage = preparationUsage({ providerInvoked: true, inputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50, outputTokens: 2, costUsd: 0.01 }, 128000, { input: 2, output: 4 });
  expect(usage).toMatchObject({ inputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50, conservativeInputTokens: 0, estimatedCostUsd: 0.01 });
  expect(observedInputTokens(usage)).toBe(480);
  for (const key of ["cacheReadTokens", "cacheWriteTokens"]) {
    const unknown = preparationUsage({ providerInvoked: true, inputTokens: 30, cacheReadTokens: 400, cacheWriteTokens: 50, outputTokens: 2, costUsd: 0.01, [key]: null }, 128000, { input: 2, output: 4 });
    expect(unknown[key]).toBeNull(); expect(unknown.conservativeCalls).toBe(1);
    expect(observedInputTokens(unknown)).toBe(128000);
  }
});

it("reconciles reported upkeep cost by operation while preserving conservative stop reserves", () => {
  const full = { version: 1, usageIncluded: false, operationId: "fictional-operation", databaseId: "database", incarnation: "epoch", recorderNamespace: "/home/example", logicalConversationId: "logical", runId: "run", conversationId: "conversation", model: "fictional:extractor", budget: "bootstrap", phase: "dispatch", invocation: "uncertain", outcome: "uncertain", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null };
  const result = { ...full, phase: "result", invocation: "invoked", outcome: "valid", inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, costUsd: 0.02 };
  const step = accounting => { const receipt = { ...accounting, providerInvoked: accounting.invocation === "invoked", status: accounting.phase === "dispatch" ? "uncertain" : "valid", accounting }; return { receipt, usage: preparationUsage(receipt, 128000, { input: 2, output: 4 }) }; };
  expect(sumPreparationUsage([step(full), step(result), step(full), step(result)])).toMatchObject({ calls: 1, estimatedCostUsd: 0.02, reportedCost: { totalUsd: 0.02, knownCostUsd: 0.02, partial: false } });
  expect(sumPreparationUsage([step(full)])).toMatchObject({ conservativeCalls: 1, conservativeInputTokens: 128000, reportedCost: { totalUsd: null, partial: true } });
  const unknown = preparationUsage({ providerInvoked: true, estimatedCostUsd: 500 }, 128000, { input: 2, output: 4 });
  expect(unknown).toMatchObject({ estimatedCostUsd: null, conservativeCostUsd: 0.272384, reportedCost: { totalUsd: null, knownCostUsd: 0, partial: true } });
  const priced = preparationUsage({ providerInvoked: true, inputTokens: null, costUsd: 0.01 }, 128000, { input: 2, output: 4 });
  expect(priced).toMatchObject({ estimatedCostUsd: null, conservativeCalls: 1, reportedCost: { totalUsd: 0.01, partial: false } });
  const free = preparationUsage({ providerInvoked: true, inputTokens: null, costUsd: 0 }, 128000, { input: 2, output: 4 });
  expect(free).toMatchObject({ conservativeCalls: 1, reportedCost: { totalUsd: 0, knownCostUsd: 0, partial: false } });
  const conflict = sumPreparationUsage([step(result), step({ ...result, costUsd: 2 })]);
  expect(conflict).toMatchObject({ calls: 2, inputTokens: result.inputTokens * 2, reportedCost: { totalUsd: null, knownCostUsd: 0.02, partial: true } });
  const budget = emptyUsage(); addUsage(budget, conflict);
  expect(budget.calls).toBe(2); expect(budget.reportedCost).toEqual({ totalUsd: null, knownCostUsd: 0.02, partial: true });
  const multiple = sumPreparationUsage([step(full), step(result), step({ ...result, costUsd: 2 }), step({ ...result, operationId: "second", costUsd: 0.03 }), step({ ...result, operationId: "second", costUsd: 0.03 })]);
  expect(multiple.reportedCost.knownCostUsd).toBe(0.05);
  const combined = emptyUsage(); addUsage(combined, multiple);
  expect(combined.reportedCost.knownCostUsd).toBe(0.05);
  expect(() => sumPreparationUsage([{ receipt: { accounting: { ...result, version: 2 } }, usage: emptyUsage() }])).toThrow("Invalid upkeep accounting");
  const bug = new Error("Fictional unrelated dedupe failure");
  expect(() => sumPreparationUsage([{ ...step(result), get usage() { throw bug; } }])).toThrow(bug);
  const mixed = sumPreparationUsage([step(result), step({ ...result, inputTokens: null, costUsd: 2 })]);
  expect(observedInputTokens(mixed)).toBe(128000 + result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens);
});

it("counts inference-only runtime usage plus checkpoint upkeep once in arm totals", () => {
  const response = { metadata: { runtime: { usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 1 } }, summary: { cost: { totalUsd: 1 }, inclusiveCost: { totalUsd: 1.02 } } } };
  const own = liveResponseUsage(response), checkpoint = preparationUsage({ providerInvoked: true, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2, costUsd: 0.02 }, 128000, { input: 2, output: 4 });
  const total = emptyUsage(); addUsage(total, own); addUsage(total, checkpoint);
  expect(total.reportedCost.totalUsd).toBe(1.02);
  const trial = { traceId: "fictional", arm: "native", repeat: 1, probeId: "fictional-probe", category: "next_action", status: "completed", score: { pass: true, outcome: "correct" }, usage: own };
  const summary = summarize([trial], { arms: ["native"], baselineArm: "native", repeats: [1], extraUsage: [{ arm: "native", usage: checkpoint }] });
  expect(summary.arms.native.usage.reportedCost.totalUsd).toBe(1.02);
});


describe("free three-pass source-selection/fitting baseline", () => {
  it.each([1, 2, "transitions"])("records every exact offer, including an empty delta (%s)", async seed => {
    const records = seed === "transitions" ? fictionalTransitionRecords() : selectionReplayRecords(generateTrace(seed));
    const passes = await replayLedgerSelection(records);
    expect(selectionReplaySummary(passes)).toMatchSnapshot();
    expect(passes.map(pass => pass.deltaEntries)).toEqual([1, 0, 1]);
    expect(passes.map(pass => pass.published)).toEqual([true, false, true]);
    expect(passes.map(pass => pass.inputTokens)).toEqual([128000, 64000, 64000]);
    for (const pass of passes) {
      expect(pass.offered.length).toBeGreaterThan(0);
      expect(pass.offered.length).toBeLessThanOrEqual(pass.deltaCap * 8);
      expect(pass.deltaCap).toBeLessThanOrEqual(8);
      expect(pass.selection.projectedBytes).toBeLessThanOrEqual(128 * 1024);
      expect(pass.selection.lineageBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      for (const span of pass.offered) {
        const record = pass.records.find(record => record.recordId === span.recordId);
        expect(record).toBeDefined();
        expect(record.sha256).toBe(span.sha256);
        expect(Buffer.from(record.text).subarray(span.start, span.end).toString()).toBe(span.text);
      }
    }
    // Repeat through a new private store, not a cached selection. No random
    // generation identity or timing field belongs in the replay manifest.
    expect(await replayLedgerSelection(records)).toEqual(passes);
  }, 60000);
});
