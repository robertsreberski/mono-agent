import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHECKOUT, externalFile, externalDirectory, regularFile, jsonBytes, sha256 } from "./continuity-holdout-files.mjs";
import { createHmac, randomBytes } from "node:crypto";
import { digest } from "./continuity-dataset.mjs";
import { checkLedgerView } from "./continuity-holdout-proof.mjs";
import { need, durable, joinShards, chunkDirectory, verifyArchive, chunkUnits } from "./continuity-holdout-workflow.mjs";

const ledgerModule = () => import(pathToFileURL(join(CHECKOUT, "packages/conversation/dist/continuity/ledger.js")).href);
export const AUDIT_FLAGS = ["label", "context", "chronology", "falseSupersession", "binding", "historicalCaution"];
export async function auditRubric(context) {
  const bytes = await regularFile(join(CHECKOUT, "scripts/continuity-holdout/audit-rubric.json"));
  need(sha256(bytes) === context.registration.rubricSha256, "audit_rubric_mismatch");
  const rubric = JSON.parse(bytes); need(rubric.schema === "holdout-audit-rubric-v1" && digest(rubric.flags) === digest(AUDIT_FLAGS), "audit_rubric_invalid");
  return { rubric, bytes, sha256: sha256(bytes) };
}
export async function verifiedJoin(context, roots, path) {
  const bytes = await externalFile(path), value = JSON.parse(bytes);
  need(!value.auditBinding, "diagnostic_totals_not_certifiable");
  const fresh = await joinShards(context, roots, null);
  need(jsonBytes(fresh) === bytes.toString("utf8"), "audit_join_mismatch");
  return { value: fresh, sha256: sha256(bytes) };
}
async function material(root, verified, name) {
  need(Object.hasOwn(verified.files, name), "audit_material_missing");
  const bytes = await regularFile(join(root, name)); need(sha256(bytes) === verified.files[name], "audit_material_changed"); return bytes;
}
async function snapshot(root, verified, name, scratch, fn) {
  const directory = await mkdtemp(join(scratch, "snapshot-")), path = join(directory, "store.sqlite"); let db;
  try {
    await writeFile(path, await material(root, verified, name), { mode: 0o600 });
    for (const suffix of ["-wal", "-shm"]) if (Object.hasOwn(verified.files, name + suffix)) await writeFile(path + suffix, await material(root, verified, name + suffix), { mode: 0o600 });
    db = new DatabaseSync(path, { readOnly: true }); return await fn(db);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}
function nativeRecords(db, scope, ledgerHash) {
  const rows = db.prepare("SELECT r.*,g.logical_id,g.conversation_id,g.state generation_state FROM continuity_records r JOIN continuity_generations g USING(generation_id) WHERE g.conversation_id=? AND g.logical_id=? AND g.state='committed' AND r.finalized=1 AND r.retained_text IS NOT NULL").all(scope, scope);
  const tools = new Map(db.prepare("SELECT run_id,tool_call_id,tool_name FROM tool_calls WHERE conversation_id=?").all(scope)
    .map(c => [`tool:${ledgerHash(JSON.stringify([scope, c.run_id, c.tool_call_id]))}`, c.tool_name]));
  return rows.map(r => {
    const source = JSON.parse(r.source_json), owner = r.kind === "owner" && r.provenance === "host-owner";
    need(r.finalized === 1 && r.generation_state === "committed" && r.logical_id === scope && r.text_sha256 === sha256(r.retained_text)
      && (!owner || r.input_id && source.attestation?.inputId === r.input_id && /^[a-f0-9]{64}$/u.test(source.attestation?.requestDigest ?? "")), "audit_native_binding");
    if (r.kind === "tool") need(tools.has(source.operationId), "audit_tool_binding");
    return { recordId: r.record_id, generationId: r.generation_id, conversationId: scope, inputId: r.input_id,
      ordinal: r.ordinal, kind: r.kind, provenance: r.provenance, source, sha256: r.text_sha256, text: r.retained_text,
      ...(tools.has(source.operationId) ? { tool: { name: tools.get(source.operationId) } } : {}) };
  });
}
function generationEvidence(generation, records, scope, ledger) {
  need(generation.conversationId === scope && generation.logicalId === scope && Array.isArray(generation.inputs)
    && generation.manifest === ledger.ledgerHash(JSON.stringify(generation.spans))
    && new Set(generation.entries.map(e => e.id)).size === generation.entries.length
    && generation.entries.every(e => typeof e.id === "string" && e.id && e.sources.length > 0), "audit_generation_binding");
  const byId = new Map(records.map(r => [r.recordId, r]));
  for (const input of generation.inputs) need(byId.get(input.recordId)?.sha256 === input.sha256, "audit_input_binding");
  for (const span of generation.spans) need(generation.inputs.some(i => i.recordId === span.recordId && i.sha256 === span.sha256), "audit_input_binding");
  const rendered = checkLedgerView(generation, records, ledger.renderLedger);
  return { ...rendered, items: generation.entries.map(entry => ({ entry, sources: entry.sources.map(id => {
    const span = generation.spans.find(s => s.id === id), record = byId.get(span.recordId);
    return { spanId: id, recordId: record.recordId, ordinal: record.ordinal, owner: span.owner, kind: record.kind,
      provenance: record.provenance, ...(record.tool ? { tool: record.tool.name } : {}), text: Buffer.from(record.text).subarray(span.start, span.end).toString("utf8") };
  }) })) };
}
export async function checkpointAudit(root, verified, unit, scratch, ledger) {
  const scope = unit.checkpoint.conversationId, prefix = `work/cp-${unit.traceId}_ledger-continuity-ledger-cold-r${unit.repeat}/work/history/tool-history/tool-lifecycles.sqlite`;
  need(scope && unit.checkpoint.upkeep?.preparations?.length === 3, "audit_checkpoint_missing");
  return snapshot(root, verified, prefix, scratch, async db => {
    const records = nativeRecords(db, scope, ledger.ledgerHash), publications = new Map(), items = [], captures = [];
    const counters = { publications: 0, captureViews: 0, probeViews: 0, derivedLines: 0, receiptRelabels: 0, receiptDowngrades: 0, d6InputOverruns: 0, d6OutputOverruns: 0 };
    let latest = null;
    for (const [index, step] of unit.checkpoint.upkeep.preparations.entries()) {
      const name = `upkeep-output/r${unit.repeat}-${unit.traceId}-p${index + 1}.json`, capture = JSON.parse(await material(root, verified, name)); captures.push(name);
      need(Object.hasOwn(capture, "ledger"), "audit_material_missing");
      const receipt = step.receipt;
      if (receipt?.operationId) {
        const row = db.prepare("SELECT outcome FROM continuity_upkeep_operations WHERE operation_id=?").get(receipt.operationId);
        need(row?.outcome, "audit_operation_binding"); const native = JSON.parse(row.outcome);
        // Native outcome precedes publication: the host adds generationId/analyzed later.
        for (const field of ["decisionRelabels", "outcomeDowngrades"]) need((native[field] ?? 0) === (receipt[field] ?? 0), "audit_operation_binding");
        need(!!native.outputOverrun === !!receipt.outputOverrun && (native.reason === "input_overrun") === (receipt.reason === "input_overrun"), "audit_operation_binding");
      }
      for (const [field, target] of [["decisionRelabels", "receiptRelabels"], ["outcomeDowngrades", "receiptDowngrades"]]) {
        const count = receipt?.[field] ?? 0; need(Number.isSafeInteger(count) && count >= 0, "audit_counter_invalid"); counters[target] += count;
      }
      counters.d6InputOverruns += Number(receipt?.reason === "input_overrun");
      counters.d6OutputOverruns += Number(receipt?.reason === "output_overrun" || receipt?.outputOverrun === true);
      const g = capture.ledger;
      if (!g) { need(!latest && !receipt?.generationId, "audit_publication_missing"); continue; }
      need(!receipt?.generationId || receipt.generationId === g.id, "audit_publication_binding");
      const evidence = generationEvidence(g, records, scope, ledger); counters.captureViews++; counters.derivedLines += evidence.derivedLines;
      if (!publications.has(g.id)) {
        need(g.parent === (latest?.id ?? null) && (!latest || latest.entries.every(old => g.entries.some(e => digest(e) === digest(old)))), "audit_ancestry_binding");
        publications.set(g.id, g); counters.publications++; items.push(...evidence.items);
      } else need(digest(publications.get(g.id)) === digest(g), "audit_generation_changed");
      latest = g;
    }
    const native = db.prepare("SELECT payload,payload_sha256 FROM continuity_ledger WHERE conversation_id=? AND logical_id=?").get(scope, scope);
    need(latest ? native && sha256(native.payload) === native.payload_sha256 && digest(ledger.normalizeLedger(JSON.parse(native.payload))) === digest(latest) : !native, "audit_latest_binding");
    for (const trial of unit.trials) {
      if (trial.status === "not_started") continue;
      const observed = trial.boundary?.observed;
      need(observed && !(observed.upkeep ?? []).some(r => r.providerInvoked || r.operationId) && !(observed.upkeepScans ?? []).length, "audit_probe_upkeep");
      need(Array.isArray(observed.continuityPacks) && observed.continuityPacks.length > 0
        && observed.continuityPacks.every(p => p.ledgerEntries === (latest?.entries.length ?? 0)), "audit_render_binding");
      for (const packet of observed.continuityPacks) { if (latest) counters.derivedLines += generationEvidence(latest, records, scope, ledger).derivedLines; counters.probeViews++; }
    }
    return { items, captures, counters };
  });
}
export async function mechanicalAudit(context, roots, joined, scratch) {
  await mkdir(scratch, { recursive: true, mode: 0o700 }); const ledger = await ledgerModule();
  const population = new Map(), failures = [], counters = { publications: 0, captureViews: 0, probeViews: 0, derivedLines: 0,
    receiptRelabels: 0, receiptDowngrades: 0, d6InputOverruns: 0, d6OutputOverruns: 0 }, checkpoints = new Set();
  for (const root of roots) {
    const controllerBytes = await externalFile(join(root, "controller.json")), state = JSON.parse(controllerBytes);
    need(joined.artifacts[`shards/${state.shard}/controller.json`] === sha256(controllerBytes), "audit_controller_binding");
    const bundle = context.plans.find(p => p.plan.holdout.shard === state.shard);
    for (const [index, chunk] of state.chunks.entries()) {
      const location = `shards/${state.shard}/chunks/${index + 1}`;
      if (!chunk.archiveSha256 || chunk.integrityError) { failures.push({ location, code: "audit_material_missing" }); continue; }
      const directory = await chunkDirectory(root, index), verified = await verifyArchive(directory, chunk.archiveSha256), consumed = new Set();
      const units = await chunkUnits(directory, bundle.plan, chunk.traceId, verified);
      for (const unit of units.filter(u => u.arm === "continuity-ledger-cold")) {
        const key = `${unit.traceId}/${unit.repeat}`, identity = context.registration.conversations.find(c => c.id === unit.traceId);
        try {
          const result = await checkpointAudit(directory, verified, unit, scratch, ledger); checkpoints.add(key);
          for (const name of result.captures) consumed.add(name);
          for (const [name, count] of Object.entries(result.counters)) counters[name] += count;
          for (const item of result.items) {
            const key = JSON.stringify([identity.corpus, identity.id, unit.repeat, item.entry.id]);
            const row = { corpus: identity.corpus, conversation: identity.id, repeat: unit.repeat, ...item };
            need(!population.has(key) || digest(population.get(key)) === digest(row), "audit_entry_changed"); population.set(key, row);
          }
        } catch (e) { failures.push({ location: `${location}/${key}`, code: /^(audit_|offline_)/u.test(e.message) ? e.message : "audit_material_unreadable" }); }
      }
      for (const name of Object.keys(verified.files).filter(n => n.startsWith("upkeep-output/"))) if (!consumed.has(name)) failures.push({ location: `${location}/${name}`, code: "audit_unbound_capture" });
    }
  }
  const expected = context.registration.conversations.length * context.registration.statisticalSpec.design.repeats;
  if (checkpoints.size !== expected) failures.push({ location: "population", code: "audit_checkpoints_missing" });
  const items = [...population].sort(([a], [b]) => a.localeCompare(b, "en")).map(([, item]) => item);
  return { schema: "holdout-mechanical-audit-v1", complete: joined.controllerComplete && failures.length === 0,
    expectedCheckpoints: expected, checkedCheckpoints: checkpoints.size, published: items.length, items,
    counters: { ...counters, uniqueRelabelled: items.filter(i => i.entry.decisionRelabelled).length, uniqueDowngraded: items.filter(i => i.entry.outcomeUnverified).length },
    failures: failures.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en")) };
}
export function blindExport(mechanical, joinSha256, rubricSha256, seed) {
  need(typeof seed === "string" && /^[a-f0-9]{64}$/u.test(seed), "audit_seed_invalid"); let counter = 0;
  const keyed = text => createHmac("sha256", Buffer.from(seed, "hex")).update(text).digest();
  const next = () => keyed(`shuffle:${counter++}`).readUInt32BE(0) / 0x100000000;
  const mapping = mechanical.items.map((item, i) => ({ id: keyed(`item:${joinSha256}:${i}`).toString("hex").slice(0, 24), item }));
  need(new Set(mapping.map(m => m.id)).size === mapping.length, "audit_blind_collision");
  for (let i = mapping.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [mapping[i], mapping[j]] = [mapping[j], mapping[i]]; }
  const items = mapping.map(({ id, item }) => ({ id, entry: Object.fromEntries(["kind", "value", "status", "decisionRelabelled", "outcomeUnverified"].filter(k => item.entry[k] !== undefined).map(k => [k, item.entry[k]])),
    evidence: item.sources.map((s, i) => ({ citation: i + 1, owner: s.owner, kind: s.kind, ...(s.tool ? { tool: s.tool } : {}), text: s.text })) }));
  const payload = { schema: "holdout-blind-export-v1", orderSeedSha256: sha256(Buffer.from(seed, "hex")), joinSha256, rubricSha256, populationComplete: mechanical.complete,
    disclosure: "True arm blinding is impossible: ledger structure identifies the treatment. Corpus, model, repeat, checkpoint, paths and probe outcomes are masked.", items };
  return { exported: { ...payload, exportSha256: sha256(jsonBytes(payload)) }, mapping };
}
export async function exportAudit(context, roots, joinedPath, output, seed = randomBytes(32).toString("hex")) {
  output = await externalDirectory(output, true); const rubric = await auditRubric(context), joined = await verifiedJoin(context, roots, joinedPath);
  const scratch = await mkdtemp(join(output, ".scratch-")); let mechanical;
  try { mechanical = await mechanicalAudit(context, roots, joined.value, scratch); } finally { await rm(scratch, { recursive: true, force: true }); }
  const blinded = blindExport(mechanical, joined.sha256, rubric.sha256, seed);
  await mkdir(join(output, "public"), { mode: 0o700 }); await mkdir(join(output, "private"), { mode: 0o700 });
  await durable(join(output, "private/mechanical.json"), mechanical, true);
  await durable(join(output, "private/map.json"), blinded.mapping, true);
  await durable(join(output, "private/order.json"), { schema: "holdout-audit-order-v1", seed }, true);
  await durable(join(output, "public/export.json"), blinded.exported, true);
  await durable(join(output, "public/rubric.json"), rubric.bytes, true);
  return { complete: mechanical.complete, entries: mechanical.published, exportSha256: blinded.exported.exportSha256, failures: mechanical.failures };
}
