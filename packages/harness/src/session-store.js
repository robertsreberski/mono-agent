// Mono-agent-owned append-only single-main-branch store. No provider execution here.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readBoundedJsonl, MAX_LINE } from "./bounded-jsonl.js";
import { archiveLegacySession, listLegacySessions, readLegacySession } from "./legacy-import.js";

import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { JOURNAL_FORMAT as FORMAT } from "./journal-types.js";
const clone = (v) => structuredClone(v);
const fail = () => { throw new Error("Invalid mono-agent harness session"); };
const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");

export class SessionStore {
  constructor(metadata, records, io, onClose) {
    this.metadata = metadata;
    this.io = io;
    this.onClose = onClose;
    this.records = [];
    this.entries = new Map();
    this.validator = new JournalValidator();
    this.tip = null;
    this.seq = 0;
    this.line = Promise.resolve();
    this.closed = false;
    this.failure = null;
    for (const record of records) this.apply(record);
  }
  validateRecord(record) { this.validator.validate(record); }
  apply(record) {
    this.validator.apply(record);
    const p = record.payload;
    if (record.kind === "message" || record.kind === "compaction") {
      const data = record.kind === "message" ? { type: "message", message: p.message }
        : { ...p.compaction, type: "compaction" };
      this.entries.set(record.id, { ...clone(data), id: record.id, parentId: p.contextParentId,
        timestamp: record.timestamp, seq: record.seq });
    }
    this.tip = this.validator.tip;
    this.seq = record.seq;
    this.records.push(clone(record));
  }
  enqueue(fn) {
    const result = this.line.then(async () => {
      if (this.closed) throw new Error("Harness session is closed");
      if (this.failure) throw this.failure;
      return fn();
    });
    this.line = result.catch((error) => { this.failure = error; });
    return result;
  }
  /** @param {any} kind @param {any} payload @param {{turnId?: string, operationId?: string, id?: string}} [identity] */
  write(kind, payload, identity = {}) {
    return this.enqueue(() => this.writeRecord(kind, payload, identity));
  }
  /** @param {any} kind @param {any} payload @param {{turnId?: string, operationId?: string, id?: string}} [identity] */
  async writeRecord(kind, payload, { turnId = this.activeTurnId(), operationId, id = randomUUID() } = {}) {
      const record = { schemaVersion: 2, id, parentId: this.validator.parentId,
        seq: this.seq + 1, timestamp: Date.now(), turnId, kind,
        ...(operationId ? { operationId } : {}), payload: typeof payload === "function" ? payload() : clone(payload) };
      const text = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(text) > MAX_LINE) throw new Error("Harness session record is too large");
      this.validateRecord(record);
      await this.io?.append(text);
      this.apply(record);
      return record;
  }
  activeTurnId() { return [...this.validator.turns].find(([, t]) => !t.end)?.[0]; }
  activeOperationId() { return [...this.validator.operations].reverse().find(([, o]) => !o.end)?.[0]; }
  beginTurn(turnId, config = {}, identitySource = "synthetic") {
    return this.write("turn_start", () => ({ config: clone(config), identitySource, baselineTipId: this.tip }), { turnId });
  }
  endTurn(turnId, status) {
    return this.write("turn_end", () => ({ status, tipId: this.tip,
      finalOperationId: this.validator.turns.get(turnId)?.finalOperationId ?? null,
      consumedInputIds: [...(this.validator.turns.get(turnId)?.inputs ?? [])] }), { turnId });
  }
  openOperation(operationId, config, type = "prompt", cause = "prompt") {
    return this.write("operation_start", () => ({ config: clone(config), type, cause, baselineTipId: this.tip, parentOperationId: this.activeOperationId() ?? null }), { operationId });
  }
  closeOperation(operationId, status) { return this.write("operation_end", () => ({ status, tipId: this.tip }), { operationId }); }
  scopedWrite(fn, cause) {
    return this.enqueue(async () => {
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
  async appendCompaction(data) {
    return this.scopedWrite(async () => (await this.writeRecord("compaction", () => ({ compaction: clone(data), contextParentId: this.tip,
      preservedMessageIds: [], derivedMessages: clone(data.retainedTail ?? []), coverageVersion: 1 }),
      { operationId: this.activeOperationId() })).id, "compaction");
  }
  async moveTo(tipId) { await this.scopedWrite(() => this.writeRecord("rewind", { tipId }), "rollback"); return tipId; }
  async getEntries() {
    await this.line;
    if (this.failure) throw this.failure;
    const entries = [];
    for (let id = this.tip; id !== null;) {
      const e = this.entries.get(id); if (!e) fail();
      entries.push(clone(e)); id = e.parentId;
    }
    return entries.reverse();
  }
  async getLeafId() { await this.line; if (this.failure) throw this.failure; return this.tip; }
  async getEntry(id) { await this.line; if (this.failure) throw this.failure; return clone(this.entries.get(id)); }
  async getOpenTurns() { await this.line; return [...this.validator.turns.values()].filter((t) => !t.end).map((t) => clone(t.start)); }
  async getOpenOperations() { await this.line; return [...this.validator.operations.values()].filter((o) => !o.end).map((o) => clone(o.start)); }
  async getTurn(turnId) { await this.line; return clone(this.validator.turns.get(turnId)?.end); }
  async getTerminal(operationId) {
    await this.line;
    const op = this.validator.operations.get(operationId);
    return op?.end ? { ...clone(op.end), config: clone(op.start.payload.config), fromTipId: op.start.payload.baselineTipId,
      tipId: op.end.payload.tipId, status: op.end.payload.status } : undefined;
  }
  sync() { return this.enqueue(() => this.io?.sync()); }
  async close() {
    if (this.closed) return;
    await this.line;
    this.closed = true;
    this.onClose?.(this);
    if (this.failure) throw this.failure;
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
  async create({ id = randomUUID(), cwd = process.cwd() } = {}) {
    if (this.sessions.has(id)) throw new Error("Harness session already exists");
    const metadata = { id, cwd, createdAt: Date.now(), journalId: randomUUID() };
    const data = { metadata, records: [] };
    this.sessions.set(id, data);
    const session = await this.open(metadata);
    await initializeSession(session);
    return session;
  }
  async open(metadata) {
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is already open");
    const data = this.sessions.get(metadata.id);
    if (!data) throw new Error("Harness session not found");
    const session = new SessionStore(data.metadata, data.records, null, (store) => {
      data.records = clone(store.records); this.openSessions.delete(metadata.id);
    });
    this.openSessions.set(metadata.id, session);
    return session;
  }
  async list() { return [...this.sessions.values()].map((s) => clone(s.metadata)); }
  async delete(metadata) {
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    this.sessions.delete(metadata.id);
  }
  async close() { for (const session of this.openSessions.values()) await session.close(); }
}

async function syncPath(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export class JsonlSessionRepo {
  constructor({ sessionsRoot }) {
    this.root = resolve(sessionsRoot);
    this.directory = join(this.root, "mono-v2", "journals");
    this.openSessions = new Map();
  }
  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true });
    if (!(await lstat(this.root)).isDirectory() || !(await lstat(this.directory)).isDirectory()) fail();
  }
  async create({ id = randomUUID(), cwd = process.cwd(), staging = false } = {}) {
    if (!safeId(id)) throw new TypeError("Unsafe Harness session id");
    await this.ensureDirectory();
    if (this.openSessions.has(id) || (await this.listOwned()).some((m) => m.id === id)) throw new Error("Harness session already exists");
    const createdAt = Date.now();
    const journalId = randomUUID();
    const path = join(this.directory, `${journalId}.jsonl${staging ? ".importing" : ""}`);
    const metadata = { id, cwd, createdAt, path, journalId };
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ format: FORMAT, version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id }, ...metadata, path: undefined })}\n`); }
    finally { await handle.close(); }
    const session = await this.open(metadata);
    await initializeSession(session);
    return session;
  }
  async open(metadata) {
    if (metadata.legacy) return this.importLegacy(metadata);
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is already open");
    if (dirname(resolve(metadata.path)) !== this.directory) fail();
    const evidence = await readBoundedJsonl(metadata.path, this.root);
    const [header, ...records] = evidence.records;
    validateJournalHeader(header);
    if (header.id !== metadata.id || header.journalId !== metadata.journalId) fail();
    const storeMetadata = { ...header, path: metadata.path };
    const session = new SessionStore(storeMetadata, records, {
      append: async (text) => {
        const handle = await open(storeMetadata.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        try { await handle.writeFile(text); } finally { await handle.close(); }
      },
      sync: async () => {
        await syncPath(storeMetadata.path);
        await syncPath(this.directory);
        await syncPath(this.root);
      },
    }, () => this.openSessions.delete(metadata.id));
    // A crash may leave an incomplete final record. Validate the complete prefix
    // first, then repair only our OWN file (legacy evidence is never repaired).
    if (evidence.torn) {
      const handle = await open(metadata.path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (stat.ino !== evidence.identity.ino || stat.dev !== evidence.identity.dev || stat.size !== evidence.identity.size) fail();
        await handle.truncate(evidence.completeBytes);
      } finally { await handle.close(); }
    }
    this.openSessions.set(metadata.id, session);
    return session;
  }
  async importLegacy(metadata) {
    const projected = await readLegacySession(metadata, this.root);
    const session = await this.create({ id: metadata.id, cwd: metadata.cwd, staging: projected.status === "import" });
    session.continuity = projected.status;
    if (projected.status === "clean_break") return session;
    try {
      for (const message of projected.messages) await session.appendMessage(message);
      await session.sync();
      const publishedPath = session.metadata.path.replace(/\.importing$/, "");
      await rename(session.metadata.path, publishedPath);
      session.metadata.path = publishedPath;
      await session.sync();
      await archiveLegacySession(metadata, this.root, projected.evidence);
      return session;
    } catch (error) {
      await session.close().catch(() => {});
      await this.delete(session.metadata);
      throw error;
    }
  }
  async listOwned() {
    let files;
    try { files = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const result = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(this.directory, file.name);
      try {
        const { records: [h] } = await readBoundedJsonl(path, this.root);
        validateJournalHeader(h);
        result.push({ ...h, path });
      } catch { /* an invalid transcript is not a resumable session */ }
    }
    return result;
  }
  async list() {
    const owned = await this.listOwned();
    const legacy = await listLegacySessions(this.root);
    return [...owned, ...legacy.filter((m) => !owned.some((n) => n.id === m.id))];
  }
  async delete(metadata) {
    if (this.openSessions.has(metadata.id)) throw new Error("Harness session is open");
    if (!metadata.legacy && dirname(resolve(metadata.path)) !== this.directory) fail();
    try { await unlink(metadata.path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async close() { for (const session of this.openSessions.values()) await session.close(); }
}
