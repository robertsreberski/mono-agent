import type { HostJournalDeletion } from "./header-authority.js";
import type { JournalEntry } from "./journal-types.js";
import { assertSupportedSessionsRoot } from "./sessions-root.js";
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
import { isOwned, publishAtomic, sameIdentity, syncDir, unchanged } from "./owned-fs-impl.js";
import { archiveLegacySession, listLegacySessions, readLegacySession, legacyJournalId, importDescriptor, importSourceMetadata, assertLegacyIdentity } from "./legacy-import.js";

import { assertEvidenceView } from "./evidence-view.js";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { JOURNAL_FORMAT as FORMAT } from "./journal-types.js";
import { canonicalHostJournalAuthority, validateHeaderUpgradeOptions, sameHostJournalAuthority } from "./header-authority.js";
import { guardedEpochPlan, managedJournalId } from "./managed-journal.js";
const sessionAuthorities = new WeakMap();
function acceptHeader(session: any, header: any): void {
  validateJournalHeader(header);
  if (header.hostAuthority !== undefined) sessionAuthorities.set(session, clone(header.hostAuthority));
}
function deletionOptions(contextOrOptions: any, explicitOptions: any): any {
  const context = contextOrOptions != null && "abortSignal" in Object(contextOrOptions);
  const authority = contextOrOptions != null && ["disposition", "hostAuthority", "assertOwned"].some((key: string) => key in Object(contextOrOptions));
  if (context && authority || explicitOptions !== undefined && authority) throw new TypeError("Ambiguous native deletion context/authority");
  return explicitOptions !== undefined ? explicitOptions : context ? undefined : contextOrOptions;
}
/** Cancellation of a repository lock wait; never of a started mutation. */
const contextSignal = (contextOrOptions: any) => contextOrOptions != null && "abortSignal" in Object(contextOrOptions) ? contextOrOptions.abortSignal : undefined;
function validateDeletionDisposition(options: any): void {
  if (options != null && "disposition" in Object(options) && !["C", "D"].includes(options.disposition)) {
    throw new TypeError("Native deletion requires a C/D disposition when provided");
  }
}
async function authorizeGuardedDeletion(header: any, options: any): Promise<void> {
  validateDeletionDisposition(options);
  if (header.hostAuthority === undefined) return;
  validateHeaderUpgradeOptions(options);
  if (!["C", "D"].includes(options.disposition) || !sameHostJournalAuthority(header.hostAuthority, options.hostAuthority)) {
    throw new TypeError("Guarded native deletion requires an authorized C/D disposition");
  }
  // Host assertion must also prove reference eligibility (C), or membership in
  // its restartable reset/retention transaction (D).
  await options.assertOwned();
}
function checkRecordAuthority(session: any, record: any): void {
  const authority = sessionAuthorities.get(session);
  if (!authority) {
    if (record?.payload?.projectionBinding !== undefined
      || record?.payload?.compaction?.checkpoint?.inheritedCoverage !== undefined
      || record?.payload?.artifactRef !== undefined) corruptBinding();
    return;
  }
  const owner = record?.kind === "owner_binding" ? record.payload : record?.payload?.binding;
  if (owner && owner.kind !== "unbound"
    && (owner.kind !== "host" || owner.ownerKey !== authority.ownerKey || owner.historyBucket !== authority.historyBucket)) corruptBinding();
}
const clone = (v: any) => structuredClone(v);
const ordered = (v: any): any => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((key: string) => [key, ordered(v[key])])) : v;
const fail = (): never => { throw new Error("Invalid mono-agent harness session"); };
const corruptBinding = () => { throw Object.assign(new Error("Invalid mono-agent harness session binding"), { code: "ERR_HARNESS_JOURNAL_CORRUPT" }); };
const safeId = (id: any) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");

export class SessionStore {
  declare metadata: any;
  declare io: any;
  declare onClose: any;
  declare records: any[];
  declare retired: boolean;
  declare continuity: string | undefined;
  declare entries: Map<any, any>;
  declare outcomes: Map<any, any>;
  declare interruptions: Map<any, any>;
  declare interruptedOperations: Set<any>;
  declare repairCache: Promise<any[]>;
  declare validator: JournalValidator;
  declare tip: string;
  declare seq: number;
  declare durableSeq: number;
  declare line: Promise<void>;
  declare closed: boolean;
  declare failure: Error | null;
  declare closePromise: Promise<void> | null;

  constructor(metadata: any, records: any, io: any, onClose: any) {
    this.metadata = metadata;
    this.io = io;
    this.onClose = onClose;
    this.records = io?.read ? null as unknown as any[] : [];
    this.retired = false;
 this.continuity = undefined;
    this.entries = new Map();
    this.outcomes = new Map();
    this.interruptions = new Map();
    this.interruptedOperations = new Set(); this.repairCache = null as unknown as Promise<any[]>;
    this.validator = new JournalValidator();
    this.tip = null as unknown as string;
    this.seq = 0; this.durableSeq = 0;
    this.line = Promise.resolve();
    this.closed = false;
 this.failure = null;
 this.closePromise = null;
    if (!io?.read && metadata.hostAuthority !== undefined) acceptHeader(this, metadata);
    for (const record of records) (this.apply as (record: any) => void)(record);
  }
  validateRecord(record: any): void {
    checkRecordAuthority(this, record);
    if (record.kind === "turn_start" && record.payload.binding && record.payload.binding.handleId !== this.metadata.id) corruptBinding();
    this.validator.validate(record);
  }
  apply(record: any, address: any): void {
    checkRecordAuthority(this, record);
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
    if (["interruption", "tool_result", "message", "compaction", "rewind", "operation_end"].includes(record.kind)) this.repairCache = null as unknown as Promise<any[]>;
    if (record.kind === "tool_result" && record.payload.phase === "returned") {
      this.outcomes.set(`${record.operationId}\0${record.payload.callId}`, this.io?.read ? { address } : { record: clone(record) });
    }
    this.tip = this.validator.tip!;
    this.seq = record.seq;
    this.records?.push(clone(record));
  }
  enqueue(fn: any): Promise<any> {
    const result = this.line.then(async () => {
      if (this.closed || this.retired) { this.failure ??= new Error("Harness session is closed or retired"); throw this.failure; }
      if (this.failure) throw this.failure;
      return await fn();
    });
    this.line = result.catch(() => {});
    return result;
  }
  write(kind: any, payload: any, identity: { turnId?: string; operationId?: string; id?: string; schemaVersion?: 2; timestamp?: number; } = {}): Promise<any> {
    return this.enqueue(() => this.writeRecord(kind, payload, identity));
  }
  async writeRecord(kind: any, payload: any, { turnId = this.activeTurnId(), operationId, id = randomUUID(), schemaVersion = 2, timestamp = Date.now() }: { turnId?: string; operationId?: string; id?: string; schemaVersion?: 2; timestamp?: number; } = {}): Promise<any> {
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
  poison(error: any): Error { this.failure ??= isJournalStorageError(error) ? error : new JournalStorageError(error); return this.failure; }
  activeTurnId(): any { return this.validator.openTurns.values().next().value; }
  activeOperationId(): any { return [...this.validator.openOperations].at(-1); }
  beginTurn(turnId: any, config: {}, identitySource: string, binding: any, projectionBinding?: any): Promise<any>;
  beginTurn(turnId: any, config: {} = {}, identitySource: string = "synthetic", binding: any, projectionBinding: any | undefined = undefined): Promise<any> {
    return this.write("turn_start", () => ({ config: clone(config), identitySource, baselineTipId: this.tip,
      ...(binding ? { binding: clone(binding) } : {}), ...(projectionBinding ? { projectionBinding: clone(projectionBinding) } : {}) }),
      { turnId });
  }
  endTurn(turnId: any, status: any, result: any = null): Promise<any> {
    return this.write("turn_end", () => ({ status, tipId: this.tip,
      finalOperationId: this.validator.turns.get(turnId)?.finalOperationId ?? null,
      consumedInputIds: [...(this.validator.turns.get(turnId)?.inputs ?? [])],
      ...(this.validator.turns.get(turnId)?.start.payload.binding ? { seal: { version: 1,
        outcome: ({ completed: "completed", failed: "failed", aborted: "cancelled", interrupted: "interrupted" })[status as "completed" | "failed" | "aborted" | "interrupted"], result: clone(result) } } : {}) }), { turnId });
  }
  openOperation(operationId: any, config: any, type: string = "prompt", cause: string = "prompt"): Promise<any> {
    return this.write("operation_start", () => ({ config: clone(config), type, cause, baselineTipId: this.tip, parentOperationId: this.activeOperationId() ?? null }), { operationId });
  }
  closeOperation(operationId: any, status: any): Promise<any> { return this.write("operation_end", () => ({ status, tipId: this.tip }), { operationId }); }
  scopedWrite(fn: any, cause: any, before: any | undefined = undefined): Promise<any> {
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
  async appendMessage(message: any, id: string = randomUUID(), input: { id: any; complete: boolean; } = { id: null, complete: true }): Promise<any> {
    return this.scopedWrite(async () => {
      const config = this.validator.operations.get(this.activeOperationId())?.start.payload.config;
      const provenance = { provider: message.provider ?? config?.model?.provider ?? "unknown",
        api: message.api ?? config?.model?.api ?? "unknown", model: message.model ?? config?.model?.id ?? "unknown" };
      const record = await this.writeRecord("message", () => ({ message: clone(message), provenance, input: clone(input), contextParentId: this.tip }),
        { id, operationId: this.activeOperationId() });
      return record.id;
    }, "seed");
  }
  async appendCompaction(data: any, inheritedCoverage: any | undefined = undefined, source: any | undefined = undefined): Promise<any> {
    // Prepare outside the admitted write queue; getEntries itself drains it.
    const branch = await this.getEntries(); const preservedMessageIds: any[] = [], derivedMessages: any[] = [];
    let cursor = 0;
    for (const message of data.retainedTail ?? []) {
      const index = branch.findIndex((entry: any, at: any) => at >= cursor && entry.type === "message" && JSON.stringify(entry.message) === JSON.stringify(message));
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
      derivedMessages, coverageVersion: 1 }), { operationId: this.activeOperationId() })).id, "compaction", inheritedCoverage ? () => {
      if (!source || source.sourceTipId !== this.tip || source.sourceSeq !== this.seq) throw new TypeError("Composed checkpoint source changed");
    } : undefined);
  }
  async moveTo(tipId: any): Promise<any> { await this.scopedWrite(() => this.writeRecord("rewind", { tipId }), "rollback"); return tipId; }
  async verifyRead(): Promise<void> { try { await this.io?.verify?.(); } catch (error) { throw this.poison(error); } }
  snapshot(): any {
    return clone({ validator: this.validator, entries: this.entries, outcomes: this.outcomes,
      interruptions: this.interruptions, interruptedOperations: this.interruptedOperations,
      tip: this.tip, seq: this.seq, durableSeq: this.durableSeq });
  }
  restore(snapshot: any): void {
    Object.assign(this, clone(snapshot)); this.validator = Object.assign(new JournalValidator(), this.validator);
  }
  readQueue(fn: any): Promise<any> {
    const result = this.line.then(async () => {
      if (this.failure) throw this.failure;
      if (this.closed && this.io?.read) throw new Error("Harness session is closed");
      return fn();
    });
    this.line = result.catch(() => {}); return result;
  }
  getEntries(): Promise<any> {
    return this.readQueue(async () => {
      await this.verifyRead(); const entries = [];
      for (let id = this.tip; id !== null;) {
        const e = this.entries.get(id); if (!e) fail();
        entries.push(await this.materialize(e, true)); id = e.parentId;
      }
      await this.verifyRead(); return entries.reverse();
    });
  }
  async getLeafId(): Promise<string> { await this.line; if (this.failure) throw this.failure; return this.tip; }
  async materialize(entry: any, cached: boolean = false): Promise<any> {
    if (!entry || !this.io?.read) return clone(entry);
    let record;
    try { record = (cached ? this.io.cached?.(entry.address) : undefined) ?? await this.io.read(entry.address); }
    catch (error) { this.failure = isJournalStorageError(error) ? error : new JournalStorageError(error); throw this.failure; }
    return { ...(record.kind === "message" ? { type: "message", message: record.payload.message }
      : { ...record.payload.compaction, type: "compaction" }), id: entry.id, parentId: entry.parentId,
      timestamp: entry.timestamp, seq: entry.seq };
  }
  getAllEntries(): Promise<any> { return this.readQueue(async () => {
    await this.verifyRead(); const entries = await Promise.all([...this.entries.values()].map((entry: any) => this.materialize(entry, true)));
    await this.verifyRead(); return entries;
  }); }
  getEntry(id: any): Promise<any> { return this.readQueue(() => this.materialize(this.entries.get(id))); }
  async getOpenTurns(): Promise<any[]> { await this.line; return [...this.validator.openTurns].map((id: any) => clone(this.validator.turns.get(id).start)); }
  async getOpenOperations(): Promise<any[]> { await this.line; return [...this.validator.openOperations].map((id: any) => clone(this.validator.operations.get(id).start)); }
  async getTurn(turnId: any): Promise<any> { await this.line; return clone(this.validator.turns.get(turnId)?.end); }
  async getTerminal(operationId: any): Promise<any> {
    await this.line;
    const op = this.validator.operations.get(operationId);
    return op?.end ? { ...clone(op.end), config: clone(op.start.payload.config), fromTipId: op.start.payload.baselineTipId,
      tipId: op.end.payload.tipId, status: op.end.payload.status } : undefined;
  }
  async getRepairEntries(): Promise<any> {
    await this.line; if (this.failure) throw this.failure;
    if (!this.interruptions.size) return [];
    if (!this.repairCache) {
      // Branch membership uses indexed ancestry, not a second full payload read.
      const visible = new Set<string>();
      for (let id = this.tip; id !== null; id = this.entries.get(id).parentId) visible.add(id);
      const plan = planRepairEntries({ tip: this.tip, visible, interruptions: this.interruptions.values(),
        validator: this.validator, timestamp: (id: string) => this.entries.get(id).timestamp });
      this.repairCache = Promise.all(plan.repairs.map(async (repair: any) => ({ ...repair, calls: await Promise.all(repair.calls.map(async (call: any) => ({
        ...call, returned: await this.getReturnedOutcome(call.operationId, call.callId),
      }))) }))).then(async (repairs: any[]) => {
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
  getReturnedOutcome(operationId: any, callId: any): Promise<any> {
    return this.readQueue(async () => {
      const outcome = this.outcomes.get(`${operationId}\0${callId}`);
      try { return outcome?.record ? clone(outcome.record.payload.message) : outcome ? (await this.io.read(outcome.address)).payload.message : undefined; }
      catch (error) { throw this.poison(error); }
    });
  }
  prepareReconciliation(): Promise<any> {
    return this.enqueue(async () => {
      try { await this.io?.prepareReconciliation?.(); this.durableSeq = this.seq; }
      catch (error) { throw this.poison(error); }
    });
  }
  sync(): Promise<any> { return this.enqueue(async () => { try { await this.io?.sync(); this.durableSeq = this.seq; } catch (error) { throw this.poison(error); } }); }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      await this.line;
      this.closed = true;
      try { if (this.failure) throw this.failure; } finally { await this.onClose?.(this); }
    })();
    return this.closePromise;
  }
}

async function initializeSession(session: any): Promise<void> {
  const turnId = `synthetic:initialize:${randomUUID()}`;
  await session.beginTurn(turnId, { cause: "initialize" });
  await session.write("owner_binding", { kind: "unbound" });
  await session.write("handle_binding", { handleId: session.metadata.id, baseRevision: null, model: null });
  await session.endTurn(turnId, "completed");
}

export class MemorySessionRepo {
  declare sessions: Map<any, any>;
  declare openSessions: Map<any, any>;

  #headers = new Map();
  constructor() { this.sessions = new Map(); this.openSessions = new Map(); }
  async create({ id = randomUUID(), cwd = process.cwd(), hostAuthority, assertOwned }: { id?: string; cwd?: string; hostAuthority?: import("./header-authority.js").HostJournalAuthority; assertOwned?: () => Promise<void>; } = {}): Promise<SessionStore> {
    if (hostAuthority !== undefined) { validateHeaderUpgradeOptions({ hostAuthority, assertOwned }); await assertOwned!(); }
    if (this.sessions.has(id)) throw new Error("Harness session already exists");
    const metadata = { id, cwd, createdAt: Date.now(), journalId: managedJournalId(id), ...(hostAuthority ? {
      format: FORMAT, version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id }, hostAuthority: canonicalHostJournalAuthority(hostAuthority),
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
  async find(id: any, context: any | undefined = undefined): Promise<any> { const header = this.#headers.get(id); return header ? this.#publicMetadata(header) : undefined; }
  async open(metadata: any, { repair = true }: { repair?: boolean; } = {}): Promise<SessionStore> {
    const id = metadata.id;
    if (this.openSessions.has(id)) throw new Error("Harness session is already open");
    const data = this.sessions.get(id);
    if (!data) throw new Error("Harness session not found");
    const header = this.#headers.get(id);
    validateJournalHeader(header);
    const session = new SessionStore(this.#publicMetadata(header), data.records, null, (store: any) => {
      data.records = clone(store.records); this.openSessions.delete(id);
    });
    this.openSessions.set(id, session);
    try { if (repair) await repairInterruptedSession(session); return session; }
    catch (error) { await session.close().catch(() => {}); throw error; }
  }
  #publicMetadata(header: any): any {
    return header.hostAuthority === undefined
      ? { id: header.id, cwd: header.cwd, createdAt: header.createdAt, journalId: header.journalId }
      : clone(header);
  }
  async list(): Promise<any[]> { return [...this.sessions.keys()].map((id: any) => this.#publicMetadata(this.#headers.get(id))); }
  async delete(metadata: any, contextOrOptions: HostJournalDeletion | { abortSignal: AbortSignal; } | undefined = undefined, explicitOptions: HostJournalDeletion | undefined = undefined): Promise<void> {
    const options = deletionOptions(contextOrOptions, explicitOptions);
    validateDeletionDisposition(options);
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    const stored = this.sessions.get(metadata.id);
    if (stored) await authorizeGuardedDeletion(this.#headers.get(metadata.id), options);
    this.sessions.delete(metadata.id); this.#headers.delete(metadata.id);
  }
  async close(): Promise<void> { for (const session of this.openSessions.values()) await session.close(); }
}

const syncPath = (path: any) => syncDir(path, undefined, fail);
/**
 * The single journal-directory naming rule shared by every catalogue walk and
 * retention inventory: anything else (`.DS_Store`, temp files, subdirectories)
 * is not a journal and is never read, charged, reclaimed or deleted.
 */
export function journalEntrySuffix(name: string): string;
export function journalEntrySuffix(name: string): string | undefined {
  return [".jsonl", ".jsonl.creating", ".jsonl.importing", ".jsonl.upgrading"].find((suffix: string) => name.endsWith(suffix));
}
async function absent(path: any): Promise<boolean> { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } }
export class JsonlSessionRepo {
  declare root: string;
  declare directory: string;
  declare openSessions: Map<any, any>;
  declare locksPromise: any;
  declare directoryIdentity: any;
  declare warm: { metadata: any; identity: any; state: any; cache: Map<any, any>; cacheBytes: number; };
  declare retiredHandles: Set<any>;
  declare onImportPhase: (_phase: any) => Promise<void>;
  declare onHeaderUpgradePhase: (_phase: any) => Promise<void>;
  declare onRootPermissionsTightened: () => void;

  constructor({ sessionsRoot, onImportPhase = async (_phase: any) => {}, onHeaderUpgradePhase = async (_phase: any) => {}, onRootPermissionsTightened = () => {} }: { sessionsRoot: any; onImportPhase?: (_phase: any) => Promise<void>; onHeaderUpgradePhase?: (_phase: any) => Promise<void>; onRootPermissionsTightened?: () => void; }) {
    this.root = resolve(sessionsRoot);
    assertSupportedSessionsRoot(this.root);
    this.directory = join(this.root, "journals");
    this.openSessions = new Map();
    this.locksPromise = null;
    this.directoryIdentity = null; this.warm = null as unknown as typeof this.warm;
    this.retiredHandles = new Set();
    this.onImportPhase = onImportPhase;
    this.onHeaderUpgradePhase = onHeaderUpgradePhase;
    this.onRootPermissionsTightened = onRootPermissionsTightened;
  }
  async ensureDirectory(): Promise<any> {
    this.locksPromise ??= JournalLocks.open(this.root, this.onRootPermissionsTightened);
    const locks = await this.locksPromise;
    await locks.assertRoot();
    // Once pinned, a removed journals directory must never be recreated by a late writer.
    if (this.directoryIdentity !== null) { await this.assertDirectory(); return locks; }
    try { await mkdir(this.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(this.directory);
    if (!isOwned(stat, true)) fail();
    this.directoryIdentity ??= stat;
    if (!sameIdentity(stat, this.directoryIdentity)) fail();
    return locks;
  }
  async assertDirectory(): Promise<void> {
    const locks = await this.locksPromise;
    await locks.assertRoot();
    const current = await lstat(this.directory);
    if (!isOwned(current, true) || !sameIdentity(current, this.directoryIdentity)) fail();
  }
  checkMetadata(metadata: any): void {
    if (!safeId(metadata.id) || metadata.journalId !== managedJournalId(metadata.id)
      || dirname(resolve(metadata.path)) !== this.directory
      || ![`${metadata.journalId}.jsonl`, `${metadata.journalId}.jsonl.importing`, `${metadata.journalId}.jsonl.creating`].includes(metadata.path.split(/[\\/]/).at(-1))) fail();
  }
  /**
   * @param [context] cancels only the lock waits
   */
  async create({ id = randomUUID(), cwd = process.cwd(), staging = false, hostAuthority, assertOwned }: { id?: string; cwd?: string; staging?: boolean; hostAuthority?: import("./header-authority.js").HostJournalAuthority; assertOwned?: () => Promise<void>; } = {}, context: { abortSignal?: AbortSignal; } | undefined = undefined): Promise<SessionStore> {
    const signal = contextSignal(context);
    if (hostAuthority !== undefined) { validateHeaderUpgradeOptions({ hostAuthority, assertOwned }); await assertOwned!(); }
    if (!safeId(id)) throw new TypeError("Unsafe harness session id");
    if (this.retiredHandles.has(id)) throw new Error("Harness session handle is retired");
    const locks = await this.ensureDirectory();
    const metadata = { id, cwd, createdAt: Date.now(), journalId: managedJournalId(id), path: "" };
    metadata.path = join(this.directory, `${metadata.journalId}.jsonl${staging ? ".importing" : ""}`);
    if (!await absent(join(this.directory, `${metadata.journalId}.jsonl`))) throw new Error("Harness session already exists");
    await locks.withCatalog(() => this.#reclaimCreating(metadata), { signal });
    const writer = await locks.acquireWriter(metadata.journalId, { wait: false, signal });
    let published = false;
    try {
      await locks.withCatalog(async () => {
        await this.assertDirectory();
        if (this.openSessions.has(id) || !await absent(join(this.directory, `${metadata.journalId}.jsonl`))) throw new Error("Harness session already exists");
        this.assertNotDamaged((await listLegacySessions(this.root, { id })).unattributed, id);
        if (!await absent(`${join(this.directory, `${metadata.journalId}.jsonl`)}.importing`)) this.assertNotDamaged([{ id }], id);
        if (this.retiredHandles.has(id)) throw new Error("Harness session handle is retired");
        if (hostAuthority !== undefined) await assertOwned!();
        await this.writeImportHeader({ format: FORMAT, version: 2, ownershipSchemaVersion: 1,
          ownership: { kind: "unbound" }, initialHandle: { id }, ...metadata, ...(hostAuthority ? { hostAuthority: canonicalHostJournalAuthority(hostAuthority) } : {}) }, true);
        if (hostAuthority !== undefined) await assertOwned!();
        published = true;
      }, { signal });
      const session = await this.openLocked(metadata, writer);
      await initializeSession(session);
      return session;
    } catch (error) {
      // A failed create may have left valid bytes; never unlink without ownership.
      const local = this.openSessions.get(id);
      if (local) await local.close().catch(() => {});
      try {
        // Cancelled before any mutation: release now, reclaim the lock file off-path.
        if (!published && signal?.aborted) { writer.release(); locks.reclaimLater(writer.path, () => this.journalDataGone(metadata)); }
        else if (!published) await locks.releaseWriter(writer, () => this.journalDataGone(metadata));
      } finally { writer.release(); }
      throw error;
    }
  }
  static guardedEpochPlan(options: any): { header: { format: string; version: number; ownershipSchemaVersion: number; ownership: { kind: string; }; initialHandle: { id: any; }; id: any; cwd: string; createdAt: any; journalId: string; hostAuthority: { version: any; rootId: any; authorityId: any; ownerKey: any; historyBucket: any; }; }; records: JournalEntry[]; bytes: Buffer<ArrayBuffer>; } { return guardedEpochPlan(options); }
  /**
   * Atomic, idempotent host epoch initialization; ordinary create stays unchanged.
   */
  async createGuardedEpoch(options: any): Promise<any> {
    validateHeaderUpgradeOptions(options); const plan = guardedEpochPlan(options);
    const metadata = { ...plan.header, path: join(this.directory, `${plan.header.journalId}.jsonl`) };
    await options.assertOwned(); const locks = await this.ensureDirectory();
    if (this.openSessions.has(options.id)) throw Object.assign(new Error("Harness session is already open"), { code: "ERR_HARNESS_WRITER_BUSY" });
    const writer = await locks.acquireWriter(metadata.journalId, { wait: false });
    try { return await locks.withCatalog(async () => {
      await options.assertOwned(); await this.assertDirectory();
      const validate = async (path: any, prefix: any) => {
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
  /**
   * Direct current-journal lookup; only a missing path needs legacy/damage discovery.
   */
  find(id: string, context?: { abortSignal?: AbortSignal }): any;
  async find(id: string, context: { abortSignal?: AbortSignal; } | undefined = undefined): Promise<any> {
    if (!safeId(id)) throw new TypeError("Unsafe harness session id");
    const journalId = managedJournalId(id), path = join(this.directory, `${journalId}.jsonl`);
    try {
      const reader = await JournalReader.open(path, this.root);
      try {
        const header = await reader.readHeader(); validateJournalHeader(header);
        if (header.id !== id || header.journalId !== journalId) fail();
        await reader.assertIdentity(); return { ...header, path };
      } finally { await reader.close(); }
    } catch (error) {
      // A path can disappear between lookup and read. Absence is not damage;
      // creation stages are inspected only under catalogue/writer ownership.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") this.assertNotDamaged([{ id }], id);
    }
    const locks = await this.ensureDirectory();
    const published = await locks.withCatalog(async () => {
      await this.#reclaimCreating({ id, journalId });
      return !await absent(path);
    }, { signal: contextSignal(context) });
    // A creator may have published while this missing-path lookup waited.
    if (published) return this.find(id, context);
    const legacy = await listLegacySessions(this.root, { id });
    this.assertNotDamaged(legacy.unattributed, id);
    const matches = legacy.sessions.filter((entry: any) => entry.id === id);
    if (matches.length > 1) fail();
    if (matches.length) return matches[0];
    for (const suffix of [".importing", ".upgrading"]) if (!await absent(path + suffix)) this.assertNotDamaged([{ id }], id);
    return undefined;
  }
  /** `signal` cancels only the writer wait, never a started open/repair. */
  async open(metadata: any, { repair = true, wait = repair, validateHeader = undefined, signal = undefined }: { repair?: boolean; wait?: any; validateHeader?: any; signal?: any; } = {}): Promise<SessionStore> {
    if (metadata.legacy) {
      if (!repair) throw new Error("Legacy sources cannot be inspected as bound native turns");
      return this.importLegacy(metadata, signal);
    }
    this.checkMetadata(metadata);
    if (metadata.path !== join(this.directory, `${metadata.journalId}.jsonl`)) fail();
    if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
    if (this.openSessions.has(metadata.id)) throw Object.assign(new Error("Harness session is already open"), { code: "ERR_HARNESS_WRITER_BUSY" });
    const locks = await this.ensureDirectory();
    const writer = await locks.acquireWriter(metadata.journalId, { wait, signal });
    let session: SessionStore | undefined;
    try {
      if (this.openSessions.has(metadata.id)) throw Object.assign(new Error("Harness session is already open"), { code: "ERR_HARNESS_WRITER_BUSY" });
      session = await this.openLocked(metadata, writer, { repair, validateHeader });
      try { if (repair) { await this.reconcileImport(session); await repairInterruptedSession(session); } return session; }
      catch (error) { await session.close().catch(() => {}); throw error; }
    } catch (error) {
      try { if (!session?.closed) await locks.releaseWriter(writer, () => this.journalDataGone(metadata)); } finally { writer.release(); }
      throw error;
    }
  }
  async syncDirectories(): Promise<void> {
    await this.assertDirectory();
    await syncPath(this.directory); await syncPath(this.root);
    await this.assertDirectory();
  }
  async openLocked(metadata: any, writer: any, { repair = true, validateHeader = undefined }: { repair?: boolean; validateHeader?: any; } = {}): Promise<SessionStore> {
    if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
    const locks = await this.locksPromise;
    await this.assertDirectory();
    const reader = await JournalReader.open(metadata.path, this.root);
    let handle!: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(metadata.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      const identity = await handle.stat();
      if (!sameIdentity(identity, reader.identity)) fail();
      let expectedSize = identity.size, expectedStat = identity, pendingTornTail: number | null = null;
      const warm = this.warm?.metadata.id === metadata.id && this.warm.metadata.journalId === metadata.journalId
        && this.warm.metadata.path === metadata.path && unchanged(this.warm.identity, identity) ? this.warm : null;
      if (!warm) this.warm = null as unknown as typeof this.warm;
      else { reader.cache = warm.cache; reader.cacheBytes = warm.cacheBytes; }
      const verify = async () => {
        reader.path = storeMetadata.path; const stat = await reader.assertIdentity();
        if (!unchanged(stat, expectedStat) || stat.size !== expectedSize) { reader.clearCache(); this.warm = null as unknown as typeof this.warm; fail(); }
      };
      const storeMetadata = { ...metadata };
      let validatedHeader: any;
      const session = new SessionStore(storeMetadata, [], {
        read: async (address: any) => { await verify(); return reader.read(address); },
        cached: (address: any) => reader.cached(address), remember: (address: any, record: any) => { if (address) reader.remember(address, record); },
        invalidate: () => { reader.clearCache(); this.warm = null as unknown as typeof this.warm; }, verify,
        relocated: async () => {
          reader.path = storeMetadata.path; const stat = await reader.assertIdentity();
          if (!sameIdentity(stat, expectedStat) || stat.size !== expectedSize || stat.mtimeMs !== expectedStat.mtimeMs) fail();
          expectedStat = stat; reader.cacheVersion = stat;
        },
        prepareReconciliation: async (expectedTail: Buffer<ArrayBufferLike> | undefined = undefined) => {
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
            pendingTornTail = null; reader.clearCache(); this.warm = null as unknown as typeof this.warm;
          }
          await handle.sync();
        },
        append: async (text: any) => {
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
      }, async (store: any) => {
        if (pendingTornTail === null && !store.retired && !store.failure && store.entries.size <= 2048 && store.seq <= 8192 && storeMetadata.path.endsWith(".jsonl")) {
          try {
            await verify(); const closedIdentity = await handle.stat();
            if (!unchanged(closedIdentity, expectedStat)) fail();
            this.warm = { metadata: { ...clone(validatedHeader), path: storeMetadata.path }, identity: closedIdentity,
              state: store.snapshot(), cache: reader.cache, cacheBytes: reader.cacheBytes };
          }
          catch { this.warm = null as unknown as typeof this.warm; }
        } else this.warm = null as unknown as typeof this.warm;
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
        validateHeader?.(clone(validatedHeader));
        acceptHeader(session, validatedHeader);
        session.restore(warm.state); Object.assign(storeMetadata, warm.metadata, { path: metadata.path });
        await verify();
      } else {
 let header: any;
        const evidence = await reader.scan((record: any, address: { offset: number; length: number; }) => {
          if (!header) { acceptHeader(session, record); header = record; validatedHeader = clone(record); validateHeader?.(clone(validatedHeader)); }
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
      // creator crashed after rename. Guarded writers cannot escape this sync.
      if (storeMetadata.hostAuthority !== undefined) { await handle.sync(); await this.syncDirectories(); }
      if (repair && (!warm || session.durableSeq !== session.seq)) { await handle.sync(); session.durableSeq = session.seq; }
      this.openSessions.set(metadata.id, session);
      return session;
    } catch (error) { await reader.close(); await handle?.close(); throw error; }
  }
  async writeImportHeader(metadata: any, catalogOwned: boolean = false): Promise<any> {
    const locks = await this.locksPromise;
    const phases = { created: "stage_created", written: "stage_written", file_synced: "stage_synced", directory_synced: "stage_ready" };
    // The `.creating` inode is ours (O_EXCL + writer + catalogue); a failed write
    // removes it rather than leave a torn header.
    const publish = async () => {
      await this.assertDirectory();
      await publishAtomic({ path: metadata.path, temporary: join(this.directory, `${metadata.journalId}.jsonl.creating`),
        bytes: Buffer.from(`${JSON.stringify({ ...metadata, path: undefined })}\n`), fail, sync: () => this.syncDirectories(),
        check: () => this.assertDirectory(), phase: async (step: "created" | "written" | "file_synced" | "renamed" | "directory_synced") => { if (step in phases) await this.onImportPhase(phases[step as keyof typeof phases]); } });
    };
    return catalogOwned ? publish() : locks.withCatalog(publish);
  }
  async importSealed(session: any): Promise<boolean> {
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
  async reconcileImport(session: any, publicationSynced: boolean = false): Promise<void> {
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
      for (const path of this.journalPaths(session.metadata).filter((p: string) => p !== session.metadata.path)) {
        if (await absent(path)) continue;
        const reader = await JournalReader.open(path, this.root);
        try {
          const header = await reader.readHeader(); validateJournalHeader(header);
          if (header.id !== session.metadata.id || header.journalId !== session.metadata.journalId || header.import?.importId !== info.importId) fail();
          const view = new (SessionStore as new (metadata: any, records: any, io: any) => SessionStore)(header, [], { read: (address: any) => reader.read(address) });
          let first = true;
          await reader.scan((record: any, address: { offset: number; length: number; }) => { if (first) first = false; else view.apply(record, address); });
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
  async importLegacy(metadata: any, signal: any | undefined = undefined): Promise<SessionStore> {
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
    await locks.withCatalog(() => this.#reclaimCreating({ id: metadata.id, journalId }), { signal });
    const writer = await locks.acquireWriter(journalId, { signal });
    let session: SessionStore | undefined;
    try {
      await locks.withCatalog(async () => {
        await this.assertDirectory();
        // Native ownership is deterministic; only legacy source discovery walks.
        const legacy = await listLegacySessions(this.root, { id: metadata.id });
        this.assertNotDamaged(legacy.unattributed, metadata.id);
        if (!await absent(`${publishedPath}.upgrading`)) this.assertNotDamaged([{ id: metadata.id }], metadata.id);
        const sources = legacy.sessions.filter((m: any) => m.id === metadata.id);
        if (sources.length > 1 || sources.some((m: any) => m.path !== metadata.path)) fail();
        if (this.retiredHandles.has(metadata.id)) throw new Error("Harness session handle is retired");
        if (await absent(publishedPath)) {
          if (sources.length !== 1) fail();
          await assertLegacyIdentity(metadata.path, this.root, info.source.identity);
        }
      }, { signal }); // validation only: no mutation has started
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
        let view: SessionStore;
        try {
          const header = await reader.readHeader(); validateJournalHeader(header);
          if (header.journalId !== journalId || header.id !== metadata.id || header.import?.importId !== info.importId) fail();
          view = new (SessionStore as new (metadata: any, records: any, io: any) => SessionStore)(header, [], { read: (address: any) => reader.read(address) });
          let first = true;
          await reader.scan((record: any, address: { offset: number; length: number; }) => { if (first) first = false; else view.apply(record, address); });
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
        await (session.beginTurn as (turnId: string, config: object) => Promise<any>)(turnId, { cause: "legacy_import", importId: info.importId });
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
        await rename(session!.metadata.path, publishedPath); session!.metadata.path = publishedPath;
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
  async listOwned({ wait = true, signal = undefined }: { wait?: boolean; signal?: any; } = {}): Promise<any> {
    if (await absent(this.directory)) return [];
    const locks = await this.ensureDirectory();
    return (await locks.withCatalog(() => this.catalogueUnlocked(), { wait, signal })).owned;
  }
  /** Locked native catalogue whose `unattributed` also carries damaged legacy
   * entries, so a handle's own damaged source is never reported missing. */
  async catalogue({ wait = true, signal = undefined }: { wait?: boolean; signal?: any; } = {}): Promise<{ owned: any; unattributed: any[]; }> {
    const legacy = await listLegacySessions(this.root);
    const native = await absent(this.directory) ? { owned: [], unattributed: [] }
      : await (await this.ensureDirectory()).withCatalog(() => this.catalogueUnlocked(), { wait, signal });
    return { owned: native.owned, unattributed: [...native.unattributed, ...legacy.unattributed] };
  }
  async listOwnedUnlocked(includeStaging: boolean = false): Promise<any[]> { return (await this.catalogueUnlocked(includeStaging)).owned; }
  /**
   * Catalogue walk shared by list/create/import/retire. Names without a
   *  journal suffix (`.DS_Store`, temp files, subdirectories) are not journals
   *  and are ignored. A journal-named entry whose header cannot be read or
   *  validated is reported as unattributed (with its handle when a parsed header
   *  names one) and skipped: it is never reclaimed, rewritten or deleted, and it
   *  never blocks another handle's valid journal. Callers refuse any handle it
   *  is attributable to, exactly as the whole-catalogue failure used to.
   */
  async catalogueUnlocked(includeStaging: boolean = false): Promise<{ owned: any[]; unattributed: { name: string; id?: string; }[]; }> {
    let files;
    try { files = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { owned: [], unattributed: [] }; throw error; }
    if (this.directoryIdentity) await this.assertDirectory();
    const owned: any[] = [], unattributed: {name: string; id?: string}[] = [];
    for (const file of files) {
      const suffix = journalEntrySuffix(file.name), creating = suffix === ".jsonl.creating";
      if (!suffix || suffix === ".jsonl.upgrading" || suffix === ".jsonl.importing" && !includeStaging) continue;
      const skip = (header?: any) => { unattributed.push({ name: file.name, ...(typeof header?.id === "string" && file.name === `${managedJournalId(header.id)}${suffix}` ? { id: header.id } : {}) }); };
      if (!file.isFile()) { skip(); continue; }
      const path = join(this.directory, file.name);
      let reader;
      try { reader = await JournalReader.open(path, this.root); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") skip(); continue; }
      let header;
      try {
        try { header = await reader.readHeader({ allowIncomplete: creating }); } catch { skip(); continue; }
        // All new native journals use deterministic IDs; import stages stay
        // available to source-bound recovery.
        const journalId = file.name.slice(0, -".jsonl.creating".length);
        if (creating && (!header || !header.import) && /^[0-9a-f]{64}$/i.test(journalId)) {
          if (header) {
            try {
              validateJournalHeader(header); this.checkMetadata({ ...header, path });
              let count = 0; const scan = await reader.scan(() => { count += 1; });
              // Never discard context or future phase data: keep it, unattributed.
              if (header.hostAuthority !== undefined || count !== 1 || scan.torn) { skip(header); continue; }
            } catch { skip(header); continue; }
          }
          // A per-entry lock failure (e.g. an insecure writer lock) keeps this
          // stage, unattributed; only shared root/catalogue failures stay fatal.
          try { await this.#reclaimNativeCreation(reader, { journalId }); }
          catch { await this.assertDirectory(); skip(header); }
          continue; // a busy failed creator's unpublished header is not a live session
        }
        if (!header || (creating && !includeStaging)) continue;
        const metadata = { ...header, path };
        try { validateJournalHeader(header); this.checkMetadata(metadata); } catch { skip(header); continue; }
        owned.push(metadata);
      } finally { await reader.close(); }
    }
    return { owned, unattributed };
  }
  /** Refuse a handle that an unattributed entry names: damaged own evidence is
   * never silently replaced, recreated or treated as retired. */
  assertNotDamaged(unattributed: any, id: any): void {
    if (unattributed.some((entry: any) => entry.id === id)) throw Object.assign(new Error("Harness session journal is unreadable"), { code: "ERR_HARNESS_JOURNAL_UNREADABLE", sessionId: id });
  }
  // Exact-path recovery only. Context-bearing, guarded and future stages are preserved.
  async #reclaimCreating(metadata: any): Promise<void> {
    const path = join(this.directory, `${metadata.journalId}.jsonl.creating`);
    if (await absent(path)) return;
    const reader = await JournalReader.open(path, this.root);
    try {
      await this.#reclaimNativeCreation(reader, metadata, async () => {
        // A live writer's stage is not a stable damage/reclamation verdict.
        const header = await reader.readHeader({ allowIncomplete: true });
        let count = 0; const scan = await reader.scan(() => { count++; });
        if (header !== undefined) {
          try { validateJournalHeader(header); this.checkMetadata({ ...header, path }); }
          catch { this.assertNotDamaged([{ id: metadata.id }], metadata.id); }
          if (header.hostAuthority !== undefined || count !== 1 || scan.torn) this.assertNotDamaged([{ id: metadata.id }], metadata.id);
        }
      });
      if (!await absent(path)) throw Object.assign(new Error("Harness creation writer is busy"), { code: "ERR_HARNESS_WRITER_BUSY" });
    } finally { await reader.close(); }
  }
  // Caller holds catalogue: every native creating->rename transaction holds it
  // too. Try the writer, never wait under catalogue or reclaim a live owner.
  async #reclaimNativeCreation(reader: any, metadata: any, validate: () => Promise<void> = async () => {}): Promise<void> {
    const locks = await this.locksPromise;
    const lockPath = join(locks.directory, `${metadata.journalId}.sqlite`);
    await locks.ensureFile(lockPath);
    const writer = await locks.tryLock(lockPath);
    if (!writer) return;
    try {
      await validate();
      await reader.assertIdentity(); await unlink(reader.path); await this.syncDirectories();
      if (!await this.journalDataGone(metadata)) return;
      await locks.assertRoot();
      if (!sameIdentity(await lstat(writer.path), writer.identity)) fail();
      writer.release(); await unlink(writer.path); await locks.syncDirectory();
    } finally { writer.release(); }
  }
  async list(_filter: unknown | undefined = undefined, context: { abortSignal?: AbortSignal; } | undefined = undefined): Promise<any[]> {
    const owned = await this.listOwned({ signal: contextSignal(context) });
    const { sessions } = await listLegacySessions(this.root);
    return [...owned, ...sessions.filter((m: any) => !owned.some((n: any) => n.id === m.id))];
  }
  journalPaths(metadata: any): string[] {
    return [join(this.directory, `${metadata.journalId}.jsonl`), join(this.directory, `${metadata.journalId}.jsonl.importing`), join(this.directory, `${metadata.journalId}.jsonl.creating`)];
  }
  async journalDataGone(metadata: any): Promise<boolean> {
    await this.assertDirectory();
    for (const path of this.journalPaths(metadata)) if (!await absent(path)) return false;
    const files = await readdir(this.directory);
    if (files.some((name: string) => name.startsWith(`${metadata.journalId}.`))) return false;
    // P1a emits no aliases. Adding projections must extend this same predicate
    // and removal transaction; unknown future aliases conservatively pin locks.
    const aliases = join(this.root, "aliases");
    if (!await absent(aliases)) {
      const stat = await lstat(aliases); if (!stat.isDirectory()) fail();
      if ((await readdir(aliases)).length) return false;
    }
    return true;
  }
  async removeOwned(metadata: any, options: HostJournalDeletion | undefined = undefined): Promise<void> {
    validateDeletionDisposition(options);
    await this.assertDirectory();
    const paths = this.journalPaths(metadata);
    const files = await readdir(this.directory);
    if (files.some((name: string) => name.startsWith(`${metadata.journalId}.`) && !paths.some((path: string) => path.endsWith(`/${name}`)))) fail();
    const aliases = join(this.root, "aliases");
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
      for (const reader of readers) await authorizeGuardedDeletion(await reader.readHeader(), options);
      for (const archive of archives) await this.removeLegacy(archive);
      for (const reader of readers) { await options?.assertOwned?.(); await reader.assertIdentity(); await unlink(reader.path); await options?.onPhase?.("native_file_removed"); }
    } finally { for (const reader of readers) await reader.close(); }
    await this.syncDirectories();
    await options?.onPhase?.("native_member_directory_synced");
  }
  async removeLegacy(metadata: any): Promise<void> {
    const path = resolve(metadata.path), parent = dirname(path);
    if (dirname(parent) !== this.root || ["journals", "locks", "aliases"].some((name: string) => parent === join(this.root, name))) fail();
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
  async retireByHandle(id: string, contextOrOptions: HostJournalDeletion | { abortSignal: AbortSignal; } | undefined = undefined, explicitOptions: HostJournalDeletion | undefined = undefined): Promise<void> {
    const options = deletionOptions(contextOrOptions, explicitOptions), signal = contextSignal(contextOrOptions);
    validateDeletionDisposition(options);
    if (!safeId(id)) throw new TypeError("Unsafe harness session id");
    this.retireHandle(id);
    try {
      if (await absent(this.root)) return;
      const locks = await this.ensureDirectory();
      const matches = await locks.withCatalog(async () => {
        const { owned, unattributed } = await this.catalogueUnlocked(true);
        const legacy = await listLegacySessions(this.root, { id, includeArchives: true });
        // Attributable damage (native or legacy, including a damaged exact-name
        // legacy candidate) is never treated as retired or unlinked. Damage of
        // unknown ownership is not reclaimable either: it is left untouched.
        this.assertNotDamaged([...unattributed, ...legacy.unattributed], id);
        return [...owned, ...legacy.sessions].filter((m: any) => m.id === id);
      }, { signal });
      const local = this.openSessions.get(id);
      if (local && !matches.some((m: any) => m.journalId === local.metadata.journalId)) matches.push(local.metadata);
      for (const metadata of matches) await this.retire(metadata, signal ? { abortSignal: signal } : undefined, options);
      const remaining = await locks.withCatalog(() => this.listOwnedUnlocked(true));
      if (remaining.some((m: any) => m.id === id)) fail();
    } finally {
      const local = this.openSessions.get(id);
      if (local && !local.retired) this.retiredHandles.delete(id);
      else this.finishRetirement(id);
    }
  }
  clearWarm(id: any): void { if (this.warm?.metadata.id === id) { this.warm.cache.clear(); this.warm = null as unknown as typeof this.warm; } }
  retireHandle(id: any): void { this.retiredHandles.add(id); this.clearWarm(id); }
  finishRetirement(id: any): void { if (!this.openSessions.has(id)) this.retiredHandles.delete(id); }
  async retire(metadata: any, contextOrOptions: HostJournalDeletion | { abortSignal: AbortSignal; } | undefined = undefined, explicitOptions: HostJournalDeletion | undefined = undefined): Promise<void> {
    const options = deletionOptions(contextOrOptions, explicitOptions), signal = contextSignal(contextOrOptions);
    validateDeletionDisposition(options);
    const live = this.openSessions.get(metadata.id), authority = live && sessionAuthorities.get(live);
    if (authority) await authorizeGuardedDeletion({ ownershipSchemaVersion: 1, hostAuthority: authority }, options);
    this.retireHandle(metadata.id);
    const context = signal ? { abortSignal: signal } : undefined;
    if (metadata.legacy) { try { return await this.delete(metadata, context, options); } finally { this.finishRetirement(metadata.id); } }
    this.checkMetadata(metadata);
    const store = this.openSessions.get(metadata.id);
    if (!store) { try { return await this.delete(metadata, context, options); } finally { this.finishRetirement(metadata.id); } }
    if (this.warm?.metadata.id === store.metadata.id) this.warm = null as unknown as typeof this.warm;
    store.io?.invalidate?.();
    store.retired = true; // reject new admission before draining prior storage I/O
    await store.line;
    const locks = await this.locksPromise;
    await locks.withCatalog(() => this.removeOwned(metadata, options), { signal });
    // Keep its already-held writer lock until the provider's close/unwind.
  }
  async delete(metadata: any, contextOrOptions: HostJournalDeletion | { abortSignal: AbortSignal; } | undefined = undefined, explicitOptions: HostJournalDeletion | undefined = undefined): Promise<void> {
    const options = deletionOptions(contextOrOptions, explicitOptions), signal = contextSignal(contextOrOptions);
    validateDeletionDisposition(options);
    this.clearWarm(metadata.id);
    const locks = await this.ensureDirectory();
    if (metadata.legacy) {
      await locks.withCatalog(() => this.removeLegacy(metadata), { signal }); return;
    }
    this.checkMetadata(metadata);
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    const writer = await locks.acquireWriter(metadata.journalId, { wait: options?.hostAuthority === undefined, signal });
    try { await locks.withCatalog(() => this.removeOwned(metadata, options), { signal }); }
    finally {
      try { await locks.releaseWriter(writer, () => this.journalDataGone(metadata)); } finally { writer.release(); }
    }
  }
  async sync(metadata: any): Promise<any> {
    const local = this.openSessions.get(metadata.id);
    if (local) return local.sync();
    const session = await this.open(metadata);
    try { await session.sync(); } finally { await session.close(); }
  }
  async close(): Promise<void> { for (const session of this.openSessions.values()) await session.close(); }
}
