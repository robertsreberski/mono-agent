// Accounted, non-committing product refusals. Never summary-lineage authority.
import { digest } from "./continuity-recorded-schema.mjs";
import { e2ActiveBranch, e2JournalScope, readE2Journal } from "./continuity-e2-journals.mjs";
import { e2LineageScope, e2PhaseWork } from "./continuity-e2-lineage.mjs";
// Completed-candidate protection refusals only. Product output_truncated is
// unreachable here: the paid SDK length-failure path stops before a verified
// generated receipt exists. Do not turn that failure into a continuation.
export const E2_PROTECTION_REFUSALS = Object.freeze(["protected_tuples_missing", "summary_budget_exceeded"]);
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
    const rounds = new Set((slot.compactionRefusals ?? []).flatMap(r => r.rounds));
    for (const h of slot.holds.filter(h => rounds.has(h.round))) {
      result.rejectedRequests++;
      const known = BigInt(h.settlement.knownUnits), reserve = BigInt(h.reservedUnits);
      // Match financial accounting: a superseded lost attempt retains its full
      // reservation (or higher known cost), even though its retry was rejected.
      units += h.settlement.kind === "settled" ? known : reserve > known ? reserve : known;
    }
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
  let directory;
  try { directory = await e2JournalScope(work); }
  catch (error) { if (!previous && error.code === "ENOENT") return []; throw error; }
  const names = directory.names;
  // An initial success may create its first journal after begin. A refusal,
  // however, needs a nonempty baseline and must not introduce a new journal.
  need(names.length <= 8192 && (!previous || previous.length > 0 && names.join() === previous.map(p => p.name).join()));
  const snapshots = [], budget = { bytes: 0 };
  for (const [i, name] of names.entries()) {
    const { validator, records, lines } = await readE2Journal(work, name.slice(0, -6), readArtifact, budget);
    const context = records.filter(r => ["message", "compaction", "rewind", "retained_summary_admitted", "reseed_predecessor_admitted"].includes(r.kind));
    const admission = validator.retainedSummaryAdmission, branch = admission ? e2ActiveBranch(validator) : [];
    const retainedAdmission = Boolean(admission && branch.some(r => r.id === admission.payload.seed.entryId) && !branch.some(r => r.kind === "compaction"));
    const snapshot = { name, retainedAdmission, lines: lines.length, prefixSha256: digest(lines.join("\n") + "\n"), contextSha256: digest(JSON.stringify(context)), tip: validator.tip };
    if (previous) {
      const prior = previous[i];
      need(lines.length >= prior.lines && digest(lines.slice(0, prior.lines).join("\n") + "\n") === prior.prefixSha256
        && snapshot.contextSha256 === prior.contextSha256 && snapshot.tip === prior.tip);
    }
    snapshots.push(snapshot);
  }
  await directory.assertStable(); return snapshots;
}
