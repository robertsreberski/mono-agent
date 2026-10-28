import { mkdir, open, readdir, readFile, rename, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { main as benchmark, listPrices } from "../continuity-benchmark.mjs";
import { makePlan, estimateCost, inventory, digest } from "./continuity-dataset.mjs";
import { preparationIntegrity } from "./continuity-runner.mjs";
import { loadRegisteredHoldout, holdoutModels, readBoundAudit } from "./continuity-holdout-registration.mjs";
import { HOLDOUT_ARMS, holdoutStatistics } from "./continuity-holdout-statistics.mjs";
import { CHECKOUT, externalDirectory, readJson, regularFile, jsonBytes, sha256, toolingRevision } from "./continuity-holdout-files.mjs";

export const need = (ok, code) => { if (!ok) throw new Error(code); };
export const finite = x => typeof x === "number" && Number.isFinite(x) && x >= 0;
export const unitKey = u => `${u.traceId}/${u.arm}/${u.repeat}`;

/** Replace a snapshot atomically, syncing both its bytes and the directory entry. */
export async function durable(path, value, exclusive = false) {
  const temp = exclusive ? path : `${path}.pending`;
  const file = await open(temp, exclusive ? "wx" : "w", 0o600);
  try { await file.writeFile(jsonBytes(value)); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(temp, path);
  const dir = await open(dirname(path), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function fileInventory(root) {
  const files = {};
  async function walk(path, prefix) {
    for (const name of (await readdir(path)).sort()) {
      const rel = prefix + name, full = join(path, name), info = await lstat(full);
      if (info.isDirectory()) await walk(full, `${rel}/`);
      else { need(info.isFile(), "archive_nonregular_file"); files[rel] = sha256(await readFile(full)); }
    }
  }
  await walk(root, ""); return files;
}
export async function archiveChunk(root) {
  const files = await fileInventory(root);
  need(!Object.hasOwn(files, "archive.json"), "archive_already_exists");
  await durable(join(root, "archive.json"), { schema: "holdout-archive-v1", files }, true);
  return sha256(await readFile(join(root, "archive.json")));
}
export async function verifyArchive(root, hash) {
  const bytes = await regularFile(join(root, "archive.json"));
  need(sha256(bytes) === hash, "archive_hash_mismatch");
  const archive = JSON.parse(bytes), current = await fileInventory(root); delete current["archive.json"];
  need(archive.schema === "holdout-archive-v1" && digest(current) === digest(archive.files), "archive_content_mismatch");
  return current;
}

export async function loadContext(options) {
  const registration = await readJson(options.registrationPath), models = registration.models;
  need(models && options.piAuthPath && options.piAuthPath === resolve(options.piAuthPath), "auth_path_required");
  const profile = { reader: models.reader, extractionModel: models.extractor, alternate: models.alternate, readerEffort: models.readerEffort, judge: models.judge };
  const codeRevision = toolingRevision();
  const loaded = await loadRegisteredHoldout({ ...options, shard: undefined, codeRevision, profile, arms: HOLDOUT_ARMS, repeats: registration.statisticalSpec.design.repeats, probeLimit: null });
  need(loaded.traces.every(t => /^[a-zA-Z0-9_-]+$/u.test(t.id)), "unsafe_conversation_id");
  const prices = await listPrices([models.reader, models.extractor]);
  // Unknown reader usage must reserve the actual catalog context/output, not the answer heuristic.
  const ref = models.reader, split = ref.indexOf(":"), provider = ref.slice(0, split), model = ref.slice(split + 1);
  let readerLimits = null;
  try {
    const data = JSON.parse(await readFile(join(CHECKOUT, "packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/data", `${provider}.json`), "utf8"));
    for (const group of Object.values(data)) for (const row of Object.values(group)) if (row?.id === model) {
      readerLimits = { input: row.contextWindow, output: row.maxTokens };
      // Use the most expensive catalog tier for unknown calls.
      prices[ref] = { ...prices[ref], reserveInput: Math.max(row.cost.input, ...(row.cost.tiers ?? []).map(t => t.input)), reserveOutput: Math.max(row.cost.output, ...(row.cost.tiers ?? []).map(t => t.output)) };
    }
  } catch { /* Unknown catalog entries block admission below. */ }
  const plans = registration.shards.map(shard => {
    const traces = loaded.traces.filter(t => shard.conversations.includes(t.id));
    const args = { ...loaded, traces, suite: "holdout", profile, codeRevision, repeats: registration.statisticalSpec.design.repeats,
      piAuthFingerprint: sha256(options.piAuthPath), holdout: { ...loaded.holdout, shard: shard.id } };
    const plan = makePlan(args), estimate = estimateCost(plan, traces, prices);
    const chunks = traces.map(trace => {
      const cost = estimateCost(makePlan({ ...args, traces: [trace] }), [trace], prices);
      return { traceId: trace.id, reservationUsd: cost.status === "estimated" ? Math.ceil((Object.values(cost.arms).reduce((n, a) => n + a.upperUsd + 0.0001, 0)) * 1e6) / 1e6 : null };
    });
    const priced = [models.reader, models.extractor].every(m => ["input", "output", "cacheRead"].every(k => finite(prices[m]?.[k])))
      && finite(prices[models.reader]?.reserveInput) && finite(prices[models.reader]?.reserveOutput)
      && finite(readerLimits?.input) && readerLimits.input > 0 && finite(readerLimits?.output) && readerLimits.output > 0;
    return { plan, prices, readerLimits, inventory: inventory(traces), estimate, chunks, ceilingUSD: shard.costCapUSD, priced,
      admissible: priced && estimate.status === "estimated" && chunks.every(c => finite(c.reservationUsd))
        && chunks.reduce((sum, c) => sum + c.reservationUsd, 0) <= shard.costCapUSD };
  });
  return { options, registration, loaded, profile, plans };
}
export function benchmarkArgs(context, shard) {
  const o = context.options, m = holdoutModels(context.profile);
  return ["--suite", "holdout", "--corpus-manifest", o.manifestPath, "--manifest-sha256", o.manifestSha256,
    "--registration", o.registrationPath, "--registration-sha256", o.registrationSha256, "--statistical-spec", o.statisticalSpecPath,
    "--reader", m.reader, "--extraction-model", m.extractor, "--alternate", m.alternate, "--no-judge", "--reader-effort", "low",
    ...(shard === undefined ? [] : ["--shard", String(shard)])];
}
export async function preparePlans(context, output) {
  output = await externalDirectory(output, true);
  const rows = [];
  for (const bundle of context.plans) {
    const shard = bundle.plan.holdout.shard, directory = join(output, `shard-${shard}`);
    await mkdir(directory, { mode: 0o700 });
    await durable(join(directory, "dry-plan.json"), bundle, true);
    let blocked = 0;
    const sentinel = new Error("provider_loading_deliberately_blocked");
    try {
      await benchmark([...benchmarkArgs(context, shard), "--real", "--confirm-plan", bundle.plan.confirmation,
        "--pi-auth-path", context.options.piAuthPath, "--output", join(directory, "confirmation-only"), "--keep-work"], {
        env: {}, stdout: () => {}, modulesLoader: async () => { blocked++; throw sentinel; },
      });
      throw new Error("confirmation_not_blocked");
    } catch (error) { if (error !== sentinel) throw error; }
    need(blocked === 1, "confirmation_not_blocked");
    const receipt = { planDigest: bundle.plan.confirmation, modulesBlocked: 1, providerDispatches: 0 };
    await durable(join(directory, "blocked-confirmation.json"), receipt, true);
    rows.push({ shard, planDigest: bundle.plan.confirmation, expectedUSD: bundle.estimate.expectedUsd ?? null,
      upperUSD: bundle.estimate.upperUsd ?? null, reservationUSD: bundle.chunks.reduce((n, c) => n + (c.reservationUsd ?? 0), 0), ceilingUSD: bundle.ceilingUSD, admissible: bundle.admissible });
  }
  const result = { schema: "holdout-dry-plans-v1", accounting: "catalog accounting, not an invoice; Codex stream_abort cannot guarantee containment", admissible: rows.every(r => r.admissible), shards: rows };
  await durable(join(output, "dry-plans.json"), result, true); return result;
}

export function invalidUnit(unit, plan) {
  const probes = plan.corpus.traces.find(t => t.id === unit.traceId)?.probes ?? [];
  if (!unit.complete || unit.checkpoint?.error || unit.trials.length !== probes.length
    || unit.trials.some(t => t.status !== "completed" || !t.boundary?.verified || t.pressure?.applicable && !t.pressure.verified)) return true;
  return unit.arm === "continuity-ledger-cold" && (!unit.checkpoint?.upkeep?.valid
    || unit.checkpoint.upkeep.preparations?.length !== 3 || !preparationIntegrity(unit.checkpoint.upkeep.preparations));
}
export function validateUnit(unit, plan, traceId) {
  need(unit.confirmation === plan.confirmation && unit.executionKind === "real" && unit.traceId === traceId
    && plan.corpus.traces.some(t => t.id === unit.traceId) && HOLDOUT_ARMS.includes(unit.arm)
    && Number.isSafeInteger(unit.repeat) && unit.repeat >= 1 && unit.repeat <= plan.repeats
    && unit.manifest?.codeRevision === plan.codeRevision && unit.manifest.dirty === false && Array.isArray(unit.trials), "unit_binding_mismatch");
  const probes = plan.corpus.traces.find(t => t.id === traceId).probes, seen = new Set();
  for (const trial of unit.trials) {
    if (trial?.status === "not_started" && Object.keys(trial).length === 1) continue;
    need(trial.traceId === traceId && trial.arm === unit.arm && trial.repeat === unit.repeat && probes.includes(trial.probeId)
      && !seen.has(trial.probeId), "trial_membership_mismatch"); seen.add(trial.probeId);
  }
}
export async function chunkUnits(root, plan, traceId) {
  let names; try { names = await readdir(join(root, "units")); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const units = [], seen = new Set();
  for (const name of names.sort()) {
    need(name.endsWith(".json"), "unexpected_unit_file");
    const unit = JSON.parse((await regularFile(join(root, "units", name))).toString("utf8")); validateUnit(unit, plan, traceId);
    need(!seen.has(unitKey(unit)), "duplicate_unit"); seen.add(unitKey(unit)); units.push(unit);
  }
  return units;
}
export function pendingAuditGate(statistics, complete) {
  const extra = [...(!complete ? ["controller-material:inconclusive"] : []), "audit-workflow-pending:inconclusive"];
  statistics.decision.reasons.push(...extra);
  statistics.decision.gates.push(...extra.map(reason => ({ name: reason.split(":")[0], status: "inconclusive" })));
  if (statistics.decision.status === "pass") statistics.decision.status = "inconclusive";
  return statistics;
}
export async function joinShards(context, roots, output, auditPath) {
  const { accountUnits, spendOf, CONTROLLER_STOPS } = await import("./continuity-holdout-controller.mjs");
  const trials = [], stops = [], seen = new Set(), shardIds = new Set(); let complete = true;
  for (const rootInput of roots) {
    const root = await externalDirectory(rootInput), state = await readJson(join(root, "controller.json"));
    const bundle = context.plans.find(b => b.plan.holdout.shard === state.shard);
    need(bundle && !shardIds.has(state.shard), "duplicate_or_unknown_shard"); shardIds.add(state.shard);
    need(state.schema === "holdout-controller-v1" && state.binding === digest(bundle) && state.stop?.reconciled === true
      && CONTROLLER_STOPS.includes(state.stop.reason) && /^[a-f0-9]{64}$/u.test(state.authorizationSha256 ?? "")
      && state.chunks.every(c => c.state !== "running"), "controller_binding_or_stop_mismatch");
    stops.push({ shard: state.shard, stop: state.stop, spend: state.spend, controllerSha256: sha256(await regularFile(join(root, "controller.json"))) });
    complete &&= state.stop.reason === "completed" && state.chunks.length === bundle.chunks.length;
    const names = await readdir(root);
    need(names.every(n => ["controller.json", "chunks"].includes(n) || n.startsWith("controller-lock.sqlite")), "unexpected_controller_file");
    const chunkNames = names.includes("chunks") ? await readdir(join(root, "chunks")) : [];
    need(digest(chunkNames.sort()) === digest(state.chunks.map((_, i) => String(i + 1)).sort()), "unexpected_chunk_directory");
    const admissions = new Set(), reconciledChunks = [];

    for (const [index, chunk] of state.chunks.entries()) {
      need(chunk.traceId === bundle.chunks[index]?.traceId && chunk.reservationUsd === bundle.chunks[index]?.reservationUsd
        && !admissions.has(chunk.traceId) && ["finished", "failed", "killed", "lost"].includes(chunk.state), "chunk_membership_mismatch"); admissions.add(chunk.traceId);
      const directory = join(root, "chunks", String(index + 1));
      if (!chunk.archiveSha256) {
        need(chunk.state !== "finished", "missing_archive"); complete = false;
        try { need((await readdir(directory)).length === 0, "unarchived_material"); } catch (e) { if (e.code !== "ENOENT") throw e; }
        reconciledChunks.push({ ...chunk, accounting: accountUnits([], bundle), unitFiles: 0 }); continue;
      }
      await verifyArchive(directory, chunk.archiveSha256);
      const units = await chunkUnits(directory, bundle.plan, chunk.traceId);
      const accounting = accountUnits(units, bundle);
      need(digest(accounting) === digest(chunk.accounting) && chunk.unitFiles === units.length, "accounting_mismatch");
      reconciledChunks.push({ ...chunk, accounting, unitFiles: units.length });
      complete &&= chunk.state === "finished" && units.length === HOLDOUT_ARMS.length * bundle.plan.repeats && units.every(u => !invalidUnit(u, bundle.plan));
      for (const unit of units) { need(!seen.has(unitKey(unit)), "duplicate_unit"); seen.add(unitKey(unit)); trials.push(...unit.trials); }
    }
    need(digest(spendOf(reconciledChunks, bundle.plan.arms.length * bundle.plan.repeats)) === digest(state.spend), "accounting_mismatch");
  }
  complete &&= shardIds.size === context.plans.length;
  const bound = await readBoundAudit(auditPath, context.options.registrationSha256);
  const statistics = holdoutStatistics({ conversations: context.registration.conversations, trials, audit: bound.audit,
    statisticalSpec: context.registration.statisticalSpec, measurement: true });
  // PR3b must establish the final unique-entry population and two-auditor evidence.
  // A bare totals file is not that proof, even if every numeric gate would pass.
  pendingAuditGate(statistics, complete);
  const result = { schema: "holdout-joined-v1", registrationSha256: context.options.registrationSha256,
    controllerComplete: complete, stops, auditBinding: bound.binding, statistics };
  output = await externalDirectory(output, true);
  await durable(join(output, "joined.json"), result, true); return result;
}
