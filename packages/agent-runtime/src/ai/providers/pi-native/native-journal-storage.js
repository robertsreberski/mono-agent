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
    /** All journal/stage/copy bytes in this explicitly dedicated native root. */
    async inventory() {
      const directory = join(root, "mono-v2", "journals");
      try { await lstat(directory); } catch (error) { if (missing(error)) { if (repo.directoryIdentity) fail(); return { bytes: 0, stagedBytes: 0, journals: {} }; } throw error; }
      await repo.ensureDirectory(); let bytes = 0, stagedBytes = 0;
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
    },
  };
}
