import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { MODEL_SWITCH_DIRECTORY, MAX_MODEL_SWITCH_BYTES, MAX_MODEL_SWITCH_FENCE_BYTES, boundedSwitchBytes, canonicalSwitchJSON,
  reservationBytes, serializeModelSwitchState, switchConversationKey, switchDigest, switchHash, switchKeys, switchObject,
  validateModelSwitchFence, validateModelSwitchState, validateSwitchReference } from "./durable-model-switch-contract.js";
import type { HandoffReference, ModelSwitchFence, ModelSwitchPointer, ModelSwitchState } from "./durable-model-switch-contract.js";
import { acceptHandoffReference, admitSummaryAttempt, advanceUnfitProducer, authorizeSummaryMessage, finishSummaryAttempt } from "./model-switch-billing.js";
import type { SummaryAttempt } from "./durable-model-switch-contract.js";

export interface ModelSwitchDirectoryIdentity { readonly dev: number; readonly ino: number }
export interface ModelSwitchStorageOwner {
  readonly ownerKey: string;
  readonly historyBucket: string;
  assertOwned(): Promise<void>;
  /** Host supplies its existing short root transaction, never a provider call. */
  withRootTransaction<T>(action: () => Promise<T>): Promise<T>;
  /** Reserve the initial durable plan (including native retention/header copy)
   * or transient serialized publication space until absolute reconciliation. */
  reserve(bytes: number): Promise<void>;
  /** Idempotently SET (not add/subtract) this intent's remaining provisional
   * reservation under the same root transaction. Physical retained bytes are
   * charged separately; recovery repeats this reconciliation safely. */
  adjustReservation(bytes: number): Promise<void>;
  onPhase?(phase: string): Promise<void>;
}
export interface ModelSwitchArtifact {
  readonly version: 1;
  readonly switchId: string;
  readonly ownerKey: string;
  readonly historyBucket: string;
  readonly attemptId: string | null;
  readonly artifact: Record<string, unknown>;
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: ModelSwitchDirectoryIdentity, b: ModelSwitchDirectoryIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats): boolean => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function unavailable(): never { throw new Error("Model-switch storage ownership, identity or permissions unavailable"); }
function secure(stat: Stats, directory: boolean): void {
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) unavailable();
  if ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || typeof process.getuid === "function" && stat.uid !== process.getuid()) unavailable();
}
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
const filePattern = /^[a-f0-9]{64}\.[a-f0-9]{64}\.(?:fence|[a-f0-9]{32}\.state|[a-f0-9]{64}\.handoff)\.json(?:\.[a-f0-9]{32}\.tmp)?$/u;

/** Additive private storage component; it does not issue canonical authority,
 * settle P2 turns, acquire conversation claims or enable host switching. The
 * durable-history integration must supply those authorities, accounting and
 * deletion transactions. All provider execution remains outside this class. */
export class ModelSwitchPayloadStore {
  private readonly root: string;
  private readonly directory: string;
  private directoryIdentity: ModelSwitchDirectoryIdentity | undefined;
  constructor(root: string, private readonly rootIdentity: ModelSwitchDirectoryIdentity) {
    if (!isAbsolute(root)) throw new TypeError("Model-switch root must be absolute");
    this.root = resolve(root); this.directory = join(this.root, MODEL_SWITCH_DIRECTORY);
  }
  private async assertRoot(): Promise<void> { const stat = await lstat(this.root); secure(stat, true); if (!same(stat, this.rootIdentity)) unavailable(); }
  private async owner(owner: ModelSwitchStorageOwner, state?: ModelSwitchState): Promise<void> {
    await this.assertRoot(); await owner.assertOwned();
    if (state && (state.identity.ownerKey !== owner.ownerKey || state.identity.historyBucket !== owner.historyBucket)) unavailable();
  }
  private async syncDirectory(path: string, identity: ModelSwitchDirectoryIdentity): Promise<void> {
    const before = await lstat(path); secure(before, true); if (!same(before, identity)) unavailable();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!same(stat, before)) unavailable(); await handle.sync(); }
    finally { await handle.close(); }
    const after = await lstat(path); secure(after, true); if (!same(before, after)) unavailable();
  }
  private async ensureDirectory(create: boolean, owner?: ModelSwitchStorageOwner): Promise<ModelSwitchDirectoryIdentity | undefined> {
    await this.assertRoot(); let stat;
    try { stat = await lstat(this.directory); } catch (error) {
      if (!missing(error)) throw error;
      if (this.directoryIdentity) unavailable();
      if (!create) return undefined; if (!owner) unavailable(); await this.owner(owner);
      try { await mkdir(this.directory, { mode: 0o700 }); } catch (failure) { if (!(failure && typeof failure === "object" && "code" in failure && failure.code === "EEXIST")) throw failure; }
      await this.syncDirectory(this.root, this.rootIdentity); stat = await lstat(this.directory);
    }
    secure(stat, true); if (this.directoryIdentity && !same(stat, this.directoryIdentity)) unavailable();
    this.directoryIdentity ??= { dev: stat.dev, ino: stat.ino }; return this.directoryIdentity;
  }
  private async assertDirectory(identity: ModelSwitchDirectoryIdentity): Promise<void> {
    await this.assertRoot(); const current = await lstat(this.directory); secure(current, true); if (!same(current, identity)) unavailable();
  }
  private coordinates(bucket: string, switchId: string): string { switchHash(switchId); return `${switchConversationKey(bucket)}.${switchId}`; }
  private async readBytes(name: string, maximum: number): Promise<Buffer> {
    if (!filePattern.test(name)) unavailable(); const directory = await this.ensureDirectory(false); if (!directory) unavailable();
    const path = join(this.directory, name), before = await lstat(path); secure(before, false); if (before.size > maximum) throw new RangeError("Model-switch serialized file exceeds its limit");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat(); secure(opened, false); if (!unchanged(opened, before)) unavailable();
      const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(path); secure(named, false);
      if (!unchanged(opened, after) || !unchanged(after, named) || bytes.byteLength !== after.size) unavailable();
      await this.assertDirectory(directory); return bytes;
    } finally { await handle.close(); }
  }
  /** Includes orphan generations, artifacts and crashed temps. Never repairs or
   * deletes unknown/torn evidence while measuring capacity. */
  async retainedBytes(): Promise<number> {
    const directory = await this.ensureDirectory(false); if (!directory) return 0;
    let total = 0;
    for (const name of await readdir(this.directory)) {
      if (!filePattern.test(name)) unavailable(); const stat = await lstat(join(this.directory, name)); secure(stat, false);
      if (stat.size > MAX_MODEL_SWITCH_BYTES) throw new RangeError("Model-switch serialized file exceeds its limit");
      total += stat.size; if (!Number.isSafeInteger(total)) unavailable();
    }
    await this.assertDirectory(directory); return total;
  }
  /** Read-only managed-root accounting. Hash-only fence coordinates are resolved
   * exclusively through their validated payload, never guessed from filenames. */
  async inventory(): Promise<{ readonly bytes: number; readonly pending: readonly { readonly state: ModelSwitchState; readonly remainingReservation: number }[] }> {
    const directory = await this.ensureDirectory(false); if (!directory) return { bytes: 0, pending: [] };
    const bytes = await this.retainedBytes(), pending: { state: ModelSwitchState; remainingReservation: number }[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".fence.json")) continue;
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.readBytes(name, MAX_MODEL_SWITCH_FENCE_BYTES)));
      validateModelSwitchFence(raw);
      const prefix = `${raw.conversationKey}.${raw.switchId}`;
      if (name !== `${prefix}.fence.json`) unavailable();
      const payload = await this.readBytes(`${prefix}.${raw.payload.generation}.state.json`, MAX_MODEL_SWITCH_BYTES);
      if (hash(payload) !== raw.payload.sha256) unavailable();
      const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); validateModelSwitchState(decoded);
      const current = await this.read(decoded.identity.historyBucket, raw.switchId);
      if (!current || switchDigest(current.fence) !== switchDigest(raw)) unavailable();
      const cached = decoded.phase === "ready" ? decoded.artifact : await this.cachedArtifact(decoded);
      pending.push({ state: current.state, remainingReservation: reservationBytes(decoded.reservation) - (cached ? decoded.reservation.artifactBytes : 0) });
    }
    await this.assertDirectory(directory); return { bytes, pending };
  }
  private async publish(name: string, bytes: Buffer, owner: ModelSwitchStorageOwner, replace: boolean, label: string): Promise<void> {
    const directory = await this.ensureDirectory(true, owner); if (!directory || !filePattern.test(name)) unavailable();
    const path = join(this.directory, name);
    if (!replace) {
      try { if (!(await this.readBytes(name, MAX_MODEL_SWITCH_BYTES)).equals(bytes)) throw new Error("Immutable model-switch content conflicts"); await this.syncDirectory(this.directory, directory); return; }
      catch (error) { if (!missing(error)) throw error; }
    }
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const createdIdentity = await handle.stat();
    let published = false;
    try {
      await handle.writeFile(bytes); const written = await handle.stat(); secure(written, false); if (written.size !== bytes.byteLength) unavailable();
      await handle.sync(); await owner.onPhase?.(`${label}_file_synced`);
      await this.owner(owner); await this.assertDirectory(directory);
      if (!unchanged(written, await lstat(temporary))) unavailable();
      await rename(temporary, path); published = true; await owner.onPhase?.(`${label}_renamed`);
      await this.syncDirectory(this.directory, directory); await owner.onPhase?.(`${label}_directory_synced`);
      await this.assertDirectory(directory); await this.owner(owner);
    } finally {
      await handle.close();
      if (!published) {
        // Only our open invocation's private temp; crashes leave it charged.
        await this.assertDirectory(directory);
        let named;
        try { named = await lstat(temporary); } catch (error) { if (!missing(error)) throw error; }
        if (named && same(named, createdIdentity)) { await rm(temporary); await this.syncDirectory(this.directory, directory); }
      }
    }
  }
  async read(bucket: string, switchId: string): Promise<{ readonly state: ModelSwitchState; readonly fence: ModelSwitchFence } | undefined> {
    const prefix = this.coordinates(bucket, switchId), directory = await this.ensureDirectory(false); if (!directory) return undefined;
    let bytes;
    try { bytes = await this.readBytes(`${prefix}.fence.json`, MAX_MODEL_SWITCH_FENCE_BYTES); }
    catch (error) { if (!missing(error)) throw error; await this.assertDirectory(directory); return undefined; }
    const fence: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); validateModelSwitchFence(fence);
    if (fence.switchId !== switchId || fence.conversationKey !== switchConversationKey(bucket)) unavailable();
    const payload = await this.readBytes(`${prefix}.${fence.payload.generation}.state.json`, MAX_MODEL_SWITCH_BYTES);
    if (hash(payload) !== fence.payload.sha256) unavailable();
    const state: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); validateModelSwitchState(state);
    if (state.identity.switchId !== switchId || state.identity.historyBucket !== bucket || state.identity.targetEpoch !== fence.targetEpoch) unavailable();
    if (state.phase === "ready") {
      const cached = await this.readArtifact(bucket, switchId, state.artifact!);
      if (cached.ownerKey !== state.identity.ownerKey) unavailable(); this.validateProposal(state, cached.artifact);
      const attempt = state.attempts.find((entry) => entry.id === cached.attemptId);
      if (cached.artifact.producer !== "checkpoint" && (!attempt || attempt.outcome !== "accepted" || switchDigest(attempt.artifact) !== switchDigest(state.artifact))) unavailable();
    }
    return { state, fence };
  }
  private async publishState(state: ModelSwitchState, owner: ModelSwitchStorageOwner): Promise<ModelSwitchPointer> {
    const bytes = serializeModelSwitchState(state), generation = randomBytes(16).toString("hex"), prefix = this.coordinates(state.identity.historyBucket, state.identity.switchId);
    const pointer = { generation, sha256: hash(bytes) };
    const fence: ModelSwitchFence = { version: 6, kind: "model-switch", conversationKey: switchConversationKey(state.identity.historyBucket), switchId: state.identity.switchId,
      targetEpoch: state.identity.targetEpoch, payload: pointer };
    validateModelSwitchFence(fence); const fenceBytes = boundedSwitchBytes(fence, MAX_MODEL_SWITCH_FENCE_BYTES);
    await this.publish(`${prefix}.${generation}.state.json`, bytes, owner, false, "payload");
    await this.publish(`${prefix}.fence.json`, fenceBytes, owner, true, "fence");
    await this.reconcile(state, pointer, owner); return pointer;
  }
  /** Only validated earlier snapshots whose complete admission/authorization
   * journals are retained by the durable winner may be reclaimed. Never erase
   * future/unknown admissions, artifacts, temps, or merely matching filenames. */
  private superseded(before: ModelSwitchState, after: ModelSwitchState): boolean {
    if (switchDigest(before.identity) !== switchDigest(after.identity) || switchDigest(before.reservation) !== switchDigest(after.reservation)
      || before.authorizationGeneration > after.authorizationGeneration) return false;
    if (before.authorizations.some((entry, index) => switchDigest(entry) !== switchDigest(after.authorizations[index] ?? null))) return false;
    for (const entry of before.attempts) {
      const retained = after.attempts.find((candidate) => candidate.id === entry.id);
      if (!retained || entry.outcome !== "started" && switchDigest(entry) !== switchDigest(retained)) return false;
    }
    const order = { outgoing: 0, checkpoint: 1, incoming: 2, pending: 3, ready: 4 };
    return (before.authorizationGeneration < after.authorizationGeneration || order[before.phase] <= order[after.phase])
      && (before.artifact === null || switchDigest(before.artifact) === switchDigest(after.artifact));
  }
  private async reconcile(state: ModelSwitchState, pointer: ModelSwitchPointer, owner: ModelSwitchStorageOwner): Promise<void> {
    await this.owner(owner, state);
    const current = await this.read(state.identity.historyBucket, state.identity.switchId);
    if (!current || switchDigest(current.fence.payload) !== switchDigest(pointer) || switchDigest(current.state) !== switchDigest(state)) unavailable();
    const directory = await this.ensureDirectory(false); if (!directory) unavailable();
    // A recovered rename may have interrupted directory fsync. Establish the
    // winner's publication barrier before removing any prior payload.
    await this.syncDirectory(this.directory, directory);
    const prefix = `${this.coordinates(state.identity.historyBucket, state.identity.switchId)}.`;
    for (const name of await readdir(this.directory)) {
      if (!filePattern.test(name)) unavailable();
      if (!name.startsWith(prefix) || !name.endsWith(".state.json") || name === `${prefix}${pointer.generation}.state.json`) continue;
      const path = join(this.directory, name), before = await lstat(path); secure(before, false);
      const bytes = await this.readBytes(name, MAX_MODEL_SWITCH_BYTES);
      const previous: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); validateModelSwitchState(previous);
      if (!this.superseded(previous, state)) continue;
      await this.owner(owner, state); await this.assertDirectory(directory);
      const named = await lstat(path); secure(named, false); if (!unchanged(before, named)) unavailable();
      await rm(path); await owner.onPhase?.("obsolete_state_removed");
    }
    await this.syncDirectory(this.directory, directory); await owner.onPhase?.("obsolete_states_directory_synced");
    // Keep fixed canonical/native/header-copy/pending estimates conservative.
    // Once content is durable its physical bytes replace, not supplement, the
    // provisional artifact cap. Absolute reconciliation is crash-idempotent.
    const cached = state.phase === "ready" ? state.artifact : await this.cachedArtifact(state);
    await owner.adjustReservation(reservationBytes(state.reservation) - (cached ? state.reservation.artifactBytes : 0));
    await this.owner(owner, state); await owner.onPhase?.("reservation_adjusted");
  }
  async begin(state: ModelSwitchState, owner: ModelSwitchStorageOwner): Promise<ModelSwitchState> {
    validateModelSwitchState(state); state = structuredClone(state);
    if (state.phase !== "outgoing" || state.attempts.length || state.authorizations.length) throw new Error("Switch intent must begin before producer admission");
    await this.owner(owner, state);
    return owner.withRootTransaction(async () => {
      await this.owner(owner, state);
      const directory = await this.ensureDirectory(false);
      if (directory) {
        const key = `${switchConversationKey(state.identity.historyBucket)}.`;
        for (const name of await readdir(this.directory)) {
          if (!filePattern.test(name)) unavailable();
          if (name.startsWith(key) && name.endsWith(".fence.json") && name !== `${this.coordinates(state.identity.historyBucket, state.identity.switchId)}.fence.json`) {
            throw new Error("Existing switch must roll forward and settle before a different intent");
          }
        }
      }
      const current = await this.read(state.identity.historyBucket, state.identity.switchId);
      if (current) {
        if (switchDigest(current.state.identity) !== switchDigest(state.identity) || switchDigest(current.state.reservation) !== switchDigest(state.reservation)) throw new Error("Switch intent identity conflicts");
        const directory = await this.ensureDirectory(false); if (!directory) unavailable();
        await this.syncDirectory(this.directory, directory); await this.owner(owner, current.state);
        await this.reconcile(current.state, current.fence.payload, owner);
        return current.state; // never reverse/restart an admitted durable intent
      }
      const serialized = serializeModelSwitchState(state);
      if (state.reservation.pendingBytes < serialized.byteLength + MAX_MODEL_SWITCH_FENCE_BYTES) throw new RangeError("Switch pending reservation is too small");
      await owner.reserve(reservationBytes(state.reservation)); await owner.onPhase?.("reserved");
      await this.publishState(state, owner); return structuredClone(state);
    });
  }
  private async update(bucket: string, switchId: string, owner: ModelSwitchStorageOwner, change: (state: ModelSwitchState) => ModelSwitchState): Promise<ModelSwitchState> {
    await this.owner(owner);
    return owner.withRootTransaction(async () => {
      const current = await this.read(bucket, switchId); if (!current) throw new Error("Switch intent is absent"); await this.owner(owner, current.state);
      await this.reconcile(current.state, current.fence.payload, owner);
      if (current.state.phase !== "ready" && await this.cachedArtifact(current.state)) throw new Error("Cached handoff must roll forward before producer advancement");
      const next = change(current.state); validateModelSwitchState(next);
      if (canonicalSwitchJSON(next) === canonicalSwitchJSON(current.state)) return next;
      await owner.reserve(serializeModelSwitchState(next).byteLength + MAX_MODEL_SWITCH_FENCE_BYTES);
      await this.publishState(next, owner); return next;
    });
  }
  admit(bucket: string, switchId: string, producer: SummaryAttempt["producer"], owner: ModelSwitchStorageOwner): Promise<ModelSwitchState> {
    return this.update(bucket, switchId, owner, (state) => admitSummaryAttempt(state, producer));
  }
  finish(bucket: string, switchId: string, producer: SummaryAttempt["producer"], outcome: "unknown" | "rejected", owner: ModelSwitchStorageOwner): Promise<ModelSwitchState> {
    return this.update(bucket, switchId, owner, (state) => finishSummaryAttempt(state, producer, outcome));
  }
  advanceUnfit(bucket: string, switchId: string, owner: ModelSwitchStorageOwner): Promise<ModelSwitchState> {
    return this.update(bucket, switchId, owner, advanceUnfitProducer);
  }
  authorizeMessage(bucket: string, switchId: string, messageDigest: string, owner: ModelSwitchStorageOwner): Promise<ModelSwitchState> {
    return this.update(bucket, switchId, owner, (state) => authorizeSummaryMessage(state, messageDigest));
  }
  /** File publication is the ONLY content authority. Caller proposes already
   * validated/fitting P3a content; this layer checks identity/protocol and JSON
   * bounds. It never invokes a producer or infers approval from summary text. */
  async accept(bucket: string, switchId: string, artifact: Record<string, unknown>, owner: ModelSwitchStorageOwner): Promise<HandoffReference> {
    boundedSwitchBytes(artifact, MAX_MODEL_SWITCH_BYTES); // reject oversized/non-JSON data before cloning can erase prototypes
    artifact = structuredClone(artifact);
    await this.owner(owner);
    return owner.withRootTransaction(async () => {
      const current = await this.read(bucket, switchId); if (!current) throw new Error("Switch intent is absent"); await this.owner(owner, current.state);
      const state = current.state;
      await this.reconcile(state, current.fence.payload, owner);
      this.validateProposal(state, artifact);
      const attempt = state.attempts.find((entry) => entry.generation === state.authorizationGeneration && entry.producer === artifact.producer);
      if (state.phase !== "ready" && artifact.producer !== state.phase) throw new Error("Handoff producer does not match durable admission");
      const envelope: ModelSwitchArtifact = { version: 1, switchId, ownerKey: state.identity.ownerKey, historyBucket: bucket,
        attemptId: attempt?.id ?? null, artifact: structuredClone(artifact) };
      const bytes = boundedSwitchBytes(envelope, MAX_MODEL_SWITCH_BYTES), reference = { id: hash(bytes), hash: hash(bytes) };
      const next = acceptHandoffReference(state, reference); await this.owner(owner, next);
      if (bytes.byteLength > state.reservation.artifactBytes) throw new RangeError("Handoff exceeds reserved artifact capacity");
      // Ready replay does not consume another reservation or rewrite content.
      if (state.phase === "ready") {
        await this.readArtifact(bucket, switchId, reference);
        const directory = await this.ensureDirectory(false); if (!directory) unavailable();
        await this.syncDirectory(this.directory, directory); await this.owner(owner, state);
        await this.reconcile(state, current.fence.payload, owner); return reference;
      }
      const cached = await this.cachedArtifact(state);
      if (cached && switchDigest(cached) !== switchDigest(reference)) throw new Error("Immutable accepted output conflicts with cached artifact");
      // Artifact bytes are already covered by the initial provisional cap.
      await owner.reserve(serializeModelSwitchState(next).byteLength + MAX_MODEL_SWITCH_FENCE_BYTES);
      await this.publish(`${this.coordinates(bucket, switchId)}.${reference.id}.handoff.json`, bytes, owner, false, "artifact");
      await this.publishState(next, owner); return reference;
    });
  }
  private validateProposal(state: ModelSwitchState, artifact: Record<string, unknown>): void {
    switchObject(artifact); switchKeys(artifact, ["version", "policy", "coverage", "summary", "checkpoint", "recent", "ledger", "retainedIds", "producer", "timestamp", "target", "budget"]);
    const sources = state.identity.sources.map(({ ordinal, epoch: _epoch, ...source }) => ({ ...source, epoch: ordinal }));
    if (artifact.version !== 1 || artifact.policy !== state.identity.projectionPolicy || !Array.isArray(artifact.recent) || !Array.isArray(artifact.ledger)
      || !Array.isArray(artifact.retainedIds) || artifact.timestamp !== state.identity.timestamp || !["outgoing", "checkpoint", "incoming"].includes(artifact.producer as string)
      || switchDigest(artifact.coverage) !== switchDigest(sources) || switchDigest(artifact.budget) !== state.identity.frozenBudgetDigest
      || switchDigest(artifact.target) !== switchDigest(state.identity.targetProvenance)) throw new Error("Handoff proposal changed frozen source/target/budget or protocol");
  }
  private async cachedArtifact(state: ModelSwitchState): Promise<HandoffReference | undefined> {
    const directory = await this.ensureDirectory(false); if (!directory) return undefined;
    const prefix = this.coordinates(state.identity.historyBucket, state.identity.switchId), candidates: HandoffReference[] = [];
    for (const name of await readdir(this.directory)) {
      if (!filePattern.test(name)) unavailable();
      if (!name.startsWith(`${prefix}.`) || !name.endsWith(".handoff.json")) continue;
      const id = name.slice(prefix.length + 1, -".handoff.json".length), reference = { id, hash: id };
      const cached = await this.readArtifact(state.identity.historyBucket, state.identity.switchId, reference);
      if (cached.ownerKey !== state.identity.ownerKey) unavailable(); this.validateProposal(state, cached.artifact);
      const attempt = state.attempts.find((entry) => entry.generation === state.authorizationGeneration && entry.producer === cached.artifact.producer);
      if (cached.artifact.producer !== state.phase || cached.attemptId !== (attempt?.id ?? null)) continue;
      candidates.push(reference);
    }
    await this.assertDirectory(directory); if (candidates.length > 1) throw new Error("Conflicting immutable artifacts for the same producer admission"); return candidates[0];
  }
  /** Storage-only accepted-cache recovery: no provider, retry, tools or new
   * authorization generation. A requested old model cannot reverse this intent. */
  async recoverArtifact(bucket: string, switchId: string, owner: ModelSwitchStorageOwner): Promise<HandoffReference | undefined> {
    await this.owner(owner);
    return owner.withRootTransaction(async () => {
      const current = await this.read(bucket, switchId); if (!current) return undefined; await this.owner(owner, current.state);
      await this.reconcile(current.state, current.fence.payload, owner);
      if (current.state.phase === "ready") return current.state.artifact!;
      const reference = await this.cachedArtifact(current.state); if (!reference) return undefined;
      const next = acceptHandoffReference(current.state, reference);
      await owner.reserve(serializeModelSwitchState(next).byteLength + MAX_MODEL_SWITCH_FENCE_BYTES);
      await this.publishState(next, owner); return reference;
    });
  }
  async readArtifact(bucket: string, switchId: string, reference: HandoffReference): Promise<ModelSwitchArtifact> {
    validateSwitchReference(reference);
    const bytes = await this.readBytes(`${this.coordinates(bucket, switchId)}.${reference.id}.handoff.json`, MAX_MODEL_SWITCH_BYTES);
    if (hash(bytes) !== reference.hash || reference.id !== reference.hash) unavailable();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); switchObject(value);
    switchKeys(value, ["version", "switchId", "ownerKey", "historyBucket", "attemptId", "artifact"]);
    if (value.version !== 1 || value.switchId !== switchId || value.historyBucket !== bucket) unavailable();
    switchObject(value.artifact); if (value.attemptId !== null) switchHash(value.attemptId);
    return value as unknown as ModelSwitchArtifact;
  }
}
