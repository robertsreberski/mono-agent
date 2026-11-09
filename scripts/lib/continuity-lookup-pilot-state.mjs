// Lookup API adapter. All guarded mechanics live in the protocol-neutral core.
import { guardedState } from "./continuity-guarded-state.mjs";
export { LOOKUP_FAUX_AUTHORIZATION, LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER, LOOKUP_PILOT_IPC } from "./continuity-lookup-guarded-policy.mjs";
import { LOOKUP_PILOT_MEASURED_ROLES } from "./continuity-lookup.mjs";
import { digest } from "./continuity-dataset.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";
export const samePilot = (a, b) => guardedState("lookup-pilot").sameRun(a, b);
export const pilotHash = (value) => guardedState("lookup-pilot").runHash(value);
export const pilotId = (value) => guardedState("lookup-pilot").runId(value);
export function requireFauxPilot(authorization) { return guardedState("lookup-pilot").requireFaux(authorization); }
export async function readPilotPrivate(path) { return guardedState("lookup-pilot").readPrivate(path); }
export const pilotStatePath = (root) => guardedState("lookup-pilot").statePath(root);
export function lookupPilotSchedule(pilot) {
  const { common, roles } = pilot.registration, seed = pilot.descriptor.schedule.seed;
  const rank = value => digest([seed, value]);
  const pairs = common.corpora.flatMap(c => c.traces.flatMap(t => t.probes.map(probeId => ({ suite: c.suite, traceId: t.id, probeId }))));
  pairs.sort((a, b) => rank(a).localeCompare(rank(b)));
  return pairs.flatMap(pair => [...roles].sort((a, b) => rank([pair, a.id]).localeCompare(rank([pair, b.id]))).map(role => {
    const path = common.policy.budget.paths.find(p => p.role === role.id && p.traceId === pair.traceId && p.probeId === pair.probeId);
    pilotNeed(path, "lookup_receipt_invalid");
    return { ...pair, roleId: role.id, code: role.code, slotId: rank([pair, role.id]), eligible: LOOKUP_PILOT_MEASURED_ROLES.includes(role.id) && path.feasibility.classification === "feasible" };
  }));
}
