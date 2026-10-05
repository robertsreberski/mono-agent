import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  MAX_PENDING_TURN_BYTES, PENDING_FILE_PATTERN, PENDING_TURN_DIRECTORY,
  parsePendingTurnPayload, pendingPayloadName, serializePendingTurnPayload, sha256, validateTurnPointer,
} from "./durable-turn-contract.js";
import type { PendingTurnIdentity, PendingTurnPayload, PendingTurnPointer } from "./durable-turn-contract.js";

export interface PendingDirectoryIdentity { readonly dev: number; readonly ino: number }
export interface PendingPayloadCoordinates { readonly conversationKey: string; readonly runIdDigest: string }
export interface PendingPayloadEntry extends PendingPayloadCoordinates {
  readonly generation: string;
  readonly name: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}
export type PendingPayloadPhase = "file_synced" | "directory_synced" | "removed";
export interface PendingPayloadOwner {
  /** Prove exact logical/physical ownership, or authorized root-held retention
   * of an inactive, settled exact victim. Never a PID/age-only deletion claim. */
  assertOwned(): Promise<void>;
  /** Reserve aggregate staged bytes under the caller's root transaction. */
  reserve(bytes: number): Promise<void>;
  /** Controlled fault seam; never part of a payload or fence. */
  onPhase?(phase: PendingPayloadPhase): Promise<void>;
}
const same = (a: PendingDirectoryIdentity, b: PendingDirectoryIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats): boolean => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function unavailable(): never { throw new Error("Pending turn storage identity or permissions unavailable"); }
function secure(info: Stats, directory: boolean): void {
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) unavailable();
  if ((info.mode & 0o777) !== (directory ? 0o700 : 0o600)) unavailable();
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) unavailable();
}
function noFollow(): number {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Pending turn storage requires no-follow support");
  return constants.O_NOFOLLOW;
}
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
export function pendingCoordinates(identity: Pick<PendingTurnIdentity, "historyBucket" | "turnId">): PendingPayloadCoordinates {
  return { conversationKey: createHash("sha256").update("mono-agent-history-v1\0").update(identity.historyBucket, "utf8").digest("hex"),
    runIdDigest: createHash("sha256").update("mono-agent-provider-dirty-run-v1\0").update(identity.turnId, "utf8").digest("hex") };
}

/**
 * Immutable P2b payload generations. This private I/O component never inspects
 * native journals, canonical history or provider state and owns no lock itself.
 * Every mutation requires an exact owner assertion supplied by durable history.
 */
export class PendingTurnPayloadStore {
  private readonly root: string;
  private readonly directory: string;
  private directoryIdentity: PendingDirectoryIdentity | undefined;
  constructor(root: string, private readonly rootIdentity: PendingDirectoryIdentity) {
    if (!isAbsolute(root)) throw new TypeError("Pending payload root must be absolute");
    this.root = resolve(root); this.directory = join(this.root, PENDING_TURN_DIRECTORY);
  }
  private async assertRoot(): Promise<void> {
    const info = await lstat(this.root); secure(info, true); if (!same(info, this.rootIdentity)) unavailable();
  }
  private async ensureDirectory(create: boolean, owner?: PendingPayloadOwner): Promise<PendingDirectoryIdentity | undefined> {
    await this.assertRoot();
    let info;
    try { info = await lstat(this.directory); }
    catch (error) {
      if (!missing(error) || this.directoryIdentity !== undefined) throw error;
      if (!create) return undefined;
      if (!owner) unavailable(); await owner.assertOwned();
      try { await mkdir(this.directory, { mode: 0o700 }); } catch (mkdirError) { if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError; }
      await this.syncDirectory(this.root, this.rootIdentity); info = await lstat(this.directory);
    }
    secure(info, true);
    if (this.directoryIdentity && !same(info, this.directoryIdentity)) unavailable();
    this.directoryIdentity ??= { dev: info.dev, ino: info.ino };
    await this.assertRoot(); return this.directoryIdentity;
  }
  private async assertDirectory(identity: PendingDirectoryIdentity): Promise<void> {
    await this.assertRoot(); const info = await lstat(this.directory); secure(info, true); if (!same(info, identity)) unavailable();
  }
  private async syncDirectory(path: string, identity: PendingDirectoryIdentity): Promise<void> {
    const before = await lstat(path); secure(before, true); if (!same(before, identity)) unavailable();
    const handle = await open(path, constants.O_RDONLY | noFollow());
    try { const opened = await handle.stat(); secure(opened, true); if (!same(opened, before)) unavailable(); await handle.sync(); }
    finally { await handle.close(); }
    const after = await lstat(path); secure(after, true); if (!same(before, after)) unavailable();
  }
  async list(): Promise<readonly PendingPayloadEntry[]> {
    const directory = await this.ensureDirectory(false); if (!directory) return [];
    const entries: PendingPayloadEntry[] = [];
    for (const name of (await readdir(this.directory)).sort()) {
      const match = PENDING_FILE_PATTERN.exec(name.endsWith(".tmp") ? name.slice(0, -4) : name); if (!match) throw new Error("Unsupported pending turn artifact");
      const info = await lstat(join(this.directory, name)); secure(info, false);
      if (info.size > MAX_PENDING_TURN_BYTES) throw new RangeError("Pending turn artifact exceeds 16 MiB");
      entries.push({ conversationKey: match[1]!, runIdDigest: match[2]!, generation: match[3]!, name, bytes: info.size, mtimeMs: info.mtimeMs });
    }
    await this.assertDirectory(directory); return entries;
  }
  async publish(value: PendingTurnPayload, owner: PendingPayloadOwner): Promise<PendingTurnPointer> {
    // Validate/measure before touching disk or consuming capacity.
    const bytes = serializePendingTurnPayload(value); const coordinates = pendingCoordinates(value.identity);
    await owner.assertOwned(); await owner.reserve(bytes.byteLength);
    const directory = await this.ensureDirectory(true, owner); if (!directory) unavailable();
    await owner.assertOwned(); const generation = randomBytes(16).toString("hex");
    const name = pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, generation), path = join(this.directory, name);
    const temporaryPath = `${path}.tmp`;
    const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
    let published = false;
    try {
      await handle.writeFile(bytes); const before = await handle.stat(); secure(before, false);
      if (before.size !== bytes.byteLength) throw new Error("Pending payload short write");
      await handle.sync(); await owner.onPhase?.("file_synced");
      const current = await lstat(temporaryPath); secure(current, false); if (!unchanged(before, current)) unavailable();
      await this.assertDirectory(directory); await owner.assertOwned();
      await rename(temporaryPath, path); published = true;
      const named = await lstat(path); secure(named, false);
      if (!same(before, named) || before.size !== named.size) unavailable();
      await this.syncDirectory(this.directory, directory); await owner.onPhase?.("directory_synced");
      await this.assertDirectory(directory); await owner.assertOwned();
      return { generation, sha256: sha256(bytes) };
    } finally {
      await handle.close();
      if (!published) {
        // Ordinary pre-publication faults cannot leave a torn final generation.
        // SIGKILL may leave a charged temp; exact-owner collection removes it.
        try { await this.assertDirectory(directory); await owner.assertOwned(); await rm(temporaryPath, { force: true }); await this.syncDirectory(this.directory, directory); }
        catch { /* Preserve/charge uncertain cleanup; do not mask the publication failure. */ }
      }
    }
  }
  /** Secure, read-only discovery of orphan identity for an explicit logical reset.
   * The filename must agree with the parsed payload; discovery grants no owner. */
  async inspect(entry: Pick<PendingPayloadEntry, "name">, expectedDigest?: string): Promise<{ readonly payload: PendingTurnPayload; readonly pointer: PendingTurnPointer }> {
    const match = PENDING_FILE_PATTERN.exec(entry.name.endsWith(".tmp") ? entry.name.slice(0, -4) : entry.name); if (!match) throw new Error("Unsupported pending turn artifact");
    const directory = await this.ensureDirectory(false); if (!directory) throw new Error("Pending payload is absent");
    const path = join(this.directory, entry.name), before = await lstat(path); secure(before, false);
    if (before.size > MAX_PENDING_TURN_BYTES) throw new RangeError("Pending turn payload exceeds 16 MiB");
    const handle = await open(path, constants.O_RDONLY | noFollow());
    try {
      const opened = await handle.stat(); secure(opened, false); if (!unchanged(before, opened)) unavailable();
      const bytes = await handle.readFile(); const after = await handle.stat(), named = await lstat(path);
      secure(after, false); secure(named, false); if (!unchanged(opened, after) || !unchanged(after, named) || bytes.byteLength !== after.size) unavailable();
      if (expectedDigest !== undefined && sha256(bytes) !== expectedDigest) throw new Error("Pending turn payload digest mismatch");
      const payload = parsePendingTurnPayload(bytes), coordinates = pendingCoordinates(payload.identity);
      if (coordinates.conversationKey !== match[1] || coordinates.runIdDigest !== match[2]) throw new Error("Pending payload filename/identity mismatch");
      await this.assertDirectory(directory);
      return { payload, pointer: { generation: match[3]!, sha256: sha256(bytes) } };
    } finally { await handle.close(); }
  }
  async read(pointer: PendingTurnPointer, expected: PendingTurnIdentity): Promise<PendingTurnPayload> {
    validateTurnPointer(pointer); const coordinates = pendingCoordinates(expected);
    const entry = await this.inspect({ name: pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, pointer.generation) }, pointer.sha256);
    if (entry.pointer.sha256 !== pointer.sha256) throw new Error("Pending turn payload digest mismatch");
    for (const key of ["purpose", "ownerKey", "historyBucket", "turnId", "handleId", "modelKey", "baseRevision", "fenceDigest"] as const) {
      if (entry.payload.identity[key] !== expected[key]) throw new Error("Pending turn payload owner/binding mismatch");
    }
    return entry.payload;
  }
  async collectUnreferenced(coordinates: PendingPayloadCoordinates, keep: readonly PendingTurnPointer[], owner: PendingPayloadOwner): Promise<number> {
    for (const pointer of keep) validateTurnPointer(pointer);
    pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, "0".repeat(32));
    await owner.assertOwned(); const directory = await this.ensureDirectory(false); if (!directory) return 0;
    const retain = new Set(keep.map((pointer) => pointer.generation)); let removed = 0;
    for (const entry of await this.list()) {
      if (entry.conversationKey !== coordinates.conversationKey || entry.runIdDigest !== coordinates.runIdDigest || retain.has(entry.generation)) continue;
      await this.assertDirectory(directory); await owner.assertOwned();
      const path = join(this.directory, entry.name), before = await lstat(path); secure(before, false);
      const handle = await open(path, constants.O_RDONLY | noFollow());
      try { const opened = await handle.stat(); secure(opened, false); if (!unchanged(before, opened) || !unchanged(opened, await lstat(path))) unavailable(); await this.assertDirectory(directory); await rm(path); }
      finally { await handle.close(); }
      removed += 1;
    }
    if (removed) { await this.syncDirectory(this.directory, directory); await owner.onPhase?.("removed"); }
    await this.assertDirectory(directory); await owner.assertOwned(); return removed;
  }
}
