// @ts-check
import { checkNativeInheritedPrefix } from "./handoff-producer.js";
// Private storage-only bridge: no provider dispatch, repair accounting or tools.
import { createEvidenceView, createHandoffBudget, prepareHandoff, buildHandoff, projectContext } from "@mono-agent/harness";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SessionStore, JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { JournalReader } from "@mono-agent/harness/journal-reader.js";
import { listLegacySessions } from "@mono-agent/harness/legacy-import.js";
import { JournalValidator, validateJournalHeader } from "@mono-agent/harness/journal-schema.js";
import { resolveDurableNativeSessionRepo, detachDurableNativeSession } from "./session-lifecycle.js";
import { normalizeDurableSessionsRoot } from "./sessions-root.js";
/** @returns {never} */
function fail() { throw new Error("Managed native journal evidence changed or is unavailable"); }
const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordered(v[k])])) : v;
// Matches the host's 32-entry chain / 16 MiB switch-payload ceiling. Raw
// capture is bounded separately from streaming inspection; never clip evidence.
export const MAX_CAPTURE_JOURNALS = 32;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export class NativeEvidenceCapacityError extends RangeError {
  constructor() {
    super("Managed native evidence capture exceeds its journal/chain limit");
    this.name = "NativeEvidenceCapacityError";
    this.code = "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT";
  }
}
const captureLimit = () => { throw new NativeEvidenceCapacityError(); };
const hex64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const missing = (error) => error?.code === "ENOENT";
/** Positive pinned dispatch provenance: provider/API/model/account all known. @param {any} value */
const positiveLeaseProvenance = (value) => !!value && typeof value === "object"
  && ["provider", "api", "model", "account"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0 && value[key].length <= 512)
  && value.account.trim().toLowerCase() !== "unknown";
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
  /** Streaming digests; only the three reference-frame records are retained.
   * An immutable intent admits only an exact prefix of those deterministic bytes.
   * @param {any} coordinate @param {any} [event] */
  const snapshot = async (coordinate, event, prefixOnly = false, capture = 0, direct = false) => {
    const meta = capture || direct ? { id: coordinate.handleId, journalId: coordinate.journalId, path: path(coordinate.journalId) } : await metadata(coordinate), reader = await JournalReader.open(meta.path, root);
    try {
      if (capture && reader.identity.size > (typeof capture === "number" ? capture : MAX_CAPTURE_BYTES)) captureLimit();
      /** @type {any} */ let header;
      /** @type {any} */ let handleBinding;
      let parentId = null, first = true, frozenFirst = true, frozenTip = null;
      const validator = new JournalValidator(), full = createHash("sha256").update("["), frozen = createHash("sha256").update("[");
      let referenceBytes = 0;
      const records = [];
      // Lease provenance proof for unguarded epochs: every content-bearing
      // record's operation must carry the identical positive pinned provenance.
      const operationProvenance = new Map();
      /** @type {any} */ let leaseProvenance; /** @type {string|undefined} */ let leaseKey;
      let leaseUnproven = false, contentRecords = 0;
      let plan = [], planIndex = 0, frozenFound = coordinate.sourceSeq === undefined, frozenDigest, boundary = 0;
      const evidence = await reader.scan((record, address) => {
        if (!header) { validateJournalHeader(record); header = record; boundary = address.offset + address.length + 1; return; }
        if (capture) records.push(record);
        const wire = JSON.stringify(record);
        if (!first) full.update(","); full.update(wire); first = false;
        if (!frozenFound) {
          if (!frozenFirst) frozen.update(","); frozen.update(wire); frozenFirst = false;
        } else if (event) {
          if (planIndex >= plan.length || !same(record, plan[planIndex++])) fail();
        }
        validator.apply(record); parentId = record.id;
        if (record.kind === "operation_start") operationProvenance.set(record.operationId, record.payload?.config?.nativeProvenance);
        if (record.kind === "message" || record.kind === "compaction") {
          const actual = operationProvenance.get(record.operationId);
          const key = positiveLeaseProvenance(actual) ? JSON.stringify([actual.provider, actual.api, actual.model, actual.account]) : undefined;
          const messageProvenance = record.kind === "message" ? record.payload?.provenance : undefined;
          contentRecords += 1;
          if (key === undefined || (leaseKey !== undefined && key !== leaseKey)
            || (messageProvenance && ["provider", "api"].some((name) => messageProvenance[name] !== actual[name]))) leaseUnproven = true;
          else if (leaseKey === undefined) { leaseKey = key; leaseProvenance = { provider: actual.provider, api: actual.api, model: actual.model, account: actual.account }; }
        }
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
      }, capture ? { maxBytes: capture } : undefined);
      if (!header || header.id !== coordinate.handleId || header.journalId !== meta.journalId || !frozenFound) fail();
      const digest = full.update("]").digest("hex");
      if (event) {
        // Validate even partial JSON byte tails before the primitive may truncate.
        const expected = Buffer.from(plan.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const length = evidence.identity.size - boundary; referenceBytes = length;
        if (length > expected.length) fail();
        const bytes = Buffer.alloc(length); let read = 0;
        while (read < length) { const result = await reader.handle.read(bytes, read, length - read, boundary + read); if (!result.bytesRead) fail(); read += result.bytesRead; }
        if (!expected.subarray(0, length).equals(bytes)) fail();
      } else if (!prefixOnly && (evidence.torn || validator.openTurns.size || validator.openOperations.size)) fail();
      const current = await reader.assertIdentity();
      if (current.nlink !== 1 || current.size !== evidence.identity.size || current.mtimeMs !== evidence.identity.mtimeMs || current.ctimeMs !== evidence.identity.ctimeMs) fail();
      return { metadata: meta, header, records, handleBinding, referenceBytes,
        leaseProvenance: !leaseUnproven && contentRecords > 0 ? leaseProvenance : undefined, owner: validator.owner, bytes: current.size, descriptor: { ...coordinate, journalId: meta.journalId,
        sourceTipId: validator.tip, sourceSeq: validator.seq, sourceDigest: digest }, parentId,
        };
    } catch (error) { if (capture && error?.code === "ERR_JOURNAL_READ_LIMIT") captureLimit(); throw error; } finally { await reader.close(); }
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
  // Definitive absence of every published/staged member of one exact journal.
  const journalAbsent = async (journalId) => {
    for (const suffix of ["", ".creating", ".importing", ".upgrading"]) {
      try { await lstat(path(journalId) + suffix); return false; } catch (error) { if (!missing(error)) throw error; }
    }
    return true;
  };
  // Frozen predecessors must still be exact. A DEFINITIVELY absent one (lost
  // externally) stays absent and untouched: C never recreates or depends on it.
  // Any present bytes, including damaged or staged ones, must still match.
  const verifyPredecessors = async (chain, context) => {
    for (const predecessor of chain.slice(0, -1)) {
      if (await journalAbsent(predecessor.journalId)) continue;
      const frozen = await snapshot(predecessor);
      if (!same(frozen.descriptor, predecessor) || !same(frozen.header.hostAuthority, context.hostAuthority)) fail();
    }
  };
  // Read-only, stage-aware catalogue for one v3 handle. Unlike repo.list() it
  // never reclaims a `.creating` stage and counts `.importing`/`.upgrading`
  // copies and legacy archives, so a staged-only restore is never "absent".
  // Serialized with native creators by the catalogue lock.
  const handleCatalogue = async (handleId) => {
    const found = { published: /** @type {any[]} */ ([]), staged: 0, legacy: 0, archived: 0, unattributed: 0 };
    let names = [];
    try { names = await readdir(repo.directory); } catch (error) { if (!missing(error)) throw error; }
    if (names.length) {
      const locks = await repo.ensureDirectory();
      await locks.withCatalog(async () => {
        for (const name of await readdir(repo.directory)) {
          const match = /^([A-Za-z0-9_-]+)\.jsonl(\.(?:creating|importing|upgrading))?$/.exec(name); if (!match) fail();
          const reader = await JournalReader.open(join(repo.directory, name), root);
          try {
            const header = await reader.readHeader({ allowIncomplete: true });
            if (header === undefined) { if (!match[2]) fail(); found.unattributed += 1; continue; }
            if (header?.id !== handleId) continue;
            if (match[2]) { found.staged += 1; continue; }
            validateJournalHeader(header);
            found.published.push({ id: handleId, journalId: match[1], path: join(repo.directory, name) });
          } finally { await reader.close(); }
        }
      });
    }
    for (const entry of await listLegacySessions(root, { includeArchives: true })) {
      if (entry.id === handleId) { if (entry.path.endsWith(".migrated")) found.archived += 1; else found.legacy += 1; }
    }
    return found;
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
          if (suffix === ".upgrading") {
            const source = await JournalReader.open(path(entry.journalId), root);
            try { await JsonlSessionRepo.assertGuardedHeaderCopy(source, reader, context.hostAuthority); }
            finally { await source.close(); }
            continue;
          }
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
    const current = chain.at(-1), provenance = context.targetProvenance;
    if (provenance !== undefined && (!provenance || Object.keys(provenance).sort().join(",") !== "account,api,model,provider"
      || ["provider", "api", "model"].some((key) => typeof provenance[key] !== "string" || !provenance[key].length || provenance[key].length > 512)
      || provenance.account !== null && (typeof provenance.account !== "string" || !provenance.account.length || provenance.account.length > 512))) fail();
    if (chain.some((entry) => entry.predecessorJournalId === current.journalId)
      || chain.some((entry) => entry.handleId === context.targetHandleId || entry.epoch === context.targetEpoch)
      || !/^[a-f0-9]{64}$/.test(context.targetEpoch)) fail();
    const plan = JsonlSessionRepo.guardedEpochPlan({ id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: context.hostAuthority });
    return { plan, descriptor: { ...current, epoch: context.targetEpoch, handleId: context.targetHandleId,
      journalId: plan.header.journalId, ...(context.targetProvenance ? { provenance: context.targetProvenance } : {}), sourceTipId: null, sourceSeq: 4,
      sourceDigest: createHash("sha256").update(JSON.stringify(plan.records)).digest("hex") } };
  };
  return {
    nativeEvidence: "v1",
    createBudget: createHandoffBudget, prepareHandoff, buildHandoff, checkInheritedPrefix: checkNativeInheritedPrefix,
    projectChain: (view, options) => projectContext(view, { ...options, switching: true }),
    /** Read only: no detach/open-for-writing, repair, import or publication.
     * Caller first freezes the current coordinate under its settled claim.
     * @param {any[]} sources @param {any} context */
    async captureEvidence(sources, context) {
      if (!sources.length || typeof context?.assertOwned !== "function") fail();
      if (sources.length > MAX_CAPTURE_JOURNALS) captureLimit();
      const statEvidence = async (source) => { try { return await lstat(path(source.journalId)); } catch { fail(); } };
      const readEvidence = async (source, remaining) => {
        try { return await snapshot(source, undefined, false, remaining); }
        catch (error) { if (error instanceof NativeEvidenceCapacityError) throw error; fail(); }
      };
      let bytes = 0;
      // Stat every exact published path before allocating records or parsing even
      // the first header. Also bounds single oversized JSONL lines. Rechecked by
      // the secure reader before each scan and by its identity CAS afterward.
      await context.assertOwned();
      for (const source of sources) { bytes += (await statEvidence(source)).size; if (bytes > MAX_CAPTURE_BYTES) captureLimit(); }
      let capturedBytes = 0;
      const segments = [], seen = new Set();
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]; await context.assertOwned();
        if (source.ordinal !== index || source.ownerKey !== context.ownerKey || source.historyBucket !== context.historyBucket
          || source.predecessorJournalId !== (index ? sources[index - 1].journalId : null) || seen.has(source.journalId)) fail();
        seen.add(source.journalId);
        if (capturedBytes >= MAX_CAPTURE_BYTES) captureLimit();
        const captured = await readEvidence(source, MAX_CAPTURE_BYTES - capturedBytes);
        capturedBytes += captured.bytes; if (capturedBytes > MAX_CAPTURE_BYTES) captureLimit();
        if (!same(captured.descriptor, source) || captured.header.ownershipSchemaVersion === 2 && !same(captured.header.hostAuthority, context.hostAuthority)) fail();
        const { epoch: _epoch, ordinal, ...descriptor } = source;
        segments.push({ descriptor: { ...descriptor, epoch: ordinal }, header: captured.header, records: captured.records });
      }
      await context.assertOwned(); return createEvidenceView({ ownerKey: context.ownerKey, historyBucket: context.historyBucket, segments });
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
      // An unguarded opt-in epoch is positive only when EVERY content-bearing
      // operation recorded the identical pinned lease provenance for this exact
      // bound model. Never inferred from credentials, paths or caller options:
      // older/unguarded writes have no such records and stay unknown.
      const lease = frozen.leaseProvenance;
      const account = lease && lease.provider === model.provider && lease.api === model.api && lease.model === model.id ? lease.account : null;
      return { ...frozen.descriptor, provenance: { provider: model.provider, api: model.api, model: model.id, account } };
    },
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
    /** Read-only proof that native publication has begun for this exact ready
     * intent. An empty tail does not opt the owner into a switch. Foreign bytes
     * fail closed; valid partial deterministic frames are recoverable too.
     * @param {any[]} sources @param {any} context */
    async hasSwitchReference(sources, context) {
      await context.assertOwned(); validateChain(sources, context);
      let present = false;
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index], current = await snapshot(source, index === sources.length - 1 ? context.event : undefined);
        if (index < sources.length - 1 && !same(current.descriptor, source)) fail();
        if (current.header.ownershipSchemaVersion === 2 && !same(current.header.hostAuthority, context.hostAuthority)) fail();
        if (current.referenceBytes > 0 && current.header.ownershipSchemaVersion !== 2) fail();
        if (index === sources.length - 1) present = current.referenceBytes > 0;
      }
      await context.assertOwned(); return present;
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
          await phase("model_change_before_open");
          const store = await repo.open(current.metadata, { repair: false, wait: false });
          try {
            await phase("model_change_writer_opened"); await context.assertOwned(); store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: context.hostAuthority });
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
      // Current may have a rejected or interrupted tail, so only its immutable
      // header is deletion evidence.
      await verifyPredecessors(chain, context);
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
      await verifyPredecessors(chain, context);
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
            try { await lstat(path(entry.journalId)); } catch (error) {
              if (!missing(error)) throw error;
              for (const suffix of [".creating", ".upgrading", ".importing"]) {
                try { await lstat(path(entry.journalId) + suffix); return true; } catch (stageError) { if (!missing(stageError)) throw stageError; }
              }
              continue;
            }
            const writerPath = join(locks.directory, `${entry.journalId}.sqlite`);
            await locks.ensureFile(writerPath); const writer = await locks.tryLock(writerPath);
            if (!writer) return true; writers.push(writer);
            let reader;
            try { reader = await JournalReader.open(path(entry.journalId), root); }
            catch (error) { if (missing(error)) continue; throw error; }
            try {
              const header = await reader.readHeader(); validateJournalHeader(header);
              if (header.id !== entry.handleId || header.journalId !== entry.journalId || header.ownershipSchemaVersion !== 2 || !same(header.hostAuthority, authority)) return true;
              for (const suffix of [".creating", ".upgrading", ".importing"]) {
                let copy; try { copy = await JournalReader.open(path(entry.journalId) + suffix, root); }
                catch (error) { if (missing(error)) continue; return true; }
                try {
                  const copied = suffix === ".upgrading" ? await JsonlSessionRepo.assertGuardedHeaderCopy(reader, copy, authority) : await copy.readHeader();
                  validateJournalHeader(copied);
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
     * With `frozen` (a predecessor), present bytes must also match that exact
     * canonical descriptor and host authority, as C later requires.
     * @param {{handleId:string, journalId?:string, frozen?:any, hostAuthority?:any}} coordinates */
    async inspectCurrentJournal(coordinates) {
      const { handleId, journalId, frozen, hostAuthority } = coordinates ?? {};
      if (frozen !== undefined && (journalId === undefined || frozen?.journalId !== journalId || frozen.handleId !== handleId || !hostAuthority)) fail();
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
          // An unattributable stage could belong to this handle: not definitive.
          if (found.unattributed) return unreadable("staged_unattributed");
          if (found.published.length > 1) return unreadable("ambiguous");
          if (found.published.length === 1) meta = found.published[0];
          // Legacy sources are imported by the ordinary open path; presence suffices.
          else if (found.legacy) return { status: "present" };
          else if (found.staged || found.archived) return unreadable("staged_only");
          else return { status: "missing" };
        }
        const reader = await JournalReader.open(meta.path, root);
        try {
          /** @type {any} */ let header; const validator = new JournalValidator();
          await reader.scan((record) => { if (!header) { validateJournalHeader(record); header = record; } else validator.apply(record); });
          if (!header || header.id !== handleId || journalId !== undefined && header.journalId !== journalId) return unreadable("identity");
        } finally { await reader.close(); }
        if (frozen !== undefined) {
          // A valid but older/foreign predecessor (e.g. a restored prefix) is not
          // the frozen evidence: refuse before any C intent can depend on it.
          let exact; try { exact = await snapshot(frozen, undefined, false, 0, true); } catch { return unreadable("predecessor_changed"); }
          if (!same(exact.descriptor, frozen) || !same(exact.header.hostAuthority, hostAuthority)) return unreadable("predecessor_changed");
        }
        return { status: "present" };
      } catch (error) {
        return unreadable(error?.code === "ENOENT" ? "changed" : error instanceof SyntaxError ? "malformed" : "invalid");
      }
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
    /** Only guarded managed journals, plus exact IDs enrolled by durable host
     * intents. Legacy provider journals never receive implicit charge/credit.
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
      /** @type {Record<string,{retainedBytes:number,headerCopyBytes:number,stagedBytes:number}>} */ const journals = Object.create(null);
      for (const name of await readdir(directory)) {
        if (!/^[A-Za-z0-9_-]+\.jsonl(?:\.(?:creating|importing|upgrading))?$/.test(name)) fail();
        const id = name.split(".")[0]; if (scope && !scope.has(id) && !unreadableOwners) continue;
        const reader = await JournalReader.open(join(directory, name), root);
        try {
          if (!scope || !scope.has(id)) {
            let header; try { header = await reader.readHeader({ allowIncomplete: true }); validateJournalHeader(header); }
            catch { continue; }
            if (header?.ownershipSchemaVersion !== 2) continue;
            if (scope && (!unreadableOwners || !same(header.hostAuthority.rootId, unreadableOwners.rootId)
              || !unknownKeys.has(createHash("sha256").update("mono-agent-history-v1\0").update(header.hostAuthority.historyBucket).digest("hex")))) continue;
          }
          const stat = await reader.assertIdentity(); if (stat.nlink !== 1) fail(); bytes += stat.size; if (!Number.isSafeInteger(bytes)) fail();
          const row = journals[id] ??= { retainedBytes: 0, headerCopyBytes: 0, stagedBytes: 0 };
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
