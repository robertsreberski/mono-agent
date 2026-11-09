// Private generated output, never an authorization binding or a public report.
import { join, isAbsolute } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { E2_SUMMARY_RECEIPT, E2_SUMMARY_RESULTS_DIRECTORY, E2_ARTIFACT_LIMITS } from "./continuity-e2-policy.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("e2_summary_receipt_invalid"), { code: "e2_summary_receipt_invalid" }); };
const hash = s => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
export function e2SummaryResultPath(root, slotId, round) {
  need(typeof root === "string" && isAbsolute(root) && hash(slotId) && Number.isSafeInteger(round) && round > 0);
  return join(root, E2_SUMMARY_RESULTS_DIRECTORY, `${slotId}-${round}.json`);
}
export async function writeE2SummaryResult(contract, message, rawUsage, tier, payloadDigest) {
  if (contract.e2.paidRole !== "summary") return { message };
  const snapshot = JSON.parse(JSON.stringify(message));
  need(snapshot?.role === "assistant" && snapshot.stopReason === "stop" && Array.isArray(snapshot.content)
    && snapshot.content.some(p => p.type === "text" && typeof p.text === "string" && p.text.trim()));
  const receipt = { schema: E2_SUMMARY_RECEIPT, requestId: `${contract.runId}:${contract.e2.round}`, slotId: contract.slotId,
    round: contract.e2.round, model: contract.e2.model, payloadDigest, message: snapshot, rawUsage, tier: ["default", "flex", "priority"].includes(tier) ? tier : null };
  need(Buffer.byteLength(JSON.stringify(receipt)) <= E2_ARTIFACT_LIMITS.summaryBytes);
  const sha256 = digest(receipt);
  const { durable } = await import("./continuity-holdout-workflow.mjs");
  await durable(e2SummaryResultPath(contract.e2.outputRoot, contract.slotId, contract.e2.round), receipt, true);
  return { message: snapshot, evidence: { schema: E2_SUMMARY_RECEIPT, sha256 } };
}
export async function verifyE2SummaryResult(root, slotId, hold, evidence, readPrivate) {
  need(evidence && Object.keys(evidence).sort().join() === "schema,sha256" && evidence.schema === E2_SUMMARY_RECEIPT && hash(evidence.sha256));
  const receipt = await readPrivate(e2SummaryResultPath(root, slotId, hold.round));
  need(Buffer.byteLength(JSON.stringify(receipt)) <= E2_ARTIFACT_LIMITS.summaryBytes);
  need(Object.keys(receipt).sort().join() === "message,model,payloadDigest,rawUsage,requestId,round,schema,slotId,tier"
    && digest(receipt) === evidence.sha256 && receipt.schema === E2_SUMMARY_RECEIPT && receipt.slotId === slotId
    && receipt.round === hold.round && receipt.requestId === hold.requestId && receipt.model === hold.model && receipt.payloadDigest === hold.payloadDigest
    && digest(receipt.rawUsage) === digest(hold.settlement.rawUsage) && receipt.tier === hold.settlement.tier
    && receipt.message?.role === "assistant" && receipt.message.stopReason === "stop" && Array.isArray(receipt.message.content)
    && receipt.message.content.some(p => p.type === "text" && typeof p.text === "string" && p.text.trim()));
  return { schema: E2_SUMMARY_RECEIPT, sha256: evidence.sha256, verified: true, durable: false };
}
