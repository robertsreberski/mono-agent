import { lstat, readdir, rm } from "node:fs/promises";
import { assertIdentity, isOwned, publishAtomic, readOwned, syncDir } from "@mono-agent/engine/owned-fs.js";
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
  /** Root-level authority: any damage to the committed marker stays fatal for the whole root. */
  async read(): Promise<NativeHistoryRootMarker | undefined> {
    try {
      await this.assertRoot(); const { bytes } = await readOwned(join(this.root, NATIVE_HISTORY_ROOT_FILE), MAX_NATIVE_HISTORY_ROOT_BYTES);
      const marker: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); validate(marker); await this.assertRoot();
      if (this.rootId !== undefined && marker.rootId !== this.rootId) unavailable();
      this.rootId = marker.rootId; return marker;
    } catch (error) {
      if (!missing(error)) throw error;
      if (this.rootId !== undefined) unavailable();
      return undefined;
    }
  }
  /** Leftover proposals stay charged until the next bootstrap removes them. */
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
  /** Runs only under the caller's root transaction, so a leftover proposal is a
   * dead issuer's and its rootId was never used: authority exists only after
   * publication. Remove owned leftovers (even torn ones) and publish fresh. */
  async ensure(owner: Owner): Promise<NativeHistoryRootMarker> {
    await owner.assertOwned(); let marker = await this.read(), removed = false;
    for (const name of await readdir(this.root)) {
      if (!NATIVE_HISTORY_ROOT_TEMP.test(name)) continue;
      const stat = await lstat(join(this.root, name)); if (!isOwned(stat) || stat.size > MAX_NATIVE_HISTORY_ROOT_BYTES) unavailable();
      await owner.assertOwned(); await rm(join(this.root, name)); removed = true; await owner.onPhase?.("root_marker_proposal_removed");
    }
    if (removed) { await this.syncRoot(); await owner.onPhase?.("root_marker_proposals_synced"); }
    if (!marker) {
      marker = { version: 1, kind: "native-history", rootId: randomBytes(32).toString("hex") };
      const bytes = boundedSwitchBytes(marker, MAX_NATIVE_HISTORY_ROOT_BYTES); await owner.reserve(bytes.byteLength);
      await publishAtomic({ path: join(this.root, NATIVE_HISTORY_ROOT_FILE),
        temporary: join(this.root, `.native-history-root.${randomBytes(16).toString("hex")}.tmp`), bytes, fail: unavailable, sync: () => this.syncRoot(),
        check: async () => { await owner.assertOwned(); await this.assertRoot(); if (await this.read()) unavailable(); },
        phase: async (step) => { if (["file_synced", "renamed", "directory_synced"].includes(step)) await owner.onPhase?.(`root_marker_${step}`); } });
    } else { await this.syncRoot(); await owner.onPhase?.("root_marker_directory_synced"); }
    const current = await this.read(); if (!current || current.rootId !== marker.rootId) unavailable();
    await owner.assertOwned(); return current;
  }
  authority(marker: NativeHistoryRootMarker, ownerKey: string, historyBucket: string): RuntimeNativeJournalAuthority {
    const coordinates = { version: 1 as const, rootId: marker.rootId, ownerKey, historyBucket };
    return { ...coordinates, authorityId: switchDigest(coordinates) };
  }
}
