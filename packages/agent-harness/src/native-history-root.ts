import { lstat, readdir, rm } from "node:fs/promises";
import { assertIdentity, isOwned, publishAtomic, readOwned, syncDir, unchanged } from "@mono-agent/harness/owned-fs.js";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { boundedSwitchBytes, switchDigest, switchHash, switchKeys, switchObject } from "./durable-model-switch-contract.js";
import type { RuntimeNativeJournalAuthority } from "@mono-agent/runtime-adapter";

export const NATIVE_HISTORY_ROOT_FILE = ".native-history-root.json";
export const NATIVE_HISTORY_ROOT_TEMP = /^\.native-history-root\.[a-f0-9]{32}\.tmp$/u;
export const MAX_NATIVE_HISTORY_ROOT_BYTES = 1024;
interface Identity { readonly dev: number; readonly ino: number }
export interface NativeHistoryRootMarker { readonly version: 1; readonly kind: "native-history";  readonly rootId: string }
interface Owner {
  assertOwned(): Promise<void>;
  reserve(bytes: number): Promise<void>;
  onPhase?(phase: string): Promise<void>;
}
function unavailable(): never { throw new Error("Native history root authority identity or permissions unavailable"); }
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
function validate(value: unknown): asserts value is NativeHistoryRootMarker {
  switchObject(value); switchKeys(value, ["version", "kind", "rootId"]);
  if (value.version !== 1 || value.kind !== "native-history") unavailable();
  switchHash(value.rootId);
}
/** Immutable host format marker, not a native catalogue or dispatch capability.
 * Issuance is administrative only and borrows the caller's drained root transaction. */
export class NativeHistoryRootStore {
  private rootId: string | undefined;
  constructor(private readonly root: string, private readonly identity: Identity) {
    if (!isAbsolute(root)) throw new TypeError("Native history root must be absolute");
  }
  private async assertRoot() { await assertIdentity(this.root, this.identity, unavailable); }
  private syncRoot() { return syncDir(this.root, this.identity, unavailable); }
  /** Root-level authority: any damage here stays fatal for the whole root. */
  private async readFile(name: string) {
    await this.assertRoot(); const { bytes, stat: identity } = await readOwned(join(this.root, name), MAX_NATIVE_HISTORY_ROOT_BYTES);
    const marker: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); validate(marker);
    await this.assertRoot(); return { marker, bytes: bytes.byteLength, identity };
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
      const stat = await lstat(join(this.root, name)); if (!isOwned(stat)) unavailable();
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
      marker ??= { version: 1, kind: "native-history", rootId: randomBytes(32).toString("hex") };
      const bytes = boundedSwitchBytes(marker, MAX_NATIVE_HISTORY_ROOT_BYTES); await owner.reserve(inspected.length ? 0 : bytes.byteLength);
      await publishAtomic({ path: join(this.root, NATIVE_HISTORY_ROOT_FILE),
        temporary: join(this.root, `.native-history-root.${randomBytes(16).toString("hex")}.tmp`), bytes, fail: unavailable, sync: () => this.syncRoot(),
        check: async () => { await owner.assertOwned(); await this.assertRoot(); if (await this.read()) unavailable(); },
        phase: async (step) => { if (["file_synced", "renamed", "directory_synced"].includes(step)) await owner.onPhase?.(`root_marker_${step}`); } });
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
    const coordinates = { version: 1 as const, rootId: marker.rootId, ownerKey, historyBucket };
    return { ...coordinates, authorityId: switchDigest(coordinates) };
  }
}
