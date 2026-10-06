import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { boundedSwitchBytes, switchDigest, switchHash, switchKeys, switchObject } from "./durable-model-switch-contract.js";
import type { RuntimeNativeJournalAuthority } from "@mono-agent/runtime-adapter";

export const NATIVE_HISTORY_ROOT_FILE = ".native-history-root.json";
export const NATIVE_HISTORY_ROOT_TEMP = /^\.native-history-root\.[a-f0-9]{32}\.tmp$/u;
export const MAX_NATIVE_HISTORY_ROOT_BYTES = 1024;
interface Identity { readonly dev: number; readonly ino: number }
export interface NativeHistoryRootMarker { readonly version: 1; readonly kind: "native-history"; readonly canonicalVersion: 4; readonly rootId: string }
interface Owner {
  assertOwned(): Promise<void>;
  reserve(bytes: number): Promise<void>;
  onPhase?(phase: string): Promise<void>;
}
function unavailable(): never { throw new Error("Native history root authority identity or permissions unavailable"); }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function secure(stat: Stats, directory = false) {
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) unavailable();
  if ((process.platform !== "win32" && (stat.mode & 0o777) !== (directory ? 0o700 : 0o600))
    || (process.getuid && stat.uid !== process.getuid())) unavailable();
}
function validate(value: unknown): asserts value is NativeHistoryRootMarker {
  switchObject(value); switchKeys(value, ["version", "kind", "canonicalVersion", "rootId"]);
  if (value.version !== 1 || value.kind !== "native-history" || value.canonicalVersion !== 4) unavailable();
  switchHash(value.rootId);
}
/** Immutable host format marker, not a native catalogue or dispatch capability.
 * Issuance is administrative only and borrows the caller's drained root transaction. */
export class NativeHistoryRootStore {
  private rootId: string | undefined;
  constructor(private readonly root: string, private readonly identity: Identity) {
    if (!isAbsolute(root)) throw new TypeError("Native history root must be absolute");
  }
  private async assertRoot() { const stat = await lstat(this.root); secure(stat, true); if (!same(stat, this.identity)) unavailable(); }
  private async syncRoot() {
    await this.assertRoot(); const handle = await open(this.root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { if (!same(await handle.stat(), this.identity)) unavailable(); await handle.sync(); }
    finally { await handle.close(); }
    await this.assertRoot();
  }
  private async readFile(name: string): Promise<{ marker: NativeHistoryRootMarker; bytes: number; identity: Stats }> {
    const path = join(this.root, name); await this.assertRoot(); const before = await lstat(path); secure(before);
    if (before.size > MAX_NATIVE_HISTORY_ROOT_BYTES) unavailable();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat(); secure(opened); if (!unchanged(before, opened)) unavailable();
      const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(path); secure(named);
      if (!unchanged(opened, after) || !unchanged(after, named) || bytes.byteLength !== after.size) unavailable();
      const marker: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); validate(marker);
      await this.assertRoot(); return { marker, bytes: bytes.byteLength, identity: named };
    } finally { await handle.close(); }
  }
  async read(): Promise<NativeHistoryRootMarker | undefined> {
    try {
      const { marker } = await this.readFile(NATIVE_HISTORY_ROOT_FILE);
      if (this.rootId !== undefined && marker.rootId !== this.rootId) unavailable();
      this.rootId = marker.rootId; return marker;
    } catch (error) {
      if (!missing(error)) throw error;
      if (this.rootId !== undefined) unavailable();
      return undefined;
    }
  }
  /** Unknown/malformed proposals remain preserved; they cannot issue authority. */
  async bytes(): Promise<number> {
    await this.read();
    let bytes = 0;
    for (const name of await readdir(this.root)) {
      if (name !== NATIVE_HISTORY_ROOT_FILE && !NATIVE_HISTORY_ROOT_TEMP.test(name)) continue;
      const stat = await lstat(join(this.root, name)); secure(stat);
      if (stat.size > MAX_NATIVE_HISTORY_ROOT_BYTES) unavailable(); bytes += stat.size;
      if (name === NATIVE_HISTORY_ROOT_FILE) await this.read();
    }
    return bytes;
  }
  async ensure(owner: Owner): Promise<NativeHistoryRootMarker> {
    await owner.assertOwned(); let marker = await this.read();
    const proposals = (await readdir(this.root)).filter((name) => NATIVE_HISTORY_ROOT_TEMP.test(name)).sort();
    const inspected = await Promise.all(proposals.map(async (name) => ({ name, ...await this.readFile(name) })));
    if (!marker && inspected.length > 1 && inspected.some((entry) => entry.marker.rootId !== inspected[0]!.marker.rootId)) unavailable();
    marker ??= inspected[0]?.marker;
    if (!await this.read()) {
      marker ??= { version: 1, kind: "native-history", canonicalVersion: 4, rootId: randomBytes(32).toString("hex") };
      const bytes = boundedSwitchBytes(marker, MAX_NATIVE_HISTORY_ROOT_BYTES); await owner.reserve(inspected.length ? 0 : bytes.byteLength);
      const name = inspected[0]?.name ?? `.native-history-root.${randomBytes(16).toString("hex")}.tmp`;
      const temporary = join(this.root, name);
      if (!inspected.length) {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
      } else if (switchDigest(inspected[0]!.marker) !== switchDigest(marker)) unavailable();
      await owner.onPhase?.("root_marker_file_synced"); await owner.assertOwned(); await this.assertRoot();
      const prepared = await this.readFile(name); if (switchDigest(prepared.marker) !== switchDigest(marker)) unavailable();
      if (await this.read()) unavailable(); // root transaction excludes legitimate competing issuers
      await rename(temporary, join(this.root, NATIVE_HISTORY_ROOT_FILE));
      await owner.onPhase?.("root_marker_renamed");
    }
    await this.syncRoot(); await owner.onPhase?.("root_marker_directory_synced");
    const current = await this.read(); if (!current || current.rootId !== marker!.rootId) unavailable();
    // Only validated, identical proposals can be discarded after the winner's barrier.
    for (const entry of inspected) {
      if (entry.marker.rootId !== current.rootId) unavailable();
      let named; try { named = await lstat(join(this.root, entry.name)); } catch (error) { if (!missing(error)) throw error; continue; }
      if (!unchanged(named, entry.identity)) unavailable(); await owner.assertOwned(); await rm(join(this.root, entry.name));
      await owner.onPhase?.("root_marker_proposal_removed");
    }
    await this.syncRoot(); await owner.onPhase?.("root_marker_proposals_synced"); await owner.assertOwned(); return current;
  }
  authority(marker: NativeHistoryRootMarker, ownerKey: string, historyBucket: string): RuntimeNativeJournalAuthority {
    const coordinates = { version: 1 as const, canonicalVersion: 4 as const, rootId: marker.rootId, ownerKey, historyBucket };
    return { ...coordinates, authorityId: switchDigest(coordinates) };
  }
}
