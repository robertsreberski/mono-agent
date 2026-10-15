import { lstat, mkdir, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { OwnedFileDamagedError, assertIdentity, isOwned, listOwned, publishAtomic, readOwned, sameIdentity, syncDir, unchanged } from "@mono-agent/agent-runtime/engine/owned-fs.js";
import {
  MAX_PENDING_TURN_BYTES, PENDING_TURN_DIRECTORY,
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
  /** A matching artifact failing the owned-file rule: charged, never collected,
   * and it refuses only operations of its own conversation. */
  readonly damaged?: true;
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
/** Generations and crash temps; any other name (`.DS_Store`, foreign temps,
 * subdirectories) is never read, charged or deleted. */
const ENTRY = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{32})\.json(?:\.tmp)?$/u;
function unavailable(): never { throw new Error("Pending turn storage identity or permissions unavailable"); }
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
  private async assertRoot(): Promise<void> { await assertIdentity(this.root, this.rootIdentity, unavailable); }
  private async ensureDirectory(create: boolean, owner?: PendingPayloadOwner): Promise<PendingDirectoryIdentity | undefined> {
    await this.assertRoot();
    let info;
    try { info = await lstat(this.directory); }
    catch (error) {
      if (!missing(error) || this.directoryIdentity !== undefined) throw error;
      if (!create) return undefined;
      if (!owner) unavailable(); await owner.assertOwned();
      try { await mkdir(this.directory, { mode: 0o700 }); } catch (mkdirError) { if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError; }
      await syncDir(this.root, this.rootIdentity, unavailable); info = await lstat(this.directory);
    }
    if (!isOwned(info, true) || (this.directoryIdentity && !sameIdentity(info, this.directoryIdentity))) unavailable();
    this.directoryIdentity ??= { dev: info.dev, ino: info.ino };
    await this.assertRoot(); return this.directoryIdentity;
  }
  private async assertDirectory(identity: PendingDirectoryIdentity): Promise<void> {
    await this.assertRoot(); await assertIdentity(this.directory, identity, unavailable);
  }
  async list(): Promise<readonly PendingPayloadEntry[]> {
    const directory = await this.ensureDirectory(false); if (!directory) return [];
    const entries = (await listOwned(this.directory, ENTRY, MAX_PENDING_TURN_BYTES)).map(({ name, match, stat, damaged }) => ({
      conversationKey: match[1]!, runIdDigest: match[2]!, generation: match[3]!, name, bytes: stat.size, mtimeMs: stat.mtimeMs, ...(damaged ? { damaged: true as const } : {}) }));
    await this.assertDirectory(directory); return entries;
  }
  async publish(value: PendingTurnPayload, owner: PendingPayloadOwner): Promise<PendingTurnPointer> {
    // Validate/measure before touching disk or consuming capacity.
    const bytes = serializePendingTurnPayload(value); const coordinates = pendingCoordinates(value.identity);
    await owner.assertOwned(); await owner.reserve(bytes.byteLength);
    const directory = await this.ensureDirectory(true, owner); if (!directory) unavailable();
    await owner.assertOwned(); const generation = randomBytes(16).toString("hex");
    const path = join(this.directory, pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, generation));
    // Ordinary faults cannot leave a torn final generation. SIGKILL may leave a
    // charged temp; exact-owner collection removes it.
    await publishAtomic({ path, temporary: `${path}.tmp`, bytes, fail: unavailable, sync: () => syncDir(this.directory, directory, unavailable),
      check: async () => { await this.assertDirectory(directory); await owner.assertOwned(); },
      phase: async (step) => { if (step === "file_synced" || step === "directory_synced") await owner.onPhase?.(step); } });
    await this.assertDirectory(directory); await owner.assertOwned();
    return { generation, sha256: sha256(bytes) };
  }
  /** Root-held drain only: active markers exclude live owners, and publication
   * cannot enter while the caller holds the root transaction. Final generations
   * and damaged temps remain untouched. No payload parsing grants authority. */
  async collectInactiveTemps(active: ReadonlySet<string>, owner: PendingPayloadOwner): Promise<void> {
    await owner.assertOwned(); const directory = await this.ensureDirectory(false); if (!directory) return;
    const victims = (await listOwned(this.directory, ENTRY, MAX_PENDING_TURN_BYTES))
      .filter(({ name, match, damaged }) => name.endsWith(".tmp") && !active.has(match[1]!) && !damaged);
    for (const { name, stat } of victims) {
      await this.assertDirectory(directory); await owner.assertOwned();
      if (!unchanged(stat, await lstat(join(this.directory, name)))) unavailable();
      await rm(join(this.directory, name));
    }
    if (victims.length) await syncDir(this.directory, directory, unavailable);
  }
  /** Secure, read-only discovery of orphan identity for an explicit logical reset.
   * The filename must agree with the parsed payload; discovery grants no owner.
   * An unreadable or malformed generation is an OwnedFileDamagedError. */
  async inspect(entry: Pick<PendingPayloadEntry, "name">, expectedDigest?: string): Promise<{ readonly payload: PendingTurnPayload; readonly pointer: PendingTurnPointer }> {
    const match = ENTRY.exec(entry.name); if (!match) throw new Error("Unsupported pending turn artifact");
    const directory = await this.ensureDirectory(false); if (!directory) throw new Error("Pending payload is absent");
    const { bytes } = await readOwned(join(this.directory, entry.name), MAX_PENDING_TURN_BYTES);
    if (expectedDigest !== undefined && sha256(bytes) !== expectedDigest) throw new Error("Pending turn payload digest mismatch");
    let payload;
    try { payload = parsePendingTurnPayload(bytes); } catch (error) { throw new OwnedFileDamagedError(entry.name, error); }
    const coordinates = pendingCoordinates(payload.identity);
    if (coordinates.conversationKey !== match[1] || coordinates.runIdDigest !== match[2]) throw new Error("Pending payload filename/identity mismatch");
    await this.assertDirectory(directory);
    return { payload, pointer: { generation: match[3]!, sha256: sha256(bytes) } };
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
  /** Damaged evidence at these coordinates refuses the owner and is never
   * collected; every victim is validated before any is removed. */
  async collectUnreferenced(coordinates: PendingPayloadCoordinates, keep: readonly PendingTurnPointer[], owner: PendingPayloadOwner): Promise<number> {
    for (const pointer of keep) validateTurnPointer(pointer);
    pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, "0".repeat(32));
    await owner.assertOwned(); const directory = await this.ensureDirectory(false); if (!directory) return 0;
    const retain = new Set(keep.map((pointer) => pointer.generation));
    const victims = (await listOwned(this.directory, ENTRY, MAX_PENDING_TURN_BYTES)).filter(({ match }) => match[1] === coordinates.conversationKey
      && match[2] === coordinates.runIdDigest && !retain.has(match[3]!));
    for (const entry of victims) {
      if (entry.damaged) throw new OwnedFileDamagedError(entry.name);
      if (!entry.name.endsWith(".tmp")) await this.inspect(entry);
    }
    for (const { name, stat } of victims) {
      await this.assertDirectory(directory); await owner.assertOwned();
      if (!unchanged(stat, await lstat(join(this.directory, name)))) unavailable();
      await rm(join(this.directory, name));
    }
    if (victims.length) { await syncDir(this.directory, directory, unavailable); await owner.onPhase?.("removed"); }
    await this.assertDirectory(directory); await owner.assertOwned(); return victims.length;
  }
}
