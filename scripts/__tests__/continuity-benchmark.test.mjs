import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, ARM_IDS, BASELINE_ARM, SMALL_PROACTIVE_COMPACTION, checkpointKey, mergePatch, verifyBoundary } from "../lib/continuity-arms.mjs";
import { inventory, loadTraces, makePlan, sourceOnly, validateTrace } from "../lib/continuity-dataset.mjs";
import { ABSTAIN_INSTRUCTION, CATEGORIES, isAbstention, parseJudgeVerdict, probePrompt, renderMarkdown, scoreAnswer, summarize } from "../lib/continuity-score.mjs";
import { callKey } from "../lib/continuity-tools.mjs";
import { main, parseArguments } from "../continuity-benchmark.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
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
      for (const category of CATEGORIES) expect(row.categories[category]).toBeGreaterThanOrEqual(1);
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
    expect(summary.arms["cold-rebuild"].excluded).toEqual({ boundaryUnverified: 1, failed: 1 });
    expect(summary.arms.native.flipRate).toBe(0.6667);
    expect(summary.arms["cold-rebuild"].usage).toMatchObject({ calls: 3, unknownCostCalls: 1, unknownTokenCalls: 1 });
    expect(summary.judge).toMatchObject({ judgedSamples: 2, agreementWithDeterministicProxy: 0.5, judgePassOnlyCount: 1 });
    const markdown = renderMarkdown(summary, { qualityMeasured: false });
    expect(markdown).toContain("NOT model quality");
    expect(markdown).toContain("next_action (proxy)");
  });
});

describe("continuity arms and plan", () => {
  it("declares four production-config arms with the native baseline first", () => {
    expect(ARM_IDS).toEqual(["native", "cold-rebuild", "compaction-1", "compaction-2"]);
    expect(BASELINE_ARM).toBe("native");
    expect(ARMS.find((arm) => arm.id === "compaction-1").probeRuntime).toEqual({ compaction: SMALL_PROACTIVE_COMPACTION });
    expect(checkpointKey(ARMS[0], 2)).toBe("scripted-native");
    expect(checkpointKey(ARMS[3], 2)).toBe("live-compaction-2-r2");
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
  });

  it("binds the workload into one digest and computes the pilot workload", async () => {
    const { traces, sha256 } = await loadTraces();
    const pilot = makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 2 });
    expect(pilot.confirmation).toMatch(/^[0-9a-f]{64}$/u);
    expect(makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 2 }).confirmation).toBe(pilot.confirmation);
    expect(makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 1 }).confirmation).not.toBe(pilot.confirmation);
    expect(makePlan({ traces, sha256, codeRevision: "a".repeat(40), repeats: 2, profile: { reader: "openai-codex:gpt-6-sol" } }).confirmation).not.toBe(pilot.confirmation);
    const probes = inventory(traces).probes;
    expect(pilot.workload).toEqual({ probeTurns: probes * 4 * 2, midCheckpointLiveTurns: 4 * 2, liveTurns: probes * 8 + 8,
      expectedCompactions: 2 * (probes * 2 + 4), judgeCalls: 4 * 4 * 2 });
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
  it("parses flags strictly", () => {
    expect(() => parseArguments(["--unknown"])).toThrow("invalid_arguments");
    expect(() => parseArguments(["--repeats"])).toThrow("missing_argument");
    expect(() => parseArguments(["--dry-run", "--real"])).toThrow("dry_run_and_real_are_exclusive");
    expect(parseArguments(["--trace", "a", "--trace", "b"]).trace).toEqual(["a", "b"]);
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
    const code = await main(["--trace", "brightline-return", "--probe-limit", "1", "--concurrency", "4", "--output", output], { env: {}, stdout: (line) => lines.push(line) });
    expect(code).toBe(1); // 4 of 16 units: the other traces were not selected.
    const results = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
    expect(results).toMatchObject({ executionKind: "offline", qualityMeasured: false, coverage: { unitsComplete: 4, unitsExpected: 16 } });
    const units = Object.fromEntries(await Promise.all((await readdir(join(output, "units"))).map(async (name) => {
      const unit = JSON.parse(await readFile(join(output, "units", name), "utf8"));
      return [unit.arm, unit];
    })));
    for (const arm of ARM_IDS) {
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
    expect(units["compaction-2"].checkpoint.mid).toMatchObject({ turnId: "t25", boundary: { verified: true } });
    expect(units["compaction-2"].trials[0].boundary.observed.compactions).toHaveLength(1);
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
