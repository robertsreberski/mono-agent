import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { fork, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { CONTROLLER_STOPS } from "../lib/continuity-holdout-controller.mjs";
import { syntheticContext } from "./fixtures/holdout-synthetic.mjs";
import { CHECKOUT, jsonBytes, sha256 } from "../lib/continuity-holdout-files.mjs";
import { holdoutStatistics, HOLDOUT_ARMS, STATISTICAL_SPEC } from "../lib/continuity-holdout-statistics.mjs";
let directory, inputs, repo, context, workflow, controller, audit, auditors, report, roots, joinedPath, exported, certificatePath, paths, collection;
const parse = async path => JSON.parse(await readFile(path));
const orderSeed = "ab".repeat(32);
const flags = ["label", "context", "chronology", "falseSupersession", "binding", "historicalCaution"];
const response = (id, changes = {}) => ({ id, ...Object.fromEntries(flags.map(k => [k, false])), rationale: "Synthetic complete evidence reviewed.", ...changes });
const auditorDoc = id => ({ schema: "holdout-auditor-v1", auditorId: id, exportSha256: exported.exportSha256, rubricSha256: exported.rubricSha256,
  attestations: { notAuthor: true, notTuner: true, independentReview: true, noOutcomeAccess: true }, items: exported.items.map(i => response(i.id)) });
const adjDoc = async items => ({ schema: "holdout-adjudication-v1", blinded: true, adjudicatorId: "synthetic-custodian", exportSha256: exported.exportSha256,
  rubricSha256: exported.rubricSha256, auditorASha256: sha256(await readFile(paths.auditorA)), auditorBSha256: sha256(await readFile(paths.auditorB)), items });
async function changedChunk(label, change, joinMaterial = true) {
  const copy = join(directory, label); await cp(roots[0], copy, { recursive: true });
  const state = await parse(join(copy, "controller.json")), chunk = join(copy, "chunks/1"), traceId = state.chunks[0].traceId;
  const unitPath = join(chunk, "units", `r1-${traceId}-continuity-ledger-cold.json`), unit = await parse(unitPath);
  const store = join(chunk, `work/cp-${traceId}_ledger-continuity-ledger-cold-r1/work/history/tool-history/tool-lifecycles.sqlite`);
  await change({ chunk, unit, store, state }); await writeFile(unitPath, jsonBytes(unit));
  await rm(join(chunk, "archive.json")); state.chunks[0].archiveSha256 = await workflow.archiveChunk(chunk);
  const verified = await workflow.verifyArchive(chunk, state.chunks[0].archiveSha256);
  if (!joinMaterial) return { chunk, unit, store, verified };
  const bundle = context.plans.find(b => b.plan.holdout.shard === state.shard), units = await workflow.chunkUnits(chunk, bundle.plan, traceId, verified);
  state.chunks[0].accounting = controller.accountUnits(units, bundle);
  state.chunks[0].journalAccounting = await controller.accountJournals(chunk, traceId, bundle, units);
  state.spend = controller.spendOf(state.chunks, bundle.plan.arms.length * bundle.plan.repeats);
  await writeFile(join(copy, "controller.json"), jsonBytes(state));
  const changedRoots = [copy, roots[1]], joined = await workflow.joinShards(context, changedRoots, null);
  return { chunk, unit, store, changedRoots, joined, mechanical: await audit.mechanicalAudit(context, changedRoots, joined, join(directory, "verify")) };
}
beforeAll(async () => {
  await mkdir(join(CHECKOUT, ".worklab-tmp"), { recursive: true }); directory = await realpath(await mkdtemp(join(CHECKOUT, ".worklab-tmp/holdout-audit-")));
  ({ repo, inputs, context, workflow, controller } = await syntheticContext(directory));
  const load = name => import(/* @vite-ignore */ pathToFileURL(join(repo, `scripts/lib/continuity-holdout-${name}.mjs`)).href);
  audit = await load("audit"); auditors = await load("auditors"); report = await load("report"); roots = [];
  for (const bundle of context.plans) {
    const output = join(directory, `run-${bundle.plan.holdout.shard}`), authorizationPath = join(inputs, `auth-${bundle.plan.holdout.shard}.json`); await mkdir(output);
    await writeFile(authorizationPath, jsonBytes({ planDigest: bundle.plan.confirmation, ceilingUSD: bundle.ceilingUSD, authPathFingerprint: bundle.plan.piAuthFingerprint,
      outputRootSha256: sha256(output), approver: "Synthetic custodian", timestamp: "2040-01-01T00:00:00.000Z" }));
    const state = await controller.runController(context, { output, authorizationPath, shard: bundle.plan.holdout.shard, env: { HOLDOUT_FIXTURE_MODE: "audit" },
      workerURL: new URL("./fixtures/holdout-worker.mjs", import.meta.url) }); expect(state.stop.reason).toBe("completed"); roots.push(output);
  }
  const joinedDir = join(directory, "joined"); await workflow.joinShards(context, roots, joinedDir); joinedPath = join(joinedDir, "joined.json");
  const exportDir = join(directory, "export"); expect((await audit.exportAudit(context, roots, joinedPath, exportDir, orderSeed)).complete).toBe(true);
  exported = await parse(join(exportDir, "public/export.json"));
  const scratch = join(directory, "verify"); await mkdir(scratch); collection = await auditors.verifyAuditExport(context, roots, joinedPath, exportDir, scratch);
  paths = { directory: exportDir, auditorA: join(inputs, "auditor-a.json"), auditorB: join(inputs, "auditor-b.json"), adjudication: join(inputs, "adjudication.json") };
  await writeFile(paths.auditorA, jsonBytes(auditorDoc("auditor-one"))); await writeFile(paths.auditorB, jsonBytes(auditorDoc("auditor-two")));
  await writeFile(paths.adjudication, jsonBytes(await adjDoc([])));
  const imported = join(directory, "imported"); expect((await auditors.importAudit(context, roots, joinedPath, exportDir, paths, imported)).phase).toBe("certified"); certificatePath = join(imported, "certificate.json");
}, 30000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it("runs join, mechanical audit, blinded import and report at one revision without a provider", async () => {
  const mechanical = await parse(join(paths.directory, "private/mechanical.json")), certificate = await parse(certificatePath);
  expect(mechanical.complete).toBe(true); expect(mechanical.checkedCheckpoints).toBe(8); expect(mechanical.published).toBe(24);
  expect(mechanical.counters).toMatchObject({ publications: 16, captureViews: 24, probeViews: 120, probeViewsUnobserved: 0, derivedLines: 400,
    receiptRelabels: 8, receiptDowngrades: 8, uniqueRelabelled: 8, uniqueDowngraded: 8, d6OutputOverruns: 8 });
  expect(certificate.totals).toMatchObject({ complete: true, published: 24, audited: 24, labelFindings: 0, contextFindings: 0 });
  const result = await report.finalReport(context, roots, joinedPath, { ...paths, certificate: certificatePath }, join(directory, "final"));
  expect(result.certified).toBe(true); expect(result.decision.status).not.toBe("fail");
  const final = await parse(join(directory, "final/report.json")); expect(final.integrity.auditCertified).toBe(true);
  expect(final.decision.reasons).not.toContain("audit-workflow-pending:inconclusive");
  // Zero-variance paired differences pass v2 even in this tiny mechanics-only fixture.
  expect(final.decision.status).toBe("pass");
  expect(final.eligibilityScope).toMatchObject({ reader: context.registration.models.reader, extractor: context.registration.models.extractor });
  expect(final.eligibilityScope.statement).toContain("not other models or blanket default enablement"); expect(JSON.stringify(final)).not.toContain(directory);
});
it("exposes the complete join/export/import/report CLI chain at one registered revision", async () => {
  const rootsPath = join(inputs, "roots.json"); await writeFile(rootsPath, jsonBytes(roots)); const o = context.options;
  const common = ["--corpus-manifest", o.manifestPath, "--manifest-sha256", o.manifestSha256, "--registration", o.registrationPath,
    "--registration-sha256", o.registrationSha256, "--statistical-spec", o.statisticalSpecPath, "--pi-auth-path", o.piAuthPath, "--shard-roots", rootsPath];
  const cli = (command, args) => {
    const result = spawnSync(process.execPath, [join(repo, "scripts/continuity-holdout/workflow.mjs"), command, ...common, ...args], { encoding: "utf8", env: {}, timeout: 10000 });
    expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
  };
  const cliJoin = join(directory, "cli-join"), cliExport = join(directory, "cli-export"), cliImport = join(directory, "cli-import");
  cli("join", ["--output", cliJoin]); const joined = join(cliJoin, "joined.json"); expect(await readFile(joined)).toEqual(await readFile(joinedPath));
  expect(cli("audit-export", ["--joined", joined, "--output", cliExport, "--seed", orderSeed]).complete).toBe(true);
  const options = ["--joined", joined, "--audit-directory", cliExport, "--auditor-a", paths.auditorA, "--auditor-b", paths.auditorB, "--adjudication", paths.adjudication];
  expect(cli("audit-import", [...options, "--output", cliImport]).phase).toBe("certified");
  expect(cli("report", [...options, "--certificate", join(cliImport, "certificate.json"), "--output", join(directory, "cli-report")]).certified).toBe(true);
});
it("exports full evidence with masked identities, no outcomes, recorded order and exact rubric hash", async () => {
  const publicText = JSON.stringify(exported);
  for (const forbidden of ["holdout-hard", "openai-codex", "fixture-case", "conversationId", "repeat", "checkpoint", "answer", "score", "sources", directory]) {
    // Disclosure explicitly names the masked metadata, but items never contain it.
    expect(JSON.stringify(exported.items)).not.toContain(forbidden);
  }
  expect(exported.disclosure).toContain("True arm blinding is impossible"); expect(exported.orderSeedSha256).toBe(sha256(Buffer.from(orderSeed, "hex"))); expect(publicText).not.toContain(orderSeed); expect(publicText).toContain("SYNTH-42");
  const { exportSha256, ...payload } = exported; expect(exportSha256).toBe(sha256(jsonBytes(payload)));
  expect(sha256(await readFile(join(paths.directory, "public/rubric.json")))).toBe(exported.rubricSha256);
  expect(exported.items.every(i => i.evidence.length > 0 && i.evidence.every(e => e.text.length > 0))).toBe(true);
});
it("deduplicates only scoped entry IDs across publications, never paraphrases", () => {
  expect(exported.items.filter(i => i.entry.value === "Inspection request for the fictional component.")).toHaveLength(8);
  expect(exported.items.filter(i => i.entry.value === "The fictional component has an inspection request.")).toHaveLength(8);
  expect(new Set(exported.items.map(i => i.id)).size).toBe(24);
  expect(new Set(collection.mapping.map(m => JSON.stringify([m.item.corpus, m.item.conversation, m.item.repeat, m.item.entry.id]))).size).toBe(24);
});
it("exports deterministic bytes despite different output directories and root order", async () => {
  const other = join(directory, "export-again"); await audit.exportAudit(context, [...roots].reverse(), joinedPath, other, orderSeed);
  for (const name of ["public/export.json", "public/rubric.json", "private/map.json", "private/mechanical.json", "private/order.json"]) expect(await readFile(join(other, name))).toEqual(await readFile(join(paths.directory, name)));
  const randomized = audit.blindExport(collection.mechanical, collection.joined.sha256, exported.rubricSha256, "cd".repeat(32)).exported;
  expect(randomized.items.map(i => i.id)).not.toEqual(exported.items.map(i => i.id));
});
it("rejects a rubric hash mismatch and a join changed after export", async () => {
  const changed = structuredClone(context); changed.registration.rubricSha256 = "0".repeat(64);
  await expect(audit.auditRubric(changed)).rejects.toThrow("audit_rubric_mismatch");
  const bad = join(inputs, "changed-join.json"); await writeFile(bad, jsonBytes({ ...(await parse(joinedPath)), controllerComplete: false }));
  await expect(audit.verifiedJoin(context, roots, bad)).rejects.toThrow("audit_join_mismatch");
});
it.each(["missing", "duplicate", "extra", "hash", "rubric", "independence", "identity", "flags", "rationale"])("rejects invalid auditor %s material", kind => {
  const first = auditorDoc("auditor-one"), second = auditorDoc("auditor-two");
  if (kind === "missing") first.items.pop();
  if (kind === "duplicate") first.items[1] = first.items[0];
  if (kind === "extra") first.items[0].id = "extra";
  if (kind === "hash") first.exportSha256 = "bad";
  if (kind === "rubric") first.rubricSha256 = "bad";
  if (kind === "independence") first.attestations.notTuner = false;
  if (kind === "identity") second.auditorId = first.auditorId;
  if (kind === "flags") first.items[0].label = 1;
  if (kind === "rationale") first.items[0].rationale = "";
  expect(() => auditors.resolveAuditors(collection, first, second, "a", "b", null)).toThrow();
});
it("reports disagreements without unmasking, and requires adjudication even for agreement", async () => {
  const a = auditorDoc("auditor-one"), b = auditorDoc("auditor-two"); a.items[0].label = true;
  const unresolved = auditors.resolveAuditors(collection, a, b, "a", "b", null);
  expect(unresolved.phase).toBe("awaiting-adjudication"); expect(unresolved.disagreements).toHaveLength(1); expect(unresolved).not.toHaveProperty("unmasked");
  const missing = { ...paths }; delete missing.adjudication;
  const out = join(directory, "unresolved-import"); expect((await auditors.importAudit(context, roots, joinedPath, paths.directory, missing, out)).phase).toBe("awaiting-adjudication");
  await expect(readFile(join(out, "unmasked.json"))).rejects.toMatchObject({ code: "ENOENT" }); await expect(readFile(join(out, "certificate.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const adj = { ...(await adjDoc([{ id: a.items[0].id, label: true, rationale: "Synthetic disputed-label resolution." }])), auditorASha256: "a", auditorBSha256: "b" };
  const resolved = auditors.resolveAuditors(collection, a, b, "a", "b", adj); expect(resolved.totals.labelFindings).toBe(1); expect(resolved.unmasked).toHaveLength(24);
  for (const items of [[], [response("extra")], [response(a.items[0].id), response(a.items[0].id)]]) expect(() => auditors.resolveAuditors(collection, a, b, "a", "b", { ...adj, items })).toThrow();
  expect(() => auditors.resolveAuditors(collection, a, b, "wrong", "b", adj)).toThrow("audit_adjudication_binding");
});
it("preserves agreed hard violations before adjudication without revealing identities", () => {
  const a = auditorDoc("auditor-one"), b = auditorDoc("auditor-two"); a.items[0].binding = true; b.items[0].binding = true; a.items[1].context = true;
  const unresolved = auditors.resolveAuditors(collection, a, b, "a", "b", null);
  expect(unresolved.lowerBounds.bindingErrors).toBe(1); expect(unresolved.lowerBounds.contextFindings).toBe(0); expect(unresolved).not.toHaveProperty("unmasked");
});
it("retains two validated auditors' agreed failures after invalid adjudication or certificate", async () => {
  const a = auditorDoc("auditor-one"), b = auditorDoc("auditor-two"); a.items[0].binding = b.items[0].binding = true;
  const local = { ...paths, auditorA: join(inputs, "failure-a.json"), auditorB: join(inputs, "failure-b.json"), adjudication: join(inputs, "failure-adj.json"), certificate: certificatePath };
  await writeFile(local.auditorA, jsonBytes(a)); await writeFile(local.auditorB, jsonBytes(b));
  const adj = { ...(await adjDoc([])), auditorASha256: sha256(await readFile(local.auditorA)), auditorBSha256: sha256(await readFile(local.auditorB)) };
  for (const kind of ["hash", "unreadable", "certificate-missing", "certificate-invalid"]) {
    await writeFile(local.adjudication, kind === "unreadable" ? "{" : jsonBytes({ ...adj, ...(kind === "hash" ? { exportSha256: "bad" } : {}) }));
    const output = join(directory, `established-fail-${kind}`), options = { ...local };
    if (kind === "certificate-missing") options.certificate = join(inputs, "missing-certificate.json");
    if (kind === "certificate-invalid") { options.certificate = join(inputs, "invalid-certificate.json"); await writeFile(options.certificate, "{"); }
    const result = await report.finalReport(context, roots, joinedPath, options, output);
    expect(result.certified).toBe(false); expect(result.decision.status).toBe("fail");
    expect((await parse(join(output, "report.json"))).audit.totals.bindingErrors).toBe(1);
  }
});
it("adjudicates only disputed flags and cannot clear or restate agreed flags", async () => {
  const a = auditorDoc("auditor-one"), b = auditorDoc("auditor-two"); a.items[0].binding = b.items[0].binding = true; a.items[0].label = true;
  const resolution = { id: a.items[0].id, label: false, rationale: "Synthetic disputed-label resolution." };
  const adj = { ...(await adjDoc([resolution])), auditorASha256: "a", auditorBSha256: "b" };
  const resolved = auditors.resolveAuditors(collection, a, b, "a", "b", adj);
  expect(resolved.totals.bindingErrors).toBe(1); expect(resolved.totals.labelFindings).toBe(0);
  expect(resolved.unmasked.find(r => r.id === resolution.id).judgment.binding).toBe(true);
  for (const extra of [{ binding: false }, { binding: true }, { context: false }]) expect(() => auditors.resolveAuditors(collection, a, b, "a", "b", { ...adj, items: [{ ...resolution, ...extra }] })).toThrow("audit_response_invalid");
});
it("exports item-relative dense host order with ties, not absolute ordinals", () => {
  const mechanical = structuredClone(collection.mechanical); mechanical.items = [mechanical.items[0]];
  const item = mechanical.items[0], source = item.sources[0]; item.sources = [{ ...source, ordinal: 900 }, { ...source, ordinal: 100 }, { ...source, ordinal: 900 }];
  const first = audit.blindExport(mechanical, collection.joined.sha256, exported.rubricSha256, orderSeed).exported;
  expect(first.items[0].evidence.map(e => e.hostOrder)).toEqual([2, 1, 2]); expect(JSON.stringify(first.items)).not.toMatch(/ordinal|900|100/u);
  item.sources[0].ordinal = 50;
  const second = audit.blindExport(mechanical, collection.joined.sha256, exported.rubricSha256, orderSeed).exported;
  expect(second.items[0].evidence.map(e => e.hostOrder)).toEqual([1, 2, 3]); expect(second.exportSha256).not.toBe(first.exportSha256);
});
it.each(["missing", "altered", "same-entry-changed", "publication-receipt-missing"])("rejects %s native audit material", async kind => {
  const result = await changedChunk(`native-${kind}`, async ({ chunk, unit, store }) => {
    if (kind === "missing") await rm(store);
    if (kind === "altered") { const db = new DatabaseSync(store); try { db.exec("UPDATE continuity_ledger SET payload='{}'"); } finally { db.close(); } }
    // Preserve the producer span-key order: the manifest hashes JSON.stringify(spans).
    if (kind === "same-entry-changed") { const path = join(chunk, "upkeep-output", `r1-${unit.traceId}-p2.json`), capture = await parse(path); expect(capture.ledger.entries[0].id).toBe("entry-a"); capture.ledger.entries[0].value = "Changed request."; await writeFile(path, JSON.stringify(capture)); }
    if (kind === "publication-receipt-missing") delete unit.checkpoint.upkeep.preparations[0].receipt.generationId;
  });
  const code = { missing: "audit_material_missing", altered: "audit_latest_binding", "same-entry-changed": "audit_generation_changed", "publication-receipt-missing": "audit_publication_binding" }[kind];
  expect(result.mechanical.complete).toBe(false); expect(result.mechanical.failures.map(f => f.code)).toContain(code);
});
it("recovers an archived hot rollback journal only in the scratch snapshot", async () => {
  let hotHash, journalHash;
  const result = await changedChunk("native-hot-journal", async ({ store }) => {
    const before = sha256(await readFile(store));
    const child = fork(new URL("./fixtures/holdout-hot-journal.mjs", import.meta.url), [store], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: {} });
    try { await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => reject(new Error(`hot_journal_fixture_exit:${code}`))); }); }
    finally { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    hotHash = sha256(await readFile(store)); journalHash = sha256(await readFile(store + "-journal")); expect(hotHash).not.toBe(before);
    expect((await readFile(store + "-journal")).subarray(0, 8).toString("hex")).toBe("d9d505f920a163d7");
  }, false);
  const ledger = await import("../../packages/conversation/dist/continuity/ledger.js");
  const checked = await audit.checkpointAudit(result.chunk, result.verified, result.unit, join(directory, "verify"), ledger);
  expect(checked.counters.publications).toBe(2); expect(checked.counters.probeViews).toBe(15);
  expect(sha256(await readFile(result.store))).toBe(hotHash); expect(sha256(await readFile(result.store + "-journal"))).toBe(journalHash);
});
it("counts unobserved failed probes without inventing views or altering statistics", async () => {
  const result = await changedChunk("unobserved-failed", async ({ unit }) => { unit.trials[0].status = "failed"; unit.trials[0].boundary = null; });
  expect(result.mechanical.complete).toBe(true); expect(result.mechanical.counters.probeViewsUnobserved).toBe(1); expect(result.mechanical.counters.probeViews).toBe(119);
  expect(result.joined.controllerComplete).toBe(false); expect(result.joined.statistics.decision.status).not.toBe("pass");
  const joinedDir = join(directory, "unobserved-join"), exportedDir = join(directory, "unobserved-export"), reportedDir = join(directory, "unobserved-report");
  await workflow.joinShards(context, result.changedRoots, joinedDir); const path = join(joinedDir, "joined.json");
  await audit.exportAudit(context, result.changedRoots, path, exportedDir, orderSeed);
  expect((await report.finalReport(context, result.changedRoots, path, { directory: exportedDir }, reportedDir)).decision.status).not.toBe("pass");
  expect((await parse(join(reportedDir, "report.json"))).audit.counters.probeViewsUnobserved).toBe(1);
});
it.each(["failed-with-boundary", "completed", "started", "not_started"])("fails closed for unverified %s probes", async kind => {
  const result = await changedChunk(`unobserved-${kind}`, async ({ unit }) => { unit.trials[0].status = kind === "failed-with-boundary" ? "failed" : kind; unit.trials[0].boundary = kind === "failed-with-boundary" ? {} : null; });
  expect(result.mechanical.complete).toBe(false); expect(result.mechanical.failures.some(f => f.code === "audit_probe_upkeep")).toBe(true);
});
it.each([["failed", "completed", true], ["killed", "completed", false], ["lost", "completed", false], ...CONTROLLER_STOPS.filter(s => s !== "completed").map(s => ["failed", s, false])])("checks controller admission for %s / %s", async (chunkState, reason, expected) => {
  const result = await changedChunk(`admission-${chunkState}-${reason}`, async ({ unit, state }) => {
    unit.trials[0].status = "failed"; unit.trials[0].boundary = null; state.chunks[0].state = chunkState; state.stop.reason = reason;
  });
  expect(result.joined.controllerComplete).toBe(false); expect(result.joined.controllerAdmissible).toBe(expected);
});
it("refuses admission with a missing shard or planned chunk", async () => {
  expect((await workflow.joinShards(context, [roots[0]], null)).controllerAdmissible).toBe(false);
  const result = await changedChunk("admission-missing-chunk", async ({ state, chunk }) => { state.chunks.pop(); await rm(join(chunk, "../2"), { recursive: true }); });
  expect(result.joined.controllerAdmissible).toBe(false); expect(result.joined.controllerComplete).toBe(false);
});
it("rejects rewritten export or private mapping evidence", async () => {
  const copy = join(directory, "bad-export"); await cp(paths.directory, copy, { recursive: true });
  const saved = await parse(join(copy, "private/map.json")); saved[0].item.repeat = 99; await writeFile(join(copy, "private/map.json"), jsonBytes(saved));
  await expect(auditors.verifyAuditExport(context, roots, joinedPath, copy, join(directory, "verify"))).rejects.toThrow("audit_export_mismatch");
});
it("makes missing native material and contradictory citations explicit integrity failures", async () => {
  const copy = join(directory, "bad-root"); await cp(roots[0], copy, { recursive: true });
  const state = await parse(join(copy, "controller.json")), chunk = join(copy, "chunks/1"), capture = join(chunk, "upkeep-output", `r1-${state.chunks[0].traceId}-p1.json`);
  const rearchive = async () => { await rm(join(chunk, "archive.json")); state.chunks[0].archiveSha256 = await workflow.archiveChunk(chunk); await writeFile(join(copy, "controller.json"), jsonBytes(state)); };
  const original = await parse(capture); await rm(capture); await rearchive();
  const scratch = join(directory, "verify");
  let result = await audit.mechanicalAudit(context, [copy, roots[1]], await workflow.joinShards(context, [copy, roots[1]], null), scratch);
  expect(result.complete).toBe(false); expect(result.failures.some(f => f.code === "audit_material_missing")).toBe(true);
  const missingJoin = join(directory, "missing-audit-join"); await workflow.joinShards(context, [copy, roots[1]], missingJoin);
  const missingExport = join(directory, "missing-audit-export"); await audit.exportAudit(context, [copy, roots[1]], join(missingJoin, "joined.json"), missingExport, orderSeed);
  expect((await report.finalReport(context, [copy, roots[1]], join(missingJoin, "joined.json"), { directory: missingExport }, join(directory, "missing-audit-report"))).decision.status).toBe("inconclusive");
  original.ledger.spans[0].owner = false; original.ledger.manifest = sha256(JSON.stringify(original.ledger.spans)); await writeFile(capture, jsonBytes(original)); await rearchive();
  result = await audit.mechanicalAudit(context, [copy, roots[1]], await workflow.joinShards(context, [copy, roots[1]], null), scratch);
  expect(result.complete).toBe(false); expect(result.failures.some(f => /binding|host_citation/u.test(f.code))).toBe(true);
  const invalidJoin = join(directory, "invalid-audit-join"); await workflow.joinShards(context, [copy, roots[1]], invalidJoin);
  const invalidExport = join(directory, "invalid-audit-export"); await audit.exportAudit(context, [copy, roots[1]], join(invalidJoin, "joined.json"), invalidExport, orderSeed);
  expect((await report.finalReport(context, [copy, roots[1]], join(invalidJoin, "joined.json"), { directory: invalidExport }, join(directory, "invalid-audit-report"))).decision.status).toBe("fail");
});
it("never certifies a totals file, missing adjudication or a changed human file", async () => {
  const totals = join(inputs, "totals.json"); await writeFile(totals, jsonBytes({ complete: true, published: 24, audited: 24, labelFindings: 0, contextFindings: 0, bindingErrors: 0, falselySupersededCurrent: 0 }));
  const result = await report.finalReport(context, roots, joinedPath, { certificate: totals }, join(directory, "totals-report"));
  expect(result.certified).toBe(false); expect(result.decision.status).not.toBe("pass");
  const noAdj = { ...paths, certificate: certificatePath }; delete noAdj.adjudication;
  expect((await report.finalReport(context, roots, joinedPath, noAdj, join(directory, "no-adj-report"))).certified).toBe(false);
  const otherA = join(inputs, "changed-a.json"), changed = auditorDoc("auditor-one"); changed.items[0].context = true; await writeFile(otherA, jsonBytes(changed));
  expect((await report.finalReport(context, roots, joinedPath, { ...paths, auditorA: otherA, certificate: certificatePath }, join(directory, "changed-human-report"))).certified).toBe(false);
});
it("keeps standalone benchmark aggregation noncertifying even with bound totals", async () => {
  const { aggregate } = await import(/* @vite-ignore */ pathToFileURL(join(repo, "scripts/continuity-benchmark.mjs")).href);
  const output = join(directory, "standalone"); await mkdir(join(output, "units"), { recursive: true });
  const auditPath = join(inputs, "diagnostic-totals.json"); await writeFile(auditPath, jsonBytes({ ...totals(), registrationSha256: context.options.registrationSha256 }));
  const result = await aggregate({ plan: context.plans[0].plan, traces: context.loaded.traces, output, mode: "real", auditPath });
  expect(result.summary.holdout.decision.gates).toContainEqual({ name: "audit-certification", status: "inconclusive" });
  expect(result.summary.holdout.decision.status).not.toBe("pass");
});
it("rejects edited certificate totals or unmasked import outputs", async () => {
  for (const target of ["certificate.json", "unmasked.json"]) {
    const copy = join(directory, `bad-import-${target}`); await cp(join(directory, "imported"), copy, { recursive: true });
    const path = join(copy, target), value = await parse(path);
    if (target === "certificate.json") value.totals.published++; else value[0].conversation = "changed";
    await writeFile(path, jsonBytes(value));
    const result = await report.finalReport(context, roots, joinedPath, { ...paths, certificate: join(copy, "certificate.json") }, join(directory, `bad-import-report-${target}`));
    expect(result.certified).toBe(false); expect(result.decision.status).not.toBe("pass");
  }
});
it("rejects non-UTF8 citation geometry instead of exporting replacement text", async () => {
  const { checkLedgerView } = await import("../lib/continuity-holdout-proof.mjs"), { renderLedger } = await import("../../packages/conversation/dist/continuity/ledger.js");
  const text = "🙂 Synthetic source.", record = { recordId: "r", ordinal: 1, text, sha256: sha256(text), kind: "tool", provenance: "tool", source: {} };
  const span = { id: "s", recordId: "r", ordinal: 1, sha256: record.sha256, start: 1, end: 4, digest: sha256(Buffer.from(text).subarray(1, 4)), owner: false };
  expect(() => checkLedgerView({ spans: [span], entries: [{ id: "e", kind: "artifact", value: "Synthetic", status: "unknown", sources: ["s"] }] }, [record], renderLedger)).toThrow("offline_host_citation");
});
it("refuses a report after one raw archived file changes, even with an unchanged manifest", async () => {
  const copy = join(directory, "raw-tamper"); await cp(roots[0], copy, { recursive: true });
  const archivePath = join(copy, "chunks/1/archive.json"), archive = await parse(archivePath);
  const name = Object.keys(archive.files).find(k => k.startsWith("units/")), raw = join(copy, "chunks/1", name);
  await writeFile(raw, Buffer.concat([await readFile(raw), Buffer.from("\n")]));
  const output = join(directory, "raw-tamper-report");
  await expect(report.finalReport(context, [copy, roots[1]], joinedPath, { ...paths, certificate: certificatePath }, output)).rejects.toThrow("archive_content_mismatch");
  await expect(readFile(join(output, "report.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("writes byte-identical reports with detached hashes and no local path or changing timestamp", async () => {
  const output = join(directory, "final-again"); await report.finalReport(context, [...roots].reverse(), joinedPath, { ...paths, certificate: certificatePath }, output);
  for (const name of ["report.json", "report.md", "artifacts.json"]) expect(await readFile(join(output, name))).toEqual(await readFile(join(directory, "final", name)));
  const manifest = await parse(join(output, "artifacts.json"));
  for (const [name, hash] of Object.entries(manifest.outputs)) expect(sha256(await readFile(join(output, name)))).toBe(hash);
  const state = await parse(join(roots[0], "controller.json")), archivePath = join(roots[0], "chunks/1/archive.json");
  expect(manifest.inputs[`shards/${state.shard}/chunks/1/archive.json`]).toBe(sha256(await readFile(archivePath)));
  expect(Object.keys((await parse(archivePath)).files).some(k => k.endsWith("tool-lifecycles.sqlite"))).toBe(true);
  expect(Object.keys(manifest.inputs).some(k => k.includes("/work/"))).toBe(false);
  expect(manifest.toolingRevision).toBe(context.registration.codeRevision);
  for (const name of ["ledger", "ranking", "span-geometry", "render-fit", "ledger-error"]) {
    const path = `packages/conversation/dist/continuity/${name}.js`; expect(manifest.inputs[`runtime/${path}`]).toBe(sha256(await readFile(join(repo, path))));
  }
  expect(manifest.inputs["audit-import/unmasked.json"]).toBe(sha256(await readFile(join(directory, "imported/unmasked.json"))));
  expect(JSON.stringify(manifest)).not.toContain(directory); expect(JSON.stringify(manifest)).not.toContain("timestamp");
});
function passingStatistics(totals) {
  const d = STATISTICAL_SPEC.design, conversations = Array.from({ length: d.conversationsPerCorpus * 2 }, (_, i) => ({ id: `synthetic-${i}`,
    corpus: d.corpora[Math.floor(i / d.conversationsPerCorpus)], family: `family-${Math.floor(i / d.conversationsPerFamily)}`, probes: Array.from({ length: d.probes }, (_, j) => `p${j}`) }));
  const trials = conversations.flatMap(c => HOLDOUT_ARMS.flatMap(arm => [1, 2].flatMap(repeat => c.probes.map(probeId => ({ traceId: c.id, arm, repeat, probeId, status: "completed", boundary: { verified: true }, score: { pass: arm !== "continuity-pack-cold", outcome: arm !== "continuity-pack-cold" ? "correct" : "abstained" } })))));
  return holdoutStatistics({ conversations, trials, audit: totals, measurement: true });
}
const totals = (published = 363, labelFindings = 10, contextFindings = 5) => ({ complete: true, published, audited: published, labelFindings, contextFindings, falselySupersededCurrent: 0, bindingErrors: 0 });
it.each([[363, 10, 5, "pass"], [363, 11, 5, "fail"], [363, 10, 6, "fail"], [726, 20, 10, "pass"], [726, 21, 10, "fail"]])("uses registered rate denominators %i / %i / %i", (n, label, context, expected) => {
  expect(passingStatistics(totals(n, label, context)).decision.status).toBe(expected);
});
it.each(["falselySupersededCurrent", "bindingErrors"])("preserves the hard-zero %s gate", field => {
  expect(passingStatistics({ ...totals(), [field]: 1 }).decision.status).toBe("fail");
});
it("accepts a mathematical pass candidate only with certified, complete audit; established failures remain failures", async () => {
  const certificate = await parse(certificatePath);
  expect(report.certifiedDecision(passingStatistics(certificate.totals), true, true).decision.status).toBe("pass");
  expect(report.certifiedDecision(passingStatistics(totals()), true, false).decision.status).toBe("inconclusive");
  expect(report.certifiedDecision(passingStatistics(totals()), false, true).decision.status).toBe("inconclusive");
  expect(report.certifiedDecision(passingStatistics({ ...totals(), bindingErrors: 1 }), false, false).decision.status).toBe("fail");
});
