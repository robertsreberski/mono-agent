import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { clopperPearson, pairedT, tQuantile, betaCdf, betaQuantile, holdoutStatistics, HOLDOUT_ARMS, STATISTICAL_SPEC } from "../lib/continuity-holdout-statistics.mjs";
import { createRegistration, holdoutModels } from "../lib/continuity-holdout-registration.mjs";
import { effectDistribution, safetyPower } from "../lib/continuity-holdout-power.mjs";
import { makePlan, digest } from "../lib/continuity-dataset.mjs";
import { profileFrom, parseArguments } from "../continuity-benchmark.mjs";

const conversations = Array.from({ length: 256 }, (_, i) => ({ id: `fixture-${i}`, corpus: i < 128 ? "holdout-hard" : "holdout-hard-distractors", probes: Array.from({ length: 15 }, (_, j) => `p${String(j + 1).padStart(2, "0")}`) }));
const audit = { published: 363, audited: 363, labelFindings: 10, contextFindings: 5, falselySupersededCurrent: 0, bindingErrors: 0, complete: true };
function trials() {
  return conversations.flatMap(c => HOLDOUT_ARMS.flatMap(arm => [1, 2].flatMap(repeat => c.probes.map(probeId => {
    const pass = arm !== "continuity-pack-cold" || probeId !== "p01";
    return { traceId: c.id, probeId, arm, repeat, status: "completed", score: { pass, abstained: !pass, outcome: pass ? "correct" : "abstained" } };
  }))));
}
const score = rows => holdoutStatistics({ conversations, trials: rows, audit });
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
    expect(result.plannedAnswersPerArm).toBe(7680); expect(result.scopes["holdout-hard"].plannedAnswers).toBe(3840);
    expect(result.scopes.combined.benefit.n).toBe(256); expect(result.audit.labelRate).toBe(10 / 363);
    expect(result.scopes.combined.ledgerAccuracy).toBe(1);
    expect(holdoutStatistics({ conversations, trials: trials(), audit: { ...audit, labelFindings: 11 } }).decision.reasons).toContain("audit-label:fail");
    expect(holdoutStatistics({ conversations, trials: trials(), audit: { ...audit, contextFindings: 6 } }).decision.reasons).toContain("audit-context:fail");
    expect(holdoutStatistics({ conversations, trials: trials() }).decision.status).toBe("inconclusive");
  });
  it("is invariant to probe/repeat order and uses conversations, not independent answers", () => {
    const rows = trials(), first = score(rows);
    expect(score([...rows].reverse())).toEqual(first);
    expect(score(rows.map(t => ({ ...t, repeat: 3 - t.repeat })))).toEqual(first);
    const affected = ledger(rows).filter(t => t.traceId === "fixture-0");
    affected.slice(0, 20).forEach(t => { t.score = { pass: false, abstained: false }; });
    const result = score(rows), corpus = result.scopes["holdout-hard"];
    expect(corpus.safety["cold-rebuild"].harmful).toBe(1);
    expect(corpus.safety["cold-rebuild"].interval.upper).toBeCloseTo(clopperPearson(1, 128).upper, 14);
    expect(result.decision.reasons).toContain("holdout-hard:wrong-rate:fail");
  });
  it("distinguishes a straddling safety interval from an established failure", () => {
    const rows = trials(); ledger(rows).filter(t => t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 3).forEach(t => { t.score = { pass: false, abstained: false }; });
    expect(score(rows).scopes["holdout-hard"].safety["cold-rebuild"].status).toBe("inconclusive");
    ledger(rows).filter(t => t.repeat === 1 && t.probeId === "p01" && Number(t.traceId.slice(8)) < 30).forEach(t => { t.score = { pass: false, abstained: false }; });
    expect(score(rows).scopes["holdout-hard"].safety["cold-rebuild"].status).toBe("fail");
  });
  it.each(["missing", "invalid", "duplicate", "unknown", "native"])("never accepts %s data or produces complete-case inference", kind => {
    const rows = trials();
    if (kind === "missing") rows.splice(rows.findIndex(t => t.arm === "continuity-ledger-cold"), 1);
    if (kind === "invalid") ledger(rows)[0].status = "boundary_unverified";
    if (kind === "duplicate") rows.push(structuredClone(ledger(rows)[0]));
    if (kind === "unknown") rows.push({ ...rows[0], traceId: "unknown" });
    if (kind === "native") rows.splice(rows.findIndex(t => t.arm === "native"), 1);
    const result = score(rows);
    expect(result.decision.status).not.toBe("pass"); expect(result.integrity.complete).toBe(false);
    expect(result.scopes.combined.benefit).toBe(null); expect(result.scopes.combined.safety["cold-rebuild"].interval).toBe(null);
    expect(result.scopes.combined.plannedAnswers).toBe(7680);
    if (["missing", "invalid", "duplicate"].includes(kind)) expect(result.scopes.combined.ledgerAccuracy).toBe(7679 / 7680);
  });
});

describe("registration and confirmation", () => {
  it("deterministically creates balanced disjoint shards and binds all inputs", () => {
    const options = registrationOptions(), registration = createRegistration(options);
    expect(createRegistration({ ...options, conversations: [...conversations].reverse() })).toEqual(registration);
    const ids = registration.shards.flatMap(s => s.conversations); expect(ids).toHaveLength(256); expect(new Set(ids).size).toBe(256);
    for (const shard of registration.shards) {
      expect(shard.conversations).toHaveLength(16);
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
    expect(() => createRegistration({ ...registrationOptions(), statisticalSpec: { ...STATISTICAL_SPEC, accuracyMinimum: 0.5 } })).toThrow("unregistered_statistical_spec");
    expect(() => createRegistration({ ...registrationOptions(), models: { ...holdoutModels(), judge: "fixture:judge" } })).toThrow("invalid_holdout_models");
    expect(profileFrom(parseArguments([])).repeats).toBe(1);
    expect(profileFrom(parseArguments(["--suite", "hard"])).arms).not.toEqual(HOLDOUT_ARMS);
  });
});

const scratch = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });
it("enumerates exact safety power and preserves the specified effect moments", () => {
  const power = safetyPower(0.005); expect(power.largestAcceptedCount).toBe(2); expect(power.individualGatePower).toBeCloseTo(0.973, 2);
  for (const rho of [0, 0.5, 0.9]) {
    const { values, probabilities } = effectDistribution(rho), mean = values.reduce((s, v, i) => s + v * probabilities[i], 0);
    const variance = values.reduce((s, v, i) => s + (v - mean) ** 2 * probabilities[i], 0) * (1 + rho) / 2;
    expect(mean).toBeCloseTo(0.04, 14); expect(Math.sqrt(variance)).toBeCloseTo(0.12, 14);
  }
});
it("power CLI is deterministic at 100,000 replications and rejects smaller studies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "holdout-power-fixture-")); scratch.push(dir);
  const run = (output, replications = "100000") => spawnSync(process.execPath, [new URL("../continuity-holdout-power.mjs", import.meta.url).pathname, "--seed", "572913", "--replications", replications, "--output", output], { encoding: "utf8", timeout: 180000 });
  const a = run(join(dir, "a")), b = run(join(dir, "b"));
  expect(a.status, a.stderr).toBe(0); expect(b.status, b.stderr).toBe(0);
  expect(a.stdout).toBe(b.stdout);
  expect(await readFile(join(dir, "a/power.md"), "utf8")).toBe(await readFile(join(dir, "b/power.md"), "utf8"));
  expect(JSON.parse(a.stdout).replications).toBe(100000);
  const invalid = run(join(dir, "invalid"), "99999"); expect(invalid.status).toBe(1); expect(invalid.stderr).toContain("invalid_power_design");
}, 360000);
