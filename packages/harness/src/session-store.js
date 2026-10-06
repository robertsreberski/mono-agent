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
import { canonicalHostJournalAuthority, validateHeaderUpgradeOptions, sameHostJournalAuthority } from "./header-authority.js";
import { modelChangeRecords, guardedEpochPlan } from "./managed-journal.js";
import { publishGuardedHeader, assertGuardedHeaderCopy } from "./header-upgrade.js";
const sessionAuthorities = new WeakMap();
const enabledVersion3Sessions = new WeakSet();
function acceptHeader(session, header) {
  validateJournalHeader(header);
  if (header.ownershipSchemaVersion === 2) sessionAuthorities.set(session, clone(header.hostAuthority));
}
function deletionOptions(contextOrOptions, explicitOptions) {
  const context = contextOrOptions != null && "abortSignal" in Object(contextOrOptions);
  const authority = contextOrOptions != null && ["disposition", "hostAuthority", "assertOwned"].some((key) => key in Object(contextOrOptions));
  if (context && authority || explicitOptions !== undefined && authority) throw new TypeError("Ambiguous native deletion context/authority");
  return explicitOptions !== undefined ? explicitOptions : context ? undefined : contextOrOptions;
}
function validateDeletionDisposition(options) {
  if (options != null && "disposition" in Object(options) && !["C", "D"].includes(options.disposition)) {
    throw new TypeError("Native deletion requires a C/D disposition when provided");
  }
}
async function authorizeGuardedDeletion(header, options) {
  validateDeletionDisposition(options);
  if (header.ownershipSchemaVersion !== 2) return;
  validateHeaderUpgradeOptions(options);
  if (!["C", "D"].includes(options.disposition) || !sameHostJournalAuthority(header.hostAuthority, options.hostAuthority)) {
    throw new TypeError("Guarded native deletion requires an authorized C/D disposition");
  }
  // Host assertion must also prove reference eligibility (C), or membership in
  // its restartable whole-chain reset/retention transaction (D).
  await options.assertOwned();
}
function checkRecordAuthority(session, record) {
  const authority = sessionAuthorities.get(session);
  if (!authority) return;
  const owner = record?.kind === "owner_binding" ? record.payload : record?.payload?.binding;
  if (owner && owner.kind !== "unbound"
    && (owner.kind !== "host" || owner.ownerKey !== authority.ownerKey || owner.historyBucket !== authority.historyBucket)) corruptBinding();
}
const clone = (v) => structuredClone(v);
const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, ordered(v[key])])) : v;
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
    /** @type {string|undefined} */ this.continuity = undefined;
    this.entries = new Map();
    this.modelChanges = new Map();
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
    if (!io?.read && metadata.ownershipSchemaVersion === 2) acceptHeader(this, metadata);
    for (const record of records) this.apply(record);
  }
  validateRecord(record) {
    checkRecordAuthority(this, record);
    if (record.kind === "model_change" && record.schemaVersion === 3 && this.modelChanges.has(record.payload?.switchId)) corruptBinding();
    if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== this.metadata.id) corruptBinding();
    this.validator.validate(record);
  }
  apply(record, address) {
    checkRecordAuthority(this, record);
    if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== this.metadata.id) corruptBinding();
    this.validator.apply(record);
    if (record.kind === "model_change" && record.schemaVersion === 3) {
      if (this.modelChanges.has(record.payload.switchId)) corruptBinding();
      this.modelChanges.set(record.payload.switchId, clone(record));
    }
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
  /** @param {any} kind @param {any} payload @param {{turnId?: string, operationId?: string, id?: string, schemaVersion?: 2|3, timestamp?:number}} [identity] */
  write(kind, payload, identity = {}) {
    return this.enqueue(() => this.writeRecord(kind, payload, identity));
  }
  /** @param {any} kind @param {any} payload @param {{turnId?: string, operationId?: string, id?: string, schemaVersion?: 2|3, timestamp?:number}} [identity] */
  async writeRecord(kind, payload, { turnId = this.activeTurnId(), operationId, id = randomUUID(), schemaVersion = 2, timestamp = Date.now() } = {}) {
      if (schemaVersion === 3) this.assertVersion3WritesEnabled();
      const record = { schemaVersion, id, parentId: this.validator.parentId,
        seq: this.seq + 1, timestamp, turnId, kind,
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
  /** Only a validated upgraded header authorizes v3, never caller metadata alone.
   * The host must also stop older binaries and hold its upgraded-root authority.
   * @param {{exclusiveWriters:true, hostAuthority:import('./header-authority.js').HostJournalAuthority}} options
   */
  enableVersion3Writes(options) {
    if (options?.exclusiveWriters !== true) throw new TypeError("Version-3 writes require exclusive upgraded writers");
    const authority = sessionAuthorities.get(this);
    if (!authority || !sameHostJournalAuthority(authority, options.hostAuthority)) throw new TypeError("Version-3 writes require a matching upgraded native header authority");
    enabledVersion3Sessions.add(this);
  }
  assertVersion3WritesEnabled() {
    if (!enabledVersion3Sessions.has(this) || !sessionAuthorities.has(this)) throw new TypeError("Version-3 writes require enableVersion3Writes with exclusive upgraded writers and an upgraded native header authority");
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
  static modelChangeRecords(options, source) { return modelChangeRecords(options, source); }
  /** Ready-only host reference. Deterministic synthetic framing can resume after
   * any partial append; a foreign/open operation is never repaired or closed.
   * @param {any} options */
  async appendModelChangeReference(options) {
    this.assertVersion3WritesEnabled();
    return this.enqueue(async () => {
      const prior = this.modelChanges.get(options.switchId);
      const expectedTurn = `synthetic:model-change:${createHash("sha256").update(options.switchId).digest("hex")}`;
      const start = this.validator.turns.get(prior?.turnId ?? expectedTurn)?.start;
      const source = start ? { seq: start.seq - 1, parentId: start.parentId, tip: start.payload.baselineTipId }
        : { seq: this.seq, parentId: this.validator.parentId, tip: this.tip };
      const records = modelChangeRecords({ ...options, timestamp: start?.timestamp ?? options.timestamp ?? Date.now() }, source);
      if (prior && JSON.stringify(ordered(prior.payload)) !== JSON.stringify(ordered(records[1].payload))) throw new Error("Native model-change identity conflicts with existing evidence");
      if (prior && !this.validator.openTurns.has(prior.turnId)) { await this.io?.sync(); this.durableSeq = this.seq; return clone(prior); }
      if (this.validator.openOperations.size || this.validator.openTurns.size && (!start
        || this.validator.openTurns.size !== 1 || !this.validator.openTurns.has(expectedTurn)
        || JSON.stringify(start) !== JSON.stringify(records[0])
        || this.seq !== source.seq + (prior ? 2 : 1)
        || this.validator.parentId !== records[prior ? 1 : 0].id)) throw new Error("Native model-change has foreign or changed open evidence");
      const remaining = records.slice(start ? prior ? 2 : 1 : 0);
      const validator = Object.assign(new JournalValidator(), structuredClone(this.validator));
      for (const record of remaining) validator.apply(record);
      // Recheck this exact remaining frame while holding the native writer;
      // the earlier bridge snapshot cannot authorize truncating changed bytes.
      const expectedTail = Buffer.from(remaining.map((record) => JSON.stringify(record)).join("\n") + "\n");
      await this.io?.prepareReconciliation(expectedTail);
      for (const record of remaining) {
        await this.writeRecord(record.kind, record.payload, { id: record.id, turnId: record.turnId,
          schemaVersion: record.schemaVersion, timestamp: record.timestamp });
        await options.onPhase?.(({ turn_start: "model_change_started", model_change: "model_change_appended", turn_end: "model_change_ended" })[record.kind]);
      }
      await this.io?.sync(); this.durableSeq = this.seq; await options.onPhase?.("model_change_synced");
      return clone(this.modelChanges.get(options.switchId));
    });
  }
  async moveTo(tipId) { await this.scopedWrite(() => this.writeRecord("rewind", { tipId }), "rollback"); return tipId; }
  async verifyRead() { try { await this.io?.verify?.(); } catch (error) { throw this.poison(error); } }
  snapshot() {
    return clone({ validator: this.validator, entries: this.entries, outcomes: this.outcomes,
      interruptions: this.interruptions, interruptedOperations: this.interruptedOperations, modelChanges: this.modelChanges,
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
  #headers = new Map();
  constructor() { this.sessions = new Map(); this.openSessions = new Map(); }
  /** @param {{id?: string, cwd?: string, hostAuthority?:import('./header-authority.js').HostJournalAuthority, assertOwned?:()=>Promise<void>}} [options] */
  async create({ id = randomUUID(), cwd = process.cwd(), hostAuthority, assertOwned } = {}) {
    if (hostAuthority !== undefined) { validateHeaderUpgradeOptions({ hostAuthority, assertOwned }); await assertOwned(); }
    if (this.sessions.has(id)) throw new Error("Harness session already exists");
    const metadata = { id, cwd, createdAt: Date.now(), journalId: randomUUID(), ...(hostAuthority ? {
      format: FORMAT, version: 2, ownershipSchemaVersion: 2, ownership: { kind: "unbound" }, initialHandle: { id }, hostAuthority: canonicalHostJournalAuthority(hostAuthority),
    } : {}) };
    const header = { format: FORMAT, version: 2, ownershipSchemaVersion: 1,
      ownership: { kind: "unbound" }, initialHandle: { id }, ...clone(metadata) };
    validateJournalHeader(header); this.#headers.set(id, clone(header));
    const data = { metadata: clone(metadata), records: [] };
    this.sessions.set(id, data);
    const session = await this.open(metadata);
    await initializeSession(session);
    return session;
  }
  async open(metadata, { repair = true } = {}) {
    const id = metadata.id;
    if (this.openSessions.has(id)) throw new Error("Harness session is already open");
    const data = this.sessions.get(id);
    if (!data) throw new Error("Harness session not found");
    const header = this.#headers.get(id);
    validateJournalHeader(header);
    const session = new SessionStore(this.#publicMetadata(header), data.records, null, (store) => {
      data.records = clone(store.records); this.openSessions.delete(id);
    });
    this.openSessions.set(id, session);
    try { if (repair) await repairInterruptedSession(session); return session; }
    catch (error) { await session.close().catch(() => {}); throw error; }
  }
  #publicMetadata(header) {
    return header.ownershipSchemaVersion === 1
      ? { id: header.id, cwd: header.cwd, createdAt: header.createdAt, journalId: header.journalId }
      : clone(header);
  }
  async list() { return [...this.sessions.keys()].map((id) => this.#publicMetadata(this.#headers.get(id))); }
  /** @param {any} metadata @param {import('./header-authority.js').HostJournalDeletion|{abortSignal:AbortSignal}} [contextOrOptions] @param {import('./header-authority.js').HostJournalDeletion} [explicitOptions] */
  async delete(metadata, contextOrOptions = undefined, explicitOptions = undefined) {
    const options = deletionOptions(contextOrOptions, explicitOptions);
    validateDeletionDisposition(options);
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    const stored = this.sessions.get(metadata.id);
    if (stored) await authorizeGuardedDeletion(this.#headers.get(metadata.id), options);
    this.sessions.delete(metadata.id); this.#headers.delete(metadata.id);
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
  constructor({ sessionsRoot, onImportPhase = async (_phase) => {}, onHeaderUpgradePhase = async (_phase) => {}, onRootPermissionsTightened = () => {} }) {
    this.root = resolve(sessionsRoot);
    this.directory = join(this.root, "mono-v2", "journals");
    this.openSessions = new Map();
    this.locksPromise = null;
    this.directoryIdentity = null; this.warm = null;
    this.retiredHandles = new Set();
    this.onImportPhase = onImportPhase;
    this.onHeaderUpgradePhase = onHeaderUpgradePhase;
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
  /** @param {{id?: string, cwd?: string, staging?: boolean, hostAuthority?:import('./header-authority.js').HostJournalAuthority, assertOwned?:()=>Promise<void>}} [options] */
  async create({ id = randomUUID(), cwd = process.cwd(), staging = false, hostAuthority, assertOwned } = {}) {
    if (hostAuthority !== undefined) { validateHeaderUpgradeOptions({ hostAuthority, assertOwned }); await assertOwned(); }
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
        if (hostAuthority !== undefined) await assertOwned();
        await this.writeImportHeader({ format: FORMAT, version: 2, ownershipSchemaVersion: hostAuthority ? 2 : 1,
          ownership: { kind: "unbound" }, initialHandle: { id }, ...metadata, ...(hostAuthority ? { hostAuthority: canonicalHostJournalAuthority(hostAuthority) } : {}) }, true);
        if (hostAuthority !== undefined) await assertOwned();
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
  static guardedEpochPlan(options) { return guardedEpochPlan(options); }
  static assertGuardedHeaderCopy(source, copy, authority) { return assertGuardedHeaderCopy(source, copy, authority); }
  /** Atomic, idempotent host epoch initialization; ordinary create stays unchanged.
   * @param {any} options */
  async createGuardedEpoch(options) {
    validateHeaderUpgradeOptions(options); const plan = guardedEpochPlan(options);
    const metadata = { ...plan.header, path: join(this.directory, `${plan.header.journalId}.jsonl`) };
    await options.assertOwned(); const locks = await this.ensureDirectory();
    if (this.openSessions.has(options.id)) throw Object.assign(new Error("Harness session is already open"), { code: "ERR_HARNESS_WRITER_BUSY" });
    const writer = await locks.acquireWriter(metadata.journalId, { wait: false });
    try { return await locks.withCatalog(async () => {
      await options.assertOwned(); await this.assertDirectory();
      const validate = async (path, prefix) => {
        const reader = await JournalReader.open(path, this.root);
        try {
          const before = await reader.assertIdentity();
          if (before.nlink !== 1 || before.size > plan.bytes.length || !prefix && before.size !== plan.bytes.length) fail();
          const bytes = await reader.handle.readFile(); const after = await reader.assertIdentity();
          if (!sameIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
            || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size || !plan.bytes.subarray(0, bytes.length).equals(bytes)) fail();
          return after;
        } finally { await reader.close(); }
      };
      const stage = `${metadata.path}.creating`;
      const committed = !await absent(metadata.path);
      if (committed) { await validate(metadata.path, false); await syncPath(metadata.path); await this.syncDirectories(); }
      // Never overwrite/discard a foreign same-handle journal or unknown stage.
      if ((await this.listOwnedUnlocked()).some((entry) => entry.id === options.id && entry.journalId !== metadata.journalId)) fail();
      if (!await absent(stage)) {
        const identity = await validate(stage, true); await options.assertOwned();
        const named = await lstat(stage);
        if (!sameIdentity(identity, named) || identity.size !== named.size || identity.ctimeMs !== named.ctimeMs) fail();
        await unlink(stage); await this.syncDirectories(); await options.onPhase?.("epoch_stage_reclaimed");
      }
      if (!committed) {
        const handle = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await options.onPhase?.("epoch_stage_created"); await handle.writeFile(plan.bytes);
          await handle.sync(); await options.onPhase?.("epoch_stage_synced");
          const written = await handle.stat(); await options.assertOwned(); await this.assertDirectory();
          const named = await lstat(stage);
          if (written.nlink !== 1 || !sameIdentity(written, named) || written.size !== plan.bytes.length
            || written.ctimeMs !== named.ctimeMs) fail();
          await rename(stage, metadata.path); await options.onPhase?.("epoch_renamed");
          await this.syncDirectories(); await options.onPhase?.("epoch_directory_synced");
        } finally { await handle.close(); }
      }
      await options.assertOwned(); await this.assertDirectory(); return metadata;
    }); } finally { writer.release(); }
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
  /** Upgrade a closed, idle, host-authorized journal. No accounting/repair or
   * provider execution occurs here. The host holds its conversation claim until
   * this promise settles; native writer/catalogue ownership is acquired here.
   * @param {any} metadata
   * @param {{hostAuthority:import('./header-authority.js').HostJournalAuthority, assertOwned:()=>Promise<void>, onPhase?:(phase:string)=>Promise<void>}} options
   */
  async upgradeHeader(metadata, options) {
    validateHeaderUpgradeOptions(options); this.checkMetadata(metadata);
    if (metadata.path !== join(this.directory, `${metadata.journalId}.jsonl`)) fail();
    if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
    if (this.openSessions.has(metadata.id)) throw Object.assign(new Error("Harness session must be detached before upgrade"), { code: "ERR_HARNESS_WRITER_BUSY" });
    await options.assertOwned();
    const locks = await this.ensureDirectory();
    const writer = await locks.acquireWriter(metadata.journalId, { wait: false });
    try {
      return await locks.withCatalog(async () => {
        if (this.openSessions.has(metadata.id)) throw Object.assign(new Error("Harness session must be detached before upgrade"), { code: "ERR_HARNESS_WRITER_BUSY" });
        this.clearWarm(metadata.id);
        return await publishGuardedHeader(this, metadata, options);
      });
    } finally { writer.release(); }
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
      let validatedHeader;
      const session = new SessionStore(storeMetadata, [], {
        read: async (address) => { await verify(); return reader.read(address); },
        cached: (address) => reader.cached(address), remember: (address, record) => { if (address) reader.remember(address, record); },
        invalidate: () => { reader.clearCache(); this.warm = null; }, verify,
        relocated: async () => {
          reader.path = storeMetadata.path; const stat = await reader.assertIdentity();
          if (!sameIdentity(stat, expectedStat) || stat.size !== expectedSize || stat.mtimeMs !== expectedStat.mtimeMs) fail();
          expectedStat = stat; reader.cacheVersion = stat;
        },
        prepareReconciliation: async (/** @type {Buffer|undefined} */ expectedTail = undefined) => {
          await verify();
          if (pendingTornTail !== null) {
            if (expectedTail !== undefined) {
              const length = expectedSize - pendingTornTail;
              if (length > expectedTail.length) fail();
              const bytes = Buffer.alloc(length); let offset = 0;
              while (offset < length) { const result = await handle.read(bytes, offset, length - offset, pendingTornTail + offset); if (!result.bytesRead) fail(); offset += result.bytesRead; }
              if (!expectedTail.subarray(0, length).equals(bytes)) fail();
              await verify();
            }
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
            this.warm = { metadata: { ...clone(validatedHeader), path: storeMetadata.path }, identity: closedIdentity,
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
        validatedHeader = clone(warm.metadata);
        acceptHeader(session, validatedHeader);
        session.restore(warm.state); Object.assign(storeMetadata, warm.metadata, { path: metadata.path });
        await verify();
      } else {
        /** @type {any} */ let header;
        const evidence = await reader.scan((record, address) => {
          if (!header) { acceptHeader(session, record); header = record; validatedHeader = clone(record); }
          else session.apply(record, address);
        });
        if (!header || header.id !== metadata.id || header.journalId !== metadata.journalId) fail();
        Object.assign(storeMetadata, header, { path: metadata.path });
        if (evidence.torn) {
          await reader.assertIdentity(); const current = await handle.stat();
          if (!unchanged(current, evidence.identity)) fail();
          if (repair) { await handle.truncate(evidence.completeBytes); expectedSize = evidence.completeBytes; expectedStat = await handle.stat(); }
          else pendingTornTail = evidence.completeBytes;
        }
      }
      // Recover a guarded publication's directory barrier even when a prior
      // upgrader crashed after rename. No v3 writer can escape before this sync.
      // Ordinary schema-1 opens keep their exact original fsync path/counts.
      if (storeMetadata.ownershipSchemaVersion === 2) { await handle.sync(); await this.syncDirectories(); }
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
  /** @param {any} metadata @param {import('./header-authority.js').HostJournalDeletion} [options] */
  async removeOwned(metadata, options = undefined) {
    validateDeletionDisposition(options);
    await this.assertDirectory();
    const paths = [...this.journalPaths(metadata), join(this.directory, `${metadata.journalId}.jsonl.upgrading`)];
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
        if (path.endsWith(".upgrading")) continue;
        const header = await reader.readHeader(); validateJournalHeader(header);
        if (header.journalId !== metadata.journalId || header.id !== metadata.id) fail();
        if (header.import) {
          const source = importSourceMetadata(header.import, this.root);
          archives.push({ ...source, path: `${source.path}.migrated` });
        }
      }
      const source = readers.find((reader) => reader.path === metadata.path);
      for (const reader of readers) {
        const header = reader.path.endsWith(".upgrading")
          ? await assertGuardedHeaderCopy(source, reader, options?.hostAuthority) : await reader.readHeader();
        await authorizeGuardedDeletion(header, options);
        if (options?.disposition === "C") {
          await reader.scan((record) => { if (record.kind === "model_change") throw new Error("C cannot delete switched-away native evidence"); });
        }
      }
      readers.sort((a, b) => Number(b.path.endsWith(".upgrading")) - Number(a.path.endsWith(".upgrading")));
      for (const archive of archives) await this.removeLegacy(archive);
      for (const reader of readers) { await options?.assertOwned?.(); await reader.assertIdentity(); await unlink(reader.path); await options?.onPhase?.("native_file_removed"); }
    } finally { for (const reader of readers) await reader.close(); }
    await this.syncDirectories();
    await options?.onPhase?.("native_member_directory_synced");
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
  /** @param {string} id @param {import('./header-authority.js').HostJournalDeletion|{abortSignal:AbortSignal}} [contextOrOptions] @param {import('./header-authority.js').HostJournalDeletion} [explicitOptions] */
  async retireByHandle(id, contextOrOptions = undefined, explicitOptions = undefined) {
    const options = deletionOptions(contextOrOptions, explicitOptions);
    validateDeletionDisposition(options);
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
      for (const metadata of matches) await this.retire(metadata, options);
      const remaining = await locks.withCatalog(() => this.listOwnedUnlocked(true));
      if (remaining.some((m) => m.id === id)) fail();
    } finally {
      const local = this.openSessions.get(id);
      if (local && !local.retired) this.retiredHandles.delete(id);
      else this.finishRetirement(id);
    }
  }
  clearWarm(id) { if (this.warm?.metadata.id === id) { this.warm.cache.clear(); this.warm = null; } }
  retireHandle(id) { this.retiredHandles.add(id); this.clearWarm(id); }
  finishRetirement(id) { if (!this.openSessions.has(id)) this.retiredHandles.delete(id); }
  /** @param {any} metadata @param {import('./header-authority.js').HostJournalDeletion|{abortSignal:AbortSignal}} [contextOrOptions] @param {import('./header-authority.js').HostJournalDeletion} [explicitOptions] */
  async retire(metadata, contextOrOptions = undefined, explicitOptions = undefined) {
    const options = deletionOptions(contextOrOptions, explicitOptions);
    validateDeletionDisposition(options);
    const live = this.openSessions.get(metadata.id), authority = live && sessionAuthorities.get(live);
    if (authority) await authorizeGuardedDeletion({ ownershipSchemaVersion: 2, hostAuthority: authority }, options);
    this.retireHandle(metadata.id);
    if (metadata.legacy) { try { return await this.delete(metadata, options); } finally { this.finishRetirement(metadata.id); } }
    this.checkMetadata(metadata);
    const store = this.openSessions.get(metadata.id);
    if (!store) { try { return await this.delete(metadata, options); } finally { this.finishRetirement(metadata.id); } }
    if (this.warm?.metadata.id === store.metadata.id) this.warm = null;
    store.io?.invalidate?.();
    store.retired = true; // reject new admission before draining prior storage I/O
    await store.line;
    const locks = await this.locksPromise;
    await locks.withCatalog(() => this.removeOwned(metadata, options));
    // Keep its already-held writer lock until the provider's close/unwind.
  }
  /** @param {any} metadata @param {import('./header-authority.js').HostJournalDeletion|{abortSignal:AbortSignal}} [contextOrOptions] @param {import('./header-authority.js').HostJournalDeletion} [explicitOptions] */
  async delete(metadata, contextOrOptions = undefined, explicitOptions = undefined) {
    const options = deletionOptions(contextOrOptions, explicitOptions);
    validateDeletionDisposition(options);
    this.clearWarm(metadata.id);
    const locks = await this.ensureDirectory();
    if (metadata.legacy) {
      await locks.withCatalog(() => this.removeLegacy(metadata)); return;
    }
    this.checkMetadata(metadata);
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    const writer = await locks.acquireWriter(metadata.journalId, { wait: options?.hostAuthority === undefined });
    try { await locks.withCatalog(() => this.removeOwned(metadata, options)); }
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
