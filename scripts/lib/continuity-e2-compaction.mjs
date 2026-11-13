// Accounted, non-committing product refusals. Never summary-lineage authority.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./continuity-recorded-schema.mjs";
import { e2LineageScope, e2PhaseWork } from "./continuity-e2-lineage.mjs";
// compactWithRequest's summary_refused reasons; provider/SDK failures are not refusals.
export const E2_PROTECTION_REFUSALS = Object.freeze(["protected_tuples_missing", "summary_budget_exceeded", "output_truncated"]);
export const isE2ProtectionRefusal = event => event?.status === "skipped" && E2_PROTECTION_REFUSALS.includes(event.reason);
export function rejectedE2Summary(h) {
  const r = h.summaryReceipt;
  return h.paidRole === "summary" && h.consumed && h.settlement?.kind === "settled" && r?.verified === true && r.durable === false
    && r.rejected === true && E2_PROTECTION_REFUSALS.includes(r.reason);
}
export function e2RefusalCounts(slots) {
  const result = { count: 0, byReason: {}, rejectedRequests: 0, rejectedUnits: "0" };
  let units = 0n;
  for (const slot of slots) {
    for (const refusal of slot.compactionRefusals ?? []) {
      result.count++; result.byReason[refusal.reason] = (result.byReason[refusal.reason] ?? 0) + 1;
    }
    for (const h of slot.holds.filter(rejectedE2Summary)) { result.rejectedRequests++; units += BigInt(h.settlement.knownUnits); }
  }
  result.rejectedUnits = units.toString(); return result;
}
const need = ok => { if (!ok) throw Object.assign(Error("e2_compaction_invalid"), { code: "e2_compaction_invalid" }); };
/** Controller reads native journals itself, before admission and before disposition.
 * Operation/turn bookkeeping may advance; context tip, checkpoints and the entire
 * pre-request prefix must not. Even a compaction followed by rewind is rejected.
 */
export async function e2NativeCompactionSnapshot(root, state, planned, checkpoint, readArtifact, previous) {
  try { return await nativeSnapshot(root, state, planned, checkpoint, readArtifact, previous); }
  catch { need(false); }
}
async function nativeSnapshot(root, state, planned, checkpoint, readArtifact, previous) {
  const scope = await e2LineageScope(state, planned, checkpoint, readArtifact);
  const work = e2PhaseWork(root, planned, planned.kind === "replay" ? scope : undefined);
  let entries;
  try { entries = await readdir(join(work, "sessions", "journals")); }
  catch (error) { if (!previous && error.code === "ENOENT") return []; throw error; }
  const names = entries.filter(n => /^[A-Za-z0-9_-]+\.jsonl$/u.test(n)).sort();
  // An initial success may create its first journal after begin. A refusal,
  // however, needs a nonempty baseline and must not introduce a new journal.
  need(names.length <= 8192 && (!previous || previous.length > 0 && names.join() === previous.map(p => p.name).join()));
  const { JournalValidator, validateJournalHeader } = await import(new URL("../../packages/turn/dist/engine/journal-schema.js", import.meta.url).href);
  const snapshots = [];
  for (const [i, name] of names.entries()) {
    const bytes = await readArtifact(join(work, "sessions", "journals", name), "e2_compaction_invalid", 128 * 1024 * 1024);
    const lines = bytes.toString("utf8").split("\n"); need(lines.pop() === "" && lines.length > 1 && lines.length <= 1000000);
    const header = JSON.parse(lines[0]); validateJournalHeader(header); need(header.journalId === name.slice(0, -6) && header.cwd === work);
    const validator = new JournalValidator(), records = lines.slice(1).map(line => JSON.parse(line));
    for (const record of records) validator.apply(record);
    const context = records.filter(r => ["message", "compaction", "rewind", "retained_summary_admitted"].includes(r.kind));
    const snapshot = { name, lines: lines.length, prefixSha256: digest(lines.join("\n") + "\n"), contextSha256: digest(JSON.stringify(context)), tip: validator.tip };
    if (previous) {
      const prior = previous[i];
      need(lines.length >= prior.lines && digest(lines.slice(0, prior.lines).join("\n") + "\n") === prior.prefixSha256
        && snapshot.contextSha256 === prior.contextSha256 && snapshot.tip === prior.tip);
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}
