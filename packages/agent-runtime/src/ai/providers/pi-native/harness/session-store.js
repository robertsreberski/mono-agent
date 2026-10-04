// Mono-owned append-only single-main-branch store. No provider execution here.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readBoundedJsonl, MAX_LINE } from "./bounded-jsonl.js";
import { archiveLegacySession, listLegacySessions, readLegacySession } from "./legacy-import.js";

const FORMAT = "mono-pi-session";
const clone = (v) => structuredClone(v);
const fail = () => { throw new Error("Invalid mono Pi session"); };
const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");

export class SessionStore {
  constructor(metadata, records, io, onClose) {
    this.metadata = metadata;
    this.io = io;
    this.onClose = onClose;
    this.records = [];
    this.entries = new Map();
    this.tip = null;
    this.turns = new Map();
    this.seq = 0;
    this.line = Promise.resolve();
    this.closed = false;
    this.failure = null;
    for (const record of records) this.apply(record);
  }
  validateRecord(record) {
    if (!Number.isSafeInteger(record.seq) || record.seq !== this.seq + 1) fail();
    if (record.kind === "entry") {
      const e = record.entry;
      if (!e || typeof e.id !== "string" || this.entries.has(e.id) || e.parentId !== this.tip
        || !Number.isSafeInteger(e.timestamp) || !["message", "compaction", "branch_summary"].includes(e.type)) fail();
    } else if (record.kind === "rollback") {
      if (record.tipId !== null && !this.entries.has(record.tipId)) fail();
    } else if (record.kind === "turn_open") {
      if (typeof record.runId !== "string" || this.turns.has(record.runId)
        || [...this.turns.values()].some((t) => t.kind === "turn_open") || record.fromTipId !== this.tip) fail();
    } else if (record.kind === "turn_close") {
      if (this.turns.get(record.runId)?.kind !== "turn_open" || record.tipId !== this.tip
        || !["completed", "failed", "aborted"].includes(record.status)) fail();
    } else fail();
  }
  apply(record) {
    this.validateRecord(record);
    if (record.kind === "entry") {
      this.entries.set(record.entry.id, clone(record.entry)); this.tip = record.entry.id;
    } else if (record.kind === "rollback") this.tip = record.tipId;
    else if (record.kind === "turn_open") this.turns.set(record.runId, clone(record));
    else this.turns.set(record.runId, { ...clone(this.turns.get(record.runId)), ...clone(record) });
    this.seq = record.seq;
    this.records.push(clone(record));
  }
  enqueue(fn) {
    const result = this.line.then(async () => {
      if (this.closed) throw new Error("Pi session is closed");
      if (this.failure) throw this.failure;
      return fn();
    });
    this.line = result.catch((error) => { this.failure = error; });
    return result;
  }
  write(makeRecord) {
    return this.enqueue(async () => {
      const record = { ...makeRecord(), seq: this.seq + 1 };
      const text = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(text) > MAX_LINE) throw new Error("Pi session record is too large");
      this.validateRecord(record);
      await this.io?.append(text);
      this.apply(record);
      return record;
    });
  }
  async appendEntry(data, id = randomUUID()) {
    const record = await this.write(() => ({ kind: "entry", entry: { ...clone(data), id,
      parentId: this.tip, timestamp: Date.now(), seq: this.seq + 1 } }));
    return record.entry.id;
  }
  appendMessage(message, id) { return this.appendEntry({ type: "message", message }, id); }
  appendCompaction(data) { return this.appendEntry({ ...data, type: "compaction" }); }
  async moveTo(tipId) { await this.write(() => ({ kind: "rollback", tipId })); return tipId; }
  openTurn(runId, config) { return this.write(() => ({ kind: "turn_open", runId, fromTipId: this.tip, config: clone(config) })); }
  closeTurn(runId, status) { return this.write(() => ({ kind: "turn_close", runId, status, tipId: this.tip })); }
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
  async getOpenTurns() { await this.line; return [...this.turns.values()].filter((t) => t.kind === "turn_open").map(clone); }
  async getTerminal(runId) { await this.line; return clone(this.turns.get(runId)); }
  sync() { return this.enqueue(() => this.io?.sync()); }
  async close() {
    if (this.closed) return;
    await this.line;
    this.closed = true;
    this.onClose?.(this);
    if (this.failure) throw this.failure;
  }
}

export class MemorySessionRepo {
  constructor() { this.sessions = new Map(); this.openSessions = new Map(); }
  async create({ id = randomUUID(), cwd = process.cwd() } = {}) {
    if (this.sessions.has(id)) throw new Error("Pi session already exists");
    const metadata = { id, cwd, createdAt: Date.now() };
    const data = { metadata, records: [] };
    this.sessions.set(id, data);
    return this.open(metadata);
  }
  async open(metadata) {
    if (this.openSessions.has(metadata.id)) throw new Error("Pi session is already open");
    const data = this.sessions.get(metadata.id);
    if (!data) throw new Error("Pi session not found");
    const session = new SessionStore(data.metadata, data.records, null, (store) => {
      data.records = clone(store.records); this.openSessions.delete(metadata.id);
    });
    this.openSessions.set(metadata.id, session);
    return session;
  }
  async list() { return [...this.sessions.values()].map((s) => clone(s.metadata)); }
  async delete(metadata) {
    if (this.openSessions.has(metadata.id)) throw new Error("Pi session is open");
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
    this.directory = join(this.root, "mono-v1");
    this.openSessions = new Map();
  }
  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true });
    if (!(await lstat(this.root)).isDirectory() || !(await lstat(this.directory)).isDirectory()) fail();
  }
  async create({ id = randomUUID(), cwd = process.cwd(), staging = false } = {}) {
    if (!safeId(id)) throw new TypeError("Unsafe Pi session id");
    await this.ensureDirectory();
    if (this.openSessions.has(id) || (await this.listOwned()).some((m) => m.id === id)) throw new Error("Pi session already exists");
    const createdAt = Date.now();
    const path = join(this.directory, `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl${staging ? ".importing" : ""}`);
    const metadata = { id, cwd, createdAt, path };
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ format: FORMAT, version: 1, ...metadata, path: undefined })}\n`); }
    finally { await handle.close(); }
    return this.open(metadata);
  }
  async open(metadata) {
    if (metadata.legacy) return this.importLegacy(metadata);
    if (this.openSessions.has(metadata.id)) throw new Error("Pi session is already open");
    if (dirname(resolve(metadata.path)) !== this.directory) fail();
    const evidence = await readBoundedJsonl(metadata.path, this.root);
    const [header, ...records] = evidence.records;
    if (header?.format !== FORMAT || header.version !== 1 || header.id !== metadata.id) fail();
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
        if (h?.format === FORMAT && h.version === 1) result.push({ ...h, path });
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
    if (this.openSessions.has(metadata.id)) throw new Error("Pi session is open");
    if (!metadata.legacy && dirname(resolve(metadata.path)) !== this.directory) fail();
    try { await unlink(metadata.path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async close() { for (const session of this.openSessions.values()) await session.close(); }
}
