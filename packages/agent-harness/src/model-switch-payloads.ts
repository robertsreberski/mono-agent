import { lstat, mkdir, rm } from "node:fs/promises";
import { OwnedFileDamagedError, assertIdentity, isOwned, listOwned, publishAtomic, readOwned, sameIdentity as same, syncDir, unchanged } from "@mono-agent/agent-runtime/engine/owned-fs.js";
import { randomBytes, createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { MODEL_SWITCH_DIRECTORY, MAX_MODEL_SWITCH_BYTES, ModelSwitchMessageConsumedError, MAX_MODEL_SWITCH_FENCE_BYTES, boundedSwitchBytes, canonicalSwitchJSON,
  reservationBytes, serializeModelSwitchState, switchConversationKey, switchDigest, switchCoverageDigest, switchHash, switchKeys, switchObject,
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
/** @internal Exact publication framing shared with native selection preflight. */
export function serializeModelSwitchArtifact(state: ModelSwitchState, artifact: Record<string, unknown>, attemptId: string | null): Buffer {
  const envelope: ModelSwitchArtifact = { version: 1, switchId: state.identity.switchId, ownerKey: state.identity.ownerKey,
    historyBucket: state.identity.historyBucket, attemptId, artifact };
  return boundedSwitchBytes(envelope, MAX_MODEL_SWITCH_BYTES);
}

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function unavailable(): never { throw new Error("Model-switch storage ownership, identity or permissions unavailable"); }
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
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
  private async assertRoot(): Promise<void> { await assertIdentity(this.root, this.rootIdentity, unavailable); }
  private async owner(owner: ModelSwitchStorageOwner, state?: ModelSwitchState): Promise<void> {
    await this.assertRoot(); await owner.assertOwned();
    if (state && (state.identity.ownerKey !== owner.ownerKey || state.identity.historyBucket !== owner.historyBucket)) unavailable();
  }
  private syncDirectory(path: string, identity: ModelSwitchDirectoryIdentity): Promise<void> { return syncDir(path, identity, unavailable); }
  private async ensureDirectory(create: boolean, owner?: ModelSwitchStorageOwner): Promise<ModelSwitchDirectoryIdentity | undefined> {
    let stat;
    try { stat = await lstat(this.directory); } catch (error) {
      if (!missing(error)) throw error;
      if (this.directoryIdentity) unavailable();
      if (!create) return undefined; if (!owner) unavailable(); await this.owner(owner);
      try { await mkdir(this.directory, { mode: 0o700 }); } catch (failure) { if (!(failure && typeof failure === "object" && "code" in failure && failure.code === "EEXIST")) throw failure; }
      await this.syncDirectory(this.root, this.rootIdentity); stat = await lstat(this.directory);
    }
    await this.assertRoot();
    if (!isOwned(stat, true) || (this.directoryIdentity && !same(stat, this.directoryIdentity))) unavailable();
    this.directoryIdentity ??= { dev: stat.dev, ino: stat.ino }; return this.directoryIdentity;
  }
  private async assertDirectory(identity: ModelSwitchDirectoryIdentity): Promise<void> {
    await this.assertRoot(); await assertIdentity(this.directory, identity, unavailable);
  }
  /** Artifact-named entries only; strays are skipped, damage is returned flagged. */
  private entries(prefix = "") {
    return listOwned(this.directory, filePattern, MAX_MODEL_SWITCH_BYTES, prefix);
  }
  private coordinates(bucket: string, switchId: string): string { switchHash(switchId); return `${switchConversationKey(bucket)}.${switchId}`; }
  private async readBytes(name: string, maximum: number): Promise<Buffer> {
    if (!filePattern.test(name)) unavailable(); const directory = await this.ensureDirectory(false); if (!directory) unavailable();
    const { bytes } = await readOwned(join(this.directory, name), maximum);
    await this.assertDirectory(directory); return bytes;
  }
  /** Includes orphan generations, artifacts, crashed temps and damaged entries.
   * Never repairs or deletes unknown/torn evidence while measuring capacity. */
  async retainedBytes(): Promise<number> { return this.conversationBytes(); }
  async conversationBytes(bucket?: string): Promise<number> {
    const directory = await this.ensureDirectory(false); if (!directory) return 0;
    const total = (await this.entries(bucket === undefined ? "" : `${switchConversationKey(bucket)}.`)).reduce((sum, entry) => sum + entry.bytes, 0);
    if (!Number.isSafeInteger(total)) unavailable();
    await this.assertDirectory(directory); return total;
  }
  /** Whole-owner D cleanup, or (with `keep`) removal of earlier switches once a
   * newer canonical receipt supersedes them. The durable host intent retains
   * membership; fences are removed first so interrupted collection cannot leave
   * dangling pointers that poison unrelated inventory. Exact-coordinate orphan
   * temps are authorized like pending-turn reset generations, never guessed owners. */
  async removeConversation(bucket: string, ownerKey: string, assertOwned: () => Promise<void>, onPhase: (phase: string) => Promise<void>, keep?: string): Promise<void> {
    const directory = await this.ensureDirectory(false); if (!directory) return;
    const prefix = `${switchConversationKey(bucket)}.`;
    const inspected = [];
    for (const { name, stat: identity, damaged } of await this.entries(prefix)) {
      if (keep !== undefined && name.startsWith(`${prefix}${keep}.`)) continue;
      if (damaged) throw new OwnedFileDamagedError(name); // damaged own evidence is never removed
      if (!name.endsWith(".tmp")) {
        const raw = decode(await this.readBytes(name, MAX_MODEL_SWITCH_BYTES));
        if (name.endsWith(".state.json")) {
          validateModelSwitchState(raw); if (raw.identity.historyBucket !== bucket || raw.identity.ownerKey !== ownerKey || raw.identity.switchId !== name.split(".")[1]) unavailable();
        } else if (name.endsWith(".fence.json")) { validateModelSwitchFence(raw); if (raw.conversationKey !== switchConversationKey(bucket)) unavailable(); }
        else {
          const [, switchId, artifactId] = name.split(".");
          const artifact = await this.readArtifact(bucket, switchId!, { id: artifactId!, hash: artifactId! });
          if (artifact.ownerKey !== ownerKey) unavailable();
        }
      }
      inspected.push({ name, identity });
    }
    inspected.sort((a, b) => Number(b.name.endsWith(".fence.json")) - Number(a.name.endsWith(".fence.json")) || a.name.localeCompare(b.name));
    for (const { name, identity } of inspected) {
      await assertOwned(); await this.assertDirectory(directory);
      const path = join(this.directory, name), named = await lstat(path); if (!isOwned(named) || !unchanged(identity, named)) unavailable();
      await rm(path); await onPhase("lifecycle_switch_file_removed");
      await this.syncDirectory(this.directory, directory);
    }
    await this.syncDirectory(this.directory, directory); await assertOwned();
  }
  /** Read-only managed-root accounting. Hash-only fence coordinates are resolved
   * exclusively through their validated payload, never guessed from filenames.
   * Every artifact name starts with its conversation key: an entry that fails
   * to read or validate marks only that conversation `damaged` (bytes still
   * charged, never pending, never removed). Root identity failures stay fatal. */
  async inventory(bucket?: string): Promise<{ readonly bytes: number; readonly pending: readonly { readonly state: ModelSwitchState; readonly remainingReservation: number; readonly remainingPendingBytes: number }[];
    readonly damaged: readonly string[]; readonly damagedFiles: readonly string[] }> {
    const directory = await this.ensureDirectory(false); if (!directory) return { bytes: 0, pending: [], damaged: [], damagedFiles: [] };
    const entries = await this.entries(bucket === undefined ? undefined : `${switchConversationKey(bucket)}.`), key = (name: string) => name.slice(0, 64);
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    const pending: { state: ModelSwitchState; remainingReservation: number; remainingPendingBytes: number }[] = [];
    const damagedFiles = new Set(entries.filter((entry) => entry.damaged).map((entry) => entry.name));
    const damaged = new Set([...damagedFiles].map(key));
    const isolate = async (name: string, action: () => Promise<void>) => {
      if (damaged.has(key(name))) return;
      try { await action(); } catch (error) {
        await this.assertDirectory(directory);
        // Read-only preflight may overlap removal of an obsolete, just-listed
        // entry. Absence is a changed inventory, not evidence of owner damage.
        if (missing(error)) {
          try { await lstat(join(this.directory, name)); }
          catch (changed) { if (missing(changed)) return; throw changed; }
        }
        damaged.add(key(name)); damagedFiles.add(name);
      }
    };
    // Every final state and artifact (fenced, retained or orphan) must parse and
    // match its filename coordinates; otherwise it is its owner's damage.
    for (const { name } of entries) if (name.endsWith(".state.json") || name.endsWith(".handoff.json")) await isolate(name, async () => {
      const [, switchId, id] = name.split("."), raw = decode(await this.readBytes(name, MAX_MODEL_SWITCH_BYTES));
      if (name.endsWith(".state.json")) {
        validateModelSwitchState(raw);
        if (raw.identity.switchId !== switchId || switchConversationKey(raw.identity.historyBucket) !== key(name)) unavailable();
      } else {
        const bucket = (raw as { historyBucket?: unknown } | null)?.historyBucket;
        if (typeof bucket !== "string" || switchConversationKey(bucket) !== key(name)) unavailable();
        await this.readArtifact(bucket, switchId!, { id: id!, hash: id! });
      }
    });
    for (const { name } of entries) if (name.endsWith(".fence.json")) await isolate(name, async () => {
      const fenceBytes = await this.readBytes(name, MAX_MODEL_SWITCH_FENCE_BYTES), raw = decode(fenceBytes);
      validateModelSwitchFence(raw);
      const prefix = `${raw.conversationKey}.${raw.switchId}`;
      if (name !== `${prefix}.fence.json`) unavailable();
      const payload = await this.readBytes(`${prefix}.${raw.payload.generation}.state.json`, MAX_MODEL_SWITCH_BYTES);
      if (hash(payload) !== raw.payload.sha256) unavailable();
      const decoded = decode(payload); validateModelSwitchState(decoded);
      const current = await this.read(decoded.identity.historyBucket, raw.switchId);
      if (!current || switchDigest(current.fence) !== switchDigest(raw)) unavailable();
      const cached = decoded.phase === "ready" ? decoded.artifact : await this.cachedArtifact(decoded);
      pending.push({ state: current.state, ...this.remainingReservation(decoded, payload.byteLength + fenceBytes.byteLength, !!cached) });
    });
    await this.assertDirectory(directory);
    return { bytes, pending: pending.filter((entry) => !damaged.has(switchConversationKey(entry.state.identity.historyBucket))), damaged: [...damaged], damagedFiles: [...damagedFiles] };
  }
  private remainingReservation(state: ModelSwitchState, publicationBytes: number, cached: boolean) {
    const remainingPendingBytes = Math.max(0, state.reservation.pendingBytes - publicationBytes);
    return { remainingPendingBytes, remainingReservation: reservationBytes(state.reservation)
      - state.reservation.pendingBytes + remainingPendingBytes - (cached ? state.reservation.artifactBytes : 0) };
  }
  private async publish(name: string, bytes: Buffer, owner: ModelSwitchStorageOwner, replace: boolean, label: string): Promise<void> {
    const directory = await this.ensureDirectory(true, owner); if (!directory || !filePattern.test(name)) unavailable();
    const path = join(this.directory, name);
    if (!replace) {
      try { if (!(await this.readBytes(name, MAX_MODEL_SWITCH_BYTES)).equals(bytes)) throw new Error("Immutable model-switch content conflicts"); await this.syncDirectory(this.directory, directory); return; }
      catch (error) { if (!missing(error)) throw error; }
    }
    // Only this invocation's private temp is ever removed; crashes leave it charged.
    await publishAtomic({ path, temporary: `${path}.${randomBytes(16).toString("hex")}.tmp`, bytes, fail: unavailable,
      sync: () => this.syncDirectory(this.directory, directory),
      check: async () => { await this.owner(owner); await this.assertDirectory(directory); },
      phase: async (step) => { if (step === "file_synced" || step === "renamed" || step === "directory_synced") await owner.onPhase?.(`${label}_${step}`); } });
    await this.assertDirectory(directory); await this.owner(owner);
  }
  async read(bucket: string, switchId: string): Promise<{ readonly state: ModelSwitchState; readonly fence: ModelSwitchFence } | undefined> {
    const prefix = this.coordinates(bucket, switchId), directory = await this.ensureDirectory(false); if (!directory) return undefined;
    let bytes;
    try { bytes = await this.readBytes(`${prefix}.fence.json`, MAX_MODEL_SWITCH_FENCE_BYTES); }
    catch (error) { if (!missing(error)) throw error; await this.assertDirectory(directory); return undefined; }
    const fence = decode(bytes); validateModelSwitchFence(fence);
    if (fence.switchId !== switchId || fence.conversationKey !== switchConversationKey(bucket)) unavailable();
    const payload = await this.readBytes(`${prefix}.${fence.payload.generation}.state.json`, MAX_MODEL_SWITCH_BYTES);
    if (hash(payload) !== fence.payload.sha256) unavailable();
    const state = decode(payload); validateModelSwitchState(state);
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
    for (const { name, stat: before, damaged } of await this.entries(prefix)) {
      if (!name.endsWith(".state.json") || name === `${prefix}${pointer.generation}.state.json`) continue;
      if (damaged) throw new OwnedFileDamagedError(name);
      const previous = decode(await this.readBytes(name, MAX_MODEL_SWITCH_BYTES)); validateModelSwitchState(previous);
      if (!this.superseded(previous, state)) continue;
      await this.owner(owner, state); await this.assertDirectory(directory);
      const path = join(this.directory, name), named = await lstat(path); if (!isOwned(named) || !unchanged(before, named)) unavailable();
      await rm(path); await owner.onPhase?.("obsolete_state_removed");
    }
    await this.syncDirectory(this.directory, directory); await owner.onPhase?.("obsolete_states_directory_synced");
    // Current state/fence bytes consume their pending plan; orphan generations
    // and crash temps remain fully charged in addition to that live publication.
    // Keep fixed canonical/native/header-copy estimates conservative.
    // Once content is durable its physical bytes replace, not supplement, the
    // provisional artifact cap. Absolute reconciliation is crash-idempotent.
    const cached = state.phase === "ready" ? state.artifact : await this.cachedArtifact(state);
    const publicationBytes = (await this.readBytes(`${prefix}${pointer.generation}.state.json`, MAX_MODEL_SWITCH_BYTES)).byteLength
      + (await this.readBytes(`${prefix}fence.json`, MAX_MODEL_SWITCH_FENCE_BYTES)).byteLength;
    await owner.adjustReservation(this.remainingReservation(state, publicationBytes, !!cached).remainingReservation);
    await this.owner(owner, state); await owner.onPhase?.("reservation_adjusted");
  }
  async begin(state: ModelSwitchState, owner: ModelSwitchStorageOwner): Promise<ModelSwitchState> {
    validateModelSwitchState(state); state = structuredClone(state);
    if (state.phase !== "outgoing" || state.attempts.length || state.authorizations.length) throw new Error("Switch intent must begin before producer admission");
    await this.owner(owner, state);
    return owner.withRootTransaction(async () => {
      await this.owner(owner, state);
      const directory = await this.ensureDirectory(false), own = `${this.coordinates(state.identity.historyBucket, state.identity.switchId)}.`;
      if (directory) {
        for (const { name } of await this.entries(`${switchConversationKey(state.identity.historyBucket)}.`)) {
          if (name.endsWith(".fence.json") && name !== `${own}fence.json`) {
            throw new Error("Existing switch must roll forward and settle before a different intent");
          }
        }
      }
      const current = await this.read(state.identity.historyBucket, state.identity.switchId);
      if (current) {
        if (current.state.initialMessageDigest !== state.initialMessageDigest) throw new Error("Switch initiating message identity conflicts");
        if (switchDigest(current.state.identity) !== switchDigest(state.identity) || switchDigest(current.state.reservation) !== switchDigest(state.reservation)) throw new Error("Switch intent identity conflicts");
        const directory = await this.ensureDirectory(false); if (!directory) unavailable();
        await this.syncDirectory(this.directory, directory); await this.owner(owner, current.state);
        await this.reconcile(current.state, current.fence.payload, owner);
        return current.state; // never reverse/restart an admitted durable intent
      }
      await this.assertMessageUnconsumed(state.identity.historyBucket, state.identity.switchId, state.initialMessageDigest);
      const serialized = serializeModelSwitchState(state);
      if (state.reservation.pendingBytes < serialized.byteLength + MAX_MODEL_SWITCH_FENCE_BYTES) throw new RangeError("Switch pending reservation is too small");
      await owner.reserve(reservationBytes(state.reservation)); await owner.onPhase?.("reserved");
      await this.publishState(state, owner); return structuredClone(state);
    });
  }
  /** Retained billing state is the redelivery guard, until a later completed
   * switch garbage-collects it. No separate message ledger is maintained. */
  async assertMessageUnconsumed(bucket: string, switchId: string, digest: string | undefined): Promise<void> {
    if (!digest || !await this.ensureDirectory(false)) return;
    const own = `${this.coordinates(bucket, switchId)}.`;
    for (const { name } of await this.entries(`${switchConversationKey(bucket)}.`)) {
      if (!name.endsWith(".state.json") || name.startsWith(own)) continue;
      const prior = decode(await this.readBytes(name, MAX_MODEL_SWITCH_BYTES)); validateModelSwitchState(prior);
      if ([prior.initialMessageDigest, ...prior.authorizations.map((entry) => entry.messageDigest)].includes(digest)) throw new ModelSwitchMessageConsumedError();
    }
  }
  private async update(bucket: string, switchId: string, owner: ModelSwitchStorageOwner, change: (state: ModelSwitchState) => ModelSwitchState, messageDigest?: string): Promise<ModelSwitchState> {
    await this.owner(owner);
    return owner.withRootTransaction(async () => {
      const current = await this.read(bucket, switchId); if (!current) throw new Error("Switch intent is absent"); await this.owner(owner, current.state);
      await this.reconcile(current.state, current.fence.payload, owner);
      if (current.state.phase !== "ready" && await this.cachedArtifact(current.state)) throw new Error("Cached handoff must roll forward before producer advancement");
      await this.assertMessageUnconsumed(bucket, switchId, messageDigest);
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
    return this.update(bucket, switchId, owner, (state) => authorizeSummaryMessage(state, messageDigest), messageDigest);
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
      const bytes = serializeModelSwitchArtifact(state, artifact, attempt?.id ?? null), reference = { id: hash(bytes), hash: hash(bytes) };
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
    const sources = state.identity.source ? [(({ epoch: _epoch, ...source }) => source)(state.identity.source)] : [];
    if (artifact.version !== 1 || artifact.policy !== state.identity.projectionPolicy || !Array.isArray(artifact.recent) || !Array.isArray(artifact.ledger)
      || !Array.isArray(artifact.retainedIds) || artifact.timestamp !== state.identity.timestamp || !["outgoing", "checkpoint", "incoming"].includes(artifact.producer as string)
      || switchCoverageDigest(artifact.coverage) !== switchCoverageDigest(sources) || switchDigest(artifact.budget) !== state.identity.frozenBudgetDigest
      || switchDigest(artifact.target) !== switchDigest(state.identity.targetProvenance)) throw new Error("Handoff proposal changed frozen source/target/budget or protocol");
  }
  private async cachedArtifact(state: ModelSwitchState): Promise<HandoffReference | undefined> {
    const directory = await this.ensureDirectory(false); if (!directory) return undefined;
    const prefix = this.coordinates(state.identity.historyBucket, state.identity.switchId), candidates: HandoffReference[] = [];
    for (const { name } of await this.entries(`${prefix}.`)) {
      if (!name.endsWith(".handoff.json")) continue;
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
  /** Re-establish a recovered fence-unlink publication barrier. */
  async syncPublication(): Promise<void> {
    const directory = await this.ensureDirectory(false); if (directory) await this.syncDirectory(this.directory, directory);
  }
  /** Canonical/native publication precedes fence release. Retain the winning
   * ready attempt/content for reference lifetime and D deletion. */
  complete(bucket: string, switchId: string, owner: ModelSwitchStorageOwner, assertCanonicalReady: () => Promise<void>): Promise<void> {
    return this.releaseIntent(bucket, switchId, owner, true, assertCanonicalReady);
  }
  /** Storage-only abandonment of a non-ready intent, which has no target journal
   * yet. Only its fence is released: the billing state (every authorization and
   * attempt, including outcome-unknown ones) and any artifacts stay retained and
   * charged until a later completed switch or D deletion collects them. */
  abandon(bucket: string, switchId: string, owner: ModelSwitchStorageOwner): Promise<void> {
    return this.releaseIntent(bucket, switchId, owner, false, async () => {});
  }
  private async releaseIntent(bucket: string, switchId: string, owner: ModelSwitchStorageOwner, ready: boolean, assertCanonical: () => Promise<void>): Promise<void> {
    await owner.withRootTransaction(async () => {
      await this.owner(owner); const current = await this.read(bucket, switchId);
      await assertCanonical();
      if (!current) { await this.syncPublication(); return; }
      if ((current.state.phase === "ready") !== ready) throw new Error(ready ? "Pending switch cannot release its intent fence" : "A ready switch must roll forward, never be abandoned");
      await this.owner(owner, current.state); await this.reconcile(current.state, current.fence.payload, owner);
      if (!ready && await this.cachedArtifact(current.state)) throw new Error("A cached handoff must roll forward, never be abandoned");
      const name = `${this.coordinates(bucket, switchId)}.fence.json`, directory = await this.ensureDirectory(false); if (!directory) unavailable();
      const before = await this.readBytes(name, MAX_MODEL_SWITCH_FENCE_BYTES), label = ready ? "switch_fence" : "switch_abandon";
      await this.owner(owner, current.state); await assertCanonical();
      if (!(await this.readBytes(name, MAX_MODEL_SWITCH_FENCE_BYTES)).equals(before)) unavailable();
      await rm(join(this.directory, name)); await owner.onPhase?.(`${label}_removed`);
      await this.syncDirectory(this.directory, directory); await owner.onPhase?.(`${label}_directory_synced`);
      await this.owner(owner, current.state); await owner.adjustReservation(0);
    });
  }
  async readArtifact(bucket: string, switchId: string, reference: HandoffReference): Promise<ModelSwitchArtifact> {
    validateSwitchReference(reference);
    const bytes = await this.readBytes(`${this.coordinates(bucket, switchId)}.${reference.id}.handoff.json`, MAX_MODEL_SWITCH_BYTES);
    if (hash(bytes) !== reference.hash || reference.id !== reference.hash) unavailable();
    const value = decode(bytes); switchObject(value);
    switchKeys(value, ["version", "switchId", "ownerKey", "historyBucket", "attemptId", "artifact"]);
    if (value.version !== 1 || value.switchId !== switchId || value.historyBucket !== bucket) unavailable();
    switchObject(value.artifact); if (value.attemptId !== null) switchHash(value.attemptId);
    return value as unknown as ModelSwitchArtifact;
  }
}
