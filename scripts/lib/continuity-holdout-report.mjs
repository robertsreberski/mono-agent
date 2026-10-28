import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { externalDirectory, externalFile, jsonBytes, sha256 } from "./continuity-holdout-files.mjs";
import { digest } from "./continuity-dataset.mjs";
import { holdoutStatistics } from "./continuity-holdout-statistics.mjs";
import { verifiedJoin } from "./continuity-holdout-audit.mjs";
import { auditInput, verifyAuditExport, evaluateImport, certification } from "./continuity-holdout-auditors.mjs";
import { durable, need, pendingAuditGate } from "./continuity-holdout-workflow.mjs";

/** Policy layer only. Callers must have revalidated the certificate, not merely totals. */
export function certifiedDecision(statistics, controllerComplete, certified) {
  pendingAuditGate(statistics, controllerComplete, certified);
  statistics.decision.gates.push({ name: "audit-certification", status: certified ? "pass" : "inconclusive" });
  if (!certified) {
    statistics.decision.reasons.push("audit-certification:inconclusive");
    if (statistics.decision.status === "pass") statistics.decision.status = "inconclusive";
  }
  return statistics;
}
export async function finalReport(context, roots, joinedPath, audit, output) {
  output = await externalDirectory(output, true);
  const joined = await verifiedJoin(context, roots, joinedPath), inputs = { ...joined.value.artifacts, "joined.json": joined.sha256,
    "registration.json": context.options.registrationSha256, "statistical-spec.json": context.registration.statisticalSpecSha256, "rubric.json": context.registration.rubricSha256 };
  const manifestBytes = await externalFile(context.options.manifestPath);
  need(sha256(manifestBytes) === context.options.manifestSha256, "report_manifest_mismatch"); inputs["freeze/manifest.json"] = sha256(manifestBytes);
  for (const [name, value] of Object.entries(JSON.parse(manifestBytes).files)) inputs[`freeze/${name}`] = value.sha256;
  const scratch = await mkdtemp(join(output, ".scratch-")); let collection = null, resolved = null, certified = false, error = "audit_input_missing";
  try {
    const savedCertificate = audit.certificate ? await auditInput(audit.certificate, "certificate.json", inputs) : null;
    collection = await verifyAuditExport(context, roots, joinedPath, audit.directory, scratch, inputs);
    resolved = await evaluateImport(collection, audit, inputs);
    if (resolved.phase === "certified") {
      const expected = certification(collection, resolved, Object.fromEntries(Object.entries(inputs).filter(([name]) => name === "joined.json" || name.startsWith("audit/") || ["auditor-a.json", "auditor-b.json", "adjudication.json"].includes(name))));
      need(savedCertificate && digest(savedCertificate) === digest(expected), "audit_certification_invalid");
      const imported = dirname(audit.certificate);
      for (const [name, value] of [["unmasked.json", resolved.unmasked], ["disagreements.json", resolved.disagreements], ["status.json", { phase: resolved.phase, disagreements: resolved.disagreements.length }]]) {
        const saved = await auditInput(join(imported, name), `audit-import/${name}`, inputs); need(digest(saved) === digest(value), "audit_import_output_mismatch");
      }
      certified = true; error = null;
    } else error = "audit_adjudication_required";
  } catch (e) { error = /^(audit_|diagnostic_)/u.test(e.message) ? e.message : "audit_evidence_invalid"; }
  finally { await rm(scratch, { recursive: true, force: true }); }
  const statistics = holdoutStatistics({ conversations: context.registration.conversations, trials: joined.value.trials,
    statisticalSpec: context.registration.statisticalSpec, audit: resolved?.totals ?? resolved?.lowerBounds ?? null, measurement: true });
  certifiedDecision(statistics, joined.value.controllerComplete, certified);
  const bindingErrors = collection?.mechanical.failures.filter(f => /binding|changed|host_citation|offered_digest/u.test(f.code)).length ?? 0;
  if (bindingErrors > context.registration.statisticalSpec.audit.bindingErrorsMaximum) {
    statistics.decision.status = "fail"; statistics.decision.gates.push({ name: "mechanical-provenance", status: "fail" }); statistics.decision.reasons.push("mechanical-provenance:fail");
  }
  const report = { schema: "holdout-final-report-v1", codeRevision: context.registration.codeRevision,
    registrationSha256: context.options.registrationSha256, joinSha256: joined.sha256,
    artifactInventory: "Raw file hashes are bound transitively: report -> archive-manifest SHA-256 -> per-file SHA-256. Every listed chunk was reverified from disk, chunk by chunk.",
    decision: statistics.decision, statistics, integrity: { ...statistics.integrity, controllerComplete: joined.value.controllerComplete,
      mechanicalComplete: collection?.mechanical.complete ?? false, auditCertified: certified, bindingErrors, auditError: error },
    accounting: "Catalog accounting, not an invoice; Codex stream_abort cannot guarantee containment. Unknown reader usage is reconciled only at chunk boundaries.",
    controllers: joined.value.stops, audit: { totals: resolved?.totals ?? resolved?.lowerBounds ?? null, counters: collection?.mechanical.counters ?? null,
      failures: collection?.mechanical.failures ?? [], disagreements: resolved?.disagreements.length ?? null }, inputArtifacts: inputs };
  const markdown = ["# Registered holdout report", "", `Decision: **${report.decision.status}**`, "", report.accounting, "",
    `Registration: ${report.registrationSha256}`, `Join: ${report.joinSha256}`, "", "## Gates", "",
    ...report.decision.gates.map(g => `- ${g.name}: ${g.status}`), "", "## Integrity and audit", "", "```json",
    JSON.stringify({ integrity: report.integrity, audit: report.audit }, null, 2), "```", "", report.artifactInventory, "", "See report.json for all intervals, counters and artifact bindings.", ""].join("\n");
  await durable(join(output, "report.json"), report, true); await durable(join(output, "report.md"), Buffer.from(markdown), true);
  const artifacts = { schema: "holdout-report-artifacts-v1", toolingRevision: context.registration.codeRevision, inventory: report.artifactInventory, inputs, outputs: { "report.json": sha256(jsonBytes(report)), "report.md": sha256(markdown) },
    note: "This detached manifest cannot include its own digest; pin its SHA-256 externally. Input keys are logical roles, never local absolute paths." };
  await durable(join(output, "artifacts.json"), artifacts, true);
  return { decision: report.decision, certified, reportSha256: artifacts.outputs["report.json"], artifactsSha256: sha256(jsonBytes(artifacts)) };
}
