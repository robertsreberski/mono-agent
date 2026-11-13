import { createHash } from "node:crypto";
import { evidenceDigest } from "./journal-digest.js";
import type { RuntimeRetainedSummaryAccess, RuntimeRetainedSummaryReceipt } from "../contracts/retained-summary.js";

const object = (x: any) => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x: any, names: string[]) => object(x) && Object.keys(x).length === names.length && Object.keys(x).every(key => names.includes(key));
const id = (x: any) => typeof x === "string" && x.length > 0 && Buffer.byteLength(x) <= 4096;
const digest = (x: any) => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const integer = (x: any) => Number.isSafeInteger(x) && x >= 0;
const hash = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const failure = () => Object.assign(new Error("Invalid retained summary admission authority"), { code: "ERR_RETAINED_SUMMARY_AUTHORITY" });
export const retainedSummaryFallbackWarning = { type: "warning", code: "retained_summary_legacy_fallback",
  message: "Retained summary protection unavailable; continuing with legacy context." } as const;

/** Closed, bounded metadata only; no retained-text copy. */
export function validRetainedSummaryReceipt(p: any): p is RuntimeRetainedSummaryReceipt {
  if (!keys(p, ["version", "binding", "selection", "destination", "seed"]) || p.version !== 1 || Buffer.byteLength(JSON.stringify(p)) > 8192) return false;
  const b = p.binding, s = p.selection, d = p.destination;
  return keys(b, ["version", "logicalConversationId", "conversationId", "generationId", "recordId", "sha256", "retainedBytes", "sourceEpoch", "sourceRevision", "publication"])
    && b.version === 1 && [b.logicalConversationId, b.conversationId, b.generationId, b.recordId, b.sourceEpoch].every(id)
    && digest(b.sha256) && integer(b.retainedBytes) && b.retainedBytes <= 1024 * 1024 && integer(b.sourceRevision)
    && keys(b.publication, ["journalId", "operationId", "sourceDigest", "summaryDigest"])
    && [b.publication.journalId, b.publication.operationId].every(id) && digest(b.publication.sourceDigest) && b.publication.summaryDigest === b.sha256
    && keys(s, ["recordId", "generationId", "sha256", "retainedBytes", "packSha256", "entry"])
    && ["recordId", "generationId", "sha256", "retainedBytes"].every(key => s[key] === b[key]) && digest(s.packSha256)
    && keys(s.entry, ["startByte", "endByte", "sha256"]) && integer(s.entry.startByte) && integer(s.entry.endByte)
    && s.entry.endByte > s.entry.startByte && s.entry.endByte <= 128 * 1024 && digest(s.entry.sha256)
    && keys(d, ["logicalConversationId", "conversationId", "epoch", "handleId", "journalId"]) && Object.values(d).every(id)
    && d.logicalConversationId === b.logicalConversationId && d.conversationId === b.conversationId
    && keys(p.seed, ["entryId", "messageDigest"]) && id(p.seed.entryId) && digest(p.seed.messageDigest);
}

function seedText(message: any): string {
  if (message?.role !== "user") throw failure();
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.length !== 1
    || message.content[0]?.type !== "text" || typeof message.content[0].text !== "string") throw failure();
  return message.content[0].text;
}
export function assertRetainedSummarySeed(receipt: RuntimeRetainedSummaryReceipt, message: any, text?: string): void {
  if (!validRetainedSummaryReceipt(receipt) || evidenceDigest(message) !== receipt.seed.messageDigest) throw failure();
  const pack = Buffer.from(seedText(message)), { startByte, endByte, sha256 } = receipt.selection.entry;
  if (hash(pack) !== receipt.selection.packSha256 || endByte > pack.length || hash(pack.subarray(startByte, endByte)) !== sha256) throw failure();
  if (text !== undefined) {
    const quote = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
    const entry = `Generated summary evidence id=${quote(receipt.binding.recordId)} sha256=${quote(receipt.binding.sha256)}: ${quote(text)}\n`;
    if (hash(text) !== receipt.binding.sha256 || Buffer.byteLength(text) !== receipt.binding.retainedBytes
      || !pack.subarray(startByte, endByte).equals(Buffer.from(entry))) throw failure();
  }
}

/** Raw branch state wins over repaired projection. Covered admissions no longer
 * depend on the source; rewind makes them active again, with legacy fallback if
 * that source has since been removed. No bytes are recovered from source journals. */
export async function resolveRetainedSummaryAdmission(raw: any, access?: RuntimeRetainedSummaryAccess, onFallback?: () => void): Promise<{ admissionId: string; text: string } | undefined> {
  const admission = raw.validator.retainedSummaryAdmission;
  if (!admission) return undefined;
  const p: RuntimeRetainedSummaryReceipt = admission.payload;
  // Structural integrity is independent of the optional continuity capability.
  if (!validRetainedSummaryReceipt(p) || p.destination.handleId !== raw.metadata.id || p.destination.journalId !== raw.metadata.journalId
    || raw.validator.owner.kind !== "host" || raw.validator.owner.ownerKey !== p.destination.logicalConversationId
    || raw.validator.owner.historyBucket !== p.destination.conversationId) throw failure();
  const entries = await raw.getEntries();
  if (entries.some((entry: any) => entry.checkpoint?.retainedSummaryCoverage?.admissionId === admission.id)) return undefined;
  if (!entries.some((entry: any) => entry.id === p.seed.entryId)) return undefined;
  const seed = await raw.getEntry(p.seed.entryId);
  assertRetainedSummarySeed(p, seed?.message);
  // A raw native checkpoint wins, including after projection repair.
  if (entries.some((entry: any) => entry.type === "compaction")) return undefined;
  const legacy = () => { try { onFallback?.(); } catch { /* Diagnostics cannot block legacy execution. */ } return undefined; };
  if (!access) return legacy();
  if (["logicalConversationId", "conversationId", "epoch", "handleId"].some(key => (p.destination as any)[key] !== (access.destination as any)[key])) throw failure();
  let proof;
  try { await access.assertCurrent(); proof = await access.resolve(p.binding); await access.assertCurrent(); }
  catch { return legacy(); } // Optional source/owner capability loss must not strand the native session.
  if (!proof || typeof proof.text !== "string" || hash(proof.text) !== p.binding.sha256
    || Buffer.byteLength(proof.text) !== p.binding.retainedBytes) return legacy(); // Source loss or mismatch.
  // Matching source bytes cannot excuse a receipt-side quotation commitment mismatch.
  assertRetainedSummarySeed(p, seed.message, proof.text);
  return { admissionId: admission.id, text: proof.text };
}
