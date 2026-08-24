import { createHash, randomBytes, randomUUID } from "node:crypto";
import { relative } from "node:path";

import {
  MemoryOperatorError,
  type MemoryOperatorActionHistoryItem,
  type MemoryOperatorActionInput,
  type MemoryOperatorCapability,
  type MemoryOperatorEditInput,
  type MemoryOperatorGraph,
  type MemoryOperatorGraphEdge,
  type MemoryOperatorGraphNode,
  type MemoryOperatorGraphQuery,
  type MemoryOperatorLifecycle,
  type MemoryOperatorMutationAdmission,
  type MemoryOperatorOperation,
  type MemoryOperatorOverview,
  type MemoryOperatorRecord,
  type MemoryOperatorRecordDetail,
  type MemoryOperatorRecordPage,
  type MemoryOperatorRecordQuery,
  type MemoryOperatorSemanticPatch,
  type MemoryOperatorService,
} from "@mono-agent/agent-contracts";
import type {
  EntityRecord,
  MemoryDb,
  MemoryEntityAssociation,
  MemoryRecord,
  MemoryStatus,
} from "../store/index.js";

import {
  replayCaptureIntent,
  writeCaptureIntent,
  type CaptureIntentAction,
  type CanonicalBulletState,
} from "./capture-outbox.js";
import { dailyFilePath, readBullet } from "./daily.js";
import { assertCanonicalGraphRepairBaseParity } from "./rebuild.js";
import {
  CANONICAL_FILE_MISSING,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
import { readReplayProjectionStrict } from "./replay-projection.js";
import type { BujoMemoryStore } from "./store.js";
import type { Bullet, BujoTier } from "./types.js";

const LEDGER_FILE = ".memory-operator-v1.json";
const LEGACY_LEDGER_SCHEMA_VERSION = 1;
const LEDGER_SCHEMA_VERSION = 2;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_OPERATIONS = 1_024;
const MAX_TERMINAL_OPERATIONS = 512;
const MAX_EXPIRED_REPLAYS = MAX_OPERATIONS;
const TERMINAL_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CONFIRMATIONS = 128;
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;
const DEFAULT_RECORD_LIMIT = 50;
const MAX_RECORD_LIMIT = 100;
const DEFAULT_GRAPH_LIMIT = 100;
const MAX_GRAPH_LIMIT = 200;
const MAX_TEXT_CODE_POINTS = 4_000;
const MAX_TAGS = 32;
const MAX_TAG_CODE_POINTS = 64;
const MAX_COLLECTION_CODE_POINTS = 128;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const COLLECTION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INVALID_SEMANTIC_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const PERSISTED_FAILURE_CODES = new Set([
  "invalid_request",
  "not_found",
  "actions_disabled",
  "revision_conflict",
  "confirmation_invalid",
  "idempotency_conflict",
  "replay_expired",
  "unavailable",
]);

type OperatorAction = "edit" | "forget" | "restore";

export interface MemoryOperatorMutationGate {
  runExclusive<T>(mutation: () => Promise<T>): Promise<T>;
}

export interface MemoryOperatorIntegrityFailure {
  readonly code: "unavailable";
  readonly reason: "ledger_startup" | "ledger_publication" | "pump";
  readonly message: string;
}

export interface BujoMemoryOperatorHooks {
  /** Fault-injection seam immediately before the ledger compare-and-swap. */
  readonly beforeLedgerPublication?: () => void;
  /** Fault-injection seam after the ledger fsync and before its exact read-back. */
  readonly afterLedgerPublication?: () => void;
  /** Fault-injection seam after the applying state is durable and before semantic publication. */
  readonly afterApplyingDurable?: (operation: MemoryOperatorOperation) => void | Promise<void>;
  /** Fault-injection seam after semantic commit and before the terminal receipt is durable. */
  readonly afterMutationCommitted?: (operation: MemoryOperatorOperation) => void | Promise<void>;
  /** Fault-injection seam after the semantic outbox intent is durable. */
  readonly afterIntentDurable?: (operationId: string) => void;
}

export interface BujoMemoryOperatorServiceOptions {
  readonly actionsEnabled: boolean;
  readonly gate?: MemoryOperatorMutationGate;
  readonly clock?: () => Date;
  readonly confirmationTtlMs?: number;
  readonly logger?: { warn(message: string): void };
  /** Path-free fail-closed notification, delivered at most once per service lifetime. */
  readonly onIntegrityFailure?: (failure: MemoryOperatorIntegrityFailure) => void;
  readonly hooks?: BujoMemoryOperatorHooks;
}

export interface BuiltinMemoryOperatorService extends MemoryOperatorService {
  /** Wait for durable action recovery, queued mutations, and store-owned writes. */
  drain(): Promise<void>;
  /** Seal admission, await an entered mutation, and durably leave gate-queued work for restart. */
  close(): Promise<void>;
}

/** @internal Same-store access; callers use createBujoMemoryOperatorService. */
export interface BujoMemoryOperatorEngine {
  readonly root: string;
  readonly tier: BujoTier;
  readonly db: MemoryDb;
  readonly clock: () => Date;
  readonly nextId: () => string;
  readonly runMutation: <T>(run: (abortSignal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly flush: () => Promise<void>;
}

interface StoredOperation extends MemoryOperatorOperation {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: string;
  readonly patch?: MemoryOperatorSemanticPatch;
  readonly appliedAt?: string;
  readonly completedAt?: string;
}

interface OperatorLedger {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly operations: readonly StoredOperation[];
  readonly expiredReplays: readonly ExpiredReplay[];
}

interface ExpiredReplay {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expiresAt: string;
}

interface LedgerState {
  readonly operations: readonly StoredOperation[];
  readonly expiredReplays: readonly ExpiredReplay[];
}

interface ConfirmationEntry {
  readonly token: string;
  readonly requestHash: string;
  readonly expiresAtMs: number;
}

interface NormalizedActionRequest {
  readonly action: OperatorAction;
  readonly recordId: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly patch?: MemoryOperatorSemanticPatch;
  readonly requestHash: string;
  readonly confirmationToken?: string;
}

interface GraphSnapshot {
  readonly memories: readonly MemoryRecord[];
  readonly entities: readonly EntityRecord[];
  readonly relations: ReturnType<MemoryDb["listEntityRelations"]>;
  readonly associations: ReturnType<MemoryDb["listMemoryAssociations"]>;
  readonly edges: ReturnType<MemoryDb["listEdges"]>;
  readonly sourceTruncated: boolean;
}

export function createBujoMemoryOperatorService(
  store: BujoMemoryStore,
  options: BujoMemoryOperatorServiceOptions,
): BuiltinMemoryOperatorService {
  return new BujoMemoryOperatorService(store.operatorEngine(), options);
}

export class BujoMemoryOperatorService implements BuiltinMemoryOperatorService {
  private readonly engine: BujoMemoryOperatorEngine;
  private readonly actionsConfigured: boolean;
  private readonly gate: MemoryOperatorMutationGate;
  private readonly clock: () => Date;
  private readonly confirmationTtlMs: number;
  private readonly logger: { warn(message: string): void };
  private readonly onIntegrityFailure: ((failure: MemoryOperatorIntegrityFailure) => void) | undefined;
  private readonly hooks: BujoMemoryOperatorHooks | undefined;
  private readonly confirmations = new Map<string, ConfirmationEntry>();
  private operations: StoredOperation[] = [];
  private expiredReplays: ExpiredReplay[] = [];
  private ledgerIdentity: ReturnType<typeof readCanonicalFileSnapshot> extends infer Snapshot
    ? Snapshot extends { identity: infer Identity } ? Identity | undefined : never
    : never;
  private ledgerUnavailable = false;
  private ledgerSaturated = false;
  private accepting = true;
  private pumpPromise: Promise<void> | undefined;
  private pumpFailure: unknown;
  private pumpCapacityBlocked = false;
  private activeMutation: Promise<void> | undefined;
  private integrityFailureNotified = false;

  constructor(engine: BujoMemoryOperatorEngine, options: BujoMemoryOperatorServiceOptions) {
    if (!Number.isInteger(options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS)
      || (options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS) <= 0) {
      throw new MemoryOperatorError("invalid_request", "Memory confirmation TTL must be a positive integer.");
    }
    this.engine = engine;
    this.actionsConfigured = options.actionsEnabled;
    this.gate = options.gate ?? { runExclusive: async <T>(run: () => Promise<T>) => await run() };
    this.clock = options.clock ?? engine.clock;
    this.confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.logger = options.logger ?? { warn: () => {} };
    this.onIntegrityFailure = options.onIntegrityFailure;
    this.hooks = options.hooks;
    try {
      this.loadLedger();
      this.schedulePump();
    } catch {
      this.ledgerUnavailable = true;
      this.notifyIntegrityFailure("ledger_startup");
    }
  }

  capability(): MemoryOperatorCapability {
    const integrityDegraded = this.ledgerUnavailable || this.pumpFailure !== undefined;
    const degraded = integrityDegraded || this.ledgerSaturated;
    const actions = this.actionsAvailable();
    return {
      schema: 1,
      backend: "builtin",
      tier: this.engine.tier,
      status: degraded ? "degraded" : "ready",
      read: !integrityDegraded,
      actions,
      graph: !integrityDegraded && this.engine.tier === "bujo" ? "captured" : "unavailable",
      ...(integrityDegraded
        ? { reason: "Memory action state requires recovery." }
        : this.ledgerSaturated
          ? { reason: "Memory action capacity is temporarily saturated." }
        : !this.actionsConfigured
        ? { reason: "Memory actions are disabled by configuration." }
        : this.engine.tier !== "bujo"
          ? { reason: "Memory actions require the active BuJo tier." }
          : {}),
    };
  }

  async overview(): Promise<MemoryOperatorOverview> {
    await this.awaitAuthoritativeReads();
    return this.engine.db.withAuditSnapshot(() => {
      const stats = this.engine.db.stats({ topEntitiesLimit: 0 });
      const audit = this.engine.db.audit();
      const superseded = stats.countsByStatus.invalidated;
      const forgotten = stats.countsByStatus.dropped;
      const active = Math.max(0, stats.totalMemories - superseded - forgotten);
      const metadata = this.engine.db.indexMetadata();
      return {
        generatedAt: this.clock().toISOString(),
        capability: this.capability(),
        counts: {
          total: stats.totalMemories,
          active,
          superseded,
          forgotten,
          byType: { ...stats.countsByType },
        },
        access: {
          totalCount: audit.access.totalCount,
          accessedRecords: audit.access.accessedMemories,
        },
        ...(metadata?.embeddingModel === undefined && metadata?.dimension === undefined
          ? {}
          : {
              embedding: {
                ...(metadata.embeddingModel === undefined ? {} : { model: metadata.embeddingModel }),
                ...(metadata.dimension === undefined ? {} : { dimension: metadata.dimension }),
              },
            }),
      };
    });
  }

  async records(query: MemoryOperatorRecordQuery): Promise<MemoryOperatorRecordPage> {
    await this.awaitAuthoritativeReads();
    const normalized = normalizeRecordQuery(query);
    const filterHash = recordFilterHash(normalized);
    const before = normalized.before === undefined ? undefined : decodeCursor(normalized.before, filterHash);
    const rows = this.engine.db.listMemories({
      limit: normalized.limit + 1,
      ...(before === undefined ? {} : { before }),
      ...(normalized.lifecycle === undefined ? {} : { statuses: statusesForLifecycle(normalized.lifecycle) }),
      ...(normalized.type === undefined ? {} : { type: normalized.type }),
      ...(normalized.collection === undefined ? {} : { collection: normalized.collection }),
      ...(normalized.query === undefined ? {} : { query: normalized.query }),
    });
    const hasMore = rows.length > normalized.limit;
    const page = rows.slice(0, normalized.limit);
    const last = page.at(-1);
    return {
      records: page.map(operatorRecord),
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeCursor(last.createdAt, last.id, filterHash) }
        : {}),
    };
  }

  async record(id: string): Promise<MemoryOperatorRecordDetail> {
    await this.awaitAuthoritativeReads();
    const record = this.requireRecord(id);
    return {
      record: operatorRecord(record),
      history: this.actionHistory(id),
    };
  }

  async graph(query: MemoryOperatorGraphQuery): Promise<MemoryOperatorGraph> {
    await this.awaitAuthoritativeReads();
    assertExactObjectKeys(query, ["focusId", "includeHistory", "limit"], "Memory graph query");
    if (this.engine.tier !== "bujo") return { fidelity: "unavailable", nodes: [], edges: [] };
    const limit = normalizeLimit(query.limit, DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT, "graph limit");
    const focusId = normalizeOptionalId(query.focusId, "graph focusId");
    if (query.includeHistory !== undefined && typeof query.includeHistory !== "boolean") {
      throw new MemoryOperatorError("invalid_request", "Memory graph includeHistory must be boolean.");
    }
    const includeHistory = query.includeHistory === true;
    const snapshot = this.graphSnapshot(limit, focusId, includeHistory);
    return projectGraph(snapshot, limit, focusId, includeHistory);
  }

  edit(id: string, input: MemoryOperatorEditInput): MemoryOperatorMutationAdmission {
    assertExactObjectKeys(
      input,
      ["expectedRevision", "idempotencyKey", "confirmationToken", "patch"],
      "Memory edit input",
    );
    return this.admit("edit", id, input, normalizePatch(input.patch));
  }

  forget(id: string, input: MemoryOperatorActionInput): MemoryOperatorMutationAdmission {
    assertExactObjectKeys(
      input,
      ["expectedRevision", "idempotencyKey", "confirmationToken"],
      "Memory forget input",
    );
    return this.admit("forget", id, input);
  }

  restore(id: string, input: MemoryOperatorActionInput): MemoryOperatorMutationAdmission {
    assertExactObjectKeys(
      input,
      ["expectedRevision", "idempotencyKey", "confirmationToken"],
      "Memory restore input",
    );
    return this.admit("restore", id, input);
  }

  operation(id: string): MemoryOperatorOperation {
    this.assertOperatorStateHealthy();
    const normalizedId = normalizeId(id, "operation id");
    const operation = this.operations.find((candidate) => candidate.id === normalizedId);
    if (operation === undefined) {
      const expired = this.expiredReplays.find((candidate) => candidate.operationId === normalizedId
        && Date.parse(candidate.expiresAt) > this.clock().getTime());
      if (expired !== undefined) {
        throw new MemoryOperatorError("replay_expired", "Memory operation replay history has expired.");
      }
      throw new MemoryOperatorError("not_found", "Memory operation was not found.");
    }
    return publicOperation(operation);
  }

  async drain(): Promise<void> {
    this.schedulePump();
    while (this.pumpPromise !== undefined) await this.pumpPromise;
    if (this.pumpCapacityBlocked) {
      throw new MemoryOperatorError(
        "unavailable",
        "Memory action capacity is temporarily saturated.",
        { reason: "capacity" },
      );
    }
    if (this.pumpFailure !== undefined) {
      throw new MemoryOperatorError("unavailable", "Memory action recovery did not complete.");
    }
    await this.engine.flush();
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.confirmations.clear();
    // Do not wait for a queued gate reservation: app lifecycle may itself own
    // the outer gate. Queued/draining work remains durable for next startup.
    // A mutation that already crossed the gate is awaited and flushed.
    await this.activeMutation;
    await this.engine.flush();
  }

  private admit(
    action: OperatorAction,
    rawId: string,
    input: MemoryOperatorActionInput,
    patch?: MemoryOperatorSemanticPatch,
  ): MemoryOperatorMutationAdmission {
    const recordId = normalizeId(rawId, "record id");
    const expectedRevision = normalizeRevision(input.expectedRevision);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestHash = actionRequestHash({
      action,
      recordId,
      expectedRevision,
      idempotencyKey,
      ...(patch === undefined ? {} : { patch }),
    });
    this.assertOperatorStateHealthy();
    const existing = this.operations.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new MemoryOperatorError(
          "idempotency_conflict",
          "The memory idempotency key is already bound to a different action.",
        );
      }
      return { kind: "queued", operation: publicOperation(existing) };
    }
    const replay = this.expiredReplays.find((candidate) => candidate.idempotencyKey === idempotencyKey
      && Date.parse(candidate.expiresAt) > this.clock().getTime());
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        throw new MemoryOperatorError(
          "idempotency_conflict",
          "The memory idempotency key is already bound to a different action.",
        );
      }
      throw new MemoryOperatorError("replay_expired", "Memory action replay history has expired.");
    }
    this.assertActionsAvailable();
    if (!this.accepting) throw new MemoryOperatorError("unavailable", "Memory actions are shutting down.");
    const current = this.requireRecord(recordId);
    assertActionLifecycle(action, current);
    assertRevision(current, expectedRevision);
    const normalized: NormalizedActionRequest = {
      action,
      recordId,
      expectedRevision,
      idempotencyKey,
      ...(patch === undefined ? {} : { patch }),
      requestHash,
      ...(input.confirmationToken === undefined ? {} : { confirmationToken: input.confirmationToken }),
    };
    if (action === "forget") {
      if (normalized.confirmationToken === undefined) return this.confirmation(normalized);
      this.consumeConfirmation(normalized);
    }
    const now = this.clock().toISOString();
    const resultRecordId = action === "edit" || action === "restore" ? this.engine.nextId() : undefined;
    const operation: StoredOperation = {
      id: randomUUID(),
      action,
      recordId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      ...(resultRecordId === undefined ? {} : { resultRecordId }),
      idempotencyKey,
      requestHash,
      expectedRevision,
      ...(patch === undefined ? {} : { patch }),
    };
    try {
      const next = compactLedgerState(
        [...this.operations, operation],
        this.expiredReplays,
        Date.parse(now),
      );
      this.publishLedger(next);
    } catch (error) {
      if (error instanceof OperatorLedgerCapacityError) {
        this.ledgerSaturated = isNonPrunableSaturation(this.operations, this.expiredReplays);
        throw new MemoryOperatorError("unavailable", "Memory action history capacity is exhausted.");
      }
      throw error;
    }
    this.schedulePump();
    return { kind: "queued", operation: publicOperation(operation) };
  }

  private confirmation(request: NormalizedActionRequest): MemoryOperatorMutationAdmission {
    this.pruneConfirmations();
    if (this.confirmations.size >= MAX_CONFIRMATIONS) {
      throw new MemoryOperatorError("unavailable", "Memory confirmation capacity is exhausted.");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.clock().getTime() + this.confirmationTtlMs;
    this.confirmations.set(token, { token, requestHash: request.requestHash, expiresAtMs });
    return {
      kind: "confirmation_required",
      confirmation: {
        token,
        expiresAt: new Date(expiresAtMs).toISOString(),
        message: `${capitalize(request.action)} memory ${request.recordId}?`,
      },
    };
  }

  private consumeConfirmation(request: NormalizedActionRequest): void {
    this.pruneConfirmations();
    const confirmation = this.confirmations.get(request.confirmationToken!);
    this.confirmations.delete(request.confirmationToken!);
    if (confirmation === undefined || confirmation.requestHash !== request.requestHash
      || confirmation.expiresAtMs <= this.clock().getTime()) {
      throw new MemoryOperatorError("confirmation_invalid", "Memory action confirmation is invalid or expired.");
    }
  }

  private pruneConfirmations(): void {
    const now = this.clock().getTime();
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.expiresAtMs <= now) this.confirmations.delete(token);
    }
  }

  private schedulePump(): void {
    if (!this.accepting || this.ledgerUnavailable || this.pumpPromise !== undefined
      || this.pumpFailure !== undefined || this.pumpCapacityBlocked || this.engine.tier !== "bujo") return;
    if (!this.operations.some(isPendingOperation)) return;
    // Start synchronously through the first gate call so its shared app-tail
    // reservation exists before admission returns a queued receipt.
    this.pumpPromise = this.runPump()
      .catch((error: unknown) => {
        if (error instanceof OperatorLedgerCapacityStop) {
          this.pumpCapacityBlocked = true;
          this.ledgerSaturated = true;
          this.safeWarn("memory operator recovery is paused at its durable capacity bound.");
          return;
        }
        this.pumpFailure = error;
        this.notifyIntegrityFailure("pump");
        this.safeWarn("memory operator recovery remains pending; restart the writable memory store to retry.");
      })
      .finally(() => {
        this.pumpPromise = undefined;
        if (this.pumpFailure === undefined && !this.pumpCapacityBlocked
          && this.operations.some(isPendingOperation)) this.schedulePump();
      });
  }

  private async runPump(): Promise<void> {
    // Durable admissions remain authoritative across configuration changes,
    // but only an actual BuJo store may advance or apply them. A later BuJo
    // startup will resume the unchanged pending receipt even if new actions
    // are disabled there.
    if (this.engine.tier !== "bujo") return;
    for (;;) {
      if (!this.accepting || this.engine.tier !== "bujo") return;
      const operation = this.operations.find(isPendingOperation);
      if (operation === undefined) return;
      if (operation.status === "queued") this.updateOperation(operation.id, { status: "draining" });
      try {
        let committed = false;
        await this.gate.runExclusive(async () => {
          if (!this.accepting || this.engine.tier !== "bujo") return;
          let current = this.requireStoredOperation(operation.id);
          if (current.status === "draining") {
            const appliedAt = current.appliedAt ?? this.clock().toISOString();
            current = this.updateOperation(current.id, { status: "applying", appliedAt });
            await this.hooks?.afterApplyingDurable?.(publicOperation(current));
          }
          const mutation = (async (): Promise<void> => {
            await this.engine.runMutation(async (abortSignal) => {
              await this.applyOperation(current, abortSignal);
            });
            await this.engine.flush();
            await this.hooks?.afterMutationCommitted?.(publicOperation(current));
            committed = true;
          })();
          this.activeMutation = mutation;
          try {
            await mutation;
          } finally {
            if (this.activeMutation === mutation) this.activeMutation = undefined;
          }
        });
        if (!committed) return;
        const completedAt = this.clock().toISOString();
        this.finishOperation(operation.id, {
          status: "succeeded",
          completedAt,
        });
      } catch (error) {
        if (error instanceof MemoryOperatorError && error.code !== "unavailable") {
          const completedAt = this.clock().toISOString();
          this.finishOperation(operation.id, {
            status: "failed",
            completedAt,
            errorCode: error.code,
            errorMessage: sanitizedErrorMessage(error.code),
          });
          continue;
        }
        // Unknown failures may have happened after the semantic outbox became
        // durable. Keep `applying` intact so startup recovery can prove/replay
        // the exact outcome instead of publishing a false terminal failure.
        throw error;
      }
    }
  }

  private async applyOperation(operation: StoredOperation, abortSignal: AbortSignal): Promise<void> {
    abortSignal.throwIfAborted();
    if (this.engine.tier !== "bujo") {
      throw new MemoryOperatorError("unavailable", "Memory action recovery requires the active BuJo tier.");
    }
    if (this.operationOutcomeExists(operation)) return;
    const current = this.requireRecord(operation.recordId);
    assertRevision(current, operation.expectedRevision);
    assertActionLifecycle(operation.action, current);
    if (operation.appliedAt === undefined) {
      throw new MemoryOperatorError("unavailable", "Memory action lost its durable apply timestamp.");
    }
    if (operation.action === "edit") {
      await this.applyEdit(operation, current, abortSignal);
    } else if (operation.action === "forget") {
      this.applyForget(operation, current);
    } else {
      await this.applyRestore(operation, current, abortSignal);
    }
    if (!this.operationOutcomeExists(operation)) {
      throw new MemoryOperatorError("unavailable", "Memory action did not reach its committed outcome.");
    }
  }

  private async applyEdit(
    operation: StoredOperation,
    current: MemoryRecord,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const resultId = requireResultId(operation);
    const before = canonicalState(this.engine.root, current);
    const patch = operation.patch ?? {};
    const createdAt = operation.appliedAt!;
    const semantic = applySemanticPatch(current, patch);
    const afterNew = bulletForRecord({
      ...semantic,
      id: resultId,
      createdAt,
      accessCount: 0,
      source: {
        ...(current.source.session === undefined ? {} : { session: current.source.session }),
        file: relative(this.engine.root, dailyFilePath(this.engine.root, new Date(createdAt))),
      },
    }, before.bullet.refs);
    const replacement = recordForBullet(afterNew, this.engine.root);
    const [vector] = await this.engine.db.prepareUpsertVectors([replacement]);
    abortSignal.throwIfAborted();
    const graph = graphForReplacement(this.engine.db, current.id, resultId, createdAt);
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "supersede",
      oldId: current.id,
      newId: resultId,
      beforeOld: before,
      afterOld: { ...before, bullet: { ...before.bullet, status: "invalidated" } },
      afterNew: {
        file: replacement.source.file!,
        bullet: afterNew,
      },
      record: replacement,
      ...(vector === undefined ? {} : { vector }),
      at: createdAt,
    };
    const handle = writeCaptureIntent(
      this.engine.root,
      [action],
      graph,
      createdAt,
      { authorityKind: "operator" },
    );
    this.hooks?.afterIntentDurable?.(operation.id);
    replayCaptureIntent(this.engine.root, handle, this.engine.db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
  }

  private applyForget(operation: StoredOperation, current: MemoryRecord): void {
    const before = canonicalState(this.engine.root, current);
    if (current.status === "dropped" || current.status === "invalidated") {
      throw new MemoryOperatorError("revision_conflict", "Memory record is no longer active.");
    }
    const priorStatus = current.status;
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "forget",
      id: current.id,
      before,
      after: {
        ...before,
        bullet: {
          ...before.bullet,
          status: "dropped",
          priorStatus,
        },
      },
      at: operation.appliedAt!,
    };
    const handle = writeCaptureIntent(
      this.engine.root,
      [action],
      {},
      operation.appliedAt!,
      { authorityKind: "operator" },
    );
    this.hooks?.afterIntentDurable?.(operation.id);
    replayCaptureIntent(this.engine.root, handle, this.engine.db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
  }

  private async applyRestore(
    operation: StoredOperation,
    current: MemoryRecord,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const resultId = requireResultId(operation);
    const prior = canonicalState(this.engine.root, current).bullet;
    const terminal = readReplayProjectionStrict(this.engine.root).projection.terminals
      .find((candidate) => candidate.id === current.id);
    if (prior.priorStatus === undefined || current.validTo === undefined
      || terminal?.authorityKind !== "operator" || terminal.at !== current.validTo) {
      throw new MemoryOperatorError("invalid_request", "Only operator-forgotten memory records can be restored.");
    }
    const createdAt = operation.appliedAt!;
    const { priorStatus, ...priorWithoutForgetMarker } = prior;
    const restored: Bullet = {
      ...priorWithoutForgetMarker,
      id: resultId,
      status: priorStatus,
      createdAt,
    };
    const record = recordForBullet(restored, this.engine.root);
    const [vector] = await this.engine.db.prepareUpsertVectors([record]);
    abortSignal.throwIfAborted();
    const graph = graphForReplacement(this.engine.db, current.id, resultId, createdAt);
    const action: CaptureIntentAction = {
      candidateIndex: 0,
      kind: "add",
      id: resultId,
      after: { file: record.source.file!, bullet: restored },
      record,
      ...(vector === undefined ? {} : { vector }),
      threads: [],
    };
    const handle = writeCaptureIntent(
      this.engine.root,
      [action],
      graph,
      createdAt,
      { authorityKind: "operator" },
    );
    this.hooks?.afterIntentDurable?.(operation.id);
    replayCaptureIntent(this.engine.root, handle, this.engine.db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
  }

  private operationOutcomeExists(operation: StoredOperation): boolean {
    const current = this.engine.db.get(operation.recordId);
    if (current === undefined || operation.appliedAt === undefined) return false;
    if (operation.action === "forget") {
      return current.status === "dropped" && current.validTo === operation.appliedAt
        && current.supersededBy === undefined;
    }
    const resultId = operation.resultRecordId;
    if (resultId === undefined) return false;
    const result = this.engine.db.get(resultId);
    if (result === undefined) return false;
    if (operation.action === "edit") {
      return current.status === "invalidated" && current.supersededBy === resultId
        && current.validTo === operation.appliedAt;
    }
    return current.status === "dropped" && result.status !== "dropped" && result.status !== "invalidated";
  }

  private graphSnapshot(limit: number, focusId: string | undefined, includeHistory: boolean): GraphSnapshot {
    return this.engine.db.withAuditSnapshot(() => {
      const fetchLimit = limit + 1;
      const statuses = includeHistory ? undefined : activeStatuses();
      let memories = focusId === undefined
        ? this.engine.db.listMemories({ limit: fetchLimit, ...(statuses === undefined ? {} : { statuses }) })
        : [this.engine.db.get(focusId)].filter((value): value is MemoryRecord => value !== undefined);
      const relations = this.engine.db.listEntityRelations(fetchLimit, focusId);
      const associations = this.engine.db.listMemoryAssociations(fetchLimit, focusId);
      const edges = this.engine.db.listEdges(fetchLimit, focusId)
        .filter((edge) => edge.kind === "supports" || edge.kind === "supersedes");
      const memoryIds = new Set(memories.map((memory) => memory.id));
      for (const id of [
        ...associations.map((association) => association.memoryId),
        ...edges.flatMap((edge) => [edge.src, edge.dst]),
      ]) {
        if (memoryIds.has(id)) continue;
        const memory = this.engine.db.get(id);
        if (memory === undefined || (!includeHistory && lifecycleOf(memory) !== "active")) continue;
        memories = [...memories, memory];
        memoryIds.add(id);
        if (memories.length >= fetchLimit) break;
      }
      const entityIds = new Set<string>([
        ...relations.flatMap((relation) => [relation.src, relation.dst]),
        ...associations.map((association) => association.entityId),
        ...edges.flatMap((edge) => [edge.src, edge.dst]).filter((id) => !memoryIds.has(id)),
      ]);
      if (focusId !== undefined && this.engine.db.getEntity(focusId) !== undefined) entityIds.add(focusId);
      let entities = [...entityIds]
        .slice(0, fetchLimit)
        .flatMap((id) => {
          const entity = this.engine.db.getEntity(id);
          return entity === undefined ? [] : [entity];
        });
      if (focusId === undefined && entities.length < fetchLimit) {
        const known = new Set(entities.map((entity) => entity.id));
        entities = [
          ...entities,
          ...this.engine.db.listEntities(fetchLimit - entities.length).filter((entity) => !known.has(entity.id)),
        ];
      }
      return {
        memories,
        entities,
        relations,
        associations,
        edges,
        sourceTruncated: memories.length > limit || entities.length > limit
          || relations.length > limit || associations.length > limit || edges.length > limit,
      };
    });
  }

  private actionHistory(id: string): MemoryOperatorActionHistoryItem[] {
    return this.operations.flatMap((operation) => {
      if ((operation.status !== "succeeded" && operation.status !== "failed")
        || (operation.recordId !== id && operation.resultRecordId !== id)
        || operation.completedAt === undefined) return [];
      return [{
        id: operation.id,
        action: operation.action,
        status: operation.status,
        recordId: operation.recordId,
        ...(operation.resultRecordId === undefined ? {} : { resultRecordId: operation.resultRecordId }),
        createdAt: operation.createdAt,
        completedAt: operation.completedAt,
        ...(operation.errorCode === undefined ? {} : { errorCode: operation.errorCode }),
      }];
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  }

  private requireRecord(id: string): MemoryRecord {
    const record = this.engine.db.get(normalizeId(id, "record id"));
    if (record === undefined) throw new MemoryOperatorError("not_found", "Memory record was not found.");
    return record;
  }

  private assertActionsAvailable(): void {
    if (!this.actionsAvailable()) {
      if (this.ledgerUnavailable || this.pumpFailure !== undefined) {
        throw new MemoryOperatorError("unavailable", "Memory action state requires recovery.");
      }
      if (this.ledgerSaturated) {
        throw new MemoryOperatorError("unavailable", "Memory action capacity is temporarily saturated.");
      }
      throw new MemoryOperatorError("actions_disabled", "Memory actions are not enabled for this memory store.");
    }
  }

  private actionsAvailable(): boolean {
    return this.actionsConfigured && this.engine.tier === "bujo"
      && !this.ledgerUnavailable && this.pumpFailure === undefined && !this.ledgerSaturated;
  }

  private assertOperatorStateHealthy(): void {
    if (this.ledgerUnavailable || this.pumpFailure !== undefined) {
      throw new MemoryOperatorError("unavailable", "Memory action state requires recovery.");
    }
  }

  private async awaitAuthoritativeReads(): Promise<void> {
    while (this.pumpPromise !== undefined) await this.pumpPromise;
    if (this.ledgerUnavailable || this.pumpFailure !== undefined) {
      throw new MemoryOperatorError("unavailable", "Memory state recovery did not complete.");
    }
  }

  private updateOperation(id: string, patch: Partial<StoredOperation>): StoredOperation {
    const index = this.operations.findIndex((operation) => operation.id === id);
    if (index < 0) throw new MemoryOperatorError("unavailable", "Memory operation state changed unexpectedly.");
    const prior = this.operations[index]!;
    const updatedAt = this.clock().toISOString();
    const next: StoredOperation = {
      ...prior,
      ...patch,
      updatedAt,
    };
    const operations = [...this.operations];
    if (patch.patch === undefined && Object.prototype.hasOwnProperty.call(patch, "patch")) {
      const { patch: _patch, ...withoutPatch } = next;
      operations[index] = withoutPatch as StoredOperation;
    } else {
      operations[index] = next;
    }
    try {
      this.publishLedger(compactLedgerState(
        operations,
        this.expiredReplays,
        Date.parse(updatedAt),
      ));
    } catch (error) {
      if (error instanceof OperatorLedgerCapacityError) {
        this.ledgerSaturated = true;
        throw new OperatorLedgerCapacityStop();
      }
      throw error;
    }
    return this.requireStoredOperation(id);
  }

  private finishOperation(
    id: string,
    terminal: Pick<StoredOperation, "status" | "completedAt">
      & Partial<Pick<StoredOperation, "errorCode" | "errorMessage">>,
  ): StoredOperation {
    const index = this.operations.findIndex((operation) => operation.id === id);
    if (index < 0) throw new MemoryOperatorError("unavailable", "Memory operation state changed unexpectedly.");
    const prior = this.operations[index]!;
    const { patch: _patch, ...withoutPatch } = prior;
    const next: StoredOperation = {
      ...withoutPatch,
      ...terminal,
      expectedRevision: "",
      updatedAt: this.clock().toISOString(),
    };
    const operations = [...this.operations];
    operations[index] = next;
    try {
      this.publishLedger(compactLedgerState(
        operations,
        this.expiredReplays,
        Date.parse(next.updatedAt),
        id,
      ));
    } catch (error) {
      if (error instanceof OperatorLedgerCapacityError) {
        this.ledgerSaturated = true;
        throw new OperatorLedgerCapacityStop();
      }
      throw error;
    }
    return this.requireStoredOperation(id);
  }

  private requireStoredOperation(id: string): StoredOperation {
    const operation = this.operations.find((candidate) => candidate.id === id);
    if (operation === undefined) throw new MemoryOperatorError("unavailable", "Memory operation disappeared.");
    return operation;
  }

  private loadLedger(): void {
    const snapshot = readCanonicalFileSnapshot(this.engine.root, LEDGER_FILE, {
      allowMissing: true,
      maxBytes: MAX_LEDGER_BYTES,
    });
    if (snapshot === undefined) return;
    if ((snapshot.identity.mode & 0o777) !== 0o600 || snapshot.identity.nlink !== 1
      || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
      throw new Error("unsafe memory operator ledger");
    }
    const ledger = parseLedger(snapshot.content);
    if (this.engine.tier !== "bujo") {
      // A stopped-store tier change must not rewrite, normalize, or apply a
      // previously accepted BuJo operation. Preserve the exact durable state
      // for a future BuJo startup.
      this.operations = [...ledger.operations];
      this.expiredReplays = [...ledger.expiredReplays];
      this.ledgerIdentity = snapshot.identity;
      this.ledgerSaturated = isNonPrunableSaturation(this.operations, this.expiredReplays);
      return;
    }
    const operations: StoredOperation[] = ledger.operations.map((operation) => (
      operation.status === "draining" ? { ...operation, status: "queued" as const } : operation
    ));
    const compacted = compactLedgerState(
      operations,
      ledger.expiredReplays,
      this.clock().getTime(),
    );
    this.operations = operations;
    this.expiredReplays = [...ledger.expiredReplays];
    this.ledgerIdentity = snapshot.identity;
    if (serializeLedger(compacted) !== snapshot.content) {
      this.publishLedger(compacted);
    } else {
      this.ledgerSaturated = isNonPrunableSaturation(this.operations, this.expiredReplays);
    }
  }

  private publishLedger(state: LedgerState): void {
    const content = serializeLedger(state);
    if (state.operations.length + state.expiredReplays.length > MAX_OPERATIONS
      || Buffer.byteLength(content, "utf8") > MAX_LEDGER_BYTES) {
      throw new OperatorLedgerCapacityError();
    }
    try {
      this.hooks?.beforeLedgerPublication?.();
    } catch {
      throw new MemoryOperatorError("unavailable", "Memory action state publication was interrupted.");
    }
    let persisted: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
    try {
      writeCanonicalFileAtomic(
        this.engine.root,
        LEDGER_FILE,
        content,
        this.ledgerIdentity ?? CANONICAL_FILE_MISSING,
      );
      this.hooks?.afterLedgerPublication?.();
      const snapshot = readCanonicalFileSnapshot(this.engine.root, LEDGER_FILE, { maxBytes: MAX_LEDGER_BYTES });
      if (snapshot === undefined || snapshot.content !== content
        || (snapshot.identity.mode & 0o777) !== 0o600 || snapshot.identity.nlink !== 1
        || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
        throw new Error("memory operator ledger publication could not be proven");
      }
      persisted = snapshot;
    } catch {
      // Once publication begins, the old/new outcome can be uncertain. Keep
      // the last proven in-memory state and require restart reconciliation.
      this.ledgerUnavailable = true;
      this.notifyIntegrityFailure("ledger_publication");
      throw new MemoryOperatorError("unavailable", "Memory action state publication could not be proven.");
    }
    this.operations = [...state.operations];
    this.expiredReplays = [...state.expiredReplays];
    this.ledgerIdentity = persisted.identity;
    this.ledgerSaturated = isNonPrunableSaturation(this.operations, this.expiredReplays);
  }

  private safeWarn(message: string): void {
    try { this.logger.warn(message); } catch { /* logging cannot change durable state */ }
  }

  private notifyIntegrityFailure(reason: MemoryOperatorIntegrityFailure["reason"]): void {
    if (this.integrityFailureNotified) return;
    this.integrityFailureNotified = true;
    const message = reason === "ledger_startup"
      ? "Memory action state could not be loaded safely."
      : reason === "ledger_publication"
        ? "Memory action state publication could not be proven."
        : "Memory action recovery did not complete.";
    try {
      this.onIntegrityFailure?.({ code: "unavailable", reason, message });
    } catch {
      // Notification consumers cannot change or mask the durable failure.
    }
  }
}

function operatorRecord(record: MemoryRecord): MemoryOperatorRecord {
  const lifecycle = lifecycleOf(record);
  return {
    id: record.id,
    revision: recordRevision(record),
    lifecycle,
    type: record.type,
    status: record.status,
    text: record.text,
    salience: record.salience,
    isInsight: record.isInsight,
    createdAt: record.createdAt,
    ...(record.lastAccessedAt === undefined ? {} : { lastAccessedAt: record.lastAccessedAt }),
    accessCount: record.accessCount,
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(record.dueAt === undefined ? {} : { dueAt: record.dueAt }),
    tags: [...record.tags],
    ...(record.collection === undefined ? {} : { collection: record.collection }),
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    ...(lifecycle === "superseded" && record.validTo !== undefined
      ? { supersededAt: record.validTo }
      : {}),
    ...(record.source.session === undefined ? {} : { source: { conversationId: record.source.session } }),
  };
}

function recordRevision(record: MemoryRecord): string {
  return createHash("sha256").update(JSON.stringify({
    id: record.id,
    lifecycle: lifecycleOf(record),
    type: record.type,
    status: record.status,
    text: record.text,
    salience: record.salience,
    isInsight: record.isInsight,
    createdAt: record.createdAt,
    validFrom: record.validFrom ?? null,
    validTo: record.validTo ?? null,
    dueAt: record.dueAt ?? null,
    tags: record.tags,
    collection: record.collection ?? null,
    supersededBy: record.supersededBy ?? null,
  })).digest("hex");
}

function lifecycleOf(record: MemoryRecord): MemoryOperatorLifecycle {
  if (record.status === "dropped") return "forgotten";
  if (record.status === "invalidated" || record.supersededBy !== undefined) return "superseded";
  return "active";
}

function normalizeRecordQuery(query: MemoryOperatorRecordQuery): {
  readonly query?: string;
  readonly lifecycle?: MemoryOperatorLifecycle;
  readonly type?: MemoryRecord["type"];
  readonly collection?: string;
  readonly limit: number;
  readonly before?: string;
} {
  assertExactObjectKeys(
    query,
    ["query", "lifecycle", "type", "collection", "limit", "before"],
    "Memory record query",
  );
  if (query.query !== undefined && typeof query.query !== "string") {
    throw new MemoryOperatorError("invalid_request", "Memory query text must be a string.");
  }
  const text = query.query?.normalize("NFKC").trim();
  if (text !== undefined && (text.length === 0 || [...text].length > MAX_TEXT_CODE_POINTS)) {
    throw new MemoryOperatorError("invalid_request", "Memory query is invalid.");
  }
  if (query.collection !== undefined && typeof query.collection !== "string") {
    throw new MemoryOperatorError("invalid_request", "Memory collection filter must be a string.");
  }
  const collection = query.collection?.normalize("NFKC").trim();
  if (collection !== undefined && (collection.length === 0
    || [...collection].length > MAX_COLLECTION_CODE_POINTS)) {
    throw new MemoryOperatorError("invalid_request", "Memory collection filter is invalid.");
  }
  if (query.lifecycle !== undefined
    && query.lifecycle !== "active" && query.lifecycle !== "superseded" && query.lifecycle !== "forgotten") {
    throw new MemoryOperatorError("invalid_request", "Memory lifecycle filter is invalid.");
  }
  if (query.type !== undefined && query.type !== "task" && query.type !== "event" && query.type !== "note") {
    throw new MemoryOperatorError("invalid_request", "Memory type filter is invalid.");
  }
  if (query.before !== undefined && typeof query.before !== "string") {
    throw new MemoryOperatorError("invalid_request", "Memory page cursor must be a string.");
  }
  return {
    ...(text === undefined ? {} : { query: text }),
    ...(query.lifecycle === undefined ? {} : { lifecycle: query.lifecycle }),
    ...(query.type === undefined ? {} : { type: query.type }),
    ...(collection === undefined ? {} : { collection }),
    limit: normalizeLimit(query.limit, DEFAULT_RECORD_LIMIT, MAX_RECORD_LIMIT, "record limit"),
    ...(query.before === undefined ? {} : { before: query.before }),
  };
}

function recordFilterHash(query: ReturnType<typeof normalizeRecordQuery>): string {
  return createHash("sha256").update(JSON.stringify({
    query: query.query ?? null,
    lifecycle: query.lifecycle ?? null,
    type: query.type ?? null,
    collection: query.collection ?? null,
  })).digest("hex");
}

function encodeCursor(createdAt: string, id: string, filterHash: string): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt, id, filterHash }), "utf8").toString("base64url");
}

function decodeCursor(value: string, filterHash: string): { createdAt: string; id: string } {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isObject(parsed) || parsed.v !== 1 || parsed.filterHash !== filterHash
      || typeof parsed.createdAt !== "string" || !isExactTimestamp(parsed.createdAt)
      || typeof parsed.id !== "string" || parsed.id.length === 0) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new MemoryOperatorError("invalid_request", "Memory page cursor is invalid for this query.");
  }
}

function statusesForLifecycle(lifecycle: MemoryOperatorLifecycle): readonly MemoryStatus[] {
  if (lifecycle === "forgotten") return ["dropped"];
  if (lifecycle === "superseded") return ["invalidated"];
  return activeStatuses();
}

function activeStatuses(): readonly MemoryStatus[] {
  return ["open", "done", "scheduled", "migrated"];
}

function normalizePatch(value: unknown): MemoryOperatorSemanticPatch {
  if (!isObject(value)) {
    throw new MemoryOperatorError("invalid_request", "Memory edit patch must be an object.");
  }
  const allowed = new Set(["text", "type", "tags", "salience", "collection", "dueAt", "validFrom"]);
  if (Object.keys(value).length === 0 || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new MemoryOperatorError("invalid_request", "Memory edit patch is empty or contains unsupported fields.");
  }
  let text: string | undefined;
  if (value.text !== undefined) text = normalizeSemanticText(value.text);
  if (value.type !== undefined && value.type !== "task" && value.type !== "event" && value.type !== "note") {
    throw new MemoryOperatorError("invalid_request", "Memory record type is invalid.");
  }
  let tags: string[] | undefined;
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > MAX_TAGS) {
      throw new MemoryOperatorError("invalid_request", "Memory tags exceed their bound.");
    }
    tags = value.tags.map((tag) => {
      if (typeof tag !== "string") throw new MemoryOperatorError("invalid_request", "Memory tag is invalid.");
      const normalized = tag.normalize("NFKC").trim();
      if (normalized.length === 0 || [...normalized].length > MAX_TAG_CODE_POINTS
        || INVALID_SEMANTIC_TEXT.test(normalized)) {
        throw new MemoryOperatorError("invalid_request", "Memory tag is invalid.");
      }
      return normalized;
    });
    if (new Set(tags).size !== tags.length) {
      throw new MemoryOperatorError("invalid_request", "Memory tags must be unique.");
    }
  }
  if (value.salience !== undefined && (typeof value.salience !== "number"
    || !Number.isFinite(value.salience) || value.salience < 0 || value.salience > 1)) {
    throw new MemoryOperatorError("invalid_request", "Memory salience must be from zero to one.");
  }
  let collection: string | null | undefined;
  if (value.collection !== undefined) {
    if (value.collection === null) collection = null;
    else {
      if (typeof value.collection !== "string") {
        throw new MemoryOperatorError("invalid_request", "Memory collection must be a bounded slug.");
      }
      collection = value.collection.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[ _]+/gu, "-");
      if (collection.length === 0 || [...collection].length > MAX_COLLECTION_CODE_POINTS
        || !COLLECTION.test(collection)) {
        throw new MemoryOperatorError("invalid_request", "Memory collection must be a bounded slug.");
      }
    }
  }
  const dueAt = normalizeNullableTimestamp(value.dueAt, "dueAt");
  const validFrom = normalizeNullableTimestamp(value.validFrom, "validFrom");
  return {
    ...(text === undefined ? {} : { text }),
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(tags === undefined ? {} : { tags }),
    ...(value.salience === undefined ? {} : { salience: value.salience }),
    ...(collection === undefined ? {} : { collection }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(validFrom === undefined ? {} : { validFrom }),
  };
}

function normalizeSemanticText(value: unknown): string {
  if (typeof value !== "string") throw new MemoryOperatorError("invalid_request", "Memory text is invalid.");
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || [...normalized].length > MAX_TEXT_CODE_POINTS
    || INVALID_SEMANTIC_TEXT.test(normalized) || normalized.includes("<!--mem")) {
    throw new MemoryOperatorError("invalid_request", "Memory text is invalid or exceeds its bound.");
  }
  return normalized;
}

function normalizeNullableTimestamp(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !isExactTimestamp(value)) {
    throw new MemoryOperatorError("invalid_request", `Memory ${label} must be an exact ISO timestamp or null.`);
  }
  return value;
}

function applySemanticPatch(record: MemoryRecord, patch: MemoryOperatorSemanticPatch): MemoryRecord {
  const {
    collection: currentCollection,
    dueAt: currentDueAt,
    validFrom: currentValidFrom,
    ...withoutNullableSemanticFields
  } = record;
  return {
    ...withoutNullableSemanticFields,
    ...(patch.text === undefined ? {} : { text: patch.text }),
    ...(patch.type === undefined ? {} : { type: patch.type }),
    ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
    ...(patch.salience === undefined ? {} : { salience: patch.salience }),
    ...optionalPatchedField("collection", currentCollection, patch.collection),
    ...optionalPatchedField("dueAt", currentDueAt, patch.dueAt),
    ...optionalPatchedField("validFrom", currentValidFrom, patch.validFrom),
  };
}

function optionalPatchedField<K extends "collection" | "dueAt" | "validFrom">(
  key: K,
  current: string | undefined,
  patch: string | null | undefined,
): Partial<Record<K, string>> {
  const value = patch === undefined ? current : patch === null ? undefined : patch;
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, string>>;
}

function canonicalState(root: string, record: MemoryRecord): CanonicalBulletState {
  const file = record.source.file;
  if (file === undefined) throw new MemoryOperatorError("unavailable", "Memory record has no canonical source.");
  const bullet = readBullet(root, file, record.id);
  if (bullet === undefined) throw new MemoryOperatorError("unavailable", "Memory canonical source is unavailable.");
  return { file, bullet };
}

function bulletForRecord(record: MemoryRecord, refs: readonly string[] = []): Bullet {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    text: record.text,
    salience: record.salience,
    isInsight: record.isInsight,
    createdAt: record.createdAt,
    refs: [...refs],
    ...(record.dueAt === undefined ? {} : { dueAt: record.dueAt }),
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    tags: [...record.tags],
    ...(record.collection === undefined ? {} : { collection: record.collection }),
    ...(record.source.session === undefined ? {} : { conversationId: record.source.session }),
  };
}

function recordForBullet(bullet: Bullet, root: string): MemoryRecord {
  const created = new Date(bullet.createdAt);
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    ...(bullet.validFrom === undefined ? {} : { validFrom: bullet.validFrom }),
    ...(bullet.dueAt === undefined ? {} : { dueAt: bullet.dueAt }),
    tags: [...(bullet.tags ?? [])],
    ...(bullet.collection === undefined ? {} : { collection: bullet.collection }),
    source: {
      file: relative(root, dailyFilePath(root, created)),
      ...(bullet.conversationId === undefined ? {} : { session: bullet.conversationId }),
    },
  };
}

function graphForReplacement(
  db: MemoryDb,
  oldId: string,
  newId: string,
  createdAt: string,
): { entities: EntityRecord[]; associations: MemoryEntityAssociation[] } {
  const prior = db.associationsForMemory(oldId);
  const entities = new Map<string, EntityRecord>();
  const associations: MemoryEntityAssociation[] = [];
  for (const association of prior) {
    const entity = db.getEntity(association.entityId);
    if (entity === undefined || entity.type === "collection") continue;
    entities.set(entity.id, entity);
    associations.push({
      memoryId: newId,
      entityId: entity.id,
      provenance: "capture",
      createdAt,
    });
  }
  if (entities.size > 16 || associations.length > 128) {
    throw new MemoryOperatorError("unavailable", "Memory graph evidence exceeds the action bound.");
  }
  return { entities: [...entities.values()], associations };
}

function projectGraph(
  snapshot: GraphSnapshot,
  limit: number,
  focusId: string | undefined,
  includeHistory: boolean,
): MemoryOperatorGraph {
  const memoryById = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const candidateEdges: MemoryOperatorGraphEdge[] = [
    ...snapshot.relations.map((relation) => ({
      source: relation.src,
      target: relation.dst,
      kind: "relation" as const,
      label: relation.relation,
    })),
    ...snapshot.associations.map((association) => ({
      source: association.memoryId,
      target: association.entityId,
      kind: "association" as const,
    })),
    ...snapshot.edges.flatMap((edge) => edge.kind === "supports" || edge.kind === "supersedes" ? [{
      source: edge.src,
      target: edge.dst,
      kind: edge.kind,
      weight: edge.weight,
    } as MemoryOperatorGraphEdge] : []),
  ].filter((edge) => {
    const sourceMemory = memoryById.get(edge.source);
    const targetMemory = memoryById.get(edge.target);
    if (!includeHistory && (sourceMemory !== undefined && lifecycleOf(sourceMemory) !== "active"
      || targetMemory !== undefined && lifecycleOf(targetMemory) !== "active")) return false;
    return (memoryById.has(edge.source) || entityById.has(edge.source))
      && (memoryById.has(edge.target) || entityById.has(edge.target));
  });
  const reachable = focusId === undefined ? undefined : new Set<string>([
    focusId,
    ...candidateEdges.flatMap((edge) => edge.source === focusId ? [edge.target]
      : edge.target === focusId ? [edge.source] : []),
  ]);
  const nodes: MemoryOperatorGraphNode[] = [];
  for (const memory of snapshot.memories) {
    if (nodes.length >= limit || (reachable !== undefined && !reachable.has(memory.id))) continue;
    if (!includeHistory && lifecycleOf(memory) !== "active") continue;
    nodes.push({
      kind: "memory",
      id: memory.id,
      label: boundedLabel(memory.text),
      lifecycle: lifecycleOf(memory),
      recordType: memory.type,
    });
  }
  for (const entity of snapshot.entities) {
    if (nodes.length >= limit || (reachable !== undefined && !reachable.has(entity.id))) continue;
    nodes.push({
      kind: "entity",
      id: entity.id,
      label: boundedLabel(entity.name),
      ...(entity.type === undefined ? {} : { entityType: entity.type }),
      ...(entity.summary === undefined ? {} : { summary: entity.summary }),
    });
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = candidateEdges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(0, limit);
  const truncated = snapshot.sourceTruncated || nodes.length >= limit || candidateEdges.length > edges.length;
  return {
    fidelity: "captured",
    nodes,
    edges,
    ...(truncated ? { truncated: true } : {}),
  };
}

function actionRequestHash(request: Omit<NormalizedActionRequest, "requestHash" | "confirmationToken">): string {
  return createHash("sha256")
    .update("mono-agent-memory-operator-action-v1\0")
    .update(JSON.stringify(request))
    .digest("hex");
}

function assertActionLifecycle(action: OperatorAction, record: MemoryRecord): void {
  const lifecycle = lifecycleOf(record);
  if (action === "restore" ? lifecycle !== "forgotten" : lifecycle !== "active") {
    throw new MemoryOperatorError("revision_conflict", "Memory record lifecycle changed before the action.");
  }
}

function assertRevision(record: MemoryRecord, expected: string): void {
  if (recordRevision(record) !== expected) {
    throw new MemoryOperatorError("revision_conflict", "Memory record revision changed before the action.");
  }
}

function normalizeRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new MemoryOperatorError("invalid_request", "Memory expectedRevision is invalid.");
  }
  return value;
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new MemoryOperatorError("invalid_request", "Memory idempotencyKey is invalid.");
  }
  return value;
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 512
    || INVALID_SEMANTIC_TEXT.test(value)) {
    throw new MemoryOperatorError("invalid_request", `Memory ${label} is invalid.`);
  }
  return value;
}

function normalizeOptionalId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizeId(value, label);
}

function normalizeLimit(value: unknown, fallback: number, maximum: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > maximum) {
    throw new MemoryOperatorError("invalid_request", `Memory ${label} must be from 1 to ${maximum}.`);
  }
  return Number(limit);
}

function publicOperation(operation: StoredOperation): MemoryOperatorOperation {
  return {
    id: operation.id,
    action: operation.action,
    recordId: operation.recordId,
    status: operation.status,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.resultRecordId === undefined ? {} : { resultRecordId: operation.resultRecordId }),
    ...(operation.errorCode === undefined ? {} : { errorCode: operation.errorCode }),
    ...(operation.errorMessage === undefined ? {} : { errorMessage: operation.errorMessage }),
  };
}

function isPendingOperation(operation: StoredOperation): boolean {
  return operation.status === "queued" || operation.status === "draining" || operation.status === "applying";
}

function requireResultId(operation: StoredOperation): string {
  if (operation.resultRecordId === undefined) {
    throw new MemoryOperatorError("unavailable", "Memory action lost its planned result identity.");
  }
  return operation.resultRecordId;
}

class OperatorLedgerCapacityError extends Error {}

class OperatorLedgerCapacityStop extends MemoryOperatorError {
  constructor() {
    super("unavailable", "Memory action state exceeds its durable bound.", { reason: "capacity" });
  }
}

function compactLedgerState(
  sourceOperations: readonly StoredOperation[],
  sourceExpiredReplays: readonly ExpiredReplay[],
  nowMs: number,
  protectedOperationId?: string,
): LedgerState {
  let operations = [...sourceOperations];
  let expiredReplays = sourceExpiredReplays
    .filter((replay) => Date.parse(replay.expiresAt) > nowMs);
  const terminalOldestFirst = (): StoredOperation[] => operations
    .filter((operation) => !isPendingOperation(operation) && operation.id !== protectedOperationId)
    .sort(compareTerminalOperations);
  let terminalCount = operations.filter((operation) => !isPendingOperation(operation)).length;
  const historyCutoff = nowMs - TERMINAL_HISTORY_RETENTION_MS;

  for (const operation of terminalOldestFirst()) {
    if (terminalCount <= MAX_TERMINAL_OPERATIONS
      && Date.parse(operation.completedAt!) >= historyCutoff) continue;
    operations = operations.filter((candidate) => candidate.id !== operation.id);
    terminalCount -= 1;
    const replay = replayForTerminal(operation, nowMs);
    if (replay !== undefined) expiredReplays.push(replay);
  }

  const liveKeys = new Set(operations.map((operation) => operation.idempotencyKey));
  const liveIds = new Set(operations.map((operation) => operation.id));
  expiredReplays = expiredReplays
    .filter((replay) => !liveKeys.has(replay.idempotencyKey) && !liveIds.has(replay.operationId))
    .sort(compareExpiredReplays);
  while (expiredReplays.length > MAX_EXPIRED_REPLAYS) expiredReplays.shift();

  while (operations.length + expiredReplays.length > MAX_OPERATIONS) {
    if (expiredReplays.length > 0) {
      expiredReplays.shift();
      continue;
    }
    const terminal = terminalOldestFirst()[0];
    if (terminal === undefined) throw new OperatorLedgerCapacityError();
    operations = operations.filter((candidate) => candidate.id !== terminal.id);
    terminalCount -= 1;
  }

  let state: LedgerState = { operations, expiredReplays };
  while (ledgerByteLength(state) > MAX_LEDGER_BYTES) {
    const terminal = terminalOldestFirst()[0];
    if (terminal !== undefined) {
      operations = operations.filter((candidate) => candidate.id !== terminal.id);
      terminalCount -= 1;
      const replay = replayForTerminal(terminal, nowMs);
      if (replay !== undefined) expiredReplays.push(replay);
      expiredReplays.sort(compareExpiredReplays);
      while (operations.length + expiredReplays.length > MAX_OPERATIONS) expiredReplays.shift();
      state = { operations, expiredReplays };
      continue;
    }
    if (expiredReplays.length > 0) {
      expiredReplays.shift();
      state = { operations, expiredReplays };
      continue;
    }
    throw new OperatorLedgerCapacityError();
  }
  return state;
}

function replayForTerminal(operation: StoredOperation, nowMs: number): ExpiredReplay | undefined {
  const completedAt = operation.completedAt;
  if (completedAt === undefined) throw new OperatorLedgerCapacityError();
  const expiresAtMs = Date.parse(completedAt) + IDEMPOTENCY_RETENTION_MS;
  if (expiresAtMs <= nowMs) return undefined;
  return {
    operationId: operation.id,
    idempotencyKey: operation.idempotencyKey,
    requestHash: operation.requestHash,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function compareTerminalOperations(left: StoredOperation, right: StoredOperation): number {
  return left.completedAt!.localeCompare(right.completedAt!) || left.id.localeCompare(right.id);
}

function compareExpiredReplays(left: ExpiredReplay, right: ExpiredReplay): number {
  return left.expiresAt.localeCompare(right.expiresAt) || left.operationId.localeCompare(right.operationId);
}

function ledgerByteLength(state: LedgerState): number {
  return Buffer.byteLength(serializeLedger(state), "utf8");
}

function serializeLedger(state: LedgerState): string {
  const ledger: OperatorLedger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    operations: state.operations,
    expiredReplays: state.expiredReplays,
  };
  return `${JSON.stringify(ledger)}\n`;
}

function isNonPrunableSaturation(
  operations: readonly StoredOperation[],
  expiredReplays: readonly ExpiredReplay[],
): boolean {
  if (expiredReplays.length > 0 || operations.some((operation) => !isPendingOperation(operation))) return false;
  if (operations.length >= MAX_OPERATIONS) return true;
  return ledgerByteLength({ operations, expiredReplays }) + minimumAdmissionByteCost() > MAX_LEDGER_BYTES;
}

function minimumAdmissionByteCost(): number {
  return Buffer.byteLength(JSON.stringify({
    id: "00000000-0000-0000-0000-000000000000",
    action: "forget",
    recordId: "x",
    status: "queued",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    idempotencyKey: "x",
    requestHash: "0".repeat(64),
    expectedRevision: "0".repeat(64),
  })) + 1;
}

function parseLedger(raw: string): OperatorLedger {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error("malformed memory operator ledger"); }
  const legacy = isObject(value) && value.schemaVersion === LEGACY_LEDGER_SCHEMA_VERSION;
  if (!isObject(value) || (!legacy && value.schemaVersion !== LEDGER_SCHEMA_VERSION)
    || (legacy ? Object.keys(value).length !== 2 : Object.keys(value).length !== 3)
    || !Object.prototype.hasOwnProperty.call(value, "operations")
    || !Array.isArray(value.operations)
    || (!legacy && !Array.isArray(value.expiredReplays))) {
    throw new Error("invalid memory operator ledger");
  }
  const operations = value.operations.map(parseStoredOperation);
  const expiredReplays = legacy
    ? []
    : (value.expiredReplays as unknown[]).map(parseExpiredReplay);
  if (operations.length + expiredReplays.length > MAX_OPERATIONS) {
    throw new Error("memory operator ledger exceeds its entry bound");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id) || keys.has(operation.idempotencyKey)) throw new Error("duplicate memory operator ledger key");
    ids.add(operation.id);
    keys.add(operation.idempotencyKey);
  }
  for (const replay of expiredReplays) {
    if (ids.has(replay.operationId) || keys.has(replay.idempotencyKey)) {
      throw new Error("duplicate memory operator ledger replay key");
    }
    ids.add(replay.operationId);
    keys.add(replay.idempotencyKey);
  }
  const canonical = legacy
    ? { schemaVersion: LEGACY_LEDGER_SCHEMA_VERSION, operations }
    : { schemaVersion: LEDGER_SCHEMA_VERSION, operations, expiredReplays };
  if (`${JSON.stringify(canonical)}\n` !== raw) throw new Error("non-canonical memory operator ledger");
  return { schemaVersion: LEDGER_SCHEMA_VERSION, operations, expiredReplays };
}

function parseExpiredReplay(value: unknown): ExpiredReplay {
  if (!isObject(value) || Object.keys(value).length !== 4
    || !isValidStoredId(value.operationId)
    || typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
    || typeof value.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestHash)
    || typeof value.expiresAt !== "string" || !isExactTimestamp(value.expiresAt)) {
    throw new Error("invalid memory operator expired replay");
  }
  const replay: ExpiredReplay = {
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    requestHash: value.requestHash,
    expiresAt: value.expiresAt,
  };
  if (JSON.stringify(replay) !== JSON.stringify(value)) {
    throw new Error("non-canonical memory operator expired replay");
  }
  return replay;
}

function parseStoredOperation(value: unknown): StoredOperation {
  const allowed = new Set([
    "id",
    "action",
    "recordId",
    "status",
    "createdAt",
    "updatedAt",
    "resultRecordId",
    "errorCode",
    "errorMessage",
    "idempotencyKey",
    "requestHash",
    "expectedRevision",
    "patch",
    "appliedAt",
    "completedAt",
  ]);
  if (!isObject(value)
    || Object.keys(value).some((key) => !allowed.has(key))
    || !isValidStoredId(value.id) || !isValidStoredId(value.recordId)
    || (value.action !== "edit" && value.action !== "forget" && value.action !== "restore")
    || (value.status !== "queued" && value.status !== "draining" && value.status !== "applying"
      && value.status !== "succeeded" && value.status !== "failed")
    || typeof value.createdAt !== "string" || !isExactTimestamp(value.createdAt)
    || typeof value.updatedAt !== "string" || !isExactTimestamp(value.updatedAt)
    || typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
    || typeof value.requestHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestHash)
    || typeof value.expectedRevision !== "string"
    || (value.resultRecordId !== undefined && !isValidStoredId(value.resultRecordId))
    || (value.appliedAt !== undefined && (typeof value.appliedAt !== "string" || !isExactTimestamp(value.appliedAt)))
    || (value.completedAt !== undefined && (typeof value.completedAt !== "string" || !isExactTimestamp(value.completedAt)))
    || (value.errorCode !== undefined && !isPersistedFailureCode(value.errorCode))
    || (value.errorMessage !== undefined && typeof value.errorMessage !== "string")) {
    throw new Error("invalid memory operator operation");
  }
  const terminal = value.status === "succeeded" || value.status === "failed";
  const applying = value.status === "applying";
  if ((terminal && value.completedAt === undefined) || (!terminal && value.completedAt !== undefined)
    || ((terminal || applying) && value.appliedAt === undefined)
    || ((!terminal && !applying) && value.appliedAt !== undefined)
    || (terminal ? value.expectedRevision !== "" : !/^[a-f0-9]{64}$/u.test(value.expectedRevision))
    || ((value.action === "edit" || value.action === "restore") !== (value.resultRecordId !== undefined))
    || (value.action === "edit" && !terminal && value.patch === undefined)
    || ((value.action !== "edit" || terminal) && value.patch !== undefined)
    || (value.status === "failed") !== (value.errorCode !== undefined && value.errorMessage !== undefined)
    || (value.status === "succeeded" && (value.errorCode !== undefined || value.errorMessage !== undefined))) {
    throw new Error("invalid memory operator operation state");
  }
  if (value.patch !== undefined) {
    const normalized = normalizePatch(value.patch);
    if (JSON.stringify(normalized) !== JSON.stringify(value.patch)) {
      throw new Error("non-canonical memory operator patch");
    }
  }
  if (value.status === "failed" && value.errorMessage !== sanitizedErrorMessage(value.errorCode!)) {
    throw new Error("invalid memory operator failure receipt");
  }
  return value as unknown as StoredOperation;
}

function isValidStoredId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 512
    && !INVALID_SEMANTIC_TEXT.test(value);
}

function isPersistedFailureCode(value: unknown): value is string {
  return typeof value === "string" && PERSISTED_FAILURE_CODES.has(value);
}

function sanitizedErrorMessage(code: string): string {
  if (code === "revision_conflict") return "Memory record changed before the action completed.";
  if (code === "not_found") return "Memory record was not found.";
  if (code === "invalid_request") return "Memory action was not valid for this record.";
  return "Memory action failed safely.";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function boundedLabel(value: string): string {
  const points = [...value];
  return points.length <= 160 ? value : `${points.slice(0, 159).join("")}…`;
}

function isExactTimestamp(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactObjectKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new MemoryOperatorError("invalid_request", `${label} must be an object with supported fields only.`);
  }
}
