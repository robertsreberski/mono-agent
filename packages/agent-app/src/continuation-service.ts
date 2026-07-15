import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";

import {
  type ContinuationStore,
  type ContinuationRetentionOptions,
  type DurableContinuationRecord,
  type ContinuationOriginContextReference,
  acquireContinuationStoreLock,
  loadOrCreateContinuationSecret,
  openContinuationStore,
} from "./continuation-store.js";
import {
  CONTINUATION_CLAIM_TOKEN_ENV,
  CONTINUATION_CLAIM_TOKEN_HEADER,
  CONTINUATION_CLAIM_URL_ENV,
  CONTINUATION_CLAIM_URL_HEADER,
  CONTINUATION_FINGERPRINT_ENV,
  CONTINUATION_FINGERPRINT_HEADER,
  CONTINUATION_MODE_ENV,
  CONTINUATION_MODE_HEADER,
  CONTINUATION_STATES,
  DEFAULT_CONTINUATION_LIMITS,
  TERMINAL_CONTINUATION_STATES,
  canonicalContinuationJson,
  continuationDigest,
  continuationTokenMatches,
  normalizeContinuationReplyTarget,
  type ContinuationClaimCapability,
  type ContinuationHealthSnapshot,
  type ContinuationHistoryRecordInput,
  type ContinuationHistoryRecordResult,
  type ContinuationLimits,
  type ContinuationMode,
  type ContinuationNativeDeliveryInput,
  type ContinuationNativeDeliveryResult,
  type ContinuationStatusSnapshot,
  type ContinuationSynthesisInput,
  type ContinuationSynthesisResult,
  type IssueContinuationCapabilityInput,
  type NamedContinuationRoute,
} from "./continuations.js";

const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 30 * 60 * 1_000;
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_DELIVERY_ATTEMPTS = 20;
const MAX_OPERATOR_PAGE_SIZE = 500;
const MAX_CLAIM_BODY_BYTES = 16 * 1024;
const MAX_TASK_KEY_CHARS = 256;
const MAX_TEXT_CHARS = 200_000;
const ORIGIN_CONTEXT_UNAVAILABLE_TEXT = "The background task finished, but I could not safely restore the original conversation context. Please ask me to check the result again.";

interface ClaimBinding {
  readonly serverName: string;
  readonly originRunId: string;
  readonly originConversationId: string;
  readonly replyToConversationId?: string;
  readonly historyBoundary?: string;
  readonly mode: ContinuationMode;
  readonly fingerprint: string;
  closed: boolean;
  settled: boolean;
  inFlightOperations: number;
  drainPromise?: Promise<void>;
  resolveDrain?: () => void;
}

export interface ContinuationServiceLogger {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export interface ContinuationServiceOptions {
  /** Defaults to `<cwd>/.mono-agent/continuations`. */
  readonly stateDir?: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly port?: number;
  readonly namedRoutes?: Readonly<Record<string, NamedContinuationRoute>>;
  /** Service name -> bearer. Values remain memory-only and are never logged. */
  readonly detachedServices?: Readonly<Record<string, string>>;
  /** Bounded terminal tombstone and captured-text retention policy. */
  readonly retention?: ContinuationRetentionOptions;
  /**
   * Host readiness check performed before a synthesis attempt is consumed.
   * Use it for channel/responder lifecycle availability, never model health.
   */
  readonly synthesisPreflight?: (
    input: ContinuationSynthesisInput,
  ) => Promise<ContinuationSynthesisAvailability> | ContinuationSynthesisAvailability;
  readonly synthesize: (input: ContinuationSynthesisInput) => Promise<ContinuationSynthesisResult>;
  readonly deliver: (input: ContinuationNativeDeliveryInput) => Promise<ContinuationNativeDeliveryResult>;
  /** History-only commit. It must never post to the native channel. */
  readonly recordHistory?: (input: ContinuationHistoryRecordInput) => Promise<ContinuationHistoryRecordResult>;
  readonly limits?: Partial<ContinuationLimits>;
  readonly maxResultBytes?: number;
  readonly maxDeadlineMs?: number;
  readonly leaseMs?: number;
  readonly workerIntervalMs?: number;
  readonly autoProcess?: boolean;
  readonly now?: () => Date;
  readonly logger?: ContinuationServiceLogger;
}

export type ContinuationSynthesisAvailability =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly code: string;
      readonly reason: string;
      readonly retryAfterMs?: number;
    };

type ResolvedOriginContext =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid"; readonly code: string }
  | {
      readonly kind: "ready";
      readonly policy: "pinned";
      readonly snapshot: AgentContinuationOriginContext;
    }
  | {
      readonly kind: "ready";
      readonly policy: "detached_latest";
    };

/**
 * Trusted host signal for the narrow race where readiness disappears after
 * preflight but before the model call begins. It is safe to requeue because the
 * host must throw it before invoking the responder/model.
 */
export class ContinuationSynthesisUnavailableError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ContinuationSynthesisUnavailableError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

class ContinuationServiceStoppingError extends Error {
  constructor() {
    super("Continuation service is stopping.");
    this.name = "ContinuationServiceStoppingError";
  }
}

class ContinuationOperationTimeoutError extends Error {
  constructor(readonly phase: "synthesis" | "delivery", timeoutMs: number) {
    super(`Continuation ${phase} exceeded its ${String(timeoutMs)}ms timeout.`);
    this.name = "ContinuationOperationTimeoutError";
  }
}

export interface ContinuationServiceHandle {
  readonly url: string;
  /** Ephemeral owner/operator bearer for local operator endpoints. */
  readonly operatorToken: string;
  /** Core harness issuer interface. */
  issueContinuationClaimCapability(input: {
    readonly runId: string;
    readonly serverName: string;
    readonly conversationId: string;
    readonly replyTo?: { readonly conversationId: string };
    readonly historyBoundary?: string;
  }): ContinuationClaimCapability;
  /** Extended host surface used for non-default modes. */
  issueRunClaimCapability(input: IssueContinuationCapabilityInput): ContinuationClaimCapability;
  status(id: string): Promise<ContinuationStatusSnapshot | undefined>;
  list(): Promise<readonly ContinuationStatusSnapshot[]>;
  health(): Promise<ContinuationHealthSnapshot>;
  processDue(limit?: number): Promise<number>;
  retry(id: string, options?: { readonly allowUnknown?: boolean }): Promise<ContinuationStatusSnapshot>;
  cancel(id: string): Promise<ContinuationStatusSnapshot>;
  resolveUnknown(
    id: string,
    outcome: { readonly kind: "delivered"; readonly deliveryId?: string } | { readonly kind: "not_delivered" } | { readonly kind: "dead_lettered" },
  ): Promise<ContinuationStatusSnapshot>;
  capturedText(id: string): Promise<string | undefined>;
  stop(): Promise<void>;
}

export class ContinuationProtocolError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ContinuationProtocolError";
    this.status = status;
    this.code = code;
  }
}

export async function startContinuationService(
  options: ContinuationServiceOptions,
): Promise<ContinuationServiceHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`Continuation service must bind to loopback, received ${host}.`);
  }
  validateNamedRoutes(options.namedRoutes ?? {});
  const stateDir = resolve(options.stateDir ?? resolve(options.cwd ?? process.cwd(), ".mono-agent", "continuations"));
  const lock = await acquireContinuationStoreLock(stateDir);
  try {
    const [store, secret] = await Promise.all([
      openContinuationStore(stateDir, {
        ...(options.retention === undefined ? {} : { retention: options.retention }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      loadOrCreateContinuationSecret(stateDir),
    ]);
    const service = new ContinuationService(store, secret, options, () => lock.release());
    await service.recover(true);
    return await service.start(host, options.port ?? 0);
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}

class ContinuationService {
  private readonly instanceId = randomUUID();
  private readonly operatorToken: string;
  private readonly claimBindings = new Map<string, ClaimBinding>();
  private readonly activeClaimBindings = new Set<ClaimBinding>();
  private readonly namedRoutes: Readonly<Record<string, NamedContinuationRoute>>;
  private readonly detachedServiceTokenHashes: ReadonlyMap<string, string>;
  private readonly maxResultBytes: number;
  private readonly maxDeadlineMs: number;
  private readonly leaseMs: number;
  private readonly workerIntervalMs: number;
  private readonly autoProcess: boolean;
  private readonly limits: ContinuationLimits;
  private readonly now: () => Date;
  private readonly logger: ContinuationServiceLogger | undefined;
  private readonly lifecycleAbort = new AbortController();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly activeHttpRequests = new Set<Promise<void>>();
  private activeHandleOperations = 0;
  private handleDrainPromise: Promise<void> | undefined;
  private resolveHandleDrain: (() => void) | undefined;
  private readonly resolvingUnknown = new Set<string>();
  private dispatchTail: Promise<void> = Promise.resolve();
  private server: Server | undefined;
  private baseUrl = "";
  private worker: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly store: ContinuationStore,
    private readonly secret: Buffer,
    private readonly options: ContinuationServiceOptions,
    private readonly releaseStoreLock: () => Promise<void>,
  ) {
    this.namedRoutes = options.namedRoutes ?? {};
    this.operatorToken = continuationOperatorToken(secret);
    this.detachedServiceTokenHashes = new Map(Object.entries(options.detachedServices ?? {}).map(
      ([name, token]) => [name, continuationDigest(token)],
    ));
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.maxDeadlineMs = options.maxDeadlineMs ?? DEFAULT_MAX_DEADLINE_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.workerIntervalMs = options.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.autoProcess = options.autoProcess !== false;
    this.limits = resolveContinuationLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  async start(host: string, port: number): Promise<ContinuationServiceHandle> {
    const server = createServer((request, response) => {
      const operation = this.handleRequest(request, response).catch((error: unknown) => {
        this.handleRequestError(response, error);
      });
      this.activeHttpRequests.add(operation);
      void operation.finally(() => { this.activeHttpRequests.delete(operation); });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Continuation service has no TCP address.");
    this.baseUrl = `http://${formatHost(host)}:${String(address.port)}`;
    if (this.autoProcess) {
      this.worker = setInterval(() => { void this.processDue().catch(() => undefined); }, this.workerIntervalMs);
      this.worker.unref?.();
    }
    this.logger?.info?.("Continuation service started.", { url: this.baseUrl, store: this.store.path });

    return {
      url: this.baseUrl,
      operatorToken: this.operatorToken,
      issueContinuationClaimCapability: (input) => this.issueRunClaimCapability({
        serverName: input.serverName,
        runId: input.runId,
        originConversationId: input.conversationId,
        ...(input.replyTo === undefined ? {} : { replyToConversationId: input.replyTo.conversationId }),
        historyBoundary: input.historyBoundary ?? input.runId,
        mode: "reply",
      }),
      issueRunClaimCapability: (input) => this.issueRunClaimCapability(input),
      status: async (id) => await this.runHandleOperation(async () => statusOf(await this.store.get(id))),
      list: async () => await this.runHandleOperation(async () => (await this.store.list()).map(statusOfRequired)),
      health: async () => await this.runHandleOperation(async () => await this.health()),
      processDue: async (limit) => await this.runHandleOperation(async () => await this.processDue(limit)),
      retry: async (id, retryOptions) => await this.runHandleOperation(async () => await this.retry(id, retryOptions)),
      cancel: async (id) => await this.runHandleOperation(async () => await this.cancel(id)),
      resolveUnknown: async (id, outcome) => await this.runHandleOperation(
        async () => await this.resolveUnknown(id, outcome),
      ),
      capturedText: async (id) => await this.runHandleOperation(async () => {
        const record = await this.store.get(id);
        return record?.mode === "capture" && record.state === "delivered" ? record.synthesizedText : undefined;
      }),
      stop: async () => await this.stop(),
    };
  }

  issueRunClaimCapability(input: IssueContinuationCapabilityInput): ContinuationClaimCapability {
    if (this.stopped) throw new Error("Continuation service is stopped.");
    const mode = input.mode ?? "reply";
    // Request-bound capabilities are always interactive and therefore always
    // pin an origin boundary. Context-free detached work has a separate,
    // host-authenticated named-route endpoint.
    const historyBoundary = input.historyBoundary ?? input.runId;
    const replyToConversationId = input.replyToConversationId
      ?? (mode === "reply" || mode === "notify_if_actionable"
        ? normalizeContinuationReplyTarget(input.originConversationId)
        : undefined);
    if ((mode === "reply" || mode === "notify_if_actionable") && replyToConversationId === undefined) {
      throw new Error(`Continuation mode ${mode} requires a bound reply target.`);
    }
    const fingerprint = continuationDigest([
      "v1",
      input.serverName,
      input.runId,
      input.originConversationId,
      replyToConversationId ?? "",
      historyBoundary,
      mode,
    ].join("\0"));
    const token = randomBytes(24).toString("base64url");
    const binding: ClaimBinding = {
      serverName: input.serverName,
      originRunId: input.runId,
      originConversationId: input.originConversationId,
      ...(replyToConversationId === undefined ? {} : { replyToConversationId }),
      historyBoundary,
      mode,
      fingerprint,
      closed: false,
      settled: false,
      inFlightOperations: 0,
    };
    this.claimBindings.set(token, binding);
    this.activeClaimBindings.add(binding);
    const url = `${this.baseUrl}/v1/continuations/claim`;
    let released = false;
    return {
      url,
      token,
      fingerprint,
      mode,
      headers: () => ({
        [CONTINUATION_CLAIM_URL_HEADER]: url,
        [CONTINUATION_CLAIM_TOKEN_HEADER]: token,
        [CONTINUATION_FINGERPRINT_HEADER]: fingerprint,
        [CONTINUATION_MODE_HEADER]: mode,
      }),
      env: () => ({
        [CONTINUATION_CLAIM_URL_ENV]: url,
        [CONTINUATION_CLAIM_TOKEN_ENV]: token,
        [CONTINUATION_FINGERPRINT_ENV]: fingerprint,
        [CONTINUATION_MODE_ENV]: mode,
      }),
      requiresOriginContext: async () => await this.requiresOriginContext(binding),
      finalizeOriginContext: async (snapshot) => await this.finalizeOriginContext(binding, snapshot),
      activateOriginContext: async () => await this.activateOriginContext(binding),
      abandonOriginContext: async () => await this.abandonOriginContext(binding),
      release: async () => {
        if (released) return;
        released = true;
        await this.closeClaimBinding(token, binding);
      },
    };
  }

  private async runHandleOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("Continuation service is stopped.");
    this.activeHandleOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeHandleOperations -= 1;
      if (this.stopped && this.activeHandleOperations === 0) {
        this.resolveHandleDrain?.();
        this.resolveHandleDrain = undefined;
        this.handleDrainPromise = undefined;
      }
    }
  }

  private async drainHandleOperations(): Promise<void> {
    if (this.activeHandleOperations === 0) return;
    this.handleDrainPromise ??= new Promise<void>((resolve) => { this.resolveHandleDrain = resolve; });
    await this.handleDrainPromise;
  }

  private async closeClaimBinding(token: string, binding: ClaimBinding): Promise<void> {
    binding.closed = true;
    if (this.claimBindings.get(token) === binding) this.claimBindings.delete(token);
    if (binding.inFlightOperations === 0) return;
    binding.drainPromise ??= new Promise<void>((resolve) => { binding.resolveDrain = resolve; });
    await binding.drainPromise;
  }

  private beginClaim(binding: ClaimBinding): () => void {
    if (binding.closed) {
      throw new ContinuationProtocolError(401, "invalid_claim_capability", "Invalid or expired claim capability.");
    }
    binding.inFlightOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      binding.inFlightOperations -= 1;
      if (binding.closed && binding.inFlightOperations === 0) {
        binding.resolveDrain?.();
        delete binding.resolveDrain;
        delete binding.drainPromise;
      }
    };
  }

  private async requiresOriginContext(binding: ClaimBinding): Promise<boolean> {
    if (this.stopped || binding.settled) return false;
    if (!binding.closed) {
      throw new Error("Continuation claims must be revoked before origin settlement is inspected.");
    }
    if (binding.inFlightOperations > 0) {
      binding.drainPromise ??= new Promise<void>((resolve) => { binding.resolveDrain = resolve; });
      await binding.drainPromise;
    }
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return false;
    try {
      if (binding.historyBoundary === undefined) {
        this.settleClaimBinding(binding);
        return false;
      }
      const required = (await this.store.list()).some((record) =>
        record.claimFingerprint === binding.fingerprint
        && !TERMINAL_CONTINUATION_STATES.has(record.state));
      if (!required) this.settleClaimBinding(binding);
      return required;
    } finally {
      finishOperation();
    }
  }

  private beginOriginSettlementOperation(binding: ClaimBinding): (() => void) | undefined {
    if (this.stopped || binding.settled) return undefined;
    if (!binding.closed) {
      throw new Error("Continuation claims must be revoked before origin settlement begins.");
    }
    if (binding.inFlightOperations !== 0) {
      throw new Error("Continuation capability release has not finished draining admitted work.");
    }
    binding.inFlightOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      binding.inFlightOperations -= 1;
      if (binding.closed && binding.inFlightOperations === 0) {
        binding.resolveDrain?.();
        delete binding.resolveDrain;
        delete binding.drainPromise;
      }
    };
  }

  private settleClaimBinding(binding: ClaimBinding): void {
    binding.settled = true;
    this.activeClaimBindings.delete(binding);
  }

  private async finalizeOriginContext(
    binding: ClaimBinding,
    snapshot: AgentContinuationOriginContext,
  ): Promise<void> {
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return;
    try {
      if (binding.historyBoundary === undefined) return;
      assertAgentContinuationOriginContext(snapshot);
      if (snapshot.conversationId !== binding.originConversationId
        || snapshot.originRunId !== binding.originRunId
        || snapshot.historyBoundary !== binding.historyBoundary) {
        throw new Error("Continuation origin context does not match its immutable claim binding.");
      }
      const matching = (await this.store.list()).filter((record) =>
        record.claimFingerprint === binding.fingerprint
        && !TERMINAL_CONTINUATION_STATES.has(record.state));
      if (matching.length === 0) return;
      const pin = await this.store.stageOriginContext(snapshot);
      try {
        await this.store.mutate((records) => {
          const candidates = [...records.values()].filter((record) =>
            record.claimFingerprint === binding.fingerprint
            && !TERMINAL_CONTINUATION_STATES.has(record.state));
          for (const record of candidates) {
            if (record.originContextState === "pinned"
              || (record.originContextState === "pending" && record.originContextRef !== undefined)) {
              if (record.originContextDigest !== pin.reference.digest
                || record.originContextRef?.digest !== pin.reference.digest) {
                throw new Error("Continuation origin context conflicts with an existing pinned snapshot.");
              }
              continue;
            }
            if (record.originContextState !== "pending") {
              throw new Error(`Continuation origin context cannot be finalized from ${record.originContextState}.`);
            }
            record.originContextRef = pin.reference;
            record.originContextDigest = pin.reference.digest;
            record.originContextMessageCount = pin.reference.messageCount;
            record.originContextFingerprint = continuationDigest(
              `mono-agent-origin-context-binding-v2\0${record.claimFingerprint}\0${pin.reference.digest}`,
            );
            record.originContextBindingMac = originContextBindingMac(this.secret, record, pin.reference);
            record.updatedAt = this.now().toISOString();
          }
        });
      } finally {
        await pin.release();
      }
    } finally {
      finishOperation();
    }
  }

  private async activateOriginContext(binding: ClaimBinding): Promise<void> {
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return;
    try {
      await this.store.activateOriginContextGroup({
        claimFingerprint: binding.fingerprint,
        activatedAt: this.now().toISOString(),
      });
      this.settleClaimBinding(binding);
    } finally {
      finishOperation();
    }
  }

  private async abandonOriginContext(binding: ClaimBinding): Promise<void> {
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return;
    const at = this.now().toISOString();
    try {
      await this.store.mutate((records) => {
        for (const record of records.values()) {
          if (record.claimFingerprint !== binding.fingerprint
            || record.originContextState !== "pending") continue;
          record.originContextState = "abandoned";
          delete record.originContextRef;
          record.updatedAt = at;
          record.lastError = errorRecord(
            "origin_context_unavailable",
            "The origin run did not commit its pinned continuation context.",
            at,
          );
          delete record.nextAttemptAt;
        }
      });
      this.settleClaimBinding(binding);
      if (this.autoProcess) void this.processDue().catch(() => undefined);
    } finally {
      finishOperation();
    }
  }

  async recover(startup = false): Promise<void> {
    const now = this.now().getTime();
    const current = await this.store.list();
    const needsRecovery = current.some((record) =>
      !TERMINAL_CONTINUATION_STATES.has(record.state)
      && (startup || !this.inFlight.has(record.continuationId))
      && (
        (startup && record.originContextState === "pending")
        ||
        (startup && record.leaseOwner !== undefined)
        || Date.parse(record.deadline) <= now
        || (record.leaseUntil !== undefined && Date.parse(record.leaseUntil) <= now)
      ),
    );
    if (!needsRecovery) return;
    await this.store.mutate((records) => {
      for (const record of records.values()) {
        if (TERMINAL_CONTINUATION_STATES.has(record.state)) continue;
        if (startup && record.originContextState === "pending") {
          record.originContextState = "abandoned";
          delete record.originContextRef;
          record.updatedAt = this.now().toISOString();
          record.lastError = errorRecord(
            "origin_context_unavailable",
            "The service restarted before the origin context was pinned.",
            record.updatedAt,
          );
          clearLease(record);
        }
        // A configured operation timeout may intentionally exceed the lease.
        // The process-lifetime store lock prevents another owner, while this
        // map proves the current owner is still supervising the attempt.
        if (!startup && this.inFlight.has(record.continuationId)) continue;
        const abandonedAtStartup = startup && record.leaseOwner !== undefined;
        const leaseExpired = record.leaseUntil !== undefined && Date.parse(record.leaseUntil) <= now;
        // Once a native send began, absence of a receipt is ambiguous even if
        // the wall-clock deadline passed while the process was down.
        if (record.deliveryStartedAt !== undefined && (abandonedAtStartup || leaseExpired || Date.parse(record.deadline) <= now)) {
          record.state = "delivery_unknown";
          record.lastError = errorRecord("delivery_outcome_unknown", "Process stopped after native delivery began; automatic replay is unsafe.", this.now().toISOString());
          clearLease(record);
          continue;
        }
        if (Date.parse(record.deadline) <= now) {
          expire(record, this.now().toISOString());
          continue;
        }
        if (!abandonedAtStartup && !leaseExpired) continue;
        if (record.state === "synthesizing") {
          if (record.synthesizedText !== undefined) {
            record.state = "ready_to_deliver";
            clearLease(record);
          } else {
            record.state = "dead_lettered";
            record.lastError = errorRecord("synthesis_outcome_unknown", "Process stopped after synthesis began; synthesis was not repeated.", this.now().toISOString());
            clearLease(record);
          }
        } else {
          clearLease(record);
        }
      }
    });
  }

  async processDue(limit = this.limits.maxConcurrent): Promise<number> {
    if (this.stopped) return 0;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Continuation process limit must be a non-negative safe integer.");
    const jobs = await this.startDueJobs(limit);
    const outcomes = await Promise.all(jobs);
    return outcomes.filter(Boolean).length;
  }

  /**
   * Keep dispatch serialized, but never serialize the work itself. A hung
   * provider occupies only one bounded worker slot and cannot block unrelated
   * continuations from being leased and processed.
   */
  private async startDueJobs(limit: number): Promise<readonly Promise<boolean>[]> {
    const dispatch = this.dispatchTail.then(async () => {
      if (this.stopped) return [];
      await this.recover();
      if (this.stopped) return [];
      const capacity = Math.max(0, Math.min(limit, this.limits.maxConcurrent - this.inFlight.size));
      if (capacity === 0) return [];
      const nowMs = this.now().getTime();
      const candidates = (await this.store.list())
        .filter((record) =>
          !this.inFlight.has(record.continuationId)
          && (
            (record.state === "result_received" && Date.parse(record.nextAttemptAt ?? record.updatedAt) <= nowMs)
            || record.state === "ready_to_deliver"
            || (record.state === "delivery_retry" && Date.parse(record.nextAttemptAt ?? record.updatedAt) <= nowMs)
          ),
        )
        .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
        .slice(0, capacity);
      if (this.stopped) return [];
      return candidates.map((candidate) => this.startOne(candidate.continuationId));
    });
    this.dispatchTail = dispatch.then(() => undefined, () => undefined);
    return await dispatch;
  }

  private startOne(id: string): Promise<boolean> {
    const existing = this.inFlight.get(id);
    if (existing !== undefined) return existing;
    const job = this.processOne(id);
    this.inFlight.set(id, job);
    void job.then(
      () => { if (this.inFlight.get(id) === job) this.inFlight.delete(id); },
      () => { if (this.inFlight.get(id) === job) this.inFlight.delete(id); },
    );
    return job;
  }

  private async processOne(id: string): Promise<boolean> {
    this.throwIfStopping();
    const leased = await this.acquireLease(id);
    if (leased === undefined) return false;
    this.throwIfStopping();
    let record = leased;
    // Even modes that need no model or channel text must not settle before the
    // originating run publishes (or abandons) its context boundary. Otherwise
    // a fast silent result can become terminal and poison origin settlement.
    if (record.originContextState === "pending") {
      await this.deferOriginContext(record.continuationId);
      return true;
    }
    if (record.synthesizedText === undefined && record.mode !== "silent") {
      const originContext = await this.resolveOriginContext(record);
      if (originContext.kind === "pending") {
        await this.deferOriginContext(record.continuationId);
        return true;
      }
      if (originContext.kind === "invalid") {
        await this.deadLetter(
          record.continuationId,
          originContext.code,
          "Pinned continuation binding failed integrity verification; native delivery was blocked.",
        );
        return true;
      }
      if (originContext.kind === "unavailable") {
        record = await this.prepareOriginContextFallback(record.continuationId);
      } else {
        const available = await this.synthesisAvailable(record, originContext);
        if (!available.ready) {
          await this.deferSynthesis(record.continuationId, available.code, available.reason, available.retryAfterMs);
          return true;
        }
        record = await this.synthesize(record, originContext);
      }
      if (record.state !== "ready_to_deliver") return true;
    } else if (record.state !== "ready_to_deliver") {
      record = await this.markReady(record.continuationId);
    }

    // Synthesis can outlive the task deadline. Persist the expiry decision
    // after the model result is stored and immediately before any native side
    // effect so a late answer is never posted merely because the original
    // lease was acquired in time.
    if (await this.expireBeforeDeliveryIfNeeded(record.continuationId)) {
      return true;
    }
    this.throwIfStopping();

    if (record.mode === "silent") {
      await this.markDelivered(record.continuationId, { kind: "silent", deliveredAt: this.now().toISOString() });
      return true;
    }
    if (record.mode === "capture") {
      await this.markDelivered(record.continuationId, { kind: "captured", deliveredAt: this.now().toISOString() });
      return true;
    }
    if (record.mode === "notify_if_actionable" && record.actionable === false) {
      await this.markDelivered(record.continuationId, { kind: "suppressed", deliveredAt: this.now().toISOString() });
      return true;
    }
    await this.deliver(record);
    return true;
  }

  private async synthesisAvailable(
    record: DurableContinuationRecord,
    originContext: Extract<ResolvedOriginContext, { readonly kind: "ready" }>,
  ): Promise<ContinuationSynthesisAvailability> {
    if (this.options.synthesisPreflight === undefined) return { ready: true };
    try {
      return await this.runBoundedOperation(
        "synthesis",
        Math.min(this.limits.synthesisTimeoutMs, 30_000),
        async () => await this.options.synthesisPreflight?.(synthesisInput(record, originContext)) ?? { ready: true },
      );
    } catch (error) {
      if (error instanceof ContinuationServiceStoppingError) throw error;
      return {
        ready: false,
        code: error instanceof ContinuationOperationTimeoutError
          ? "synthesis_preflight_timeout"
          : "synthesis_preflight_failed",
        reason: safeReason(error),
      };
    }
  }

  private async resolveOriginContext(record: DurableContinuationRecord): Promise<ResolvedOriginContext> {
    if (record.originContextState === "detached_latest") {
      return { kind: "ready", policy: "detached_latest" };
    }
    if (record.originContextState === "pending") return { kind: "pending" };
    if (record.originContextState !== "pinned" || record.originContextRef === undefined) {
      return { kind: "unavailable" };
    }
    const expectedFingerprint = continuationDigest(
      `mono-agent-origin-context-binding-v2\0${record.claimFingerprint}\0${record.originContextRef.digest}`,
    );
    const expectedMac = originContextBindingMac(this.secret, record, record.originContextRef);
    if (record.originContextDigest !== record.originContextRef.digest
      || record.originContextFingerprint !== expectedFingerprint
      || record.originContextBindingMac !== expectedMac) {
      return { kind: "invalid", code: "origin_context_binding_invalid" };
    }
    let snapshot: AgentContinuationOriginContext | undefined;
    try {
      snapshot = await this.store.loadOriginContext(record.originContextRef);
    } catch {
      // Filesystem identity/permission failures are indistinguishable from a
      // corrupt snapshot at this trust boundary. Fail closed into the same
      // deterministic no-model delivery instead of retrying or dead-lettering.
      await this.markOriginContextUnavailable(record.continuationId, "origin_context_unreadable");
      return { kind: "unavailable" };
    }
    if (snapshot === undefined
      || snapshot.conversationId !== record.originConversationId
      || snapshot.originRunId !== record.originRunId
      || snapshot.historyBoundary !== record.historyBoundary) {
      await this.markOriginContextUnavailable(record.continuationId, "origin_context_missing_or_corrupt");
      return { kind: "unavailable" };
    }
    return { kind: "ready", policy: "pinned", snapshot };
  }

  private async markOriginContextUnavailable(id: string, code: string): Promise<void> {
    await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, this.instanceId);
      current.originContextState = "abandoned";
      delete current.originContextRef;
      current.updatedAt = this.now().toISOString();
      current.lastError = errorRecord(code, "Pinned origin context is unavailable.", current.updatedAt);
    });
  }

  private async deferOriginContext(id: string): Promise<DurableContinuationRecord> {
    return await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, this.instanceId);
      current.synthesisDeferrals += 1;
      const at = this.now();
      current.state = "result_received";
      current.updatedAt = at.toISOString();
      current.nextAttemptAt = new Date(at.getTime() + backoffMs(
        current.synthesisDeferrals,
        1_000,
        5 * 60 * 1_000,
      )).toISOString();
      current.lastError = errorRecord(
        "origin_context_pending",
        "The origin run has not committed its pinned context yet.",
        current.updatedAt,
      );
      clearLease(current);
      return structuredClone(current);
    });
  }

  private async prepareOriginContextFallback(id: string): Promise<DurableContinuationRecord> {
    return await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, this.instanceId);
      current.synthesizedText = ORIGIN_CONTEXT_UNAVAILABLE_TEXT;
      current.completionKind = "origin_context_unavailable";
      current.state = "ready_to_deliver";
      current.updatedAt = this.now().toISOString();
      delete current.nextAttemptAt;
      delete current.synthesisStartedAt;
      return structuredClone(current);
    });
  }

  private async deferSynthesis(
    id: string,
    code: string,
    reason: string,
    retryAfterMs = 1_000,
    consumedAttempt = false,
  ): Promise<DurableContinuationRecord> {
    return await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, this.instanceId);
      const at = this.now();
      current.state = "result_received";
      current.updatedAt = at.toISOString();
      current.nextAttemptAt = new Date(at.getTime() + Math.max(0, retryAfterMs)).toISOString();
      current.lastError = errorRecord(code, reason, current.updatedAt);
      delete current.synthesisStartedAt;
      if (consumedAttempt) current.synthesisAttempts = Math.max(0, current.synthesisAttempts - 1);
      clearLease(current);
      return structuredClone(current);
    });
  }

  private async expireBeforeDeliveryIfNeeded(id: string): Promise<boolean> {
    const now = this.now();
    return await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      requireLease(current, this.instanceId);
      if (Date.parse(current.deadline) > now.getTime()) return false;
      expire(current, now.toISOString());
      return true;
    });
  }

  private async acquireLease(id: string): Promise<DurableContinuationRecord | undefined> {
    const now = this.now();
    return await this.store.mutate((records) => {
      const record = records.get(id);
      if (record === undefined || TERMINAL_CONTINUATION_STATES.has(record.state)) return undefined;
      if (record.leaseUntil !== undefined && Date.parse(record.leaseUntil) > now.getTime()) return undefined;
      if (Date.parse(record.deadline) <= now.getTime()) {
        expire(record, now.toISOString());
        return undefined;
      }
      record.leaseOwner = this.instanceId;
      record.leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString();
      record.updatedAt = now.toISOString();
      return structuredClone(record);
    });
  }

  private async synthesize(
    record: DurableContinuationRecord,
    originContext: Extract<ResolvedOriginContext, { readonly kind: "ready" }>,
  ): Promise<DurableContinuationRecord> {
    const startedAt = this.now().toISOString();
    const prepared = await this.store.mutate((records) => {
      this.throwIfStopping();
      const current = requireRecord(records, record.continuationId);
      requireLease(current, this.instanceId);
      current.state = "synthesizing";
      current.synthesisAttempts += 1;
      current.synthesisStartedAt = startedAt;
      current.updatedAt = startedAt;
      delete current.nextAttemptAt;
      return structuredClone(current);
    });
    try {
      const result = await this.runBoundedOperation(
        "synthesis",
        this.limits.synthesisTimeoutMs,
        async () => await this.options.synthesize(synthesisInput(prepared, originContext)),
      );
      this.throwIfStopping();
      const text = result.text.trim();
      if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
        throw new Error(text.length === 0 ? "Synthesis returned empty text." : "Synthesis exceeded the 200,000 character limit.");
      }
      return await this.store.mutate((records) => {
        const current = requireRecord(records, prepared.continuationId);
        requireLease(current, this.instanceId);
        current.synthesizedText = text;
        current.completionKind = "synthesized";
        if (result.actionable !== undefined) current.actionable = result.actionable;
        current.state = "ready_to_deliver";
        current.updatedAt = this.now().toISOString();
        delete current.lastError;
        delete current.synthesisStartedAt;
        return structuredClone(current);
      });
    } catch (error) {
      if (error instanceof ContinuationServiceStoppingError) throw error;
      if (error instanceof ContinuationSynthesisUnavailableError) {
        return await this.deferSynthesis(
          prepared.continuationId,
          error.code,
          error.message,
          error.retryAfterMs,
          true,
        );
      }
      return await this.store.mutate((records) => {
        const current = requireRecord(records, prepared.continuationId);
        requireLease(current, this.instanceId);
        const at = this.now().toISOString();
        current.lastError = errorRecord(
          error instanceof ContinuationOperationTimeoutError
            ? "synthesis_timeout_outcome_unknown"
            : "synthesis_failed",
          safeReason(error),
          at,
        );
        current.updatedAt = at;
        clearLease(current);
        // At-most-once model execution: a thrown/ambiguous synthesis is terminal.
        // Only delivery may retry, and only after text has been durably persisted.
        current.state = "dead_lettered";
        return structuredClone(current);
      });
    }
  }

  private async markReady(id: string): Promise<DurableContinuationRecord> {
    return await this.store.mutate((records) => {
      const record = requireRecord(records, id);
      requireLease(record, this.instanceId);
      record.state = "ready_to_deliver";
      record.updatedAt = this.now().toISOString();
      return structuredClone(record);
    });
  }

  private async deliver(record: DurableContinuationRecord): Promise<void> {
    if (record.replyToConversationId === undefined || record.synthesizedText === undefined) {
      await this.deadLetter(record.continuationId, "missing_delivery_binding", "Continuation has no bound native destination or synthesized text.");
      return;
    }
    const started = await this.store.mutate((records) => {
      this.throwIfStopping();
      const current = requireRecord(records, record.continuationId);
      requireLease(current, this.instanceId);
      current.deliveryAttempts += 1;
      const at = this.now().toISOString();
      current.deliveryStartedAt = at;
      current.updatedAt = at;
      return structuredClone(current);
    });
    const conversationId = started.replyToConversationId;
    const text = started.synthesizedText;
    if (conversationId === undefined || text === undefined) {
      await this.deadLetter(started.continuationId, "missing_delivery_binding", "Continuation delivery binding disappeared before native delivery.");
      return;
    }
    let result: ContinuationNativeDeliveryResult;
    try {
      result = await this.runBoundedOperation(
        "delivery",
        this.limits.deliveryTimeoutMs,
        async () => await this.options.deliver({
          continuationId: started.continuationId,
          conversationId,
          text,
          deliveryKey: `continuation:${started.continuationId}`,
        }),
      );
      this.throwIfStopping();
    } catch (error) {
      if (error instanceof ContinuationServiceStoppingError) throw error;
      result = {
        kind: "unknown",
        code: error instanceof ContinuationOperationTimeoutError
          ? "delivery_timeout_outcome_unknown"
          : "delivery_threw",
        reason: safeReason(error),
      };
    }
    await this.store.mutate((records) => {
      const current = requireRecord(records, started.continuationId);
      requireLease(current, this.instanceId);
      const at = this.now().toISOString();
      current.updatedAt = at;
      clearLease(current);
      if (result.kind === "delivered") {
        current.state = "delivered";
        delete current.deliveryStartedAt;
        delete current.nextAttemptAt;
        delete current.lastError;
        current.receipt = {
          kind: "delivered",
          deliveredAt: at,
          ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
          ...(result.channelId === undefined ? {} : { channelId: result.channelId }),
          ...(result.historyRecorded === undefined ? {} : { historyRecorded: result.historyRecorded }),
          ...(result.historyRecorded !== false || result.historyErrorCode === undefined
            ? {}
            : { historyErrorCode: boundedHistoryErrorCode(result.historyErrorCode) }),
        };
      } else if (result.kind === "retryable" && current.deliveryAttempts < DEFAULT_DELIVERY_ATTEMPTS) {
        current.state = "delivery_retry";
        delete current.deliveryStartedAt;
        current.lastError = errorRecord(result.code, result.reason, at);
        const delay = result.retryAfterMs ?? backoffMs(current.deliveryAttempts, 1_000, 60 * 60 * 1_000);
        current.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
      } else if (result.kind === "unknown") {
        current.state = "delivery_unknown";
        current.lastError = errorRecord(result.code, result.reason, at);
      } else {
        current.state = "dead_lettered";
        delete current.deliveryStartedAt;
        const code = result.kind === "retryable" ? "delivery_attempts_exhausted" : result.code;
        current.lastError = errorRecord(code, result.reason, at);
      }
    });
  }

  private async markDelivered(id: string, receipt: NonNullable<DurableContinuationRecord["receipt"]>): Promise<void> {
    await this.store.mutate((records) => {
      const record = requireRecord(records, id);
      requireLease(record, this.instanceId);
      record.state = "delivered";
      record.receipt = receipt;
      record.updatedAt = receipt.deliveredAt;
      delete record.nextAttemptAt;
      delete record.lastError;
      clearLease(record);
    });
  }

  private async deadLetter(id: string, code: string, reason: string): Promise<void> {
    await this.store.mutate((records) => {
      const record = requireRecord(records, id);
      record.state = "dead_lettered";
      record.updatedAt = this.now().toISOString();
      record.lastError = errorRecord(code, reason, record.updatedAt);
      clearLease(record);
    });
  }

  private async retry(id: string, options?: { readonly allowUnknown?: boolean }): Promise<ContinuationStatusSnapshot> {
    const record = await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      if (current.state === "delivery_unknown" && options?.allowUnknown !== true) {
        throw new ContinuationProtocolError(409, "delivery_unknown", "Resolve the ambiguous delivery before retrying.");
      }
      if (current.state !== "delivery_retry" && current.state !== "dead_lettered" && current.state !== "delivery_unknown") {
        throw new ContinuationProtocolError(409, "not_retryable", `Continuation state ${current.state} is not retryable.`);
      }
      if (current.synthesizedText === undefined && current.mode !== "silent") {
        throw new ContinuationProtocolError(
          409,
          "synthesis_not_retryable",
          "Continuation synthesis has no persisted output and cannot be repeated.",
        );
      }
      current.state = "ready_to_deliver";
      current.nextAttemptAt = this.now().toISOString();
      delete current.deliveryStartedAt;
      delete current.lastError;
      current.updatedAt = this.now().toISOString();
      clearLease(current);
      return structuredClone(current);
    });
    if (this.autoProcess) void this.processDue().catch(() => undefined);
    return statusOfRequired(record);
  }

  private async cancel(id: string): Promise<ContinuationStatusSnapshot> {
    const record = await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      if (TERMINAL_CONTINUATION_STATES.has(current.state)) {
        if (current.state === "cancelled") return structuredClone(current);
        throw new ContinuationProtocolError(409, "already_terminal", `Continuation is already ${current.state}.`);
      }
      if (current.leaseOwner !== undefined || current.state === "synthesizing" || current.deliveryStartedAt !== undefined) {
        throw new ContinuationProtocolError(
          409,
          "continuation_in_flight",
          "Continuation has an active synthesis or native delivery; cancellation cannot make that side effect disappear.",
        );
      }
      current.state = "cancelled";
      current.updatedAt = this.now().toISOString();
      current.lastError = errorRecord("cancelled_by_operator", "Continuation cancelled by the operator.", current.updatedAt);
      clearLease(current);
      return structuredClone(current);
    });
    return statusOfRequired(record);
  }

  private async resolveUnknown(
    id: string,
    outcome: { readonly kind: "delivered"; readonly deliveryId?: string } | { readonly kind: "not_delivered" } | { readonly kind: "dead_lettered" },
  ): Promise<ContinuationStatusSnapshot> {
    if (this.resolvingUnknown.has(id)) {
      throw new ContinuationProtocolError(409, "resolution_in_progress", "This ambiguous delivery is already being resolved.");
    }
    this.resolvingUnknown.add(id);
    try {
      const current = await this.store.get(id);
      if (current === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
      if (current.state !== "delivery_unknown") {
        throw new ContinuationProtocolError(409, "not_delivery_unknown", "Only delivery_unknown continuations can be resolved.");
      }

      let history: ContinuationHistoryRecordResult | undefined;
      if (outcome.kind === "delivered") {
        if (this.options.recordHistory === undefined
          || current.replyToConversationId === undefined
          || current.synthesizedText === undefined) {
          history = { recorded: false, code: "history_record_unavailable_after_ambiguous_delivery" };
        } else {
          try {
            history = await this.runBoundedOperation(
              "delivery",
              this.limits.deliveryTimeoutMs,
              async () => await this.options.recordHistory?.({
                continuationId: current.continuationId,
                conversationId: current.replyToConversationId as string,
                text: current.synthesizedText as string,
                deliveryKey: `continuation:${current.continuationId}`,
              }) ?? { recorded: false, code: "history_record_unavailable_after_ambiguous_delivery" },
            );
          } catch (error) {
            if (error instanceof ContinuationServiceStoppingError) throw error;
            history = {
              recorded: false,
              code: error instanceof ContinuationOperationTimeoutError
                ? "history_record_timeout_after_ambiguous_delivery"
                : "history_record_failed_after_ambiguous_delivery",
            };
          }
        }
      }

      const record = await this.store.mutate((records) => {
        const mutable = requireRecord(records, id);
        if (mutable.state !== "delivery_unknown") {
          throw new ContinuationProtocolError(409, "not_delivery_unknown", "Only delivery_unknown continuations can be resolved.");
        }
        const at = this.now().toISOString();
        mutable.updatedAt = at;
        delete mutable.deliveryStartedAt;
        if (outcome.kind === "delivered") {
          const recorded = history?.recorded === true;
          mutable.state = "delivered";
          mutable.receipt = {
            kind: "delivered",
            deliveredAt: at,
            ...(outcome.deliveryId === undefined ? {} : { deliveryId: outcome.deliveryId }),
            historyRecorded: recorded,
            ...(recorded ? {} : {
              historyErrorCode: boundedHistoryErrorCode(
                history?.recorded === false
                  ? history.code
                  : "history_record_unavailable_after_ambiguous_delivery",
              ),
            }),
          };
          delete mutable.lastError;
        } else if (outcome.kind === "not_delivered") {
          mutable.state = "ready_to_deliver";
          mutable.nextAttemptAt = at;
          delete mutable.lastError;
        } else {
          mutable.state = "dead_lettered";
          mutable.lastError = errorRecord("operator_dead_lettered", "Ambiguous delivery was dead-lettered by the operator.", at);
        }
        return structuredClone(mutable);
      });
      if (outcome.kind === "not_delivered" && this.autoProcess) void this.processDue().catch(() => undefined);
      return statusOfRequired(record);
    } finally {
      this.resolvingUnknown.delete(id);
    }
  }

  private async health(): Promise<ContinuationHealthSnapshot> {
    const [records, storage] = await Promise.all([this.store.list(), this.store.stats()]);
    const counts = Object.fromEntries(CONTINUATION_STATES.map((state) => [state, 0])) as Record<(typeof CONTINUATION_STATES)[number], number>;
    let oldestPendingAt: string | undefined;
    let due = 0;
    const now = this.now().getTime();
    for (const record of records) {
      counts[record.state] += 1;
      if (!TERMINAL_CONTINUATION_STATES.has(record.state)) {
        if (oldestPendingAt === undefined || record.createdAt < oldestPendingAt) oldestPendingAt = record.createdAt;
        if (record.nextAttemptAt === undefined || Date.parse(record.nextAttemptAt) <= now) due += 1;
      }
    }
    const pending = records.length - [...TERMINAL_CONTINUATION_STATES].reduce((sum, state) => sum + counts[state], 0);
    const status = counts.delivery_unknown > 0 || counts.dead_lettered > 0
      ? "unhealthy"
      : pending > 0 || counts.expired > 0 || storage.historyDegraded > 0
        ? "degraded"
        : "healthy";
    return {
      status,
      checkedAt: this.now().toISOString(),
      counts,
      pending,
      due,
      storage,
      ...(oldestPendingAt === undefined ? {} : { oldestPendingAt }),
    };
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (this.stopped) {
      throw new ContinuationProtocolError(503, "service_stopping", "Continuation service is stopping.");
    }
    const url = new URL(request.url ?? "/", this.baseUrl);
    if (request.method === "POST" && url.pathname === "/v1/continuations/claim") {
      const token = requireBearer(request);
      const binding = this.claimBindings.get(token);
      if (binding === undefined) throw new ContinuationProtocolError(401, "invalid_claim_capability", "Invalid or expired claim capability.");
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      // Do not count a slow request body as admitted work. Recheck and enter
      // the drain only after the complete bounded body exists; release() then
      // either revokes it or waits for its durable mutation to finish.
      const finishClaim = this.beginClaim(binding);
      try {
        sendJson(response, 200, await this.claim(binding, body));
      } finally {
        finishClaim();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations/detached/claim") {
      const serviceName = requireHeader(request, "x-mono-agent-service-name");
      this.authorizeDetached(serviceName, requireBearer(request));
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      sendJson(response, 200, await this.claimDetached(serviceName, body));
      return;
    }
    const resultMatch = /^\/v1\/continuations\/([^/]+)\/result$/u.exec(url.pathname);
    if ((request.method === "PUT" || request.method === "POST") && resultMatch?.[1] !== undefined) {
      const body = await readJson(request, this.maxResultBytes);
      sendJson(response, 202, await this.acceptResult(resultMatch[1], requireBearer(request), body));
      return;
    }
    const statusMatch = /^\/v1\/continuations\/([^/]+)\/status$/u.exec(url.pathname);
    if (request.method === "GET" && statusMatch?.[1] !== undefined) {
      const record = await this.authorizedRecord(statusMatch[1], requireBearer(request));
      sendJson(response, 200, statusOfRequired(record));
      return;
    }
    if (url.pathname === "/v1/operator/continuations") {
      this.authorizeOperator(request);
      if (request.method !== "GET") throw new ContinuationProtocolError(405, "method_not_allowed", "Method not allowed.");
      sendJson(response, 200, operatorContinuationPage(await this.store.list(), url, this.limits.operatorPageSize));
      return;
    }
    if (url.pathname === "/v1/operator/health") {
      this.authorizeOperator(request);
      if (request.method !== "GET") throw new ContinuationProtocolError(405, "method_not_allowed", "Method not allowed.");
      sendJson(response, 200, await this.health());
      return;
    }
    const operatorMatch = /^\/v1\/operator\/continuations\/([^/]+)\/(retry|cancel|resolve)$/u.exec(url.pathname);
    if (request.method === "POST" && operatorMatch?.[1] !== undefined && operatorMatch[2] !== undefined) {
      this.authorizeOperator(request);
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      if (operatorMatch[2] === "retry") {
        sendJson(response, 200, await this.retry(operatorMatch[1], { allowUnknown: asObject(body).allowUnknown === true }));
      } else if (operatorMatch[2] === "cancel") {
        sendJson(response, 200, await this.cancel(operatorMatch[1]));
      } else {
        const value = asObject(body);
        const kind = value.kind;
        if (kind !== "delivered" && kind !== "not_delivered" && kind !== "dead_lettered") {
          throw new ContinuationProtocolError(400, "invalid_resolution", "Resolution kind is invalid.");
        }
        sendJson(response, 200, await this.resolveUnknown(operatorMatch[1], {
          kind,
          ...(kind === "delivered" && typeof value.deliveryId === "string" ? { deliveryId: value.deliveryId } : {}),
        }));
      }
      return;
    }
    throw new ContinuationProtocolError(404, "not_found", "Continuation endpoint not found.");
  }

  private async claim(binding: ClaimBinding, body: unknown): Promise<Record<string, unknown>> {
    const claim = parseClaim(body, this.now(), this.maxDeadlineMs);
    return await this.claimBound(binding, claim);
  }

  private async claimDetached(serviceName: string, body: unknown): Promise<Record<string, unknown>> {
    const object = asObject(body);
    const routeName = requiredStringField(object, "route");
    const route = this.namedRoutes[routeName];
    if (route === undefined) throw new ContinuationProtocolError(403, "unknown_named_route", "Detached claim route is not configured.");
    const claim = parseClaim(body, this.now(), this.maxDeadlineMs);
    const originConversationId = route.conversationId ?? `continuation-route:${routeName}`;
    const fingerprint = continuationDigest([
      "v1-detached",
      serviceName,
      routeName,
      route.mode,
      route.conversationId ?? "",
    ].join("\0"));
    return await this.claimBound({
      serverName: `detached:${serviceName}`,
      originRunId: `detached:${serviceName}:${claim.taskKey}`,
      originConversationId,
      ...(route.conversationId === undefined ? {} : { replyToConversationId: route.conversationId }),
      mode: route.mode,
      fingerprint,
      closed: false,
      settled: true,
      inFlightOperations: 0,
    }, claim, routeName);
  }

  private async claimBound(
    binding: ClaimBinding,
    claim: ParsedClaim,
    routeName?: string,
  ): Promise<Record<string, unknown>> {
    let created = false;
    const record = await this.store.mutate((records) => {
      const existing = [...records.values()].find((candidate) =>
        candidate.serverName === binding.serverName
        && candidate.originRunId === binding.originRunId
        && candidate.taskKey === claim.taskKey,
      );
      if (existing !== undefined) {
        if (existing.taskHash !== claim.taskHash
          || existing.claimFingerprint !== binding.fingerprint
          || existing.deadline !== claim.deadline) {
          throw new ContinuationProtocolError(409, "claim_conflict", "taskKey was already claimed with different immutable inputs.");
        }
        return structuredClone(existing);
      }
      const active = [...records.values()].filter((candidate) => !TERMINAL_CONTINUATION_STATES.has(candidate.state));
      if (active.length >= this.limits.maxActiveRecords) {
        throw new ContinuationProtocolError(
          429,
          "active_continuation_limit",
          `The service already has its maximum ${String(this.limits.maxActiveRecords)} active continuations.`,
        );
      }
      const activeForOrigin = active.filter((candidate) => candidate.claimFingerprint === binding.fingerprint).length;
      if (activeForOrigin >= this.limits.maxActivePerOrigin) {
        throw new ContinuationProtocolError(
          429,
          "active_origin_limit",
          `This claim origin already has its maximum ${String(this.limits.maxActivePerOrigin)} active continuations.`,
        );
      }
      const now = this.now().toISOString();
      const continuationId = randomUUID();
      const token = this.deriveResultToken(continuationId, claim.taskHash);
      const next: DurableContinuationRecord = {
        continuationId,
        serverName: binding.serverName,
        originRunId: binding.originRunId,
        originConversationId: binding.originConversationId,
        ...(binding.replyToConversationId === undefined ? {} : { replyToConversationId: binding.replyToConversationId }),
        ...(binding.historyBoundary === undefined ? {} : { historyBoundary: binding.historyBoundary }),
        originContextState: binding.historyBoundary === undefined ? "detached_latest" : "pending",
        mode: binding.mode,
        ...(routeName === undefined ? {} : { routeName }),
        taskKey: claim.taskKey,
        taskHash: claim.taskHash,
        claimFingerprint: binding.fingerprint,
        resultTokenHash: continuationDigest(token),
        createdAt: now,
        updatedAt: now,
        deadline: claim.deadline,
        state: "claimed",
        synthesisAttempts: 0,
        synthesisDeferrals: 0,
        deliveryAttempts: 0,
      };
      records.set(continuationId, next);
      created = true;
      return structuredClone(next);
    });
    const token = this.deriveResultToken(record.continuationId, record.taskHash);
    return {
      continuationId: record.continuationId,
      resultUrl: `${this.baseUrl}/v1/continuations/${encodeURIComponent(record.continuationId)}/result`,
      statusUrl: `${this.baseUrl}/v1/continuations/${encodeURIComponent(record.continuationId)}/status`,
      token,
      expiresAt: record.deadline,
      fingerprint: record.claimFingerprint,
      ...(created ? {} : { replayed: true }),
    };
  }

  private async acceptResult(id: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    const object = asObject(body);
    const idempotencyKey = requiredStringField(object, "idempotencyKey", 256);
    if (!("payload" in object)) throw new ContinuationProtocolError(400, "missing_payload", "Result payload is required.");
    const serialized = canonicalContinuationJson(object.payload);
    const payloadHash = continuationDigest(serialized);
    const providedHash = typeof object.payloadHash === "string" ? object.payloadHash : undefined;
    if (providedHash !== undefined && providedHash !== payloadHash) {
      throw new ContinuationProtocolError(400, "payload_hash_mismatch", "Result payload hash does not match the payload.");
    }
    const now = this.now();
    const record = await this.store.mutate((records) => {
      const current = requireRecord(records, id);
      authorizeRecordToken(current, token);
      if (current.resultIdempotencyKey !== undefined) {
        if (current.resultIdempotencyKey !== idempotencyKey || current.resultPayloadHash !== payloadHash) {
          throw new ContinuationProtocolError(409, "result_conflict", "Continuation already has a different immutable result.");
        }
        return structuredClone(current);
      }
      if (current.state !== "claimed") {
        throw new ContinuationProtocolError(409, "result_not_accepted", `Continuation is ${current.state}.`);
      }
      if (Date.parse(current.deadline) <= now.getTime()) {
        expire(current, now.toISOString());
        throw new ContinuationProtocolError(410, "continuation_expired", "Continuation deadline has passed.");
      }
      current.resultIdempotencyKey = idempotencyKey;
      current.resultPayloadHash = payloadHash;
      current.resultPayload = structuredClone(object.payload);
      current.state = "result_received";
      current.updatedAt = now.toISOString();
      return structuredClone(current);
    });
    if (this.autoProcess) void this.processDue().catch(() => undefined);
    return { continuationId: id, state: record.state, accepted: true };
  }

  private async authorizedRecord(id: string, token: string): Promise<DurableContinuationRecord> {
    const record = await this.store.get(id);
    if (record === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
    authorizeRecordToken(record, token);
    return record;
  }

  private authorizeDetached(serviceName: string, token: string): void {
    const expected = this.detachedServiceTokenHashes.get(serviceName);
    if (expected === undefined || !continuationTokenMatches(token, expected)) {
      throw new ContinuationProtocolError(401, "invalid_service_capability", "Invalid detached-service capability.");
    }
  }

  private authorizeOperator(request: IncomingMessage): void {
    if (!continuationTokenMatches(requireBearer(request), continuationDigest(this.operatorToken))) {
      throw new ContinuationProtocolError(401, "invalid_operator_capability", "Invalid operator capability.");
    }
  }

  private deriveResultToken(id: string, taskHash: string): string {
    return createHmac("sha256", this.secret).update(`continuation-result\0${id}\0${taskHash}`).digest("base64url");
  }

  private handleRequestError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    const protocol = error instanceof ContinuationProtocolError
      ? error
      : new ContinuationProtocolError(500, "internal_error", "Continuation request failed.");
    if (!(error instanceof ContinuationProtocolError)) {
      this.logger?.error?.("Continuation request failed.", { reason: safeReason(error) });
    }
    sendJson(response, protocol.status, { error: { code: protocol.code, message: protocol.message } });
  }

  private throwIfStopping(): void {
    if (this.stopped || this.lifecycleAbort.signal.aborted) {
      throw new ContinuationServiceStoppingError();
    }
  }

  private async runBoundedOperation<T>(
    phase: "synthesis" | "delivery",
    timeoutMs: number,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.throwIfStopping();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ContinuationOperationTimeoutError(phase, timeoutMs)), timeoutMs);
      timeout.unref?.();
    });
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ContinuationServiceStoppingError());
      this.lifecycleAbort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timedOut, stopped]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) this.lifecycleAbort.signal.removeEventListener("abort", onAbort);
    }
  }

  private async stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    await this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    this.lifecycleAbort.abort();
    if (this.worker !== undefined) clearInterval(this.worker);
    this.worker = undefined;
    const bindings = [...this.activeClaimBindings];
    for (const binding of bindings) binding.closed = true;
    this.claimBindings.clear();
    const server = this.server;
    this.server = undefined;
    try {
      if (server !== undefined) {
        await closeContinuationServer(server);
      }
      while (this.activeHttpRequests.size > 0) {
        await Promise.allSettled([...this.activeHttpRequests]);
      }
      await this.drainHandleOperations();
      await Promise.all(bindings.map(async (binding) => {
        if (binding.inFlightOperations === 0) return;
        binding.drainPromise ??= new Promise<void>((resolve) => { binding.resolveDrain = resolve; });
        await binding.drainPromise;
      }));
      await this.dispatchTail.catch(() => undefined);
      await Promise.allSettled([...this.inFlight.values()]);
      const fingerprints = new Set(bindings.map((binding) => binding.fingerprint));
      if (fingerprints.size > 0) {
        const at = this.now().toISOString();
        try {
          await this.store.mutate((records) => {
            for (const record of records.values()) {
              if (!fingerprints.has(record.claimFingerprint) || record.originContextState !== "pending") continue;
              record.originContextState = "abandoned";
              delete record.originContextRef;
              record.updatedAt = at;
              record.lastError = errorRecord(
                "origin_context_unavailable",
                "The origin service stopped before its pinned continuation context committed.",
                at,
              );
              delete record.nextAttemptAt;
              clearLease(record);
            }
          });
        } catch (error) {
          // A prior durable transaction may already have poisoned this store.
          // Shutdown must still revoke stale closures and release OS ownership;
          // restart recovery deterministically abandons any remaining pending
          // origin records before processing them.
          this.logger?.warn?.("Continuation origin settlement will finish during restart recovery.", {
            reason: safeReason(error),
          });
        }
      }
      for (const binding of bindings) this.settleClaimBinding(binding);
    } finally {
      await this.releaseStoreLock();
    }
  }
}

/** Derive the restart-stable local operator capability from the owner-only service secret. */
export function continuationOperatorToken(secret: Uint8Array): string {
  return createHmac("sha256", secret).update("mono-agent-continuation-operator-v1").digest("base64url");
}

interface ParsedClaim {
  readonly taskKey: string;
  readonly taskHash: string;
  readonly deadline: string;
}

function parseClaim(body: unknown, now: Date, maxDeadlineMs: number): ParsedClaim {
  const object = asObject(body);
  const taskKey = requiredStringField(object, "taskKey", MAX_TASK_KEY_CHARS);
  const taskHash = requiredStringField(object, "taskHash", 256);
  const deadline = requiredStringField(object, "deadline", 64);
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now.getTime()) {
    throw new ContinuationProtocolError(400, "invalid_deadline", "Claim deadline must be a future ISO timestamp.");
  }
  if (deadlineMs - now.getTime() > maxDeadlineMs) {
    throw new ContinuationProtocolError(400, "deadline_too_far", "Claim deadline exceeds the configured maximum.");
  }
  return { taskKey, taskHash, deadline: new Date(deadlineMs).toISOString() };
}

function statusOf(record: DurableContinuationRecord | undefined): ContinuationStatusSnapshot | undefined {
  return record === undefined ? undefined : statusOfRequired(record);
}

function statusOfRequired(record: DurableContinuationRecord): ContinuationStatusSnapshot {
  return {
    continuationId: record.continuationId,
    state: record.state,
    mode: record.mode,
    taskKey: record.taskKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deadline: record.deadline,
    attempts: { synthesis: record.synthesisAttempts, delivery: record.deliveryAttempts },
    synthesisDeferrals: record.synthesisDeferrals,
    originContext: {
      state: record.originContextState,
      ...(record.originContextDigest === undefined ? {} : { digest: record.originContextDigest }),
      ...(record.originContextMessageCount === undefined ? {} : { messageCount: record.originContextMessageCount }),
    },
    ...(record.completionKind === undefined ? {} : { completionKind: record.completionKind }),
    ...(record.nextAttemptAt === undefined ? {} : { nextAttemptAt: record.nextAttemptAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.receipt === undefined ? {} : { receipt: record.receipt }),
  };
}

function requireRecord(records: Map<string, DurableContinuationRecord>, id: string): DurableContinuationRecord {
  const record = records.get(id);
  if (record === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
  return record;
}

function synthesisInput(
  record: DurableContinuationRecord,
  originContext: Extract<ResolvedOriginContext, { readonly kind: "ready" }>,
): ContinuationSynthesisInput {
  const common = {
    continuationId: record.continuationId,
    originConversationId: record.originConversationId,
    originRunId: record.originRunId,
    ...(record.replyToConversationId === undefined ? {} : { replyToConversationId: record.replyToConversationId }),
    mode: record.mode,
    payload: record.resultPayload,
  };
  if (originContext.policy === "detached_latest") {
    return { ...common, originContextPolicy: "detached_latest" };
  }
  if (record.historyBoundary === undefined) {
    throw new Error(`Pinned continuation ${record.continuationId} is missing its history boundary.`);
  }
  return {
    ...common,
    historyBoundary: record.historyBoundary,
    originContextPolicy: "pinned",
    originContext: originContext.snapshot,
  };
}

function originContextBindingMac(
  secret: Uint8Array,
  record: DurableContinuationRecord,
  reference: ContinuationOriginContextReference,
): string {
  return createHmac("sha256", secret).update(canonicalContinuationJson({
    version: 2,
    continuationId: record.continuationId,
    claimFingerprint: record.claimFingerprint,
    serverName: record.serverName,
    originRunId: record.originRunId,
    originConversationId: record.originConversationId,
    replyToConversationId: record.replyToConversationId ?? null,
    historyBoundary: record.historyBoundary ?? null,
    mode: record.mode,
    routeName: record.routeName ?? null,
    taskKey: record.taskKey,
    taskHash: record.taskHash,
    resultTokenHash: record.resultTokenHash,
    createdAt: record.createdAt,
    deadline: record.deadline,
    originContextDigest: reference.digest,
    originContextBytes: reference.bytes,
    originContextMessageCount: reference.messageCount,
  })).digest("hex");
}

function requireLease(record: DurableContinuationRecord, owner: string): void {
  if (record.leaseOwner !== owner) throw new ContinuationProtocolError(409, "lease_lost", "Continuation processing lease was lost.");
}

function clearLease(record: DurableContinuationRecord): void {
  delete record.leaseOwner;
  delete record.leaseUntil;
}

function expire(record: DurableContinuationRecord, at: string): void {
  record.state = "expired";
  record.updatedAt = at;
  record.lastError = errorRecord("deadline_expired", "Continuation deadline passed before delivery completed.", at);
  clearLease(record);
}

function errorRecord(code: string, reason: string, at: string): NonNullable<DurableContinuationRecord["lastError"]> {
  return { code: bounded(code, 128), reason: bounded(reason, 1_000), at };
}

function authorizeRecordToken(record: DurableContinuationRecord, token: string): void {
  if (!continuationTokenMatches(token, record.resultTokenHash)) {
    throw new ContinuationProtocolError(401, "invalid_result_capability", "Invalid continuation result capability.");
  }
}

function validateNamedRoutes(routes: Readonly<Record<string, NamedContinuationRoute>>): void {
  for (const [name, route] of Object.entries(routes)) {
    if (name.trim().length === 0 || name.length > 128) throw new Error("Continuation route names must be 1-128 characters.");
    if ((route.mode === "notify_if_actionable" || route.mode === "capture") && !route.conversationId?.trim()) {
      throw new Error(`Continuation route ${name} requires conversationId.`);
    }
    if (route.mode === "silent" && route.conversationId !== undefined) {
      throw new Error(`Continuation route ${name} cannot set conversationId for mode ${route.mode}.`);
    }
  }
}

function resolveContinuationLimits(input: Partial<ContinuationLimits> | undefined): ContinuationLimits {
  const maxActiveRecords = input?.maxActiveRecords ?? DEFAULT_CONTINUATION_LIMITS.maxActiveRecords;
  const limits: ContinuationLimits = {
    ...DEFAULT_CONTINUATION_LIMITS,
    ...input,
    maxActiveRecords,
    maxActivePerOrigin: input?.maxActivePerOrigin
      ?? Math.min(DEFAULT_CONTINUATION_LIMITS.maxActivePerOrigin, maxActiveRecords),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Continuation limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxActiveRecords > 1_000_000) throw new Error("Continuation maxActiveRecords cannot exceed 1000000.");
  if (limits.maxActivePerOrigin > limits.maxActiveRecords) {
    throw new Error("Continuation maxActivePerOrigin cannot exceed maxActiveRecords.");
  }
  if (limits.maxConcurrent > 256) throw new Error("Continuation maxConcurrent cannot exceed 256.");
  if (limits.synthesisTimeoutMs > 24 * 60 * 60 * 1_000 || limits.deliveryTimeoutMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Continuation operation timeouts cannot exceed 24 hours.");
  }
  if (limits.operatorPageSize > MAX_OPERATOR_PAGE_SIZE) {
    throw new Error(`Continuation operatorPageSize cannot exceed ${String(MAX_OPERATOR_PAGE_SIZE)}.`);
  }
  return limits;
}

function operatorContinuationPage(
  records: readonly DurableContinuationRecord[],
  url: URL,
  configuredPageSize: number,
): Record<string, unknown> {
  const rawLimit = url.searchParams.get("limit");
  let limit = configuredPageSize;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
      throw new ContinuationProtocolError(400, "invalid_page_limit", "Operator list limit must be a positive integer.");
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > configuredPageSize || limit > MAX_OPERATOR_PAGE_SIZE) {
      throw new ContinuationProtocolError(
        400,
        "invalid_page_limit",
        `Operator list limit cannot exceed ${String(Math.min(configuredPageSize, MAX_OPERATOR_PAGE_SIZE))}.`,
      );
    }
  }
  const cursor = parseOperatorCursor(url.searchParams.get("cursor"));
  const ordered = [...records].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.continuationId.localeCompare(left.continuationId));
  const eligible = cursor === undefined
    ? ordered
    : ordered.filter((record) =>
      record.createdAt < cursor.createdAt
      || (record.createdAt === cursor.createdAt && record.continuationId < cursor.continuationId));
  const selected = eligible.slice(0, limit);
  const last = selected.at(-1);
  return {
    continuations: selected.map(statusOfRequired),
    pageSize: limit,
    ...(eligible.length <= limit || last === undefined
      ? {}
      : { nextCursor: encodeOperatorCursor(last) }),
  };
}

function encodeOperatorCursor(record: DurableContinuationRecord): string {
  return Buffer.from(JSON.stringify([record.createdAt, record.continuationId]), "utf8").toString("base64url");
}

function parseOperatorCursor(value: string | null): { readonly createdAt: string; readonly continuationId: string } | undefined {
  if (value === null) return undefined;
  try {
    if (value.length === 0 || value.length > 512) throw new Error("invalid");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded)
      || decoded.length !== 2
      || typeof decoded[0] !== "string"
      || !Number.isFinite(Date.parse(decoded[0]))
      || typeof decoded[1] !== "string"
      || decoded[1].length === 0
      || decoded[1].length > 128) {
      throw new Error("invalid");
    }
    return { createdAt: decoded[0], continuationId: decoded[1] };
  } catch {
    throw new ContinuationProtocolError(400, "invalid_page_cursor", "Operator list cursor is invalid.");
  }
}

async function closeContinuationServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    let forced: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (forced !== undefined) clearTimeout(forced);
      if (error === undefined) resolveClose();
      else reject(error);
    };
    server.close((error) => finish(error));
    server.closeIdleConnections?.();
    forced = setTimeout(() => {
      // An incomplete/slow request must not hold config reload or process
      // shutdown forever. Result and claim writes are idempotent, so callers
      // can safely retry a connection terminated at this boundary.
      server.closeAllConnections?.();
    }, 5_000);
  });
}

function requireBearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new ContinuationProtocolError(401, "missing_capability", "Bearer capability is required.");
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length === 0 || token.length > 512) {
    throw new ContinuationProtocolError(401, "invalid_capability", "Bearer capability is invalid.");
  }
  return token;
}

function requireHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new ContinuationProtocolError(400, "missing_service_name", "Detached service name header is required.");
  }
  return value;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new ContinuationProtocolError(413, "payload_too_large", "Request body exceeds the configured limit.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ContinuationProtocolError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContinuationProtocolError(400, "invalid_body", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredStringField(object: Record<string, unknown>, key: string, max = 512): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ContinuationProtocolError(400, `invalid_${key}`, `${key} must be a non-empty string up to ${String(max)} characters.`);
  }
  return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(encoded));
  response.end(encoded);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function backoffMs(attempt: number, base: number, cap: number): number {
  const exponential = Math.min(cap, base * (2 ** Math.max(0, attempt - 1)));
  const deterministicJitter = 0.75 + ((attempt * 1103515245 + 12345) % 500) / 1_000;
  return Math.max(base, Math.floor(exponential * deterministicJitter));
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function safeReason(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1_000);
}

function boundedHistoryErrorCode(value: string): string {
  const normalized = value.trim().slice(0, 128);
  return normalized.length === 0 ? "history_record_failed" : normalized;
}
