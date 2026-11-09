// Controller-owned committed-summary lineage. Never trust a child-supplied text hash.
import { join } from "node:path";
import { digest } from "./continuity-recorded-schema.mjs";
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { verifyE2SummaryResult, e2SummaryResultPath } from "./continuity-e2-summary-receipts.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("e2_summary_receipt_invalid"), { code: "e2_summary_receipt_invalid" }); };
const token = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(s);
const split = "\n\n---\n\n**Turn Context (split turn):**\n\n";
export const E2_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const E2_SUMMARY_SUFFIX = "\n</summary>";
export function e2PhaseBase(root, slot) {
  need(slot && ["proof", "replay"].includes(slot.kind));
  if (slot.kind === "replay") return join(root, "work", "replay");
  need(["switch", "cancel", "idle", "pressure"].includes(slot.arm) && ["ceiling", "restart"].includes(slot.variant));
  return join(root, "work", `${slot.arm}-${slot.variant}`);
}
export function e2PhaseWork(root, slot, branch) {
  if (slot.kind === "replay") { need([0, 1].includes(branch)); return join(e2PhaseBase(root, slot), `branch-${branch}`, "work"); }
  return join(e2PhaseBase(root, slot), "work");
}
export async function e2LineageScope(state, planned, checkpoint, readArtifact) {
  if (planned.kind === "proof") return "proof";
  const binding = state.pilot.registration.protocol;
  const bytes = await readArtifact(binding.path, "e2_summary_receipt_invalid"); need(digest(bytes) === binding.sha256);
  const protocol = JSON.parse(bytes); need(Number.isSafeInteger(checkpoint) && checkpoint >= 0);
  const first = protocol.branches[0].checkpoints.length, total = first + protocol.branches[1].checkpoints.length;
  need(checkpoint < total); return checkpoint < first ? 0 : 1;
}
const responseText = message => message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
function fileSuffix(details) {
  need(details && ["readFiles", "modifiedFiles"].every(k => Array.isArray(details[k]) && details[k].length <= 4096
    && details[k].every(s => typeof s === "string" && s.length <= 16384)));
  return [["read-files", details.readFiles], ["modified-files", details.modifiedFiles]]
    .map(([tag, paths]) => paths.length ? `\n\n<${tag}>\n${paths.join("\n")}\n</${tag}>` : "").join("");
}
export async function readE2Checkpoint(root, planned, reference, readArtifact) {
  try { return await readCheckpoint(root, planned, reference, readArtifact); }
  catch { need(false); }
}
async function readCheckpoint(root, planned, reference, readArtifact) {
  need(reference && token(reference.journalId) && token(reference.checkpointId));
  const work = e2PhaseWork(root, planned, reference.branch);
  const bytes = await readArtifact(join(work, "sessions", "journals", `${reference.journalId}.jsonl`), "e2_summary_receipt_invalid", 128 * 1024 * 1024);
  const lines = bytes.toString("utf8").split("\n"); need(lines.pop() === "" && lines.length > 1 && lines.length <= 1000000);
  const header = JSON.parse(lines.shift());
  const { JournalValidator, validateJournalHeader } = await import(new URL("../../packages/turn/dist/engine/journal-schema.js", import.meta.url).href);
  validateJournalHeader(header); need(header.journalId === reference.journalId && header.cwd === work);
  const validator = new JournalValidator(), records = lines.map(line => JSON.parse(line));
  for (const record of records) validator.apply(record);
  const record = records.find(r => r.id === reference.checkpointId), value = record?.payload?.compaction;
  need(record?.kind === "compaction" && records.filter(r => r.kind === "compaction").at(-1)?.id === record.id && value?.checkpoint?.summaryMessage?.summary === value.summary && typeof value.summary === "string"
    && value.summary.isWellFormed() && Buffer.byteLength(value.summary) <= 4 * 1024 * 1024 && value.summary.trim()
    && records.some(r => r.kind === "operation_end" && r.operationId === record.operationId && r.payload.status === "completed"));
  return { summary: value.summary, details: value.details, model: value.checkpoint.model, seq: record.seq };
}
export async function bindE2Checkpoint({ root, state, planned, slot, summaries, reference, readPrivate, readArtifact }) {
  const scope = await e2LineageScope(state, planned, reference.checkpoint, readArtifact);
  reference = { ...reference, ...(planned.kind === "replay" ? { branch: scope } : {}) };
  const checkpoint = await readE2Checkpoint(root, planned, reference, readArtifact), texts = [];
  need(summaries.length > 0 && summaries.length <= 2 && !(state.slots ?? []).some(s => s.checkpoints?.some(c => c.journalId === reference.journalId && c.checkpointId === reference.checkpointId)));
  for (const hold of summaries) {
    await verifyE2SummaryResult(root, slot.slotId, hold, { schema: hold.summaryReceipt.schema, sha256: hold.summaryReceipt.sha256 }, readPrivate);
    const result = await readPrivate(e2SummaryResultPath(root, slot.slotId, hold.round));
    need(`${checkpoint.model?.provider}:${checkpoint.model?.id}` === hold.model); texts.push(responseText(result.message));
  }
  const suffix = fileSuffix(checkpoint.details), candidates = texts.length === 2 ? [texts.join(split)] : [texts[0]];
  if (texts.length === 1) {
    const prior = slot.lineages?.[scope];
    const previous = prior ? await readE2Checkpoint(root, state.schedule[prior.phase], prior, readArtifact) : null;
    if (previous) need(digest(previous.summary) === prior.textSha256);
    const history = previous?.summary.replace(/(?:\n\n<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>)+$/u, "") ?? "No prior history.";
    candidates.push(history + split + texts[0]);
  }
  need(candidates.some(text => text + suffix === checkpoint.summary));
  return { version: 1, scope, ...(planned.kind === "replay" ? { branch: scope } : {}), phase: planned.index, journalId: reference.journalId, checkpointId: reference.checkpointId,
    textSha256: digest(checkpoint.summary), generated: summaries.map(h => ({ round: h.round, sha256: h.summaryReceipt.sha256 })) };
}
// Only recognized shipping representations qualify: a complete native summary
// message, or a complete JSON-quoted generated-summary record in a continuity pack.
export function e2BodySummaryDigests(body) {
  const found = [];
  for (const item of body.input ?? []) {
    if (item?.role !== "user") continue;
    const parts = typeof item.content === "string" ? [item.content] : (item.content ?? []).filter(p => p.type === "input_text").map(p => p.text);
    for (const text of parts) {
      if (typeof text !== "string" || !text.isWellFormed()) continue;
      if (text.startsWith(E2_SUMMARY_PREFIX) && text.endsWith(E2_SUMMARY_SUFFIX)) found.push(digest(text.slice(E2_SUMMARY_PREFIX.length, -E2_SUMMARY_SUFFIX.length)));
      if (text.startsWith("### Conversation continuity pack (historical evidence)\n")) for (const line of text.split("\n")) {
        const match = /^Generated summary evidence id="chr1_[A-Za-z0-9_-]{43}" sha256="[a-f0-9]{64}": (".*")$/u.exec(line);
        if (match) { let value; try { value = JSON.parse(match[1]); } catch { continue; } if (typeof value === "string" && value.isWellFormed()) found.push(digest(value)); }
      }
    }
  }
  return found;
}
export async function verifyE2NativeLineage(bytes, hold, state, assignment, readArtifact) {
  need(canonicalDigest(hold.lineage ?? null) === canonicalDigest(state.slots[assignment.index].lineages?.[hold.lineageScope] ?? null));
  if (!hold.lineage) return; // A baseline before the first generated summary has no summary authority.
  const reference = hold.lineage;
  need(reference.version === 1 && Number.isSafeInteger(reference.phase) && reference.phase >= 0 && reference.phase <= assignment.index);
  const checkpoint = await readE2Checkpoint(assignment.outputRoot, state.schedule[reference.phase], reference, readArtifact);
  need(digest(checkpoint.summary) === reference.textSha256 && e2BodySummaryDigests(JSON.parse(bytes)).includes(reference.textSha256));
}
