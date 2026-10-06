// @ts-check
// Private storage-only bridge: no provider dispatch, repair accounting or tools.
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { SessionStore, JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { JournalReader } from "@mono-agent/harness/journal-reader.js";
import { JournalValidator, validateJournalHeader } from "@mono-agent/harness/journal-schema.js";
import { resolveDurableNativeSessionRepo, detachDurableNativeSession } from "./session-lifecycle.js";
/** @returns {never} */
function fail() { throw new Error("Managed native journal evidence changed or is unavailable"); }
const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordered(v[k])])) : v;
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const missing = (error) => error?.code === "ENOENT";
/** @param {{sessionsRoot:string, onPhase?:(phase:string)=>Promise<void>}} options */
export function createManagedNativeJournalStorage({ sessionsRoot, onPhase = async () => {} }) {
  if (!isAbsolute(sessionsRoot)) throw new TypeError("Managed native root must be absolute");
  const root = resolve(sessionsRoot), repo = resolveDurableNativeSessionRepo(root);
  const phase = async (name) => { await onPhase(name); };
  const path = (id) => { if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(); return join(root, "mono-v2", "journals", `${id}.jsonl`); };
  const metadata = async (source) => {
    const matches = (await repo.listOwned({ wait: false })).filter((item) => item.id === source.handleId && (!source.journalId || item.journalId === source.journalId));
    if (matches.length !== 1 || matches[0].path !== path(matches[0].journalId)) fail(); return matches[0];
  };
  /** Streaming digests; only the three reference-frame records are retained.
   * An immutable intent admits only an exact prefix of those deterministic bytes.
   * @param {any} coordinate @param {any} [event] */
  const snapshot = async (coordinate, event, prefixOnly = false) => {
    const meta = await metadata(coordinate), reader = await JournalReader.open(meta.path, root);
    try {
      /** @type {any} */ let header;
      /** @type {any} */ let handleBinding;
      let parentId = null, first = true, frozenFirst = true, frozenTip = null;
      const validator = new JournalValidator(), full = createHash("sha256").update("["), frozen = createHash("sha256").update("[");
      let plan = [], planIndex = 0, frozenFound = coordinate.sourceSeq === undefined, frozenDigest, boundary = 0;
      const evidence = await reader.scan((record, address) => {
        if (!header) { validateJournalHeader(record); header = record; boundary = address.offset + address.length + 1; return; }
        const wire = JSON.stringify(record);
        if (!first) full.update(","); full.update(wire); first = false;
        if (!frozenFound) {
          if (!frozenFirst) frozen.update(","); frozen.update(wire); frozenFirst = false;
        } else if (event) {
          if (planIndex >= plan.length || !same(record, plan[planIndex++])) fail();
        }
        validator.apply(record); parentId = record.id;
        if (record.kind === "handle_binding") handleBinding = record.payload;
        const binding = record.kind === "owner_binding" ? record.payload : record.payload.binding;
        if (binding && binding.kind !== "unbound" && (binding.ownerKey !== coordinate.ownerKey || binding.historyBucket !== coordinate.historyBucket)) fail();
        if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== coordinate.handleId) fail();
        if (!frozenFound && validator.seq === coordinate.sourceSeq) {
          frozenFound = true; frozenTip = validator.tip; frozenDigest = frozen.update("]").digest("hex");
          if (frozenTip !== coordinate.sourceTipId || frozenDigest !== coordinate.sourceDigest || validator.openTurns.size || validator.openOperations.size) fail();
          boundary = address.offset + address.length + 1;
          if (event) plan = SessionStore.modelChangeRecords(event, { seq: validator.seq, parentId, tip: validator.tip });
        }
      });
      if (!header || header.id !== coordinate.handleId || header.journalId !== meta.journalId || !frozenFound) fail();
      const digest = full.update("]").digest("hex");
      if (event) {
        // Validate even partial JSON byte tails before the primitive may truncate.
        const expected = Buffer.from(plan.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const length = evidence.identity.size - boundary;
        if (length > expected.length) fail();
        const bytes = Buffer.alloc(length); let read = 0;
        while (read < length) { const result = await reader.handle.read(bytes, read, length - read, boundary + read); if (!result.bytesRead) fail(); read += result.bytesRead; }
        if (!expected.subarray(0, length).equals(bytes)) fail();
      } else if (!prefixOnly && (evidence.torn || validator.openTurns.size || validator.openOperations.size)) fail();
      const current = await reader.assertIdentity();
      if (current.nlink !== 1 || current.size !== evidence.identity.size || current.mtimeMs !== evidence.identity.mtimeMs || current.ctimeMs !== evidence.identity.ctimeMs) fail();
      return { metadata: meta, header, handleBinding, owner: validator.owner, bytes: current.size, descriptor: { ...coordinate, journalId: meta.journalId,
        sourceTipId: validator.tip, sourceSeq: validator.seq, sourceDigest: digest }, parentId,
        };
    } finally { await reader.close(); }
  };
  // Canonical membership is supplied by the held host owner, never inferred
  // from catalogue presence. Native storage validates all coordinates again.
  const validateChain = (chain, context) => {
    if (!Array.isArray(chain) || !chain.length || typeof context?.assertOwned !== "function") fail();
    JsonlSessionRepo.guardedEpochPlan({ id: chain[0]?.handleId, timestamp: 0, hostAuthority: context.hostAuthority });
    const journals = new Set(), handles = new Set();
    for (let index = 0; index < chain.length; index++) {
      const entry = chain[index];
      if (!entry || !/^[A-Za-z0-9_-]+$/.test(entry.journalId) || !/^[a-f0-9]{64}$/.test(entry.handleId)
        || !/^[a-f0-9]{64}$/.test(entry.epoch) || entry.ordinal !== index
        || entry.predecessorJournalId !== (index ? chain[index - 1].journalId : null)
        || entry.ownerKey !== context.hostAuthority.ownerKey || entry.historyBucket !== context.hostAuthority.historyBucket
        || journals.has(entry.journalId) || handles.has(entry.handleId)) fail();
      journals.add(entry.journalId); handles.add(entry.handleId);
    }
  };
  const deletionMetadata = (entry) => ({ id: entry.handleId, journalId: entry.journalId, path: path(entry.journalId) });
  // Preflight the complete physical set, including stages, before any unlink.
  // Rejected current tails are not repaired or promoted into frozen evidence.
  const inspectDeletion = async (entries, context) => {
    await context.assertOwned(); await repo.ensureDirectory();
    const names = await readdir(repo.directory);
    for (const entry of entries) {
      const allowed = new Set(["", ".creating", ".importing", ".upgrading"].map((suffix) => `${entry.journalId}.jsonl${suffix}`));
      if (names.some((name) => name.startsWith(`${entry.journalId}.`) && !allowed.has(name))) fail();
      for (const suffix of ["", ".creating", ".importing", ".upgrading"]) {
        let reader;
        try { reader = await JournalReader.open(path(entry.journalId) + suffix, root); }
        catch (error) { if (missing(error)) continue; throw error; }
        try {
          const header = await reader.readHeader(); validateJournalHeader(header);
          if (header.id !== entry.handleId || header.journalId !== entry.journalId
            || header.ownershipSchemaVersion !== 2 || !same(header.hostAuthority, context.hostAuthority)) fail();
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
  const coldPlan = (chain, context) => {
    validateChain(chain, context);
    const current = chain.at(-1);
    if (chain.some((entry) => entry.predecessorJournalId === current.journalId)
      || chain.some((entry) => entry.handleId === context.targetHandleId || entry.epoch === context.targetEpoch)
      || !/^[a-f0-9]{64}$/.test(context.targetEpoch)) fail();
    const plan = JsonlSessionRepo.guardedEpochPlan({ id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: context.hostAuthority });
    return { plan, descriptor: { ...current, epoch: context.targetEpoch, handleId: context.targetHandleId,
      journalId: plan.header.journalId, sourceTipId: null, sourceSeq: 4,
      sourceDigest: createHash("sha256").update(JSON.stringify(plan.records)).digest("hex") } };
  };
  return {
    /** @param {any} coordinates */
    async freeze(coordinates) { await detachDurableNativeSession(coordinates.handleId, root); return (await snapshot(coordinates)).descriptor; },
    /** Before intent publication: no upgrade/event/create side effects. @param {any[]} sources @param {any} context */
    async measureSwitch(sources, context) {
      await context.assertOwned(); let retainedNativeBytes = 0, headerCopyBytes = 0;
      for (const source of sources) {
        await detachDurableNativeSession(source.handleId, root);
        const frozen = await snapshot(source);
        if (!same(frozen.descriptor, source)) fail();
        if (frozen.header.ownershipSchemaVersion === 2 && !same(frozen.header.hostAuthority, context.hostAuthority)) fail();
        retainedNativeBytes += frozen.bytes;
        const oldHeader = Buffer.byteLength(JSON.stringify(frozen.header) + "\n");
        const newHeader = Buffer.byteLength(JSON.stringify({ ...frozen.header, ownershipSchemaVersion: 2, hostAuthority: context.hostAuthority }) + "\n");
        if (frozen.header.ownershipSchemaVersion !== 2) {
          retainedNativeBytes += newHeader - oldHeader;
          headerCopyBytes = Math.max(headerCopyBytes, frozen.bytes - oldHeader + newHeader);
        }
      }
      const target = JsonlSessionRepo.guardedEpochPlan({ id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: context.hostAuthority });
      const source = sources.at(-1), current = await snapshot(source);
      if (current.owner.kind !== "host" || current.owner.ownerKey !== context.hostAuthority.ownerKey
        || current.owner.historyBucket !== context.hostAuthority.historyBucket || current.handleBinding?.baseRevision + 1 !== context.sourceRevision
        || `${current.handleBinding?.model?.provider}:${current.handleBinding?.model?.id}` !== context.fromModelKey
        || ["provider", "api"].some((key) => current.handleBinding?.model?.[key] !== source.provenance[key])
        || current.handleBinding?.model?.id !== source.provenance.model) fail();
      if ((await repo.listOwned({ wait: false })).some((entry) => entry.id === context.targetHandleId)) throw new Error("Native target epoch already exists before intent publication");
      const frames = SessionStore.modelChangeRecords(context.event, { seq: source.sourceSeq, parentId: current.parentId, tip: source.sourceTipId });
      // Exact reference framing is measured once content exists; pre-intent callers
      // reserve a fixed-size hash reference with the same serialized dimensions.
      retainedNativeBytes += target.bytes.length + Buffer.byteLength(frames.map((r) => JSON.stringify(r)).join("\n") + "\n");
      await context.assertOwned(); return { retainedNativeBytes, headerCopyBytes };
    },
    /** Ready-only. @param {any[]} sources @param {any} context */
    async publishSwitch(sources, context) {
      await context.assertOwned(); const output = [];
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]; await detachDurableNativeSession(source.handleId, root);
        const current = await snapshot(source, index === sources.length - 1 ? context.event : undefined);
        if (current.header.ownershipSchemaVersion !== 2) {
          if (!same(current.descriptor, source)) fail();
          await repo.upgradeHeader(current.metadata, { hostAuthority: context.hostAuthority, assertOwned: context.assertOwned,
            onPhase: async (name) => phase(`header_${name}`) });
        } else if (!same(current.header.hostAuthority, context.hostAuthority)) fail();
        if (index < sources.length - 1 && !same(current.descriptor, source)) fail();
        if (index === sources.length - 1) {
          const store = await repo.open(current.metadata, { repair: false, wait: false });
          try { await context.assertOwned(); store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: context.hostAuthority });
            await store.appendModelChangeReference({ ...context.event, onPhase: phase });
          } finally { await store.close(); }
        }
        output.push((await snapshot(source, index === sources.length - 1 ? context.event : undefined)).descriptor);
      }
      await context.assertOwned();
      await repo.createGuardedEpoch({ id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: context.hostAuthority, assertOwned: context.assertOwned, onPhase: phase });
      const last = sources.at(-1);
      const target = await snapshot({ epoch: context.targetEpoch, ordinal: sources.length, predecessorJournalId: last.journalId,
        handleId: context.targetHandleId, ownerKey: last.ownerKey, historyBucket: last.historyBucket, provenance: context.targetProvenance });
      await context.assertOwned(); return [...output, target.descriptor];
    },
    /** Historical completed switch fences may outlive a cold replacement of
     * their target. Verify the accepted source frames, never recreate old B.
     * @param {any[]} chain @param {any[]} sources @param {any} context */
    async verifySwitchSources(chain, sources, context) {
      await context.assertOwned(); validateChain(chain, context);
      if (chain.length <= sources.length) fail();
      for (let index = 0; index < sources.length; index++) {
        const current = await snapshot(sources[index], index === sources.length - 1 ? context.event : undefined);
        if (!same(current.header.hostAuthority, context.hostAuthority) || !same(current.descriptor, chain[index])
          || current.descriptor.sourceSeq !== sources[index].sourceSeq + (index === sources.length - 1 ? 3 : 0)) fail();
      }
      for (let index = sources.length; index < chain.length; index++) {
        const evidence = await snapshot(chain[index], undefined, index === chain.length - 1);
        if (!same(evidence.header.hostAuthority, context.hostAuthority) || index < chain.length - 1 && !same(evidence.descriptor, chain[index])) fail();
      }
      await context.assertOwned();
    },
    /** Recovered canonical receipts must name real completed native publication.
     * Read-only validation: never append, repair or create missing evidence.
     * @param {any[]} chain @param {any[]} sources @param {any} context */
    async verifySwitch(chain, sources, context) {
      await context.assertOwned();
      if (chain.length !== sources.length + 1) fail();
      for (let index = 0; index < sources.length; index++) {
        const current = await snapshot(sources[index], index === sources.length - 1 ? context.event : undefined);
        if (!same(current.header.hostAuthority, context.hostAuthority) || !same(current.descriptor, chain[index])
          || current.descriptor.sourceSeq !== sources[index].sourceSeq + (index === sources.length - 1 ? 3 : 0)) fail();
      }
      const plan = JsonlSessionRepo.guardedEpochPlan({ id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: context.hostAuthority });
      const expected = { epoch: context.targetEpoch, ordinal: sources.length, handleId: context.targetHandleId,
        journalId: plan.header.journalId, predecessorJournalId: sources.at(-1).journalId,
        ownerKey: context.hostAuthority.ownerKey, historyBucket: context.hostAuthority.historyBucket,
        provenance: context.targetProvenance, sourceTipId: null, sourceSeq: 4,
        sourceDigest: createHash("sha256").update(JSON.stringify(plan.records)).digest("hex") };
      if (!same(chain.at(-1), expected)) fail();
      // Later B turns may exist after semantic fence unlink. Only the immutable
      // initializer prefix is required here; any provider fence owns its tail.
      const target = await snapshot(expected, undefined, true);
      if (!same(target.header, plan.header)) fail(); await context.assertOwned();
    },
    /** Pure deterministic plan, to persist in host C intent before any I/O.
     * No new predecessor is made from the rejected current tail.
     * @param {any[]} chain @param {any} context */
    planColdEpoch(chain, context) {
      const { plan, descriptor } = coldPlan(chain, context);
      return { descriptor, bytes: plan.bytes.length };
    },
    /** Host must retain its C intent until canonical publication and cleanup.
     * @param {any[]} chain @param {any} context */
    async publishColdEpoch(chain, context) {
      const { plan, descriptor } = coldPlan(chain, context);
      await context.assertOwned();
      // Frozen predecessors must still be exact; current may have a rejected or
      // interrupted tail, so only its immutable header is deletion evidence.
      for (const predecessor of chain.slice(0, -1)) {
        const frozen = await snapshot(predecessor);
        if (!same(frozen.descriptor, predecessor) || !same(frozen.header.hostAuthority, context.hostAuthority)) fail();
      }
      await inspectDeletion([chain.at(-1)], context);
      await repo.createGuardedEpoch({ id: context.targetHandleId, timestamp: context.timestamp,
        hostAuthority: context.hostAuthority, assertOwned: context.assertOwned, onPhase: phase });
      const target = await snapshot(descriptor, undefined, true);
      if (!same(target.header, plan.header)) fail();
      await context.assertOwned(); return [...chain.slice(0, -1), descriptor];
    },
    /** Read-only proof after the host cold rename. Never recreates missing
     * evidence behind a canonical receipt. @param {any[]} chain @param {any} context */
    async verifyColdEpoch(chain, context) {
      const { plan, descriptor } = coldPlan(chain, context); await context.assertOwned();
      for (const predecessor of chain.slice(0, -1)) {
        const frozen = await snapshot(predecessor);
        if (!same(frozen.descriptor, predecessor) || !same(frozen.header.hostAuthority, context.hostAuthority)) fail();
      }
      const target = await snapshot(descriptor, undefined, true);
      if (!same(target.header, plan.header)) fail(); await context.assertOwned();
    },
    /** Read-only retention eligibility probe, not deletion authority. A live
     * writer or contradictory header protects the owner before reservation.
     * @param {any[]} chain @param {any} authority */
    async deletionBlocked(chain, authority) {
      validateChain(chain, { hostAuthority: authority, assertOwned: async () => {} });
      const locks = await repo.ensureDirectory();
      try { return await locks.withCatalog(async () => {
        const writers = [];
        try {
          for (const entry of chain) {
            if (repo.openSessions.has(entry.handleId)) return true;
            const writerPath = join(locks.directory, `${entry.journalId}.sqlite`);
            await locks.ensureFile(writerPath); const writer = await locks.tryLock(writerPath);
            if (!writer) return true; writers.push(writer);
            let reader;
            try { reader = await JournalReader.open(path(entry.journalId), root); }
            catch (error) { if (missing(error)) continue; throw error; }
            try {
              const header = await reader.readHeader(); validateJournalHeader(header);
              if (header.id !== entry.handleId || header.journalId !== entry.journalId || header.ownershipSchemaVersion !== 2 || !same(header.hostAuthority, authority)) return true;
            } catch { return true; } finally { await reader.close(); }
          }
          return false;
        } finally { for (const writer of writers) writer.release(); }
      }, { wait: false }); } catch (error) { if (error?.code === "ERR_HARNESS_WRITER_BUSY") return true; throw error; }
    },
    /** Reference-checked C or full-set D. Missing members are idempotent success,
     * not creation eligibility. Host retains membership until every barrier wins.
     * @param {any[]} chain @param {any} context */
    async deleteJournals(chain, context) {
      validateChain(chain, context);
      if (!["C", "D"].includes(context.disposition)) fail();
      const entries = context.disposition === "D" ? chain : chain.filter((entry) => entry.journalId === context.eligibleJournalId);
      if (context.disposition === "C" && (entries.length !== 1 || entries[0] !== chain.at(-1)
        || chain.some((entry) => entry.predecessorJournalId === context.eligibleJournalId))) fail();
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
    /** All journal/stage/copy bytes in this explicitly dedicated native root. */
    async inventory() {
      const directory = join(root, "mono-v2", "journals");
      try { await lstat(directory); } catch (error) { if (missing(error)) { if (repo.directoryIdentity) fail(); return { bytes: 0, stagedBytes: 0, journals: {} }; } throw error; }
      const locks = await repo.ensureDirectory(); return locks.withCatalog(async () => { let bytes = 0, stagedBytes = 0;
      /** @type {Record<string,{retainedBytes:number,headerCopyBytes:number,stagedBytes:number}>} */ const journals = Object.create(null);
      for (const name of await readdir(directory)) {
        if (!/^[A-Za-z0-9_-]+\.jsonl(?:\.(?:creating|importing|upgrading))?$/.test(name)) fail();
        const reader = await JournalReader.open(join(directory, name), root);
        try { const stat = await reader.assertIdentity(); if (stat.nlink !== 1) fail(); bytes += stat.size; if (!Number.isSafeInteger(bytes)) fail();
          const id = name.split(".")[0], row = journals[id] ??= { retainedBytes: 0, headerCopyBytes: 0, stagedBytes: 0 };
          if (name.endsWith(".upgrading")) row.headerCopyBytes += stat.size; else row.retainedBytes += stat.size;
          if (!name.endsWith(".jsonl")) { row.stagedBytes += stat.size; stagedBytes += stat.size; }
        }
        finally { await reader.close(); }
      }
      await repo.assertDirectory(); return { bytes, stagedBytes, journals };
      });
    },
  };
}
