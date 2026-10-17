import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { createContinuationHttpRoutes } from "./continuation-http-routes.js";
import { createContinuationOperatorOperations } from "./continuations/operator-operations.js";
import { createContinuationProtocolOperations } from "./continuations/protocol-operations.js";
import { ContinuationDispatchWorker } from "./continuation-dispatch-worker.js";
import { ContinuationProtocolError } from "./continuation-service-errors.js";
import { operatorContinuationPage, requireBearer } from "./continuation-service-helpers.js";
import { acquireSqliteLease } from "./durable-state/sqlite-lease.js";
import { loadOrCreateContinuationSecret } from "./continuation-secret.js";
import { openContinuationStore } from "./continuation-store.js";
import {
  clearLease,
  closeContinuationServer,
  errorRecord,
  formatHost,
  isLoopbackHost,
  safeReason,
  statusOf,
  statusOfRequired,
  validateNamedRoutes,
} from "./continuation-service-helpers.js";
import type {
  ClaimBinding,
  ContinuationServiceHandle,
  ContinuationServiceOptions,
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
  type IssueContinuationCapabilityInput,
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

class ContinuationService extends ContinuationDispatchWorker {
  private readonly protocol = createContinuationProtocolOperations({
    store: this.store, now: this.now, maxDeadlineMs: this.maxDeadlineMs, limits: this.limits, namedRoutes: this.namedRoutes,
    baseUrl: () => this.baseUrl,
    deriveResultToken: (id, taskHash) => createHmac("sha256", this.secret).update(`continuation-result\0${id}\0${taskHash}`).digest("base64url"),
    scheduleProcess: () => this.scheduleProcess(),
  });
  private readonly operator = createContinuationOperatorOperations({
    store: this.store, now: this.now, limits: this.limits, recordHistory: this.options.recordHistory,
    scheduleProcess: () => this.scheduleProcess(),
    isResolvingUnknown: (id) => this.resolvingUnknown.has(id),
    beginResolvingUnknown: (id) => { this.resolvingUnknown.add(id); },
    finishResolvingUnknown: (id) => { this.resolvingUnknown.delete(id); },
    runBoundedOperation: async (phase, timeoutMs, operation) => await this.runBoundedOperation(phase, timeoutMs, operation),
  });

  private scheduleProcess(): void {
    if (this.autoProcess) void this.processDue().catch(() => undefined);
  }

  async start(host: string, port: number): Promise<ContinuationServiceHandle> {
    const routes = createContinuationHttpRoutes({
      ...this.operator,
      maxResultBytes: this.maxResultBytes, logger: this.logger,
      isStopped: () => this.stopped, baseUrl: () => this.baseUrl,
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
