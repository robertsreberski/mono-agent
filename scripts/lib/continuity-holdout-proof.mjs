import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOLDOUT_ARMS } from "./continuity-holdout-statistics.mjs";
import { makePlan } from "./continuity-dataset.mjs";
import { main as benchmark } from "../continuity-benchmark.mjs";
import { CHECKOUT, externalDirectory, sha256, regularFile } from "./continuity-holdout-files.mjs";
import { seeded } from "./continuity-holdout-registration.mjs";
import { preparationIntegrity, verifyLedgerTreatment } from "./continuity-runner.mjs";
import { benchmarkArgs, durable, need } from "./continuity-holdout-workflow.mjs";

export function representatives(conversations, seed) {
  const next = seeded(seed), families = [...new Set(conversations.map(c => c.family))].sort();
  return families.map(family => {
    const pool = conversations.filter(c => c.family === family).sort((a, b) => a.id.localeCompare(b.id, "en"));
    return pool[Math.floor(next() * pool.length)].id;
  });
}
export function checkProofUnit(unit) {
  need(unit.executionKind === "offline" && unit.complete && !unit.checkpoint?.error && unit.trials.length > 0
    && unit.trials.every(t => t.status === "completed" && t.boundary?.verified && (!t.pressure?.applicable || t.pressure.verified)), "offline_boundary_unverified");
  if (unit.arm !== "continuity-ledger-cold") return;
  const upkeep = unit.checkpoint.upkeep, steps = upkeep?.preparations;
  need(upkeep?.valid && steps?.length === 3 && preparationIntegrity(steps), "offline_preparation_integrity");
  need(new Set(steps.map(s => s.journal?.databaseId)).size === 1 && steps.every(s => s.journal?.databaseId), "offline_database_identity");
  let frontier = 0;
  for (const step of steps) {
    const scan = step.observed?.upkeepScans?.[0], fit = step.observed?.upkeepSelections?.[0], journal = step.journal;
    need(scan?.complete && ["rows", "bytes", "windows"].every(k => Number.isFinite(scan[k]) && scan[k] <= scan.limits[k])
      && fit?.fitted === journal.offered.length && fit.fitted <= 8 * fit.deltaCap && fit.projectionAttempts <= 4096, "offline_scan_budget");
    const cursor = JSON.parse(journal.frontier); need(cursor.ordinal >= frontier, "offline_frontier_regressed"); frontier = cursor.ordinal;
    need(journal.offerCounts.every(v => v.offer_count <= 2) && journal.compact.identities === 0, "offline_offer_budget");
  }
  for (const trial of unit.trials) {
    need(verifyLedgerTreatment(upkeep, trial.boundary.observed), "offline_injection");
    need((trial.boundary.observed.upkeepScans ?? []).length === 0
      && (trial.boundary.observed.upkeep ?? []).every(r => !r.providerInvoked && !r.operationId), "offline_probe_upkeep");
  }
}
async function sourceRenderProof(root, unit) {
  const { spanKey, ledgerHash, renderLedger } = await import(pathToFileURL(join(CHECKOUT, "packages/conversation/dist/continuity/ledger.js")).href);
  const path = join(root, "work", `cp-${unit.traceId}_ledger-continuity-ledger-cold-r1`, "work/history/tool-history/tool-lifecycles.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const scope = unit.checkpoint.conversationId;
    const rows = db.prepare("SELECT r.* FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE g.conversation_id=? AND retained_text IS NOT NULL ORDER BY ordinal").all(scope);
    const tools = new Map(db.prepare("SELECT run_id,tool_call_id,tool_name FROM tool_calls WHERE conversation_id=?").all(scope)
      .map(c => [`tool:${ledgerHash(JSON.stringify([scope, c.run_id, c.tool_call_id]))}`, c.tool_name]));
    const records = rows.map(r => ({ recordId: r.record_id, generationId: r.generation_id, conversationId: scope, runId: r.run_id,
      ...(r.input_id ? { inputId: r.input_id } : {}), kind: r.kind, provenance: r.provenance, source: JSON.parse(r.source_json), ordinal: r.ordinal,
      sequence: r.seq, text: r.retained_text, sha256: r.text_sha256, originalBytes: r.original_bytes, retainedBytes: r.retained_bytes,
      redacted: !!r.redacted, truncated: !!r.truncated, untrusted: true }));
    const byOrdinal = new Map(records.map(r => [r.ordinal, r])), byId = new Map(records.map(r => [r.recordId, r]));
    const counts = new Map();
    for (const [index, step] of unit.checkpoint.upkeep.preparations.entries()) {
      for (const offer of step.journal.offered) {
        const record = byOrdinal.get(offer.ordinal);
        need(record && record.sha256 === sha256(record.text) && offer.digest === record.sha256, "offline_offered_digest");
        const text = Buffer.from(record.text).subarray(offer.start, offer.end).toString("utf8");
        const owner = record.kind === "owner" && record.provenance === "host-owner" && record.inputId === record.source.attestation?.inputId;
        need(spanKey({ ...offer, recordId: record.recordId, sha256: record.sha256, digest: ledgerHash(text), owner, kind: record.kind,
          ...(tools.has(record.source.operationId) ? { toolName: tools.get(record.source.operationId) } : {}) }) === offer.key, "offline_offered_identity");
        counts.set(offer.key, (counts.get(offer.key) ?? 0) + 1);
        need(counts.get(offer.key) <= 2 && ledgerHash(text) === sha256(text), "offline_span_budget");
      }
      const capture = JSON.parse((await regularFile(join(root, "upkeep-output", `r1-${unit.traceId}-p${index + 1}.json`))).toString("utf8"));
      const generation = capture.ledger;
      if (!generation) continue; // An analyzed empty delta is valid; injection is independently verified.
      for (const span of generation.spans) {
        const record = byId.get(span.recordId);
        need(record && span.ordinal === record.ordinal && record.sha256 === sha256(record.text)
          && span.sha256 === record.sha256 && Number.isSafeInteger(span.start) && span.start >= 0 && Number.isSafeInteger(span.end)
          && span.end > span.start && span.end <= Buffer.byteLength(record.text)
          && span.digest === sha256(Buffer.from(record.text).subarray(span.start, span.end))
          && span.owner === (record.kind === "owner" && record.provenance === "host-owner" && record.inputId === record.source.attestation?.inputId), "offline_host_citation");
      }
      const saved = JSON.stringify(generation), rendered = renderLedger(generation, records);
      const lines = rendered.split("\n").filter(line => line.startsWith("Derived "));
      const order = lines.map(line => Number(line.match(/ order=(\d+) status=/u)?.[1]));
      const expected = generation.entries.map(e => Math.max(...e.sources.map(id => generation.spans.find(s => s.id === id)?.ordinal))).sort((a, b) => a - b);
      need(JSON.stringify(order) === JSON.stringify(expected) && order.every(Number.isSafeInteger)
        && lines.every(line => Buffer.byteLength(line + "\n") <= 1024) && saved === JSON.stringify(generation), "offline_render_order_or_storage");
    }
    return { retainedRecords: records.length, preparationChildren: unit.checkpoint.upkeep.preparations.map(s => s.pid) };
  } finally { db.close(); }
}
export async function auditProofOutput(context, directory, selected, limit) {
    const saved = JSON.parse((await regularFile(join(directory, "plan.json"))).toString("utf8"));
    const expected = makePlan({ ...context.loaded, suite: "holdout", profile: context.profile, codeRevision: context.registration.codeRevision, repeats: 1, probeLimit: limit });
    need(saved.confirmation === expected.confirmation && saved.executionKind === "offline", "offline_plan_mismatch");
    const files = (await readdir(join(directory, "units"))).sort(), identities = new Set(), children = new Set();
    need(files.length === selected.length * 4, "offline_units_missing");
    for (const file of files) {
      const unit = JSON.parse(await readFile(join(directory, "units", file), "utf8"));
      need(selected.includes(unit.traceId) && HOLDOUT_ARMS.includes(unit.arm) && unit.repeat === 1 && unit.trials.length === limit
        && unit.confirmation === expected.confirmation && unit.manifest?.codeRevision === context.registration.codeRevision, "offline_membership");
      const probes = new Set();
      for (const trial of unit.trials) {
        need(trial.traceId === unit.traceId && trial.arm === unit.arm && trial.repeat === 1 && !probes.has(trial.probeId)
          && expected.corpus.traces.find(t => t.id === unit.traceId).probes.includes(trial.probeId), "offline_trial_membership"); probes.add(trial.probeId);
      }
      const identity = `${unit.traceId}/${unit.arm}`; need(!identities.has(identity), "offline_duplicate_unit"); identities.add(identity);
      checkProofUnit(unit);
      if (unit.arm === "continuity-ledger-cold") {
        const source = await sourceRenderProof(directory, unit);
        for (const pid of source.preparationChildren) { need(!children.has(pid), "offline_child_reused"); children.add(pid); }
      }
    }
    return children.size;
}
export async function offlineProof(context, output, { onPhase = () => {}, scope = "both", run = benchmark } = {}) {
  need(["both", "all", "representative"].includes(scope), "invalid_proof_scope");
  onPhase({ phase: "controller-start" });
  need(!Object.keys(process.env).some(k => /^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|CODEX|PI)_.*(API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/u.test(k)), "offline_credentials_present");
  output = await externalDirectory(output, true);
  const subset = representatives(context.registration.conversations, context.registration.seed), receipts = [];
  for (const [label, limit, selected] of [["all", 1, context.registration.conversations.map(c => c.id)], ["representative", 15, subset]]) {
    if (scope !== "both" && scope !== label) continue;
    onPhase({ phase: "proof-phase-start", label });
    const directory = join(output, label); await mkdir(directory, { mode: 0o700 });
    const code = await run([...benchmarkArgs(context), "--repeats", "1", "--probe-limit", String(limit),
      "--output", directory, "--concurrency", "8", "--capture-upkeep-output", "--keep-work", ...(label === "all" ? [] : selected.flatMap(id => ["--trace", id]))], { stdout: () => {}, onPhase: event => onPhase({ ...event, label }) });
    need([0, 1].includes(code), "offline_run_failed");
    const children = await auditProofOutput(context, directory, selected, limit);
    receipts.push({ label, conversations: selected, probes: limit, units: selected.length * 4, preparationChildren: children, passed: true });
    await durable(join(output, `${label}-proof.json`), receipts.at(-1), true);
    onPhase({ phase: "proof-phase-completion", label });
  }
  const proof = { schema: "holdout-offline-proof-v1", registrationSha256: context.options.registrationSha256,
    qualityMeasured: false, selectionSeed: context.registration.seed, receipts };
  await durable(join(output, "offline-proof.json"), proof, true); return proof;
}
