import { randomUUID } from "node:crypto";

import {
  PROVIDER_AUTH_CHECK_SCHEMA,
  ProviderAuthOperationError,
  type ProviderAuthCheckOperator,
  type ProviderAuthCheckResult,
  type ProviderAuthCheckResultCode,
  type ProviderAuthCheckSessionSnapshot,
  type ProviderAuthStatusSnapshot,
} from "@mono-agent/agent-contracts";
import { resolveConfiguredProviders } from "@mono-agent/config";
import { runPiProviderCheck } from "@mono-agent/agent-runtime/ai";
import {
  createPiOAuthApiKeyResolver,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
  type LocalProviderDefinition,
  type RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

import { selectProviderAuthCheckModel } from "./provider-model-catalog.js";
import type { ProviderAuthObservationTracker } from "./provider-auth-observations.js";
import { providerAuthStatusSnapshot, type ProviderAuthStatusOptions } from "./provider-auth-status.js";

const CHECK_RETENTION_MS = 10 * 60 * 1_000;
const CHECK_COOLDOWN_MS = 60 * 1_000;
const PROVIDER_TIMEOUT_MS = 30 * 1_000;
const BATCH_TIMEOUT_MS = 120 * 1_000;
const MAX_CONCURRENCY = 2;

export interface ProviderAuthCheckExecution {
  readonly state: "passed" | "auth_failed" | "network_failed" | "quota_limited" | "model_not_entitled" | "inconclusive";
  readonly code: ProviderAuthCheckResultCode;
  readonly message: string;
}

interface LiveCheckSession {
  snapshot: ProviderAuthCheckSessionSnapshot;
  readonly idempotencyKey: string;
  readonly abort: AbortController;
  readonly providerAborts: Map<string, AbortController>;
  readonly revisions: ReadonlyMap<string, number>;
  run?: Promise<void>;
  retention?: ReturnType<typeof setTimeout>;
  batchTimeout?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  batchTimedOut: boolean;
}

interface PendingCheckAdmission {
  readonly idempotencyKey: string;
  readonly promise: Promise<ProviderAuthCheckSessionSnapshot>;
  readonly resolve: (snapshot: ProviderAuthCheckSessionSnapshot) => void;
  readonly reject: (error: unknown) => void;
  cancelled: boolean;
}

export interface ProviderAuthCheckManager extends ProviderAuthCheckOperator {
  isActive(): boolean;
  credentialPersisted(providerId: string): void;
  stop(): Promise<void>;
}

export interface CreateProviderAuthCheckManagerOptions extends ProviderAuthStatusOptions {
  readonly observations: ProviderAuthObservationTracker;
  readonly isLoginActive: () => boolean;
  readonly now?: () => number;
  readonly execute?: (
    model: RuntimeModelReference,
    signal: AbortSignal,
  ) => Promise<ProviderAuthCheckExecution>;
  /** Deterministic test seam for the passive snapshot prepared before a batch. */
  readonly statusSnapshot?: () => Promise<ProviderAuthStatusSnapshot>;
  readonly providerTimeoutMs?: number;
  readonly batchTimeoutMs?: number;
  readonly cooldownMs?: number;
}

export function createProviderAuthCheckManager(
  options: CreateProviderAuthCheckManagerOptions,
): ProviderAuthCheckManager {
  const sessions = new Map<string, LiveCheckSession>();
  const byIdempotencyKey = new Map<string, string>();
  const credentialRevisions = new Map<string, number>();
  const now = options.now ?? Date.now;
  const providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  const batchTimeoutMs = options.batchTimeoutMs ?? BATCH_TIMEOUT_MS;
  const cooldownMs = options.cooldownMs ?? CHECK_COOLDOWN_MS;
  let lastTerminalAt = Number.NEGATIVE_INFINITY;
  let stopping = false;
  let pendingAdmission: PendingCheckAdmission | undefined;

  const current = () => [...sessions.values()].find((session) => session.snapshot.state === "running");
  const replaceResult = (session: LiveCheckSession, providerId: string, result: ProviderAuthCheckResult) => {
    session.snapshot = {
      ...session.snapshot,
      updatedAt: new Date(now()).toISOString(),
      results: session.snapshot.results.map((candidate) => candidate.providerId === providerId ? result : candidate),
    };
  };
  const finish = (session: LiveCheckSession, state: "completed" | "cancelled") => {
    if (session.snapshot.state !== "running") return;
    if (session.batchTimeout !== undefined) clearTimeout(session.batchTimeout);
    const finishedAt = new Date(now()).toISOString();
    session.snapshot = {
      ...session.snapshot,
      state,
      updatedAt: finishedAt,
      expiresAt: new Date(now() + CHECK_RETENTION_MS).toISOString(),
    };
    lastTerminalAt = now();
    session.retention = setTimeout(() => {
      sessions.delete(session.snapshot.id);
      if (byIdempotencyKey.get(session.idempotencyKey) === session.snapshot.id) {
        byIdempotencyKey.delete(session.idempotencyKey);
      }
    }, CHECK_RETENTION_MS);
    session.retention.unref?.();
  };

  const execute = options.execute ?? defaultExecutor(options);
  const runOne = async (session: LiveCheckSession, result: ProviderAuthCheckResult) => {
    if (result.model === undefined || result.selectionBasis === undefined) return;
    if (session.abort.signal.aborted) {
      replaceResult(session, result.providerId, terminalResult(result, session.batchTimedOut ? "not_run" : "cancelled", now));
      return;
    }
    replaceResult(session, result.providerId, { ...result, state: "running" });
    const controller = new AbortController();
    session.providerAborts.set(result.providerId, controller);
    const abort = () => controller.abort(session.abort.signal.reason);
    session.abort.signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Provider check timed out."));
    }, providerTimeoutMs);
    timeout.unref?.();
    let outcome: ProviderAuthCheckExecution;
    try {
      const aborted = new Promise<ProviderAuthCheckExecution>((resolve) => {
        if (controller.signal.aborted) {
          resolve(inconclusive());
          return;
        }
        controller.signal.addEventListener("abort", () => resolve(inconclusive()), { once: true });
      });
      const executed = execute(parseMonoRuntimeModelReference(result.model), controller.signal)
        .catch(() => inconclusive());
      outcome = await Promise.race([executed, aborted]);
    } finally {
      clearTimeout(timeout);
      session.abort.signal.removeEventListener("abort", abort);
      session.providerAborts.delete(result.providerId);
    }
    const checkedAt = new Date(now()).toISOString();
    const revision = credentialRevisions.get(result.providerId) ?? 0;
    const capturedRevision = session.revisions.get(result.providerId) ?? 0;
    const state = revision !== capturedRevision
      ? "stale"
      : timedOut || session.batchTimedOut
        ? "timeout"
        : session.cancelled
          ? "cancelled"
          : outcome.state;
    const finalResult: ProviderAuthCheckResult = {
      ...result,
      state,
      checkedAt,
      code: revision !== capturedRevision ? "stale"
        : timedOut || session.batchTimedOut ? "timeout"
          : session.cancelled ? "cancelled"
            : outcome.code,
      message: state === "stale" ? "Credential changed before the check completed."
        : state === "timeout" ? "The provider check timed out."
          : state === "cancelled" ? "The provider check was cancelled."
            : outcome.message,
    };
    replaceResult(session, result.providerId, finalResult);
    if (state === "passed") options.observations.recordSuccess(result.providerId, result.model, checkedAt);
    else if (state === "auth_failed") options.observations.recordFailure(result.providerId, result.model, "provider_auth", checkedAt);
    else if (state === "network_failed" || state === "timeout") {
      options.observations.recordFailure(result.providerId, result.model, "provider_unavailable", checkedAt);
    } else if (state === "quota_limited" || state === "model_not_entitled" || state === "inconclusive") {
      options.observations.invalidate(result.providerId, checkedAt);
    }
  };

  const runBatch = async (session: LiveCheckSession) => {
    let index = 0;
    const selected = session.snapshot.results.filter((result) => result.state === "pending");
    const worker = async () => {
      while (index < selected.length) {
        const next = selected[index++];
        if (next === undefined) return;
        await runOne(session, next);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, selected.length) }, worker));
    if (session.batchTimedOut) {
      for (const result of session.snapshot.results) {
        if (result.state === "pending") replaceResult(session, result.providerId, terminalResult(result, "not_run", now));
      }
    }
    finish(session, session.cancelled ? "cancelled" : "completed");
  };

  const conflict = (message = "Another provider authentication operation is already active.") =>
    new ProviderAuthOperationError("provider_auth_conflict", message, 409);

  const prepare = async (admission: PendingCheckAdmission) => {
    try {
      const status = await (options.statusSnapshot?.() ?? providerAuthStatusSnapshot(options));
      if (admission.cancelled || stopping || pendingAdmission !== admission) {
        throw conflict("Provider authentication is stopping.");
      }
      if (options.isLoginActive() || current() !== undefined) throw conflict();
      const resolvedProviders = resolveConfiguredProviders(options.config);
      const configuredRoutes = status.providers.flatMap((provider) => provider.usages.flatMap((usage) => {
        try { return [parseMonoRuntimeModelReference(usage.model)]; } catch { return []; }
      }));
      const results: ProviderAuthCheckResult[] = status.providers.map((provider) => {
        const selection = selectProviderAuthCheckModel(provider.providerId, {
          providers: resolvedProviders.entries,
          configuredRoutes,
        });
        return selection.kind === "selected"
          ? {
              providerId: provider.providerId,
              label: provider.label,
              state: "pending",
              model: selection.model.reference,
              selectionBasis: selection.selectionBasis,
            }
          : {
              providerId: provider.providerId,
              label: provider.label,
              state: "unsupported",
              code: selection.code,
              message: selection.message,
              checkedAt: new Date(now()).toISOString(),
            };
      });
      const createdAt = new Date(now()).toISOString();
      const session: LiveCheckSession = {
        snapshot: {
          schema: PROVIDER_AUTH_CHECK_SCHEMA,
          id: randomUUID(),
          state: "running",
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date(now() + CHECK_RETENTION_MS).toISOString(),
          results,
        },
        idempotencyKey: admission.idempotencyKey,
        abort: new AbortController(),
        providerAborts: new Map(),
        revisions: new Map(status.providers.map((provider) => [provider.providerId, credentialRevisions.get(provider.providerId) ?? 0])),
        cancelled: false,
        batchTimedOut: false,
      };
      sessions.set(session.snapshot.id, session);
      byIdempotencyKey.set(admission.idempotencyKey, session.snapshot.id);
      if (pendingAdmission === admission) pendingAdmission = undefined;
      session.batchTimeout = setTimeout(() => {
        session.batchTimedOut = true;
        session.abort.abort(new Error("Provider check batch timed out."));
      }, batchTimeoutMs);
      session.batchTimeout.unref?.();
      session.run = runBatch(session);
      await Promise.resolve();
      admission.resolve(session.snapshot);
    } catch (error) {
      admission.reject(error);
    } finally {
      if (pendingAdmission === admission) pendingAdmission = undefined;
    }
  };

  return {
    isActive: () => pendingAdmission !== undefined || current() !== undefined,
    start(input) {
      if (stopping) return Promise.reject(conflict("Provider authentication is stopping."));
      const replayId = byIdempotencyKey.get(input.idempotencyKey);
      if (replayId !== undefined) {
        const replay = sessions.get(replayId);
        if (replay !== undefined) return Promise.resolve(replay.snapshot);
      }
      if (pendingAdmission !== undefined) {
        return pendingAdmission.idempotencyKey === input.idempotencyKey
          ? pendingAdmission.promise
          : Promise.reject(conflict());
      }
      if (options.isLoginActive() || current() !== undefined) {
        return Promise.reject(conflict());
      }
      if (now() - lastTerminalAt < cooldownMs) {
        const remainingMs = cooldownMs - (now() - lastTerminalAt);
        return Promise.reject(new ProviderAuthOperationError(
          "provider_auth_rate_limited",
          "Wait before running provider checks again.",
          429,
          Math.max(1, Math.ceil(remainingMs / 1_000)),
        ));
      }
      let resolve!: PendingCheckAdmission["resolve"];
      let reject!: PendingCheckAdmission["reject"];
      const promise = new Promise<ProviderAuthCheckSessionSnapshot>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const admission: PendingCheckAdmission = {
        idempotencyKey: input.idempotencyKey,
        promise,
        resolve,
        reject,
        cancelled: false,
      };
      pendingAdmission = admission;
      void prepare(admission);
      return promise;
    },
    async get(checkId) {
      return sessions.get(checkId)?.snapshot;
    },
    async cancel(checkId) {
      const session = sessions.get(checkId);
      if (session === undefined || session.snapshot.state !== "running") return;
      session.cancelled = true;
      session.abort.abort(new Error("Provider checks were cancelled."));
      for (const result of session.snapshot.results) {
        if (result.state === "pending") replaceResult(session, result.providerId, terminalResult(result, "cancelled", now));
      }
      await session.run?.catch(() => undefined);
    },
    credentialPersisted(providerId) {
      credentialRevisions.set(providerId, (credentialRevisions.get(providerId) ?? 0) + 1);
      const session = current();
      session?.providerAborts.get(providerId)?.abort(new Error("Credential changed during provider check."));
    },
    async stop() {
      stopping = true;
      const preparing = pendingAdmission;
      if (preparing !== undefined) {
        preparing.cancelled = true;
        pendingAdmission = undefined;
        preparing.reject(conflict("Provider authentication is stopping."));
      }
      const active = current();
      if (active !== undefined) {
        active.cancelled = true;
        active.abort.abort(new Error("Provider checks stopped."));
        await active.run?.catch(() => undefined);
      }
      for (const session of sessions.values()) {
        if (session.retention !== undefined) clearTimeout(session.retention);
        if (session.batchTimeout !== undefined) clearTimeout(session.batchTimeout);
      }
      sessions.clear();
      byIdempotencyKey.clear();
    },
  };
}

function inconclusive(): ProviderAuthCheckExecution {
  return { state: "inconclusive", code: "inconclusive", message: "The provider check failed without a safe diagnosis." };
}

function terminalResult(
  result: ProviderAuthCheckResult,
  state: "cancelled" | "not_run",
  now: () => number,
): ProviderAuthCheckResult {
  return {
    ...result,
    state,
    checkedAt: new Date(now()).toISOString(),
    code: state,
    message: state === "cancelled" ? "The provider check was cancelled." : "The provider check did not start before the batch deadline.",
  };
}

function defaultExecutor(options: ProviderAuthStatusOptions) {
  const resolved = resolveConfiguredProviders(options.config);
  const resolver = createPiOAuthApiKeyResolver({ path: resolved.piAuthPath });
  const locals = resolved.entries.filter((provider): provider is LocalProviderDefinition =>
    provider.type !== undefined || provider.id === "ollama" || provider.id === "lmstudio");
  return async (model: RuntimeModelReference, signal: AbortSignal): Promise<ProviderAuthCheckExecution> => {
    const runtimeOptions = runtimeOptionsForLocalProvider(model, locals);
    const configured = locals.find((provider) => provider.id === model.provider);
    const envKey = configured?.apiKeyEnv === undefined ? undefined : options.env[configured.apiKeyEnv];
    const customProvider = runtimeOptions.customProvider === undefined || envKey === undefined
      ? runtimeOptions.customProvider
      : { ...runtimeOptions.customProvider, api_key: envKey };
    return await runPiProviderCheck({
      model,
      resolvePiApiKey: resolver,
      runtimeOptions: {
        ...runtimeOptions,
        ...(customProvider === undefined ? {} : { customProvider }),
      },
      environment: options.env,
      abortSignal: signal,
    });
  };
}
