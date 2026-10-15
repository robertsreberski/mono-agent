import { managedJournalId } from "./managed-journal.js";
// One-way idle MAIN branch import only. Never schedule or replay old operations.
import { lstat, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { JournalReader } from "./journal-reader.js";
import { createCompactionSummaryMessage } from "./compaction-kit/messages.js";
import { projectContext } from "./request-projection.js";
import { syncDir } from "./owned-fs-impl.js";

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
/** @returns {never} */
const fail = () => { throw new Error("Invalid legacy Pi session"); };
/** Valid legacy sources plus damaged legacy-named entries (unreadable,
 * malformed or of unknown format). Damage is never imported, archived or
 * deleted. Pi names sources `<time>_<id>.jsonl`, which attributes damage to that
 * handle; an entry without that shape (or an unreadable directory) has no owner.
 * @param {string} root @param {{includeArchives?:boolean, id?:string}} [options]
 * @returns {Promise<{sessions:any[], unattributed:{name:string, id?:string}[]}>} */
export async function listLegacySessions(root, { includeArchives = false, id: requestedId } = {}) {
  const sessions = [], unattributed = [];
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { sessions, unattributed }; throw error; }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === "mono-v2") continue;
    let files;
    try { files = await readdir(join(root, dir.name), { withFileTypes: true }); }
    catch { unattributed.push({ name: dir.name }); continue; }
    for (const file of files) {
      if (!(includeArchives ? /\.jsonl(?:\.migrated)?$/ : /\.jsonl$/).test(file.name)) continue;
      const path = join(root, dir.name, file.name), id = /^[^_]*_(.+)\.jsonl(?:\.migrated)?$/.exec(file.name)?.[1];
      // Only an attributable different filename can be skipped. Renamed Pi
      // sources still need a header read to discover their owner.
      if (requestedId !== undefined && id !== undefined && id !== requestedId) continue;
      let h;
      try {
        const reader = await JournalReader.open(path, root, { ownerOnly: false });
        try { h = await reader.readHeader(); } finally { await reader.close(); }
      } catch (error) { if (error?.code === "ENOENT") continue; }
      if (h?.v === 4 && h.kind === "header" && h.storageVersion === 1) {
        sessions.push({ id: h.id, cwd: h.cwd, createdAt: h.createdAt, path, legacy: true });
      } else if (h?.type === "session" && h.version === 3) {
        sessions.push({ id: h.id, cwd: h.cwd, createdAt: Date.parse(h.timestamp), path, legacy: true });
      } else unattributed.push({ name: join(dir.name, file.name), ...(id ? { id } : {}) });
    }
  }
  return { sessions, unattributed };
}

// Legacy Pi compactions become messages during import, never current-format
// compaction records. Supply their summary envelope at this conversion boundary.
function projectLegacyContext(entries) {
  return projectContext(entries.map((entry) => entry.type === "compaction" ? { ...entry,
    checkpoint: { summaryMessage: createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp) },
  } : entry));
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
      // Pi 0.99.2 keeps physical ancestry through configuration/label nodes.
      if (!["message", "compaction", "branch_summary", "custom", "custom_message", "model_change",
        "thinking_level_change", "active_tools_change", "session_info", "label"].includes(entry?.type)) fail();
      if (typeof entry.id !== "string" || entries.has(entry.id) || (entry.parentId !== null && !entries.has(entry.parentId))) fail();
      if (entry.type === "compaction" && !Array.isArray(entry.retainedTail)) {
        const tail = []; let id = entry.parentId; let found = false;
        while (id !== null) {
          const ancestor = entries.get(id); if (!ancestor) fail();
          // A previous compaction contributes its summary, not its own tail.
          const messages = projectLegacyContext([{ ...ancestor, retainedTail: [] }]).messages;
          if (messages[0]) tail.push(messages[0]);
          if (id === entry.firstKeptEntryId) { found = true; break; }
          id = ancestor.parentId;
        }
        if (!found) fail(); entry.retainedTail = tail.reverse();
      }
      const normalized = entry.type === "custom_message" ? { ...entry, type: "message", message: {
        role: "custom", customType: entry.customType, content: entry.content, details: entry.details,
        display: entry.display, timestamp: Date.parse(entry.timestamp),
      } } : entry;
      entries.set(entry.id, { ...normalized, timestamp: Date.parse(entry.timestamp) });
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
  return { status: "import", messages: projectLegacyContext(branch).messages, evidence };
}

export function legacyJournalId(metadata, root) {
  return managedJournalId(metadata.id);
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
  for (const path of new Set([dirname(metadata.path), resolve(root)])) await syncDir(path, undefined, fail);
  await assertLegacyIdentity(archive, root, evidence.identity);
  await phase("archive_synced");
}
