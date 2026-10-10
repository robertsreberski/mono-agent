import type { RuntimeNativeJournalAuthority, RuntimeNativeJournalStorage, RuntimeNativeSwitchContext, RuntimeNativeColdEpochContext } from "@mono-agent/runtime-adapter";
import { NativeHistoryRootStore, NATIVE_HISTORY_ROOT_FILE, NATIVE_HISTORY_ROOT_TEMP, MAX_NATIVE_HISTORY_ROOT_BYTES } from "./native-history-root.js";
import { ModelSwitchPayloadStore } from "./model-switch-payloads.js";
import type { ModelSwitchStorageOwner } from "./model-switch-payloads.js";
import { MODEL_SWITCH_DIRECTORY, ModelSwitchCapacityError, switchDigest, validateModelSwitchState, validateTurnHistoryV4, recognizesModelSwitchBinding, MAX_JOURNAL_CHAIN, validateJournalChain, validateFrozenHandoffBudget, switchHash, validateSwitchReference } from "./durable-model-switch-contract.js";
import type { ModelSwitchState, HandoffReference, SummaryAttempt, TurnHistoryV4, CanonicalJournalDescriptor } from "./durable-model-switch-contract.js";
import { pendingTurnDescriptor, turnInputDigest, turnCandidateDigest, projectTurnSettlement } from "./durable-turn-settlement.js";
import { recognizesTurnCommit, validateTurnHistoryV3 } from "./durable-turn-history.js";
import type { TurnHistoryV3 } from "./durable-turn-history.js";
import type { DurableTurnReceipt, PendingTurnPointer, PendingTurnPayload, PendingTurnInput, PendingTurnCandidate, DurableTurnFence } from "./durable-turn-contract.js";
import { PendingTurnPayloadStore } from "./durable-turn-payloads.js";
import { PENDING_TURN_DIRECTORY, DurableTurnAlreadyCommittedError, validateDurableTurnFence, serializeDurableTurnFence, createPendingTurnPayload, createPendingInitialInput, durableTurnFenceDigest, pendingPayloadName, serializePendingTurnPayload } from "./durable-turn-contract.js";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import {
  AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES,
  AGENT_CONTEXT_IMPORT_MAX_IDEMPOTENCY_KEY_BYTES,
  AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES,
  AGENT_CONTEXT_IMPORT_VERSION,
  AGENT_CONTEXT_IMPORT_SYSTEM_PROVENANCE,
  type AgentContextImportRequest,
  type AgentContextImportResult,
} from "@mono-agent/agent-contracts";

import type { HistoryMessage } from "./context/index.js";
import type {
  ConversationHistoryProviderSessionTurn,
  ConversationHistoryExclusiveTurn,
  ConversationHistoryContextImport,
  ConversationHistoryStore,
  ConversationHistoryTurnInspector,
  ConversationHistoryTurnRecovery,
  ConversationHistoryTurnDrainOptions,
  ConversationHistoryTurnDrainResult,
  PreparedHistoryAppend,
  ProviderSessionTurnCommitOptions,
  ProviderSessionTurnBinding,
} from "./types.js";
import { assertSessionModelKey, ProviderSessionModelChangedError, uniqueSessionHandles, type ProviderSessionHandle } from "./session-runtime.js";
import { isProcessAlive } from "./history-process-liveness.js";

const LEGACY_STORE_VERSION = 1;
const PROVIDER_STORE_VERSION = 2;
const STORE_VERSION = 3;
const DEFAULT_MAX_MESSAGES = 64;
const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;
const MAX_MESSAGE_ENVELOPE_BYTES = 16 * 1024;
// JSON may encode one content byte as a six-byte escape (for example, NUL).
const MAX_MESSAGE_SERIALIZED_BYTES = MAX_MESSAGE_CONTENT_BYTES * 6 + MAX_MESSAGE_ENVELOPE_BYTES;
const MAX_STORE_FILE_BYTES = DEFAULT_MAX_MESSAGES * MAX_MESSAGE_SERIALIZED_BYTES + 64 * 1024;
const MAX_APPEND_MESSAGES = DEFAULT_MAX_MESSAGES;
const DEFAULT_MAX_STORE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CONVERSATIONS = 10_000;
const DEFAULT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const HISTORY_FILE_SUFFIX = ".history.json";
const LOCKS_DIRECTORY = ".locks";
const TOOL_HISTORY_DIRECTORY = "tool-history";
const TOOL_HISTORY_OWNER_FILE = "tool-lifecycles-owner.sqlite";
const ROOT_LOCK_FILE = "root.sqlite";
const NATIVE_OPERATION_PATTERN = /^\.native-history-op\.([a-f0-9]{64})\.json$/u;
const MAX_NATIVE_OPERATION_BYTES = 2 * MAX_STORE_FILE_BYTES + 4096;
type NativeHistoryIo = {
  <T>(action: () => Promise<T>): Promise<T>;
  isRootHeld(): boolean;
};
interface NativeHistoryOperation {
  readonly version: 1 | 2; readonly disposition: "C" | "D";
  readonly coldSwitch?: NativeColdSwitch;
  readonly source: TurnHistoryV4; readonly next: CanonicalHistoryFile | null;
  readonly timestamp: number;
}
interface NativeColdSwitch {
  readonly messageDigest: string;
  readonly targetProvenance: CanonicalJournalDescriptor["provenance"];
  readonly reason: "chain_limit" | "capacity" | "journal_missing";
}
const CONVERSATION_LOCK_SHARDS = 16;
const LOGICAL_SESSION_LOCK_SHARDS = 16;
const MAX_SESSION_CLAIMS_PER_SHARD = 1_024;
const MAX_SESSION_CLAIM_FILE_BYTES = 1024 * 1024;
const MAX_SESSION_CLAIM_JOURNAL_BYTES = 2 * MAX_SESSION_CLAIM_FILE_BYTES;
const CONVERSATION_SHARD_LOCK_PATTERN = /^conversation-shard-([a-f0-9]{2})\.sqlite$/u;
const LOGICAL_SESSION_SHARD_LOCK_PATTERN = /^logical-session-shard-([a-f0-9]{2})\.sqlite$/u;
const LOGICAL_SESSION_SHARD_JOURNAL_PATTERN = /^logical-session-shard-([a-f0-9]{2})\.sqlite-journal$/u;
const TEMP_FILE_PATTERN = /^\.([a-f0-9]{64})\.([0-9]+)\.[a-f0-9]{24}\.tmp$/u;
const HISTORY_FILE_PATTERN = /^[a-f0-9]{64}\.history\.json$/u;
const LEGACY_CONVERSATION_LOCK_PATTERN = /^[a-f0-9]{64}\.sqlite$/u;
const ACTIVE_MARKER_PATTERN = /^([a-f0-9]{64})\.([0-9]+)\.([a-f0-9]{32})\.active$/u;
const DIRTY_FENCE_PATTERN = /^([a-f0-9]{64})\.dirty\.json$/u;
const DIRTY_FENCE_TEMP_PATTERN = /^\.([a-f0-9]{64})\.([0-9]+)\.([a-f0-9]{24})\.dirty\.tmp$/u;
const MAX_ACTIVE_MARKER_BYTES = 4 * 1024;
const MAX_DIRTY_FENCE_BYTES = 1024;
const MAX_RUN_ID_BYTES = 4 * 1024;
// JSON can escape every decoded byte as six bytes. The remaining allowance
// covers both message envelopes, the fixed provenance, timestamp and v2 record.
const MAX_CONTEXT_IMPORT_RECORD_BYTES = 6 * (
  AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES
  + AGENT_CONTEXT_IMPORT_MAX_IDEMPOTENCY_KEY_BYTES
  + AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES
) + (2 * MAX_MESSAGE_ENVELOPE_BYTES) + (64 * 1024);

// Config reloads can briefly leave old and new harness instances alive in the
// same owner process. Module-level queues serialize both same-conversation
// read/modify/write work and root-wide retention accounting across instances.
const PROCESS_APPEND_QUEUES = new Map<string, Promise<void>>();
const PROCESS_LOGICAL_SESSION_QUEUES = new Map<string, Promise<void>>();
const PROCESS_ROOT_QUEUES = new Map<string, Promise<void>>();
const PROCESS_POST_COMMIT_FAILURES = new Map<string, { count: number; lastError?: string }>();

export interface DurableHistoryStoreOptions {
  /** Storage-only native matcher; never dispatches a provider, tool or continuation. */
  readonly reconcileProviderSessionTurn?: ConversationHistoryTurnInspector;
  /** Owner-only directory containing one content-addressed file per conversation. */
  readonly root: string;
  /** Administrative opt-in only; configured hosts do not create this capability. */
  readonly nativeJournalStorage?: RuntimeNativeJournalStorage;
  /** Storage-boundary verification hook; never a provider or host policy. */
  readonly onNativeHistoryPhase?: (phase: string) => Promise<void>;
  /** Retained messages per conversation. Defaults to, and may not exceed, 64. */
  readonly maxMessages?: number;
  /** Aggregate committed-history quota. Defaults to 256 MiB. */
  readonly maxStoreBytes?: number;
  /** Aggregate unpublished-stage quota. Defaults to `maxStoreBytes`. */
  readonly maxStagedBytes?: number;
  /** Maximum committed conversations. Defaults to 10,000. */
  readonly maxConversations?: number;
  /** Maximum inactive conversation-file age. Defaults to 365 days. */
  readonly maxAgeMs?: number;
  /** Injectable clock for deterministic retention and tests. */
  readonly now?: () => number;
  /**
   * Fail-closed removal of an exact provider-session id. When present, this
   * store may coordinate durable provider sessions across processes; every
   * epoch made unreachable is retired before the owning history mutation.
   */
  readonly retireProviderSession?: (providerSessionId: string, modelKey?: string) => Promise<void>;
}

/** Administrative authority only; does not upgrade native headers or enable dispatch. */
export interface NativeHistoryAuthorityLease {
  readonly status: "owned";
  readonly authority: RuntimeNativeJournalAuthority;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

/** Administrative storage only; never a dispatch/capability advertisement. */
export interface ManagedModelSwitchStorageLease {
  readonly status: "owned";
  read(): ReturnType<ModelSwitchPayloadStore["read"]>;
  admit(producer: SummaryAttempt["producer"]): Promise<ModelSwitchState>;
  finish(producer: SummaryAttempt["producer"], outcome: "unknown" | "rejected"): Promise<ModelSwitchState>;
  advanceUnfit(): Promise<ModelSwitchState>;
  authorizeMessage(messageDigest: string): Promise<ModelSwitchState>;
  accept(artifact: Record<string, unknown>): Promise<HandoffReference>;
  recoverArtifact(): Promise<HandoffReference | undefined>;
  /** Releases the claim, never the durable fence or evidence. */
  release(): Promise<void>;
}
/** Claim-only host preparation. No incoming fence/admission or configured opt-in.
 * Child leases borrow this owner; releasing one never releases the preparation.
 * Admission consumes the preparation only after the canonical model is ready.
 * Inside phase/native callbacks, only assertOwned may be called: all other
 * preparation/child methods serialize behind the running action. Do not call
 * same-conversation standalone store APIs while this preparation is held; they
 * acquire its claim and cannot proceed until admission or abort releases it. */
/** Pre-intent contention, not unsupported storage or permission to cold replay.
 * Never wait holding a conversation claim: two contenders can pin each other. */
/** @internal Ordinary host admission cannot borrow prepared native authority. */
export class OrdinaryNativeDispatchUnavailableError extends Error {
  constructor() {
    super("Ordinary admission on a guarded chain requires owned native preparation; native evidence was preserved.");
    this.name = "OrdinaryNativeDispatchUnavailableError";
  }
}
/** @internal A pending switch is a pre-admission refusal, not a failed turn. */
export class ModelSwitchPendingError extends Error {
  constructor() { super("Model-switch storage pending; ordinary admission/mutation is unavailable until transaction settlement"); this.name = "ModelSwitchPendingError"; }
}
export class NativeHistoryAuthorityBusyError extends Error {
  readonly code = "ERR_NATIVE_HISTORY_AUTHORITY_BUSY";
  readonly retryable = true;
  constructor() { super("Native root authority requires drained host owners and settled fences"); this.name = "NativeHistoryAuthorityBusyError"; }
}

export interface ManagedProviderSessionPreparation {
  readonly recovery: ConversationHistoryTurnRecovery;
  read(): Promise<ProviderSessionPreparationSnapshot>;
  /** Caller-supplied provenance is used only for a legacy source's API/model;
   * its account is explicitly null, never inferred from current credentials. */
  captureNativeEvidence(legacyProvenance?: import("@mono-agent/runtime-adapter").RuntimeNativeJournalDescriptor["provenance"]): Promise<{
    readonly sources: readonly CanonicalJournalDescriptor[]; readonly view: import("@mono-agent/runtime-adapter").RuntimeNativeEvidenceView;
  }>;
  readHandoff(switchId: string, reference: HandoffReference): Promise<{ readonly artifact: Readonly<Record<string, unknown>>;
    readonly budget: import("@mono-agent/runtime-adapter").RuntimeHandoffBudget }>;
  assertOwned(): Promise<void>;
  acquireNativeHistoryAuthority(options: { readonly exclusiveWriters: true }): Promise<ModelSwitchStorageSupport | NativeHistoryAuthorityLease>;
  beginModelSwitchStorage(state: ModelSwitchState): Promise<ModelSwitchStorageSupport | ManagedModelSwitchStorageLease>;
  rollForwardModelSwitch(switchId: string, options: { readonly exclusiveWriters: true; readonly onPhase?: (phase: string) => Promise<void> }): Promise<{ readonly status: "pending" | "committed" | "absent" }>;
  /** coldModelChange explicitly selects today's cold rotation, never while a switch is pending.
   * missingCurrentEpoch is owner-approved recovery of an externally missing current
   * journal: when that exact epoch is still canonical, admission first rotates it
   * through the existing same-model cold path (v3 retire/new epoch, v4 durable C). */
  admit(binding: ProviderSessionTurnBinding, options?: { readonly coldModelChange?: true; readonly missingCurrentEpoch?: string }): Promise<ConversationHistoryProviderSessionTurn & { readonly native?: TurnHistoryV4["native"]; assertOwned(): Promise<void> }>;
  /** @internal Explicit persisted-delivery cold transition: C current only, P predecessors; no producer/admission. */
  coldModelChange?(input: { readonly messageId: string; readonly modelKey: string; readonly sourceCanonicalDigest: string;
    readonly targetProvenance: CanonicalJournalDescriptor["provenance"]; readonly reason: NativeColdSwitch["reason"] }): Promise<NonNullable<TurnHistoryV4["lastSwitch"]>>;
  /** @internal Read-only probe of the canonical current journal under this owner.
   * `absent` means no current journal is expected yet (or no probe capability). */
  inspectCurrentJournal?(): Promise<CurrentJournalPresence>;
  abort(): Promise<void>;
}
export type CurrentJournalPresence = { readonly status: "absent" | "present" } | { readonly status: "missing"; readonly epoch: string }
  | { readonly status: "unreadable"; readonly reason: string };
export interface ProviderSessionPreparationSnapshot {
  readonly history: readonly HistoryMessage[];
  readonly source: Awaited<ReturnType<DurableConversationHistoryStore["modelSwitchStorageSource"]>>;
  readonly native?: TurnHistoryV4["native"];
  readonly lastSwitch?: TurnHistoryV4["lastSwitch"];
  readonly pending?: ModelSwitchState;
}
export type ModelSwitchStorageSupport = { readonly status: "unsupported"; readonly reason: "id_limit" | "unbound" };

export interface DurableHistoryStoreStats {
  readonly conversations: number;
  /** Physical canonical, switch-storage and root-authority bytes, excluding plans. */
  readonly bytes: number;
  readonly reservedBytes: number;
  readonly activePreparedAppends: number;
  readonly postCommitMaintenanceFailures: number;
  readonly lastPostCommitMaintenanceError?: string;
  readonly limits: {
    readonly maxMessages: number;
    readonly maxStoreBytes: number;
    readonly maxStagedBytes: number;
    readonly maxConversations: number;
    readonly maxAgeMs: number;
  };
}

interface ProviderSessionState {
  readonly modelKey?: string;
  readonly epoch: string;
  readonly revision?: number;
  readonly dirtyRunId?: string;
}

type CanonicalHistoryFile = TurnHistoryV3 | TurnHistoryV4;

interface LoadedHistoryRecord {
  readonly lastCommit?: DurableTurnReceipt;
  readonly sourceVersion: 0 | typeof LEGACY_STORE_VERSION | typeof PROVIDER_STORE_VERSION | typeof STORE_VERSION | 4;
  readonly native?: TurnHistoryV4["native"];
  readonly lastSwitch?: NonNullable<TurnHistoryV4["lastSwitch"]>;
  readonly conversationId: string;
  readonly messages: readonly HistoryMessage[];
  readonly providerSession?: ProviderSessionState;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ActiveStage {
  readonly logicalConversationKey?: string;
  readonly conversationKey: string;
  readonly destinationName: string;
  readonly temporaryPath: string;
  readonly bytes: number;
}

interface ActiveMarker {
  readonly path: string;
  readonly conversationKey: string;
  readonly pid: number;
  readonly token: string;
}

interface DirtyFence {
  readonly kind?: "execution" | "compaction" | "retirement";
  readonly payload?: PendingTurnPointer;
  readonly modelKey?: string;
  readonly path: string;
  readonly conversationKey: string;
  readonly logicalConversationKey?: string;
  readonly epoch: string;
  readonly providerSessionId?: string;
  readonly revision: number;
  readonly runIdDigest: string;
  readonly mtimeMs?: number;
}

interface HeldConversation {
  readonly logical: HeldLogicalConversation;
  assertOwned(): Promise<void>;
  readonly marker: ActiveMarker;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

interface HeldLogicalConversation {
  assertOwned(): Promise<void>;
  readonly logicalConversationId: string;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

interface HeldExactConversationClaim {
  readonly conversationId: string;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

class HistoryOwnerBusyError extends Error {}
class CanonicalParseFailure extends Error { constructor(error: unknown) { super(error instanceof Error ? error.message : "Unreadable canonical history", { cause: error }); } }

interface RootAccounting {
  readonly records: Map<string, LoadedHistoryRecord | undefined>;
  rawSwitches?: Promise<Awaited<ReturnType<ModelSwitchPayloadStore["inventory"]>>>;
  native?: Promise<Awaited<ReturnType<RuntimeNativeJournalStorage["inventory"]>>>;
  switches?: Promise<Awaited<ReturnType<ModelSwitchPayloadStore["inventory"]>> & { nativeBytes: number; nativeStagedBytes: number }>;
  operations?: Promise<{ bytes: number; reserved: number; keys: Set<string> }>;
}

interface CrossProcessLock {
  release(): Promise<void>;
}

interface CommittedEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Restart-durable conversation history with bounded, owner-only, atomic files.
 *
 * Conversation ids never become path components: their normalized exact value
 * is stored in the file while a SHA-256 digest selects the filename. Prepared
 * appends are fully validated and fsynced but remain invisible until commit's
 * atomic rename. SQLite-backed OS locks serialize same-conversation turns and
 * root retention across both store instances and independent processes.
 */
export class DurableConversationHistoryStore implements ConversationHistoryStore {
  readonly providerSessionReconciliation: "v1" | undefined;
  private readonly inspectProviderTurn: ConversationHistoryTurnInspector | undefined;
  readonly providerSessionPreparation = "v1" as const;
  readonly providerSessionModelBinding = "v1" as const;
  readonly providerSessionRecovery = "v1" as const;
  readonly providerSessionRetirement: "fail-closed" | undefined;
  readonly contextImport: ConversationHistoryContextImport | undefined;
  private readonly root: string;
  private readonly maxMessages: number;
  private readonly maxStoreBytes: number;
  private readonly maxStagedBytes: number;
  private readonly maxConversations: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly retireProviderSession: ((providerSessionId: string, modelKey?: string) => Promise<void>) | undefined;
  private rootReady: Promise<DirectoryIdentity> | undefined;
  private locksRootReady: Promise<DirectoryIdentity> | undefined;
  private pendingPayloadStore: PendingTurnPayloadStore | undefined;
  private pendingPayloads(rootIdentity: DirectoryIdentity): PendingTurnPayloadStore {
    return this.pendingPayloadStore ??= new PendingTurnPayloadStore(this.root, rootIdentity);
  }

  constructor(options: DurableHistoryStoreOptions) {
    if (typeof options?.root !== "string" || options.root.trim().length === 0) {
      throw new TypeError("root must be a non-empty absolute path.");
    }
    if (!isAbsolute(options.root)) {
      throw new TypeError("root must be an absolute path.");
    }
    const root = resolve(options.root);
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isInteger(maxMessages) || maxMessages < 0 || maxMessages > DEFAULT_MAX_MESSAGES) {
      throw new TypeError(`maxMessages must be an integer between 0 and ${DEFAULT_MAX_MESSAGES}.`);
    }
    const maxStoreBytes = normalizeNonNegativeInteger(
      options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
      "maxStoreBytes",
    );
    const maxStagedBytes = normalizeNonNegativeInteger(
      options.maxStagedBytes ?? maxStoreBytes,
      "maxStagedBytes",
    );
    const maxConversations = normalizeNonNegativeInteger(
      options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS,
      "maxConversations",
    );
    const maxAgeMs = normalizeNonNegativeInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "maxAgeMs");
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function when present.");
    }
    if (options.retireProviderSession !== undefined && typeof options.retireProviderSession !== "function") {
      throw new TypeError("retireProviderSession must be a function when present.");
    }
    if (options.reconcileProviderSessionTurn !== undefined && (typeof options.reconcileProviderSessionTurn !== "function" || options.retireProviderSession === undefined)) {
      throw new TypeError("Native turn reconciliation requires an inspector and fail-closed retirement.");
    }
    this.nativeJournalStorage = options.nativeJournalStorage;
    this.nativePhase = options.onNativeHistoryPhase ?? (async () => {});
    this.inspectProviderTurn = options.reconcileProviderSessionTurn;
    this.providerSessionReconciliation = this.inspectProviderTurn === undefined ? undefined : "v1";
    this.root = root;
    this.maxMessages = maxMessages;
    this.maxStoreBytes = maxStoreBytes;
    this.maxStagedBytes = maxStagedBytes;
    this.maxConversations = maxConversations;
    this.maxAgeMs = maxAgeMs;
    this.now = options.now ?? Date.now;
    this.retireProviderSession = options.retireProviderSession;
    this.providerSessionRetirement = options.retireProviderSession === undefined ? undefined : "fail-closed";
    this.contextImport = maxMessages >= 2
      && maxStoreBytes >= MAX_CONTEXT_IMPORT_RECORD_BYTES
      && maxStagedBytes >= MAX_CONTEXT_IMPORT_RECORD_BYTES
      && maxConversations >= 1
      ? {
        version: AGENT_CONTEXT_IMPORT_VERSION,
        maxTextBytes: AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES,
        providerState: options.retireProviderSession === undefined ? "absent" : "retire-fail-closed",
        beginExclusiveTurn: async (conversationId) => await this.beginExclusiveTurn(conversationId),
        prepareImport: async (conversationId, request) => await this.prepareContextImport(conversationId, request),
      }
      : undefined;
  }

  private readonly nativeJournalStorage: RuntimeNativeJournalStorage | undefined;
  private readonly nativePhase: (phase: string) => Promise<void>;
  private nativeHistoryRootStore: NativeHistoryRootStore | undefined;
  private nativeHistoryRoot(rootIdentity: DirectoryIdentity): NativeHistoryRootStore {
    return this.nativeHistoryRootStore ??= new NativeHistoryRootStore(this.root, rootIdentity);
  }
  /** Explicit stopped-older-writer acknowledgement; no production caller opts in. */
  async acquireNativeHistoryAuthority(conversationId: string, options: { readonly exclusiveWriters: true }): Promise<ModelSwitchStorageSupport | NativeHistoryAuthorityLease> {
    if (options?.exclusiveWriters !== true) throw new TypeError("Native root authority requires exclusive upgraded writers");
    const id = normalizeConversationId(conversationId), ownerKey = logicalConversationIdForFence(id);
    if (id.length > 512 || ownerKey.length > 512) return { status: "unsupported", reason: "id_limit" };
    const held = await this.acquireConversation(id);
    return await this.acquireHeldNativeHistoryAuthority(id, held, true);
  }
  private async acquireHeldNativeHistoryAuthority(id: string, held: HeldConversation, releaseOwner: boolean): Promise<ModelSwitchStorageSupport | NativeHistoryAuthorityLease> {
    const ownerKey = logicalConversationIdForFence(id), rootIdentity = held.rootIdentity;
    let released = false;
    const release = async () => { if (released) return; released = true; if (releaseOwner) await this.releaseConversation(held, rootIdentity); };
    const assertOwned = async () => { if (released) throw new Error("Native history authority lease released"); await held.assertOwned(); };
    try {
      await this.settleHeldTurn(id, held);
      const source = await this.modelSwitchStorageSource(id);
      if (source.status === "unsupported") { await release(); return source; }
      const releaseRoot = await this.acquireRootTransaction(rootIdentity);
      let marker;
      try {
        await assertOwned();
        const active = await this.scanActiveMarkers(true);
        if (active.some((entry) => entry.path !== held.marker.path)
          || (await this.scanDirtyFences(await this.ensureLocksRoot(), false)).length
          || (await this.pendingPayloads(rootIdentity).list()).length) {
          throw new NativeHistoryAuthorityBusyError();
        }
        const rootStore = this.nativeHistoryRoot(rootIdentity);
        if (!await rootStore.read()) {
          for (const entry of await this.scanCommittedEntries(rootIdentity, false)) {
            if ((await this.readCommittedEntryRecord(entry, rootIdentity)).sourceVersion === 4) throw new Error("Canonical v4 root authority marker is missing; restore consistent backup");
          }
        }
        marker = await rootStore.ensure({ assertOwned, reserve: async (bytes) => {
          const plan = await this.retentionPlan(rootIdentity, []);
          if (plan.projectedBytes + bytes > this.maxStoreBytes || await this.scanStagedBytes(rootIdentity) + bytes > this.maxStagedBytes) {
            throw new ModelSwitchCapacityError("Native root authority capacity unavailable");
          }
        } });
      } finally { await releaseRoot(); }
      const authority = Object.freeze(this.nativeHistoryRoot(rootIdentity).authority(marker, ownerKey, id));
      return { status: "owned", authority, assertOwned: async () => {
        await assertOwned(); const current = await this.nativeHistoryRoot(rootIdentity).read();
        if (current?.rootId !== authority.rootId) throw new Error("Native history root authority changed");
      }, release };
    } catch (error) { await release().catch(() => undefined); throw error; }
  }

  private modelSwitchPayloadStore: ModelSwitchPayloadStore | undefined;
  private modelSwitchPayloads(rootIdentity: DirectoryIdentity): ModelSwitchPayloadStore {
    this.modelSwitchPayloadStore ??= new ModelSwitchPayloadStore(this.root, rootIdentity); return this.modelSwitchPayloadStore;
  }
  private rootAccounting: RootAccounting | undefined;
  private invalidateCanonicalAccounting(name: string): void {
    if (!this.rootAccounting) return;
    this.rootAccounting.records.delete(name);
    delete this.rootAccounting.rawSwitches; delete this.rootAccounting.switches;
    delete this.rootAccounting.native; delete this.rootAccounting.operations;
  }
  private switchInventory(rootIdentity: DirectoryIdentity) {
    const compute = () => this.modelSwitchPayloads(rootIdentity).inventory();
    return this.rootAccounting ? this.rootAccounting.rawSwitches ??= compute() : compute();
  }
  private async accountingRecords(rootIdentity: DirectoryIdentity, entries: readonly CommittedEntry[]) {
    const cached = this.rootAccounting?.records ?? new Map<string, LoadedHistoryRecord | undefined>();
    for (const entry of entries) if (!cached.has(entry.name)) {
      try { cached.set(entry.name, await this.readCommittedEntryRecord(entry, rootIdentity)); }
      catch (error) { if (!(error instanceof CanonicalParseFailure)) throw error; cached.set(entry.name, undefined); }
    }
    return new Map(entries.map((entry) => [entry.name, cached.get(entry.name)]));
  }
  private async managedNativeInventory(rootIdentity: DirectoryIdentity, records?: ReadonlyMap<string, LoadedHistoryRecord | undefined>) {
    const compute = async () => {
      const ids = new Set<string>();
      if (records === undefined && await this.nativeHistoryRoot(rootIdentity).read()) {
        records = await this.accountingRecords(rootIdentity, await this.scanCommittedEntries(rootIdentity, false));
      }
      for (const record of records?.values() ?? []) if (record?.sourceVersion === 4) for (const row of record.native!.chain) ids.add(row.journalId);
      for (const operation of await this.nativeOperationOwners(rootIdentity)) {
        for (const row of operation.source.native.chain) ids.add(row.journalId);
        if (operation.next?.version === 4) for (const row of operation.next.native.chain) ids.add(row.journalId);
      }
      for (const { state } of (await this.switchInventory(rootIdentity)).pending) {
        for (const row of state.identity.sources) ids.add(row.journalId);
        ids.add(managedNativeJournalId(deriveProviderSessionId(state.identity.historyBucket, state.identity.targetEpoch)));
      }
      const unknownKeys = [...(records?.entries() ?? [])].filter(([, record]) => record === undefined)
        .map(([name]) => name.slice(0, -HISTORY_FILE_SUFFIX.length));
      const marker = unknownKeys.length === 0 ? undefined : await this.nativeHistoryRoot(rootIdentity).read();
      return this.nativeJournalStorage!.inventory([...ids], marker ? { rootId: marker.rootId, conversationKeys: unknownKeys } : undefined);
    };
    return this.rootAccounting ? this.rootAccounting.native ??= compute() : compute();
  }
  private async modelSwitchFootprint(rootIdentity: DirectoryIdentity, records?: ReadonlyMap<string, LoadedHistoryRecord | undefined>, native?: Awaited<ReturnType<RuntimeNativeJournalStorage["inventory"]>>) {
    const compute = async () => {
      const footprint = await this.switchInventory(rootIdentity);
      if (!this.nativeJournalStorage) return { ...footprint, nativeBytes: 0, nativeStagedBytes: 0 };
      const physical = native ?? await this.managedNativeInventory(rootIdentity, records);
      let nativeStagedBytes = physical.stagedBytes;
      const pending = [];
      for (const entry of footprint.pending) {
        const state = entry.state, record = records === undefined ? await this.readRecord(state.identity.historyBucket, rootIdentity) : records.get(`${historyKey(state.identity.historyBucket)}${HISTORY_FILE_SUFFIX}`);
        const committed = record?.sourceVersion === 4 && recognizesModelSwitchBinding(record, state.identity);
        const targetId = managedNativeJournalId(deriveProviderSessionId(state.identity.historyBucket, state.identity.targetEpoch));
        const ids = new Set([...state.identity.sources.map((row) => row.journalId), targetId]);
        let nativeCredit = 0, copyCredit = 0;
        for (const id of ids) { nativeCredit += physical.journals[id]?.retainedBytes ?? 0; copyCredit += physical.journals[id]?.headerCopyBytes ?? 0; }
        if (!committed) { const target = physical.journals[targetId]; nativeStagedBytes += Math.max(0, (target?.retainedBytes ?? 0) - (target?.stagedBytes ?? 0)); }
        const canonicalCredit = committed ? (await lstat(join(this.root, `${historyKey(record.conversationId)}${HISTORY_FILE_SUFFIX}`))).size : 0;
        pending.push({ ...entry, remainingReservation: Math.max(0, entry.remainingReservation
          - Math.min(state.reservation.retainedNativeBytes, nativeCredit)
          - Math.min(state.reservation.headerCopyBytes, copyCredit)
          - Math.min(state.reservation.canonicalBytes, canonicalCredit)) });
      }
      return { ...footprint, pending, nativeBytes: physical.bytes, nativeStagedBytes };
    };
    return this.rootAccounting ? this.rootAccounting.switches ??= compute() : compute();
  }
  private nativeSwitchContext(state: ModelSwitchState, authority: RuntimeNativeJournalAuthority, assertOwned: () => Promise<void>): RuntimeNativeSwitchContext {
    return { hostAuthority: authority, assertOwned, targetHandleId: deriveProviderSessionId(state.identity.historyBucket, state.identity.targetEpoch),
      targetEpoch: state.identity.targetEpoch, timestamp: state.identity.timestamp, sourceRevision: state.identity.sourceRevision,
      fromModelKey: state.identity.fromModelKey, targetProvenance: state.identity.targetProvenance,
      event: { switchId: state.identity.switchId, timestamp: state.identity.timestamp, from: state.identity.sources.at(-1)!.provenance,
        to: state.identity.targetProvenance, artifactRef: state.artifact ?? { id: "0".repeat(64), hash: "0".repeat(64) } } };
  }
  private async requireNoModelSwitch(conversationId: string, rootIdentity: DirectoryIdentity): Promise<void> {
    if ((await this.switchInventory(rootIdentity)).pending.some((entry) => entry.state.identity.historyBucket === conversationId)) {
      throw new ModelSwitchPendingError();
    }
  }
  /** Read-only support probe. Long IDs continue today's ordinary cold replay:
   * unsupported storage is a result, not a switch-time contract error. */
  async modelSwitchStorageSource(conversationId: string): Promise<ModelSwitchStorageSupport | {
    readonly status: "supported"; readonly sourceCanonicalDigest: string; readonly sourceRevision: number;
    readonly fromModelKey: string; readonly sourceEpoch: string; readonly ownerKey: string;
  }> {
    const id = normalizeConversationId(conversationId), ownerKey = logicalConversationIdForFence(id);
    if (id.length > 512 || ownerKey.length > 512) return { status: "unsupported", reason: "id_limit" };
    const rootIdentity = await this.ensureRoot(), record = await this.readRecord(id, rootIdentity);
    if (!record.providerSession?.modelKey || record.providerSession.revision === undefined || (record.sourceVersion !== STORE_VERSION && record.sourceVersion !== 4)) return { status: "unsupported", reason: "unbound" };
    return { status: "supported", sourceCanonicalDigest: switchDigest({ version: record.sourceVersion, conversationId: id, messages: record.messages,
      providerSession: record.providerSession, ...lastCommitBinding(record), ...v4Extension(record) }), sourceRevision: record.providerSession.revision,
      fromModelKey: record.providerSession.modelKey, sourceEpoch: record.providerSession.epoch, ownerKey };
  }
  /** Host-only storage lease. Holds the real logical/physical claim while each
   * durable operation borrows only a short root transaction; production is
   * outside those transactions. Native validation/migration is not enabled. */
  async beginModelSwitchStorage(state: ModelSwitchState): Promise<ModelSwitchStorageSupport | ManagedModelSwitchStorageLease> {
    const id = normalizeConversationId(state.identity.historyBucket), ownerKey = logicalConversationIdForFence(id);
    if (id.length > 512 || ownerKey.length > 512) return { status: "unsupported", reason: "id_limit" };
    if (state.identity.historyBucket !== id || state.identity.ownerKey !== ownerKey) throw new Error("Model-switch bucket must be normalized and belong to the managed owner");
    validateModelSwitchState(state); state = structuredClone(state);
    const held = await this.acquireConversation(id);
    return await this.beginHeldModelSwitchStorage(state, held, true);
  }
  private async beginHeldModelSwitchStorage(state: ModelSwitchState, held: HeldConversation, releaseOwner: boolean): Promise<ModelSwitchStorageSupport | ManagedModelSwitchStorageLease> {
    const id = state.identity.historyBucket, ownerKey = logicalConversationIdForFence(id), rootIdentity = held.rootIdentity;
    let released = false;
    const assertOwned = async () => { if (released) throw new Error("Model-switch storage lease released"); await held.assertOwned(); };
    const release = async () => { if (released) return; released = true; if (releaseOwner) await this.releaseConversation(held, rootIdentity); };
    try {
      await this.settleHeldTurn(id, held);
      const source = await this.modelSwitchStorageSource(id);
      if (source.status === "unsupported") { await release(); return source; }
      if (state.identity.ownerKey !== source.ownerKey || state.identity.sourceCanonicalDigest !== source.sourceCanonicalDigest
        || state.identity.sourceRevision !== source.sourceRevision || state.identity.fromModelKey !== source.fromModelKey
        || state.identity.sources.at(-1)?.epoch !== source.sourceEpoch) throw new Error("Model-switch source changed or does not belong to the managed owner");
      const payloads = this.modelSwitchPayloads(rootIdentity), bucket = state.identity.historyBucket, switchId = state.identity.switchId;
      let initialNativeCredit = 0;
      if (this.nativeJournalStorage && !await payloads.read(bucket, switchId)) {
        const marker = await this.nativeHistoryRoot(rootIdentity).read();
        if (!marker) throw new Error("Issue drained native root authority before publishing a switch intent");
        if (state.identity.sources.length >= MAX_JOURNAL_CHAIN || state.identity.sources.at(-1)!.handleId !== deriveProviderSessionId(id, source.sourceEpoch)) throw new Error("Native switch chain is full or source handle conflicts");
        const authority = this.nativeHistoryRoot(rootIdentity).authority(marker, ownerKey, id);
        const existing = await this.readRecord(id, rootIdentity);
        if (existing.native && (existing.native.chain.length !== state.identity.sources.length || existing.native.chain.some((row, index) =>
          ["journalId", "epoch", "ordinal", "handleId", "predecessorJournalId", "ownerKey", "historyBucket", "provenance"].some((key) =>
            switchDigest(row[key as keyof CanonicalJournalDescriptor]) !== switchDigest(state.identity.sources[index]![key as keyof CanonicalJournalDescriptor]))))) throw new Error("Frozen switch chain does not match canonical membership");
        const preview = [...state.identity.sources.map((row, index) => index === state.identity.sources.length - 1 ? { ...row, sourceSeq: row.sourceSeq + 3, sourceDigest: "0".repeat(64) } : row),
          { journalId: managedNativeJournalId(deriveProviderSessionId(id, state.identity.targetEpoch)), epoch: state.identity.targetEpoch,
            ordinal: state.identity.sources.length, handleId: deriveProviderSessionId(id, state.identity.targetEpoch), predecessorJournalId: state.identity.sources.at(-1)!.journalId,
            ownerKey, historyBucket: id, sourceTipId: null, sourceSeq: 4, sourceDigest: "0".repeat(64), provenance: state.identity.targetProvenance }];
        const previewState = { ...state, artifact: { id: "0".repeat(64), hash: "0".repeat(64) } };
        if (serializeHistoryFile(switchCanonicalRecord(existing, previewState, authority, preview)).byteLength > state.reservation.canonicalBytes) throw new ModelSwitchCapacityError("Canonical switch capacity unavailable before intent publication");
        const measured = await this.nativeJournalStorage.measureSwitch(state.identity.sources, this.nativeSwitchContext(state, authority, assertOwned));
        if (measured.retainedNativeBytes > state.reservation.retainedNativeBytes || measured.headerCopyBytes > state.reservation.headerCopyBytes) throw new ModelSwitchCapacityError("Native switch measured capacity exceeds the frozen plan");
        const physical = await this.managedNativeInventory(rootIdentity);
        initialNativeCredit = state.identity.sources.reduce((total, row) => total + (physical.journals[row.journalId]?.retainedBytes ?? 0), 0);
      }
      const validateSpace = async (additional: number) => {
        await assertOwned();
        const footprint = await this.modelSwitchFootprint(rootIdentity);
        const pending = footprint.pending.find((entry) => entry.state.identity.switchId === switchId);
        // The pending plan already covers publication space. Only a physical
        // peak beyond its unused portion requires additional capacity.
        if (pending) additional = Math.max(0, additional - pending.remainingPendingBytes);
        else additional = Math.max(0, additional - initialNativeCredit);
        const plan = await this.retentionPlan(rootIdentity, []);
        // Storage admission never deletes unrelated owners merely to reserve a
        // switch; failure precedes publication/provider work.
        if (plan.projectedBytes + additional > this.maxStoreBytes || plan.projectedCount > this.maxConversations) throw new ModelSwitchCapacityError("Model-switch aggregate history capacity unavailable");
        if (await this.scanStagedBytes(rootIdentity) + additional > this.maxStagedBytes) throw new ModelSwitchCapacityError("Model-switch staged capacity unavailable");
      };
      const owner: ModelSwitchStorageOwner = { ownerKey, historyBucket: bucket, assertOwned,
        withRootTransaction: async (action) => { await assertOwned(); const unlock = await this.acquireRootTransaction(rootIdentity); try {
          requireSettledFence(await this.findDirtyFence(historyKey(id), await this.ensureLocksRoot()));
          return await action();
        } finally { await unlock(); } },
        reserve: validateSpace,
        // Durable inventory is the absolute ledger; never increment a process
        // counter or grant credits from a caller's requested adjustment.
        adjustReservation: async (_remaining) => {
          // Publication/enrollment changes the absolute ledger, not just a
          // counter. Keep record reads, but invalidate affected footprints.
          if (this.rootAccounting) {
            delete this.rootAccounting.rawSwitches; delete this.rootAccounting.switches;
            delete this.rootAccounting.native; delete this.rootAccounting.operations;
          }
          await validateSpace(0);
        } };
      await payloads.begin(state, owner);
      return { status: "owned", read: async () => { await assertOwned(); return payloads.read(bucket, switchId); },
        admit: (producer) => payloads.admit(bucket, switchId, producer, owner),
        finish: (producer, outcome) => payloads.finish(bucket, switchId, producer, outcome, owner),
        advanceUnfit: () => payloads.advanceUnfit(bucket, switchId, owner),
        authorizeMessage: (digest) => payloads.authorizeMessage(bucket, switchId, digest, owner),
        accept: (artifact) => payloads.accept(bucket, switchId, artifact, owner),
        recoverArtifact: () => payloads.recoverArtifact(bucket, switchId, owner), release };
    } catch (error) { await release().catch(() => undefined); throw error; }
  }

  /** Restartable ready-only storage transaction; never runs a producer or provider.
   * Pending stays fenced with its source binding. No configured host calls this. */
  async rollForwardModelSwitch(conversationId: string, switchId: string, options: {
    readonly exclusiveWriters: true; readonly onPhase?: (phase: string) => Promise<void>;
  }): Promise<{ readonly status: "pending" | "committed" | "absent" }> {
    if (options?.exclusiveWriters !== true || !this.nativeJournalStorage) throw new Error("Managed native switch capability and exclusive writers required");
    const id = normalizeConversationId(conversationId), held = await this.acquireConversation(id);
    try { return await this.rollForwardHeldModelSwitch(id, switchId, held, options.onPhase); }
    finally { await this.releaseConversation(held, held.rootIdentity); }
  }
  private async rollForwardHeldModelSwitch(id: string, switchId: string, held: HeldConversation,
    phase: (phase: string) => Promise<void> = async () => {}): Promise<{ readonly status: "pending" | "committed" | "absent" }> {
    const rootIdentity = held.rootIdentity, native = this.nativeJournalStorage;
    if (!native) throw new Error("Managed native switch capability required");
    const payloads = this.modelSwitchPayloads(rootIdentity);
    const assertOwned = async () => { await held.assertOwned(); const marker = await this.nativeHistoryRoot(rootIdentity).read(); if (!marker) throw new Error("Native root authority missing"); };
    const withRootTransaction = async <T>(action: () => Promise<T>): Promise<T> => { const unlock = await this.acquireRootTransaction(rootIdentity); try { await assertOwned(); return await action(); } finally { await unlock(); } };
    await assertOwned();
    const current = await payloads.read(id, switchId), existing = await this.readRecord(id, rootIdentity);
    if (!current) {
      if (existing.lastSwitch?.switchId !== switchId) return { status: "absent" };
      await withRootTransaction(async () => { await this.syncManagedCanonical(id, rootIdentity); await payloads.syncPublication(); });
      return { status: "committed" };
    }
    if (current.state.phase !== "ready") return { status: "pending" };
    const state = current.state;
    if (state.identity.ownerKey !== logicalConversationIdForFence(id)) throw new Error("Switch does not belong to the managed owner");
    const receiptMatches = existing.sourceVersion === 4 && recognizesModelSwitchBinding(existing, state.identity);
    const historical = existing.sourceVersion === 4 && !!existing.native && existing.native.chain.length > state.identity.sources.length
      && existing.providerSession?.epoch !== state.identity.targetEpoch
      && state.identity.sources.every((entry, index) => existing.native!.chain[index]?.journalId === entry.journalId && existing.native!.chain[index]?.epoch === entry.epoch);
    if (!receiptMatches && !historical) {
      requireSettledFence(await this.findDirtyFence(historyKey(id), await this.ensureLocksRoot()));
      const source = await this.modelSwitchStorageSource(id);
      if (source.status !== "supported" || source.sourceCanonicalDigest !== state.identity.sourceCanonicalDigest
        || source.sourceRevision !== state.identity.sourceRevision || source.fromModelKey !== state.identity.fromModelKey
        || source.sourceEpoch !== state.identity.sources.at(-1)!.epoch) throw new Error("Switch source changed before native roll-forward");
      const marker = (await this.nativeHistoryRoot(rootIdentity).read())!;
      const authority = this.nativeHistoryRoot(rootIdentity).authority(marker, state.identity.ownerKey, id);
      // All potentially long native I/O is outside the short host root transaction.
      const chain = await native.publishSwitch(state.identity.sources, this.nativeSwitchContext(state, authority, assertOwned));
      validateJournalChain(chain, state.identity.ownerKey, id);
      if (chain.length !== state.identity.sources.length + 1 || chain.at(-1)!.epoch !== state.identity.targetEpoch
        || chain.at(-1)!.handleId !== deriveProviderSessionId(id, state.identity.targetEpoch)
        || state.identity.sources.some((row, index) => row.journalId !== chain[index]!.journalId || row.epoch !== chain[index]!.epoch || row.handleId !== chain[index]!.handleId)) throw new Error("Native switch returned conflicting membership");
      const record = switchCanonicalRecord(existing, state, authority, chain);
      if (serializeHistoryFile(record).byteLength > state.reservation.canonicalBytes) throw new Error("Canonical switch exceeds frozen publication capacity");
      await withRootTransaction(async () => {
        const latest = await this.modelSwitchStorageSource(id);
        if (latest.status !== "supported" || latest.sourceCanonicalDigest !== state.identity.sourceCanonicalDigest) throw new Error("Canonical source changed during native publication");
        // The durable plan already reserved this peak before native side effects;
        // double-charging it here could strand an admitted intent after recovery.
        const stage = await this.writeStage(record, rootIdentity); await phase("switch_canonical_stage_synced");
        await assertOwned(); await rename(stage.temporaryPath, join(this.root, stage.destinationName)); this.invalidateCanonicalAccounting(stage.destinationName); await phase("switch_canonical_renamed");
        await fsyncDirectory(this.root, rootIdentity); await phase("switch_canonical_directory_synced");
      });
    }
    const published = await this.readRecord(id, rootIdentity);
    if (!published.native) throw new Error("Canonical switch membership missing");
    if (historical) await native.verifySwitchSources(published.native.chain, state.identity.sources,
      this.nativeSwitchContext(state, published.native.authority, assertOwned));
    else await native.verifySwitch(published.native.chain, state.identity.sources,
      this.nativeSwitchContext(state, published.native.authority, assertOwned));
    const proveReceipt = async () => {
      const canonical = await this.readRecord(id, rootIdentity);
      if (historical) {
        if (canonical.sourceVersion !== 4 || !canonical.native || switchDigest(canonical.native.chain) !== switchDigest(published.native!.chain)) throw new Error("Historical switch membership changed");
        await native.verifySwitchSources(canonical.native.chain, state.identity.sources, this.nativeSwitchContext(state, canonical.native.authority, assertOwned));
      } else if (canonical.sourceVersion !== 4 || !recognizesModelSwitchBinding(canonical, state.identity)
        || canonical.providerSession?.epoch !== state.identity.targetEpoch || canonical.providerSession.modelKey !== state.identity.toModelKey
        || switchDigest(canonical.native?.projection) !== switchDigest(state.artifact)
        || switchDigest(canonical.lastSwitch?.artifact) !== switchDigest(state.artifact)) throw new Error("Canonical ready binding conflicts with accepted intent");
      await this.syncManagedCanonical(id, rootIdentity);
    };
    await payloads.complete(id, switchId, { ownerKey: state.identity.ownerKey, historyBucket: id, assertOwned, withRootTransaction,
      reserve: async () => { throw new Error("Completed switch cannot reserve anew"); }, adjustReservation: async () => {}, onPhase: phase }, proveReceipt);
    return { status: "committed" };
  }
  private async syncManagedCanonical(id: string, rootIdentity: DirectoryIdentity): Promise<void> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const path = join(this.root, `${historyKey(id)}${HISTORY_FILE_SUFFIX}`), before = await lstat(path); assertSecureHistoryFile(before, path);
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { const opened = await handle.stat(); if (!(before.dev === opened.dev && before.ino === opened.ino && before.size === opened.size && before.ctimeMs === opened.ctimeMs)) throw new Error("Canonical receipt identity changed"); await handle.sync(); }
    finally { await handle.close(); }
    await fsyncDirectory(this.root, rootIdentity);
  }

  private requireNativeCapability(record: LoadedHistoryRecord | CanonicalHistoryFile, capability: "native epoch transition" | "whole-chain deletion", operation: string): void {
    if (("sourceVersion" in record ? record.sourceVersion : record.version) === 4 && !this.nativeJournalStorage) {
      throw new Error(`Canonical v4 ${operation} requires managed ${capability} capability`);
    }
  }
  private nativeCanonical(record: LoadedHistoryRecord): TurnHistoryV4 {
    if (record.sourceVersion !== 4 || !record.native || !record.providerSession?.modelKey || record.providerSession.revision === undefined) throw new Error("Native canonical membership unavailable");
    const value = { version: 4 as const, conversationId: record.conversationId, messages: record.messages,
      providerSession: { epoch: record.providerSession.epoch, revision: record.providerSession.revision, modelKey: record.providerSession.modelKey },
      ...lastCommitBinding(record), ...v4Extension(record) };
    validateTurnHistoryV4(value, (message) => validateAndCloneMessage(message as HistoryMessage)); return value;
  }
  private coldContext(source: TurnHistoryV4, next: CanonicalHistoryFile, assertOwned: () => Promise<void>, coldSwitch?: NativeColdSwitch): RuntimeNativeColdEpochContext {
    if (!coldSwitch && next.providerSession.modelKey !== source.providerSession.modelKey) throw new ProviderSessionModelChangedError();
    return { hostAuthority: source.native.authority, assertOwned, targetEpoch: next.providerSession.epoch,
      targetHandleId: deriveProviderSessionId(source.conversationId, next.providerSession.epoch), timestamp: 0,
      ...(coldSwitch ? { targetProvenance: coldSwitch.targetProvenance } : {}) };
  }
  private coldRecord(source: TurnHistoryV4, next: CanonicalHistoryFile, coldSwitch?: NativeColdSwitch): TurnHistoryV4 {
    const { descriptor } = this.nativeJournalStorage!.planColdEpoch(source.native.chain, this.coldContext(source, next, async () => {}, coldSwitch));
    const value = { ...next, version: 4 as const, ...v4Extension(source), native: { ...source.native,
      chain: [...source.native.chain.slice(0, -1), descriptor], ...(coldSwitch ? { projection: null } : {}) } };
    if (coldSwitch) {
      // Separate host cold receipt: no paid handoff and no native model_change
      // with a null artifact. Its exact identity survives intent cleanup/restart.
      const identity = { kind: "cold-model-change", sourceDigest: switchDigest(source), ...coldSwitch,
        fromEpoch: source.providerSession.epoch, toEpoch: next.providerSession.epoch, toModelKey: next.providerSession.modelKey };
      Object.assign(value, { lastSwitch: { version: 1, kind: "cold", messageDigest: coldSwitch.messageDigest, switchId: switchDigest({ namespace: "mono-cold-switch-v1", identity }),
        intentDigest: switchDigest(identity), fromEpoch: identity.fromEpoch, toEpoch: identity.toEpoch, artifact: null } });
    }
    validateTurnHistoryV4(value, (message) => validateAndCloneMessage(message as HistoryMessage)); return value;
  }
  private nativeOperationPath(id: string): string { return join(this.root, `.native-history-op.${historyKey(id)}.json`); }
  private validateNativeOperation(value: unknown): asserts value is NativeHistoryOperation {
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== (value.version === 2 ? "coldSwitch,disposition,next,source,timestamp,version" : "disposition,next,source,timestamp,version")
      || ![1, 2].includes(value.version as number) || !["C", "D"].includes(value.disposition as string) || value.timestamp !== 0) throw new TypeError("Invalid native history lifecycle intent");
    validateTurnHistoryV4(value.source, (message) => validateAndCloneMessage(message as HistoryMessage));
    if (value.next !== null) {
      if (isRecord(value.next) && value.next.version === 4) validateTurnHistoryV4(value.next, (message) => validateAndCloneMessage(message as HistoryMessage));
      else validateTurnHistoryV3(value.next, (message) => validateAndCloneMessage(message as HistoryMessage));
      if (value.next.conversationId !== value.source.conversationId) throw new TypeError("Native lifecycle owner changed");
    }
    let coldSwitch: NativeColdSwitch | undefined;
    if (value.version === 2) {
      if (value.disposition !== "C" || !isRecord(value.coldSwitch)
        || Object.keys(value.coldSwitch).sort().join(",") !== "messageDigest,reason,targetProvenance"
        || !["chain_limit", "capacity", "journal_missing"].includes(value.coldSwitch.reason as string)) throw new TypeError("Invalid cold model transition");
      switchHash(value.coldSwitch.messageDigest);
      coldSwitch = value.coldSwitch as unknown as NativeColdSwitch;
      if (!value.next || value.next.version !== 4 || value.next.providerSession.revision !== 0
        || value.next.providerSession.modelKey === value.source.providerSession.modelKey
        || value.next.providerSession.modelKey !== `${coldSwitch.targetProvenance.provider}:${coldSwitch.targetProvenance.model}`
        || switchDigest(value.next.messages) !== switchDigest(value.source.messages)
        || switchDigest(lastCommitBinding(value.next)) !== switchDigest(lastCommitBinding(value.source))) throw new TypeError("Cold model context or binding changed");
    }
    if (value.disposition === "C") {
      if (!value.next || value.next.version !== 4 || (!coldSwitch && value.next.providerSession.modelKey !== value.source.providerSession.modelKey) || switchDigest(this.coldRecord(value.source, value.next, coldSwitch)) !== switchDigest(value.next)) throw new TypeError("Native cold plan changed");
    } else if (value.next && (value.next.version !== 3 || value.next.messages.length || value.next.lastCommit)) throw new TypeError("Invalid native deletion replacement");
  }
  private async readNativeOperationBytes(name: string, rootIdentity: DirectoryIdentity): Promise<Buffer> {
    if (!NATIVE_OPERATION_PATTERN.test(name)) throw new TypeError("Invalid native lifecycle filename");
    const path = join(this.root, name); await assertDirectoryIdentity(this.root, rootIdentity);
    const before = await lstat(path); assertSecureHistoryFile(before, path);
    if (before.size > MAX_NATIVE_OPERATION_BYTES) throw new Error("Native lifecycle intent exceeds its limit");
    const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
    try {
      const opened = await handle.stat(); assertSecureHistoryFile(opened, path); assertSameIdentity(before, opened, path);
      if (opened.size > MAX_NATIVE_OPERATION_BYTES) throw new Error("Native lifecycle intent exceeds its limit");
      const bytes = await handle.readFile(), after = await handle.stat(), named = await lstat(path);
      assertSecureHistoryFile(after, path); assertSecureHistoryFile(named, path); assertSameIdentity(opened, after, path); assertSameIdentity(after, named, path);
      if (opened.size !== after.size || opened.ctimeMs !== after.ctimeMs || after.ctimeMs !== named.ctimeMs || bytes.length !== after.size) throw new Error("Native lifecycle intent changed");
      await assertDirectoryIdentity(this.root, rootIdentity); return bytes;
    } finally { await handle.close(); }
  }
  private async readNativeOperation(id: string, rootIdentity: DirectoryIdentity): Promise<NativeHistoryOperation | undefined> {
    let bytes; try { bytes = await this.readNativeOperationBytes(`.native-history-op.${historyKey(id)}.json`, rootIdentity); }
    catch (error) { if (isErrno(error, "ENOENT")) return undefined; throw error; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); this.validateNativeOperation(value);
    if (value.source.conversationId !== id) throw new TypeError("Native lifecycle filename/owner mismatch");
    await this.assertNativeRecordAuthority({ ...value.source, sourceVersion: 4 }, rootIdentity); return value;
  }
  private async nativeOperationFootprint(rootIdentity: DirectoryIdentity, native?: Awaited<ReturnType<RuntimeNativeJournalStorage["inventory"]>>): Promise<{ bytes: number; reserved: number; keys: Set<string> }> {
    const compute = async () => {
      let bytes = 0, reserved = 0; const keys = new Set<string>();
      const physical = this.nativeJournalStorage ? native ?? await this.managedNativeInventory(rootIdentity) : undefined;
      for (const name of await readdir(this.root)) {
        const match = NATIVE_OPERATION_PATTERN.exec(name); if (!match) continue;
        const path = join(this.root, name), info = await lstat(path); assertSecureHistoryFile(info, path);
        if (info.size > MAX_NATIVE_OPERATION_BYTES) throw new Error("Native lifecycle intent exceeds its limit"); bytes += info.size; keys.add(match[1]!);
        // Accounting does not need dispatchable membership. Invalid owner evidence
        // remains charged and protected rather than blocking unrelated mutation.
        try {
          const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.readNativeOperationBytes(name, rootIdentity))); this.validateNativeOperation(raw);
          if (historyKey(raw.source.conversationId) !== match[1]) throw new TypeError("Native lifecycle coordinates changed");
          if (raw.disposition === "C" && raw.next) {
            const plan = this.nativeJournalStorage!.planColdEpoch(raw.source.native.chain, this.coldContext(raw.source, raw.next, async () => {}, raw.coldSwitch));
            reserved += Math.max(0, plan.bytes - (physical?.journals[plan.descriptor.journalId]?.retainedBytes ?? 0));
          }
        } catch (error) { if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error; }
      }
      await assertDirectoryIdentity(this.root, rootIdentity); return { bytes, reserved, keys };
    };
    return this.rootAccounting ? this.rootAccounting.operations ??= compute() : compute();
  }
  /** Called under a root transaction; native side effects begin only after this
   * exact intent and its directory are durable. A killed unpublished stage has
   * no effect and follows the existing abandoned-stage cleanup policy. */
  private async publishNativeOperation(operation: NativeHistoryOperation, rootIdentity: DirectoryIdentity): Promise<void> {
    this.validateNativeOperation(operation);
    const id = operation.source.conversationId, current = await this.readNativeOperation(id, rootIdentity);
    if (current) { if (switchDigest(current) !== switchDigest(operation)) throw new Error("Conflicting native lifecycle intent"); return; }
    const bytes = Buffer.from(`${JSON.stringify(operation)}\n`); if (bytes.length > MAX_NATIVE_OPERATION_BYTES) throw new Error("Native lifecycle intent exceeds its limit");
    const temporary = join(this.root, `.${historyKey(id)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
    await writePreparedFile(temporary, bytes, this.root, rootIdentity); await this.nativePhase("lifecycle_intent_stage_synced");
    await rename(temporary, this.nativeOperationPath(id)); await this.nativePhase("lifecycle_intent_renamed");
    await fsyncDirectory(this.root, rootIdentity); await this.nativePhase("lifecycle_intent_directory_synced");
  }
  private nativeIoOutsideRoot(rootIdentity: DirectoryIdentity, release: () => Promise<void>, replace: (unlock: () => Promise<void>) => void): NativeHistoryIo {
    let rootHeld = true;
    const run = async <T>(action: () => Promise<T>): Promise<T> => {
      // A failed release/reacquisition is not an owner-local action failure.
      // Keep the flag false until the caller has a real root unlock again.
      rootHeld = false;
      await release(); replace(async () => {});
      try { return await action(); }
      finally { replace(await this.acquireRootTransaction(rootIdentity)); rootHeld = true; }
    };
    return Object.assign(run, { isRootHeld: () => rootHeld });
  }
  /** The caller holds both the exact/logical owner and a root transaction.
   * Canonical membership survives native deletion, including every unlink crash. */
  private async finishNativeOperation(operation: NativeHistoryOperation, rootIdentity: DirectoryIdentity, assertOwned: () => Promise<void>, nativeIo: NativeHistoryIo): Promise<void> {
    if (!this.nativeJournalStorage) throw new Error("Managed native lifecycle capability required");
    const id = operation.source.conversationId;
    const owned = async () => {
      await assertOwned(); await this.assertNativeRecordAuthority({ ...operation.source, sourceVersion: 4 }, rootIdentity);
      const latest = await this.readRecord(id, rootIdentity, true);
      const sourceMatches = latest.sourceVersion === 4 && switchDigest(this.nativeCanonical(latest)) === switchDigest(operation.source);
      const nextMatches = operation.next === null ? latest.sourceVersion === 0 : latest.sourceVersion === operation.next.version
        && switchDigest({ version: latest.sourceVersion, conversationId: id, messages: latest.messages, providerSession: latest.providerSession,
          ...lastCommitBinding(latest), ...v4Extension(latest) }) === switchDigest(operation.next);
      if (!sourceMatches && !nextMatches) throw new Error("Canonical membership changed during native lifecycle transaction");
    };
    await owned();
    // A recovered rename must regain the intent's file/directory barriers before
    // it can authorize physical mutation in this process.
    const intentPath = this.nativeOperationPath(id), beforeIntent = await lstat(intentPath);
    const intentHandle = await open(intentPath, fsConstants.O_RDONLY | noFollowFlag());
    try { assertSameIdentity(beforeIntent, await intentHandle.stat(), intentPath); await intentHandle.sync(); }
    finally { await intentHandle.close(); }
    await fsyncDirectory(this.root, rootIdentity);
    const source = operation.source;
    const current = await this.readRecord(id, rootIdentity, true);
    const sourceMatches = current.sourceVersion === 4 && switchDigest(this.nativeCanonical(current)) === switchDigest(source);
    if (operation.disposition === "C" && sourceMatches) {
      const next = operation.next!;
      const chain = await nativeIo(() => this.nativeJournalStorage!.publishColdEpoch(source.native.chain, this.coldContext(source, next, owned, operation.coldSwitch)));
      if (switchDigest(chain) !== switchDigest((next as TurnHistoryV4).native.chain)) throw new Error("Native cold publication conflicts with persisted plan");
    }
    if (operation.disposition === "C" && !sourceMatches) {
      await nativeIo(() => this.nativeJournalStorage!.verifyColdEpoch(source.native.chain, this.coldContext(source, operation.next!, owned, operation.coldSwitch)));
    }
    if (operation.disposition === "D") {
      await nativeIo(() => this.nativeJournalStorage!.deleteJournals(source.native.chain, { disposition: "D", hostAuthority: source.native.authority, assertOwned: owned }));
      await this.nativePhase("lifecycle_native_deleted");
      await this.modelSwitchPayloads(rootIdentity).removeConversation(id, source.native.authority.ownerKey, owned, this.nativePhase);
      await this.nativePhase("lifecycle_switch_storage_deleted");
      await this.removePendingConversation(historyKey(id), rootIdentity, owned);
      await this.nativePhase("lifecycle_pending_deleted");
    }
    if (sourceMatches) {
      if (operation.next) {
        const stage = await this.writeStage(operation.next, rootIdentity); await this.nativePhase("lifecycle_canonical_stage_synced");
        await owned(); await rename(stage.temporaryPath, this.recordPath(id));
      } else { await owned(); await rm(this.recordPath(id)); }
      this.invalidateCanonicalAccounting(`${historyKey(id)}${HISTORY_FILE_SUFFIX}`);
      await this.nativePhase("lifecycle_canonical_published");
    }
    await this.syncLifecycleCanonical(id, operation.next !== null, rootIdentity); await this.nativePhase("lifecycle_canonical_directory_synced");
    if (operation.disposition === "C") {
      await nativeIo(() => this.nativeJournalStorage!.deleteJournals(source.native.chain, { disposition: "C", eligibleJournalId: source.native.chain.at(-1)!.journalId,
        hostAuthority: source.native.authority, assertOwned: owned })); await this.nativePhase("lifecycle_native_deleted");
    }
    const fence = await this.findDirtyFence(historyKey(id), await this.ensureLocksRoot());
    if (fence) {
      const handle = fence.providerSessionId ?? deriveProviderSessionId(id, fence.epoch);
      if (!source.native.chain.some((entry) => entry.handleId === handle)) throw new Error("Native lifecycle fence is outside the authorized chain");
      await this.removeDirtyFenceAfterCommit(fence);
    }
    await this.removePendingConversation(historyKey(id), rootIdentity, owned); await this.nativePhase("lifecycle_fence_cleaned");
    await owned(); await rm(this.nativeOperationPath(id)); await this.nativePhase("lifecycle_intent_removed");
    await fsyncDirectory(this.root, rootIdentity); await this.nativePhase("lifecycle_intent_removal_synced");
  }
  private async syncLifecycleCanonical(id: string, present: boolean, rootIdentity: DirectoryIdentity): Promise<void> {
    if (present) await this.syncManagedCanonical(id, rootIdentity); else await fsyncDirectory(this.root, rootIdentity);
  }
  private async nativeOperationOwners(rootIdentity: DirectoryIdentity): Promise<NativeHistoryOperation[]> {
    const operations: NativeHistoryOperation[] = [];
    for (const name of await readdir(this.root)) {
      if (!NATIVE_OPERATION_PATTERN.test(name)) continue;
      const path = join(this.root, name), info = await lstat(path); assertSecureHistoryFile(info, path);
      if (info.size > MAX_NATIVE_OPERATION_BYTES) throw new Error("Native lifecycle intent exceeds its limit");
      try {
        const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.readNativeOperationBytes(name, rootIdentity))); this.validateNativeOperation(raw);
        const operation = await this.readNativeOperation(raw.source.conversationId, rootIdentity);
        if (!operation || this.nativeOperationPath(raw.source.conversationId) !== path) throw new TypeError("Native lifecycle filename changed"); operations.push(operation);
      } catch (error) { if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error; }
    }
    return operations;
  }
  /** Cleanup invariants:
   * - prepareRecord/provider admission: only our logical D may run before
   *   reservation; a foreign failure cannot block an unrelated owner.
   * - resumeInactiveNativeDeletions: borrowed ownership prevents same-owner
   *   stranding; without native capability do nothing. Foreign D runs only as
   *   post-commit maintenance; owner/native failures are diagnostic only while
   *   the root is held. Failed root reacquisition aborts maintenance.
   * - retentionPlan: protect persisted/busy evidence, preserve LRU, probe only
   *   needed victims and never grant capacity credit from an excluded victim.
   * - applyRetention: exclude busy or failed-intent victims and replan so a
   *   free victim can restore quotas; never continue after losing the root lock.
   * Accepted limits: a v4 logical owner busy in another process can be admitted
   * for credit and leave maintenance pending. The replan bound is fixed at the
   * start-of-maintenance entry count (+ one final plan), not extended by arrivals.
   */
  private async resumeInactiveNativeDeletions(rootIdentity: DirectoryIdentity, nativeIo: NativeHistoryIo,
    committingOwner: HeldLogicalConversation, phase: "prepare" | "maintenance"): Promise<void> {
    if (!this.nativeJournalStorage) return;
    const active = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    for (const operation of await this.nativeOperationOwners(rootIdentity)) {
      const id = operation.source.conversationId, logicalId = logicalConversationIdForFence(id);
      if (operation.disposition !== "D" || active.has(historyKey(id))
        || phase === "prepare" && logicalId !== committingOwner.logicalConversationId) continue;
      let owner: HeldLogicalConversation | undefined, exact: HeldExactConversationClaim | undefined;
      try {
        try {
          owner = committingOwner.logicalConversationId === logicalId ? committingOwner : await this.acquireLogicalConversation(logicalId, true);
          if (requiresExactConversationClaim(id)) exact = await this.acquireExactConversationClaim(id, true);
          await this.finishNativeOperation(operation, rootIdentity, () => owner!.assertOwned(), nativeIo);
        } finally { await exact?.release(); if (owner !== committingOwner) await owner?.release(); }
      } catch (error) {
        if (!nativeIo.isRootHeld()) throw error;
        if (error instanceof HistoryOwnerBusyError) continue;
        if (phase === "prepare") throw error;
        recordPostCommitMaintenanceFailure(this.root, error);
      }
    }
  }
  private async recoverNativeOperation(id: string, held: HeldConversation): Promise<void> {
    let releaseRoot = await this.acquireRootTransaction(held.rootIdentity);
    const nativeIo = this.nativeIoOutsideRoot(held.rootIdentity, () => releaseRoot(), (release) => { releaseRoot = release; });
    try { const operation = await this.readNativeOperation(id, held.rootIdentity); if (operation) await this.finishNativeOperation(operation, held.rootIdentity, () => held.assertOwned(), nativeIo); }
    finally { await releaseRoot(); }
  }

  async load(conversationId: string): Promise<readonly HistoryMessage[]> {
    const normalizedId = normalizeConversationId(conversationId);
    const rootIdentity = await this.ensureRoot();
    const record = await this.readRecord(normalizedId, rootIdentity);
    const retained = retainHistoryMessages(record.messages, this.maxMessages);
    return retained.map(cloneMessage);
  }

  async readProviderSessionBinding(conversationId: string): Promise<{ readonly modelKey?: string; readonly revision: number; readonly native?: true } | undefined> {
    const normalizedId = normalizeConversationId(conversationId);
    const rootIdentity = await this.ensureRoot();
    const record = await this.readRecord(normalizedId, rootIdentity);
    const provider = record.providerSession;
    return provider === undefined ? undefined : { ...modelBinding(provider.modelKey), revision: provider.revision ?? 0, ...(record.sourceVersion === 4 ? { native: true as const } : {}) };
  }

  async append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void> {
    const prepared = await this.prepareAppend(conversationId, messages);
    try {
      await prepared.commit();
    } catch (error) {
      await prepared.abort().catch(() => undefined);
      throw error;
    }
  }

  async reset(conversationId: string): Promise<void> {
    const normalizedId = normalizeConversationId(conversationId);
    await this.resetPhysicalConversation(normalizedId);
  }

  async resetLogicalConversation(logicalConversationId: string): Promise<void> {
    const logicalId = normalizeConversationId(logicalConversationId);
    const heldLogical = await this.acquireLogicalConversation(logicalId);
    let heldExact: HeldExactConversationClaim | undefined;
    try {
      const rootIdentity = heldLogical.rootIdentity;
      // A normalized logical id may itself end in a rollover-shaped suffix.
      // Appends then associate that exact physical id with its parent logical
      // session, so claim that exact id before discovery as well as owning this
      // reset's logical claim. The claim is an exact owner row rather than a
      // long-held physical shard transaction, avoiding both sibling blocking
      // and same-shard re-entrancy while the reset visits rollover children.
      if (requiresExactConversationClaim(logicalId)) {
        heldExact = await this.acquireExactConversationClaim(logicalId);
      }
      const conversationIds = new Set<string>();
      const unattributableNames = new Set<string>();
      let orderedIds: string[];
      const releaseDiscovery = await this.acquireRootTransaction(rootIdentity);
      try {
        const entries = await this.scanCommittedEntries(rootIdentity, true);
        for (const entry of entries) {
          const record = await this.readCommittedEntryRecord(entry, rootIdentity);
          if (belongsToLogicalConversation(record.conversationId, logicalId)) {
            this.requireNativeCapability(record, "whole-chain deletion", "logical reset");
            conversationIds.add(record.conversationId);
          }
        }
        for (const entry of await this.pendingPayloads(rootIdentity).list()) {
          try {
            const { payload } = await this.pendingPayloads(rootIdentity).inspect(entry);
            if (belongsToLogicalConversation(payload.identity.historyBucket, logicalId)) conversationIds.add(payload.identity.historyBucket);
          } catch {
            // Unattributable generations are preserved and charged, not a reason
            // to prevent resetting an unrelated logical session. Exact reset and
            // validated logical fence coordinates can still clear known owners.
            await assertDirectoryIdentity(this.root, rootIdentity);
            await assertDirectoryIdentity(join(this.root, LOCKS_DIRECTORY), await this.ensureLocksRoot());
            unattributableNames.add(entry.name);
            // Filename coordinates are sufficient for the exact logical base.
            // Validated child identities below are reset under their own claims,
            // which also clear every torn generation at those known coordinates.
            if (entry.conversationKey === historyKey(logicalId)) conversationIds.add(logicalId);
          }
        }
        for (const operation of await this.nativeOperationOwners(rootIdentity)) {
          if (belongsToLogicalConversation(operation.source.conversationId, logicalId)) conversationIds.add(operation.source.conversationId);
        }
        orderedIds = [...conversationIds].sort();
        await heldLogical.assertOwned();
        // Fail before resetting any sibling, not midway through logical reset.
        for (const id of orderedIds) await this.requireNoModelSwitch(id, rootIdentity);
      } finally { await releaseDiscovery(); }
      if (orderedIds.includes(logicalId)) {
        await this.resetPhysicalConversation(logicalId, heldLogical, heldExact);
      }
      for (const conversationId of orderedIds) {
        if (conversationId === logicalId) continue;
        await this.resetPhysicalConversation(conversationId, heldLogical);
      }
      await this.resetDirtyFencesForLogicalConversation(logicalId, heldLogical);
      const releaseDiagnostics = await this.acquireRootTransaction(rootIdentity);
      try {
        await heldLogical.assertOwned();
        const preserved = (await this.pendingPayloads(rootIdentity).list()).filter((entry) => unattributableNames.has(entry.name)).length;
        if (preserved > 0) recordPostCommitMaintenanceFailure(this.root, new Error(
          `Logical reset preserved ${preserved} unattributable pending entries; exact-owner reset is required to clear unknown coordinates.`));
      } finally { await releaseDiagnostics(); }
    } finally {
      try {
        if (heldExact !== undefined) {
          await heldExact.release();
        }
      } finally {
        await heldLogical.release();
      }
    }
  }

  private async resetDirtyFencesForLogicalConversation(logicalConversationId: string, held: HeldLogicalConversation): Promise<void> {
    const rootIdentity = await this.ensureRoot();
    const locksIdentity = await this.ensureLocksRoot();
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    try {
      const logicalConversationKey = historyKey(logicalConversationId);
      const fences = await this.scanDirtyFences(locksIdentity, false);
      const matching: Array<{ readonly fence: DirtyFence; readonly providerSessionId: string }> = [];
      for (const fence of fences) {
        if (
          fence.conversationKey !== logicalConversationKey
          && fence.logicalConversationKey !== logicalConversationKey
        ) continue;
        const providerSessionId = fence.providerSessionId
          ?? (fence.conversationKey === logicalConversationKey
            ? deriveProviderSessionId(logicalConversationId, fence.epoch)
            : undefined);
        if (providerSessionId === undefined) continue;
        if (fence.kind !== undefined && this.retireProviderSession === undefined) {
          throw new Error("Reset of a pending native turn requires fail-closed provider retirement.");
        }
        matching.push({ fence: await this.authorizeFenceReset(fence, locksIdentity), providerSessionId });
      }
      // Every fence remains a crash-recovery journal until all matching provider
      // retirements succeed. A failure therefore leaves the reset retryable and
      // does not partially unlink its dirty-only membership evidence. Discovery,
      // retirement, unlink, and directory durability share the root transaction
      // so an unrelated maintenance sweep cannot consume the same journal.
      await this.retireProviderSessions(matching.map((entry) => ({ providerSessionId: entry.providerSessionId, ...modelBinding(entry.fence.modelKey) })));
      for (const { fence } of matching) {
        await this.removePendingConversation(fence.conversationKey, rootIdentity, () => held.assertOwned());
        await rm(fence.path);
      }
      if (matching.length > 0) await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
    } finally {
      await releaseRoot();
    }
  }

  private async resetPhysicalConversation(
    conversationId: string,
    logicalFence?: HeldLogicalConversation,
    exactFence?: HeldExactConversationClaim,
  ): Promise<void> {
    const held = await this.acquireConversation(conversationId, logicalFence, exactFence);
    await this.resetHeldPhysicalConversation(conversationId, held);
  }

  private async resetHeldPhysicalConversation(
    conversationId: string,
    held: HeldConversation,
  ): Promise<void> {
    const rootIdentity = held.rootIdentity;
    let prepared: PreparedHistoryAppend;
    try {
      const existing = await this.readRecord(conversationId, rootIdentity);
      this.requireNativeCapability(existing, "whole-chain deletion", "reset");
      if (existing.sourceVersion === 4) {
        const source = this.nativeCanonical(existing);
        const operation: NativeHistoryOperation = { version: 1, disposition: "D", source, timestamp: 0,
          next: { version: 3, conversationId, messages: [], providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(existing.providerSession?.modelKey) } } };
        let releaseRoot = await this.acquireRootTransaction(rootIdentity);
        const nativeIo = this.nativeIoOutsideRoot(rootIdentity, () => releaseRoot(), (release) => { releaseRoot = release; });
        try { await this.requireNoModelSwitch(conversationId, rootIdentity); await this.publishNativeOperation(operation, rootIdentity); await this.finishNativeOperation(operation, rootIdentity, () => held.assertOwned(), nativeIo); }
        finally { await releaseRoot(); }
        await this.releaseConversation(held, rootIdentity); return;
      }
      if (this.retireProviderSession === undefined
        && (await this.pendingPayloads(rootIdentity).list()).some((entry) => entry.conversationKey === historyKey(conversationId))) {
        throw new Error("Reset of pending turn payloads requires fail-closed provider retirement.");
      }
      const retirementFence = await this.prepareProviderRetirement(existing, rootIdentity, true);
      prepared = await this.prepareRecord({
        version: STORE_VERSION,
        conversationId,
        messages: [],
        providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(existing.providerSession?.modelKey) },
      }, held, rootIdentity, undefined, retirementFence,
      async () => await this.removePendingConversation(historyKey(conversationId), rootIdentity, () => held.assertOwned()));
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
    try {
      await prepared.commit();
    } catch (error) {
      await prepared.abort().catch(() => undefined);
      throw error;
    }
  }

  async prepareAppend(
    conversationId: string,
    messages: readonly HistoryMessage[],
  ): Promise<PreparedHistoryAppend> {
    const normalizedId = normalizeConversationId(conversationId);
    const admitted = validateAppendMessages(messages);
    const held = await this.acquireConversation(normalizedId);
    const rootIdentity = held.rootIdentity;
    try {
      this.requireNativeCapability(await this.readRecord(normalizedId, rootIdentity), "native epoch transition", "host-only append");
      await this.settleHeldTurn(normalizedId, held);
      const existing = await this.readRecord(normalizedId, rootIdentity);
      const retirementFence = await this.prepareProviderRetirement(existing, rootIdentity);
      const combined = [...existing.messages, ...admitted];
      const retained = retainHistoryMessages(combined, this.maxMessages);
      const record: CanonicalHistoryFile = {
        version: STORE_VERSION,
        conversationId: normalizedId,
        messages: retained,
        ...lastCommitBinding(existing),
        // Host-only history is not present in a provider transcript. Rotate on
        // every ordinary append so no old provider cache can be resumed.
        providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(existing.providerSession?.modelKey) },
      };
      return await this.prepareRecord(record, held, rootIdentity, undefined, retirementFence);
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
  }

  private async beginExclusiveTurn(conversationId: string): Promise<ConversationHistoryExclusiveTurn> {
    const normalizedId = normalizeConversationId(conversationId);
    const heldLogical = await this.acquireLogicalConversation(logicalConversationIdForFence(normalizedId));
    let heldExact: HeldExactConversationClaim | undefined;
    let marker: ActiveMarker | undefined;
    let settled = false;
    let prepared = false;
    let operation = Promise.resolve();
    const serialize = <T>(action: () => Promise<T>): Promise<T> => {
      const current = operation.then(action, action);
      operation = current.then(() => undefined, () => undefined);
      return current;
    };
    const releaseLease = async (): Promise<void> => {
      if (settled) return;
      const errors: unknown[] = [];
      if (marker !== undefined) {
        const releaseRoot = await this.acquireRootTransaction(heldLogical.rootIdentity).catch((error) => {
          errors.push(error);
          return undefined;
        });
        if (releaseRoot !== undefined) {
          try {
            await this.removeActiveMarker(marker).catch((error) => errors.push(error));
          } finally {
            await releaseRoot().catch((error) => errors.push(error));
          }
        }
      }
      await heldExact?.release().catch((error) => errors.push(error));
      await heldLogical.release().catch((error) => errors.push(error));
      settled = true;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Exclusive history turn cleanup failed.");
    };
    try {
      if (requiresExactConversationClaim(normalizedId)) {
        heldExact = await this.acquireExactConversationClaim(normalizedId);
      }
      this.requireNativeCapability(await this.readRecord(normalizedId, heldLogical.rootIdentity), "native epoch transition", "exclusive host-only mutation");
      const settlementOwner = await this.acquireConversation(normalizedId, heldLogical, heldExact);
      try { await this.settleHeldTurn(normalizedId, settlementOwner); }
      finally { await this.releaseConversation(settlementOwner, settlementOwner.rootIdentity); }
      const locksIdentity = await this.ensureLocksRoot();
      const releaseRoot = await this.acquireRootTransaction(heldLogical.rootIdentity);
      try {
        await this.retireInactiveDirtyFences(
          heldLogical.rootIdentity,
          locksIdentity,
          historyKey(normalizedId),
        );
        requireSettledFence(await this.findDirtyFence(historyKey(normalizedId), locksIdentity));
        marker = await this.createActiveMarker(historyKey(normalizedId), locksIdentity);
      } finally {
        await releaseRoot();
      }
      const existing = await this.readRecord(normalizedId, heldLogical.rootIdentity);
      const historyVersion = historyRecordVersion(existing);
      return {
        history: existing.messages.map(cloneMessage),
        historyVersion,
        prepareCommit: async (messages) => await serialize(async () => {
          if (settled) throw new Error("Exclusive history turn is already settled.");
          if (prepared) throw new Error("Exclusive history turn already has a prepared commit.");
          prepared = true;
          const admitted = validateAppendMessages(messages);
          let held: HeldConversation | undefined;
          try {
            held = await this.acquireConversation(normalizedId, heldLogical, heldExact);
            const current = await this.readRecord(normalizedId, held.rootIdentity);
            if (historyRecordVersion(current) !== historyVersion) {
              throw new Error("Canonical conversation history changed during the exclusive turn.");
            }
            const retirementFence = await this.prepareProviderRetirement(current, held.rootIdentity);
            const retained = retainHistoryMessages([...current.messages, ...admitted], this.maxMessages);
            const record: CanonicalHistoryFile = {
              version: STORE_VERSION,
              conversationId: normalizedId,
              messages: retained,
              ...lastCommitBinding(current),
              providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(current.providerSession?.modelKey) },
            };
            const inner = await this.prepareRecord(record, held, held.rootIdentity, undefined, retirementFence);
            held = undefined;
            let appendState: "open" | "committed" | "aborted" = "open";
            const append: PreparedHistoryAppend = {
              commit: async () => {
                if (appendState === "committed") return;
                if (appendState === "aborted") throw new Error("Cannot commit an aborted history append.");
                await inner.commit();
                appendState = "committed";
                await releaseLease();
              },
              abort: async () => {
                if (appendState !== "open") return;
                appendState = "aborted";
                const errors: unknown[] = [];
                await inner.abort().catch((error) => errors.push(error));
                await releaseLease().catch((error) => errors.push(error));
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) throw new AggregateError(errors, "Exclusive history append abort failed.");
              },
            };
            return { append, committedHistoryVersion: historyRecordVersion(record) };
          } catch (error) {
            if (held !== undefined) await this.releaseConversation(held, held.rootIdentity).catch(() => undefined);
            await releaseLease().catch(() => undefined);
            throw error;
          }
        }),
        abort: async () => await serialize(releaseLease),
      };
    } catch (error) {
      await releaseLease().catch(() => undefined);
      throw error;
    }
  }

  private async prepareContextImport(
    conversationId: string,
    request: AgentContextImportRequest & { readonly timestamp: string },
  ): Promise<{ readonly result: AgentContextImportResult; readonly append?: PreparedHistoryAppend }> {
    if (this.contextImport === undefined) throw new Error("Canonical context import is unsupported by this store configuration.");
    const normalizedId = normalizeConversationId(conversationId);
    const normalized = validateContextImportRequest(request);
    const held = await this.acquireConversation(normalizedId);
    const rootIdentity = held.rootIdentity;
    try {
      this.requireNativeCapability(await this.readRecord(normalizedId, rootIdentity), "native epoch transition", "context import");
      await this.settleHeldTurn(normalizedId, held);
      const existing = await this.readRecord(normalizedId, rootIdentity, true);
      const exactPair = findContextImportPair(existing.messages, normalized.idempotencyKey);
      if (exactPair !== undefined) {
        await this.releaseConversation(held, rootIdentity);
        if (exactPair.valid && exactPair.text === normalized.text) return { result: { status: "duplicate" } };
        return { result: { status: "conflict", reason: "idempotency_conflict" } };
      }
      if (existing.messages.length > 0) {
        await this.releaseConversation(held, rootIdentity);
        return { result: { status: "conflict", reason: "conversation_not_empty" } };
      }
      const retirementFence = await this.prepareProviderRetirement(existing, rootIdentity);
      const messages: readonly HistoryMessage[] = [
        { role: "system", name: "context-import-provenance", content: AGENT_CONTEXT_IMPORT_SYSTEM_PROVENANCE, timestamp: normalized.timestamp },
        { role: "assistant", name: "context-import", content: normalized.text, timestamp: normalized.timestamp, idempotencyKey: normalized.idempotencyKey },
      ];
      const record: CanonicalHistoryFile = {
        version: STORE_VERSION,
        conversationId: normalizedId,
        messages,
        ...lastCommitBinding(existing),
        providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(existing.providerSession?.modelKey) },
      };
      return {
        result: { status: "appended" },
        append: await this.prepareRecord(record, held, rootIdentity, undefined, retirementFence),
      };
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
  }

  /** Settle/capture under one owner before host preparation, without admitting
   * incoming execution. Default callers still use beginProviderSessionTurn. */
  async beginProviderSessionPreparation(conversationId: string, runId: string): Promise<ManagedProviderSessionPreparation> {
    const id = normalizeConversationId(conversationId), normalizedRunId = normalizeRunId(runId);
    const held = await this.acquireConversation(id);
    let state: "prepared" | "transferred" | "closed" = "prepared";
    let queue = Promise.resolve();
    const children = new Set<() => Promise<void>>();
    const assertOwned = async () => {
      if (state !== "prepared") throw new Error("Provider preparation is no longer owned");
      await held.assertOwned();
      if (state !== "prepared") throw new Error("Provider preparation is no longer owned");
    };
    const serialize = <T>(action: () => Promise<T>): Promise<T> => {
      const current = queue.then(action, action); queue = current.then(() => undefined, () => undefined); return current;
    };
    const owned = <T>(action: () => Promise<T>) => serialize(async () => { await assertOwned(); return await action(); });
    const borrowed = { ...held, assertOwned };
    const closeChildren = async () => { for (const release of children) await release(); children.clear(); };
    try {
      const recovery = await this.settleHeldTurn(id, held);
      return {
        recovery,
        assertOwned,
        read: () => owned(async () => {
          const record = await this.readRecord(id, held.rootIdentity);
          const pending = (await this.modelSwitchPayloads(held.rootIdentity).inventory()).pending.filter((entry) => entry.state.identity.historyBucket === id);
          if (pending.length > 1) throw new Error("Conflicting pending model switches");
          return structuredClone({ ...(pending[0] ? { pending: pending[0].state } : {}), history: record.messages, source: await this.modelSwitchStorageSource(id),
            ...(record.native ? { native: record.native } : {}), ...(record.lastSwitch ? { lastSwitch: record.lastSwitch } : {}) });
        }),
        captureNativeEvidence: (legacyProvenance) => owned(async () => {
          const native = this.nativeJournalStorage as Partial<import("@mono-agent/runtime-adapter").RuntimeNativePreparationStorage> | undefined;
          if (native?.nativeEvidence !== "v1" || !native.captureEvidence || !native.freeze) throw new Error("Native evidence capture capability unavailable");
          const source = await this.modelSwitchStorageSource(id), record = await this.readRecord(id, held.rootIdentity);
          if (source.status !== "supported") throw new Error("Native evidence source unavailable");
          if (legacyProvenance && `${legacyProvenance.provider}:${legacyProvenance.model}` !== source.fromModelKey) throw new Error("Legacy source model disagrees with canonical binding");
          const sources = record.native ? [...record.native.chain] : [{ epoch: source.sourceEpoch, ordinal: 0,
            handleId: deriveProviderSessionId(id, source.sourceEpoch), predecessorJournalId: null, ownerKey: source.ownerKey, historyBucket: id,
            ...(legacyProvenance ? { provenance: { ...structuredClone(legacyProvenance), account: null } } : {}) }];
          const current = await native.freeze(sources.at(-1)!);
          if (`${current.provenance.provider}:${current.provenance.model}` !== source.fromModelKey) throw new Error("Captured source model disagrees with canonical binding");
          const frozen = [...sources.slice(0, -1), current] as CanonicalJournalDescriptor[];
          const view = await native.captureEvidence(frozen, { ownerKey: source.ownerKey, historyBucket: id,
            ...(record.native ? { hostAuthority: record.native.authority } : {}), assertOwned });
          await assertOwned(); return { sources: structuredClone(frozen), view };
        }),
        readHandoff: (switchId, reference) => owned(async () => {
          switchHash(switchId); validateSwitchReference(reference);
          const payloads = this.modelSwitchPayloads(held.rootIdentity), record = await this.readRecord(id, held.rootIdentity);
          const pending = await payloads.read(id, switchId);
          const ready = pending?.state.phase === "ready" ? pending.state.artifact : undefined;
          const canonical = record.lastSwitch?.switchId === switchId ? record.native?.projection : undefined;
          if (switchDigest(reference) !== switchDigest(ready ?? canonical ?? null)) throw new Error("Handoff is not the accepted current or pending projection");
          const cached = await payloads.readArtifact(id, switchId, reference);
          validateFrozenHandoffBudget(cached.artifact.budget);
          await assertOwned(); return { artifact: structuredClone(cached.artifact), budget: structuredClone(cached.artifact.budget) };
        }),
        acquireNativeHistoryAuthority: (options) => owned(async () => {
          if (options?.exclusiveWriters !== true) throw new TypeError("Native root authority requires exclusive upgraded writers");
          if (id.length > 512 || held.logical.logicalConversationId.length > 512) return { status: "unsupported" as const, reason: "id_limit" as const };
          const lease = await this.acquireHeldNativeHistoryAuthority(id, borrowed, false);
          if (lease.status === "unsupported") return lease;
          children.add(lease.release);
          return { status: "owned" as const, authority: lease.authority,
            assertOwned: async () => { await assertOwned(); await lease.assertOwned(); }, release: () => serialize(() => lease.release()) };
        }),
        beginModelSwitchStorage: (input) => owned(async () => {
          validateModelSwitchState(input); const intent = structuredClone(input);
          if (intent.identity.historyBucket !== id || intent.identity.ownerKey !== logicalConversationIdForFence(id)) throw new Error("Prepared switch belongs to another owner/bucket");
          if (id.length > 512 || intent.identity.ownerKey.length > 512) return { status: "unsupported" as const, reason: "id_limit" as const };
          const lease = await this.beginHeldModelSwitchStorage(intent, borrowed, false);
          if (lease.status === "unsupported") return lease;
          children.add(lease.release);
          return { status: "owned" as const, read: () => owned(() => lease.read()),
            admit: (producer) => owned(() => lease.admit(producer)), finish: (producer, outcome) => owned(() => lease.finish(producer, outcome)),
            advanceUnfit: () => owned(() => lease.advanceUnfit()), authorizeMessage: (digest) => owned(() => lease.authorizeMessage(digest)),
            accept: (artifact) => owned(() => lease.accept(artifact)), recoverArtifact: () => owned(() => lease.recoverArtifact()),
            release: () => serialize(() => lease.release()) };
        }),
        rollForwardModelSwitch: (switchId, options) => owned(async () => {
          if (options?.exclusiveWriters !== true || !this.nativeJournalStorage) throw new Error("Managed native switch capability and exclusive writers required");
          return await this.rollForwardHeldModelSwitch(id, switchId, borrowed, options.onPhase);
        }),
        coldModelChange: (input) => {
          let request: typeof input;
          try { request = structuredClone(input); } catch (error) { return Promise.reject(error); }
          return owned(async () => {
            assertSessionModelKey(request.modelKey);
            if (typeof request.messageId !== "string" || !request.messageId.length || request.messageId.length > 512) throw new TypeError("Persisted cold delivery identity required");
            await this.settleHeldTurn(id, borrowed); await this.requireNoModelSwitch(id, held.rootIdentity);
            const record = await this.readRecord(id, held.rootIdentity);
            if (record.providerSession?.dirtyRunId !== undefined) throw new Error("Cold model transition requires a settled outgoing current epoch");
            const source = this.nativeCanonical(record);
            if (source.providerSession.modelKey === request.modelKey) {
              if (source.lastSwitch?.kind === "cold" && source.lastSwitch.messageDigest === switchDigest({ persistedDelivery: request.messageId }) && source.native.projection === null) return structuredClone(source.lastSwitch);
              throw new Error("Cold model transition requires a different model");
            }
            switchHash(request.sourceCanonicalDigest);
            if (request.sourceCanonicalDigest !== switchDigest(source)) throw new Error("Cold model source changed after host preparation");
            const coldSwitch: NativeColdSwitch = { messageDigest: switchDigest({ persistedDelivery: request.messageId }),
              targetProvenance: request.targetProvenance, reason: request.reason };
            const next = this.coldRecord(source, { version: 3, conversationId: id, messages: source.messages,
              ...lastCommitBinding(source), providerSession: { epoch: createProviderSessionEpoch(), revision: 0, modelKey: request.modelKey } }, coldSwitch);
            const operation: NativeHistoryOperation = { version: 2, disposition: "C", source, next, timestamp: 0, coldSwitch };
            this.validateNativeOperation(operation); await closeChildren();
            let unlock = await this.acquireRootTransaction(held.rootIdentity);
            const nativeIo = this.nativeIoOutsideRoot(held.rootIdentity, () => unlock(), (release) => { unlock = release; });
            try {
              await assertOwned();
              // A legacy dirty fence is unknown current work too, not C authority.
              if (await this.findDirtyFence(historyKey(id), await this.ensureLocksRoot())) throw new Error("Cold model transition requires a settled outgoing current epoch");
              await this.reserveNativeCold(operation, held.rootIdentity); await this.publishNativeOperation(operation, held.rootIdentity);
              // Unlike ordinary post-commit maintenance, physical C completion is
              // mandatory before P2 admission; failure leaves a reconcilable intent.
              await this.finishNativeOperation(operation, held.rootIdentity, assertOwned, nativeIo);
            } finally { await unlock(); }
            return structuredClone(next.lastSwitch!);
          });
        },
        inspectCurrentJournal: () => owned(async (): Promise<CurrentJournalPresence> => {
          const native = this.nativeJournalStorage;
          if (!native?.inspectCurrentJournal) return { status: "absent" };
          const record = await this.readRecord(id, held.rootIdentity), session = record.providerSession, chain = record.native?.chain;
          if (session?.modelKey === undefined || session.revision === undefined || session.dirtyRunId !== undefined) return { status: "absent" };
          // An unguarded epoch has no journal before its first admitted turn; a
          // guarded epoch is published with its initializer at C/switch time.
          if (!chain && (record.sourceVersion !== STORE_VERSION || session.revision === 0)) return { status: "absent" };
          const current = chain?.at(-1);
          if (current && current.epoch !== session.epoch) return { status: "unreadable", reason: "membership" };
          const presence = await native.inspectCurrentJournal(current ? { handleId: current.handleId, journalId: current.journalId }
            : { handleId: deriveProviderSessionId(id, session.epoch) });
          if (presence.status === "present") { await assertOwned(); return { status: "present" }; }
          if (presence.status === "unreadable") { await assertOwned(); return { status: "unreadable", reason: presence.reason }; }
          // C re-verifies every frozen predecessor before replacing the current.
          // A lost predecessor cannot be proved unchanged: refuse before intent.
          for (const predecessor of chain?.slice(0, -1) ?? []) {
            if ((await native.inspectCurrentJournal({ handleId: predecessor.handleId, journalId: predecessor.journalId })).status !== "present") {
              await assertOwned(); return { status: "unreadable", reason: "predecessor_unavailable" };
            }
          }
          await assertOwned(); return { status: "missing", epoch: session.epoch };
        }),
        admit: (input, options) => {
          const coldModelChange = options?.coldModelChange === true, missingCurrentEpoch = options?.missingCurrentEpoch;
          let binding: ProviderSessionTurnBinding;
          try { binding = structuredClone(input); } catch (error) { return Promise.reject(error); }
          return owned(async () => {
            assertSessionModelKey(binding.modelKey);
            if (binding.reconciliation && Buffer.byteLength(normalizedRunId) > 512) throw new TypeError("Reconciled turn id exceeds 512 bytes.");
            if (binding.reconciliation && this.inspectProviderTurn === undefined) throw new Error("Native turn reconciliation is not configured.");
            await this.settleHeldTurn(id, borrowed);
            await this.requireNoModelSwitch(id, held.rootIdentity);
            const record = await this.readRecord(id, held.rootIdentity);
            if (!coldModelChange && record.providerSession?.modelKey !== undefined && record.providerSession.modelKey !== binding.modelKey) {
              throw new Error("Prepared provider admission requires a ready canonical model binding");
            }
            await closeChildren();
            // All borrowed operations have drained. Only the P2 turn may now own
            // this physical claim; preparation abort cannot release it afterward.
            state = "transferred";
            try {
              if (binding.reconciliation) await this.drainBeforeAdmission(id, normalizedRunId, binding);
            } catch (error) { state = "closed"; await this.releaseConversation(held, held.rootIdentity); throw error; }
            let turnOwned!: () => Promise<void>;
            let native: TurnHistoryV4["native"] | undefined;
            try {
              const turn = await this.beginHeldProviderSessionTurn(id, normalizedRunId, binding, held, (assertion, binding) => { turnOwned = assertion; native = binding; }, missingCurrentEpoch);
              return { ...turn, ...(native ? { native } : {}), assertOwned: () => turnOwned() };
            } catch (error) { state = "closed"; throw error; } // P2 helper released its owner.
          });
        },
        abort: () => serialize(async () => {
          if (state !== "prepared") return;
          state = "closed"; await closeChildren(); await this.releaseConversation(held, held.rootIdentity);
        }),
      };
    } catch (error) { state = "closed"; await this.releaseConversation(held, held.rootIdentity).catch(() => undefined); throw error; }
  }

  async beginProviderSessionTurn(
    conversationId: string,
    runId: string,
    binding?: ProviderSessionTurnBinding,
  ): Promise<ConversationHistoryProviderSessionTurn> {
    if (binding !== undefined) assertSessionModelKey(binding.modelKey);
    const normalizedId = normalizeConversationId(conversationId);
    const normalizedRunId = normalizeRunId(runId);
    if (binding?.reconciliation && Buffer.byteLength(normalizedRunId) > 512) throw new TypeError("Reconciled turn id exceeds 512 bytes.");
    if (binding?.reconciliation !== undefined) await this.drainBeforeAdmission(normalizedId, normalizedRunId, binding);
    const held = await this.acquireConversation(normalizedId);
    return await this.beginHeldProviderSessionTurn(normalizedId, normalizedRunId, binding, held);
  }
  private async beginHeldProviderSessionTurn(normalizedId: string, normalizedRunId: string, binding: ProviderSessionTurnBinding | undefined,
    held: HeldConversation, captureOwnership?: (assertOwned: () => Promise<void>, native?: TurnHistoryV4["native"]) => void,
    missingCurrentEpoch?: string): Promise<ConversationHistoryProviderSessionTurn> {
    const rootIdentity = held.rootIdentity;
    let turnSettled = false;
    let prepared: PreparedHistoryAppend | undefined;
    let preparationInvalidated = false;
    let reconciliationSettlement: { readonly nativeReusable: boolean } | undefined;
    let turnOperation = Promise.resolve();
    const serializeTurn = <T>(action: () => Promise<T>): Promise<T> => {
      const current = turnOperation.then(action, action);
      turnOperation = current.then(() => undefined, () => undefined);
      return current;
    };
    try {
      const recovery = await this.settleHeldTurn(normalizedId, held);
      let existing = await this.readRecord(normalizedId, rootIdentity);
      // Ordinary P2 callers cannot supply the accepted native projection/current
      // authority. Refuse before cold rotation, dirty admission or native I/O.
      // Only owner-held preparation may transfer that proof into dispatch.
      if (existing.sourceVersion === 4 && binding?.unpreparedNativeDispatch === true) throw new OrdinaryNativeDispatchUnavailableError();
      if (binding?.reconciliation && existing.lastCommit?.turnId === normalizedRunId) throw new DurableTurnAlreadyCommittedError();
      const existingProvider = existing.providerSession;
      const modelKey = binding?.modelKey ?? existingProvider?.modelKey;
      const previousModelKey = binding !== undefined && existingProvider?.modelKey !== modelKey
        ? existingProvider?.modelKey : undefined;
      const previousModelWasUnbound = binding !== undefined
        && existingProvider !== undefined
        && existingProvider.modelKey === undefined
        && (existingProvider.revision ?? 0) > 0;
      const conversationKey = historyKey(normalizedId);
      const locksIdentity = await this.ensureLocksRoot();
      let fence: DirtyFence;
      let payload: PendingTurnPayload | undefined;
      let epoch: string;
      let revision: number;
      let releaseRoot = await this.acquireRootTransaction(rootIdentity);
      const nativeIo = this.nativeIoOutsideRoot(rootIdentity, () => releaseRoot(), (release) => { releaseRoot = release; });
      try {
        await this.resumeInactiveNativeDeletions(rootIdentity, nativeIo, held.logical, "prepare");
        await this.requireNoModelSwitch(normalizedId, rootIdentity);
        const existingFence = await this.findDirtyFence(conversationKey, locksIdentity);
        requireSettledFence(existingFence);
        // The read-only preflight can race another process. Guard the binding
        // again under the root transaction before any rotation or retirement.
        if (binding?.skipModelRotation === true && existingProvider !== undefined
          && (existingProvider.modelKey === undefined
            ? (existingProvider.revision ?? 0) > 0
            : existingProvider.modelKey !== binding.modelKey)) {
          throw new ProviderSessionModelChangedError();
        }
        let reusable = (binding === undefined || existingProvider?.modelKey === binding.modelKey)
          && this.maxMessages > 0
          && existingFence === undefined
          && existingProvider !== undefined
          && existingProvider.dirtyRunId === undefined
          && existingProvider.revision !== undefined
          && existingProvider.revision < Number.MAX_SAFE_INTEGER
          // Owner-approved missing-journal recovery: only the exact epoch the
          // preparation probed. A later rotation already replaced it (idempotent).
          && !(missingCurrentEpoch !== undefined && existingProvider.epoch === missingCurrentEpoch);
        if (!reusable) {
          this.requireNativeCapability(existing, "native epoch transition", "provider admission cold rotation");
          if (existing.sourceVersion === 4) {
            const source = this.nativeCanonical(existing), next = this.coldRecord(source, { version: 3, conversationId: normalizedId, messages: existing.messages,
              ...lastCommitBinding(existing), providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(modelKey) } });
            const operation: NativeHistoryOperation = { version: 1, disposition: "C", source, next, timestamp: 0 };
            await this.reserveNativeCold(operation, rootIdentity); await this.publishNativeOperation(operation, rootIdentity);
            await this.finishNativeOperation(operation, rootIdentity, () => held.assertOwned(), nativeIo); existing = await this.readRecord(normalizedId, rootIdentity); reusable = true;
          } else await this.retireProviderSessions([
            ...(existingProvider === undefined
              ? []
              : [{ providerSessionId: deriveProviderSessionId(normalizedId, existingProvider.epoch), ...modelBinding(existingProvider.modelKey) }]),
            ...(existingFence === undefined
              ? []
              : [{ providerSessionId: existingFence.providerSessionId ?? deriveProviderSessionId(normalizedId, existingFence.epoch), ...modelBinding(existingFence.modelKey) }]),
          ]);
        }
        epoch = reusable ? existing.providerSession!.epoch : createProviderSessionEpoch();
        revision = reusable ? existing.providerSession!.revision as number : 0;
        const providerSessionId = deriveProviderSessionId(normalizedId, epoch);
        const projectedCleanRecord = preserveV4(existing, {
          version: STORE_VERSION,
          conversationId: normalizedId,
          messages: retainHistoryMessages(existing.messages, this.maxMessages),
          ...lastCommitBinding(existing),
          providerSession: { epoch, revision: revision + 1, ...modelBinding(modelKey) },
        });
        await this.validateRetentionReservation(rootIdentity, [this.projectRecord(projectedCleanRecord)]);
        await this.reserveDirtyFenceCapacity(conversationKey, rootIdentity, locksIdentity);
        if (binding?.reconciliation !== undefined) {
          if (this.inspectProviderTurn === undefined || modelKey === undefined) throw new Error("Native turn reconciliation is not configured.");
          const admission = binding.reconciliation;
          if (admission.purpose === "execution" ? admission.initial === undefined : admission.initial !== undefined) throw new TypeError("Invalid turn admission purpose/initial input.");
          const purpose = admission.purpose;
          const wire: DurableTurnFence = { version: 5, kind: purpose, conversationKey,
            logicalConversationKey: historyKey(logicalConversationIdForFence(normalizedId)), epoch, providerSessionId, modelKey,
            revision, runIdDigest: digestRunId(normalizedRunId), payload: { generation: "0".repeat(32), sha256: "0".repeat(64) } };
          const inputs = admission.initial === undefined ? [] : [createPendingInitialInput({
            id: `initial:${digestRunId(normalizedRunId)}`, persistText: admission.initial.persistText, timestamp: admission.initial.timestamp,
            ...(admission.initial.senderLabel === undefined ? {} : { senderLabel: admission.initial.senderLabel }),
          }, admission.initial.persistText)];
          payload = createPendingTurnPayload({ purpose, ownerKey: admission.ownerKey, historyBucket: normalizedId, turnId: normalizedRunId,
            handleId: providerSessionId, modelKey, baseRevision: revision, fenceDigest: durableTurnFenceDigest(wire) }, inputs, "admitted");
          const pointer = await this.pendingPayloads(rootIdentity).publish(payload, {
            assertOwned: () => held.assertOwned(), reserve: async (bytes) => await this.validateStagingReservation(rootIdentity, bytes),
          });
          fence = await this.publishDirtyFence({ ...wire, payload: pointer }, locksIdentity);
        } else fence = await this.publishDirtyFence({
          conversationKey,
          logicalConversationKey: historyKey(logicalConversationIdForFence(normalizedId)),
          epoch,
          providerSessionId,
          ...modelBinding(modelKey),
          revision,
          runIdDigest: digestRunId(normalizedRunId),
        }, locksIdentity);
      } finally {
        await releaseRoot();
      }
      const turnBaseRecord = preserveV4(existing, {
        version: STORE_VERSION,
        conversationId: normalizedId,
        messages: existing.messages,
        ...lastCommitBinding(existing),
        providerSession: { epoch, revision, ...modelBinding(modelKey) },
      });
      const providerSessionId = deriveProviderSessionId(normalizedId, epoch);

      captureOwnership?.(async () => await serializeTurn(async () => {
        if (turnSettled || prepared) throw new Error("Prepared provider turn no longer owns executable storage");
        await held.assertOwned();
      }), existing.native ? structuredClone(existing.native) : undefined);
      return {
        ...(recovery.status === "clean" ? {} : { recovery }),
        ...(payload === undefined ? {} : { reconciliation: {
          get settlement() { return reconciliationSettlement; },
          descriptor: pendingTurnDescriptor(payload),
          admit: async (input: PendingTurnInput) => await serializeTurn(async () => {
            if (turnSettled || prepared) throw new Error("Cannot admit input to a settled provider turn.");
            const current = payload!;
            const index = current.inputs.findIndex((entry) => entry.id === input.id);
            if (index !== -1 && input.kind !== current.inputs[index]!.kind) throw new Error("Conflicting durable input placement.");
            if (index !== -1 && current.inputs[index]?.kind !== "initial") {
              if (JSON.stringify(current.inputs[index]) !== JSON.stringify(input)) throw new Error("Conflicting durable live input identity.");
              return;
            }
            const inputs = [...current.inputs]; if (index === -1) inputs.push(input); else inputs[index] = { ...inputs[index]!, requestDigest: input.requestDigest };
            const replacement = createPendingTurnPayload(current.identity, inputs, current.disposition, current.candidate);
            const replacementFence = await this.replacePendingPayload(fence, replacement, held);
            payload = replacement; fence = replacementFence;
          }),
          claim: async (disposition: PendingTurnPayload["disposition"], candidate?: PendingTurnCandidate) => await serializeTurn(async () => {
            if (turnSettled) {
              if (disposition === "detached") throw new Error("Cannot acknowledge detachment after history ownership release.");
              return; // A late result cannot resurrect released evidence.
            }
            if (prepared && disposition !== "cancelled" && disposition !== "failed") throw new Error("Cannot replace a prepared candidate.");
            if (prepared) preparationInvalidated = true;
            const current = payload!;
            // Cancellation is monotonic and dominates native/late completed results.
            const next = current.disposition === "cancelled" ? "cancelled" : disposition;
            const retainedCandidate = current.disposition === "cancelled"
              ? disposition === "cancelled" && candidate?.outcome === "cancelled" ? candidate : current.candidate
              : candidate ?? (next === "cancelled" || next === "failed"
                ? current.candidate?.outcome === next ? current.candidate : undefined : current.candidate);
            // Router detachment is also monotonic, but its final host candidate may update.
            const replacement = createPendingTurnPayload(current.identity, current.inputs,
              next === "cancelled" ? next : current.disposition === "detached" ? "detached" : next, retainedCandidate);
            const replacementFence = await this.replacePendingPayload(fence, replacement, held);
            payload = replacement; fence = replacementFence;
          }),
        } }),
        providerSessionId,
        ...modelBinding(modelKey),
        ...(previousModelKey === undefined ? {} : { previousModelKey }),
        ...(previousModelWasUnbound ? { previousModelWasUnbound: true } : {}),
        providerSessionRevision: revision,
        prepareCommit: async (
          messages: readonly HistoryMessage[],
          options: ProviderSessionTurnCommitOptions,
        ): Promise<PreparedHistoryAppend> => await serializeTurn(async () => {
          if (turnSettled) throw new Error("Provider session turn is already settled.");
          if (prepared !== undefined) throw new Error("Provider session turn already has a prepared commit.");
          if (!isRecord(options) || typeof options.providerSessionSynced !== "boolean") {
            throw new TypeError("providerSessionSynced must be a boolean.");
          }
          const admitted = validateAppendMessages(messages);
          if (payload !== undefined) {
            const settlement = await this.preparePendingSettlement(fence, payload, held, admitted);
            payload = settlement.payload; fence = settlement.fence;
            reconciliationSettlement = { nativeReusable: !settlement.cold };
            prepared = await this.prepareRecord(settlement.record, held, rootIdentity, () => { turnSettled = true; }, fence,
              settlement.cold && existing.sourceVersion !== 4 ? async () => await this.retireProviderSessions([{ providerSessionId, ...modelBinding(modelKey) }]) : undefined,
              false, async () => await this.removePendingConversation(conversationKey, rootIdentity, () => held.assertOwned()));
            const pendingAppend = prepared;
            return { commit: async () => {
              if (preparationInvalidated) throw new Error("Prepared turn invalidated by a terminal host claim; recover before publication.");
              await pendingAppend.commit();
            }, abort: async () => await pendingAppend.abort() };
          }
          if (!options.providerSessionSynced) {
            this.requireNativeCapability(existing, "native epoch transition", "unsynced provider commit");
            // The harness normally invalidates a failed/unsynced live handle
            // first. Retire by exact durable id as a second fail-closed layer:
            // a cold/unknown registry entry must not strand its JSONL.
            if (existing.sourceVersion !== 4) await this.retireProviderSessions([{ providerSessionId, ...modelBinding(modelKey) }]);
          }
          const combined = [...turnBaseRecord.messages, ...admitted];
          const retained = retainHistoryMessages(combined, this.maxMessages);
          const cleanRecord = preserveV4(existing, {
            version: STORE_VERSION,
            conversationId: normalizedId,
            messages: retained,
            ...lastCommitBinding(turnBaseRecord),
            providerSession: {
              epoch: options.providerSessionSynced ? epoch : createProviderSessionEpoch(),
              revision: options.providerSessionSynced ? revision + 1 : 0,
              ...modelBinding(modelKey),
            },
          });
          prepared = await this.prepareRecord(cleanRecord, held, rootIdentity, () => {
            turnSettled = true;
          }, fence);
          return prepared;
        }),
        abort: async (): Promise<void> => await serializeTurn(async () => {
          if (turnSettled) return;
          if (prepared !== undefined) {
            await prepared.abort();
            turnSettled = true;
            return;
          }
          await this.releaseConversation(held, rootIdentity);
          turnSettled = true;
        }),
      };
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
  }

  private async drainBeforeAdmission(conversationId: string, runId: string, binding: ProviderSessionTurnBinding): Promise<void> {
    if (!this.inspectProviderTurn || !binding.reconciliation) throw new Error("Native turn reconciliation is not configured.");
    const admission = binding.reconciliation;
    const inputs = admission.initial === undefined ? [] : [createPendingInitialInput({ id: `initial:${digestRunId(runId)}`,
      persistText: admission.initial.persistText, timestamp: admission.initial.timestamp,
      ...(admission.initial.senderLabel === undefined ? {} : { senderLabel: admission.initial.senderLabel }) }, admission.initial.persistText)];
    const projected = serializePendingTurnPayload(createPendingTurnPayload({ purpose: admission.purpose, ownerKey: admission.ownerKey,
      historyBucket: conversationId, turnId: runId, handleId: "0".repeat(64), modelKey: binding.modelKey,
      baseRevision: 0, fenceDigest: "0".repeat(64) }, inputs, "admitted")).byteLength;
    const rootIdentity = await this.ensureRoot(), locksIdentity = await this.ensureLocksRoot();
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    let needsDrain;
    try {
      const fences = await this.scanDirtyFences(locksIdentity, true);
      const physicalOwners = new Set([...fences.map((fence) => fence.conversationKey),
        ...(await this.pendingPayloads(rootIdentity).list()).map((entry) => entry.conversationKey)]);
      physicalOwners.delete(historyKey(conversationId));
      const existing = await this.readRecord(conversationId, rootIdentity);
      const nextRevision = (existing.providerSession?.revision ?? 0) < Number.MAX_SAFE_INTEGER
        ? (existing.providerSession?.revision ?? 0) + 1 : 1;
      const reservation = await this.retentionPlan(rootIdentity, [this.projectRecord({ version: STORE_VERSION,
        conversationId, messages: retainHistoryMessages(existing.messages, this.maxMessages), ...lastCommitBinding(existing),
        providerSession: { epoch: "0".repeat(64), revision: nextRevision, modelKey: binding.modelKey } })]);
      needsDrain = physicalOwners.size >= this.maxConversations
        || (await this.scanStagedBytes(rootIdentity)) + projected > this.maxStagedBytes
        || reservation.minimumCount > this.maxConversations || reservation.minimumBytes > this.maxStoreBytes;
    } finally { await releaseRoot(); }
    if (needsDrain) await this.drainInactiveTurns({}, historyKey(conversationId));
  }

  async drainPendingProviderSessionTurns(options: ConversationHistoryTurnDrainOptions = {}): Promise<ConversationHistoryTurnDrainResult> {
    return await this.drainInactiveTurns(options);
  }

  private async drainInactiveTurns(options: ConversationHistoryTurnDrainOptions, excludedKey?: string): Promise<ConversationHistoryTurnDrainResult> {
    if (!this.inspectProviderTurn) throw new Error("Pending-turn draining requires configured native reconciliation.");
    const limit = options.limit ?? 32, cursor = options.cursor;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32 || (cursor !== undefined
      && (!Number.isFinite(cursor.mtimeMs) || cursor.mtimeMs < 0 || !/^[a-f0-9]{64}$/u.test(cursor.conversationKey)))) throw new TypeError("Invalid bounded pending-turn drain request.");
    const rootIdentity = await this.ensureRoot(), locksIdentity = await this.ensureLocksRoot();
    const releaseSnapshot = await this.acquireRootTransaction(rootIdentity);
    let candidates;
    try {
      const active = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
      const fences = new Map((await this.scanDirtyFences(locksIdentity, true)).map((fence) => [fence.conversationKey, fence]));
      const owners = new Map<string, { readonly conversationKey: string; mtimeMs: number; readonly entries: Array<{ readonly name: string; readonly mtimeMs: number }> }>();
      for (const entry of await this.pendingPayloads(rootIdentity).list()) {
        if (entry.conversationKey === excludedKey || active.has(entry.conversationKey)) continue;
        const fence = fences.get(entry.conversationKey);
        if (fence && fence.kind !== "execution" && fence.kind !== "compaction") continue;
        if (fence?.payload && entry.generation !== fence.payload.generation) continue;
        const prior = owners.get(entry.conversationKey);
        if (prior) {
          prior.entries.push({ name: entry.name, mtimeMs: entry.mtimeMs });
          prior.mtimeMs = Math.min(prior.mtimeMs, fence?.mtimeMs ?? entry.mtimeMs);
        } else owners.set(entry.conversationKey, { conversationKey: entry.conversationKey,
          mtimeMs: fence?.mtimeMs ?? entry.mtimeMs, entries: [{ name: entry.name, mtimeMs: entry.mtimeMs }] });
      }
      candidates = [...owners.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.conversationKey.localeCompare(b.conversationKey))
        .filter((entry) => !cursor || entry.mtimeMs > cursor.mtimeMs || (entry.mtimeMs === cursor.mtimeMs && entry.conversationKey > cursor.conversationKey));
    } finally { await releaseSnapshot(); }
    let settled = 0, busy = 0, unresolved = 0;
    let nextCursor: ConversationHistoryTurnDrainResult["cursor"];
    for (const candidate of candidates.slice(0, limit)) {
      nextCursor = { mtimeMs: candidate.mtimeMs, conversationKey: candidate.conversationKey };
      let held: HeldConversation | undefined;
      try {
        let payload: PendingTurnPayload | undefined, inspectionError: unknown;
        for (const entry of candidate.entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
          try { payload = (await this.pendingPayloads(rootIdentity).inspect(entry)).payload; break; }
          catch (error) {
            await assertDirectoryIdentity(this.root, rootIdentity);
            await assertDirectoryIdentity(join(this.root, LOCKS_DIRECTORY), locksIdentity);
            inspectionError = error;
          }
        }
        if (!payload) throw inspectionError ?? new Error("Pending owner has no attributable generation.");
        // Read-only discovery is not ownership. Try exact/logical rows without
        // waiting for a foreign owner, even if it appeared after our snapshot.
        held = await this.acquireConversation(normalizeConversationId(payload.identity.historyBucket), undefined, undefined, true);
        const releaseCheck = await this.acquireRootTransaction(rootIdentity);
        let fence;
        try { fence = await this.findDirtyFence(candidate.conversationKey, locksIdentity); }
        finally { await releaseCheck(); }
        if (fence === undefined) {
          const releaseCleanup = await this.acquireRootTransaction(rootIdentity);
          try { await this.removePendingConversation(candidate.conversationKey, rootIdentity, () => held!.assertOwned()); }
          finally { await releaseCleanup(); }
        } else if (fence.kind === "execution" || fence.kind === "compaction") {
          await this.settleHeldTurn(payload.identity.historyBucket, held);
        } else { unresolved += 1; continue; }
        settled += 1;
      } catch (error) {
        if (error instanceof HistoryOwnerBusyError || (isRecord(error) && error.code === "ERR_HARNESS_WRITER_BUSY")) busy += 1;
        else if (held === undefined && (error instanceof SyntaxError || error instanceof TypeError)) unresolved += 1; // Unattributable orphan: preserve and charge it.
        else if (isErrno(error, "ENOENT") && held === undefined) { await assertDirectoryIdentity(this.root, rootIdentity); busy += 1; }
        else {
          // A poisoned owner remains charged, but must not starve unrelated
          // drainable owners. Namespace identity failures are root-wide.
          await assertDirectoryIdentity(this.root, rootIdentity);
          await assertDirectoryIdentity(join(this.root, LOCKS_DIRECTORY), locksIdentity);
          unresolved += 1;
        }
      } finally { if (held) await this.releaseConversation(held, rootIdentity); }
    }
    return { settled, busy, unresolved, remaining: candidates.length > limit, ...(nextCursor === undefined ? {} : { cursor: nextCursor }) };
  }

  async recoverProviderSessionTurn(conversationId: string): Promise<ConversationHistoryTurnRecovery> {
    const normalizedId = normalizeConversationId(conversationId);
    const held = await this.acquireConversation(normalizedId);
    try { return await this.settleHeldTurn(normalizedId, held); }
    finally { await this.releaseConversation(held, held.rootIdentity); }
  }

  private async replacePendingPayload(fence: DirtyFence, payload: PendingTurnPayload, held: HeldConversation): Promise<DirtyFence> {
    const releaseRoot = await this.acquireRootTransaction(held.rootIdentity);
    try {
      await held.assertOwned();
      const current = await this.findDirtyFence(fence.conversationKey, await this.ensureLocksRoot());
      if (!current || serializeDirtyFence(current).compare(serializeDirtyFence(fence)) !== 0) throw new Error("Pending fence changed during owner-held publication.");
      const pointer = await this.pendingPayloads(held.rootIdentity).publish(payload, {
        assertOwned: () => held.assertOwned(), reserve: async (bytes) => await this.validateStagingReservation(held.rootIdentity, bytes),
      });
      const replacement = await this.publishDirtyFence({ ...fence, payload: pointer }, await this.ensureLocksRoot());
      // After durable pointer replacement, old generations are no longer needed.
      try {
        await this.pendingPayloads(held.rootIdentity).collectUnreferenced({ conversationKey: fence.conversationKey, runIdDigest: fence.runIdDigest }, [pointer], {
          assertOwned: () => held.assertOwned(), reserve: async () => { throw new Error("Collection cannot publish payloads."); },
        });
      } catch (error) { recordPostCommitMaintenanceFailure(this.root, error); }
      await held.assertOwned();
      return replacement;
    } finally { await releaseRoot(); }
  }

  private async readPendingTurn(fence: DirtyFence, held: HeldConversation): Promise<PendingTurnPayload> {
    if (!fence.payload || !fence.kind || fence.kind === "retirement") throw new Error("Fence is not an execution admission.");
    await held.assertOwned();
    const { payload } = await this.pendingPayloads(held.rootIdentity).inspect({
      name: pendingPayloadName(fence.conversationKey, fence.runIdDigest, fence.payload.generation),
    }, fence.payload.sha256);
    const wire = { version: 5, kind: fence.kind, conversationKey: fence.conversationKey,
      logicalConversationKey: fence.logicalConversationKey!, epoch: fence.epoch, providerSessionId: fence.providerSessionId!,
      modelKey: fence.modelKey!, revision: fence.revision, runIdDigest: fence.runIdDigest, payload: fence.payload } as const;
    if (historyKey(payload.identity.historyBucket) !== held.marker.conversationKey
      || payload.identity.handleId !== fence.providerSessionId || payload.identity.modelKey !== fence.modelKey
      || payload.identity.baseRevision !== fence.revision || digestRunId(payload.identity.turnId) !== fence.runIdDigest
      || payload.identity.purpose !== fence.kind || payload.identity.fenceDigest !== durableTurnFenceDigest(wire)) throw new Error("Pending turn/fence binding mismatch.");
    return payload;
  }

  private async preparePendingSettlement(fence: DirtyFence, payload: PendingTurnPayload, held: HeldConversation, liveMessages?: readonly HistoryMessage[]): Promise<{
    readonly record: CanonicalHistoryFile; readonly fence: DirtyFence; readonly payload: PendingTurnPayload; readonly cold: boolean;
  }> {
    if (!this.inspectProviderTurn) throw new Error("Pending native turn requires configured owner-held reconciliation.");
    await held.assertOwned();
    const existing = await this.readRecord(payload.identity.historyBucket, held.rootIdentity, true);
    if ((fence.revision > 0 && (existing.providerSession === undefined || existing.providerSession.epoch !== fence.epoch
      || existing.providerSession.revision !== fence.revision || existing.providerSession.modelKey !== fence.modelKey))
      || (existing.providerSession?.epoch === fence.epoch && existing.providerSession.revision !== fence.revision)) {
      throw new Error("Canonical base revision changed before native settlement.");
    }
    const canonicalVersion = historyRecordVersion(existing);
    // Native ownership/matching/repair/fsync happens OUTSIDE the root transaction.
    const evidence = await this.inspectProviderTurn({ descriptor: pendingTurnDescriptor(payload), purpose: payload.identity.purpose,
      modelKey: payload.identity.modelKey, expectedInputs: payload.inputs.map((input) => ({ id: input.id, requestDigest: input.requestDigest, placement: input.placement })) });
    await held.assertOwned();
    if (existing.sourceVersion === 4 && evidence.status === "matched" && evidence.journalId !== existing.native?.chain.at(-1)?.journalId) {
      throw new Error("Canonical v4 native settlement journal does not match the authoritative chain tip");
    }
    const current = await this.readRecord(payload.identity.historyBucket, held.rootIdentity, true);
    if (historyRecordVersion(current) !== canonicalVersion) throw new Error("Canonical history changed during native inspection.");
    let projection = projectTurnSettlement(payload, evidence, new Date(this.now()).toISOString());
    if (projection.outcome === "completed" && payload.identity.purpose === "execution" && liveMessages?.length) {
      const users = liveMessages.slice(0, -1), assistant = liveMessages.at(-1)!;
      const projectedUsers = projection.messages.filter((message) => message.role === "user");
      if (assistant.role !== "assistant" || assistant.timestamp === undefined || users.length !== projectedUsers.length
        || users.some((message, index) => message.role !== "user" || message.content !== projectedUsers[index]!.content
          || message.name !== projectedUsers[index]!.name || message.runId !== payload.identity.turnId
          || (index > 0 && message.timestamp !== projectedUsers[index]!.timestamp))
        || users[0]?.timestamp === undefined || assistant.runId !== payload.identity.turnId) {
        throw new Error("Host completion does not match admitted canonical inputs.");
      }
      payload = createPendingTurnPayload(payload.identity, payload.inputs, payload.disposition, {
        outcome: "completed", text: assistant.content, timestamp: assistant.timestamp, initialTimestamp: users[0].timestamp,
        error: null, failureKind: null, ...(payload.candidate?.silent === undefined ? {} : { silent: payload.candidate.silent }),
        ...(payload.candidate?.consumedInputIds === undefined ? {} : { consumedInputIds: payload.candidate.consumedInputIds }),
      });
      projection = projectTurnSettlement(payload, evidence, assistant.timestamp);
    }
    const cold = !projection.nativeReusable;
    if (cold) this.requireNativeCapability(existing, "native epoch transition", "cold native turn settlement");
    // Persist the resolved minimal candidate before canonical staging. A crash at
    // rename can then recognize the receipt without inspecting native state again.
    if (projection.candidate !== undefined) {
      payload = createPendingTurnPayload(payload.identity, payload.inputs, payload.disposition, projection.candidate);
      fence = await this.replacePendingPayload(fence, payload, held);
    }
    const lastCommit: DurableTurnReceipt = { version: 1, turnId: payload.identity.turnId, inputDigest: turnInputDigest(payload),
      candidateDigest: turnCandidateDigest(payload), journalId: projection.journalId, tipId: projection.tipId,
      baseRevision: fence.revision, committedRevision: fence.revision + 1, outcome: projection.outcome };
    return { fence, payload, cold, record: preserveV4(existing, { version: STORE_VERSION, conversationId: payload.identity.historyBucket,
      messages: retainHistoryMessages([...existing.messages, ...projection.messages], this.maxMessages), lastCommit,
      providerSession: { epoch: cold ? createProviderSessionEpoch() : fence.epoch,
        revision: cold ? 0 : fence.revision + 1, ...modelBinding(fence.modelKey) } }) };
  }

  private async settleHeldTurn(conversationId: string, held: HeldConversation): Promise<ConversationHistoryTurnRecovery> {
    await held.assertOwned();
    // Ready alone is not runtime switch authority. Once this exact accepted
    // reference has begun in the current native journal, however, ordinary
    // admission must finish storage roll-forward rather than strand C forever.
    if (this.nativeJournalStorage) {
      const pending = (await this.modelSwitchPayloads(held.rootIdentity).inventory()).pending
        .filter((entry) => entry.state.identity.historyBucket === conversationId);
      for (const { state } of pending) if (state.phase === "ready") {
        const marker = await this.nativeHistoryRoot(held.rootIdentity).read();
        if (!marker) continue; // Not native-ready; keep its switch fence, but allow authority/recovery.
        const authority = this.nativeHistoryRoot(held.rootIdentity).authority(marker, state.identity.ownerKey, conversationId);
        if (await this.nativeJournalStorage.hasSwitchReference(state.identity.sources, this.nativeSwitchContext(state, authority, () => held.assertOwned()))) {
          await this.rollForwardHeldModelSwitch(conversationId, state.identity.switchId, held);
        }
      }
    }
    const locksIdentity = await this.ensureLocksRoot();
    let fence: DirtyFence | undefined;
    const releaseSnapshot = await this.acquireRootTransaction(held.rootIdentity);
    try { fence = await this.findDirtyFence(historyKey(conversationId), locksIdentity); }
    finally { await releaseSnapshot(); }
    if (fence?.kind !== "execution" && fence?.kind !== "compaction") {
      if (fence === undefined && this.inspectProviderTurn !== undefined) {
        const releaseCleanup = await this.acquireRootTransaction(held.rootIdentity);
        try { await this.removePendingConversation(historyKey(conversationId), held.rootIdentity, () => held.assertOwned()); }
        finally { await releaseCleanup(); }
      }
      return { status: "clean" };
    }
    if (!this.inspectProviderTurn) throw new Error("Pending native turn requires owner-held reconciliation before mutation.");
    const payload = await this.readPendingTurn(fence, held);
    if (payload.identity.historyBucket !== conversationId) throw new Error("Pending history bucket mismatch.");
    const existing = await this.readRecord(conversationId, held.rootIdentity, true);
    if (recognizesTurnCommit(existing, conversationId, payload.identity.turnId, turnInputDigest(payload), turnCandidateDigest(payload))) {
      if (existing.providerSession?.epoch !== fence.epoch) this.requireNativeCapability(existing, "native epoch transition", "cold receipt cleanup");
      const releaseRoot = await this.acquireRootTransaction(held.rootIdentity);
      try {
        await held.assertOwned();
        await fsyncDirectory(this.root, held.rootIdentity);
      } finally { await releaseRoot(); }
      if (existing.sourceVersion !== 4 && existing.providerSession?.epoch !== fence.epoch) await this.retireProviderSessions([{ providerSessionId: fence.providerSessionId!, ...modelBinding(fence.modelKey) }]);
      const releaseCleanup = await this.acquireRootTransaction(held.rootIdentity);
      try {
        await held.assertOwned();
        if (historyRecordVersion(await this.readRecord(conversationId, held.rootIdentity, true)) !== historyRecordVersion(existing)) throw new Error("Canonical receipt changed during native retirement.");
        await this.removeDirtyFenceAfterCommit(fence);
        await this.removePendingConversation(fence.conversationKey, held.rootIdentity, () => held.assertOwned());
      } finally { await releaseCleanup(); }
      return { status: existing.lastCommit!.outcome === "interrupted" ? "interrupted" : "recovered", turnId: payload.identity.turnId, outcome: existing.lastCommit!.outcome,
        ...(existing.providerSession?.epoch === fence.epoch ? { providerSessionId: fence.providerSessionId!, providerSessionRevision: existing.providerSession.revision! } : {}) };
    }
    const settlement = await this.preparePendingSettlement(fence, payload, held);
    const prepared = await this.prepareRecord(settlement.record, held, held.rootIdentity, undefined, settlement.fence,
      settlement.cold && existing.sourceVersion !== 4 ? async () => await this.retireProviderSessions([{ providerSessionId: settlement.fence.providerSessionId!, ...modelBinding(settlement.fence.modelKey) }]) : undefined,
      true, async () => await this.removePendingConversation(settlement.fence.conversationKey, held.rootIdentity, () => held.assertOwned()));
    try { await prepared.commit(); }
    catch (error) { await prepared.abort().catch(() => undefined); throw error; }
    // A post-rename durability/cleanup failure is committed, but no new native
    // dispatch may enter until the persisted receipt has completed settlement.
    const releaseCheck = await this.acquireRootTransaction(held.rootIdentity);
    try {
      if (await this.findDirtyFence(fence.conversationKey, locksIdentity)) throw new Error("Turn committed but durability settlement is pending; wait or reset.");
    } finally { await releaseCheck(); }
    return { status: settlement.record.lastCommit!.outcome === "interrupted" ? "interrupted" : "recovered",
      turnId: payload.identity.turnId, outcome: settlement.record.lastCommit!.outcome,
      ...(settlement.cold ? {} : { providerSessionId: settlement.fence.providerSessionId!, providerSessionRevision: settlement.record.providerSession.revision }) };
  }

  async stats(): Promise<DurableHistoryStoreStats> {
    const rootIdentity = await this.ensureRoot();
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    try {
      const entries = await this.scanCommittedEntries(rootIdentity, false);
      const active = await this.scanActiveMarkers(true);
      const maintenance = PROCESS_POST_COMMIT_FAILURES.get(this.root);
      const switches = await this.modelSwitchFootprint(rootIdentity);
      const operations = await this.nativeOperationFootprint(rootIdentity);
      return {
        conversations: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.size, 0) + switches.bytes + switches.nativeBytes + operations.bytes + await this.nativeHistoryRoot(rootIdentity).bytes(),
        reservedBytes: switches.pending.reduce((sum, entry) => sum + entry.remainingReservation, 0) + operations.reserved,
        activePreparedAppends: active.length,
        postCommitMaintenanceFailures: maintenance?.count ?? 0,
        ...(maintenance?.lastError === undefined
          ? {}
          : { lastPostCommitMaintenanceError: maintenance.lastError }),
        limits: {
          maxMessages: this.maxMessages,
          maxStoreBytes: this.maxStoreBytes,
          maxStagedBytes: this.maxStagedBytes,
          maxConversations: this.maxConversations,
          maxAgeMs: this.maxAgeMs,
        },
      };
    } finally {
      await releaseRoot();
    }
  }

  private async prepareRecord(
    record: CanonicalHistoryFile,
    held: HeldConversation,
    rootIdentity: DirectoryIdentity,
    onSettled?: () => void,
    dirtyFence?: DirtyFence,
    afterDurableCommit?: () => Promise<void>,
    keepOwner = false,
    afterFenceCleanup?: () => Promise<void>,
  ): Promise<PreparedHistoryAppend> {
    let releaseRoot = await this.acquireRootTransaction(rootIdentity);
    const nativeIo = this.nativeIoOutsideRoot(rootIdentity, () => releaseRoot(), (release) => { releaseRoot = release; });
    let stage: ActiveStage | undefined;
    try {
      await this.resumeInactiveNativeDeletions(rootIdentity, nativeIo, held.logical, "prepare");
      await this.requireNoModelSwitch(record.conversationId, rootIdentity);
      const existing = await this.readRecord(record.conversationId, rootIdentity);
      if (existing.sourceVersion === 4 && existing.providerSession?.epoch !== record.providerSession.epoch) {
        this.requireNativeCapability(existing, "native epoch transition", "cold publication");
        const source = this.nativeCanonical(existing), next = this.coldRecord(source, record);
        const projected = this.projectRecord(next); await this.validateStagingReservation(rootIdentity, projected.bytes);
        stage = await this.writeStage(next, rootIdentity); await this.validateRetentionReservation(rootIdentity, [stage]);
        return this.createNativePreparedAppend(stage, { version: 1, disposition: "C", source, next, timestamp: 0 }, held, keepOwner, onSettled);
      }
      record = preserveV4(existing, record);
      const projected = this.projectRecord(record);
      await this.validateStagingReservation(rootIdentity, projected.bytes);
      // Write while the root transaction is held so another process cannot
      // pass the same staged-byte reservation before this temp becomes visible.
      stage = await this.writeStage(record, rootIdentity);
      await this.validateRetentionReservation(rootIdentity, [stage]);
      return this.createPreparedAppend(stage, rootIdentity, held, onSettled, dirtyFence, afterDurableCommit, keepOwner, afterFenceCleanup);
    } catch (error) {
      if (stage !== undefined) {
        await rm(stage.temporaryPath, { force: true }).catch(() => undefined);
        await fsyncDirectory(this.root, rootIdentity).catch(() => undefined);
      }
      throw error;
    } finally {
      await releaseRoot();
    }
  }

  private async reserveNativeCold(operation: NativeHistoryOperation, rootIdentity: DirectoryIdentity): Promise<void> {
    const existing = await this.readNativeOperation(operation.source.conversationId, rootIdentity);
    if (existing) { if (switchDigest(existing) !== switchDigest(operation)) throw new Error("Conflicting native cold reservation"); return; }
    const next = operation.next!, plan = this.nativeJournalStorage!.planColdEpoch(operation.source.native.chain,
      this.coldContext(operation.source, next, async () => {}, operation.coldSwitch));
    const bytes = Buffer.byteLength(JSON.stringify(operation) + "\n"), projected = this.projectRecord(next);
    const retention = await this.retentionPlan(rootIdentity, operation.coldSwitch ? [] : [projected]);
    // Exceptional model changes must fit the actual publication peak: neither
    // replacing the old canonical nor hypothetical retention victims are credits
    // before the intent, target header and new canonical stage are durable.
    const canonicalStage = operation.coldSwitch ? projected.bytes : 0;
    const charged = operation.coldSwitch ? retention.projectedBytes + canonicalStage : retention.minimumBytes;
    const count = operation.coldSwitch ? retention.projectedCount : retention.minimumCount;
    if (charged + bytes + plan.bytes > this.maxStoreBytes || count > this.maxConversations) throw new (operation.coldSwitch ? ModelSwitchCapacityError : Error)("Native cold history capacity unavailable");
    if (await this.scanStagedBytes(rootIdentity) + bytes + plan.bytes + canonicalStage > this.maxStagedBytes) throw new (operation.coldSwitch ? ModelSwitchCapacityError : Error)("Native cold staging capacity unavailable");
  }
  private createNativePreparedAppend(stage: ActiveStage, operation: NativeHistoryOperation, held: HeldConversation, keepOwner: boolean, onSettled?: () => void): PreparedHistoryAppend {
    let state: "prepared" | "committed" | "aborted" = "prepared", pending = Promise.resolve();
    const serialize = (action: () => Promise<void>) => { const current = pending.then(action, action); pending = current.catch(() => {}); return current; };
    const release = async () => { if (!keepOwner) { await this.removeActiveMarker(held.marker); await held.release(); onSettled?.(); } };
    return {
      commit: async () => await serialize(async () => {
        if (state === "committed") return; if (state === "aborted") throw new Error("Cannot commit an aborted history append.");
        let unlock = await this.acquireRootTransaction(held.rootIdentity);
        const nativeIo = this.nativeIoOutsideRoot(held.rootIdentity, () => unlock(), (release) => { unlock = release; });
        try {
          await held.assertOwned(); await this.reserveNativeCold(operation, held.rootIdentity);
          await this.publishNativeOperation(operation, held.rootIdentity);
          try { await this.finishNativeOperation(operation, held.rootIdentity, () => held.assertOwned(), nativeIo); }
          catch (error) {
            const latest = await this.readRecord(operation.source.conversationId, held.rootIdentity, true);
            if (latest.sourceVersion !== 4 || switchDigest(this.nativeCanonical(latest)) !== switchDigest(operation.next)) throw error;
            // Canonical rename is the semantic commit; unresolved physical cleanup
            // stays fenced by the durable lifecycle intent and is diagnostic.
            recordPostCommitMaintenanceFailure(this.root, error);
          }
          state = "committed"; await rm(stage.temporaryPath, { force: true }); await fsyncDirectory(this.root, held.rootIdentity);
          try { await this.applyRetention(held.rootIdentity, this.projectRecord(operation.next!), nativeIo, held.logical); }
          catch (error) { recordPostCommitMaintenanceFailure(this.root, error); }
          await release();
        } finally { await unlock(); }
      }),
      abort: async () => await serialize(async () => {
        if (state !== "prepared") return; state = "aborted";
        const unlock = await this.acquireRootTransaction(held.rootIdentity);
        try { await rm(stage.temporaryPath, { force: true }); await fsyncDirectory(this.root, held.rootIdentity); await this.removeActiveMarker(held.marker); }
        finally { await unlock(); await held.release(); onSettled?.(); }
      }),
    };
  }

  private projectRecord(record: CanonicalHistoryFile): ActiveStage {
    const conversationKey = historyKey(record.conversationId);
    return {
      conversationKey,
      logicalConversationKey: historyKey(logicalConversationIdForFence(record.conversationId)),
      destinationName: `${conversationKey}${HISTORY_FILE_SUFFIX}`,
      temporaryPath: "",
      bytes: serializeHistoryFile(record).byteLength,
    };
  }

  private async findDirtyFence(
    conversationKey: string,
    locksIdentity: DirectoryIdentity,
  ): Promise<DirtyFence | undefined> {
    return (await this.scanDirtyFences(locksIdentity, true))
      .find((fence) => fence.conversationKey === conversationKey);
  }

  private async reserveDirtyFenceCapacity(
    conversationKey: string,
    rootIdentity: DirectoryIdentity,
    locksIdentity: DirectoryIdentity,
  ): Promise<void> {
    let fences = await this.scanDirtyFences(locksIdentity, true);
    const pendingKeys = new Set((await this.pendingPayloads(rootIdentity).list()).map((entry) => entry.conversationKey));
    const targetCount = new Set([...fences.map((fence) => fence.conversationKey), ...pendingKeys, conversationKey]).size;
    if (targetCount <= this.maxConversations) return;

    const committedKeys = new Set(
      (await this.scanCommittedEntries(rootIdentity, true))
        .map((entry) => entry.name.slice(0, -HISTORY_FILE_SUFFIX.length)),
    );
    const activeKeys = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    for (const key of (await this.nativeOperationFootprint(rootIdentity)).keys) committedKeys.add(key);
    const reclaimable = fences
      .filter((fence) => (
        fence.conversationKey !== conversationKey
        && fence.kind !== "execution" && fence.kind !== "compaction"
        && !committedKeys.has(fence.conversationKey)
        && !activeKeys.has(fence.conversationKey)
      ))
      .sort((left, right) => (left.mtimeMs ?? 0) - (right.mtimeMs ?? 0)
        || left.conversationKey.localeCompare(right.conversationKey));
    let remaining = targetCount;
    let removed = false;
    for (const fence of reclaimable) {
      if (remaining <= this.maxConversations) break;
      if (this.retireProviderSession !== undefined) {
        // V2 fences carry the exact provider id. A legacy fence without one is
        // not reclaimable safely because its conversation id is intentionally
        // one-way hashed in the filename.
        if (fence.providerSessionId === undefined) continue;
        await this.retireProviderSessions([{ providerSessionId: fence.providerSessionId, ...modelBinding(fence.modelKey) }]);
      }
      await rm(fence.path);
      removed = true;
      if (!pendingKeys.has(fence.conversationKey)) remaining -= 1;
    }
    if (removed) await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
    if (remaining > this.maxConversations) {
      throw new Error(`Provider-session dirty fences exceed the ${this.maxConversations}-conversation quota.`);
    }
    fences = await this.scanDirtyFences(locksIdentity, false);
    if (new Set([...fences.map((fence) => fence.conversationKey), ...pendingKeys, conversationKey]).size
      > this.maxConversations) {
      throw new Error(`Provider-session dirty fences exceed the ${this.maxConversations}-conversation quota.`);
    }
  }

  private async publishDirtyFence(
    value: Omit<DirtyFence, "path" | "mtimeMs">,
    locksIdentity: DirectoryIdentity,
  ): Promise<DirtyFence> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    const destination = join(locksRoot, `${value.conversationKey}.dirty.json`);
    const temporary = join(
      locksRoot,
      `.${value.conversationKey}.${process.pid}.${randomBytes(12).toString("hex")}.dirty.tmp`,
    );
    const bytes = serializeDirtyFence(value);
    let published = false;
    try {
      await writePreparedFile(temporary, bytes, locksRoot, locksIdentity);
      await rename(temporary, destination);
      published = true;
      await fsyncDirectory(locksRoot, locksIdentity);
      const info = await lstat(destination);
      assertSecureHistoryFile(info, destination);
      if (info.size !== bytes.byteLength) {
        throw new Error(`History dirty fence ${destination} was not written completely.`);
      }
      return { ...value, path: destination, mtimeMs: info.mtimeMs };
    } finally {
      if (!published) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async writeStage(record: CanonicalHistoryFile, rootIdentity: DirectoryIdentity): Promise<ActiveStage> {
    const conversationKey = historyKey(record.conversationId);
    const bytes = serializeHistoryFile(record);
    const temporaryPath = join(
      this.root,
      `.${conversationKey}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      await writePreparedFile(temporaryPath, bytes, this.root, rootIdentity);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      conversationKey,
      logicalConversationKey: historyKey(logicalConversationIdForFence(record.conversationId)),
      destinationName: `${conversationKey}${HISTORY_FILE_SUFFIX}`,
      temporaryPath,
      bytes: bytes.byteLength,
    };
  }

  private createPreparedAppend(
    stage: ActiveStage,
    rootIdentity: DirectoryIdentity,
    held: HeldConversation,
    onSettled?: () => void,
    dirtyFence?: DirtyFence,
    afterDurableCommit?: () => Promise<void>,
    keepOwner = false,
    afterFenceCleanup?: () => Promise<void>,
  ): PreparedHistoryAppend {
    let state: "prepared" | "committed" | "aborted" = "prepared";
    let operation = Promise.resolve();
    const serialize = (action: () => Promise<void>): Promise<void> => {
      const current = operation.then(action, action);
      operation = current.catch(() => undefined);
      return current;
    };

    return {
      commit: async (): Promise<void> => await serialize(async () => {
        if (state === "committed") return;
        if (state === "aborted") throw new Error("Cannot commit an aborted history append.");
        let published = false;
        let releaseRoot = await this.acquireRootTransaction(rootIdentity);
        try {
          await assertDirectoryIdentity(this.root, rootIdentity);
          // Revalidate while holding the root transaction queue. Preparation
          // never evicts committed history, and another conversation may have
          // committed since this stage reserved its projected capacity.
          await this.validateRetentionReservation(rootIdentity, [stage]);
          await rename(stage.temporaryPath, join(this.root, stage.destinationName));
          this.invalidateCanonicalAccounting(stage.destinationName);
          published = true;
          state = "committed";

          // Rename is the semantic commit. Directory durability and defensive
          // verification happen afterwards, so their failure is observable in
          // stats but can never make callers retry an already-published turn.
          try {
            await fsyncDirectory(this.root, rootIdentity);
            // The canonical replacement is clean and directory-durable before
            // the crash fence is removed. If cleanup cannot be made durable,
            // restore the visible fence and record a diagnostic so the next
            // turn rotates instead of trusting ambiguous provider state.
            if (afterDurableCommit && (dirtyFence?.kind === "execution" || dirtyFence?.kind === "compaction")) {
              const beforeRetirement = await lstat(join(this.root, stage.destinationName));
              await releaseRoot(); releaseRoot = async () => {};
              try { await afterDurableCommit(); }
              finally { releaseRoot = await this.acquireRootTransaction(rootIdentity); }
              await held.assertOwned();
              const afterRetirement = await lstat(join(this.root, stage.destinationName));
              assertSecureHistoryFile(afterRetirement, join(this.root, stage.destinationName));
              if (beforeRetirement.dev !== afterRetirement.dev || beforeRetirement.ino !== afterRetirement.ino
                || beforeRetirement.size !== afterRetirement.size || beforeRetirement.mtimeMs !== afterRetirement.mtimeMs
                || beforeRetirement.ctimeMs !== afterRetirement.ctimeMs) throw new Error("Canonical publication changed during native retirement.");
            } else await afterDurableCommit?.();
            if (dirtyFence !== undefined) {
              await this.removeDirtyFenceAfterCommit(dirtyFence);
              if (dirtyFence.kind === "retirement") await this.removePendingConversation(dirtyFence.conversationKey, rootIdentity, () => held.assertOwned());
            }
            await afterFenceCleanup?.();
            const committed = await lstat(join(this.root, stage.destinationName));
            assertSecureHistoryFile(committed, join(this.root, stage.destinationName));
            // Only prune older committed records after the replacement itself
            // has been durably published. Retention is maintenance, never part
            // of the caller-visible success boundary.
            await this.applyRetention(rootIdentity, stage, this.nativeIoOutsideRoot(rootIdentity, () => releaseRoot(), (release) => { releaseRoot = release; }), held.logical);
            await assertDirectoryIdentity(this.root, rootIdentity);
          } catch (error) {
            recordPostCommitMaintenanceFailure(this.root, error);
          }
        } catch (error) {
          if (!published) throw error;
          recordPostCommitMaintenanceFailure(this.root, error);
        } finally {
          if (published && !keepOwner) {
            await this.removeActiveMarker(held.marker).catch((error) => {
              recordPostCommitMaintenanceFailure(this.root, error);
            });
          }
          await releaseRoot();
          if (published && !keepOwner) {
            await held.release();
            onSettled?.();
          }
        }
      }),
      abort: async (): Promise<void> => await serialize(async () => {
        if (state === "committed" || state === "aborted") return;
        const releaseRoot = await this.acquireRootTransaction(rootIdentity);
        state = "aborted";
        const cleanupErrors: unknown[] = [];
        try {
          try {
            await rm(stage.temporaryPath, { force: true });
            await fsyncDirectory(this.root, rootIdentity);
          } catch (error) {
            cleanupErrors.push(error);
          }
          // Marker removal is independent from stage removal. In particular,
          // a transient stage-unlink failure must not leave a live-PID marker
          // consuming retention and staging capacity until daemon restart.
          try {
            await this.removeActiveMarker(held.marker);
          } catch (error) {
            cleanupErrors.push(error);
          }
        } finally {
          try {
            await releaseRoot();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            await held.release();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            onSettled?.();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, "Prepared history abort cleanup failed.");
        }
      }),
    };
  }

  private async removeDirtyFenceAfterCommit(fence: DirtyFence): Promise<void> {
    const locksIdentity = await this.ensureLocksRoot();
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    try {
      const current = await readDirtyFence(fence.path);
      if (
        current.kind !== fence.kind
        || current.payload?.generation !== fence.payload?.generation || current.payload?.sha256 !== fence.payload?.sha256
        || current.conversationKey !== fence.conversationKey
        || current.logicalConversationKey !== fence.logicalConversationKey
        || current.modelKey !== fence.modelKey
        || current.epoch !== fence.epoch
        || current.providerSessionId !== fence.providerSessionId
        || current.revision !== fence.revision
        || current.runIdDigest !== fence.runIdDigest
      ) {
        throw new Error(`History dirty fence ${fence.path} changed before clean commit.`);
      }
      await rm(fence.path);
      await fsyncDirectory(locksRoot, locksIdentity);
    } catch (error) {
      // A failed unlink leaves the original fence. If unlink succeeded but its
      // directory fsync failed, atomically restore an equivalent visible fence
      // before returning committed success. A restoration failure is folded
      // into the diagnostic; the canonical record itself remains committed.
      try {
        await lstat(fence.path);
      } catch (statError) {
        if (isErrno(statError, "ENOENT")) {
          await this.publishDirtyFence({
            ...(fence.kind === undefined ? {} : { kind: fence.kind }),
            ...(fence.payload === undefined ? {} : { payload: fence.payload }),
            conversationKey: fence.conversationKey,
            ...(fence.logicalConversationKey === undefined
              ? {}
              : { logicalConversationKey: fence.logicalConversationKey }),
            epoch: fence.epoch,
            ...modelBinding(fence.modelKey),
            ...(fence.providerSessionId === undefined ? {} : { providerSessionId: fence.providerSessionId }),
            revision: fence.revision,
            runIdDigest: fence.runIdDigest,
          }, locksIdentity);
        } else {
          throw new AggregateError([error, statError], "Dirty-fence cleanup failed closed.");
        }
      }
      throw error;
    }
  }

  private async validateRetentionReservation(
    rootIdentity: DirectoryIdentity,
    projectedStages: readonly ActiveStage[],
  ): Promise<void> {
    const plan = await this.retentionPlan(rootIdentity, projectedStages);
    if (plan.minimumCount > this.maxConversations) {
      throw new Error(`Conversation history exceeds its ${this.maxConversations}-conversation quota.`);
    }
    if (plan.minimumBytes > this.maxStoreBytes) {
      throw new Error(`Conversation history exceeds its ${this.maxStoreBytes}-byte aggregate quota.`);
    }
  }

  private async validateStagingReservation(
    rootIdentity: DirectoryIdentity,
    plannedBytes: number,
  ): Promise<void> {
    const stagedBytes = await this.scanStagedBytes(rootIdentity);
    if (stagedBytes + plannedBytes > this.maxStagedBytes) {
      throw new Error(`Prepared conversation history exceeds its ${this.maxStagedBytes}-byte staging quota.`);
    }
  }

  private async applyRetention(rootIdentity: DirectoryIdentity, committedStage: ActiveStage, nativeIo: NativeHistoryIo, committingOwner: HeldLogicalConversation): Promise<void> {
    await this.resumeInactiveNativeDeletions(rootIdentity, nativeIo, committingOwner, "maintenance");
    const attempted = new Set<string>();
    const maxPlans = (await this.scanCommittedEntries(rootIdentity, false)).length + 1;
    for (let iteration = 0; iteration < maxPlans; iteration++) {
      const plan = await this.retentionPlan(rootIdentity, [committedStage], attempted);
      if (plan.minimumCount > this.maxConversations || plan.minimumBytes > this.maxStoreBytes) throw new Error("Conversation history retention reservation changed after publication.");
      let bytes = plan.projectedBytes, count = plan.projectedCount, replan = false;
      // Preserve global LRU order. After any unlocked native window, rebuild
      // all coordinates, protections and estimates before considering a victim.
      for (const entry of plan.candidates) {
        if (this.now() - entry.mtimeMs <= this.maxAgeMs && count <= this.maxConversations && bytes <= this.maxStoreBytes) continue;
        const record = plan.records.get(entry.name); if (!record) continue;
        if (record.sourceVersion === 4) {
          if (attempted.has(entry.name)) continue; attempted.add(entry.name);
          let owner: HeldLogicalConversation | undefined, exact: HeldExactConversationClaim | undefined, published = false;
          try {
            owner = logicalConversationIdForFence(record.conversationId) === committingOwner.logicalConversationId
              ? committingOwner : await this.acquireLogicalConversation(logicalConversationIdForFence(record.conversationId), true);
            if (requiresExactConversationClaim(record.conversationId)) exact = await this.acquireExactConversationClaim(record.conversationId, true);
            const operation: NativeHistoryOperation = { version: 1, disposition: "D", source: this.nativeCanonical(record), next: null, timestamp: 0 };
            const assertOwned = async () => { await owner!.assertOwned(); if ((await this.scanActiveMarkers(false)).some((marker) => marker.conversationKey === historyKey(record.conversationId))) throw new Error("Retention victim acquired ownership"); };
            await assertOwned(); await this.publishNativeOperation(operation, rootIdentity); published = true;
            await this.finishNativeOperation(operation, rootIdentity, assertOwned, nativeIo);
            replan = true;
          } catch (error) {
            if (!nativeIo.isRootHeld()) throw error;
            if (!(error instanceof HistoryOwnerBusyError)) {
              if (!published) throw error;
              // Keep the published D intent charged/protective for later resume,
              // but do not let this failed victim hide another free LRU victim.
              recordPostCommitMaintenanceFailure(this.root, error);
            }
            replan = true;
          }
          finally { await exact?.release(); if (owner !== committingOwner) await owner?.release(); }
          if (replan) break;
          continue;
        }
        const retirementFence = this.retireProviderSession === undefined ? undefined
          : await this.ensureRetirementFence(record, rootIdentity, await this.ensureLocksRoot());
        await this.retireProviderSessions(this.providerSessionsForRetirement(record, retirementFence));
        await rm(entry.path); this.invalidateCanonicalAccounting(entry.name); await fsyncDirectory(this.root, rootIdentity);
        if (retirementFence) await this.removeDirtyFenceAfterCommit(retirementFence);
        const key = historyKey(record.conversationId);
        await this.removePendingConversation(key, rootIdentity, async () => {
          await assertDirectoryIdentity(this.root, rootIdentity);
          if ((await this.scanActiveMarkers(false)).some((marker) => marker.conversationKey === key)
            || await this.findDirtyFence(key, await this.ensureLocksRoot())) throw new Error("Retention victim acquired pending ownership.");
        });
        count--; bytes -= entry.size;
      }
      if (replan) continue;
      if (count > this.maxConversations || bytes > this.maxStoreBytes) throw new Error("Retention victims became unavailable; quota maintenance remains pending.");
      await assertDirectoryIdentity(this.root, rootIdentity); return;
    }
    throw new Error("Retention replanning bound reached; quota maintenance remains pending.");
  }

  private async retentionPlan(
    rootIdentity: DirectoryIdentity,
    projectedStages: readonly ActiveStage[],
    excludedNames: ReadonlySet<string> = new Set(),
  ): Promise<{
    readonly projectedBytes: number;
    readonly projectedCount: number;
    readonly minimumBytes: number;
    readonly minimumCount: number;
    readonly candidates: readonly CommittedEntry[];
    readonly records: ReadonlyMap<string, LoadedHistoryRecord | undefined>;
  }> {
    const entries = await this.scanCommittedEntries(rootIdentity, true);
    const protectedNames = new Set(
      (await this.scanActiveMarkers(true)).map((marker) => `${marker.conversationKey}${HISTORY_FILE_SUFFIX}`),
    );
    // Pending execution/compaction owners cannot be quota/age-evicted before
    // explicit settlement. No native inspection occurs under this transaction.
    for (const fence of await this.scanDirtyFences(await this.ensureLocksRoot(), false)) {
      if (fence.kind === "execution" || fence.kind === "compaction") protectedNames.add(`${fence.conversationKey}${HISTORY_FILE_SUFFIX}`);
    }
    const managedRoot = await this.nativeHistoryRoot(rootIdentity).read() !== undefined;
    let records = new Map<string, LoadedHistoryRecord | undefined>();
    const wantsPruning = entries.length + projectedStages.filter((stage) => !entries.some((entry) => entry.name === stage.destinationName)).length > this.maxConversations
      || entries.reduce((sum, entry) => sum + entry.size, 0) + projectedStages.reduce((sum, stage) => sum + stage.bytes, 0) > this.maxStoreBytes
      || entries.some((entry) => this.now() - entry.mtimeMs > this.maxAgeMs);
    if (managedRoot || wantsPruning) records = await this.accountingRecords(rootIdentity, entries);
    for (const [name, record] of records) if (!record) protectedNames.add(name);
    const native = this.nativeJournalStorage ? await this.managedNativeInventory(rootIdentity, records) : undefined;
    const switches = await this.modelSwitchFootprint(rootIdentity, records, native);
    for (const entry of switches.pending) protectedNames.add(`${historyKey(entry.state.identity.historyBucket)}${HISTORY_FILE_SUFFIX}`);
    const operations = await this.nativeOperationFootprint(rootIdentity, native);
    for (const key of operations.keys) protectedNames.add(`${key}${HISTORY_FILE_SUFFIX}`);
    for (const [name, record] of records) if (record?.sourceVersion === 4 && !this.nativeJournalStorage) protectedNames.add(name);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    let projectedBytes = entries.reduce((sum, entry) => sum + entry.size, 0) + switches.bytes + switches.nativeBytes + operations.bytes + operations.reserved + await this.nativeHistoryRoot(rootIdentity).bytes()
      + switches.pending.reduce((sum, entry) => sum + entry.remainingReservation, 0);
    let projectedCount = entries.length;
    for (const active of projectedStages) {
      const replaced = byName.get(active.destinationName);
      if (replaced === undefined) projectedCount += 1;
      else projectedBytes -= replaced.size;
      projectedBytes += active.bytes;
    }

    if (!managedRoot && records.size === 0 && (projectedCount > this.maxConversations || projectedBytes > this.maxStoreBytes)) {
      records = await this.accountingRecords(rootIdentity, entries);
      for (const [name, record] of records) if (!record) protectedNames.add(name);
    }
    const candidates: CommittedEntry[] = [];
    let removableBytes = 0;
    const needsPruning = projectedCount > this.maxConversations || projectedBytes > this.maxStoreBytes
      || entries.some((entry) => this.now() - entry.mtimeMs > this.maxAgeMs);
    if (needsPruning) for (const entry of entries.filter((item) => !protectedNames.has(item.name) && !excludedNames.has(item.name)).sort(compareRetentionEntries)) {
      // Do not touch exact-claim SQLite transactions until this LRU victim is
      // actually needed. Stop as soon as both quota excess and age are covered.
      if (projectedCount - candidates.length <= this.maxConversations && projectedBytes - removableBytes <= this.maxStoreBytes
        && this.now() - entry.mtimeMs <= this.maxAgeMs) break;
      const record = records.get(entry.name);
      if (record?.sourceVersion === 4 && requiresExactConversationClaim(record.conversationId)) {
        let exact: HeldExactConversationClaim | undefined;
        try { exact = await this.acquireExactConversationClaim(record.conversationId, true); }
        catch (error) { if (!(error instanceof HistoryOwnerBusyError)) throw error; continue; }
        finally { await exact?.release(); }
      }
      if (record?.sourceVersion === 4 && (record.native!.chain.some((row) => (native?.journals[row.journalId]?.stagedBytes ?? 0) > 0)
        || await this.nativeJournalStorage!.deletionBlocked(record.native!.chain, record.native!.authority))) continue;
      const extra = record?.sourceVersion === 4 ? record.native!.chain.reduce((sum, row) => sum
        + (native?.journals[row.journalId]?.retainedBytes ?? 0) + (native?.journals[row.journalId]?.headerCopyBytes ?? 0), 0)
        + await this.modelSwitchPayloads(rootIdentity).conversationBytes(record.conversationId) : 0;
      candidates.push({ ...entry, size: entry.size + extra }); removableBytes += entry.size + extra;
    }
    const minimumBytes = projectedBytes - candidates.reduce((sum, entry) => sum + entry.size, 0);
    const minimumCount = projectedCount - candidates.length;
    // Establish feasibility before deleting anything. An append that cannot fit
    // even after every eligible record is removed must not destroy older
    // history merely to discover that fact.
    return { projectedBytes, projectedCount, minimumBytes, minimumCount, candidates, records };
  }

  private async scanStagedBytes(rootIdentity: DirectoryIdentity): Promise<number> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const activeConversationKeys = new Set(
      (await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey),
    );
    // Published pending inputs remain charged after a crash/marker removal.
    // They are not abandoned canonical staging and require owner-held recovery.
    const switches = await this.modelSwitchFootprint(rootIdentity);
    const operations = await this.nativeOperationFootprint(rootIdentity);
    let bytes = operations.bytes + operations.reserved + (await this.pendingPayloads(rootIdentity).list()).reduce((total, entry) => total + entry.bytes, 0) + switches.bytes + switches.nativeStagedBytes + await this.nativeHistoryRoot(rootIdentity).bytes()
      + switches.pending.reduce((sum, entry) => sum + entry.remainingReservation, 0);
    let removed = false;
    for (const name of (await readdir(this.root)).sort()) {
      const match = TEMP_FILE_PATTERN.exec(name);
      if (match === null) continue;
      const path = join(this.root, name);
      const info = await lstat(path);
      assertSecureHistoryFile(info, path);
      if (info.size > MAX_STORE_FILE_BYTES) {
        throw new Error(`History temporary ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
      }
      // Every legitimate stage is created only after its active marker and
      // both are mutated under the root transaction. A stage without a marker
      // is therefore abandoned even when its filename PID is still live or
      // has been reused by a later process.
      if (!activeConversationKeys.has(match[1] as string)) {
        await rm(path);
        removed = true;
        continue;
      }
      bytes += info.size;
    }
    if (removed) await fsyncDirectory(this.root, rootIdentity);
    await assertDirectoryIdentity(this.root, rootIdentity);
    return bytes;
  }

  private async scanCommittedEntries(
    rootIdentity: DirectoryIdentity,
    cleanStaleTemps: boolean,
  ): Promise<CommittedEntry[]> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const names = (await readdir(this.root)).sort();
    const activeConversationKeys = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    const entries: CommittedEntry[] = [];
    let removedTemp = false;
    for (const name of names) {
      const path = join(this.root, name);
      if (name === LOCKS_DIRECTORY) {
        const info = await lstat(path);
        assertSecureHistoryDirectory(info, path);
        continue;
      }
      if (NATIVE_OPERATION_PATTERN.test(name)) {
        const info = await lstat(path); assertSecureHistoryFile(info, path);
        if (info.size > MAX_NATIVE_OPERATION_BYTES) throw new Error("Native lifecycle intent exceeds its limit");
        continue;
      }
      if (name === NATIVE_HISTORY_ROOT_FILE || NATIVE_HISTORY_ROOT_TEMP.test(name)) {
        const stat = await lstat(join(this.root, name)); assertSecureHistoryFile(stat, join(this.root, name));
        if (stat.size > MAX_NATIVE_HISTORY_ROOT_BYTES) throw new Error("Native root marker exceeds its serialized limit");
        if (name === NATIVE_HISTORY_ROOT_FILE) await this.nativeHistoryRoot(rootIdentity).read();
        continue;
      }
      if (name === MODEL_SWITCH_DIRECTORY) {
        await this.switchInventory(rootIdentity); continue;
      }
      if (name === PENDING_TURN_DIRECTORY) {
        await this.pendingPayloads(rootIdentity).list();
        continue;
      }
      if (name === TOOL_HISTORY_DIRECTORY) {
        const info = await lstat(path);
        assertSecureHistoryDirectory(info, path);
        continue;
      }
      if (HISTORY_FILE_PATTERN.test(name)) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_STORE_FILE_BYTES) {
          throw new Error(`History file ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
        }
        entries.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
        continue;
      }
      const temporaryMatch = TEMP_FILE_PATTERN.exec(name);
      if (temporaryMatch !== null) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (
          cleanStaleTemps
          && !activeConversationKeys.has(temporaryMatch[1] as string)
        ) {
          await rm(path);
          removedTemp = true;
        }
        continue;
      }
      throw new Error(`History root ${this.root} contains unsupported entry ${name}.`);
    }
    if (removedTemp) await fsyncDirectory(this.root, rootIdentity);
    await assertDirectoryIdentity(this.root, rootIdentity);
    return entries;
  }

  private async ensureRoot(): Promise<DirectoryIdentity> {
    this.rootReady ??= createAndVerifyRoot(this.root).catch((error) => {
      this.rootReady = undefined;
      throw error;
    });
    return await this.rootReady;
  }

  private async ensureLocksRoot(): Promise<DirectoryIdentity> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    this.locksRootReady ??= createAndVerifyLocksRoot(locksRoot).catch((error) => {
      this.locksRootReady = undefined;
      throw error;
    });
    return await this.locksRootReady;
  }

  private async acquireRootTransaction(rootIdentity: DirectoryIdentity): Promise<() => Promise<void>> {
    const releaseProcess = await acquireQueue(PROCESS_ROOT_QUEUES, this.root);
    try {
      await assertDirectoryIdentity(this.root, rootIdentity);
      const locksIdentity = await this.ensureLocksRoot();
      const lock = await acquireCrossProcessLock(join(this.root, LOCKS_DIRECTORY, ROOT_LOCK_FILE), locksIdentity);
      const accounting: RootAccounting = { records: new Map() };
      this.rootAccounting = accounting;
      let released = false;
      return async (): Promise<void> => {
        if (released) return;
        released = true;
        if (this.rootAccounting === accounting) this.rootAccounting = undefined;
        try {
          await lock.release();
        } finally {
          releaseProcess();
        }
      };
    } catch (error) {
      releaseProcess();
      throw error;
    }
  }

  private async acquireConversation(
    conversationId: string,
    logicalFence?: HeldLogicalConversation,
    exactFence?: HeldExactConversationClaim,
    tryOnly = false,
  ): Promise<HeldConversation> {
    const expectedLogicalId = logicalConversationIdForFence(conversationId);
    if (
      logicalFence !== undefined
      && !belongsToLogicalConversation(conversationId, logicalFence.logicalConversationId)
    ) {
      throw new Error("Physical conversation does not belong to the held logical-session fence.");
    }
    if (exactFence !== undefined && exactFence.conversationId !== conversationId) {
      throw new Error("Physical conversation does not belong to the held exact-conversation claim.");
    }
    const heldLogical = logicalFence ?? await this.acquireLogicalConversation(expectedLogicalId, tryOnly);
    const ownsLogicalFence = logicalFence === undefined;
    const conversationKey = historyKey(conversationId);
    let heldExact = exactFence;
    let ownsExactFence = false;
    let releaseProcess: (() => void) | undefined;
    let legacyLock: CrossProcessLock | undefined;
    let marker: ActiveMarker | undefined;
    let rootIdentity: DirectoryIdentity | undefined;
    try {
      if (requiresExactConversationClaim(conversationId) && heldExact === undefined) {
        heldExact = await this.acquireExactConversationClaim(conversationId, tryOnly);
        ownsExactFence = true;
      }
      if (tryOnly && PROCESS_APPEND_QUEUES.has(this.queueKey(conversationId))) throw new HistoryOwnerBusyError("Physical history owner is busy.");
      releaseProcess = await acquireQueue(PROCESS_APPEND_QUEUES, this.queueKey(conversationId));
      rootIdentity = await this.ensureRoot();
      const locksIdentity = await this.ensureLocksRoot();
      // Logical/exact owner rows already serialize every physical mutation.
      // Never hold a shared shard transaction across a provider call: a shard
      // collision must not block unrelated admission or cancellation publication.
      // Claim-aware writers (>=0.20.0) share these same rows, including writers
      // that still hold the redundant physical shard lock. Pre-0.20.0 writers
      // must be stopped before sharing this root; there is no old-binary fence.
      // Keep legacy per-conversation inodes in place and honor existing locks.
      legacyLock = await acquireExistingCrossProcessLock(
        join(this.root, LOCKS_DIRECTORY, `${conversationKey}.sqlite`),
        locksIdentity,
        tryOnly,
      );
      const releaseRoot = await this.acquireRootTransaction(rootIdentity);
      try {
        await this.retireInactiveDirtyFences(rootIdentity, locksIdentity, conversationKey);
        marker = await this.createActiveMarker(conversationKey, locksIdentity);
      } finally {
        await releaseRoot();
      }
      let released = false;
      const held: HeldConversation = {
        logical: heldLogical,
        marker,
        rootIdentity,
        assertOwned: async (): Promise<void> => {
          if (released) throw new Error("History conversation ownership has been released.");
          await heldLogical.assertOwned();
          await assertDirectoryIdentity(this.root, rootIdentity!);
          const current = await readActiveMarker(marker!.path);
          if (current.token !== marker!.token || current.conversationKey !== conversationKey || current.pid !== process.pid) {
            throw new Error("History conversation ownership changed.");
          }
        },
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            await legacyLock?.release();
          } finally {
            releaseProcess?.();
            try {
              if (ownsExactFence) await heldExact?.release();
            } finally {
              if (ownsLogicalFence) await heldLogical.release();
            }
          }
        },
      };
      await this.recoverNativeOperation(conversationId, held);
      return held;
    } catch (error) {
      if (marker !== undefined && rootIdentity !== undefined) {
        const releaseRoot = await this.acquireRootTransaction(rootIdentity).catch(() => undefined);
        if (releaseRoot !== undefined) {
          try {
            await this.removeActiveMarker(marker).catch(() => undefined);
          } finally {
            await releaseRoot();
          }
        }
      }
      await legacyLock?.release().catch(() => undefined);
      releaseProcess?.();
      try {
        if (ownsExactFence) await heldExact?.release().catch(() => undefined);
      } finally {
        if (ownsLogicalFence) await heldLogical.release().catch(() => undefined);
      }
      throw error;
    }
  }

  private async acquireLogicalConversation(
    logicalConversationId: string,
    tryOnly = false,
  ): Promise<HeldLogicalConversation> {
    if (tryOnly && PROCESS_LOGICAL_SESSION_QUEUES.has(`${this.root}\0${historyKey(logicalConversationId)}`)) throw new HistoryOwnerBusyError("Logical history owner is busy.");
    const releaseProcess = await acquireQueue(
      PROCESS_LOGICAL_SESSION_QUEUES,
      `${this.root}\0${historyKey(logicalConversationId)}`,
    );
    try {
      const rootIdentity = await this.ensureRoot();
      const locksIdentity = await this.ensureLocksRoot();
      const lock = await acquireSessionClaim(
        join(this.root, LOCKS_DIRECTORY, logicalSessionShardLockName(historyKey(logicalConversationId))),
        locksIdentity,
        sessionClaimKey("logical", logicalConversationId),
        tryOnly,
      );
      let released = false;
      return {
        logicalConversationId,
        rootIdentity,
        assertOwned: async (): Promise<void> => {
          if (released) throw new Error("History logical ownership has been released.");
          await assertDirectoryIdentity(this.root, rootIdentity);
          await assertDirectoryIdentity(join(this.root, LOCKS_DIRECTORY), locksIdentity);
        },
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            await lock.release();
          } finally {
            releaseProcess();
          }
        },
      };
    } catch (error) {
      releaseProcess();
      throw error;
    }
  }

  private async acquireExactConversationClaim(
    conversationId: string,
    tryOnly = false,
  ): Promise<HeldExactConversationClaim> {
    const rootIdentity = await this.ensureRoot();
    const locksIdentity = await this.ensureLocksRoot();
    const lock = await acquireSessionClaim(
      join(this.root, LOCKS_DIRECTORY, logicalSessionShardLockName(historyKey(conversationId))),
      locksIdentity,
      sessionClaimKey("exact", conversationId),
      tryOnly,
    );
    let released = false;
    return {
      conversationId,
      rootIdentity,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await lock.release();
      },
    };
  }

  private async releaseConversation(held: HeldConversation, rootIdentity: DirectoryIdentity): Promise<void> {
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    try {
      await this.removeActiveMarker(held.marker);
    } finally {
      await releaseRoot();
      await held.release();
    }
  }

  private async createActiveMarker(
    conversationKey: string,
    locksIdentity: DirectoryIdentity,
  ): Promise<ActiveMarker> {
    const token = randomBytes(16).toString("hex");
    const marker: ActiveMarker = {
      path: join(this.root, LOCKS_DIRECTORY, `${conversationKey}.${process.pid}.${token}.active`),
      conversationKey,
      pid: process.pid,
      token,
    };
    const body = Buffer.from(`${JSON.stringify({
      version: 1,
      conversationKey,
      pid: process.pid,
      token,
    })}\n`, "utf8");
    let handle;
    let complete = false;
    try {
      handle = await open(
        marker.path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
        0o600,
      );
      await handle.writeFile(body);
      await handle.chmod(0o600);
      await handle.sync();
      const info = await handle.stat();
      assertSecureHistoryFile(info, marker.path);
      if (info.size !== body.byteLength) throw new Error(`History active marker ${marker.path} was not written completely.`);
      complete = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!complete) await rm(marker.path, { force: true }).catch(() => undefined);
    }
    try {
      await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
      return marker;
    } catch (error) {
      await rm(marker.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async removeActiveMarker(marker: ActiveMarker): Promise<void> {
    const locksIdentity = await this.ensureLocksRoot();
    await rm(marker.path, { force: true });
    await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
  }

  private async scanActiveMarkers(cleanDead: boolean): Promise<readonly ActiveMarker[]> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    const locksIdentity = await this.ensureLocksRoot();
    await assertDirectoryIdentity(locksRoot, locksIdentity);
    const markers: ActiveMarker[] = [];
    let removed = false;
    for (const name of (await readdir(locksRoot)).sort()) {
      if (
        name === ROOT_LOCK_FILE
        || name === TOOL_HISTORY_OWNER_FILE
        || LEGACY_CONVERSATION_LOCK_PATTERN.test(name)
        || isConversationShardLockName(name)
        || isLogicalSessionShardLockName(name)
      ) {
        const path = join(locksRoot, name);
        assertSecureHistoryFile(await lstat(path), path);
        continue;
      }
      if (isLogicalSessionShardJournalName(name)) {
        await assertSessionClaimJournalIfPresent(join(locksRoot, name));
        continue;
      }
      if (DIRTY_FENCE_PATTERN.test(name) || DIRTY_FENCE_TEMP_PATTERN.test(name)) {
        const path = join(locksRoot, name);
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_DIRTY_FENCE_BYTES) {
          throw new Error(`History dirty fence ${path} is too large.`);
        }
        continue;
      }
      const match = ACTIVE_MARKER_PATTERN.exec(name);
      if (match === null) throw new Error(`History lock root ${locksRoot} contains unsupported entry ${name}.`);
      const path = join(locksRoot, name);
      const info = await lstat(path);
      assertSecureHistoryFile(info, path);
      if (info.size > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
      const markerPid = Number.parseInt(match[2] as string, 10);
      // A crashed writer may leave a partial marker. The unique filename is
      // enough to safely reap it once its owner PID is no longer live.
      if (cleanDead && !isProcessAlive(markerPid)) {
        await rm(path);
        removed = true;
        continue;
      }
      const marker = await readActiveMarker(path);
      if (
        marker.conversationKey !== match[1]
        || marker.pid !== markerPid
        || marker.token !== match[3]
      ) {
        throw new Error(`History active marker ${path} does not match its filename.`);
      }
      markers.push(marker);
    }
    if (removed) await fsyncDirectory(locksRoot, locksIdentity);
    return markers;
  }

  private async scanDirtyFences(
    locksIdentity: DirectoryIdentity,
    cleanDeadTemps: boolean,
  ): Promise<readonly DirtyFence[]> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    await assertDirectoryIdentity(locksRoot, locksIdentity);
    const fences: DirtyFence[] = [];
    let removed = false;
    for (const name of (await readdir(locksRoot)).sort()) {
      const path = join(locksRoot, name);
      if (
        name === ROOT_LOCK_FILE
        || name === TOOL_HISTORY_OWNER_FILE
        || LEGACY_CONVERSATION_LOCK_PATTERN.test(name)
        || isConversationShardLockName(name)
        || isLogicalSessionShardLockName(name)
        || ACTIVE_MARKER_PATTERN.test(name)
      ) {
        assertSecureHistoryFile(await lstat(path), path);
        continue;
      }
      if (isLogicalSessionShardJournalName(name)) {
        await assertSessionClaimJournalIfPresent(path);
        continue;
      }
      const fenceMatch = DIRTY_FENCE_PATTERN.exec(name);
      if (fenceMatch !== null) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_DIRTY_FENCE_BYTES) {
          throw new Error(`History dirty fence ${path} is too large.`);
        }
        const fence = await readDirtyFence(path);
        if (fence.conversationKey !== fenceMatch[1]) {
          throw new Error(`History dirty fence ${path} does not match its filename.`);
        }
        fences.push({ ...fence, mtimeMs: info.mtimeMs });
        continue;
      }
      const tempMatch = DIRTY_FENCE_TEMP_PATTERN.exec(name);
      if (tempMatch !== null) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_DIRTY_FENCE_BYTES) {
          throw new Error(`History dirty fence temporary ${path} is too large.`);
        }
        const ownerPid = Number.parseInt(tempMatch[2] as string, 10);
        if (cleanDeadTemps && !isProcessAlive(ownerPid)) {
          await rm(path);
          removed = true;
        }
        continue;
      }
      throw new Error(`History lock root ${locksRoot} contains unsupported entry ${name}.`);
    }
    if (removed) await fsyncDirectory(locksRoot, locksIdentity);
    return fences;
  }

  private async retireInactiveDirtyFences(
    rootIdentity: DirectoryIdentity,
    locksIdentity: DirectoryIdentity,
    excludedConversationKey: string,
  ): Promise<void> {
    if (this.retireProviderSession === undefined) return;
    const activeKeys = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    const fences = await this.scanDirtyFences(locksIdentity, true);
    if (fences.length === 0) return;
    const switchingKeys = new Set((await this.switchInventory(rootIdentity)).pending.map((entry) => historyKey(entry.state.identity.historyBucket)));
    for (const name of await readdir(this.root)) { const match = NATIVE_OPERATION_PATTERN.exec(name); if (match) switchingKeys.add(match[1]!); }
    const committedByName = new Map(
      (await this.scanCommittedEntries(rootIdentity, true)).map((entry) => [entry.name, entry]),
    );
    const planned: Array<{ fence: DirtyFence & { readonly providerSessionId: string }; committedEntry: CommittedEntry | undefined; committedRecord: LoadedHistoryRecord | undefined; canonicalProvesCommit: boolean }> = [];
    for (const fence of fences) {
      if (
        fence.conversationKey === excludedConversationKey
        || fence.kind === "execution" || fence.kind === "compaction"
        || activeKeys.has(fence.conversationKey)
        || switchingKeys.has(fence.conversationKey)
        || fence.providerSessionId === undefined
      ) {
        continue;
      }
      const committedEntry = committedByName.get(`${fence.conversationKey}${HISTORY_FILE_SUFFIX}`);
      let committedRecord: LoadedHistoryRecord | undefined;
      try { committedRecord = committedEntry === undefined ? undefined : await this.readCommittedEntryRecord(committedEntry, rootIdentity); }
      catch (error) {
        if (await this.nativeHistoryRoot(rootIdentity).read() && (error instanceof CanonicalParseFailure || error instanceof TruncatedHistoryRecordError || error instanceof TypeError)) continue;
        // Unmarked v1-v3 roots retain the original error and recovery behavior.
        throw error instanceof CanonicalParseFailure ? error.cause : error;
      }
      const canonicalProvesCommit = committedRecord?.providerSession !== undefined
        && committedRecord.providerSession?.epoch === fence.epoch
        && committedRecord.providerSession.modelKey === fence.modelKey
        && committedRecord.providerSession.dirtyRunId === undefined
        && committedRecord.providerSession.revision === fence.revision + 1;
      if (!canonicalProvesCommit && committedRecord?.sourceVersion === 4) continue; // unresolved chain owner is protected, never root-wide blocking
      planned.push({ fence: { ...fence, providerSessionId: fence.providerSessionId }, committedEntry, committedRecord, canonicalProvesCommit });
    }
    let removed = false;
    for (const { fence, committedEntry, committedRecord, canonicalProvesCommit } of planned) {
      // The fence is the crash-recovery journal: durable transcript deletion
      // happens first, then its directory entry is fsynced, and only then may
      // the fence disappear. A crash or error at any earlier point leaves the
      // idempotent journal visible for the next maintenance pass.
      // A canonical epoch at exactly revision+1 proves the history rename won
      // and only fence cleanup crashed; preserve that valid transcript.
      if (!canonicalProvesCommit) {
        const sameCommittedEpoch = committedRecord?.providerSession !== undefined
          && committedRecord.providerSession?.epoch === fence.epoch;
        // Contradictory owners for one id are corruption, not a retirement hint.
        // Validate both before invoking either runtime or losing the journal.
        await this.retireProviderSessions(sameCommittedEpoch
          ? this.providerSessionsForRetirement(committedRecord, fence)
          : [{ providerSessionId: fence.providerSessionId, ...modelBinding(fence.modelKey) }]);
        if (
          committedEntry !== undefined
          && committedRecord?.providerSession !== undefined
          && committedRecord.providerSession?.epoch === fence.epoch
        ) {
          await this.rotateCommittedProviderEpoch(committedEntry, committedRecord, rootIdentity);
        }
      }
      await rm(fence.path);
      removed = true;
    }
    if (removed) await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
  }

  private async assertNativeRecordAuthority(record: LoadedHistoryRecord, rootIdentity: DirectoryIdentity): Promise<void> {
    if (record.sourceVersion !== 4) return;
    const rootStore = this.nativeHistoryRoot(rootIdentity), marker = await rootStore.read();
    if (!marker) throw new TypeError("Canonical v4 root authority marker is missing; restore consistent backup");
    if (switchDigest(record.native?.authority) !== switchDigest(rootStore.authority(marker, logicalConversationIdForFence(record.conversationId), record.conversationId))) {
      throw new TypeError("Canonical native authority does not match the managed root marker");
    }
  }

  private async readRecord(
    conversationId: string,
    rootIdentity: DirectoryIdentity,
    strict = false,
  ): Promise<LoadedHistoryRecord> {
    strict ||= await this.nativeHistoryRoot(rootIdentity).read() !== undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const record = await this.readRecordOnce(conversationId, rootIdentity, strict);
        await this.assertNativeRecordAuthority(record, rootIdentity); return record;
      } catch (error) {
        if (attempt < 2 && (error instanceof ConcurrentHistoryMutationError || isErrno(error, "ENOENT"))) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("History record could not be read atomically.");
  }

  private async readRecordOnce(
    conversationId: string,
    rootIdentity: DirectoryIdentity,
    strict: boolean,
  ): Promise<LoadedHistoryRecord> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const path = this.recordPath(conversationId);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { sourceVersion: 0, conversationId, messages: [] };
      }
      throw error;
    }
    assertSecureHistoryFile(before, path);
    if (before.size > MAX_STORE_FILE_BYTES) {
      throw new Error(`History file ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
    }

    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      assertSecureHistoryFile(opened, path);
      assertSameIdentity(before, opened, path);
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
        throw new Error(`History file ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
      }
      const after = await handle.stat();
      assertSameIdentity(opened, after, path);
      let record: LoadedHistoryRecord;
      try {
        record = parseHistoryFile(bytes, path);
      } catch (error) {
        if (!strict && error instanceof TruncatedHistoryRecordError) {
          // Atomic replacement means our own writes cannot publish a partial
          // record. If the filesystem nevertheless presents stable truncated
          // JSON, fail cold instead of poisoning every future turn. Keep the
          // unreadable file in place so the next locked append replaces it
          // atomically; a fresh provider epoch then prevents stale transcript
          // resume without guessing at data that can no longer be parsed.
          await assertDirectoryIdentity(this.root, rootIdentity);
          return { sourceVersion: 0, conversationId, messages: [] };
        }
        throw error;
      }
      if (record.conversationId !== conversationId) {
        throw new Error(`History file ${path} does not belong to the requested conversation.`);
      }
      await assertDirectoryIdentity(this.root, rootIdentity);
      return record;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async prepareProviderRetirement(
    record: LoadedHistoryRecord,
    rootIdentity: DirectoryIdentity,
    reset = false,
  ): Promise<DirtyFence | undefined> {
    const locksIdentity = await this.ensureLocksRoot();
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    let fence: DirtyFence | undefined;
    try {
      await this.requireNoModelSwitch(record.conversationId, rootIdentity);
      this.requireNativeCapability(record, reset ? "whole-chain deletion" : "native epoch transition", reset ? "reset" : "provider retirement");
      const existing = await this.findDirtyFence(historyKey(record.conversationId), locksIdentity);
      if (!reset) requireSettledFence(existing);
      if (reset && existing?.kind !== undefined && this.retireProviderSession === undefined) {
        throw new Error("Reset of a pending native turn requires fail-closed provider retirement.");
      }
      if (this.retireProviderSession === undefined) return undefined;
      fence = await this.ensureRetirementFence(record, rootIdentity, locksIdentity, reset);
    } finally {
      await releaseRoot();
    }
    if (record.sourceVersion !== 4) await this.retireProviderSessions(this.providerSessionsForRetirement(record, fence));
    return fence;
  }

  private async ensureRetirementFence(
    record: LoadedHistoryRecord,
    rootIdentity: DirectoryIdentity,
    locksIdentity: DirectoryIdentity,
    reset = false,
  ): Promise<DirtyFence | undefined> {
    this.requireNativeCapability(record, reset ? "whole-chain deletion" : "native epoch transition", "retirement-fence issuance");
    const conversationKey = historyKey(record.conversationId);
    const existing = await this.findDirtyFence(conversationKey, locksIdentity);
    if (!reset) requireSettledFence(existing);
    if (existing !== undefined) return reset ? await this.authorizeFenceReset(existing, locksIdentity) : existing;
    if (record.providerSession === undefined) return undefined;
    await this.reserveDirtyFenceCapacity(conversationKey, rootIdentity, locksIdentity);
    const providerSessionId = deriveProviderSessionId(record.conversationId, record.providerSession.epoch);
    return await this.publishDirtyFence({
      conversationKey,
      logicalConversationKey: historyKey(logicalConversationIdForFence(record.conversationId)),
      epoch: record.providerSession.epoch,
      ...modelBinding(record.providerSession.modelKey),
      providerSessionId,
      revision: record.providerSession.revision ?? 0,
      runIdDigest: digestRunId(`history-retirement-${randomBytes(16).toString("hex")}`),
    }, locksIdentity);
  }

  private async authorizeFenceReset(fence: DirtyFence, locksIdentity: DirectoryIdentity): Promise<DirtyFence> {
    if (fence.kind !== "execution" && fence.kind !== "compaction") return fence;
    return await this.publishDirtyFence({
      kind: "retirement", conversationKey: fence.conversationKey, logicalConversationKey: fence.logicalConversationKey!,
      epoch: fence.epoch, providerSessionId: fence.providerSessionId!, modelKey: fence.modelKey!,
      revision: fence.revision, runIdDigest: fence.runIdDigest,
    }, locksIdentity);
  }

  private async removePendingConversation(conversationKey: string, rootIdentity: DirectoryIdentity,
    assertOwned: () => Promise<void>): Promise<void> {
    const payloads = this.pendingPayloads(rootIdentity);
    const runs = new Set((await payloads.list()).filter((entry) => entry.conversationKey === conversationKey).map((entry) => entry.runIdDigest));
    for (const runIdDigest of runs) {
      await payloads.collectUnreferenced({ conversationKey, runIdDigest }, [], {
        assertOwned,
        reserve: async () => { throw new Error("Reset cleanup cannot publish pending payloads."); },
      });
    }
  }

  private providerSessionsForRetirement(
    record: LoadedHistoryRecord,
    fence?: DirtyFence,
  ): readonly ProviderSessionHandle[] {
    return [
      ...(record.providerSession === undefined
        ? []
        : [{ providerSessionId: deriveProviderSessionId(record.conversationId, record.providerSession.epoch), ...modelBinding(record.providerSession.modelKey) }]),
      ...(fence === undefined
        ? []
        : [{ providerSessionId: fence.providerSessionId ?? deriveProviderSessionId(record.conversationId, fence.epoch), ...modelBinding(fence.modelKey) }]),
    ];
  }

  private async readCommittedEntryRecord(
    entry: CommittedEntry,
    rootIdentity: DirectoryIdentity,
  ): Promise<LoadedHistoryRecord> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const before = await lstat(entry.path);
    assertSecureHistoryFile(before, entry.path);
    let handle;
    try {
      handle = await open(entry.path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      assertSecureHistoryFile(opened, entry.path);
      assertSameIdentity(before, opened, entry.path);
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
        throw new Error(`History file ${entry.path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
      }
      const after = await handle.stat();
      assertSameIdentity(opened, after, entry.path);
      let record: LoadedHistoryRecord;
      try {
        record = parseHistoryFile(bytes, entry.path); await this.assertNativeRecordAuthority(record, rootIdentity);
        if (`${historyKey(record.conversationId)}${HISTORY_FILE_SUFFIX}` !== entry.name) throw new Error(`History file ${entry.path} does not match its conversation id.`);
      } catch (error) { throw new CanonicalParseFailure(error); }
      return record;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async rotateCommittedProviderEpoch(
    entry: CommittedEntry,
    record: LoadedHistoryRecord,
    rootIdentity: DirectoryIdentity,
  ): Promise<void> {
    if (record.providerSession === undefined) return;
    this.requireNativeCapability(record, "native epoch transition", "inactive provider epoch rotation");
    const rotated: CanonicalHistoryFile = {
      version: STORE_VERSION,
      conversationId: record.conversationId,
      messages: record.messages,
      ...lastCommitBinding(record),
      providerSession: { epoch: createProviderSessionEpoch(), revision: 0, ...modelBinding(record.providerSession.modelKey) },
    };
    const stage = await this.writeStage(rotated, rootIdentity);
    let published = false;
    try {
      await rename(stage.temporaryPath, entry.path);
      this.invalidateCanonicalAccounting(entry.name);
      published = true;
      await fsyncDirectory(this.root, rootIdentity);
    } finally {
      if (!published) await rm(stage.temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async retireProviderSessions(handles: readonly ProviderSessionHandle[]): Promise<void> {
    if (this.retireProviderSession === undefined) return;
    for (const { providerSessionId, modelKey } of uniqueSessionHandles(handles)) {
      if (!/^[a-f0-9]{64}$/u.test(providerSessionId)) {
        throw new Error("History produced an invalid provider session id for retirement.");
      }
      await this.retireProviderSession(providerSessionId, modelKey);
    }
  }

  private recordPath(conversationId: string): string {
    return join(this.root, `${historyKey(conversationId)}${HISTORY_FILE_SUFFIX}`);
  }

  private queueKey(conversationId: string): string {
    return `${this.root}\0${historyKey(conversationId)}`;
  }
}

export function createDurableHistoryStore(options: DurableHistoryStoreOptions): DurableConversationHistoryStore {
  return new DurableConversationHistoryStore(options);
}

function normalizeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

async function acquireQueue(queues: Map<string, Promise<void>>, key: string): Promise<() => void> {
  const prior = queues.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate;
  });
  const tail = prior.catch(() => undefined).then(async () => await gate);
  queues.set(key, tail);
  await prior.catch(() => undefined);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    releaseGate();
    if (queues.get(key) === tail) queues.delete(key);
  };
}

function recordPostCommitMaintenanceFailure(root: string, error: unknown): void {
  const previous = PROCESS_POST_COMMIT_FAILURES.get(root);
  PROCESS_POST_COMMIT_FAILURES.set(root, {
    count: (previous?.count ?? 0) + 1,
    lastError: error instanceof Error ? error.message : String(error),
  });
}

function compareRetentionEntries(left: CommittedEntry, right: CommittedEntry): number {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

function historyRecordVersion(record: LoadedHistoryRecord | CanonicalHistoryFile): string {
  return createHash("sha256")
    .update("mono-agent-history-version-v1\0")
    .update(JSON.stringify({
      sourceVersion: "sourceVersion" in record ? record.sourceVersion : record.version,
      conversationId: record.conversationId,
      messages: record.messages,
      providerSession: record.providerSession,
      lastCommit: record.lastCommit,
      ...v4Extension(record),
    }), "utf8")
    .digest("hex");
}

function validateContextImportRequest(
  request: AgentContextImportRequest & { readonly timestamp: string },
): AgentContextImportRequest & { readonly timestamp: string } {
  if (!isRecord(request)) throw new TypeError("context import request must be an object.");
  const keys = Object.keys(request).sort();
  if (keys.join("\0") !== ["idempotencyKey", "text", "timestamp"].join("\0")) {
    throw new TypeError("context import request must contain only text, idempotencyKey, and timestamp.");
  }
  if (typeof request.text !== "string" || request.text.trim().length === 0) {
    throw new TypeError("context import text must be a non-empty string.");
  }
  if (Buffer.byteLength(request.text, "utf8") > AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES) {
    throw new TypeError(`context import text must not exceed ${AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES} UTF-8 bytes.`);
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim().length === 0) {
    throw new TypeError("context import idempotencyKey must be a non-empty string.");
  }
  if (Buffer.byteLength(request.idempotencyKey, "utf8") > AGENT_CONTEXT_IMPORT_MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new TypeError(`context import idempotencyKey must not exceed ${AGENT_CONTEXT_IMPORT_MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes.`);
  }
  if (request.idempotencyKey.includes("\0")) {
    throw new TypeError("context import idempotencyKey must not contain NUL bytes.");
  }
  if (typeof request.timestamp !== "string") throw new TypeError("context import timestamp must be a string.");
  const parsed = new Date(request.timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== request.timestamp) {
    throw new TypeError("context import timestamp must be a canonical ISO-8601 timestamp.");
  }
  return { text: request.text, idempotencyKey: request.idempotencyKey, timestamp: request.timestamp };
}

function findContextImportPair(
  messages: readonly HistoryMessage[],
  idempotencyKey: string,
): { readonly valid: boolean; readonly text: string } | undefined {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.idempotencyKey !== idempotencyKey) continue;
    const provenance = messages[index - 1];
    if (
      message.role === "assistant"
      && message.name === "context-import"
      && provenance?.role === "system"
      && provenance.name === "context-import-provenance"
      && provenance.content === AGENT_CONTEXT_IMPORT_SYSTEM_PROVENANCE
      && provenance.timestamp === message.timestamp
    ) {
      return { valid: true, text: message.content };
    }
    return { valid: false, text: "" };
  }
  return undefined;
}

function retainHistoryMessages(messages: readonly HistoryMessage[], maxMessages: number): readonly HistoryMessage[] {
  if (maxMessages === 0 || messages.length === 0) return [];
  const units: Array<readonly HistoryMessage[]> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const first = messages[index]!;
    const second = messages[index + 1];
    if (
      first.role === "system"
      && first.name === "context-import-provenance"
      && first.content === AGENT_CONTEXT_IMPORT_SYSTEM_PROVENANCE
      && second?.role === "assistant"
      && second.name === "context-import"
      && second.timestamp === first.timestamp
      && second.idempotencyKey !== undefined
    ) {
      units.push([first, second]);
      index += 1;
    } else {
      units.push([first]);
    }
  }
  const retained: HistoryMessage[][] = [];
  let remaining = maxMessages;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (unit.length > remaining) continue;
    retained.unshift(unit.map(cloneMessage));
    remaining -= unit.length;
    if (remaining === 0) break;
  }
  return retained.flat();
}

function normalizeConversationId(conversationId: string): string {
  if (typeof conversationId !== "string") throw new TypeError("conversationId must be a non-empty string.");
  const normalized = conversationId.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) throw new TypeError("conversationId must be a non-empty string.");
  if (bytes > AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES) {
    throw new TypeError(`conversationId must not exceed ${AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES} UTF-8 bytes.`);
  }
  if (normalized.includes("\0")) throw new TypeError("conversationId must not contain NUL bytes.");
  return normalized;
}

function belongsToLogicalConversation(conversationId: string, logicalConversationId: string): boolean {
  return conversationId === logicalConversationId
    || new RegExp(`^${escapeRegExp(logicalConversationId)}#\\d{4}-\\d{2}-\\d{2}$`, "u").test(conversationId);
}

function logicalConversationIdForFence(conversationId: string): string {
  const logicalId = conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "");
  return logicalId.length === 0 ? conversationId : logicalId;
}

function requiresExactConversationClaim(conversationId: string): boolean {
  return logicalConversationIdForFence(conversationId) !== conversationId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeRunId(runId: string): string {
  if (typeof runId !== "string") throw new TypeError("runId must be a non-empty string.");
  const normalized = runId.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) throw new TypeError("runId must be a non-empty string.");
  if (bytes > MAX_RUN_ID_BYTES) throw new TypeError(`runId must not exceed ${MAX_RUN_ID_BYTES} UTF-8 bytes.`);
  if (normalized.includes("\0")) throw new TypeError("runId must not contain NUL bytes.");
  return normalized;
}

function historyKey(conversationId: string): string {
  return createHash("sha256").update("mono-agent-history-v1\0").update(conversationId, "utf8").digest("hex");
}

function sessionClaimKey(kind: "exact" | "logical", conversationId: string): string {
  return createHash("sha256")
    .update("mono-agent-history-session-claim-v1\0")
    .update(kind, "utf8")
    .update("\0")
    .update(conversationId, "utf8")
    .digest("hex");
}

function logicalSessionShardLockName(logicalConversationKey: string): string {
  const shard = Number.parseInt(logicalConversationKey.slice(0, 8), 16) % LOGICAL_SESSION_LOCK_SHARDS;
  return `logical-session-shard-${shard.toString(16).padStart(2, "0")}.sqlite`;
}

function isConversationShardLockName(name: string): boolean {
  const match = CONVERSATION_SHARD_LOCK_PATTERN.exec(name);
  return match !== null && Number.parseInt(match[1] as string, 16) < CONVERSATION_LOCK_SHARDS;
}

function isLogicalSessionShardLockName(name: string): boolean {
  const match = LOGICAL_SESSION_SHARD_LOCK_PATTERN.exec(name);
  return match !== null && Number.parseInt(match[1] as string, 16) < LOGICAL_SESSION_LOCK_SHARDS;
}

function isLogicalSessionShardJournalName(name: string): boolean {
  const match = LOGICAL_SESSION_SHARD_JOURNAL_PATTERN.exec(name);
  return match !== null && Number.parseInt(match[1] as string, 16) < LOGICAL_SESSION_LOCK_SHARDS;
}

function createProviderSessionEpoch(): string {
  return randomBytes(32).toString("hex");
}

function digestRunId(runId: string): string {
  return createHash("sha256").update("mono-agent-provider-dirty-run-v1\0").update(runId, "utf8").digest("hex");
}

function deriveProviderSessionId(conversationId: string, epoch: string): string {
  return createHash("sha256")
    .update("mono-agent-provider-session-v2\0")
    .update(conversationId, "utf8")
    .update("\0")
    .update(epoch, "utf8")
    .digest("hex");
}

function validateAppendMessages(messages: readonly HistoryMessage[]): readonly HistoryMessage[] {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array.");
  if (messages.length > MAX_APPEND_MESSAGES) {
    throw new TypeError(`append accepts at most ${MAX_APPEND_MESSAGES} messages.`);
  }
  return Array.from(messages, (message) => validateAndCloneMessage(message));
}

function validateAndCloneMessage(value: HistoryMessage): HistoryMessage {
  if (!isRecord(value)) throw new TypeError("Each history message must be an object.");
  const allowed = new Set(["role", "content", "name", "timestamp", "runId", "idempotencyKey"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`History message contains unsupported field ${key}.`);
  }
  if (!(["system", "user", "assistant", "tool"] as const).includes(value.role)) {
    throw new TypeError("History message role is invalid.");
  }
  if (typeof value.content !== "string") throw new TypeError("History message content must be a string.");
  const contentBytes = Buffer.byteLength(value.content, "utf8");
  if (contentBytes > MAX_MESSAGE_CONTENT_BYTES) {
    throw new TypeError(`History message content must not exceed ${MAX_MESSAGE_CONTENT_BYTES} UTF-8 bytes.`);
  }
  const optional = ["name", "timestamp", "runId", "idempotencyKey"] as const;
  for (const field of optional) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new TypeError(`History message ${field} must be a string when present.`);
    }
  }
  const clone = cloneMessage(value);
  const envelope = { ...clone, content: "" };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_MESSAGE_ENVELOPE_BYTES) {
    throw new TypeError(`History message metadata must not exceed ${MAX_MESSAGE_ENVELOPE_BYTES} serialized UTF-8 bytes.`);
  }
  if (Buffer.byteLength(JSON.stringify(clone), "utf8") > MAX_MESSAGE_SERIALIZED_BYTES) {
    throw new TypeError("History message cannot be represented within its serialized safety limit.");
  }
  return clone;
}

function cloneMessage(message: HistoryMessage): HistoryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
  };
}

function lastCommitBinding(record: { readonly lastCommit?: DurableTurnReceipt }): { readonly lastCommit?: DurableTurnReceipt } {
  return record.lastCommit === undefined ? {} : { lastCommit: { ...record.lastCommit } };
}

function v4Extension(record: { readonly conversationId: string; readonly native?: TurnHistoryV4["native"]; readonly lastSwitch?: TurnHistoryV4["lastSwitch"] }) {
  return record.native === undefined ? {} : { native: structuredClone(record.native),
    ...(record.lastSwitch === undefined ? {} : { lastSwitch: structuredClone(record.lastSwitch) }) };
}
/** Preserve chain/authority/projection/switch receipt only for a proven same-
 * epoch write. Never invent a native journal descriptor or demote v4 to v3. */
function preserveV4(existing: LoadedHistoryRecord | CanonicalHistoryFile, next: CanonicalHistoryFile): CanonicalHistoryFile {
  if (("sourceVersion" in existing ? existing.sourceVersion : existing.version) !== 4) return next;
  if (next.conversationId !== existing.conversationId || next.providerSession.epoch !== existing.providerSession?.epoch
    || next.providerSession.modelKey !== existing.providerSession.modelKey) {
    return next; // The owner-held native lifecycle planner must complete this candidate.
  }
  const record = { ...next, version: 4, ...v4Extension(existing) };
  validateTurnHistoryV4(record, (message) => validateAndCloneMessage(message as HistoryMessage));
  return record;
}

function serializeHistoryFile(record: CanonicalHistoryFile): Buffer {
  if (record.version === 4) validateTurnHistoryV4(record, (message) => validateAndCloneMessage(message as HistoryMessage));
  else validateTurnHistoryV3(record, (message) => validateAndCloneMessage(message as HistoryMessage));
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
    throw new Error(`Serialized conversation history exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
  }
  return bytes;
}

function serializeDirtyFence(value: Omit<DirtyFence, "path" | "mtimeMs">): Buffer {
  if (value.kind !== undefined) return serializeDurableTurnFence({ version: 5, kind: value.kind, conversationKey: value.conversationKey,
    logicalConversationKey: value.logicalConversationKey!, epoch: value.epoch, providerSessionId: value.providerSessionId!, modelKey: value.modelKey!,
    revision: value.revision, runIdDigest: value.runIdDigest, ...(value.payload === undefined ? {} : { payload: value.payload }) });
  if (value.modelKey !== undefined) {
    assertSessionModelKey(value.modelKey);
    if (value.logicalConversationKey === undefined || value.providerSessionId === undefined) {
      throw new Error("Bound dirty fences require logical and provider session identities.");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(value.conversationKey)) {
    throw new Error("History dirty fence has an invalid conversation key.");
  }
  if (value.logicalConversationKey !== undefined && !/^[a-f0-9]{64}$/u.test(value.logicalConversationKey)) {
    throw new Error("History dirty fence has an invalid logical conversation key.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.epoch)) {
    throw new Error("History dirty fence has an invalid provider epoch.");
  }
  if (value.providerSessionId !== undefined && !/^[a-f0-9]{64}$/u.test(value.providerSessionId)) {
    throw new Error("History dirty fence has an invalid provider session id.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("History dirty fence has an invalid provider revision.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.runIdDigest)) {
    throw new Error("History dirty fence has an invalid run digest.");
  }
  const bytes = Buffer.from(`${JSON.stringify({
    version: value.modelKey !== undefined ? 4 : value.logicalConversationKey !== undefined
      ? 3
      : value.providerSessionId === undefined ? 1 : 2,
    conversationKey: value.conversationKey,
    ...modelBinding(value.modelKey),
    ...(value.logicalConversationKey === undefined
      ? {}
      : { logicalConversationKey: value.logicalConversationKey }),
    epoch: value.epoch,
    ...(value.providerSessionId === undefined ? {} : { providerSessionId: value.providerSessionId }),
    revision: value.revision,
    runIdDigest: value.runIdDigest,
  })}\n`, "utf8");
  if (bytes.byteLength > MAX_DIRTY_FENCE_BYTES) {
    throw new Error(`History dirty fence exceeds the ${MAX_DIRTY_FENCE_BYTES}-byte limit.`);
  }
  return bytes;
}

async function writePreparedFile(
  temporary: string,
  bytes: Buffer,
  root: string,
  rootIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(root, rootIdentity);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    const temporaryInfo = await handle.stat();
    assertSecureHistoryFile(temporaryInfo, temporary);
    if (temporaryInfo.size !== bytes.byteLength) {
      throw new Error(`History temporary ${temporary} was not written completely.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertDirectoryIdentity(root, rootIdentity);
}

function parseHistoryFile(bytes: Buffer, path: string): LoadedHistoryRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TruncatedHistoryRecordError(`History file ${path} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new Error(`History file ${path} must contain an object.`);
  if (typeof value.conversationId !== "string" || !Array.isArray(value.messages)) {
    throw new Error(`History file ${path} has an unsupported schema.`);
  }
  const conversationId = normalizeConversationId(value.conversationId);
  if (conversationId !== value.conversationId) {
    throw new Error(`History file ${path} contains a non-canonical conversation id.`);
  }
  if (value.messages.length > DEFAULT_MAX_MESSAGES) {
    throw new Error(`History file ${path} exceeds the ${DEFAULT_MAX_MESSAGES}-message limit.`);
  }
  const messages = value.messages.map((message) => validateAndCloneMessage(message as HistoryMessage));
  const keys = Object.keys(value).sort().join(",");
  if (value.version === LEGACY_STORE_VERSION && keys === "conversationId,messages,version") {
    return { sourceVersion: LEGACY_STORE_VERSION, conversationId, messages };
  }
  if (value.version === 4) {
    validateTurnHistoryV4(value, (message) => validateAndCloneMessage(message as HistoryMessage));
    if (value.native.authority.ownerKey !== logicalConversationIdForFence(conversationId)
      || value.native.chain.some((segment) => segment.handleId !== deriveProviderSessionId(conversationId, segment.epoch))) {
      throw new Error("Canonical v4 journal chain does not belong to the managed conversation");
    }
    return { sourceVersion: 4, conversationId, messages, providerSession: { ...value.providerSession },
      ...lastCommitBinding(value), ...v4Extension(value) };
  }
  if (value.version === STORE_VERSION) {
    validateTurnHistoryV3(value, (message) => validateAndCloneMessage(message as HistoryMessage));
    return {
      sourceVersion: STORE_VERSION,
      conversationId,
      messages,
      providerSession: { epoch: value.providerSession.epoch, revision: value.providerSession.revision, ...modelBinding(value.providerSession.modelKey) },
      ...lastCommitBinding(value),
    };
  }
  if (
    value.version !== PROVIDER_STORE_VERSION
    || keys !== "conversationId,messages,providerSession,version"
    || !isRecord(value.providerSession)
  ) {
    throw new Error(`History file ${path} has an unsupported schema.`);
  }
  const providerKeys = Object.keys(value.providerSession).sort().join(",");
  if (
    providerKeys !== "epoch"
    && providerKeys !== "dirtyRunId,epoch"
    && providerKeys !== "epoch,revision"
    && providerKeys !== "dirtyRunId,epoch,revision"
    && providerKeys !== "epoch,modelKey,revision"
    && providerKeys !== "dirtyRunId,epoch,modelKey,revision"
  ) {
    throw new Error(`History file ${path} has an unsupported provider session schema.`);
  }
  if (typeof value.providerSession.epoch !== "string" || !/^[a-f0-9]{64}$/u.test(value.providerSession.epoch)) {
    throw new Error(`History file ${path} has an invalid provider session epoch.`);
  }
  if ("modelKey" in value.providerSession) assertSessionModelKey(value.providerSession.modelKey);
  let revision: number | undefined;
  if (value.providerSession.revision !== undefined) {
    revision = value.providerSession.revision as number;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`History file ${path} has an invalid provider session revision.`);
    }
  }
  let dirtyRunId: string | undefined;
  if (value.providerSession.dirtyRunId !== undefined) {
    dirtyRunId = normalizeRunId(value.providerSession.dirtyRunId as string);
    if (dirtyRunId !== value.providerSession.dirtyRunId) {
      throw new Error(`History file ${path} has a non-canonical dirty run id.`);
    }
  }
  return {
    sourceVersion: PROVIDER_STORE_VERSION,
    conversationId,
    messages,
    providerSession: {
      epoch: value.providerSession.epoch,
      ...modelBinding(value.providerSession.modelKey as string | undefined),
      ...(revision === undefined ? {} : { revision }),
      ...(dirtyRunId === undefined ? {} : { dirtyRunId }),
    },
  };
}

class TruncatedHistoryRecordError extends Error {}

async function acquireCrossProcessLock(
  path: string,
  directoryIdentity: DirectoryIdentity,
  tryOnly = false,
): Promise<CrossProcessLock> {
  const directory = dirname(path);
  await ensureOwnerOnlyLockFile(path, directoryIdentity);
  for (;;) {
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      // MEMORY avoids world-umask-dependent journal sidecars while retaining
      // SQLite's kernel-backed cross-process RESERVED lock semantics.
      database.exec("PRAGMA journal_mode=MEMORY");
      database.exec("BEGIN IMMEDIATE");
      assertSecureHistoryFile(await lstat(path), path);
      let released = false;
      return {
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            database?.exec("ROLLBACK");
          } catch {
            // close() is the authoritative kernel-lock release after an
            // unexpected SQLite transaction-state error.
          }
          try {
            database?.close();
          } catch {
            // The connection is no longer reusable; never turn lock cleanup
            // into an ambiguous failure after a semantic history commit.
          }
          database = undefined;
        },
      };
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Closing a failed lock attempt is best-effort.
      }
      if (!isSqliteBusy(error)) throw error;
      if (tryOnly) throw new HistoryOwnerBusyError("Legacy history owner is busy.");
      // There is deliberately no age timeout: a live provider turn owns this
      // conversation until it settles. On process death SQLite's OS lock is
      // released automatically, while the durable dirty bit remains.
      await delay(8 + Math.floor(Math.random() * 17));
    }
  }
}

async function acquireSessionClaim(
  path: string,
  directoryIdentity: DirectoryIdentity,
  claimKey: string,
  tryOnly = false,
): Promise<CrossProcessLock> {
  if (!/^[a-f0-9]{64}$/u.test(claimKey)) {
    throw new Error("History session claim key must be an opaque SHA-256 digest.");
  }
  const directory = dirname(path);
  const token = randomBytes(16).toString("hex");
  await ensureOwnerOnlyLockFile(
    path,
    directoryIdentity,
    true,
    MAX_SESSION_CLAIM_FILE_BYTES,
  );
  for (;;) {
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    await assertSessionClaimJournalIfPresent(`${path}-journal`);
    let database: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode=DELETE");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA busy_timeout=0");
      database.exec(`
        CREATE TABLE IF NOT EXISTS session_claims (
          claim_key TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          token TEXT NOT NULL,
          acquired_at_ms INTEGER NOT NULL
        ) WITHOUT ROWID
      `);
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const prior = database.prepare(`
        SELECT claim_key,pid,token,acquired_at_ms FROM session_claims WHERE claim_key=?
      `).get(claimKey) as Record<string, unknown> | undefined;
      if (prior !== undefined) {
        const owner = parseSessionClaimOwner(prior, path);
        if (owner.claimKey !== claimKey) {
          throw new Error(`History session claim ${path} changed during acquisition.`);
        }
        const priorPid = owner.pid;
        const priorToken = owner.token;
        if (isProcessAlive(priorPid)) {
          database.exec("ROLLBACK");
          transactionOpen = false;
          database.close();
          database = undefined;
          if (tryOnly) throw new HistoryOwnerBusyError("Exact history claim is busy.");
          // Ownership is explicit and exact-keyed. Polling only observes that
          // live owner; unrelated keys can claim the same database meanwhile.
          await delay(8 + Math.floor(Math.random() * 17));
          continue;
        }
        const removed = database.prepare(`
          DELETE FROM session_claims WHERE claim_key=? AND pid=? AND token=?
        `).run(claimKey, priorPid, priorToken);
        if (Number(removed.changes) !== 1) {
          throw new Error("History session claim changed during dead-owner recovery.");
        }
      } else {
        const count = sessionClaimCount(database, path);
        if (count > MAX_SESSION_CLAIMS_PER_SHARD) {
          throw new Error(
            `History session claims exceed the ${MAX_SESSION_CLAIMS_PER_SHARD}-claim shard limit.`,
          );
        }
        if (count === MAX_SESSION_CLAIMS_PER_SHARD) {
          const owners = database.prepare(`
            SELECT claim_key,pid,token,acquired_at_ms FROM session_claims ORDER BY claim_key
          `).all() as Record<string, unknown>[];
          if (owners.length !== count) {
            throw new Error(`History session claim registry ${path} changed during capacity recovery.`);
          }
          const removeDead = database.prepare(`
            DELETE FROM session_claims WHERE claim_key=? AND pid=? AND token=?
          `);
          for (const row of owners) {
            const owner = parseSessionClaimOwner(row, path);
            if (isProcessAlive(owner.pid)) continue;
            const removed = removeDead.run(owner.claimKey, owner.pid, owner.token);
            if (Number(removed.changes) !== 1) {
              throw new Error("History session claim changed during capacity recovery.");
            }
          }
          if (sessionClaimCount(database, path) >= MAX_SESSION_CLAIMS_PER_SHARD) {
            throw new Error(
              `History session claims exceed the ${MAX_SESSION_CLAIMS_PER_SHARD}-claim shard limit.`,
            );
          }
        }
      }
      database.prepare(`
        INSERT INTO session_claims (claim_key,pid,token,acquired_at_ms)
        VALUES (?,?,?,?)
      `).run(claimKey, process.pid, token, Date.now());
      database.exec("COMMIT");
      transactionOpen = false;
      database.close();
      database = undefined;
      let released = false;
      return {
        release: async (): Promise<void> => {
          if (released) return;
          await releaseSessionClaim(
            path,
            directoryIdentity,
            claimKey,
            token,
          );
          released = true;
        },
      };
    } catch (error) {
      if (transactionOpen) {
        try { database?.exec("ROLLBACK"); } catch { /* close releases the short transaction */ }
      }
      try { database?.close(); } catch { /* no reuse after a failed claim attempt */ }
      if (!isSqliteBusy(error)) throw error;
      if (tryOnly) throw new HistoryOwnerBusyError("History claim shard is busy.");
      await delay(8 + Math.floor(Math.random() * 17));
    }
  }
}

async function releaseSessionClaim(
  path: string,
  directoryIdentity: DirectoryIdentity,
  claimKey: string,
  token: string,
): Promise<void> {
  const directory = dirname(path);
  for (;;) {
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    await assertSessionClaimJournalIfPresent(`${path}-journal`);
    let database: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode=DELETE");
      database.exec("PRAGMA synchronous=FULL");
      database.exec("PRAGMA busy_timeout=0");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const owner = database.prepare(`
        SELECT claim_key,pid,token,acquired_at_ms FROM session_claims WHERE claim_key=?
      `).get(claimKey) as Record<string, unknown> | undefined;
      const parsedOwner = owner === undefined ? undefined : parseSessionClaimOwner(owner, path);
      if (
        parsedOwner?.claimKey !== claimKey
        || parsedOwner.pid !== process.pid
        || parsedOwner.token !== token
      ) {
        throw new Error("History session claim ownership changed before release.");
      }
      const removed = database.prepare(`
        DELETE FROM session_claims WHERE claim_key=? AND pid=? AND token=?
      `).run(claimKey, process.pid, token);
      if (Number(removed.changes) !== 1) {
        throw new Error("History session claim was not released exactly once.");
      }
      database.exec("COMMIT");
      transactionOpen = false;
      database.close();
      return;
    } catch (error) {
      if (transactionOpen) {
        try { database?.exec("ROLLBACK"); } catch { /* close releases the short transaction */ }
      }
      try { database?.close(); } catch { /* no reuse after a failed release attempt */ }
      if (!isSqliteBusy(error)) throw error;
      await delay(8 + Math.floor(Math.random() * 17));
    }
  }
}

function parseSessionClaimOwner(
  row: Record<string, unknown>,
  path: string,
): { readonly claimKey: string; readonly pid: number; readonly token: string } {
  const claimKey = row.claim_key;
  const pid = Number(row.pid);
  const token = row.token;
  const acquiredAtMs = Number(row.acquired_at_ms);
  if (
    typeof claimKey !== "string"
    || !/^[a-f0-9]{64}$/u.test(claimKey)
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || typeof token !== "string"
    || !/^[a-f0-9]{32}$/u.test(token)
    || !Number.isSafeInteger(acquiredAtMs)
    || acquiredAtMs < 0
  ) {
    throw new Error(`History session claim ${path} has an invalid owner.`);
  }
  return { claimKey, pid, token };
}

function sessionClaimCount(database: DatabaseSync, path: string): number {
  const row = database.prepare("SELECT count(*) AS count FROM session_claims")
    .get() as Record<string, unknown>;
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`History session claim registry ${path} has an invalid row count.`);
  }
  return count;
}

async function assertSessionClaimJournalIfPresent(path: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  assertSecureTransientHistoryFile(info, path);
  if (info.size > MAX_SESSION_CLAIM_JOURNAL_BYTES) {
    throw new Error(`History session claim journal ${path} is unexpectedly large.`);
  }
}

async function acquireExistingCrossProcessLock(
  path: string,
  directoryIdentity: DirectoryIdentity,
  tryOnly = false,
): Promise<CrossProcessLock | undefined> {
  try {
    const info = await lstat(path);
    assertSecureHistoryFile(info, path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return await acquireCrossProcessLock(path, directoryIdentity, tryOnly);
}

async function ensureOwnerOnlyLockFile(
  path: string,
  directoryIdentity: DirectoryIdentity,
  syncCreatedDirectory = true,
  maxBytes = 64 * 1024,
): Promise<boolean> {
  const directory = dirname(path);
  await assertDirectoryIdentity(directory, directoryIdentity);
  let handle;
  let created = false;
  try {
    try {
      handle = await open(
        path,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
        0o600,
      );
      created = true;
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const info = await lstat(path);
  assertSecureHistoryFile(info, path);
  if (info.size > maxBytes) throw new Error(`History lock file ${path} is unexpectedly large.`);
  if (created && syncCreatedDirectory) await fsyncDirectory(directory, directoryIdentity);
  return created;
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy/iu.test(error.message);
}

async function readActiveMarker(path: string): Promise<ActiveMarker> {
  const before = await lstat(path);
  assertSecureHistoryFile(before, path);
  if (before.size > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    assertSecureHistoryFile(opened, path);
    assertSameIdentity(before, opened, path);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
    const after = await handle.stat();
    assertSameIdentity(opened, after, path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`History active marker ${path} is not valid JSON.`);
    }
    if (
      !isRecord(value)
      || Object.keys(value).sort().join(",") !== "conversationKey,pid,token,version"
      || value.version !== 1
      || typeof value.conversationKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.conversationKey)
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.token !== "string"
      || !/^[a-f0-9]{32}$/u.test(value.token)
    ) {
      throw new Error(`History active marker ${path} has an unsupported schema.`);
    }
    return {
      path,
      conversationKey: value.conversationKey,
      pid: value.pid as number,
      token: value.token,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readDirtyFence(path: string): Promise<DirtyFence> {
  const before = await lstat(path);
  assertSecureHistoryFile(before, path);
  if (before.size > MAX_DIRTY_FENCE_BYTES) throw new Error(`History dirty fence ${path} is too large.`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    assertSecureHistoryFile(opened, path);
    assertSameIdentity(before, opened, path);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_DIRTY_FENCE_BYTES) throw new Error(`History dirty fence ${path} is too large.`);
    const after = await handle.stat();
    assertSameIdentity(opened, after, path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`History dirty fence ${path} is not valid JSON.`);
    }
    if (isRecord(value) && value.version === 5) {
      validateDurableTurnFence(value);
      return { path, kind: value.kind, conversationKey: value.conversationKey, logicalConversationKey: value.logicalConversationKey,
        epoch: value.epoch, providerSessionId: value.providerSessionId, modelKey: value.modelKey, revision: value.revision, runIdDigest: value.runIdDigest,
        ...(value.payload === undefined ? {} : { payload: value.payload }) };
    }
    const keys = isRecord(value) ? Object.keys(value).sort().join(",") : "";
    const legacy = isRecord(value)
      && value.version === 1
      && keys === "conversationKey,epoch,revision,runIdDigest,version";
    const current = isRecord(value)
      && value.version === 2
      && keys === "conversationKey,epoch,providerSessionId,revision,runIdDigest,version"
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    const logical = isRecord(value)
      && value.version === 3
      && keys === "conversationKey,epoch,logicalConversationKey,providerSessionId,revision,runIdDigest,version"
      && typeof value.logicalConversationKey === "string"
      && /^[a-f0-9]{64}$/u.test(value.logicalConversationKey)
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    const bound = isRecord(value)
      && value.version === 4
      && keys === "conversationKey,epoch,logicalConversationKey,modelKey,providerSessionId,revision,runIdDigest,version"
      && typeof value.logicalConversationKey === "string"
      && /^[a-f0-9]{64}$/u.test(value.logicalConversationKey)
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    if (bound && isRecord(value)) assertSessionModelKey(value.modelKey);
    if (
      !isRecord(value)
      || (!legacy && !current && !logical && !bound)
      || typeof value.conversationKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.conversationKey)
      || typeof value.epoch !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.epoch)
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 0
      || typeof value.runIdDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.runIdDigest)
    ) {
      throw new Error(`History dirty fence ${path} has an unsupported schema.`);
    }
    return {
      path,
      ...(bound ? { modelKey: value.modelKey as string } : {}),
      conversationKey: value.conversationKey,
      ...(logical || bound ? { logicalConversationKey: value.logicalConversationKey as string } : {}),
      epoch: value.epoch,
      ...(current || logical || bound ? { providerSessionId: value.providerSessionId as string } : {}),
      revision: value.revision as number,
      runIdDigest: value.runIdDigest,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createAndVerifyRoot(root: string): Promise<DirectoryIdentity> {
  await createDirectoryPathWithoutSymlinks(root);
  const info = await lstat(root);
  assertSecureHistoryDirectory(info, root);
  return { dev: info.dev, ino: info.ino };
}

async function createAndVerifyLocksRoot(root: string): Promise<DirectoryIdentity> {
  const identity = await createAndVerifyRoot(root);
  for (let shard = 0; shard < CONVERSATION_LOCK_SHARDS; shard += 1) {
    const name = `conversation-shard-${shard.toString(16).padStart(2, "0")}.sqlite`;
    await ensureOwnerOnlyLockFile(join(root, name), identity, false);
  }
  for (let shard = 0; shard < LOGICAL_SESSION_LOCK_SHARDS; shard += 1) {
    const name = `logical-session-shard-${shard.toString(16).padStart(2, "0")}.sqlite`;
    await ensureOwnerOnlyLockFile(
      join(root, name),
      identity,
      false,
      MAX_SESSION_CLAIM_FILE_BYTES,
    );
  }
  // One directory sync publishes the complete fixed table atomically enough
  // for every initializer, including a process that observed files another
  // concurrent initializer had created but not yet synced.
  await fsyncDirectory(root, identity);
  return identity;
}

async function createDirectoryPathWithoutSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    let created = false;
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      if (created) {
        await chmod(current, 0o700);
        await fsyncParentDirectory(current);
      }
      info = await lstat(current);
    }
    // macOS exposes root-owned compatibility links such as /var -> /private/var.
    // Those are outside the caller's control; user-owned links anywhere in the
    // configured path remain fail-closed.
    if (info.isSymbolicLink()) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== 0 || uid === 0) {
        throw new Error(`History path component ${current} must not be a user-controlled symbolic link.`);
      }
      continue;
    }
    if (!info.isDirectory()) throw new Error(`History path component ${current} must be a directory.`);
  }
}

function assertSecureHistoryDirectory(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`History root ${path} must be a non-symlink directory.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error(`History root ${path} must have owner-only mode 0700.`);
  }
}

function assertSecureHistoryFile(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`History path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (info.nlink !== 1) throw new Error(`History file ${path} must have exactly one hard link.`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`History file ${path} must have owner-only mode 0600.`);
  }
}

function assertSecureTransientHistoryFile(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`History path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  // A concurrent SQLite DELETE-journal commit may unlink the path immediately
  // after lstat; APFS can report that transient inode with zero remaining
  // links. Multiple links are never legitimate and remain fail-closed.
  if (info.nlink > 1) throw new Error(`History file ${path} must not have multiple hard links.`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`History file ${path} must have owner-only mode 0600.`);
  }
}

function assertOwnedByCurrentUser(info: Stats, path: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`History path ${path} must be owned by the current user.`);
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureHistoryDirectory(info, path);
  if (info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error(`History root ${path} changed while it was in use.`);
  }
}

function assertSameIdentity(before: Stats, after: Stats, path: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new ConcurrentHistoryMutationError(`History file ${path} changed while it was being read.`);
  }
}

class ConcurrentHistoryMutationError extends Error {}

async function fsyncDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
    const info = await handle.stat();
    assertSecureHistoryDirectory(info, path);
    if (info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new Error(`History root ${path} changed while it was in use.`);
    }
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fsyncParentDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  let handle;
  try {
    handle = await open(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function modelBinding(modelKey: string | undefined): { readonly modelKey?: string } {
  return modelKey === undefined ? {} : { modelKey };
}

function requireSettledFence(fence: DirtyFence | undefined): void {
  if (fence?.kind === "execution" || fence?.kind === "compaction") {
    throw new Error("Pending provider turn requires explicit owner-held reconciliation");
  }
}

function managedNativeJournalId(handleId: string): string { return createHash("sha256").update(`mono-host-journal-v1\0${handleId}`).digest("hex"); }

function switchCanonicalRecord(existing: LoadedHistoryRecord, state: ModelSwitchState, authority: RuntimeNativeJournalAuthority,
  chain: readonly CanonicalJournalDescriptor[]): TurnHistoryV4 {
  return { version: 4, conversationId: state.identity.historyBucket, messages: existing.messages,
    providerSession: { epoch: state.identity.targetEpoch, revision: 0, modelKey: state.identity.toModelKey },
    native: { authority, chain, projection: state.artifact }, ...lastCommitBinding(existing),
    lastSwitch: { version: 1, switchId: state.identity.switchId, intentDigest: switchDigest(state.identity), fromEpoch: state.identity.sources.at(-1)!.epoch,
      toEpoch: state.identity.targetEpoch, artifact: state.artifact } };
}
