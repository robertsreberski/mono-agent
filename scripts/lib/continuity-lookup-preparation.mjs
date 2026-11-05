// Read-only preparation proof and verified-byte restoration. No dispatch authority.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { digest } from "./continuity-dataset.mjs";
import { armById } from "./continuity-arms.mjs";
import { lookupPilotWork } from "./continuity-lookup-pilot-runtime.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { readPilotPrivate, pilotStatePath, samePilot } from "./continuity-lookup-pilot-state.mjs";
import { isLookupLeaseFile, markLookupLeaseCompromised } from "./continuity-lookup-lease.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
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
      need(before.isFile() && before.nlink === 1 && before.size <= 64 * 1024 * 1024 && !isLookupLeaseFile(path, before));
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat(); need(!markLookupLeaseCompromised(stat) && stat.dev === before.dev && stat.ino === before.ino);
        const bytes = await file.readFile(), after = await file.stat(); total += bytes.length;
        need(total <= 512 * 1024 * 1024 && bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
        rows.push({ path: relative, directory: false, mode: stat.mode & 0o777, sha256: digest(bytes.toString("base64")), bytes });
      } finally { await file.close(); }
    }
    const after = await lstat(path);
    need(after.dev === before.dev && after.ino === before.ino && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && await realpath(path) === path);
  };
  await walk(root); return rows;
}
async function contents(a) {
  const p = paths(a), manifest = await readPilotPrivate(p.manifest), rows = await tree(p.snapshot);
  need(manifest.schema === "lookup-preparation-v1" && manifest.slotId === a.slotId && manifest.traceId === a.slot.traceId
    && typeof manifest.conversationId === "string" && manifest.conversationId.length > 0 && manifest.conversationId.length <= 512);
  return { manifest, rows, treeDigest: digest({ manifest, tree: rows.map(({ bytes: _bytes, ...row }) => row) }) };
}
export async function writeLookupPreparation(a, checkpoint) {
  const p = paths(a); need(checkpoint.work === p.work && checkpoint.snapshot === p.snapshot);
  await durable(p.manifest, { schema: "lookup-preparation-v1", slotId: a.slotId, traceId: a.slot.traceId,
    conversationId: checkpoint.record.conversationId, continuity: checkpoint.record.continuity ?? null }, true);
  return (await contents(a)).treeDigest;
}
export async function lookupPreparationDigest(a) { return (await contents(a)).treeDigest; }
/** The controller's observed exit and a fresh tuple check are both required. */
export async function verifyLookupPreparation(a, state, restored = false) {
  assertLookupPilotArm(armById(a.roleRequest.binding.arm));
  const record = state.slots[a.index]?.preparation;
  need(record?.exited === true && Number.isSafeInteger(record.pid) && record.pid > 1 && record.pid !== process.pid
    && typeof record.startIdentity === "string" && record.startIdentity.length > 0
    && typeof record.treeDigest === "string" && /^[a-f0-9]{64}$/u.test(record.treeDigest)
    && lookupProcessStartIdentity(record.pid) !== record.startIdentity);
  const saved = verified.get(key(a));
  if (saved) need(samePilot(saved.record, record));
  else {
    need((await contents(a)).treeDigest === record.treeDigest);
    verified.set(key(a), { record: freeze(structuredClone(record)), restored: false });
  }
  need(!restored || verified.get(key(a)).restored);
  return verified.get(key(a)).record;
}
/** Copy from the exact verified buffers; no re-opening the mutable source after hashing. */
export async function restoreLookupPreparation(a) {
  const state = await readPilotPrivate(pilotStatePath(a.outputRoot));
  need(state.slots[a.index]?.worker?.pid === process.pid && state.slots[a.index].worker.startIdentity === lookupProcessStartIdentity(process.pid));
  await verifyLookupPreparation(a, state);
  const saved = verified.get(key(a)); need(!saved.restored);
  const source = await contents(a); need(source.treeDigest === saved.record.treeDigest);
  const p = paths(a); await rm(p.work, { recursive: true, force: true });
  for (const row of source.rows) {
    const path = row.path ? join(p.work, row.path) : p.work;
    if (row.directory) await mkdir(path, { mode: row.mode });
    else await writeFile(path, row.bytes, { mode: row.mode, flag: "wx" });
  }
  // A changed durable record cannot be installed as an in-process boundary proof.
  await verifyLookupPreparation(a, await readPilotPrivate(pilotStatePath(a.outputRoot)));
  saved.restored = true;
  const proof = Object.freeze({}); proofs.set(proof, { work: p.work, arm: a.roleRequest.binding.arm, conversationId: source.manifest.conversationId });
  return { proof, work: p.work, manifest: freeze(source.manifest) };
}
export function lookupPreparedBoundary(pilot, arm, work, conversationId) {
  const proof = proofs.get(pilot?.preparation);
  const valid = lookupPilotServesArm(arm) && proof?.arm === arm.id && proof.work === work && proof.conversationId === conversationId;
  if (valid) proofs.delete(pilot.preparation);
  return valid;
}
