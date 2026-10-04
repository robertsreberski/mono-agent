// One-way idle MAIN branch import only. Never schedule or replay old operations.
import { lstat, readdir, rename, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readBoundedJsonl } from "./bounded-jsonl.js";
import { buildPiSessionContext } from "./session-context.js";

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const fail = () => { throw new Error("Invalid legacy Pi session"); };
export async function listLegacySessions(root) {
  const result = [];
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === "mono-v1") continue;
    for (const file of await readdir(join(root, dir.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, file.name);
      try {
        const { records } = await readBoundedJsonl(path, root);
        const h = records[0];
        if (h?.v === 4 && h.kind === "header" && h.storageVersion === 1) {
          result.push({ id: h.id, cwd: h.cwd, createdAt: h.createdAt, path, legacy: true });
        } else if (h?.type === "session" && h.version === 3) {
          result.push({ id: h.id, cwd: h.cwd, createdAt: Date.parse(h.timestamp), path, legacy: true });
        }
      } catch { /* malformed files are not resumable */ }
    }
  }
  return result;
}

export async function readLegacySession(metadata, root) {
  const evidence = await readBoundedJsonl(metadata.path, root);
  const [header, ...records] = evidence.records;
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
        entry.retainedTail = buildPiSessionContext(all.slice(cut));
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
  return { status: "import", messages: buildPiSessionContext(branch), evidence };
}

export async function archiveLegacySession(metadata, root, evidence) {
  // Detect changes after the read; only a successful NEW-store fsync may call this.
  const stat = await lstat(metadata.path);
  if (stat.dev !== evidence.identity.dev || stat.ino !== evidence.identity.ino
    || stat.size !== evidence.identity.size || stat.mtimeMs !== evidence.identity.mtimeMs) fail();
  await rename(metadata.path, `${metadata.path}.migrated`);
  for (const path of new Set([dirname(metadata.path), resolve(root)])) {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
