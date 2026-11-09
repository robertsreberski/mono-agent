// Shared guarded-run mechanics; policy is selected only by a closed protocol id.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedLease } from "./continuity-guarded-lease.mjs";
const instances = new Map();
export function guardedState(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, id) {
  const { need,  } = guardedAccounting(id);
  const { isLeaseFile, markLeaseCompromised } = guardedLease(id);
  const sameRun = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
  const runHash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
  const runId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  function requireFaux(authorization) {
    need(authorization?.schema !== protocol.policy.AUTHORIZATION_SCHEMA, protocol.codes.pilot_real_route_unavailable);
    need(authorization?.schema === protocol.policy.FAUX_AUTHORIZATION, protocol.codes.pilot_faux_required);
    need(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), protocol.codes.debug_forbidden);
    // The incompatible faux identity is non-paid and is explicitly allowed under CI.
  }
  async function privateParents(path) {
    need(isAbsolute(path) && resolve(path) === path, protocol.codes.receipt_invalid);
    const parents = [];
    for (let current = dirname(path); ; current = dirname(current)) {
      const s = await lstat(current);
      need(s.isDirectory() && [0, userInfo().uid].includes(s.uid)
        && ((s.mode & 0o022) === 0 || s.uid === 0 && (s.mode & 0o1000) !== 0), protocol.codes.receipt_invalid);
      parents.push([s.dev, s.ino]); if (dirname(current) === current) break;
    }
    need(await realpath(dirname(path)) === dirname(path), protocol.codes.receipt_invalid); return parents;
  }
  async function readPrivate(path) {
    const parents = await privateParents(path);
    const before = await lstat(path);
    const safe = s => s.isFile() && s.uid === userInfo().uid && s.nlink === 1 && (s.mode & 0o077) === 0 && s.size <= 16 * 1024 * 1024;
    need(safe(before) && !isLeaseFile(path, before), protocol.codes.receipt_invalid);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      need(!markLeaseCompromised(stat) && safe(stat) && stat.dev === before.dev && stat.ino === before.ino, protocol.codes.receipt_invalid);
      const checkPath = async () => {
        need(sameRun(parents, await privateParents(path)), protocol.codes.receipt_invalid);
        const current = await lstat(path);
        // Trusted writers replace atomically; any in-place change around the read refuses.
        need(safe(current) && current.dev === stat.dev && current.ino === stat.ino && current.size === stat.size
          && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs, protocol.codes.receipt_invalid);
      };
      await checkPath(); const bytes = await file.readFile(); const after = await file.stat();
      need(bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, protocol.codes.receipt_invalid);
      await checkPath(); return JSON.parse(bytes.toString("utf8"));
    } finally { await file.close(); }
  }
  const statePath = root => join(root, protocol.journal);
  return Object.freeze({ sameRun, runHash, runId, requireFaux, readPrivate, statePath });
}
