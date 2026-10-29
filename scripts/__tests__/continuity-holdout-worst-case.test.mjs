import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOLDOUT_ARMS, STATISTICAL_SPEC, holdoutStatistics, completionLowerBound, pairedT, clopperPearson, validateStatisticalSpec } from "../lib/continuity-holdout-statistics.mjs";
import { CHECKOUT, jsonBytes, sha256 } from "../lib/continuity-holdout-files.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { seeded } from "../lib/continuity-holdout-registration.mjs";
import { syntheticContext } from "./fixtures/holdout-synthetic.mjs";
import { auditCheckpoint } from "./fixtures/holdout-audit-data.mjs";
const arm = "continuity-ledger-cold", pack = "continuity-pack-cold", cold = "cold-rebuild";
const conversations = Array.from({ length: 512 }, (_, i) => ({ id: `synthetic-${i}`, corpus: STATISTICAL_SPEC.design.corpora[Math.floor(i / 256)], family: `family-${Math.floor(i / 16)}`, probes: Array.from({ length: 15 }, (_, j) => `p${j}`) }));
const audit = { complete: true, published: 363, audited: 363, labelFindings: 0, contextFindings: 0, falselySupersededCurrent: 0, bindingErrors: 0 };
function trials(packAbstains = true) {
  return conversations.flatMap(c => HOLDOUT_ARMS.flatMap(a => [1, 2].flatMap(repeat => c.probes.map(probeId => ({ traceId: c.id, arm: a, repeat, probeId, status: "completed",
    score: a === pack && (packAbstains || probeId === "p0") ? { pass: false, outcome: "abstained" } : { pass: true, outcome: "correct" } })))));
}
const score = rows => holdoutStatistics({ conversations, trials: rows, audit, measurement: true });
const missing = (rows, a, count) => { let left = count; return rows.filter(t => !(t.arm === a && left-- > 0)); };
it("preserves all legacy complete-data scope fields and the decision", () => {
  const result = score(trials(false)); expect(result.decision.status).toBe("pass"); expect(result.decision.reasons).toEqual([]); expect(result.integrity.worstCase).toBe(false);
  for (const [name, scope] of Object.entries(result.scopes)) {
    const n = name === "combined" ? 512 : 256, cp = clopperPearson(0, n), benefit = pairedT(Array(n).fill(1 / 15));
    const { worstCase, worstCompletionLower, ...legacy } = scope;
    const safety = Object.fromEntries(Object.entries(legacy.safety).map(([key, { worstHarmful, ...row }]) => [key, row]));
    expect({ ...legacy, safety }).toEqual({ plannedConversations: n, plannedAnswers: n * 30, complete: true,
      safety: Object.fromEntries([cold, pack].map(key => [key, { harmful: 0, knownHarmful: 0, n, interval: cp, bestCompletion: cp, status: "pass" }])),
      benefit, benefitStatus: "pass", bestCompletionUpper: benefit.upper, ledgerCorrect: n * 30, ledgerMissing: 0, ledgerAccuracy: 1,
      bestCompletionAccuracy: 1, ledgerWrong: 0, ledgerWrongRate: 0, wrongStatus: "pass" });
    expect(worstCase).toBe(false); expect(worstCompletionLower).toBe(benefit.lower);
  }
});
it("passes one missing ledger slot with explicit worst-case flags and planned denominators", () => {
  const result = score(missing(trials(), arm, 1)); expect(result.decision.status).toBe("pass"); expect(result.integrity.complete).toBe(false);
  expect(result.integrity.worstCase).toBe(true); expect(result.integrity.missingPerArm[arm]).toBe(1); expect(result.scopes.combined.worstCase).toBe(true);
  expect(result.scopes.combined.safety[cold].worstHarmful).toBe(1); expect(result.scopes.combined.benefit).toBe(null);
});
it.each([153, 154])("enforces the registered integer cap with %i native misses", count => {
  const result = score(missing(trials(), "native", count)); expect(result.integrity.maximumMissingPerArm).toBe(153);
  expect(result.integrity.missingPerArm.native).toBe(count); expect(result.integrity.withinMissingCap).toBe(count === 153);
  expect(result.decision.status).toBe(count === 153 ? "pass" : "inconclusive");
  expect(result.decision.gates.filter(g => g.name !== "integrity").every(g => g.status === "pass")).toBe(true);
});
it.each(["wrong-rate", "safety", "accuracy"])("leaves worst-case %s uncertainty inconclusive, not failed", gate => {
  let rows = trials();
  if (gate === "wrong-rate") rows = missing(rows, arm, 39);
  if (gate === "safety") rows = rows.filter(t => !(t.arm === arm && t.repeat === 1 && t.probeId === "p0" && Number(t.traceId.slice(10)) < 7));
  if (gate === "accuracy") {
    const ls = rows.filter(t => t.arm === arm); ls.slice(0, 1248).forEach(t => { t.score = { pass: false, outcome: "abstained" }; });
    rows.splice(rows.indexOf(ls[1248]), 1);
  }
  const result = score(rows), key = gate === "accuracy" ? "accuracy" : `holdout-hard:${gate === "safety" ? `safety:${cold}` : gate}`;
  expect(result.decision.gates.find(g => g.name === key).status).toBe("inconclusive"); expect(result.decision.status).toBe("inconclusive");
});
it("fills a missing comparator wrong in its favour and can flip safety from pass", () => {
  let rows = trials();
  for (const row of rows) if (row.repeat === 1 && row.probeId === "p0" && (row.arm === arm && Number(row.traceId.slice(10)) < 7 || [cold, pack].includes(row.arm) && row.traceId === "synthetic-6")) row.score = { pass: false, outcome: "wrong" };
  expect(score(rows).decision.status).toBe("pass"); rows = rows.filter(t => !(t.arm === cold && t.traceId === "synthetic-6" && t.repeat === 1 && t.probeId === "p0"));
  const safety = score(rows).scopes["holdout-hard"].safety[cold]; expect(safety.knownHarmful).toBe(6); expect(safety.worstHarmful).toBe(7); expect(safety.status).toBe("inconclusive");
});
it("unknown rows still block acceptance and the registered cap cannot be relaxed", () => {
  const rows = trials(); rows.push({ ...rows[0], traceId: "unplanned" }); expect(score(rows).decision.status).toBe("inconclusive");
  for (const value of [0, 0.02, null]) { const changed = structuredClone(STATISTICAL_SPEC); changed.missingData.worstCaseCompletion.maximumMissingFractionPerArm = value; expect(() => validateStatisticalSpec(changed)).toThrow("unregistered_statistical_spec"); }
});
it("bounds random completions below their t lower endpoints and equals fixed samples", () => {
  const random = seeded(88031);
  for (let i = 0; i < 200; i++) {
    const bounds = Array.from({ length: 16 }, () => { const lo = random() * 2 - 1; return [lo, lo + random() * (1 - lo)]; });
    const values = bounds.map(([lo, hi]) => lo + random() * (hi - lo)); expect(completionLowerBound(bounds)).toBeLessThanOrEqual(pairedT(values).lower);
    expect(completionLowerBound(values.map(x => [x, x]))).toBe(pairedT(values).lower);
  }
  expect(completionLowerBound([[0, 0], [0, 0]])).toBe(0); expect(() => completionLowerBound([[2, 2], [0, 0]])).toThrow("invalid_completion_bounds");
});
const scratch = [];
afterEach(async () => { for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }); });
// Bulk producer of native-shaped synthetic artifacts, not a real/provider execution.
async function syntheticShards(directory, context, workflow, controller) {
  const roots = [];
  for (const bundle of context.plans) {
    const root = join(directory, `shard-${bundle.plan.holdout.shard}`), chunks = []; await mkdir(join(root, "chunks"), { recursive: true });
    for (const [i, planned] of bundle.chunks.entries()) {
      const output = join(root, "chunks", String(i + 1)), units = [], fails = bundle.plan.holdout.shard === 1 && i === 1; await mkdir(join(output, "units"), { recursive: true });
      const probes = bundle.plan.corpus.traces.find(t => t.id === planned.traceId).probes;
      for (const a of HOLDOUT_ARMS) for (const repeat of [1, 2]) {
        const checkpoint = a === arm ? await auditCheckpoint(output, planned.traceId, repeat) : {};
        const unit = { traceId: planned.traceId, arm: a, repeat, complete: true, executionKind: "real", confirmation: bundle.plan.confirmation,
          manifest: { codeRevision: context.registration.codeRevision, dirty: false }, checkpoint, trials: probes.map(probeId => ({ traceId: planned.traceId, arm: a, repeat, probeId, status: "completed",
            boundary: { verified: true, ...(a === arm ? { observed: { upkeep: [], upkeepScans: [], continuityPacks: [{ ledgerEntries: 3 }] } } : {}) },
            score: a === pack ? { pass: false, outcome: "abstained" } : { pass: true, outcome: "correct" }, usage: { calls: 1, inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.001 } })) };
        if (fails && a === "native" && repeat === 1) Object.assign(unit.trials[0], { status: "failed", score: null, boundary: null });
        units.push(unit); await writeFile(join(output, "units", `${a}-${repeat}.json`), jsonBytes(unit));
      }
      chunks.push({ ...planned, state: fails ? "failed" : "finished", unitFiles: units.length, accounting: controller.accountUnits(units, bundle),
        journalAccounting: await controller.accountJournals(output, planned.traceId, bundle, units), archiveSha256: await workflow.archiveChunk(output) });
    }
    await writeFile(join(root, "controller.json"), jsonBytes({ schema: "holdout-controller-v1", shard: bundle.plan.holdout.shard, binding: digest(bundle), authorizationSha256: "a".repeat(64),
      stop: { reason: "completed", reconciled: true }, chunks, spend: controller.spendOf(chunks, 8) })); roots.push(root);
  }
  return roots;
}
it("joins and certifies a full synthetic report with a failed chunk within the cap", async () => {
  await mkdir(join(CHECKOUT, ".worklab-tmp"), { recursive: true }); const directory = await mkdtemp(join(CHECKOUT, ".worklab-tmp/worst-case-study-")); scratch.push(directory);
  const { repo, inputs, context, workflow, controller } = await syntheticContext(directory, { families: 8, conversationsPerFamily: 16, conversationsPerCorpus: 64, shards: 64, perCorpusPerShard: 1 });
  const load = name => import(/* @vite-ignore */ pathToFileURL(join(repo, `scripts/lib/continuity-holdout-${name}.mjs`)).href);
  const auditModule = await load("audit"), auditors = await load("auditors"), report = await load("report"), roots = await syntheticShards(directory, context, workflow, controller);
  const joinedDir = join(directory, "joined"), joined = await workflow.joinShards(context, roots, joinedDir), joinedPath = join(joinedDir, "joined.json");
  expect(joined.controllerComplete).toBe(false); expect(joined.controllerAdmissible).toBe(true); expect(joined.statistics.integrity.missingPerArm.native).toBe(1);
  const exportedDir = join(directory, "audit"); expect((await auditModule.exportAudit(context, roots, joinedPath, exportedDir, "cd".repeat(32))).complete).toBe(true);
  const exported = JSON.parse(await readFile(join(exportedDir, "public/export.json"))), paths = { auditorA: join(inputs, "auditor-a.json"), auditorB: join(inputs, "auditor-b.json"), adjudication: join(inputs, "adjudication.json") };
  for (const [key, id] of [["auditorA", "reviewer-a"], ["auditorB", "reviewer-b"]]) await writeFile(paths[key], jsonBytes({ schema: "holdout-auditor-v1", auditorId: id, exportSha256: exported.exportSha256, rubricSha256: exported.rubricSha256,
    attestations: { notAuthor: true, notTuner: true, independentReview: true, noOutcomeAccess: true }, items: exported.items.map(({ id }) => ({ id, label: false, context: false, chronology: false, falseSupersession: false, binding: false, historicalCaution: false, rationale: "Synthetic evidence checked." })) }));
  await writeFile(paths.adjudication, jsonBytes({ schema: "holdout-adjudication-v1", blinded: true, adjudicatorId: "reviewer-c", exportSha256: exported.exportSha256, rubricSha256: exported.rubricSha256,
    auditorASha256: sha256(await readFile(paths.auditorA)), auditorBSha256: sha256(await readFile(paths.auditorB)), items: [] }));
  const imported = join(directory, "imported"); await auditors.importAudit(context, roots, joinedPath, exportedDir, paths, imported);
  const output = join(directory, "report"), result = await report.finalReport(context, roots, joinedPath, { ...paths, directory: exportedDir, certificate: join(imported, "certificate.json") }, output);
  expect(result.certified).toBe(true); expect(result.decision.status).toBe("pass");
  expect(JSON.parse(await readFile(join(output, "report.json"))).integrity).toMatchObject({ controllerComplete: false, controllerAdmissible: true, worstCase: true, complete: false, auditCertified: true });
}, 120000);
