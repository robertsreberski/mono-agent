import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { externalFile, externalDirectory, sha256, jsonBytes } from "./continuity-holdout-files.mjs";
import { digest } from "./continuity-dataset.mjs";
import { need, durable } from "./continuity-holdout-workflow.mjs";
import { AUDIT_FLAGS, auditRubric, verifiedJoin, mechanicalAudit, blindExport } from "./continuity-holdout-audit.mjs";

export async function auditInput(path, name, hashes) {
  need(typeof path === "string", "audit_input_missing");
  const bytes = await externalFile(path); hashes[name] = sha256(bytes); return JSON.parse(bytes);
}
export async function verifyAuditExport(context, roots, joinedPath, directory, scratch, hashes = {}) {
  need(typeof directory === "string", "audit_input_missing");
  const rubric = await auditRubric(context), joined = await verifiedJoin(context, roots, joinedPath);
  hashes["joined.json"] = joined.sha256;
  const saved = await auditInput(join(directory, "public/export.json"), "audit/public/export.json", hashes);
  const savedRubric = await externalFile(join(directory, "public/rubric.json")); hashes["audit/public/rubric.json"] = sha256(savedRubric);
  need(sha256(savedRubric) === rubric.sha256, "audit_rubric_mismatch");
  const order = await auditInput(join(directory, "private/order.json"), "audit/private/order.json", hashes); need(order.schema === "holdout-audit-order-v1", "audit_seed_invalid");
  const mechanical = await mechanicalAudit(context, roots, joined.value, scratch), expected = blindExport(mechanical, joined.sha256, rubric.sha256, order.seed);
  const original = await auditInput(join(directory, "private/mechanical.json"), "audit/private/mechanical.json", hashes);
  const mapping = await auditInput(join(directory, "private/map.json"), "audit/private/map.json", hashes);
  need(digest(original) === digest(mechanical) && digest(expected.exported) === digest(saved) && digest(expected.mapping) === digest(mapping), "audit_export_mismatch");
  return { joined, mechanical, exported: saved, mapping, rubricSha256: rubric.sha256 };
}
const flagsOf = row => Object.fromEntries(AUDIT_FLAGS.map(k => [k, row[k]]));
function rowsById(rows, expected) {
  need(Array.isArray(rows) && rows.length === expected.size, "audit_response_coverage"); const map = new Map();
  for (const row of rows) {
    need(expected.has(row?.id) && !map.has(row.id), "audit_response_membership");
    need(AUDIT_FLAGS.every(k => typeof row[k] === "boolean") && typeof row.rationale === "string" && row.rationale.trim().length > 0 && row.rationale.length <= 4096, "audit_response_invalid"); map.set(row.id, row);
  }
  return map;
}
function bound(doc, exported) {
  need(doc?.exportSha256 === exported.exportSha256 && doc.rubricSha256 === exported.rubricSha256, "audit_response_hash_mismatch");
}
function auditor(doc, exported) {
  bound(doc, exported);
  need(doc.schema === "holdout-auditor-v1" && /^[a-zA-Z0-9_-]{1,80}$/u.test(doc.auditorId ?? "")
    && ["notAuthor", "notTuner", "independentReview", "noOutcomeAccess"].every(k => doc.attestations?.[k] === true), "audit_independence_required");
  return rowsById(doc.items, new Set(exported.items.map(i => i.id)));
}
/** No identity map is returned until the complete, outcome-blind adjudication validates. */
export function resolveAuditors(collection, a, b, aSha256, bSha256, adjudication) {
  need(collection.mechanical.complete, "audit_mechanical_incomplete");
  const first = auditor(a, collection.exported), second = auditor(b, collection.exported);
  need(a.auditorId !== b.auditorId, "audit_independent_auditors_required");
  const disagreements = [...first].filter(([id, row]) => digest(flagsOf(row)) !== digest(flagsOf(second.get(id))))
    .map(([id, row]) => ({ id, first: flagsOf(row), second: flagsOf(second.get(id)) }));
  if (!adjudication) {
    const agreed = [...first].map(([id, row]) => Object.fromEntries(AUDIT_FLAGS.map(k => [k, row[k] && second.get(id)[k]])));
    return { phase: "awaiting-adjudication", disagreements, lowerBounds: { complete: false, published: collection.mechanical.published, audited: first.size,
      labelFindings: agreed.filter(r => r.label).length, contextFindings: agreed.filter(r => r.context).length,
      falselySupersededCurrent: agreed.filter(r => r.falseSupersession).length, bindingErrors: agreed.filter(r => r.binding).length } };
  }
  bound(adjudication, collection.exported);
  need(adjudication.schema === "holdout-adjudication-v1" && adjudication.blinded === true
    && typeof adjudication.adjudicatorId === "string" && adjudication.adjudicatorId.trim()
    && adjudication.auditorASha256 === aSha256 && adjudication.auditorBSha256 === bSha256, "audit_adjudication_binding");
  const resolutions = rowsById(adjudication.items, new Set(disagreements.map(d => d.id)));
  const judgments = collection.exported.items.map(({ id }) => resolutions.get(id) ?? first.get(id));
  const totals = { complete: true, published: collection.mechanical.published, audited: judgments.length,
    labelFindings: judgments.filter(r => r.label).length, contextFindings: judgments.filter(r => r.context).length,
    falselySupersededCurrent: judgments.filter(r => r.falseSupersession).length, bindingErrors: judgments.filter(r => r.binding).length,
    chronologyFindings: judgments.filter(r => r.chronology).length, historicalCautions: judgments.filter(r => r.historicalCaution).length };
  const unmasked = collection.mapping.map(({ id, item }) => ({ id, ...item, judgment: judgments.find(r => r.id === id) }));
  return { phase: "certified", disagreements, totals, unmasked };
}
export async function evaluateImport(collection, paths, hashes) {
  const a = await auditInput(paths.auditorA, "auditor-a.json", hashes), b = await auditInput(paths.auditorB, "auditor-b.json", hashes);
  const adjudication = paths.adjudication ? await auditInput(paths.adjudication, "adjudication.json", hashes) : null;
  return resolveAuditors(collection, a, b, hashes["auditor-a.json"], hashes["auditor-b.json"], adjudication);
}
export function certification(collection, resolved, hashes) {
  need(resolved.phase === "certified", "audit_adjudication_required");
  return { schema: "holdout-audit-certification-v1", joinSha256: collection.joined.sha256,
    exportSha256: collection.exported.exportSha256, rubricSha256: collection.rubricSha256,
    evidence: Object.fromEntries(Object.entries(hashes).filter(([key]) => key !== "certificate.json")),
    totals: resolved.totals, unmaskedSha256: sha256(jsonBytes(resolved.unmasked)) };
}
export async function importAudit(context, roots, joinedPath, directory, paths, output) {
  output = await externalDirectory(output, true); const scratch = await mkdtemp(join(output, ".scratch-")), hashes = {};
  try {
    const collection = await verifyAuditExport(context, roots, joinedPath, directory, scratch, hashes);
    const resolved = await evaluateImport(collection, paths, hashes);
    await durable(join(output, "disagreements.json"), resolved.disagreements, true);
    if (resolved.phase === "certified") {
      await durable(join(output, "unmasked.json"), resolved.unmasked, true);
      await durable(join(output, "certificate.json"), certification(collection, resolved, hashes), true);
    }
    await durable(join(output, "status.json"), { phase: resolved.phase, disagreements: resolved.disagreements.length }, true);
    return { phase: resolved.phase, disagreements: resolved.disagreements.length };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
