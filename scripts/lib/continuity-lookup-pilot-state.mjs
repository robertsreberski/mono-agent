import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { isLookupLeaseFile, markLookupLeaseCompromised } from "./continuity-lookup-lease.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";

export const LOOKUP_FAUX_AUTHORIZATION = "continuity-lookup-faux-authorization-v1";
export const LOOKUP_FAUX_CONTROLLER = "continuity-lookup-faux-controller-v1";
export const LOOKUP_PILOT_IPC = "lookup-faux-ipc-v1";
export const samePilot = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
export const pilotHash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
export const pilotId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
export function requireFauxPilot(authorization) {
  pilotNeed(authorization?.schema !== "continuity-lookup-pilot-authorization-v1", "lookup_pilot_real_route_unavailable");
  pilotNeed(authorization?.schema === LOOKUP_FAUX_AUTHORIZATION, "lookup_pilot_faux_required");
  pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  // The incompatible faux identity is non-paid and is explicitly allowed under CI.
}
export async function readPilotPrivate(path) {
  const before = await lstat(path);
  const safe = s => s.isFile() && s.uid === userInfo().uid && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= 16 * 1024 * 1024;
  pilotNeed(safe(before) && !isLookupLeaseFile(path, before), "lookup_receipt_invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    pilotNeed(!markLookupLeaseCompromised(stat) && safe(stat) && stat.dev === before.dev && stat.ino === before.ino, "lookup_receipt_invalid");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
export const pilotStatePath = root => join(root, "lookup-pilot-controller.json");

export function lookupPilotSchedule(pilot) {
  const { common, roles } = pilot.registration, seed = pilot.descriptor.schedule.seed;
  const rank = value => digest([seed, value]);
  const pairs = common.corpora.flatMap(c => c.traces.flatMap(t => t.probes.map(probeId => ({ suite: c.suite, traceId: t.id, probeId }))));
  pairs.sort((a, b) => rank(a).localeCompare(rank(b)));
  return pairs.flatMap(pair => [...roles].sort((a, b) => rank([pair, a.id]).localeCompare(rank([pair, b.id]))).map(role => {
    const path = common.policy.budget.paths.find(p => p.role === role.id && p.traceId === pair.traceId && p.probeId === pair.probeId);
    pilotNeed(path, "lookup_receipt_invalid");
    return { ...pair, roleId: role.id, code: role.code, slotId: rank([pair, role.id]), eligible: path.feasibility.classification === "feasible" };
  }));
}
