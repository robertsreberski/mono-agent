// One-way idle MAIN branch import only. Never schedule or replay old operations.
import { constants } from "node:fs";
import { lstat, readdir, rename, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { JournalReader } from "./journal-reader.js";
import { buildHarnessSessionContext } from "./session-context.js";

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const fail = () => { throw new Error("Invalid legacy Pi session"); };
export async function listLegacySessions(root) {
  const result = [];
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === "mono-v2") continue;
    for (const file of await readdir(join(root, dir.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, file.name);
      try {
        const reader = await JournalReader.open(path, root, { ownerOnly: false });
        let h; try { h = await reader.readHeader(); } finally { await reader.close(); }
        if (h?.v === 4 && h.kind === "header" && h.storageVersion === 1) {
          result.push({ id: h.id, cwd: h.cwd, createdAt: h.createdAt, path, legacy: true });
        } else if (h?.type === "session" && h.version === 3) {
          result.push({ id: h.id, cwd: h.cwd, createdAt: Date.parse(h.timestamp), path, legacy: true });
        }
      } catch { fail(); }
    }
  }
  return result;
}

export async function readLegacySession(metadata, root) {
  const reader = await JournalReader.open(metadata.path, root, { ownerOnly: false });
  let evidence;
  /** @type {any} */ let header;
  const records = [];
  try {
    evidence = await reader.scan((record) => { if (!header) header = record; else records.push(record); });
    const identity = await reader.fingerprint();
    if (!["dev", "ino", "size", "mtimeMs"].every((key) => evidence.identity[key] === identity[key])) fail();
    evidence.identity = identity;
  } finally { await reader.close(); }
  if (header?.id !== metadata.id) fail();
  const entries = new Map();
  const values = new Map();
  let tip = null;
  let seq = 0;
  if (header.type === "session" && header.version === 3) {
    for (const entry of records) {
      // v3 labels/config records are not model-facing; keep only native entries.
      if (!["message", "compaction", "branch_summary", "custom"].includes(entry?.type)) continue;
      if (entry.type === "compaction" && !Array.isArray(entry.retainedTail)) {
        // v3 cuts are entry-id based; reconstruct its retained branch contribution.
        const all = [...entries.values()];
        const cut = all.findIndex((e) => e.id === entry.firstKeptEntryId);
        if (cut < 0) fail();
        entry.retainedTail = buildHarnessSessionContext(all.slice(cut));
      }
      if (typeof entry.id !== "string" || entries.has(entry.id) || (entry.parentId !== null && !entries.has(entry.parentId))) fail();
      entries.set(entry.id, { ...entry, timestamp: Date.parse(entry.timestamp) });
      tip = entry.id;
    }
  } else if (header.v === 4 && header.kind === "header" && header.storageVersion === 1) {
    for (const record of records) {
      const writes = Array.isArray(record) ? record : [record];
      if (!writes.length) fail();
      for (const write of writes) {
        if (!object(write) || !Number.isSafeInteger(write.seq) || write.seq <= seq) fail();
        seq = write.seq;
        if (write.kind === "entry") {
          if (typeof write.id !== "string" || entries.has(write.id) || (write.parentId !== null && !entries.has(write.parentId))) fail();
          entries.set(write.id, write);
        } else if (write.kind === "value" || write.kind === "list") {
          if (typeof write.namespace !== "string" || typeof write.key !== "string" || !["set", "delete", "append"].includes(write.op)) fail();
          const address = `${write.namespace}\0${write.key}`;
          if (write.op === "delete") values.delete(address); else values.set(address, write.value);
        } else if (write.kind !== "usage") fail();
      }
    }
    tip = values.get("pi.branch.tip\0main") ?? null;
    // Any live operation/pending evidence (including sibling lanes) clean-breaks.
    for (const [address, value] of values) {
      if (address.startsWith("pi.op.meta\0") || address.startsWith("pi.op.state\0")
        || address.startsWith("pi.pending.") || (address.startsWith("pi.lane.state\0")
          && (value?.currentOperationId != null || value?.inbox?.length))) {
        return { status: "clean_break", reason: "open_operations", evidence };
      }
    }
  } else fail();
  const branch = [];
  const seen = new Set();
  for (let id = tip; id !== null;) {
    if (seen.has(id) || !entries.has(id)) fail();
    seen.add(id);
    const entry = entries.get(id);
    branch.push(entry); id = entry.parentId;
  }
  branch.reverse();
  return { status: "import", messages: buildHarnessSessionContext(branch), evidence };
}

export function legacyJournalId(metadata, root) {
  return createHash("sha256").update(`legacy\0${relative(resolve(root), resolve(metadata.path))}\0${metadata.id}`).digest("hex");
}
export function importDescriptor(metadata, root, projected) {
  const source = { path: relative(resolve(root), resolve(metadata.path)), id: metadata.id, identity: projected.evidence.identity };
  return { version: 1, importId: createHash("sha256").update(JSON.stringify(source)).digest("hex"), source,
    mode: projected.status, messageCount: projected.messages?.length ?? 0,
    contextHash: createHash("sha256").update(JSON.stringify(projected.messages ?? [])).digest("hex") };
}
export function importSourceMetadata(info, root) {
  if (typeof info?.source?.path !== "string" || info.source.path.split(/[\\/]/).length !== 2
    || info.source.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
    || !info.source.path.endsWith(".jsonl")) fail();
  return { id: info.source.id, path: join(resolve(root), info.source.path), legacy: true };
}
export async function assertLegacyIdentity(path, root, identity) {
  const reader = await JournalReader.open(path, root, { ownerOnly: false });
  try {
    const current = await reader.fingerprint();
    if (!["dev", "ino", "size", "mtimeMs", "sha256"].every((key) => current[key] === identity[key])) fail();
  } finally { await reader.close(); }
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
export async function archiveLegacySession(metadata, root, evidence, phase = async (_name) => {}) {
  const archive = `${metadata.path}.migrated`;
  const originalExists = await exists(metadata.path), archiveExists = await exists(archive);
  if (originalExists && archiveExists) fail(); // never overwrite an earlier archive
  if (!originalExists && !archiveExists) fail();
  if (originalExists) {
    await assertLegacyIdentity(metadata.path, root, evidence.identity);
    await rename(metadata.path, archive);
    await assertLegacyIdentity(archive, root, evidence.identity);
    await phase("archive_renamed");
  } else await assertLegacyIdentity(archive, root, evidence.identity);
  for (const path of new Set([dirname(metadata.path), resolve(root)])) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await assertLegacyIdentity(archive, root, evidence.identity);
  await phase("archive_synced");
}
