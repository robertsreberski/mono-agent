// Mono-agent-owned append-only single-main-branch store. No provider execution here.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createCompactionSummaryMessage } from "./compaction-kit/messages.js";
import { planRepairEntries } from "./repair-entries.js";
import { repairInterruptedSession } from "./interruption.js";
import { JournalStorageError, isJournalStorageError } from "./storage-error.js";
import { JournalReader } from "./journal-reader.js";
import { JournalLocks } from "./journal-lock.js";
import { archiveLegacySession, listLegacySessions, readLegacySession, legacyJournalId, importDescriptor, importSourceMetadata, assertLegacyIdentity } from "./legacy-import.js";

import { assertEvidenceView } from "./evidence-view.js";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { JOURNAL_FORMAT as FORMAT } from "./journal-types.js";
const clone = (v) => structuredClone(v);
const fail = () => { throw new Error("Invalid mono-agent harness session"); };
const corruptBinding = () => { throw Object.assign(new Error("Invalid mono-agent harness session binding"), { code: "ERR_HARNESS_JOURNAL_CORRUPT" }); };
const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");

export class SessionStore {
  constructor(metadata, records, io, onClose) {
    this.metadata = metadata;
    this.io = io;
    this.onClose = onClose;
    this.records = io?.read ? null : [];
    this.retired = false;
    this.version3WritesEnabled = false;
    /** @type {string|undefined} */ this.continuity = undefined;
    this.entries = new Map();
    this.outcomes = new Map();
    this.interruptions = new Map();
    this.interruptedOperations = new Set(); this.repairCache = null;
    this.validator = new JournalValidator();
    this.tip = null;
    this.seq = 0; this.durableSeq = 0;
    this.line = Promise.resolve();
    this.closed = false;
    /** @type {Error|null} */ this.failure = null;
    /** @type {Promise<void>|null} */ this.closePromise = null;
    for (const record of records) this.apply(record);
  }
  validateRecord(record) {
    if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== this.metadata.id) corruptBinding();
    this.validator.validate(record);
  }
  apply(record, address) {
    if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== this.metadata.id) corruptBinding();
    this.validator.apply(record);
    this.io?.remember?.(address, record);
    if (record.kind === "rewind") this.io?.invalidate?.();
    const p = record.payload;
    if (record.kind === "message" || record.kind === "compaction") {
      const data = record.kind === "message" ? { type: "message", message: p.message }
        : { ...p.compaction, type: "compaction" };
      this.entries.set(record.id, { ...(this.io?.read ? { address, type: data.type } : clone(data)),
        id: record.id, parentId: p.contextParentId, timestamp: record.timestamp, seq: record.seq });
    }
    if (record.kind === "interruption") {
      this.interruptions.set(record.id, { ...clone(record.payload), turnId: record.turnId, timestamp: record.timestamp });
      for (const op of p.operationIds.length ? p.operationIds : [null]) this.interruptedOperations.add(`${record.turnId}\0${op ?? ""}`);
    }
    if (["interruption", "tool_result", "message", "compaction", "rewind", "operation_end"].includes(record.kind)) this.repairCache = null;
    if (record.kind === "tool_result" && record.payload.phase === "returned") {
      this.outcomes.set(`${record.operationId}\0${record.payload.callId}`, this.io?.read ? { address } : { record: clone(record) });
    }
    this.tip = this.validator.tip;
    this.seq = record.seq;
    this.records?.push(clone(record));
  }
  enqueue(fn) {
    const result = this.line.then(async () => {
      if (this.closed || this.retired) { this.failure ??= new Error("Harness session is closed or retired"); throw this.failure; }
      if (this.failure) throw this.failure;
      return await fn();
    });
    this.line = result.catch(() => {});
    return result;
  }
  /** @param {any} kind @param {any} payload @param {{turnId?: string, operationId?: string, id?: string, schemaVersion?: 2|3}} [identity] */
  write(kind, payload, identity = {}) {
    return this.enqueue(() => this.writeRecord(kind, payload, identity));
  }
  /** @param {any} kind @param {any} payload @param {{turnId?: string, operationId?: string, id?: string, schemaVersion?: 2|3}} [identity] */
  async writeRecord(kind, payload, { turnId = this.activeTurnId(), operationId, id = randomUUID(), schemaVersion = 2 } = {}) {
      if (schemaVersion === 3) this.assertVersion3WritesEnabled();
      const record = { schemaVersion, id, parentId: this.validator.parentId,
        seq: this.seq + 1, timestamp: Date.now(), turnId, kind,
        ...(operationId ? { operationId } : {}), payload: typeof payload === "function" ? payload() : clone(payload) };
      const text = `${JSON.stringify(record)}\n`;
      const persisted = this.io?.read ? JSON.parse(text) : record;
      this.validateRecord(persisted);
      try {
        const address = await this.io?.append(text);
        this.apply(persisted, address);
      } catch (error) { throw this.poison(error); }
      return persisted;
  }
  poison(error) { this.failure ??= isJournalStorageError(error) ? error : new JournalStorageError(error); return this.failure; }
  activeTurnId() { return this.validator.openTurns.values().next().value; }
  activeOperationId() { return [...this.validator.openOperations].at(-1); }
  beginTurn(turnId, config = {}, identitySource = "synthetic", binding) {
    return this.write("turn_start", () => ({ config: clone(config), identitySource, baselineTipId: this.tip,
      ...(binding ? { binding: clone(binding) } : {}) }), { turnId });
  }
  endTurn(turnId, status, result = null) {
    return this.write("turn_end", () => ({ status, tipId: this.tip,
      finalOperationId: this.validator.turns.get(turnId)?.finalOperationId ?? null,
      consumedInputIds: [...(this.validator.turns.get(turnId)?.inputs ?? [])],
      ...(this.validator.turns.get(turnId)?.start.payload.binding ? { seal: { version: 1,
        outcome: ({ completed: "completed", failed: "failed", aborted: "cancelled", interrupted: "interrupted" })[status], result: clone(result) } } : {}) }), { turnId });
  }
  openOperation(operationId, config, type = "prompt", cause = "prompt") {
    return this.write("operation_start", () => ({ config: clone(config), type, cause, baselineTipId: this.tip, parentOperationId: this.activeOperationId() ?? null }), { operationId });
  }
  closeOperation(operationId, status) { return this.write("operation_end", () => ({ status, tipId: this.tip }), { operationId }); }
  scopedWrite(fn, cause, before = undefined) {
    return this.enqueue(async () => {
    before?.();
    const synthetic = !this.activeTurnId();
    const turnId = synthetic ? `synthetic:${cause}:${randomUUID()}` : this.activeTurnId();
    if (synthetic) await this.writeRecord("turn_start", { config: { cause }, identitySource: "synthetic", baselineTipId: this.tip }, { turnId });
    const result = await fn();
    if (synthetic) await this.writeRecord("turn_end", { status: "completed", tipId: this.tip, finalOperationId: null, consumedInputIds: [] }, { turnId });
    return result;
    });
  }
  async appendMessage(message, id = randomUUID(), input = { id: null, complete: true }) {
    return this.scopedWrite(async () => {
      const config = this.validator.operations.get(this.activeOperationId())?.start.payload.config;
      const provenance = { provider: message.provider ?? config?.model?.provider ?? "unknown",
        api: message.api ?? config?.model?.api ?? "unknown", model: message.model ?? config?.model?.id ?? "unknown" };
      const record = await this.writeRecord("message", () => ({ message: clone(message), provenance, input: clone(input), contextParentId: this.tip }),
        { id, operationId: this.activeOperationId() });
      return record.id;
    }, "seed");
  }
  /** Explicit operational acknowledgement, per open writer. Complete v3 records
   * reject in old readers, but old cold-open repair can truncate a torn v3 tail.
   * Stop/prohibit all older readers/writers for this root before enabling.
   * This is not canonical or cross-process authorization.
   * @param {{exclusiveWriters:true}} options
   */
  enableVersion3Writes(options) {
    if (options?.exclusiveWriters !== true) throw new TypeError("Version-3 writes require exclusive upgraded writers");
    this.version3WritesEnabled = true;
  }
  assertVersion3WritesEnabled() {
    if (!this.version3WritesEnabled) throw new TypeError("Version-3 writes require enableVersion3Writes with exclusive upgraded writers");
  }
  async appendComposedCompaction(data, view) {
    this.assertVersion3WritesEnabled();
    assertEvidenceView(view);
    const inheritedMessages = new Set(view.segments.slice(0, -1).flatMap((s) => s.entries.filter((e) => e.type === "message").map((e) => JSON.stringify(e.message))));
    if ((data.retainedTail ?? []).some((message) => inheritedMessages.has(JSON.stringify(message)))) throw new TypeError("Inherited native tail must remain in predecessor evidence");
    const current = view.segments.at(-1).descriptor;
    if (current.journalId !== this.metadata.journalId || current.handleId !== this.metadata.id
      || current.sourceTipId !== this.tip || current.sourceSeq !== this.seq) throw new TypeError("Composed checkpoint source changed");
    return this.appendCompaction(data, { version: 1, sources: view.segments.slice(0, -1).map((s) => ({
      journalId: s.descriptor.journalId, sourceTipId: s.descriptor.sourceTipId,
      sourceSeq: s.descriptor.sourceSeq, sourceDigest: s.descriptor.sourceDigest,
    })) }, current);
  }
  async appendCompaction(data, inheritedCoverage = undefined, source = undefined) {
    if (inheritedCoverage) this.assertVersion3WritesEnabled();
    // Prepare outside the admitted write queue; getEntries itself drains it.
    const branch = await this.getEntries(); const preservedMessageIds = [], derivedMessages = [];
    let cursor = 0;
    for (const message of data.retainedTail ?? []) {
      const index = branch.findIndex((entry, at) => at >= cursor && entry.type === "message" && JSON.stringify(entry.message) === JSON.stringify(message));
      if (index >= 0) { preservedMessageIds.push(branch[index].id); cursor = index + 1; }
      else derivedMessages.push(clone(message));
    }
    const timestamp = Date.now();
    const checkpoint = { version: 1, summaryMessage: createCompactionSummaryMessage(data.summary, data.tokensBefore, timestamp),
      preservedMessageIds, derivedMessages, tokensBefore: data.tokensBefore ?? null, tokensAfter: data.tokensAfter ?? null,
      model: this.validator.operations.get(this.activeOperationId())?.start.payload.config?.model ?? null,
      coverage: { version: 1, sourceTipId: this.tip, sourceEntryCount: branch.length }, projectionVersion: 1, ...(inheritedCoverage ? { inheritedCoverage: clone(inheritedCoverage) } : {}) };
    return this.scopedWrite(async () => (await this.writeRecord("compaction", () => ({
      compaction: { ...clone(data), checkpoint }, contextParentId: this.tip, preservedMessageIds,
      derivedMessages, coverageVersion: 1 }), { operationId: this.activeOperationId(), schemaVersion: inheritedCoverage ? 3 : 2 })).id, "compaction", inheritedCoverage ? () => {
      if (!source || source.sourceTipId !== this.tip || source.sourceSeq !== this.seq) throw new TypeError("Composed checkpoint source changed");
    } : undefined);
  }
  /** Opt-in reference only: host artifacts are the sole content authority. */
  async appendModelChangeReference({ switchId, from, to, artifactRef }) {
    this.assertVersion3WritesEnabled();
    return this.scopedWrite(() => this.writeRecord("model_change", {
      version: 1, switchId, from, to, source: "host-handoff", checkpointId: null, artifactRef,
    }, { schemaVersion: 3 }), "model-change");
  }
  async moveTo(tipId) { await this.scopedWrite(() => this.writeRecord("rewind", { tipId }), "rollback"); return tipId; }
  async verifyRead() { try { await this.io?.verify?.(); } catch (error) { throw this.poison(error); } }
  snapshot() {
    return clone({ validator: this.validator, entries: this.entries, outcomes: this.outcomes,
      interruptions: this.interruptions, interruptedOperations: this.interruptedOperations,
      tip: this.tip, seq: this.seq, durableSeq: this.durableSeq });
  }
  restore(snapshot) {
    Object.assign(this, clone(snapshot)); this.validator = Object.assign(new JournalValidator(), this.validator);
  }
  readQueue(fn) {
    const result = this.line.then(async () => {
      if (this.failure) throw this.failure;
      if (this.closed && this.io?.read) throw new Error("Harness session is closed");
      return fn();
    });
    this.line = result.catch(() => {}); return result;
  }
  getEntries() {
    return this.readQueue(async () => {
      await this.verifyRead(); const entries = [];
      for (let id = this.tip; id !== null;) {
        const e = this.entries.get(id); if (!e) fail();
        entries.push(await this.materialize(e, true)); id = e.parentId;
      }
      await this.verifyRead(); return entries.reverse();
    });
  }
  async getLeafId() { await this.line; if (this.failure) throw this.failure; return this.tip; }
  async materialize(entry, cached = false) {
    if (!entry || !this.io?.read) return clone(entry);
    let record;
    try { record = (cached ? this.io.cached?.(entry.address) : undefined) ?? await this.io.read(entry.address); }
    catch (error) { this.failure = isJournalStorageError(error) ? error : new JournalStorageError(error); throw this.failure; }
    return { ...(record.kind === "message" ? { type: "message", message: record.payload.message }
      : { ...record.payload.compaction, type: "compaction" }), id: entry.id, parentId: entry.parentId,
      timestamp: entry.timestamp, seq: entry.seq };
  }
  getAllEntries() { return this.readQueue(async () => {
    await this.verifyRead(); const entries = await Promise.all([...this.entries.values()].map((entry) => this.materialize(entry, true)));
    await this.verifyRead(); return entries;
  }); }
  getEntry(id) { return this.readQueue(() => this.materialize(this.entries.get(id))); }
  async getOpenTurns() { await this.line; return [...this.validator.openTurns].map((id) => clone(this.validator.turns.get(id).start)); }
  async getOpenOperations() { await this.line; return [...this.validator.openOperations].map((id) => clone(this.validator.operations.get(id).start)); }
  async getTurn(turnId) { await this.line; return clone(this.validator.turns.get(turnId)?.end); }
  async getTerminal(operationId) {
    await this.line;
    const op = this.validator.operations.get(operationId);
    return op?.end ? { ...clone(op.end), config: clone(op.start.payload.config), fromTipId: op.start.payload.baselineTipId,
      tipId: op.end.payload.tipId, status: op.end.payload.status } : undefined;
  }
  async getRepairEntries() {
    await this.line; if (this.failure) throw this.failure;
    if (!this.interruptions.size) return [];
    if (!this.repairCache) {
      // Branch membership uses indexed ancestry, not a second full payload read.
      const visible = new Set();
      for (let id = this.tip; id !== null; id = this.entries.get(id).parentId) visible.add(id);
      const plan = planRepairEntries({ tip: this.tip, visible, interruptions: this.interruptions.values(),
        validator: this.validator, timestamp: (id) => this.entries.get(id).timestamp });
      this.repairCache = Promise.all(plan.repairs.map(async (repair) => ({ ...repair, calls: await Promise.all(repair.calls.map(async (call) => ({
        ...call, returned: await this.getReturnedOutcome(call.operationId, call.callId),
      }))) }))).then(async (repairs) => {
        // Preserve original I/O admission order: initial calls in parallel,
        // inferred additions sequentially after them, attached to the last account.
        for (const addition of plan.additions) {
          const account = repairs[plan.repairs.indexOf(addition.account)];
          account.calls.push({ ...addition.call, returned: await this.getReturnedOutcome(addition.call.operationId, addition.call.callId) });
        }
        return repairs;
      });
    }
    return clone(await this.repairCache);
  }
  getReturnedOutcome(operationId, callId) {
    return this.readQueue(async () => {
      const outcome = this.outcomes.get(`${operationId}\0${callId}`);
      try { return outcome?.record ? clone(outcome.record.payload.message) : outcome ? (await this.io.read(outcome.address)).payload.message : undefined; }
      catch (error) { throw this.poison(error); }
    });
  }
  prepareReconciliation() {
    return this.enqueue(async () => {
      try { await this.io?.prepareReconciliation?.(); this.durableSeq = this.seq; }
      catch (error) { throw this.poison(error); }
    });
  }
  sync() { return this.enqueue(async () => { try { await this.io?.sync(); this.durableSeq = this.seq; } catch (error) { throw this.poison(error); } }); }
  close() {
    this.closePromise ??= (async () => {
      await this.line;
      this.closed = true;
      try { if (this.failure) throw this.failure; } finally { await this.onClose?.(this); }
    })();
    return this.closePromise;
  }
}

async function initializeSession(session) {
  const turnId = `synthetic:initialize:${randomUUID()}`;
  await session.beginTurn(turnId, { cause: "initialize" });
  await session.write("owner_binding", { kind: "unbound" });
  await session.write("handle_binding", { handleId: session.metadata.id, baseRevision: null, model: null });
  await session.endTurn(turnId, "completed");
}

export class MemorySessionRepo {
  constructor() { this.sessions = new Map(); this.openSessions = new Map(); }
  /** @param {{id?: string, cwd?: string}} [options] */
  async create({ id = randomUUID(), cwd = process.cwd() } = {}) {
    if (this.sessions.has(id)) throw new Error("Harness session already exists");
    const metadata = { id, cwd, createdAt: Date.now(), journalId: randomUUID() };
    const data = { metadata, records: [] };
    this.sessions.set(id, data);
    const session = await this.open(metadata);
    await initializeSession(session);
    return session;
  }
  async open(metadata, { repair = true } = {}) {
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is already open");
    const data = this.sessions.get(metadata.id);
    if (!data) throw new Error("Harness session not found");
    const session = new SessionStore(data.metadata, data.records, null, (store) => {
      data.records = clone(store.records); this.openSessions.delete(metadata.id);
    });
    this.openSessions.set(metadata.id, session);
    try { if (repair) await repairInterruptedSession(session); return session; }
    catch (error) { await session.close().catch(() => {}); throw error; }
  }
  async list() { return [...this.sessions.values()].map((s) => clone(s.metadata)); }
  async delete(metadata) {
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    this.sessions.delete(metadata.id);
  }
  async close() { for (const session of this.openSessions.values()) await session.close(); }
}

async function syncPath(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function absent(path) { try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } }
export class JsonlSessionRepo {
  constructor({ sessionsRoot, onImportPhase = async (_phase) => {}, onRootPermissionsTightened = () => {} }) {
    this.root = resolve(sessionsRoot);
    this.directory = join(this.root, "mono-v2", "journals");
    this.openSessions = new Map();
    this.locksPromise = null;
    this.directoryIdentity = null; this.warm = null;
    this.retiredHandles = new Set();
    this.onImportPhase = onImportPhase;
    this.onRootPermissionsTightened = onRootPermissionsTightened;
  }
  async ensureDirectory() {
    this.locksPromise ??= JournalLocks.open(this.root, this.onRootPermissionsTightened);
    const locks = await this.locksPromise;
    await locks.assertRoot();
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail();
    this.directoryIdentity ??= stat;
    if (!sameIdentity(stat, this.directoryIdentity)) fail();
    return locks;
  }
  async assertDirectory() {
    const locks = await this.locksPromise;
    await locks.assertRoot();
    const current = await lstat(this.directory);
    if (!current.isDirectory() || (current.mode & 0o077) !== 0 || !sameIdentity(current, this.directoryIdentity)) fail();
  }
  checkMetadata(metadata) {
    if (!safeId(metadata.id) || !/^[A-Za-z0-9_-]+$/.test(metadata.journalId)
      || dirname(resolve(metadata.path)) !== this.directory
      || ![`${metadata.journalId}.jsonl`, `${metadata.journalId}.jsonl.importing`, `${metadata.journalId}.jsonl.creating`].includes(metadata.path.split(/[\\/]/).at(-1))) fail();
  }
  /** @param {{id?: string, cwd?: string, staging?: boolean}} [options] */
  async create({ id = randomUUID(), cwd = process.cwd(), staging = false } = {}) {
    if (!safeId(id)) throw new TypeError("Unsafe harness session id");
    if (this.retiredHandles.has(id)) throw new Error("Harness session handle is retired");
    const locks = await this.ensureDirectory();
    const metadata = { id, cwd, createdAt: Date.now(), journalId: randomUUID(), path: "" };
    metadata.path = join(this.directory, `${metadata.journalId}.jsonl${staging ? ".importing" : ""}`);
    const writer = await locks.acquireWriter(metadata.journalId);
    let published = false;
    try {
      await locks.withCatalog(async () => {
        await this.assertDirectory();
        if (this.openSessions.has(id) || (await this.listOwnedUnlocked(true)).some((m) => m.id === id)) throw new Error("Harness session already exists");
        if (this.retiredHandles.has(id)) throw new Error("Harness session handle is retired");
        await this.writeImportHeader({ format: FORMAT, version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id }, ...metadata }, true);
        published = true;
      });
      const session = await this.openLocked(metadata, writer);
      await initializeSession(session);
      return session;
    } catch (error) {
      // A failed create may have left valid bytes; never unlink without ownership.
      const local = this.openSessions.get(id);
      if (local) await local.close().catch(() => {});
      try {
        if (!published) await locks.releaseWriter(writer, () => this.journalDataGone(metadata));
      } finally { writer.release(); }
      throw error;
    }
  }
  async open(metadata, { repair = true, wait = repair } = {}) {
    if (metadata.legacy) {
      if (!repair) throw new Error("Legacy sources cannot be inspected as bound native turns");
      return this.importLegacy(metadata);
    }
    this.checkMetadata(metadata);
    if (metadata.path !== join(this.directory, `${metadata.journalId}.jsonl`)) fail();
    if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
    if (this.openSessions.has(metadata.id)) throw Object.assign(new Error("Harness session is already open"), { code: "ERR_HARNESS_WRITER_BUSY" });
    const locks = await this.ensureDirectory();
    const writer = await locks.acquireWriter(metadata.journalId, { wait });
    let session;
    try {
      if (this.openSessions.has(metadata.id)) throw Object.assign(new Error("Harness session is already open"), { code: "ERR_HARNESS_WRITER_BUSY" });
      session = await this.openLocked(metadata, writer, { repair });
      try { if (repair) { await this.reconcileImport(session); await repairInterruptedSession(session); } return session; }
      catch (error) { await session.close().catch(() => {}); throw error; }
    } catch (error) {
      try { if (!session?.closed) await locks.releaseWriter(writer, () => this.journalDataGone(metadata)); } finally { writer.release(); }
      throw error;
    }
  }
  async syncDirectories() {
    await this.assertDirectory();
    await syncPath(this.directory); await syncPath(join(this.root, "mono-v2")); await syncPath(this.root);
    await this.assertDirectory();
  }
  async openLocked(metadata, writer, { repair = true } = {}) {
    if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
    const locks = await this.locksPromise;
    await this.assertDirectory();
    const reader = await JournalReader.open(metadata.path, this.root);
    let handle;
    try {
      handle = await open(metadata.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      const identity = await handle.stat();
      if (!sameIdentity(identity, reader.identity)) fail();
      let expectedSize = identity.size, expectedStat = identity, pendingTornTail = null;
      const unchanged = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
      const warm = this.warm?.metadata.id === metadata.id && this.warm.metadata.journalId === metadata.journalId
        && this.warm.metadata.path === metadata.path && unchanged(this.warm.identity, identity) ? this.warm : null;
      if (!warm) this.warm = null;
      else { reader.cache = warm.cache; reader.cacheBytes = warm.cacheBytes; }
      const verify = async () => {
        reader.path = storeMetadata.path; const stat = await reader.assertIdentity();
        if (!unchanged(stat, expectedStat) || stat.size !== expectedSize) { reader.clearCache(); this.warm = null; fail(); }
      };
      const storeMetadata = { ...metadata };
      const session = new SessionStore(storeMetadata, [], {
        read: async (address) => { await verify(); return reader.read(address); },
        cached: (address) => reader.cached(address), remember: (address, record) => { if (address) reader.remember(address, record); },
        invalidate: () => { reader.clearCache(); this.warm = null; }, verify,
        relocated: async () => {
          reader.path = storeMetadata.path; const stat = await reader.assertIdentity();
          if (!sameIdentity(stat, expectedStat) || stat.size !== expectedSize || stat.mtimeMs !== expectedStat.mtimeMs) fail();
          expectedStat = stat; reader.cacheVersion = stat;
        },
        prepareReconciliation: async () => {
          await verify();
          if (pendingTornTail !== null) {
            await handle.truncate(pendingTornTail); expectedSize = pendingTornTail; expectedStat = await handle.stat();
            pendingTornTail = null; reader.clearCache(); this.warm = null;
          }
          await handle.sync();
        },
        append: async (text) => {
          if (pendingTornTail !== null) throw new Error("Native torn tail requires matched reconciliation before mutation");
          reader.path = storeMetadata.path;
          await this.assertDirectory(); await reader.assertIdentity();
          const stat = await handle.stat(); if (!unchanged(stat, expectedStat) || stat.size !== expectedSize) fail();
          const bytes = Buffer.from(text); const address = { offset: expectedSize, length: bytes.length - 1 };
          let written = 0;
          while (written < bytes.length) {
            const result = await handle.write(bytes, written, bytes.length - written, null);
            if (!result.bytesWritten) throw new Error("Harness journal short write"); written += result.bytesWritten;
          }
          expectedSize += bytes.length; expectedStat = await handle.stat(); reader.cacheVersion = expectedStat;
          await this.assertDirectory(); await reader.assertIdentity();
          return address;
        },
        sync: async () => { await verify(); await handle.sync(); },
      }, async (store) => {
        if (pendingTornTail === null && !store.retired && !store.failure && store.entries.size <= 2048 && store.seq <= 8192 && storeMetadata.path.endsWith(".jsonl")) {
          try {
            await verify(); const closedIdentity = await handle.stat();
            if (!unchanged(closedIdentity, expectedStat)) fail();
            this.warm = { metadata: clone(storeMetadata), identity: closedIdentity,
              state: store.snapshot(), cache: reader.cache, cacheBytes: reader.cacheBytes };
          }
          catch { this.warm = null; }
        } else this.warm = null;
        this.openSessions.delete(metadata.id);
        this.retiredHandles.delete(metadata.id);
        try { await reader.close(); } finally {
          try { await handle.close(); } finally {
            try { await locks.releaseWriter(writer, store.retired ? () => this.journalDataGone(storeMetadata) : undefined); }
            finally { writer.release(); }
          }
        }
      });
      if (warm) {
        session.restore(warm.state); Object.assign(storeMetadata, warm.metadata, { path: metadata.path });
        await verify();
      } else {
        /** @type {any} */ let header;
        const evidence = await reader.scan((record, address) => {
          if (!header) { validateJournalHeader(record); header = record; }
          else session.apply(record, address);
        });
        if (!header || header.id !== metadata.id || header.journalId !== metadata.journalId) fail();
        Object.assign(storeMetadata, header, { path: metadata.path });
        if (evidence.torn) {
          await reader.assertIdentity(); const current = await handle.stat();
          if (!sameIdentity(current, evidence.identity) || current.size !== evidence.identity.size) fail();
          if (repair) { await handle.truncate(evidence.completeBytes); expectedSize = evidence.completeBytes; expectedStat = await handle.stat(); }
          else pendingTornTail = evidence.completeBytes;
        }
      }
      if (repair && (!warm || session.durableSeq !== session.seq)) { await handle.sync(); session.durableSeq = session.seq; }
      this.openSessions.set(metadata.id, session);
      return session;
    } catch (error) { await reader.close(); await handle?.close(); throw error; }
  }
  async writeImportHeader(metadata, catalogOwned = false) {
    const locks = await this.locksPromise;
    const creating = join(this.directory, `${metadata.journalId}.jsonl.creating`);
    const publish = async () => {
      await this.assertDirectory();
      const handle = await open(creating, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let identity;
      try {
        identity = await handle.stat();
        await this.onImportPhase("stage_created");
        await handle.writeFile(`${JSON.stringify({ ...metadata, path: undefined })}\n`);
        await this.onImportPhase("stage_written");
        await handle.sync(); await this.onImportPhase("stage_synced");
      } catch (error) {
        // This unpublished inode is ours (O_EXCL + writer + catalogue). Do not
        // leave a torn header after an ordinary write/sync failure.
        if (identity && !await absent(creating) && sameIdentity(identity, await lstat(creating))) { await unlink(creating); await this.syncDirectories(); }
        throw error;
      } finally { await handle.close(); }
      await rename(creating, metadata.path); await this.syncDirectories();
      await this.onImportPhase("stage_ready");
    };
    return catalogOwned ? publish() : locks.withCatalog(publish);
  }
  async importSealed(session) {
    const info = session.metadata.import;
    const turnId = `synthetic:legacy-import:${info.importId}`;
    const turn = session.validator.turns.get(turnId);
    if (!turn?.end || turn.end.payload.status !== "completed") return false;
    const messages = [];
    for (const entry of session.entries.values()) {
      if (entry.seq > turn.start.seq && entry.seq < turn.end.seq) {
        if (entry.type !== "message") fail();
        messages.push((await session.materialize(entry)).message);
      }
    }
    if (messages.length !== info.messageCount
      || createHash("sha256").update(JSON.stringify(messages)).digest("hex") !== info.contextHash) fail();
    return true;
  }
  async reconcileImport(session, publicationSynced = false) {
    const info = session.metadata.import;
    if (!info) return;
    if (legacyJournalId(importSourceMetadata(info, this.root), this.root) !== session.metadata.journalId
      || createHash("sha256").update(JSON.stringify(info.source)).digest("hex") !== info.importId) fail();
    if (!await this.importSealed(session)) fail();
    if (!publicationSynced) await session.sync();
    if (info.mode === "clean_break") {
      if (session.entries.size === 0) session.continuity = "clean_break";
    }
    const archiveTurnId = `synthetic:legacy-archived:${info.importId}`;
    const archiveTurn = session.validator.turns.get(archiveTurnId);
    const archived = archiveTurn?.end?.payload.status === "completed";
    const publicationTurnId = `synthetic:legacy-published:${info.importId}`;
    const publicationTurn = session.validator.turns.get(publicationTurnId);
    const publicationComplete = archived || publicationTurn?.end?.payload.status === "completed";
    // Recovery of an incompletely sealed rename must establish directory
    // durability once. Completed import/publication markers make reopen append-only.
    if (!publicationSynced && !publicationComplete) await this.syncDirectories();
    const locks = await this.locksPromise;
    await locks.withCatalog(async () => {
      await this.assertDirectory();
      for (const path of this.journalPaths(session.metadata).filter((p) => p !== session.metadata.path)) {
        if (await absent(path)) continue;
        const reader = await JournalReader.open(path, this.root);
        try {
          const header = await reader.readHeader(); validateJournalHeader(header);
          if (header.id !== session.metadata.id || header.journalId !== session.metadata.journalId || header.import?.importId !== info.importId) fail();
          const view = new SessionStore(header, [], { read: (address) => reader.read(address) });
          let first = true;
          await reader.scan((record, address) => { if (first) first = false; else view.apply(record, address); });
          await reader.assertIdentity(); await unlink(path); await this.syncDirectories();
        } finally { await reader.close(); }
      }
      if (info.mode === "import" && !archived) await archiveLegacySession(importSourceMetadata(info, this.root), this.root, { identity: info.source.identity }, this.onImportPhase);
      await this.assertDirectory();
    });
    const completionId = info.mode === "import" ? archiveTurnId : publicationTurnId;
    const completion = info.mode === "import" ? archiveTurn : publicationTurn;
    if ((info.mode === "import" && !archived) || (info.mode === "clean_break" && !publicationComplete)) {
      // Import and ordinary reopen use the same final-operation/suspension selection.
      await repairInterruptedSession(session, "crashed", [completionId]);
      if (!completion) await session.beginTurn(completionId, { cause: info.mode === "import" ? "legacy_archive" : "legacy_publication", importId: info.importId });
      await session.endTurn(completionId, "completed"); await session.sync();
    }
  }
  async importLegacy(metadata) {
    const projected = await readLegacySession(metadata, this.root);
    const info = importDescriptor(metadata, this.root, projected);
    const locks = await this.ensureDirectory();
    const journalId = legacyJournalId(metadata, this.root);
    const stage = { format: FORMAT, version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" },
      initialHandle: { id: metadata.id }, id: metadata.id, cwd: metadata.cwd, createdAt: Date.now(), journalId,
      path: join(this.directory, `${journalId}.jsonl.importing`), import: info };
    validateJournalHeader(stage);
    const publishedPath = join(this.directory, `${journalId}.jsonl`);
    const creatingPath = join(this.directory, `${journalId}.jsonl.creating`);
    const writer = await locks.acquireWriter(journalId);
    let session;
    try {
      await locks.withCatalog(async () => {
        await this.assertDirectory();
        const owned = await this.listOwnedUnlocked(true);
        const legacy = await listLegacySessions(this.root);
        const sources = legacy.filter((m) => m.id === metadata.id);
        if (owned.some((m) => m.id === metadata.id && m.journalId !== journalId)
          || sources.length > 1 || sources.some((m) => m.path !== metadata.path)) fail();
        if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
        if (await absent(publishedPath)) {
          if (sources.length !== 1) fail();
          await assertLegacyIdentity(metadata.path, this.root, info.source.identity);
        }
      });
      if (!await absent(publishedPath)) {
        session = await this.openLocked({ ...stage, path: publishedPath }, writer);
        if (session.metadata.import?.importId !== info.importId) fail();
        await this.reconcileImport(session); session.continuity = info.mode; return session;
      }
      if (!await absent(creatingPath)) {
        await locks.withCatalog(async () => {
          const reader = await JournalReader.open(creatingPath, this.root);
          try {
            const header = await reader.readHeader({ allowIncomplete: true });
            if (!header) {
              await assertLegacyIdentity(metadata.path, this.root, info.source.identity);
              await reader.assertIdentity(); await unlink(creatingPath); await this.syncDirectories(); return;
            }
            validateJournalHeader(header);
            if (header.journalId !== journalId || header.import?.importId !== info.importId || !await absent(stage.path)) fail();
            await reader.assertIdentity(); await rename(creatingPath, stage.path); await this.syncDirectories();
          } finally { await reader.close(); }
        });
      }
      if (!await absent(stage.path)) {
        const reader = await JournalReader.open(stage.path, this.root);
        let view;
        try {
          const header = await reader.readHeader(); validateJournalHeader(header);
          if (header.journalId !== journalId || header.id !== metadata.id || header.import?.importId !== info.importId) fail();
          view = new SessionStore(header, [], { read: (address) => reader.read(address) });
          let first = true;
          await reader.scan((record, address) => { if (first) first = false; else view.apply(record, address); });
          if (!await this.importSealed(view)) {
            // Only unpublished, validated source-bound staging may be rebuilt.
            await locks.withCatalog(async () => {
              await assertLegacyIdentity(metadata.path, this.root, info.source.identity);
              await reader.assertIdentity(); await unlink(stage.path); await this.syncDirectories();
            });
          }
        } finally { await reader.close(); }
      }
      const freshStage = await absent(stage.path);
      if (freshStage) await this.writeImportHeader(stage);
      session = await this.openLocked(stage, writer);
      if (freshStage) {
        await initializeSession(session);
        const turnId = `synthetic:legacy-import:${info.importId}`;
        await session.beginTurn(turnId, { cause: "legacy_import", importId: info.importId });
        for (const message of projected.messages ?? []) {
          await session.appendMessage(message); await this.onImportPhase("message_written");
        }
        await session.endTurn(turnId, "completed");
      }
      if (!await this.importSealed(session)) fail();
      await session.sync(); await this.onImportPhase("context_synced");
      await locks.withCatalog(async () => {
        await assertLegacyIdentity(metadata.path, this.root, info.source.identity);
        await this.assertDirectory();
        if (!await absent(publishedPath)) fail();
        await rename(session.metadata.path, publishedPath); session.metadata.path = publishedPath;
        await this.onImportPhase("published");
      });
      await session.io.relocated(); await session.sync(); await this.syncDirectories(); await this.onImportPhase("publication_synced");
      await this.reconcileImport(session, true); session.continuity = info.mode;
      return session;
    } catch (error) {
      // Publication is irreversible here: archival/fsync failure must never
      // remove valid published context. Restart reconciles it under ownership.
      await session?.close().catch(() => {});
      throw error;
    } finally {
      if (!session) {
        try { await locks.releaseWriter(writer, () => this.journalDataGone(stage)); }
        finally { writer.release(); }
      } else if (session.closed) writer.release();
    }
  }
  async listOwned({ wait = true } = {}) {
    if (await absent(this.directory)) return [];
    const locks = await this.ensureDirectory();
    return locks.withCatalog(() => this.listOwnedUnlocked(), { wait });
  }
  async listOwnedUnlocked(includeStaging = false) {
    let files;
    try { files = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (this.directoryIdentity) await this.assertDirectory();
    const result = [];
    for (const file of files) {
      const creating = file.name.endsWith(".jsonl.creating");
      if (!file.name.endsWith(".jsonl") && !creating && !(includeStaging && file.name.endsWith(".jsonl.importing"))) continue;
      if (!file.isFile()) fail();
      const path = join(this.directory, file.name);
      const reader = await JournalReader.open(path, this.root);
      try {
        const header = await reader.readHeader({ allowIncomplete: file.name.endsWith(".jsonl.creating") });
        // Native create uses UUIDs; imports use deterministic SHA-256 IDs. An
        // incomplete import header must remain available to source-bound recovery.
        const journalId = file.name.slice(0, -".jsonl.creating".length);
        if (creating && (!header || !header.import) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(journalId)) {
          if (header) {
            validateJournalHeader(header); this.checkMetadata({ ...header, path });
            let count = 0; const scan = await reader.scan(() => { count += 1; });
            if (count !== 1 || scan.torn) fail(); // never discard context or future phase data
          }
          await this.#reclaimNativeCreation(reader, { journalId });
          continue; // a busy failed creator's unpublished header is not a live session
        }
        if (!header || (creating && !includeStaging)) continue;
        validateJournalHeader(header);
        const metadata = { ...header, path }; this.checkMetadata(metadata); result.push(metadata);
      } finally { await reader.close(); }
    }
    return result;
  }
  // Caller holds catalogue: every native creating->rename transaction holds it
  // too. Try the writer, never wait under catalogue or reclaim a live owner.
  async #reclaimNativeCreation(reader, metadata) {
    const locks = await this.locksPromise;
    const lockPath = join(locks.directory, `${metadata.journalId}.sqlite`);
    await locks.ensureFile(lockPath);
    const writer = await locks.tryLock(lockPath);
    if (!writer) return;
    try {
      await reader.assertIdentity(); await unlink(reader.path); await this.syncDirectories();
      if (!await this.journalDataGone(metadata)) return;
      await locks.assertRoot();
      if (!sameIdentity(await lstat(writer.path), writer.identity)) fail();
      writer.release(); await unlink(writer.path); await locks.syncDirectory();
    } finally { writer.release(); }
  }
  async list() {
    const owned = await this.listOwned();
    const legacy = await listLegacySessions(this.root);
    return [...owned, ...legacy.filter((m) => !owned.some((n) => n.id === m.id))];
  }
  journalPaths(metadata) {
    return [join(this.directory, `${metadata.journalId}.jsonl`), join(this.directory, `${metadata.journalId}.jsonl.importing`), join(this.directory, `${metadata.journalId}.jsonl.creating`)];
  }
  async journalDataGone(metadata) {
    await this.assertDirectory();
    const files = await readdir(this.directory);
    if (files.some((name) => name.startsWith(`${metadata.journalId}.`))) return false;
    // P1a emits no aliases. Adding projections must extend this same predicate
    // and removal transaction; unknown future aliases conservatively pin locks.
    const aliases = join(this.root, "mono-v2", "aliases");
    if (!await absent(aliases)) {
      const stat = await lstat(aliases); if (!stat.isDirectory()) fail();
      if ((await readdir(aliases)).length) return false;
    }
    return true;
  }
  async removeOwned(metadata) {
    await this.assertDirectory();
    const paths = this.journalPaths(metadata);
    const files = await readdir(this.directory);
    if (files.some((name) => name.startsWith(`${metadata.journalId}.`) && !paths.some((path) => path.endsWith(`/${name}`)))) fail();
    const aliases = join(this.root, "mono-v2", "aliases");
    if (!await absent(aliases) && (!(await lstat(aliases)).isDirectory() || (await readdir(aliases)).length)) fail();
    // Validate all matching evidence before removing either publication phase.
    const readers = [], archives = [];
    try {
      for (const path of paths) {
        if (await absent(path)) continue;
        const reader = await JournalReader.open(path, this.root); readers.push(reader);
        const header = await reader.readHeader(); validateJournalHeader(header);
        if (header.journalId !== metadata.journalId || header.id !== metadata.id) fail();
        if (header.import) {
          const source = importSourceMetadata(header.import, this.root);
          archives.push({ ...source, path: `${source.path}.migrated` });
        }
      }
      for (const archive of archives) await this.removeLegacy(archive);
      for (const reader of readers) { await reader.assertIdentity(); await unlink(reader.path); }
    } finally { for (const reader of readers) await reader.close(); }
    await this.syncDirectories();
  }
  async removeLegacy(metadata) {
    const path = resolve(metadata.path), parent = dirname(path);
    if (dirname(parent) !== this.root || parent === join(this.root, "mono-v2")) fail();
    await this.assertDirectory();
    if (await absent(path)) return;
    const reader = await JournalReader.open(path, this.root, { ownerOnly: false });
    try {
      const header = await reader.readHeader();
      if (header.id !== metadata.id || !((header.type === "session" && header.version === 3)
        || (header.kind === "header" && header.v === 4 && header.storageVersion === 1))) fail();
      await reader.assertIdentity(); await unlink(path);
    } finally { await reader.close(); }
    await syncPath(parent); await syncPath(this.root); await this.assertDirectory();
  }
  async retireByHandle(id) {
    if (!safeId(id)) throw new TypeError("Unsafe harness session id");
    this.retireHandle(id);
    try {
      if (await absent(this.root)) return;
      const locks = await this.ensureDirectory();
      const matches = await locks.withCatalog(async () => {
        const owned = await this.listOwnedUnlocked(true);
        const legacy = await listLegacySessions(this.root, { includeArchives: true });
        // A headerless/corrupt legacy exact-name candidate is uncertainty, not
        // authority to unlink it outside ownership or acknowledge complete loss.
        for (const dir of await readdir(this.root, { withFileTypes: true })) {
          if (dir.name === "mono-v2") continue;
          if (dir.isSymbolicLink()) fail();
          if (!dir.isDirectory()) continue;
          for (const file of await readdir(join(this.root, dir.name), { withFileTypes: true })) {
            if (!file.name.endsWith(`_${id}.jsonl`) && !file.name.endsWith(`_${id}.jsonl.migrated`)) continue;
            if (!file.isFile() || !legacy.some((m) => m.path === join(this.root, dir.name, file.name) && m.id === id)) fail();
          }
        }
        return [...owned, ...legacy].filter((m) => m.id === id);
      });
      const local = this.openSessions.get(id);
      if (local && !matches.some((m) => m.journalId === local.metadata.journalId)) matches.push(local.metadata);
      for (const metadata of matches) await this.retire(metadata);
      const remaining = await locks.withCatalog(() => this.listOwnedUnlocked(true));
      if (remaining.some((m) => m.id === id)) fail();
    } finally { this.finishRetirement(id); }
  }
  clearWarm(id) { if (this.warm?.metadata.id === id) { this.warm.cache.clear(); this.warm = null; } }
  retireHandle(id) { this.retiredHandles.add(id); this.clearWarm(id); }
  finishRetirement(id) { if (!this.openSessions.has(id)) this.retiredHandles.delete(id); }
  async retire(metadata) {
    this.retireHandle(metadata.id);
    if (metadata.legacy) { try { return await this.delete(metadata); } finally { this.finishRetirement(metadata.id); } }
    this.checkMetadata(metadata);
    const store = this.openSessions.get(metadata.id);
    if (!store) { try { return await this.delete(metadata); } finally { this.finishRetirement(metadata.id); } }
    if (this.warm?.metadata.id === store.metadata.id) this.warm = null;
    store.io?.invalidate?.();
    store.retired = true; // reject new admission before draining prior storage I/O
    await store.line;
    const locks = await this.locksPromise;
    await locks.withCatalog(() => this.removeOwned(metadata));
    // Keep its already-held writer lock until the provider's close/unwind.
  }
  async delete(metadata) {
    this.clearWarm(metadata.id);
    const locks = await this.ensureDirectory();
    if (metadata.legacy) {
      await locks.withCatalog(() => this.removeLegacy(metadata)); return;
    }
    this.checkMetadata(metadata);
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    const writer = await locks.acquireWriter(metadata.journalId);
    try { await locks.withCatalog(() => this.removeOwned(metadata)); }
    finally {
      try { await locks.releaseWriter(writer, () => this.journalDataGone(metadata)); } finally { writer.release(); }
    }
  }
  async sync(metadata) {
    const local = this.openSessions.get(metadata.id);
    if (local) return local.sync();
    const session = await this.open(metadata);
    try { await session.sync(); } finally { await session.close(); }
  }
  async close() { for (const session of this.openSessions.values()) await session.close(); }
}
