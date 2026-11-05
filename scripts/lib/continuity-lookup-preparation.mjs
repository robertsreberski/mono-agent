// Read-only preparation proof and verified-byte restoration. No dispatch authority.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { digest } from "./continuity-dataset.mjs";
import { armById } from "./continuity-arms.mjs";
import { lookupPilotWork } from "./continuity-lookup-pilot-runtime.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { readPilotPrivate, pilotStatePath, samePilot, LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER } from "./continuity-lookup-pilot-state.mjs";
import { isLookupLeaseFile, markLookupLeaseCompromised } from "./continuity-lookup-lease.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
export const LOOKUP_PREFLIGHT = "lookup-preflight-controller-v1";
export const LOOKUP_TREE_LIMITS = Object.freeze({ fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 });
const verified = new Map(), proofs = new WeakMap();
const need = ok => { if (!ok) throw Object.assign(new Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" }); };
export function lookupPilotServesArm(arm) {
  return ["native-lookup", "continuity-pack-cold", "continuity-pack-boundary"].includes(arm?.id)
    && arm.fork === "in-place" && !arm.restart && arm.midCheckpoint === null && !arm.ledgerUpkeep;
}
export function assertLookupPilotArm(arm) {
  if (!lookupPilotServesArm(arm)) throw Object.assign(new Error("lookup_pilot_boundary_required"), { code: "lookup_pilot_boundary_required" });
}
const paths = a => ({ work: lookupPilotWork(a), snapshot: join(dirname(lookupPilotWork(a)), "snapshot"), manifest: join(dirname(lookupPilotWork(a)), "preparation.json") });
const key = a => digest([a.outputRoot, a.epoch, a.slotId, a.index, process.pid]);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
/** Read each regular file through its own no-follow descriptor; restore these bytes, not a later path lookup. */
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
async function contents(a, schema = "lookup-preparation-v1") {
  const p = paths(a), manifest = await readPilotPrivate(p.manifest), rows = await tree(p.snapshot);
  need(manifest.schema === schema && manifest.slotId === a.slotId && manifest.traceId === a.slot.traceId
    && typeof manifest.conversationId === "string" && manifest.conversationId.length > 0 && manifest.conversationId.length <= 512);
  return { manifest, rows, treeDigest: digest({ manifest, tree: rows.map(({ bytes: _bytes, ...row }) => row) }) };
}
export async function writeLookupPreparation(a, checkpoint) { return writeSnapshot(a, checkpoint, "lookup-preparation-v1"); }
export async function writeLookupPreflight(a, checkpoint) { return writeSnapshot(a, checkpoint, "lookup-preflight-snapshot-v1"); }
async function writeSnapshot(a, checkpoint, schema) {
  const p = paths(a); need(checkpoint.work === p.work && checkpoint.snapshot === p.snapshot);
  await durable(p.manifest, { schema, slotId: a.slotId, traceId: a.slot.traceId,
    conversationId: checkpoint.record.conversationId, continuity: checkpoint.record.continuity ?? null }, true);
  return (await contents(a, schema)).treeDigest;
}
export async function lookupPreflightDigest(a) { return (await contents(a, "lookup-preflight-snapshot-v1")).treeDigest; }
export async function lookupPreparationDigest(a) { return (await contents(a)).treeDigest; }
/** The controller's observed exit and a fresh tuple check are both required. */
export async function verifyLookupPreparation(a, state, restored = false) {
  try { return await verifyPreparation(a, state, restored); } catch { need(false); }
}
async function verifyPreparation(a, state, restored, source) {
  need([LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER].includes(state.schema));
  assertLookupPilotArm(armById(a.roleRequest.binding.arm));
  const record = state.slots[a.index]?.preparation;
  exitedRecord(record, "lookup-preparation-record-v1");
  const saved = verified.get(key(a));
  if (saved) need(samePilot(saved.record, record));
  else {
    need((source ?? await contents(a)).treeDigest === record.treeDigest);
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
/** Copy from the exact verified buffers; no re-opening the mutable source after hashing. */
export async function restoreLookupPreparation(a) {
  try { return await restorePreparation(a); } catch { need(false); }
}
async function restorePreparation(a) {
  const state = await readPilotPrivate(pilotStatePath(a.outputRoot));
  need(state.slots[a.index]?.worker?.pid === process.pid && state.slots[a.index].worker.startIdentity === lookupProcessStartIdentity(process.pid));
  need([LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER].includes(state.schema));
  assertLookupPilotArm(armById(a.roleRequest.binding.arm));
  const source = await restoreSource(a, state.slots[a.index].preparation, "lookup-preparation-v1", "lookup-preparation-record-v1");
  await verifyPreparation(a, state, false, source);
  const saved = verified.get(key(a)); need(!saved.restored);
  const p = paths(a); await installTree(p.work, source.rows);
  // A changed durable record cannot be installed as an in-process boundary proof.
  await verifyLookupPreparation(a, await readPilotPrivate(pilotStatePath(a.outputRoot)));
  saved.restored = true;
  const proof = Object.freeze({}); proofs.set(proof, { work: p.work, arm: a.roleRequest.binding.arm, conversationId: source.manifest.conversationId });
  return { proof, work: p.work, manifest: freeze(source.manifest) };
}
async function restoreSource(a, record, schema, recordSchema) {
  exitedRecord(record, recordSchema);
  const first = await contents(a, schema); need(first.treeDigest === record.treeDigest);
  const second = await contents(a, schema); need(second.treeDigest === first.treeDigest);
  return second;
}
/** Descriptor-bound chmod; compare path identities around enumeration and descent. */
export async function removeLookupWorkTree(root) {
  const same = async ({path, stat}) => { const now = await lstat(path); need(now.isDirectory() && now.dev === stat.dev && now.ino === stat.ino); };
  const writable = async (path, ancestors = []) => {
    for (const ancestor of ancestors) await same(ancestor);
    let stat; try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory()) return;
    need(stat.uid === userInfo().uid);
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const bound = await handle.stat(); need(bound.dev === stat.dev && bound.ino === stat.ino && bound.isDirectory());
      const checked = [...ancestors, {path, stat}];
      for (const dir of checked) await same(dir);
      await handle.chmod((stat.mode & 0o777) | 0o700);
      for (const dir of checked) await same(dir);
      const names = await readdir(path);
      for (const dir of checked) await same(dir);
      for (const name of names) await writable(join(path, name), checked);
    } finally { await handle.close(); }
  };
  await writable(root); await rm(root, { recursive: true, force: true });
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
/** Same byte installation as the probe, but never produces a boundary proof. */
export async function restoreLookupPreflight(a) {
  try {
    const state = await readPilotPrivate(pilotStatePath(a.outputRoot));
    need(state.schema === LOOKUP_PREFLIGHT && state.controller.pid === process.pid
      && state.controller.startIdentity === lookupProcessStartIdentity(process.pid)
      && state.schedule[a.index]?.slotId === a.slotId && samePilot(state.schedule[a.index], a.slot));
    const source = await restoreSource(a, state.slots[a.index]?.preparation, "lookup-preflight-snapshot-v1", "lookup-preflight-record-v1");
    await installTree(paths(a).work, source.rows);
  } catch { need(false); }
}
export function lookupPreparedBoundary(pilot, arm, work, conversationId) {
  const proof = proofs.get(pilot?.preparation);
  const valid = lookupPilotServesArm(arm) && proof?.arm === arm.id && proof.work === work && proof.conversationId === conversationId;
  if (valid) proofs.delete(pilot.preparation);
  return valid;
}

/** Metadata only: never follow rejected links or open oversized/non-regular files. */
export async function lookupPreparationStats(root) {
  const stats = { fileCount: 0, totalBytes: 0, largestFileBytes: 0, rejectedEntries: [] }, rejected = new Map();
  const reject = kind => rejected.set(kind, (rejected.get(kind) ?? 0) + 1);
  const walk = async path => {
    try {
      const stat = await lstat(path);
      if (stat.uid !== userInfo().uid) { reject("foreign_owner"); return; }
      if (stat.mode & 0o022) reject("writable_mode");
      if (stat.isSymbolicLink()) { reject("symbolic_link"); return; }
      if (stat.isDirectory()) { for (const name of await readdir(path)) await walk(join(path, name)); return; }
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

/** Logical-or-allocated bytes, conservatively counting links independently. */
export async function lookupRetainedBytes(slotRoot) {
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
