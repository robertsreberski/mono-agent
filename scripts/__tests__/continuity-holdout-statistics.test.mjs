import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { clopperPearson, pairedT, tQuantile, betaCdf, betaQuantile, holdoutStatistics, HOLDOUT_ARMS, STATISTICAL_SPEC, completionUpperBound, gateEvaluator, validateStatisticalSpec, familyT, familyCompletionBounds, pureAbstention } from "../lib/continuity-holdout-statistics.mjs";
import { createRegistration, holdoutModels, readBoundAudit, seeded, assertRealHoldoutModels, validateRegistrationVersion } from "../lib/continuity-holdout-registration.mjs";
import { bundleDistribution, simulatePower, POWER_SCENARIOS, familyEffectParameters } from "../lib/continuity-holdout-power.mjs";
import { scoreAnswer, renderMarkdown } from "../lib/continuity-score.mjs";
import { sha256 } from "../lib/continuity-holdout-files.mjs";
import { makePlan, digest } from "../lib/continuity-dataset.mjs";
import { profileFrom, parseArguments, aggregate } from "../continuity-benchmark.mjs";

const conversations = Array.from({ length: 512 }, (_, i) => ({ id: `fixture-${i}`, family: `family-${Math.floor(i / 2)}`, corpus: i < 256 ? "holdout-hard" : "holdout-hard-distractors", probes: Array.from({ length: 15 }, (_, j) => `p${String(j + 1).padStart(2, "0")}`) }));
const audit = { published: 363, audited: 363, labelFindings: 10, contextFindings: 5, falselySupersededCurrent: 0, bindingErrors: 0, complete: true };
function trials() {
  return conversations.flatMap(c => HOLDOUT_ARMS.flatMap(arm => [1, 2].flatMap(repeat => c.probes.map(probeId => {
    const pass = arm !== "continuity-pack-cold" || probeId !== "p01";
    return { traceId: c.id, probeId, arm, repeat, status: "completed", answer: pass ? "Fixture answer." : "UNKNOWN", score: { pass, abstained: !pass, outcome: pass ? "correct" : "abstained" } };
  }))));
}
const score = rows => holdoutStatistics({ conversations, trials: rows, audit, measurement: true });
const ledger = rows => rows.filter(t => t.arm === "continuity-ledger-cold");
const registrationOptions = () => ({ conversations, manifestSha256: "a".repeat(64), rubricSha256: "b".repeat(64), statisticalSpecSha256: "c".repeat(64), statisticalSpec: STATISTICAL_SPEC, seed: 7654, models: holdoutModels(), codeRevision: "d".repeat(40) });

describe("exact cluster statistics", () => {
  // Independent 60-digit Decimal binomial-CDF inversion, P[Binomial(128,p)<=k]=.05.
  it.each([0.02313240525174675064, 0.03652382505354844207, 0.04836699299276614878, 0.05945880939140506194].map((upper, k) => [k, upper]))("matches golden CP upper %i/128", (k, upper) => {
    expect(clopperPearson(k, 128).upper).toBeCloseTo(upper, 13);
  });
  it("handles boundaries, beta inversion and Student-t references", () => {
    expect(clopperPearson(0, 128).lower).toBe(0); expect(clopperPearson(128, 128).upper).toBe(1);
    expect(clopperPearson(0, 1).upper).toBeCloseTo(0.95, 13);
    expect(() => clopperPearson(1, 0)).toThrow("invalid_binomial_counts");
    expect(() => clopperPearson(-1, 128)).toThrow("invalid_binomial_counts");
    expect(betaCdf(betaQuantile(0.95, 3, 126), 3, 126)).toBeCloseTo(0.95, 13);
    expect(tQuantile(0.95, 9)).toBeCloseTo(1.83311293265623716869, 12);
    const bound = pairedT([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bound.mean).toBe(5.5); expect(bound.lower).toBeCloseTo(5.5 - 1.83311293265623716869 * Math.sqrt(11 / 12), 12);
    expect(pairedT([0.03, 0.03]).lower).toBe(0.03);
  });
  it("passes complete fixture gates with planned denominators and exact audit rate boundaries", () => {
    const result = score(trials()); expect(result.decision.status).toBe("pass");
    expect(result.plannedAnswersPerArm).toBe(15360); expect(result.scopes["holdout-hard"].plannedAnswers).toBe(7680);
    expect(result.scopes.combined.benefit.n).toBe(256); expect(result.audit.labelRate).toBe(10 / 363);
    expect(result.scopes.combined.ledgerAccuracy).toBe(1);
    expect(holdoutStatistics({ conversations, trials: trials(), measurement: true, audit: { ...audit, labelFindings: 11 } }).decision.reasons).toContain("audit-label:fail");
    expect(holdoutStatistics({ conversations, trials: trials(), measurement: true, audit: { ...audit, contextFindings: 6 } }).decision.reasons).toContain("audit-context:fail");
    expect(holdoutStatistics({ conversations, trials: trials(), measurement: true }).decision.status).toBe("inconclusive");
  });
  it("is invariant to probe/repeat order and uses conversations, not independent answers", () => {
    const rows = trials(), first = score(rows);
    expect(score([...rows].reverse())).toEqual(first);
    expect(score(rows.map(t => ({ ...t, repeat: 3 - t.repeat })))).toEqual(first);
    const affected = ledger(rows).filter(t => ["fixture-0", "fixture-1"].includes(t.traceId));
    affected.slice(0, 40).forEach(t => { t.score = { pass: false, abstained: false, outcome: "wrong" }; });
    const result = score(rows), corpus = result.scopes["holdout-hard"];
    expect(corpus.discordances["cold-rebuild"].ledgerOnlyKnownWrong).toBe(2);
    expect(corpus.safety.native.interval).toMatchObject(familyT([2 / 3, ...Array(127).fill(0)]));
    expect(result.decision.reasons).toContain("holdout-hard:safety:continuity-pack-cold:inconclusive");
  });
  it("distinguishes a straddling safety interval from an established failure", () => {
    const rows = trials(); ledger(rows).filter(t => t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 30).forEach(t => { t.score = { pass: false, abstained: false, outcome: "wrong" }; });
    expect(score(rows).scopes["holdout-hard"].safety["continuity-pack-cold"].status).toBe("inconclusive");
    ledger(rows).filter(t => t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 80).forEach(t => { t.score = { pass: false, abstained: false, outcome: "wrong" }; });
    expect(score(rows).scopes["holdout-hard"].safety["continuity-pack-cold"].status).toBe("fail");
  });
  it.each(["missing", "invalid", "bad-score", "duplicate", "unknown", "native"])("bounds %s planned data without producing complete-case inference", kind => {
    const rows = trials();
    if (kind === "missing") rows.splice(rows.findIndex(t => t.arm === "continuity-ledger-cold"), 1);
    if (kind === "invalid") ledger(rows)[0].status = "boundary_unverified";
    if (kind === "bad-score") ledger(rows)[0].score = { pass: true, outcome: "not-an-outcome" };
    if (kind === "duplicate") rows.push(structuredClone(ledger(rows)[0]));
    if (kind === "unknown") rows.push({ ...rows[0], traceId: "unknown" });
    if (kind === "native") rows.splice(rows.findIndex(t => t.arm === "native"), 1);
    const result = score(rows);
    expect(result.decision.status).toBe(kind === "unknown" ? "inconclusive" : "pass"); expect(result.integrity.complete).toBe(false);
    expect(result.scopes.combined.benefit).toBe(null); expect(result.scopes.combined.safety.native.interval).toBe(null);
    expect(result.scopes.combined.plannedAnswers).toBe(15360);
    if (["missing", "invalid", "bad-score", "duplicate"].includes(kind)) expect(result.scopes.combined.ledgerAccuracy).toBe(15359 / 15360);
  });
});

describe("registration and confirmation", () => {
  it("deterministically creates balanced disjoint shards and binds all inputs", () => {
    const options = registrationOptions(), registration = createRegistration(options);
    expect(createRegistration({ ...options, conversations: [...conversations].reverse() })).toEqual(registration);
    expect(registration.shards).toHaveLength(32);
    const ids = registration.shards.flatMap(s => s.conversations); expect(ids).toHaveLength(512); expect(new Set(ids).size).toBe(512);
    for (const shard of registration.shards) {
      expect(shard.costCapUSD).toBe(25); expect(shard.conversations).toHaveLength(16);
      expect(shard.conversations.filter(id => conversations.find(c => c.id === id).corpus === "holdout-hard")).toHaveLength(8);
    }
    for (const key of ["manifestSha256", "rubricSha256", "statisticalSpecSha256", "codeRevision", "seed", "models"]) {
      const changed = { ...options, [key]: key === "seed" ? 7655 : key === "models" ? { ...options.models, extractor: "fixture:extractor" } : "e".repeat(key === "codeRevision" ? 40 : 64) };
      expect(digest(createRegistration(changed))).not.toBe(digest(registration));
    }
    const trace = { id: "fixture", family: "long", turns: [{ user: "Fixture", steps: [{ call: { result: "Fixture" } }, { reply: "Fixture" }] }], probes: [{ id: "p01", category: "abstention" }] };
    const plan = holdout => makePlan({ suite: "holdout", traces: [trace], sha256: options.manifestSha256, codeRevision: options.codeRevision, repeats: 2, profile: { judge: null }, holdout });
    const confirmation = plan(registration).confirmation;
    expect(plan({ ...registration, shards: [...registration.shards].reverse() }).confirmation).not.toBe(confirmation);
    expect(plan({ ...registration, rubricSha256: "e".repeat(64) }).confirmation).not.toBe(confirmation);
    expect(plan({ ...registration, statisticalSpecSha256: "e".repeat(64) }).confirmation).not.toBe(confirmation);
  });
  it("locks the spec and the registered model policy, with legacy profiles unchanged", () => {
    expect(() => createRegistration({ ...registrationOptions(), statisticalSpec: { ...STATISTICAL_SPEC, decision: "unsupported" } })).toThrow("unregistered_statistical_spec");
    expect(() => createRegistration({ ...registrationOptions(), models: { ...holdoutModels(), judge: "fixture:judge" } })).toThrow("invalid_holdout_models");
    expect(profileFrom(parseArguments([])).repeats).toBe(1);
    expect(profileFrom(parseArguments(["--suite", "hard"])).arms).not.toEqual(HOLDOUT_ARMS);
  });
});

const scratch = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });
it("enumerates coherent repeat bundles with the requested quality moments", () => {
  for (const scenario of POWER_SCENARIOS) {
    const atoms = bundleDistribution(scenario.quality, scenario.errorCount);
    expect(atoms.reduce((sum, a) => sum + a.probability, 0)).toBeCloseTo(1, 14);
    for (const arm of ["ledger", "native", "pack"]) {
      for (const atom of atoms) {
        const b = atom.bundle[arm]; expect(b.correct + b.wrong).toBeLessThanOrEqual(15);
        expect(b.correct).toBeGreaterThanOrEqual(0); expect(b.wrong).toBeGreaterThanOrEqual(0);
      }
      for (const [i, key] of ["correct", "wrong"].entries()) {
        expect(atoms.reduce((sum, a) => sum + a.probability * a.bundle[arm][key] / 15, 0)).toBeCloseTo(scenario.quality[arm][i], 14);
      }
    }
  }
});
it("power CLI is deterministic at 100,000 synthetic replications and rejects smaller studies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "holdout-power-fixture-")); scratch.push(dir);
  // Selected synthetic scenario has G=8 per corpus, exercising real family inference, not G=1 inconclusiveness.
  const spec = structuredClone(STATISTICAL_SPEC);
  Object.assign(spec.design, { conversationsPerCorpus: 16, families: 16, conversationsPerFamily: 2, shards: 1, perCorpusPerShard: 16 });
  const path = join(dir, "spec.json"); await writeFile(path, JSON.stringify(spec));
  const run = (output, replications = "100000", scenario = "improved-target-icc-0.2-rho-0.5") => spawnSync(process.execPath, [new URL("../continuity-holdout-power.mjs", import.meta.url).pathname, "--seed", "572913", "--replications", replications, "--statistical-spec", path, "--scenario", scenario, "--output", output], { encoding: "utf8", timeout: 180000 });
  const a = run(join(dir, "a")), b = run(join(dir, "b"));
  expect(a.status, a.stderr).toBe(0); expect(b.status, b.stderr).toBe(0);
  expect(a.stdout).toBe(b.stdout);
  expect(await readFile(join(dir, "a/power.md"), "utf8")).toBe(await readFile(join(dir, "b/power.md"), "utf8"));
  const report = JSON.parse(a.stdout); expect(report.replications).toBe(100000);
  expect(report.schema).toBe("holdout-power-v2");
  expect(report.scenarioSelection).toBe("improved-target-icc-0.2-rho-0.5");
  expect(report.scenarios).toHaveLength(1); expect(report.scenarios[0].families).toBe(16);
  expect(report.scenarios[0].conversationsPerFamily).toBe(2);
  expect(report.scenarios[0].gatePassRates["combined:benefit"].rate).toBeGreaterThan(0);
  expect(report.scenarios[0].gatePassRates["holdout-hard:native"].rate).toBeGreaterThan(0);
  expect(report.scenarios[0].jointAcceptance.rate).toBeGreaterThan(0);
  expect(report.scenarios[0].jointAcceptance.rate).toBeLessThan(1);
  expect(report.calibrationPass).toBe(null); // Target-only analysis cannot claim null calibration.
  expect(report.statisticalSpec.confidenceByGate).toEqual({ pack: 0.97, native: 0.95, benefit: 0.95 });
  const invalid = run(join(dir, "invalid"), "99999"); expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("invalid_power_design");
  const unknown = run(join(dir, "unknown"), "100000", "unregistered-scenario");
  expect(unknown.status).toBe(1); expect(unknown.stderr).toContain("invalid_power_scenario");
  expect(POWER_SCENARIOS.slice(0, 65).every(s => !s.stress && !s.reference && (s.name.startsWith("improved-target") || ["pack", "native", "benefit:combined", "benefit:corpus"].includes(s.boundary)))).toBe(true);
  expect(() => simulatePower({ scenarios: [{ ...POWER_SCENARIOS[0], errorCount: 0 }] })).toThrow("invalid_power_scenario");
}, 360000);


describe("review regression contracts", () => {
  it.each(["stale", "conflicted", "violation", "leaked", "abstained", "empty"])("classifies %s from raw answers, not the abstained flag", outcome => {
    const rows = trials();
    const examples = {
      stale: [{ score: { kind: "value", accept: ["fresh"], superseded: ["stale"] } }, "stale UNKNOWN"],
      conflicted: [{ score: { kind: "value", accept: ["fresh"], superseded: ["stale"] } }, "fresh stale UNKNOWN"],
      violation: [{ score: { kind: "constraint_task", forbidden: ["forbidden"] } }, "forbidden UNKNOWN"],
      leaked: [{ score: { kind: "redaction", secret: "SYNTHETICSECRET" } }, "SYNTHETICSECRET UNKNOWN"],
      abstained: [{ score: { kind: "value", accept: ["fresh"], superseded: ["stale"] } }, "UNKNOWN"],
      empty: [{ score: { kind: "value", accept: ["fresh"], superseded: ["stale"] } }, ""],
    };
    const result = scoreAnswer(...examples[outcome]); expect(result.outcome).toBe(outcome);
    if (outcome !== "empty") expect(result.abstained).toBe(true);
    ledger(rows)[0].score = result; ledger(rows)[0].answer = examples[outcome][1];
    const scope = score(rows).scopes["holdout-hard"], expected = ["abstained", "empty"].includes(outcome) ? 0 : 1;
    expect(scope.ledgerWrong).toBe(expected); expect(scope.discordances["cold-rebuild"].ledgerOnlyKnownWrong).toBe(expected);
  });
  it.each(["wrong-rate", "accuracy", "safety", "benefit"])("retains an established %s failure with missing data", gate => {
    const rows = trials(), ls = ledger(rows);
    if (gate === "wrong-rate") ls.slice(0, 200).forEach(t => { t.score = { pass: false, outcome: "wrong", abstained: false }; });
    if (gate === "accuracy") ls.slice(0, 2000).forEach(t => { t.answer = "UNKNOWN"; t.score = { pass: false, outcome: "abstained", abstained: true }; });
    if (gate === "safety") ls.filter(t => t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 100).forEach(t => { t.score = { pass: false, outcome: "wrong", abstained: false }; });
    if (gate === "benefit") {
      ls.forEach(t => { t.answer = "UNKNOWN"; t.score = { pass: false, outcome: "abstained", abstained: true }; });
      rows.filter(t => t.arm === "continuity-pack-cold").forEach(t => { t.score = { pass: true, outcome: "correct", abstained: false }; });
    }
    rows.splice(rows.findIndex(t => t.arm === "continuity-ledger-cold" && t.traceId === "fixture-255"), 1);
    const result = score(rows); expect(result.decision.status).toBe("fail");
    const reason = gate === "accuracy" ? "accuracy:fail" : `holdout-hard:${gate === "safety" ? "safety:continuity-pack-cold" : gate}:fail`;
    expect(result.decision.reasons).toContain(reason);
    expect(result.scopes.combined.benefit).toBe(null);
  });
  it("retains known audit failures when auditing is incomplete", () => {
    const result = holdoutStatistics({ conversations, trials: [], measurement: true, audit: { ...audit, audited: 100, complete: false, labelFindings: 11 } });
    expect(result.decision.reasons).toContain("audit-label:fail"); expect(result.decision.status).toBe("fail");
  });
  it("bounds missing pack slots in both directions without complete-case inference", () => {
    const rows = trials();
    ledger(rows).filter(t => t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 40).forEach(t => { t.score = { pass: false, outcome: "wrong", abstained: true }; });
    const filtered = rows.filter(t => !(t.arm === "continuity-pack-cold" && t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 40));
    const safety = score(filtered).scopes["holdout-hard"].safety["continuity-pack-cold"];
    expect(safety.interval).toBe(null); expect(safety.status).toBe("inconclusive");
    expect(safety.bestCompletionLower).toBeLessThan(0.005); expect(safety.worstCompletionUpper).toBeGreaterThan(0.005);
  });
  it("preserves the non-monotone +1 counterexample and bounds sampled completions", () => {
    const fixed = Array(127).fill(0.0201), bounds = fixed.map(v => [v, v]).concat([[-1, 1]]);
    expect(pairedT([...fixed, 1]).lower).toBeLessThan(0.02);
    expect(pairedT([...fixed, 0.0201]).lower).toBeGreaterThan(0.02);
    expect(completionUpperBound(bounds)).toBeGreaterThan(0.02);
    const random = seeded(8231);
    for (let i = 0; i < 200; i++) {
      const intervals = Array.from({ length: 16 }, () => { const lo = random() * 2 - 1; return [lo, lo + random() * (1 - lo)]; });
      const completion = intervals.map(([lo, hi]) => lo + random() * (hi - lo));
      expect(pairedT(completion).upper).toBeLessThanOrEqual(completionUpperBound(intervals));
    }
  });
  it("shares power/scoring gates and matches 200 sampled paired-t decisions", () => {
    const evaluator = gateEvaluator(), random = seeded(88432), n = STATISTICAL_SPEC.design.conversationsPerCorpus;
    for (let i = 0; i < 200; i++) {
      const values = Array.from({ length: n }, () => random() * 2 - 1), interval = familyT(values);
      const result = evaluator.benefit(values.reduce((a, b) => a + b, 0), values.reduce((a, b) => a + b * b, 0), values.reduce((a, b) => a + b ** 3, 0), n, true);
      const safety = evaluator.safety(values.reduce((a, b) => a + b, 0), values.reduce((a, b) => a + b * b, 0), values.reduce((a, b) => a + b ** 3, 0), n, "continuity-pack-cold");
      const packInterval = familyT(values, 0.97);
      expect(safety.interval).toEqual(packInterval);
      expect(safety.status).toBe(packInterval.upper <= 0.005 ? "pass" : packInterval.lower > 0.005 ? "fail" : "inconclusive");
      expect(result.interval).toEqual(interval);
      expect(result.status).toBe(interval.lower > 0.02 ? "pass" : interval.upper <= 0.02 ? "fail" : "inconclusive");
    }
  });
  it("accepts parameterized layouts but rejects inconsistent totals", () => {
    const options = registrationOptions(), changed = structuredClone(STATISTICAL_SPEC);
    changed.design.shards = 16; changed.design.perCorpusPerShard = 16; changed.design.shardCostCapUSD = 30;
    expect(validateStatisticalSpec(changed)).toBe(true);
    expect(digest(createRegistration({ ...options, statisticalSpec: changed }))).not.toBe(digest(createRegistration(options)));
    const broken = structuredClone(STATISTICAL_SPEC); broken.design.shards = 31;
    expect(() => validateStatisticalSpec(broken)).toThrow("invalid_statistical_design");
    expect(() => createRegistration({ ...options, conversations: conversations.slice(1) })).toThrow("invalid_planned_holdout");
  });
  it("forces offline analysis inconclusive and binds exact audit bytes to registration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holdout-audit-fixture-")); scratch.push(directory);
    const registrationSha256 = "f".repeat(64), path = join(directory, "audit.json");
    const input = { ...audit, labelFindings: 11, registrationSha256 };
    await writeFile(path, JSON.stringify(input));
    const bound = await readBoundAudit(path, registrationSha256);
    expect(bound.binding).toEqual({ sha256: sha256(await readFile(path)), registrationSha256 });
    await writeFile(path, JSON.stringify(input) + "\n");
    expect((await readBoundAudit(path, registrationSha256)).binding.sha256).not.toBe(bound.binding.sha256);
    const plan = makePlan({ suite: "holdout", traces: [], sha256: "a".repeat(64), repeats: 2, arms: HOLDOUT_ARMS, profile: { judge: null },
      holdout: { conversations, statisticalSpec: STATISTICAL_SPEC, registrationSha256, models: holdoutModels() } });
    for (const mode of ["offline", "real"]) {
      const output = join(directory, mode); await mkdir(join(output, "units"), { recursive: true });
      const observedWrong = ledger(trials()).slice(0, 200).map(t => ({ ...t, score: { pass: false, outcome: "wrong", abstained: true } }));
      await writeFile(join(output, "units/partial.json"), JSON.stringify({ confirmation: plan.confirmation, executionKind: mode,
        complete: false, arm: "continuity-ledger-cold", trials: [...observedWrong, { status: "not_started" }] }));
      const result = await aggregate({ plan, traces: [], output, mode, auditPath: path });
      expect(result.coverage.unitsComplete).toBe(0);
      expect(result.summary.holdout.integrity.unknownTrials).toBe(0);
      expect(result.summary.holdout.integrity.notStartedPlaceholders).toBe(1);
      for (const scope of Object.values(result.summary.holdout.scopes)) {
        if (mode === "offline") {
          expect(scope.wrongStatus).toBe("not_a_measurement"); expect(scope.benefitStatus).toBe("not_a_measurement");
          expect(Object.values(scope.safety).every(s => s.status === "not_a_measurement")).toBe(true);
        }
      }
      expect(result.summary.holdout.scopes["holdout-hard"].wrongStatus).toBe(mode === "offline" ? "not_a_measurement" : "fail");
      expect(result.summary.holdout.scopes["holdout-hard"].ledgerWrong).toBe(200);
      expect(renderMarkdown(result.summary, { qualityMeasured: false })).toContain("Decision: **inconclusive**");
      expect(renderMarkdown(result.summary, { qualityMeasured: false })).toContain("not_a_measurement");
      expect(renderMarkdown(result.summary, { qualityMeasured: false })).toContain("pack 97%; native 95%; benefit 95%");
      expect(result.summary.holdout.auditBinding.sha256).toBe(sha256(await readFile(path)));
      expect(result.summary.holdout.auditBinding.registrationSha256).toBe(registrationSha256);
      expect(result.summary.holdout.decision.status).toBe(mode === "offline" ? "inconclusive" : "fail");
      if (mode === "offline") expect(result.summary.holdout.decision.reasons).toEqual(["not_a_measurement"]);
      else expect(result.summary.holdout.decision.reasons).toContain("audit-label:fail");
    }
    await expect(aggregate({ plan: { ...plan, holdout: { ...plan.holdout, models: { ...holdoutModels(), reader: "fixture:synthetic" } } },
      traces: [], output: directory, mode: "real" })).rejects.toThrow("holdout_measurement_requires_real_models");
    await writeFile(path, JSON.stringify({ ...input, registrationSha256: "e".repeat(64) }));
    await expect(readBoundAudit(path, registrationSha256)).rejects.toThrow("audit_registration_mismatch");
    await expect(aggregate({ plan, traces: [], output: join(directory, "offline"), mode: "offline", auditPath: path })).rejects.toThrow("audit_registration_mismatch");
  });
});


it.each([
  ["confidence", 0.9], ["confidenceByGate.pack", 0.95], ["confidenceByGate.pack", 0.975],
  ["confidenceByGate.native", 0.97], ["confidenceByGate.benefit", 0.97], ["safety.maximumByComparator.continuity-pack-cold", 1], ["safety.maximumByComparator.native", 1], ["safety.wrongRateMaximum", 1],
  ["benefit.combinedMinimumExclusive", 0], ["benefit.corpusMinimumExclusive", -1], ["accuracyMinimum", 0],
  ["audit.labelNumerator", 11], ["audit.contextNumerator", 6], ["audit.referenceDenominator", 364],
  ["audit.falselySupersededMaximum", 1], ["audit.bindingErrorsMaximum", 1],
])("rejects a changed approved gate: %s", (path, value) => {
  const changed = structuredClone(STATISTICAL_SPEC), keys = path.split("."), last = keys.pop();
  let parent = changed; for (const key of keys) parent = parent[key]; parent[last] = value;
  expect(() => validateStatisticalSpec(changed)).toThrow("unregistered_statistical_spec");
  expect(() => createRegistration({ ...registrationOptions(), statisticalSpec: changed })).toThrow("unregistered_statistical_spec");
});
it.each(["correct", "stale", "conflicted", "violation", "leaked", "abstained", "empty", "wrong", "fabricated"])("rejects pass/outcome disagreement for %s", outcome => {
  const rows = trials(); ledger(rows)[0].score = { outcome, pass: outcome !== "correct" };
  const result = score(rows); expect(result.integrity.complete).toBe(false);
  expect(result.scopes.combined.ledgerMissing).toBe(1); expect(result.decision.status).toBe("pass");
});
it.each(["reader", "extractor", "alternate"].flatMap(role => ["fixture", "faux"].map(provider => [role, provider])))("rejects a real holdout %s on %s models", (role, provider) => {
  expect(() => assertRealHoldoutModels({ ...holdoutModels(), [role]: `${provider}:synthetic` })).toThrow("holdout_measurement_requires_real_models");
  expect(() => assertRealHoldoutModels(holdoutModels())).not.toThrow();
});
it("keeps offline complete counts/intervals diagnostic without per-scope verdicts", () => {
  const result = holdoutStatistics({ conversations, trials: trials(), audit });
  expect(result.scopes.combined.benefit.n).toBe(256);
  expect(result.scopes.combined.ledgerWrong).toBe(0);
  for (const scope of Object.values(result.scopes)) {
    expect(scope.wrongStatus).toBe("not_a_measurement"); expect(scope.benefitStatus).toBe("not_a_measurement");
    expect(Object.values(scope.safety).every(s => s.status === "not_a_measurement" && s.interval)).toBe(true);
  }
});


describe("registered v2 quality rule", () => {
  it.each([["continuity-pack-cold", 0.005], ["native", 0.02]])("uses inclusive exact %s upper margins", (comparator, margin) => {
    const gate = gateEvaluator();
    const at = gate.safety(2 * margin, 2 * margin * margin, 2 * margin ** 3, 2, comparator);
    expect(at.interval.upper).toBe(margin); expect(at.status).toBe("pass");
    const above = margin + 1e-6;
    expect(gate.safety(2 * above, 2 * above * above, 2 * above ** 3, 2, comparator).status).toBe("fail");
    expect(gate.safety(0, 0, 0, 128, comparator).status).toBe("pass");
    expect(gate.safety(1 / 60, 1 / 3600, 1 / 216000, 128, comparator).status).toBe("pass");
  });
  it("pins point boundaries and strict benefit lower endpoints", () => {
    const gate = gateEvaluator();
    expect(gate.wrongRate(2, 100)).toBe("pass"); expect(gate.wrongRate(2.00001, 100)).toBe("fail");
    expect(gate.accuracy(91875, 0, 100000)).toBe("pass"); expect(gate.accuracy(91874, 0, 100000)).toBe("fail");
    expect(gate.benefit(0.04, 0.0008, 0.000016, 2, true).status).toBe("fail");
    expect(gate.benefit(0, 0, 0, 2, false).status).toBe("fail");
    expect(gate.benefit(0.040002, 2 * 0.020001 ** 2, 2 * 0.020001 ** 3, 2, true).status).toBe("pass");
  });
  it("retains reverse discordances without gating any-wrong conversation risks", () => {
    const rows = trials();
    rows.filter(t => t.arm === "continuity-pack-cold" && t.traceId === "fixture-0").forEach(t => { t.answer = "Fixture wrong answer."; t.score = { pass: false, outcome: "wrong" }; });
    const scope = score(rows).scopes["holdout-hard"];
    expect(scope.discordances["continuity-pack-cold"]).toMatchObject({ ledgerOnlyKnownWrong: 0, comparatorOnlyKnownWrong: 1 });
    expect(scope.safety["continuity-pack-cold"].interval.mean).toBe(-1 / 256);
  });
  it("does not fail a study for a completely wrong cold arm", () => {
    const rows = trials(); rows.filter(t => t.arm === "cold-rebuild").forEach(t => { t.score = { pass: false, outcome: "wrong" }; });
    const result = score(rows); expect(result.decision.status).toBe("pass");
    expect(result.scopes.combined.descriptive["cold-rebuild"].wrongRate).toBe(1);
    expect(result.decision.gates.some(g => g.name.includes("cold-rebuild"))).toBe(false);
  });
  it("rejects incompatible registrations/specs with stable version errors", () => {
    const registration = createRegistration(registrationOptions());
    expect(registration.schema).toBe("holdout-registration-v2");
    expect(() => validateRegistrationVersion({ ...registration, schema: "holdout-registration-v1" })).toThrow("incompatible_holdout_registration_version");
    const oldSpec = { ...STATISTICAL_SPEC, schema: "holdout-statistical-spec-v1" };
    expect(() => validateStatisticalSpec(oldSpec)).toThrow("incompatible_statistical_spec_version");
    expect(() => validateRegistrationVersion({ ...registration, statisticalSpec: oldSpec })).toThrow("incompatible_statistical_spec_version");
  });
});


describe("family-clustered tighten-only inference", () => {
  it("matches hand-calculated adjusted sample skew and endpoints", () => {
    // x=[0,0,0,4]: mean=1, sd=2, SE=1, adjusted sample skew=2.
    const t = tQuantile(0.95, 3), adjustment = 2 * (1 + 2 * t * t) / 12;
    const positive = familyT([0, 0, 0, 4]), negative = familyT([0, 0, 0, -4]);
    expect(positive.mean).toBe(1); expect(positive.se).toBe(1); expect(positive.skew).toBe(2);
    expect(positive.upper).toBeCloseTo(1 + t + adjustment, 13);
    expect(positive.lower).toBeCloseTo(1 - t, 13);
    expect(negative.upperAdjustment).toBe(0); expect(negative.upper).toBeCloseTo(-1 + t, 13);
    expect(negative.lower).toBeCloseTo(-1 - t - adjustment, 13);
    const constant = familyT(Array(128).fill(1 / 15));
    expect(constant).toMatchObject({ se: 0, skew: 0 });
    expect(constant.upper).toBeCloseTo(1 / 15, 14); expect(constant.lower).toBeCloseTo(1 / 15, 14);
  });
  it("never loosens plain t, and bounds all sampled missing completions", () => {
    const random = seeded(77424);
    for (let draw = 0; draw < 250; draw++) {
      const bounds = Array.from({ length: 8 }, () => { const lo = random() * 2 - 1; return [lo, lo + random() * (1 - lo)]; });
      const envelope = familyCompletionBounds(bounds);
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const values = bounds.map(([lo, hi]) => lo + fraction * (hi - lo));
        const result = familyT(values), plain = pairedT(values);
        expect(result.upper).toBeGreaterThanOrEqual(plain.upper - 1e-12);
        expect(result.lower).toBeLessThanOrEqual(plain.lower + 1e-12);
        expect(result.upper).toBeLessThanOrEqual(envelope.upper);
        expect(result.lower).toBeGreaterThanOrEqual(envelope.lower);
      }
    }
    const fixed = [[0, 0], [0, 0], [0.5, 0.5]];
    expect(familyCompletionBounds(fixed)).toEqual({ lower: familyT([0, 0, 0.5]).lower, upper: familyT([0, 0, 0.5]).upper });
  });
  it("can lose pack non-inferiority because of one bad family", () => {
    const rows = trials(); ledger(rows).filter(t => t.traceId === "fixture-0" || t.traceId === "fixture-1").forEach(t => { t.score = { pass: false, outcome: "wrong" }; });
    const result = score(rows);
    expect(result.scopes["holdout-hard"].families).toBe(128); expect(result.scopes.combined.families).toBe(256);
    expect(result.scopes["holdout-hard"].safety["continuity-pack-cold"].status).not.toBe("pass");
    expect(result.scopes["holdout-hard"].safety.native.interval.icc).toBeCloseTo(1, 12);
    expect(result.scopes["holdout-hard"].safety.native.interval.designEffect).toBeCloseTo(2, 12);
    // A single bad family can also turn a sub-ceiling background into an established point-rule failure.
    ledger(rows).filter(t => !["fixture-0", "fixture-1"].includes(t.traceId)).slice(0, 100).forEach(t => { t.score = { pass: false, outcome: "wrong" }; });
    expect(score(rows).decision.reasons).toContain("holdout-hard:wrong-rate:fail");
  });
  it("pins inference and analytically targets the D ICC with exactly preserved means", () => {
    for (const icc of [0, 0.1, 0.2, 0.35]) for (const rho of [0, 0.5, 0.9]) {
      const { r } = familyEffectParameters(icc, rho), a = (1 + rho) / 2;
      expect(r / (a + (1 - a) * r)).toBeCloseTo(icc, 14);
    }
    const changed = structuredClone(STATISTICAL_SPEC); changed.inference.combined = "corpus-stratified";
    expect(() => validateStatisticalSpec(changed)).toThrow("unregistered_statistical_spec");
  });
});


describe("registered alternative B confidence levels", () => {
  it("matches hand-calculated 97% pack endpoints and keeps negative-skew U plain t", () => {
    // Independent df=3 closed-form CDF inversion: F(t)=.5+[atan(r)+r/(1+r²)]/pi, r=t/sqrt(3).
    const t97 = 2.950510470082926, adjustment = 3.068504011356323;
    expect(tQuantile(0.97, 3)).toBeCloseTo(t97, 12);
    const upper = familyT([0, 0, 0, 4], 0.97), reflected = familyT([0, 0, 0, -4], 0.97);
    expect(upper).toMatchObject({ mean: 1, se: 1, skew: 2, confidence: 0.97 });
    expect(upper.upperAdjustment).toBeCloseTo(adjustment, 12);
    expect(upper.upper).toBeCloseTo(7.019014481439249, 12);
    expect(upper.lower).toBeCloseTo(1 - t97, 12);
    expect(reflected.upperAdjustment).toBe(0); expect(reflected.upper).toBeCloseTo(-1 + t97, 12);
    expect(reflected.lower).toBeCloseTo(-1 - t97 - adjustment, 12);
    const evaluator = gateEvaluator(), moments = [4, 16, 64, 4];
    expect(evaluator.safety(...moments, "continuity-pack-cold").interval).toEqual(upper);
    expect(evaluator.safety(...moments, "native").interval).toEqual(familyT([0, 0, 0, 4], 0.95));
    expect(evaluator.benefit(...moments, true).interval).toEqual(familyT([0, 0, 0, 4], 0.95));
    expect(evaluator.safety(0.01, 0.00005, 0.00000025, 2, "continuity-pack-cold")).toMatchObject({ status: "pass", interval: { upper: 0.005, confidence: 0.97 } });
    const above = 0.005001;
    expect(evaluator.safety(2 * above, 2 * above ** 2, 2 * above ** 3, 2, "continuity-pack-cold").status).toBe("fail");
  });
  it("uses each gate's confidence in its conservative missing envelope and reporting", () => {
    const rows = trials(); rows.splice(rows.findIndex(t => t.arm === "continuity-ledger-cold"), 1);
    const result = score(rows), scope = result.scopes["holdout-hard"];
    const bounds = [[0, 1 / 60], ...Array.from({ length: 127 }, () => [0, 0])];
    expect(scope.safety["continuity-pack-cold"].worstCompletionUpper).toBe(familyCompletionBounds(bounds, 0.97).upper);
    expect(scope.safety.native.worstCompletionUpper).toBe(familyCompletionBounds(bounds, 0.95).upper);
    expect(result.confidenceByGate).toEqual({ pack: 0.97, native: 0.95, benefit: 0.95 });
    expect(result.decision.gates.find(g => g.name === "holdout-hard:safety:continuity-pack-cold").confidence).toBe(0.97);
    expect(result.decision.gates.find(g => g.name === "holdout-hard:benefit").confidence).toBe(0.95);
    const values = bounds.map(([lo, hi]) => (lo + hi) / 2), envelope = familyCompletionBounds(bounds, 0.97);
    expect(familyT(values, 0.97).upper).toBeLessThanOrEqual(envelope.upper);
    expect(familyT(values, 0.97).lower).toBeGreaterThanOrEqual(envelope.lower);
  });
  it("rejects the all-95% round-1 semantic spec and unregistered per-gate levels", () => {
    const round1 = structuredClone(STATISTICAL_SPEC); delete round1.confidenceByGate; round1.confidence = 0.95;
    expect(() => validateStatisticalSpec(round1)).toThrow("unregistered_statistical_spec");
    expect(() => createRegistration({ ...registrationOptions(), statisticalSpec: round1 })).toThrow("unregistered_statistical_spec");
    for (const key of ["pack", "native", "benefit"]) {
      const changed = structuredClone(STATISTICAL_SPEC); changed.confidenceByGate[key] -= 0.01;
      expect(() => validateStatisticalSpec(changed)).toThrow("unregistered_statistical_spec");
    }
  });
});


describe("pure abstention and completion regressions", () => {
  it.each(["", "  ", "UNKNOWN", " ‘unknown!’ ", "I don’t know.", "I do not know", "Not stated", "NOT MENTIONED!", "N / A", "N.A."])("recognizes only a whole abstention: %s", answer => {
    expect(pureAbstention(answer)).toBe(true);
  });
  it.each([undefined, null, 42, "...", "Use fathoms; the excluded terms were not mentioned.", "I don't know exactly, perhaps PARCELMALLOW"])("fails closed for missing or substantive text: %s", answer => {
    expect(pureAbstention(answer)).toBe(false);
  });
  it.each(HOLDOUT_ARMS)("uses the raw predicate for %s gates, point counts and descriptive W", arm => {
    const examples = [
      ["UNKNOWN", { kind: "identifier", accept: ["PARCELASTER"], reject: ["PARCELBIRCH"] }, 0],
      ["Use fathoms; the excluded terms were not mentioned.", { kind: "constraint_recall", requireAll: [["FixtureRequired"]] }, 1],
      ["I don't know exactly, perhaps PARCELMALLOW", { kind: "identifier", accept: ["PARCELASTER"], reject: ["PARCELBIRCH"] }, 1],
      [undefined, null, 1],
    ];
    for (const [answer, key, expected] of examples) {
      const rows = trials(), trial = rows.find(t => t.arm === arm);
      trial.answer = answer; trial.score = key ? scoreAnswer({ score: key }, answer) : { pass: false, outcome: "abstained" };
      expect(trial.score.outcome).toBe("abstained"); // Existing scorer remains unchanged, including hedged cases.
      const scope = score(rows).scopes["holdout-hard"];
      expect(scope.descriptive[arm].wrong).toBe(expected); expect(scope.descriptive[arm].wrongRate).toBe(expected / 7680);
      if (arm === "continuity-ledger-cold") {
        expect(scope.ledgerWrong).toBe(expected); expect(scope.ledgerWrongRate).toBe(expected / 7680);
        expect(scope.safety.native.interval.mean).toBeCloseTo(expected / 7680, 13);
        expect(scope.safety["continuity-pack-cold"].interval.mean).toBeCloseTo(expected / 7680, 13);
      }
      trial.score = { pass: true, outcome: "correct" }; delete trial.answer;
      expect(score(rows).scopes["holdout-hard"].descriptive[arm].wrong).toBe(0);
    }
  });
  it("nulls incomplete arm outcome rates/risks but retains known counts and missingness", () => {
    const rows = trials(), index = rows.findIndex(t => t.arm === "cold-rebuild"); rows.splice(index, 1);
    const scope = score(rows).scopes["holdout-hard"], cold = scope.descriptive["cold-rebuild"];
    expect(cold).toMatchObject({ complete: false, missing: 1, correct: 7679, wrong: 0, anyWrongRisk: null, correctRate: null, wrongRate: null, abstainedOrEmptyRate: null });
    expect(cold.missingRate).toBe(1 / 7680); expect(scope.descriptive.native.correctRate).toBe(1);
  });
  // Independently generated with Python Decimal at 70-digit precision (confirmed at 50):
  // t=sqrt(df)*tan(theta), F(t)=1/2+[4^k(k!)²/((2k)!pi)]*integral_0^theta cos^(2k)(u) du,
  // df=2k+1; even-cosine reduction recurrence + arctan series and 240 bisection steps.
  // This is independent of the JS incomplete-beta/Lanczos implementation.
  it.each([[0.95, 127, 1.6569403435420646592], [0.97, 127, 1.8977419806344177570],
    [0.95, 255, 1.6508510924986625441], [0.97, 255, 1.8891970911838422851]])("matches independent t(%s,%i)", (confidence, df, reference) => {
    expect(tQuantile(confidence, df)).toBeCloseTo(reference, 10);
  });
  it("encloses 200 independently randomized family-wise corner completions at both confidence levels", () => {
    const random = seeded(783421), bounds = Array.from({ length: 128 }, () => {
      const lo = random() * 2 - 1; return [lo, lo + random() * (1 - lo)];
    });
    for (const confidence of [0.95, 0.97]) {
      const envelope = familyCompletionBounds(bounds, confidence);
      for (let draw = 0; draw < 200; draw++) {
        const completion = bounds.map(([lo, hi]) => random() < 0.5 ? lo : hi), result = familyT(completion, confidence);
        expect(result.upper).toBeLessThanOrEqual(envelope.upper); expect(result.lower).toBeGreaterThanOrEqual(envelope.lower);
      }
    }
  });
});
