import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { isLookupLeaseFile, markLookupLeaseCompromised } from "./continuity-lookup-lease.mjs";
import { LOOKUP_AUTHORIZATION_SCHEMA } from "./continuity-lookup-authorization.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";

export const LOOKUP_FAUX_AUTHORIZATION = "continuity-lookup-faux-authorization-v1";
export const LOOKUP_REAL_CONTROLLER = "continuity-lookup-controller-v1";
export const LOOKUP_FAUX_CONTROLLER = "continuity-lookup-faux-controller-v1";
export const LOOKUP_PILOT_IPC = "lookup-faux-ipc-v1";
export const samePilot = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
export const pilotHash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
export const pilotId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
export function requireFauxPilot(authorization) {
  pilotNeed(authorization?.schema !== LOOKUP_AUTHORIZATION_SCHEMA, "lookup_pilot_real_route_unavailable");
  pilotNeed(authorization?.schema === LOOKUP_FAUX_AUTHORIZATION, "lookup_pilot_faux_required");
  pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  // The incompatible faux identity is non-paid and is explicitly allowed under CI.
}
async function privateParents(path) {
  pilotNeed(isAbsolute(path) && resolve(path) === path, "lookup_receipt_invalid");
  const parents = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    const s = await lstat(current);
    pilotNeed(s.isDirectory() && [0, userInfo().uid].includes(s.uid)
      && ((s.mode & 0o022) === 0 || s.uid === 0 && (s.mode & 0o1000) !== 0), "lookup_receipt_invalid");
    parents.push([s.dev, s.ino]); if (dirname(current) === current) break;
  }
  pilotNeed(await realpath(dirname(path)) === dirname(path), "lookup_receipt_invalid"); return parents;
}
export async function readPilotPrivate(path) {
  const parents = await privateParents(path);
  const before = await lstat(path);
  const safe = s => s.isFile() && s.uid === userInfo().uid && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= 16 * 1024 * 1024;
  pilotNeed(safe(before) && !isLookupLeaseFile(path, before), "lookup_receipt_invalid");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    pilotNeed(!markLookupLeaseCompromised(stat) && safe(stat) && stat.dev === before.dev && stat.ino === before.ino, "lookup_receipt_invalid");
    const checkPath = async () => {
      pilotNeed(samePilot(parents, await privateParents(path)), "lookup_receipt_invalid");
      const current = await lstat(path);
      // Trusted writers replace atomically; any in-place change around the read refuses.
      pilotNeed(safe(current) && current.dev === stat.dev && current.ino === stat.ino && current.size === stat.size
        && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs, "lookup_receipt_invalid");
    };
    await checkPath(); const bytes = await file.readFile(); const after = await file.stat();
    pilotNeed(bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, "lookup_receipt_invalid");
    await checkPath(); return JSON.parse(bytes.toString("utf8"));
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
