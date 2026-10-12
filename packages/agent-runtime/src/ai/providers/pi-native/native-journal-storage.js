// @ts-check
import { checkNativeInheritedPrefix } from "./handoff-producer.js";
// Private storage-only bridge: no provider dispatch, repair accounting or tools.
import { createEvidenceView, createHandoffBudget, prepareHandoff, buildHandoff } from "@mono-agent/harness";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { JsonlSessionRepo, journalEntrySuffix } from "@mono-agent/harness/session-store.js";
import { JournalReader } from "@mono-agent/harness/journal-reader.js";
import { listLegacySessions } from "@mono-agent/harness/legacy-import.js";
import { JournalValidator, validateJournalHeader } from "@mono-agent/harness/journal-schema.js";
import { resolveDurableNativeSessionRepo, detachDurableNativeSession } from "./session-lifecycle.js";
import { normalizeDurableSessionsRoot } from "./sessions-root.js";
/** @returns {never} */
function fail() { throw new Error("Managed native journal evidence changed or is unavailable"); }
const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordered(v[k])])) : v;
// Matches the host's 16 MiB switch-payload ceiling. Raw capture is bounded
// separately from streaming inspection; never clip evidence.
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export class NativeEvidenceCapacityError extends RangeError {
  constructor() {
    super("Managed native evidence capture exceeds its byte limit");
    this.name = "NativeEvidenceCapacityError";
    this.code = "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT";
  }
}
const captureLimit = () => { throw new NativeEvidenceCapacityError(); };
const hex64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const missing = (error) => error?.code === "ENOENT";
const STAGES = ["", ".creating", ".importing"];
/** @param {{sessionsRoot:string, onPhase?:(phase:string)=>Promise<void>}} options */
export function createManagedNativeJournalStorage({ sessionsRoot, onPhase = async () => {} }) {
  if (typeof sessionsRoot !== "string" || !isAbsolute(sessionsRoot.trim())) throw new TypeError("Managed native root must be absolute");
  const root = normalizeDurableSessionsRoot(sessionsRoot), repo = resolveDurableNativeSessionRepo(root);
  const phase = async (name) => { await onPhase(name); };
  const path = (id) => { if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(); return join(root, "mono-v2", "journals", `${id}.jsonl`); };
  const metadata = async (source) => {
    const matches = (await repo.listOwned({ wait: false })).filter((item) => item.id === source.handleId && (!source.journalId || item.journalId === source.journalId));
    if (matches.length !== 1 || matches[0].path !== path(matches[0].journalId)) fail(); return matches[0];
  };
  /** Streaming digest of one exact journal; records are retained only for capture.
   * @param {any} coordinate */
  const snapshot = async (coordinate, capture = 0, direct = false) => {
    const meta = capture || direct ? { id: coordinate.handleId, journalId: coordinate.journalId, path: path(coordinate.journalId) } : await metadata(coordinate), reader = await JournalReader.open(meta.path, root);
    try {
      if (capture && reader.identity.size > capture) captureLimit();
      /** @type {any} */ let header;
      /** @type {any} */ let handleBinding;
      const validator = new JournalValidator(), full = createHash("sha256").update("[");
      let first = true;
      const records = [];
      const evidence = await reader.scan((record) => {
        if (!header) { validateJournalHeader(record); header = record; return; }
        if (capture) records.push(record);
        if (!first) full.update(","); full.update(JSON.stringify(record)); first = false;
        validator.apply(record);
        if (record.kind === "handle_binding") handleBinding = record.payload;
        const binding = record.kind === "owner_binding" ? record.payload : record.payload.binding;
        if (binding && binding.kind !== "unbound" && (binding.ownerKey !== coordinate.ownerKey || binding.historyBucket !== coordinate.historyBucket)) fail();
        if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== coordinate.handleId) fail();
      }, capture ? { maxBytes: capture } : undefined);
      if (!header || header.id !== coordinate.handleId || header.journalId !== meta.journalId) fail();
      if (evidence.torn || validator.openTurns.size || validator.openOperations.size) fail();
      const current = await reader.assertIdentity();
      if (current.nlink !== 1 || current.size !== evidence.identity.size || current.mtimeMs !== evidence.identity.mtimeMs || current.ctimeMs !== evidence.identity.ctimeMs) fail();
      return { metadata: meta, header, records, handleBinding,
        owner: validator.owner, bytes: current.size,
        descriptor: { ...coordinate, journalId: meta.journalId, sourceTipId: validator.tip, sourceSeq: validator.seq, sourceDigest: full.update("]").digest("hex") } };
    } catch (error) { if (capture && error?.code === "ERR_JOURNAL_READ_LIMIT") captureLimit(); throw error; } finally { await reader.close(); }
  };
  // Definitive absence of every published/staged member of one exact journal.
  const journalAbsent = async (journalId) => {
    for (const suffix of STAGES) {
      try { await lstat(path(journalId) + suffix); return false; } catch (error) { if (!missing(error)) throw error; }
    }
    return true;
  };
  // Read-only, stage-aware catalogue for one v3 handle. Unlike repo.list() it
  // never reclaims a `.creating` stage and counts `.importing`/`.upgrading`
  // copies and legacy archives, so a staged-only restore is never "absent".
  // Serialized with native creators by the catalogue lock. Entry selection
  // matches listOwnedUnlocked: unrelated names are skipped and a matching
  // non-file fails. Like its reclaim rule, a `.creating` stage with an
  // incomplete or header-only body is a failed unpublished creation, not
  // evidence (ignored here, never unlinked). Any other matching file whose
  // header cannot be read, parsed or validated is unattributed: it could be
  // this handle's damaged journal, so it blocks only a "missing" verdict, never
  // a found published journal. repo.list() skips unattributed entries.
  const handleCatalogue = async (handleId) => {
    const found = { published: /** @type {any[]} */ ([]), staged: 0, legacy: 0, archived: 0, unattributed: 0 };
    let present = false;
    try { present = (await lstat(repo.directory)).isDirectory(); } catch (error) { if (!missing(error)) throw error; }
    if (present) {
      const locks = await repo.ensureDirectory();
      await locks.withCatalog(async () => {
        for (const file of await readdir(repo.directory, { withFileTypes: true })) {
          const suffix = journalEntrySuffix(file.name);
          if (!suffix) continue;
          if (!file.isFile()) { found.unattributed += 1; continue; }
          const filePath = join(repo.directory, file.name);
          let header, bodyless = false;
          try {
            const reader = await JournalReader.open(filePath, root);
            try {
              header = await reader.readHeader({ allowIncomplete: true });
              if (suffix === ".jsonl.creating" && header) { let count = 0; const scan = await reader.scan(() => { count += 1; }); bodyless = count === 1 && !scan.torn; }
            } finally { await reader.close(); }
          } catch (error) { if (missing(error)) continue; header = null; }
          if (suffix === ".jsonl.creating" && (header === undefined || bodyless)) continue;
          if (!header || typeof header !== "object") { found.unattributed += 1; continue; }
          if (header.id !== handleId) continue;
          if (suffix !== ".jsonl") { found.staged += 1; continue; }
          try { validateJournalHeader(header); } catch { found.unattributed += 1; continue; }
          found.published.push({ id: handleId, journalId: file.name.slice(0, -suffix.length), path: filePath });
        }
      });
    }
    const legacy = await listLegacySessions(root, { includeArchives: true });
    // Damaged legacy entries named for this handle, or of unknown owner, could be ours.
    found.unattributed += legacy.unattributed.filter((entry) => entry.id === undefined || entry.id === handleId).length;
    for (const entry of legacy.sessions) {
      if (entry.id === handleId) { if (entry.path.endsWith(".migrated")) found.archived += 1; else found.legacy += 1; }
    }
    return found;
  };
  const deletionMetadata = (entry) => ({ id: entry.handleId, journalId: entry.journalId, path: path(entry.journalId) });
  // Preflight the complete physical set, including stages, before any unlink.
  // Guarded journals must carry this host authority; an unguarded switch source
  // is identified by its exact frozen header only.
  const inspectDeletion = async (entries, context) => {
    await context.assertOwned(); await repo.ensureDirectory();
    const names = await readdir(repo.directory);
    for (const entry of entries) {
      const allowed = new Set(STAGES.map((suffix) => `${entry.journalId}.jsonl${suffix}`));
      if (names.some((name) => name.startsWith(`${entry.journalId}.`) && !allowed.has(name))) fail();
      for (const suffix of STAGES) {
        let reader;
        try { reader = await JournalReader.open(path(entry.journalId) + suffix, root); }
        catch (error) { if (missing(error)) continue; throw error; }
        try {
          const header = await reader.readHeader(); validateJournalHeader(header);
          if (header.id !== entry.handleId || header.journalId !== entry.journalId
            || header.ownershipSchemaVersion === 2 && !same(header.hostAuthority, context.hostAuthority)) fail();
          if (suffix) {
            const validator = new JournalValidator(); let first = true;
            const evidence = await reader.scan((record) => {
              if (first) first = false; else validator.apply(record);
            });
            if (evidence.torn || validator.openTurns.size || validator.openOperations.size) fail();
          }
          const identity = await reader.assertIdentity(); if (identity.nlink !== 1) fail();
        } finally { await reader.close(); }
      }
    }
    await repo.assertDirectory(); await context.assertOwned();
  };
  return {
    nativeEvidence: "v1",
    createBudget: createHandoffBudget, prepareHandoff, buildHandoff, checkInheritedPrefix: checkNativeInheritedPrefix,
    /** Read only: no detach/open-for-writing, repair, import or publication.
     * Caller first freezes the current coordinate under its settled claim. A null
     * source means the current journal is definitively missing: canonical gaps
     * then carry the history through the same approved handoff order.
     * @param {any} source @param {any} context */
    async captureEvidence(source, context) {
      if (typeof context?.assertOwned !== "function" || !source && !context.gaps?.length) fail();
      await context.assertOwned();
      const segments = [];
      if (source) {
        if (source.ownerKey !== context.ownerKey || source.historyBucket !== context.historyBucket) fail();
        // Stat the exact published path before allocating records or parsing even
        // the first header. Rechecked by the secure reader and its identity CAS.
        let stat; try { stat = await lstat(path(source.journalId)); } catch { fail(); }
        if (stat.size > MAX_CAPTURE_BYTES) captureLimit();
        let captured;
        try { captured = await snapshot(source, MAX_CAPTURE_BYTES); }
        catch (error) { if (error instanceof NativeEvidenceCapacityError) throw error; fail(); }
        if (!same(captured.descriptor, source) || captured.header.ownershipSchemaVersion === 2 && !same(captured.header.hostAuthority, context.hostAuthority)) fail();
        const { epoch: _epoch, ...descriptor } = source;
        segments.push({ descriptor, header: captured.header, records: captured.records });
      }
      await context.assertOwned();
      return createEvidenceView({ ownerKey: context.ownerKey, historyBucket: context.historyBucket, segments, gaps: context.gaps ?? [], prior: context.prior ?? null });
    },
    /** @param {any} coordinates */
    async freeze(coordinates) {
      await detachDurableNativeSession(coordinates.handleId, root);
      const frozen = await snapshot(coordinates);
      if (coordinates.provenance) return frozen.descriptor;
      // Legacy account evidence is unknown. API/model come from validated owned
      // native binding bytes, never a credential lookup needed just to summarize.
      const binding = frozen.handleBinding, model = binding?.model;
      if (frozen.owner.kind !== "host" || frozen.owner.ownerKey !== coordinates.ownerKey || frozen.owner.historyBucket !== coordinates.historyBucket
        || binding?.handleId !== coordinates.handleId || !model || [model.provider, model.api, model.id].some((value) => typeof value !== "string" || !value.length)) fail();
      return { ...frozen.descriptor, provenance: { provider: model.provider, api: model.api, model: model.id, account: null } };
    },
    /** Deterministic guarded epoch for a switch target or cold rotation. Idempotent
     * across crashes; an existing exact initializer is the only acceptable state.
     * @param {any} context */
    async createEpoch(context) {
      await context.assertOwned();
      await repo.createGuardedEpoch({ id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: context.hostAuthority,
        assertOwned: context.assertOwned, onPhase: phase });
      await context.assertOwned();
    },
    /** Read-only retention eligibility probe, not deletion authority. A live
     * writer or contradictory header protects the owner before reservation.
     * @param {any[]} journals @param {any} authority */
    async deletionBlocked(journals, authority) {
      const locks = await repo.ensureDirectory();
      try { return await locks.withCatalog(async () => {
        const writers = [];
        try {
          for (const entry of journals) {
            if (repo.openSessions.has(entry.handleId)) return true;
            try { await lstat(path(entry.journalId)); } catch (error) {
              if (!missing(error)) throw error;
              for (const suffix of STAGES.slice(1)) {
                try { await lstat(path(entry.journalId) + suffix); return true; } catch (stageError) { if (!missing(stageError)) throw stageError; }
              }
              continue;
            }
            const writerPath = join(locks.directory, `${entry.journalId}.sqlite`);
            await locks.ensureFile(writerPath); const writer = await locks.tryLock(writerPath);
            if (!writer) return true; writers.push(writer);
            let reader;
            try { reader = await JournalReader.open(path(entry.journalId), root); }
            catch (error) { if (missing(error)) continue; return true; } // damaged evidence is never a victim
            try {
              const header = await reader.readHeader(); validateJournalHeader(header);
              if (header.id !== entry.handleId || header.journalId !== entry.journalId || header.ownershipSchemaVersion !== 2 || !same(header.hostAuthority, authority)) return true;
              for (const suffix of STAGES.slice(1)) {
                let copy; try { copy = await JournalReader.open(path(entry.journalId) + suffix, root); }
                catch (error) { if (missing(error)) continue; return true; }
                try {
                  const copied = await copy.readHeader(); validateJournalHeader(copied);
                  if (copied.id !== entry.handleId || copied.journalId !== entry.journalId || copied.ownershipSchemaVersion !== 2 || !same(copied.hostAuthority, authority)) return true;
                } catch { return true; } finally { await copy.close(); }
              }
            } catch { return true; } finally { await reader.close(); }
          }
          return false;
        } finally { for (const writer of writers) writer.release(); }
      }, { wait: false }); } catch (error) { if (error?.code === "ERR_HARNESS_WRITER_BUSY") return true; throw error; }
    },
    /** Read-only presence probe under the held host claim. Never opens for
     * writing, repairs, imports, creates or deletes. `missing` requires a
     * definitive absence: no published/staged file for an exact journal ID, or
     * no catalogue entry (owned or legacy) for the handle. Any other doubt is
     * `unreadable`, never cold authority. A torn final line is left to the
     * existing open/repair path; every complete line must parse and validate.
     * @param {{handleId:string, journalId?:string}} coordinates */
    async inspectCurrentJournal(coordinates) {
      const { handleId, journalId } = coordinates ?? {};
      if (!hex64(handleId) || journalId !== undefined && (typeof journalId !== "string" || !/^[A-Za-z0-9_-]+$/.test(journalId))) fail();
      const unreadable = (reason) => ({ status: /** @type {const} */ ("unreadable"), reason });
      let meta;
      try {
        if (journalId !== undefined) {
          if (await journalAbsent(journalId)) return { status: "missing" };
          try { await lstat(path(journalId)); } catch (error) { if (missing(error)) return unreadable("staged_only"); throw error; }
          meta = { id: handleId, journalId, path: path(journalId) };
        } else {
          const found = await handleCatalogue(handleId);
          if (found.published.length > 1) return unreadable("ambiguous");
          if (found.published.length === 1) meta = found.published[0];
          // Legacy sources are imported by the ordinary open path; presence suffices.
          else if (found.legacy) return { status: "present" };
          else if (found.staged || found.archived) return unreadable("staged_only");
          // An unattributable file could be this handle's damaged journal.
          else if (found.unattributed) return unreadable("unattributed");
          else return { status: "missing" };
        }
        const reader = await JournalReader.open(meta.path, root);
        try {
          /** @type {any} */ let header; const validator = new JournalValidator();
          await reader.scan((record) => { if (!header) { validateJournalHeader(record); header = record; } else validator.apply(record); });
          if (!header || header.id !== handleId || journalId !== undefined && header.journalId !== journalId) return unreadable("identity");
        } finally { await reader.close(); }
        return { status: "present" };
      } catch (error) {
        return unreadable(error?.code === "ENOENT" ? "changed" : error instanceof SyntaxError ? "malformed" : "invalid");
      }
    },
    /** Exact host-listed journals (C retires one superseded journal, D a whole
     * conversation). Missing members are idempotent success, not creation
     * eligibility. Host retains its intent until every barrier wins.
     * @param {any[]} entries @param {any} context */
    async deleteJournals(entries, context) {
      if (!["C", "D"].includes(context?.disposition) || typeof context.assertOwned !== "function"
        || entries.some((entry) => !hex64(entry?.handleId) || !/^[A-Za-z0-9_-]+$/.test(entry.journalId))) fail();
      for (const entry of entries) await detachDurableNativeSession(entry.handleId, root);
      await inspectDeletion(entries, context);
      for (const entry of entries) {
        await context.assertOwned();
        await repo.delete(deletionMetadata(entry), { hostAuthority: context.hostAuthority,
          disposition: context.disposition, assertOwned: context.assertOwned, onPhase: phase });
        await phase("native_member_removed");
      }
      await context.assertOwned(); await phase("native_members_directory_synced");
    },
    /** Only guarded managed journals, plus exact IDs enrolled by durable host
     * intents. Legacy provider journals never receive implicit charge/credit.
     * An enrolled journal that cannot be opened (or is hard-linked) is damage:
     * its row is `damaged`, charged its named bytes, never credited or deleted.
     * Unreadable canonicals still charge independently attested schema-2
     * evidence for those exact buckets in this pinned root, never legacy files
     * or journals belonging to another root/bucket.
     * @param {string[]} [managedJournalIds]
     * @param {{rootId:string,conversationKeys:string[]}} [unreadableOwners] */
    async inventory(managedJournalIds = undefined, unreadableOwners = undefined) {
      const scope = managedJournalIds === undefined ? null : new Set(managedJournalIds);
      if (scope && [...scope].some((id) => !/^[A-Za-z0-9_-]+$/.test(id))) fail();
      if (unreadableOwners && (!hex64(unreadableOwners.rootId)
        || !Array.isArray(unreadableOwners.conversationKeys) || unreadableOwners.conversationKeys.some((key) => !hex64(key)))) fail();
      const unknownKeys = new Set(unreadableOwners?.conversationKeys);
      const directory = join(root, "mono-v2", "journals");
      try { await lstat(directory); } catch (error) { if (missing(error)) { if (repo.directoryIdentity) fail(); return { bytes: 0, stagedBytes: 0, journals: {} }; } throw error; }
      const locks = await repo.ensureDirectory(); return locks.withCatalog(async () => { let bytes = 0, stagedBytes = 0;
      /** @type {Record<string,{retainedBytes:number,stagedBytes:number,damaged?:true}>} */ const journals = Object.create(null);
      for (const name of await readdir(directory)) {
        // Shared skip rule: non-journal names and unattributed journal-named
        // entries are neither charged nor credited, and retention never deletes them.
        const suffix = journalEntrySuffix(name), id = suffix ? name.slice(0, -suffix.length) : "";
        if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
        if (scope && !scope.has(id) && !unreadableOwners) continue;
        let reader;
        try { reader = await JournalReader.open(join(directory, name), root); }
        catch (error) {
          if (!scope?.has(id) || missing(error)) continue;
          await repo.assertDirectory(); // root identity stays fatal; the entry alone is damaged
          let size = 0; try { size = (await lstat(join(directory, name))).size; } catch (statError) { if (!missing(statError)) throw statError; }
          const row = journals[id] ??= { retainedBytes: 0, stagedBytes: 0 };
          row.damaged = true; row.retainedBytes += size; bytes += size;
          if (!name.endsWith(".jsonl")) { row.stagedBytes += size; stagedBytes += size; }
          continue;
        }
        try {
          if (!scope || !scope.has(id)) {
            let header; try { header = await reader.readHeader({ allowIncomplete: true }); validateJournalHeader(header); }
            catch { continue; }
            if (header?.ownershipSchemaVersion !== 2) continue;
            if (scope && (!unreadableOwners || !same(header.hostAuthority.rootId, unreadableOwners.rootId)
              || !unknownKeys.has(createHash("sha256").update("mono-agent-history-v1\0").update(header.hostAuthority.historyBucket).digest("hex")))) continue;
          }
          const stat = await reader.assertIdentity(); bytes += stat.size; if (!Number.isSafeInteger(bytes)) fail();
          const row = journals[id] ??= { retainedBytes: 0, stagedBytes: 0 };
          row.retainedBytes += stat.size;
          if (!name.endsWith(".jsonl")) { row.stagedBytes += stat.size; stagedBytes += stat.size; }
        }
        finally { await reader.close(); }
      }
      await repo.assertDirectory(); return { bytes, stagedBytes, journals };
      });
    },
  };
}
