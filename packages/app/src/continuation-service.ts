import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { createContinuationHttpRoutes } from "./continuation-http-routes.js";
import { createContinuationOperatorOperations } from "./continuations/operator-operations.js";
import { createContinuationProtocolOperations } from "./continuations/protocol-operations.js";
import { createContinuationDispatchOperations } from "./continuation-dispatch-worker.js";
import { createContinuationOriginOperations } from "./continuation-service-origin.js";
import {
  ContinuationOperationTimeoutError,
  ContinuationProtocolError,
  ContinuationServiceStoppingError,
} from "./continuation-service-errors.js";
import { acquireSqliteLease } from "./durable-state/sqlite-lease.js";
import { loadOrCreateContinuationSecret } from "./continuation-secret.js";
import { openContinuationStore, type ContinuationStore } from "./continuation-store.js";
import {
  clearLease,
  closeContinuationServer,
  continuationOperatorToken,
  errorRecord,
  formatHost,
  isLoopbackHost,
  operatorContinuationPage,
  originContextBindingMac,
  requireBearer,
  resolveContinuationLimits,
  safeReason,
  statusOf,
  statusOfRequired,
  validateNamedRoutes,
} from "./continuation-service-helpers.js";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_DEADLINE_MS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_WORKER_INTERVAL_MS,
  type ClaimBinding,
  type ContinuationServiceHandle,
  type ContinuationServiceLogger,
  type ContinuationServiceOptions,
} from "./continuation-service-types.js";
import {
  CONTINUATION_CLAIM_TOKEN_ENV,
  CONTINUATION_CLAIM_TOKEN_HEADER,
  CONTINUATION_CLAIM_URL_ENV,
  CONTINUATION_CLAIM_URL_HEADER,
  CONTINUATION_FINGERPRINT_ENV,
  CONTINUATION_FINGERPRINT_HEADER,
  CONTINUATION_MODE_ENV,
  CONTINUATION_MODE_HEADER,
  continuationDigest,
  continuationTokenMatches,
  normalizeContinuationReplyTarget,
  type ContinuationClaimCapability,
  type ContinuationLimits,
  type IssueContinuationCapabilityInput,
  type NamedContinuationRoute,
} from "./continuations.js";

export { ContinuationSynthesisUnavailableError } from "./continuation-service-errors.js";
export { continuationOperatorToken } from "./continuation-service-helpers.js";
export type { ContinuationServiceHandle } from "./continuation-service-types.js";

export async function startContinuationService(
  options: ContinuationServiceOptions,
): Promise<ContinuationServiceHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`Continuation service must bind to loopback, received ${host}.`);
  }
  validateNamedRoutes(options.namedRoutes ?? {});
  const stateDir = resolve(options.stateDir ?? resolve(options.cwd ?? process.cwd(), ".mono-agent", "continuations"));
  const lock = await acquireSqliteLease(stateDir);
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
  private readonly origin: ReturnType<typeof createContinuationOriginOperations>;
  private readonly dispatch: ReturnType<typeof createContinuationDispatchOperations>;

  private readonly protocol: ReturnType<typeof createContinuationProtocolOperations>;
  private readonly operator: ReturnType<typeof createContinuationOperatorOperations>;
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
    this.origin = createContinuationOriginOperations({
      store: this.store,
      now: () => this.now(),
      instanceId: this.instanceId,
      isStopped: () => this.stopped,
      beginSettlement: (binding) => this.beginOriginSettlementOperation(binding),
      claimDrain: (binding) => this.claimDrain(binding),
      settleBinding: (binding) => this.settleClaimBinding(binding),
      bindingMac: (record, reference) => originContextBindingMac(this.secret, record, reference),
      scheduleProcess: () => this.scheduleProcess(),
    });
    this.dispatch = createContinuationDispatchOperations({
      store: this.store,
      now: () => this.now(),
      instanceId: this.instanceId,
      leaseMs: this.leaseMs,
      limits: this.limits,
      synthesisPreflight: this.options.synthesisPreflight,
      synthesize: this.options.synthesize,
      deliver: this.options.deliver,
      isStopped: () => this.stopped,
      isSupervised: (id) => this.inFlight.has(id),
      startDueJobs: async (limit) => await this.startDueJobs(limit),
      throwIfStopping: () => this.throwIfStopping(),
      resolveOriginContext: async (record) => await this.origin.resolveOriginContext(record),
      runBoundedOperation: async (phase, timeoutMs, operation) => await this.runBoundedOperation(phase, timeoutMs, operation),
    });
    this.protocol = createContinuationProtocolOperations({
      store: this.store,
      now: () => this.now(),
      maxDeadlineMs: this.maxDeadlineMs,
      limits: this.limits,
      namedRoutes: this.namedRoutes,
      baseUrl: () => this.baseUrl,
      deriveResultToken: (id, taskHash) => createHmac("sha256", this.secret).update(`continuation-result\0${id}\0${taskHash}`).digest("base64url"),
      scheduleProcess: () => this.scheduleProcess(),
    });
    this.operator = createContinuationOperatorOperations({
      store: this.store,
      now: () => this.now(),
      limits: this.limits,
      recordHistory: this.options.recordHistory,
      scheduleProcess: () => this.scheduleProcess(),
      isResolvingUnknown: (id) => this.resolvingUnknown.has(id),
      beginResolvingUnknown: (id) => { this.resolvingUnknown.add(id); },
      finishResolvingUnknown: (id) => { this.resolvingUnknown.delete(id); },
      runBoundedOperation: async (phase, timeoutMs, operation) => await this.runBoundedOperation(phase, timeoutMs, operation),
    });
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

  private claimDrain(binding: ClaimBinding): Promise<void> | undefined {
    if (binding.inFlightOperations <= 0) return undefined;
    binding.drainPromise ??= new Promise<void>((resolve) => { binding.resolveDrain = resolve; });
    return binding.drainPromise;
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

  private async startDueJobs(limit: number): Promise<readonly Promise<boolean>[]> {
    const dispatch = this.dispatchTail.then(async () => {
      if (this.stopped) return [];
      await this.dispatch.recover();
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
          ))
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
    const job = this.dispatch.processOne(id);
    this.inFlight.set(id, job);
    void job.then(
      () => { if (this.inFlight.get(id) === job) this.inFlight.delete(id); },
      () => { if (this.inFlight.get(id) === job) this.inFlight.delete(id); },
    );
    return job;
  }

  async recover(startup = false): Promise<void> { await this.dispatch.recover(startup); }

  private async processDue(limit?: number): Promise<number> { return await this.dispatch.processDue(limit); }

  private scheduleProcess(): void {
    if (this.autoProcess) void this.processDue().catch(() => undefined);
  }

  async start(host: string, port: number): Promise<ContinuationServiceHandle> {
    const routes = createContinuationHttpRoutes({
      ...this.operator,
      maxResultBytes: this.maxResultBytes,
      logger: this.logger,
      isStopped: () => this.stopped,
      baseUrl: () => this.baseUrl,
      authorizeRunClaim: (token) => {
        const binding = this.claimBindings.get(token);
        if (binding === undefined) throw new ContinuationProtocolError(401, "invalid_claim_capability", "Invalid or expired claim capability.");
        return async (body, write) => {
          const finishClaim = this.beginClaim(binding);
          try { write(await this.protocol.claim(binding, body)); } finally { finishClaim(); }
        };
      },
      authorizeDetached: (serviceName, token) => {
        const expected = this.detachedServiceTokenHashes.get(serviceName);
        if (expected === undefined || !continuationTokenMatches(token, expected)) {
          throw new ContinuationProtocolError(401, "invalid_service_capability", "Invalid detached-service capability.");
        }
      },
      authorizeOperator: (request) => {
        if (!continuationTokenMatches(requireBearer(request), continuationDigest(this.operatorToken))) {
          throw new ContinuationProtocolError(401, "invalid_operator_capability", "Invalid operator capability.");
        }
      },
      claimDetached: async (name, body) => await this.protocol.claimDetached(name, body),
      acceptResult: async (id, token, body) => await this.protocol.acceptResult(id, token, body),
      authorizedRecord: async (id, token) => await this.protocol.authorizedRecord(id, token),
      list: async (url) => operatorContinuationPage(await this.store.list(), url, this.limits.operatorPageSize),
    });
    const server = createServer((request, response) => {
      const operation = routes.handleRequest(request, response).catch((error: unknown) => {
        routes.handleRequestError(response, error);
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
    if (address === null || typeof address === "string") {
      throw new Error("Continuation service has no TCP address.");
    }
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
      health: async () => await this.runHandleOperation(async () => await this.operator.health()),
      processDue: async (limit) => await this.runHandleOperation(async () => await this.processDue(limit)),
      retry: async (id, retryOptions) => await this.runHandleOperation(async () => await this.operator.retry(id, retryOptions)),
      cancel: async (id) => await this.runHandleOperation(async () => await this.operator.cancel(id)),
      resolveUnknown: async (id, outcome) => await this.runHandleOperation(
        async () => await this.operator.resolveUnknown(id, outcome),
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
      requiresOriginContext: async () => await this.origin.requiresOriginContext(binding),
      finalizeOriginContext: async (snapshot) => await this.origin.finalizeOriginContext(binding, snapshot),
      activateOriginContext: async () => await this.origin.activateOriginContext(binding),
      abandonOriginContext: async () => await this.origin.abandonOriginContext(binding),
      release: async () => {
        if (released) return;
        released = true;
        await this.closeClaimBinding(token, binding);
      },
    };
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
