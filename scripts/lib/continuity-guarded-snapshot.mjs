// Shared guarded-run mechanics. Historical authority identifiers remain visible to the exact source inventory.
import { constants } from "node:fs";
import { lstat, open, readdir, opendir, realpath, mkdir, unlink, rmdir, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { digest } from "./continuity-dataset.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedLease } from "./continuity-guarded-lease.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
export const GUARDED_STATS_LIMITS = Object.freeze({ entries: 65536, depth: 64 });
const instances = new Map();
export function guardedSnapshot(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const LOOKUP_PREFLIGHT = protocol.policy.PREFLIGHT, LOOKUP_TREE_LIMITS = protocol.policy.TREE_LIMITS, LOOKUP_REAL_CONTROLLER = protocol.policy.REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER = protocol.policy.FAUX_CONTROLLER;
  const { readPrivate: readPilotPrivate, statePath: pilotStatePath, sameRun: samePilot } = guardedState(protocolId);
  const { isLeaseFile: isLookupLeaseFile, markLeaseCompromised: markLookupLeaseCompromised } = guardedLease(protocolId);
  const { work: lookupPilotWork, assertArm: assertLookupPilotArm, servesArm: lookupPilotServesArm } = protocol.hooks;
  const verified = new Map(), proofs = new WeakMap();
  const need = ok => { if (!ok) throw Object.assign(new Error(protocol.codes.preparation_invalid), { code: protocol.codes.preparation_invalid }); };
  const paths = a => ({ work: lookupPilotWork(a), snapshot: join(dirname(lookupPilotWork(a)), "snapshot"), manifest: join(dirname(lookupPilotWork(a)), "preparation.json") });
  const key = a => digest([a.outputRoot, a.epoch, a.slotId, a.index, process.pid]);
  const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  async function tree(root) {
    need(await realpath(root) === root);
    const rows = []; let total = 0;
    const walk = async (path, relative = "") => {
      const before = await lstat(path); need(before.uid === userInfo().uid && (before.mode & 0o022) === 0);
      if (before.isDirectory()) {
        rows.push({ path: relative, directory: true, mode: before.mode & 0o777 });
        for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name);
      } else {
        need(before.isFile() && before.nlink === 1 && before.size <= LOOKUP_TREE_LIMITS.fileBytes && !isLookupLeaseFile(path, before));
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat(); need(!markLookupLeaseCompromised(stat) && stat.dev === before.dev && stat.ino === before.ino);
          const bytes = await file.readFile(), after = await file.stat(); total += bytes.length;
          need(total <= LOOKUP_TREE_LIMITS.totalBytes && bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
          rows.push({ path: relative, directory: false, mode: stat.mode & 0o777, sha256: digest(bytes.toString("base64")), bytes });
        } finally { await file.close(); }
      }
      const after = await lstat(path);
      need(after.dev === before.dev && after.ino === before.ino && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && await realpath(path) === path);
    };
    await walk(root); return rows;
  }
  async function contents(a, schema = protocol.schemas.preparation) {
    const p = paths(a), manifest = await readPilotPrivate(p.manifest), rows = await tree(p.snapshot);
    need(manifest.schema === schema && manifest.slotId === a.slotId && protocol.hooks.snapshotMatches(manifest, a)
      && typeof manifest.conversationId === "string" && manifest.conversationId.length > 0 && manifest.conversationId.length <= 512);
    return { manifest, rows, treeDigest: digest({ manifest, tree: rows.map(({ bytes: _bytes, ...row }) => row) }) };
  }
  async function writeLookupPreparation(a, checkpoint) { return writeSnapshot(a, checkpoint, protocol.schemas.preparation); }
  async function writeLookupPreflight(a, checkpoint) { return writeSnapshot(a, checkpoint, protocol.schemas.preflightSnapshot); }
  async function writeSnapshot(a, checkpoint, schema) {
    const p = paths(a); need(checkpoint.work === p.work && checkpoint.snapshot === p.snapshot);
    await durable(p.manifest, { schema, slotId: a.slotId, ...protocol.hooks.snapshotSource(a),
      conversationId: checkpoint.record.conversationId, continuity: checkpoint.record.continuity ?? null }, true);
    return (await contents(a, schema)).treeDigest;
  }
  async function lookupPreflightDigest(a) { return (await contents(a, protocol.schemas.preflightSnapshot)).treeDigest; }
  async function lookupPreparationDigest(a) { return (await contents(a)).treeDigest; }
  async function verifyLookupPreparation(a, state, restored = false) {
    try { return await verifyPreparation(a, state, restored); } catch { need(false); }
  }
  async function verifyPreparation(a, state, restored) {
    need([LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER].includes(state.schema));
    assertLookupPilotArm(protocol.hooks.armForAssignment(a));
    const record = state.slots[a.index]?.preparation;
    exitedRecord(record, protocol.schemas.preparationRecord);
    const saved = verified.get(key(a));
    if (saved) need(samePilot(saved.record, record));
    else {
      await verifySource(a, record, protocol.schemas.preparation, protocol.schemas.preparationRecord);
      verified.set(key(a), { record: freeze(structuredClone(record)), restored: false });
    }
    need(!restored || verified.get(key(a)).restored);
    return verified.get(key(a)).record;
  }
  function exitedRecord(record, schema) {
    need(record?.schema === schema && record.exited === true && Number.isSafeInteger(record.pid) && record.pid > 1 && record.pid !== process.pid
      && typeof record.startIdentity === "string" && record.startIdentity.length > 0
      && typeof record.treeDigest === "string" && /^[a-f0-9]{64}$/u.test(record.treeDigest)
      && lookupProcessStartIdentity(record.pid) !== record.startIdentity);
  }
  async function restoreLookupPreparation(a) {
    try { return await restorePreparation(a); } catch { need(false); }
  }
  async function restorePreparation(a) {
    const state = await readPilotPrivate(pilotStatePath(a.outputRoot));
    need(state.slots[a.index]?.worker?.pid === process.pid && state.slots[a.index].worker.startIdentity === lookupProcessStartIdentity(process.pid));
    need([LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER].includes(state.schema));
    assertLookupPilotArm(protocol.hooks.armForAssignment(a));
    await verifyPreparation(a, state, false);
    const source = await restoreSource(a, state.slots[a.index].preparation, protocol.schemas.preparation, protocol.schemas.preparationRecord);
    const saved = verified.get(key(a)); need(!saved.restored);
    const p = paths(a); await installTree(p.work, source.rows);
    // A changed durable record cannot be installed as an in-process boundary proof.
    await verifyLookupPreparation(a, await readPilotPrivate(pilotStatePath(a.outputRoot)));
    saved.restored = true;
    const proof = Object.freeze({}); proofs.set(proof, { work: p.work, arm: protocol.hooks.assignmentArm(a), conversationId: source.manifest.conversationId });
    return { proof, work: p.work, manifest: freeze(source.manifest) };
  }
  async function restoreSource(a, record, schema, recordSchema) {
    exitedRecord(record, recordSchema);
    const source = await contents(a, schema); need(source.treeDigest === record.treeDigest); return source;
  }
  async function verifySource(a, record, schema, recordSchema) {
    // Drop this read's buffers before the restore read; dry and normal share this sequence.
    await restoreSource(a, record, schema, recordSchema);
  }
  async function removeLookupWorkTree(root) {
    const same = async ({path, stat}) => {
      const now = await lstat(path); need(now.dev === stat.dev && now.ino === stat.ino && now.mode === stat.mode);
    };
    const remove = async (path, ancestors = []) => {
      for (const ancestor of ancestors) await same(ancestor);
      let stat; try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      need(stat.uid === userInfo().uid);
      if (!stat.isDirectory()) {
        for (const ancestor of ancestors) await same(ancestor);
        await same({path, stat}); await unlink(path); return;
      }
      if (!(stat.mode & 0o400)) throw Object.assign(Error(protocol.codes.preparation_unreadable_directory), {code: protocol.codes.preparation_unreadable_directory});
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const bound = await handle.stat(); need(bound.dev === stat.dev && bound.ino === stat.ino && bound.isDirectory());
        let checked = [...ancestors, {path, stat}];
        for (const dir of checked) await same(dir);
        await handle.chmod((stat.mode & 0o777) | 0o700);
        stat = await handle.stat(); checked = [...ancestors, {path, stat}];
        for (const dir of checked) await same(dir);
        const names = await readdir(path);
        for (const dir of checked) await same(dir);
        for (const name of names) await remove(join(path, name), checked);
        for (const dir of checked) await same(dir);
        // Recheck immediately; rmdir cannot traverse a replacement or new child.
        await rmdir(path);
      } finally { await handle.close(); }
    };
    await remove(root);
  }
  async function installTree(work, rows) {
    await removeLookupWorkTree(work);
    for (const row of rows) {
      const path = row.path ? join(work, row.path) : work;
      if (row.directory) await mkdir(path, { mode: 0o700 });
      else await writeFile(path, row.bytes, { mode: row.mode, flag: "wx" });
    }
    for (const row of [...rows].reverse()) if (row.directory) await chmod(row.path ? join(work, row.path) : work, row.mode);
  }
  async function restoreLookupPreflight(a) {
    try {
      const state = await readPilotPrivate(pilotStatePath(a.outputRoot));
      need(state.schema === LOOKUP_PREFLIGHT && state.controller.pid === process.pid
        && state.controller.startIdentity === lookupProcessStartIdentity(process.pid)
        && state.schedule[a.index]?.slotId === a.slotId && samePilot(state.schedule[a.index], a.slot));
      await verifySource(a, state.slots[a.index]?.preparation, protocol.schemas.preflightSnapshot, protocol.schemas.preflightRecord);
      const source = await restoreSource(a, state.slots[a.index]?.preparation, protocol.schemas.preflightSnapshot, protocol.schemas.preflightRecord);
      await installTree(paths(a).work, source.rows);
    } catch { need(false); }
  }
  function lookupPreparedBoundary(pilot, arm, work, conversationId) {
    const proof = proofs.get(pilot?.preparation);
    const valid = lookupPilotServesArm(arm) && proof?.arm === arm.id && proof.work === work && proof.conversationId === conversationId;
    if (valid) proofs.delete(pilot.preparation);
    return valid;
  }
  async function lookupPreparationStats(root) {
    const stats = { fileCount: 0, totalBytes: 0, largestFileBytes: 0, rejectedEntries: [] }, rejected = new Map();
    const reject = kind => rejected.set(kind, (rejected.get(kind) ?? 0) + 1);
    let entries = 0, exhausted = false;
    const walk = async (path, depth = 0) => {
      if (exhausted) return;
      if (++entries > GUARDED_STATS_LIMITS.entries) { exhausted = true; reject("entry_limit"); return; }
      if (depth > GUARDED_STATS_LIMITS.depth) { reject("depth_limit"); return; }
      try {
        const stat = await lstat(path);
        if (stat.uid !== userInfo().uid) { reject("foreign_owner"); return; }
        if (stat.mode & 0o022) reject("writable_mode");
        if (stat.isSymbolicLink()) { reject("symbolic_link"); return; }
        if (stat.isDirectory()) {
          // Streaming bounds wide directories too; breaking closes the directory handle.
          for await (const entry of await opendir(path)) { await walk(join(path, entry.name), depth + 1); if (exhausted) break; }
          return;
        }
        if (!stat.isFile()) { reject(stat.isFIFO() ? "fifo" : stat.isSocket() ? "socket" : stat.isBlockDevice() || stat.isCharacterDevice() ? "device" : "non_regular"); return; }
        stats.fileCount++; stats.totalBytes += stat.size; stats.largestFileBytes = Math.max(stats.largestFileBytes, stat.size);
        if (stat.nlink !== 1) reject("hard_link");
        if (isLookupLeaseFile(path, stat)) reject("lease_inode");
        if (stat.size > LOOKUP_TREE_LIMITS.fileBytes) reject("file_limit");
      } catch { reject("unreadable_entry"); }
    };
    await walk(root);
    if (stats.totalBytes > LOOKUP_TREE_LIMITS.totalBytes) reject("total_limit");
    stats.rejectedEntries = [...rejected].sort().map(([kind, count]) => ({ kind, count }));
    return stats;
  }
  async function lookupRetainedBytes(slotRoot) {
    const sizes = {snapshotBytes: 0, workBytes: 0, homeBytes: 0, otherBytes: 0};
    const walk = async (path, relative = "") => {
      const stat = await lstat(path);
      const bytes = Math.max(stat.size, stat.blocks * 512);
      need(Number.isSafeInteger(bytes) && bytes >= 0);
      const field = relative === "checkpoint/snapshot" || relative.startsWith("checkpoint/snapshot/") ? "snapshotBytes"
        : relative === "checkpoint/work" || relative.startsWith("checkpoint/work/") ? "workBytes"
        : relative === "checkpoint/lease-home" || relative.startsWith("checkpoint/lease-home/") || relative && !relative.startsWith("checkpoint") ? "homeBytes" : "otherBytes";
      sizes[field] += bytes;
      if (stat.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name), relative ? `${relative}/${name}` : name);
    };
    await walk(slotRoot); const retainedBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
    need(Number.isSafeInteger(retainedBytes)); return {...sizes, retainedBytes};
  }
  return Object.freeze({ writeLookupPreparation, writeLookupPreflight, lookupPreflightDigest, lookupPreparationDigest, verifyLookupPreparation, restoreLookupPreparation, removeLookupWorkTree, restoreLookupPreflight, lookupPreparedBoundary, lookupPreparationStats, lookupRetainedBytes });
}
