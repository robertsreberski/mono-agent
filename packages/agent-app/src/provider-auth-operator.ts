import { randomUUID } from "node:crypto";

import {
  MAX_PROVIDER_AUTH_OPTIONS,
  MAX_PROVIDER_AUTH_INPUT_BYTES,
  MAX_PROVIDER_AUTH_STRING_BYTES,
  MAX_PROVIDER_AUTH_TEXT_INPUT_BYTES,
  PROVIDER_AUTH_SESSION_SCHEMA,
  ProviderAuthOperationError,
  type ProviderAuthOperator,
  type ProviderAuthPrompt,
  type ProviderAuthSessionInput,
  type ProviderAuthSessionSnapshot,
  type ProviderAuthSessionStartInput,
  type ProviderAuthStatusSnapshot,
} from "@mono-agent/agent-contracts";
import { loginPiProviderAuth } from "@mono-agent/agent-runtime/ai";

import { persistPiProviderCredential } from "./provider-setup.js";
import {
  createProviderAuthCheckManager,
  type CreateProviderAuthCheckManagerOptions,
} from "./provider-auth-checks.js";
import type { ProviderAuthObservationTracker } from "./provider-auth-observations.js";
import { providerAuthStatusSnapshot, type ProviderAuthStatusOptions } from "./provider-auth-status.js";

const SESSION_TTL_MS = 20 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 10 * 60 * 1_000;
const AUTH_REPLACEMENT_DRAIN_MS = 2_000;

interface PendingPrompt {
  readonly id: string;
  readonly type: ProviderAuthPrompt["type"];
  readonly allowEmpty: boolean;
  readonly options?: readonly { readonly id: string }[];
  readonly resolve: (value: string) => void;
  readonly reject: (error: unknown) => void;
}

interface LiveSession {
  readonly sequence: number;
  snapshot: ProviderAuthSessionSnapshot;
  readonly abort: AbortController;
  prompt: PendingPrompt | undefined;
  run?: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
}

interface PendingLoginAdmission {
  readonly sequence: number;
  readonly input: ProviderAuthSessionStartInput;
  readonly abort: AbortController;
  readonly promise: Promise<ProviderAuthSessionSnapshot>;
  readonly resolve: (snapshot: ProviderAuthSessionSnapshot) => void;
  readonly reject: (error: unknown) => void;
  task?: Promise<void>;
}

export interface CreateProviderAuthOperatorOptions extends ProviderAuthStatusOptions {
  readonly platform?: NodeJS.Platform;
  readonly login?: typeof loginPiProviderAuth;
  readonly persist?: typeof persistPiProviderCredential;
  readonly now?: () => number;
  readonly checkExecute?: CreateProviderAuthCheckManagerOptions["execute"];
  readonly checkProviderTimeoutMs?: number;
  readonly checkBatchTimeoutMs?: number;
  readonly checkCooldownMs?: number;
  /** Deterministic test seam shared by login and check admission preparation. */
  readonly statusSnapshot?: () => Promise<ProviderAuthStatusSnapshot>;
}

export function createProviderAuthOperator(options: CreateProviderAuthOperatorOptions): ProviderAuthOperator {
  const sessions = new Map<string, LiveSession>();
  const pendingAdmissions = new Map<number, PendingLoginAdmission>();
  const activePersistences = new Set<Promise<void>>();
  const now = options.now ?? Date.now;
  let stopping = false;
  let nextSequence = 0;
  let newestValidSequence = 0;
  let currentSession: LiveSession | undefined;
  const loginActive = () => pendingAdmissions.size > 0
    || activePersistences.size > 0
    || currentSession !== undefined && !isTerminal(currentSession.snapshot.state);
  const statusSnapshot = async () => await (options.statusSnapshot?.() ?? providerAuthStatusSnapshot(options));
  const checks = createProviderAuthCheckManager({
    ...options,
    isLoginActive: loginActive,
    ...(options.checkExecute === undefined ? {} : { execute: options.checkExecute }),
    ...(options.checkProviderTimeoutMs === undefined ? {} : { providerTimeoutMs: options.checkProviderTimeoutMs }),
    ...(options.checkBatchTimeoutMs === undefined ? {} : { batchTimeoutMs: options.checkBatchTimeoutMs }),
    ...(options.checkCooldownMs === undefined ? {} : { cooldownMs: options.checkCooldownMs }),
  });

  const terminal = (session: LiveSession, state: "succeeded" | "failed" | "cancelled", error?: ProviderAuthSessionSnapshot["error"]) => {
    if (isTerminal(session.snapshot.state)) return;
    session.prompt = undefined;
    if (session.timeout !== undefined) clearTimeout(session.timeout);
    session.snapshot = update(session.snapshot, { state, ...(error === undefined ? {} : { error }) }, true);
    session.retention = setTimeout(() => {
      sessions.delete(session.snapshot.id);
      if (currentSession === session) currentSession = undefined;
    }, TERMINAL_RETENTION_MS);
    session.retention.unref?.();
  };

  const isCurrent = (session: LiveSession) => currentSession === session;

  const startRun = (session: LiveSession, priorPersistences: readonly Promise<void>[]) => {
    const input = session.snapshot;
    const login = options.login ?? loginPiProviderAuth;
    const persist = options.persist ?? persistPiProviderCredential;
    session.run = (async () => {
      if (priorPersistences.length > 0) {
        const drain = await waitForPersistenceDrain(
          priorPersistences,
          session.abort.signal,
          AUTH_REPLACEMENT_DRAIN_MS,
        );
        if (drain === "aborted" || !isCurrent(session)) {
          terminal(session, "cancelled");
          return;
        }
        if (drain === "timeout") {
          terminal(session, "failed", {
            code: "replacement_timeout",
            message: "The previous authentication did not stop safely. Retry after it finishes.",
          });
          return;
        }
      }
      if (session.abort.signal.aborted || !isCurrent(session)) {
        terminal(session, "cancelled");
        return;
      }

      const persistence = Promise.resolve().then(async () => await persist({
        authPath: options.config.providers?.piAuthPath ?? "",
        provider: input.providerId,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
        abortSignal: session.abort.signal,
        resolveCredential: async () => await login(input.providerId, input.authType, {
          signal: session.abort.signal,
          prompt: async (prompt) => {
            if (session.abort.signal.aborted || !isCurrent(session)) {
              throw new Error("Provider authentication was cancelled.");
            }
            if (input.providerId === "openai-codex" && prompt.type === "select") {
              const selected = input.strategy === "device_code" ? "device_code" : "browser";
              if (!prompt.options?.some((option) => option.id === selected)) {
                throw new Error("Selected OpenAI login strategy is unavailable.");
              }
              return selected;
            }
            if (!isPromptType(prompt.type)) {
              throw new Error("Provider returned an invalid authentication prompt.");
            }
            if (!nonEmpty(prompt.message)) {
              throw new Error("Provider returned an empty authentication prompt.");
            }
            return await new Promise<string>((resolve, reject) => {
              if (session.abort.signal.aborted || prompt.signal?.aborted === true || !isCurrent(session)) {
                reject(new Error("Provider authentication was cancelled."));
                return;
              }
              const promptId = randomUUID();
              if (prompt.options !== undefined && prompt.options.length > MAX_PROVIDER_AUTH_OPTIONS) {
                reject(new Error("Provider returned too many authentication options."));
                return;
              }
              const projectedOptions = prompt.options?.map((option) => {
                if (!boundedExact(option.id) || !boundedExact(option.label)
                  || option.description !== undefined && !boundedExact(option.description)) {
                  throw new Error("Provider returned an invalid authentication option.");
                }
                return {
                  id: option.id,
                  label: bounded(option.label),
                  ...(option.description === undefined ? {} : { description: bounded(option.description) }),
                };
              });
              const projected: ProviderAuthPrompt = {
                id: promptId,
                type: prompt.type,
                message: bounded(prompt.message),
                ...(nonEmpty(prompt.placeholder) ? { placeholder: bounded(prompt.placeholder) } : {}),
                ...(prompt.type === "text" && prompt.allowEmpty === true ? { allowEmpty: true } : {}),
                ...(projectedOptions === undefined ? {} : { options: projectedOptions }),
              };
              const pending: PendingPrompt = {
                id: promptId,
                type: prompt.type,
                allowEmpty: prompt.type === "text" && prompt.allowEmpty === true,
                ...(projectedOptions === undefined ? {} : { options: projectedOptions }),
                resolve,
                reject,
              };
              session.prompt = pending;
              session.snapshot = update(session.snapshot, { state: "awaiting_input", prompt: projected });
              const cancel = () => {
                if (session.prompt !== pending) return;
                session.prompt = undefined;
                session.snapshot = update(session.snapshot, {}, true);
                reject(new Error("Provider prompt was cancelled."));
              };
              prompt.signal?.addEventListener("abort", cancel, { once: true });
              session.abort.signal.addEventListener("abort", cancel, { once: true });
            });
          },
          notify: (event: unknown) => {
            const deviceTtlMs = applyEvent(session, event, now, () => isCurrent(session));
            if (deviceTtlMs !== undefined && deviceTtlMs < SESSION_TTL_MS) {
              if (session.timeout !== undefined) clearTimeout(session.timeout);
              session.timeout = setTimeout(() => {
                if (!isCurrent(session)) return;
                session.abort.abort(new Error("Provider device code expired."));
                terminal(session, "failed", { code: "timed_out", message: "Provider device code expired." });
              }, deviceTtlMs);
              session.timeout.unref?.();
            }
          },
        }),
      }));
      activePersistences.add(persistence);
      persistence.then(
        () => activePersistences.delete(persistence),
        () => activePersistences.delete(persistence),
      );
      try {
        await raceWithAbort(persistence, session.abort.signal);
        if (session.abort.signal.aborted || !isCurrent(session)) {
          terminal(session, "cancelled");
          return;
        }
        checks.credentialPersisted(input.providerId);
        options.observations.credentialPersisted(input.providerId);
        terminal(session, "succeeded");
      } catch (error) {
        if (session.abort.signal.aborted || !isCurrent(session)) {
          terminal(session, "cancelled");
        } else {
          terminal(session, "failed", safeError(error));
        }
      }
    })().catch(() => {
      if (session.abort.signal.aborted || !isCurrent(session)) {
        terminal(session, "cancelled");
      } else {
        terminal(session, "failed", { code: "provider_auth_failed", message: "Provider authentication failed. Retry or use the mono-agent auth login command on the host." });
      }
    });
  };

  const prepareAdmission = async (admission: PendingLoginAdmission): Promise<void> => {
    try {
      const status = await raceWithAbort(statusSnapshot(), admission.abort.signal);
      if (stopping) {
        throw new ProviderAuthOperationError("provider_auth_conflict", "Provider authentication is stopping.", 409);
      }
      if (checks.isActive()) {
        throw new ProviderAuthOperationError("provider_auth_conflict", "Provider live checks are active. Cancel them before authenticating.", 409);
      }
      const provider = status.providers.find((candidate) => candidate.providerId === admission.input.providerId);
      if (provider === undefined) throw new ProviderAuthOperationError("provider_auth_invalid_request", "Provider is not used by this agent.", 400);
      if (!provider.methods.some((method) => method.authType === admission.input.authType && method.strategy === admission.input.strategy)) {
        throw new ProviderAuthOperationError("provider_auth_conflict", "The selected authentication method is unavailable.", 409);
      }
      if (options.config.providers?.piAuthPath === undefined) {
        throw new ProviderAuthOperationError("provider_auth_unavailable", "The Pi auth store is not configured.", 503);
      }
      if (admission.sequence < newestValidSequence) {
        throw replacedAdmissionError();
      }

      newestValidSequence = admission.sequence;
      for (const candidate of pendingAdmissions.values()) {
        if (candidate.sequence < admission.sequence) candidate.abort.abort(replacedAdmissionError());
      }

      const previous = currentSession;
      if (previous !== undefined && !isTerminal(previous.snapshot.state)) {
        previous.abort.abort(new Error("Provider authentication was replaced."));
        terminal(previous, "cancelled");
      }
      const createdAt = new Date(now()).toISOString();
      const snapshot: ProviderAuthSessionSnapshot = {
        schema: PROVIDER_AUTH_SESSION_SCHEMA,
        id: randomUUID(),
        providerId: admission.input.providerId,
        authType: admission.input.authType,
        strategy: admission.input.strategy,
        state: "pending",
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
      };
      const session: LiveSession = {
        sequence: admission.sequence,
        snapshot,
        abort: admission.abort,
        prompt: undefined,
      };
      sessions.set(snapshot.id, session);
      currentSession = session;
      session.timeout = setTimeout(() => {
        if (!isCurrent(session)) return;
        session.abort.abort(new Error("Provider authentication timed out."));
        terminal(session, "failed", { code: "timed_out", message: "Provider authentication timed out." });
      }, SESSION_TTL_MS);
      session.timeout.unref?.();
      startRun(session, [...activePersistences]);
      await Promise.resolve();
      admission.resolve(session.snapshot);
    } catch (error) {
      admission.reject(error);
    } finally {
      pendingAdmissions.delete(admission.sequence);
    }
  };

  return {
    async status() {
      return await statusSnapshot();
    },
    start(input) {
      if (stopping) return Promise.reject(new ProviderAuthOperationError("provider_auth_conflict", "Provider authentication is stopping.", 409));
      if (checks.isActive()) {
        return Promise.reject(new ProviderAuthOperationError(
          "provider_auth_conflict",
          "Provider live checks are active. Cancel them before authenticating.",
          409,
        ));
      }
      const sequence = ++nextSequence;
      let resolve!: PendingLoginAdmission["resolve"];
      let reject!: PendingLoginAdmission["reject"];
      const promise = new Promise<ProviderAuthSessionSnapshot>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const admission: PendingLoginAdmission = {
        sequence,
        input,
        abort: new AbortController(),
        promise,
        resolve,
        reject,
      };
      pendingAdmissions.set(sequence, admission);
      admission.task = prepareAdmission(admission);
      return promise;
    },
    async get(sessionId) {
      return sessions.get(sessionId)?.snapshot;
    },
    async submit(sessionId, input) {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new ProviderAuthOperationError("provider_auth_not_found", "Provider authentication session was not found.", 404);
      if (isTerminal(session.snapshot.state)) throw new ProviderAuthOperationError("provider_auth_conflict", "Provider authentication session is already complete.", 409);
      const prompt = session.prompt;
      if (prompt === undefined || prompt.id !== input.promptId) {
        throw new ProviderAuthOperationError("provider_auth_conflict", "Provider authentication prompt is stale.", 409);
      }
      const value = normalizeInput(input, prompt);
      session.prompt = undefined;
      session.snapshot = update(session.snapshot, { state: "pending" }, true);
      prompt.resolve(value);
      await Promise.resolve();
      return session.snapshot;
    },
    async cancel(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      if (!isTerminal(session.snapshot.state)) {
        session.abort.abort(new Error("Provider authentication was cancelled."));
        terminal(session, "cancelled");
        await settleWithin(session.run, AUTH_REPLACEMENT_DRAIN_MS);
      }
    },
    checks,
    async stop() {
      stopping = true;
      const stopError = new ProviderAuthOperationError("provider_auth_conflict", "Provider authentication is stopping.", 409);
      const admissionTasks = [...pendingAdmissions.values()].map((admission) => {
        admission.abort.abort(stopError);
        return admission.task;
      });
      await checks.stop();
      const sessionRuns = [...sessions.values()].map(async (session) => {
        if (!isTerminal(session.snapshot.state)) {
          session.abort.abort(new Error("Provider authentication service stopped."));
          terminal(session, "cancelled");
        }
        await session.run?.catch(() => undefined);
        if (session.retention !== undefined) clearTimeout(session.retention);
      });
      await Promise.all([...admissionTasks, ...sessionRuns]);
      while (activePersistences.size > 0) {
        await Promise.allSettled([...activePersistences]);
      }
      sessions.clear();
      pendingAdmissions.clear();
      currentSession = undefined;
    },
  };
}

function replacedAdmissionError(): ProviderAuthOperationError {
  return new ProviderAuthOperationError(
    "provider_auth_conflict",
    "Provider authentication request was replaced by a newer valid request.",
    409,
  );
}

async function raceWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Provider authentication was cancelled.");
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(signal.reason ?? new Error("Provider authentication was cancelled.")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function waitForPersistenceDrain(
  persistences: readonly Promise<void>[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<"drained" | "timeout" | "aborted"> {
  if (signal.aborted) return "aborted";
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref?.();
    const finish = (result: "drained" | "timeout" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => finish("aborted");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void Promise.allSettled(persistences).then(() => finish("drained"));
  });
}

async function settleWithin(pending: Promise<void> | undefined, timeoutMs: number): Promise<void> {
  if (pending === undefined) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    void pending.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); },
    );
  });
}

function applyEvent(
  session: LiveSession,
  event: unknown,
  now: () => number,
  isCurrent: () => boolean,
): number | undefined {
  if (!isCurrent() || !record(event) || typeof event.type !== "string" || isTerminal(session.snapshot.state)) return undefined;
  if (event.type === "auth_url" && !httpUrl(event.url)) {
    throw new Error("Provider returned an invalid authentication URL.");
  }
  if (event.type === "device_code" && (!httpUrl(event.verificationUri) || !nonEmpty(event.userCode))) {
    throw new Error("Provider returned an invalid device-code event.");
  }
  if (event.type === "auth_url" && httpUrl(event.url)) {
    session.snapshot = update(session.snapshot, {
      state: "awaiting_user",
      authUrl: { url: event.url, instructions: instructionsFor(session.snapshot, event.instructions) },
    });
    return undefined;
  } else if (event.type === "device_code" && httpUrl(event.verificationUri) && nonEmpty(event.userCode)) {
    if (event.expiresInSeconds !== undefined
      && (typeof event.expiresInSeconds !== "number" || !Number.isFinite(event.expiresInSeconds) || event.expiresInSeconds <= 0)) {
      throw new Error("Provider returned an invalid device-code expiry.");
    }
    const ttlMs = typeof event.expiresInSeconds === "number"
      ? Math.min(event.expiresInSeconds * 1_000, SESSION_TTL_MS) : undefined;
    const expiresAt = ttlMs === undefined ? undefined : new Date(now() + ttlMs).toISOString();
    session.snapshot = update(session.snapshot, {
      state: "awaiting_user",
      ...(expiresAt === undefined ? {} : { expiresAt }),
      progress: instructionsFor(session.snapshot, undefined),
      deviceCode: {
        verificationUri: event.verificationUri,
        userCode: bounded(event.userCode),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    });
    return ttlMs;
  } else if ((event.type === "progress" || event.type === "info") && nonEmpty(event.message)) {
    session.snapshot = update(session.snapshot, { progress: bounded(event.message) });
  }
  return undefined;
}

function instructionsFor(session: ProviderAuthSessionSnapshot, upstream: unknown): string {
  if (session.providerId === "github-copilot") return "Open this URL in any browser, enter the displayed code, and keep this dialog open while the headless agent completes sign-in.";
  if (session.providerId === "openai-codex" && session.strategy === "device_code") return "Open the OpenAI device page in any browser, enter the code, and keep this dialog open while the headless agent polls.";
  if (session.providerId === "openai-codex") return "Open the URL. If the final localhost page cannot reach the agent host, copy the complete final URL from the browser address bar and paste it here.";
  if (session.providerId === "anthropic") return "Open the URL. If the redirect to localhost:53692 does not load, copy the complete final URL from the address bar and paste it here; the full URL is preferred.";
  return `${typeof upstream === "string" ? bounded(upstream) : "Complete the provider sign-in in this browser."} The agent host is headless; keep this dialog open.`;
}

function update(
  current: ProviderAuthSessionSnapshot,
  changes: Partial<ProviderAuthSessionSnapshot>,
  clearPrompt = false,
): ProviderAuthSessionSnapshot {
  const next = { ...current, ...changes, updatedAt: new Date().toISOString() } as Record<string, unknown>;
  if (clearPrompt) delete next.prompt;
  return next as unknown as ProviderAuthSessionSnapshot;
}

function normalizeInput(input: ProviderAuthSessionInput, prompt: PendingPrompt): string {
  if (prompt.type === "select") {
    if (!prompt.options?.some((option) => option.id === input.value)) {
      throw new ProviderAuthOperationError("provider_auth_invalid_request", "Invalid provider authentication selection.", 400);
    }
    return input.value;
  }
  if (prompt.type === "secret") {
    const value = input.value.trim();
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PROVIDER_AUTH_INPUT_BYTES || /[\r\n\0]/u.test(value)) {
      throw new ProviderAuthOperationError("provider_auth_invalid_request", "Provider authentication secret is invalid.", 400);
    }
    return value;
  }
  if (Buffer.byteLength(input.value, "utf8") > MAX_PROVIDER_AUTH_TEXT_INPUT_BYTES || input.value.includes("\0")) {
    throw new ProviderAuthOperationError("provider_auth_too_large", "Provider authentication input is too large.", 413);
  }
  const value = input.value.trim();
  if (value.length === 0 && !prompt.allowEmpty) {
    throw new ProviderAuthOperationError("provider_auth_invalid_request", "Provider authentication input is required.", 400);
  }
  return value;
}

function safeError(error: unknown): ProviderAuthSessionSnapshot["error"] {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("lock") && (message.includes("active") || message.includes("exists"))) {
    return { code: "auth_store_busy", message: "Another authentication process is using the Pi auth store." };
  }
  if (message.includes("unsafe") || message.includes("refusing") || message.includes("owned")) {
    return { code: "auth_store_unsafe", message: "The Pi auth store did not pass owner-only safety checks." };
  }
  if (message.includes("cleanup")) return { code: "cleanup_failed", message: "Credential cleanup could not be confirmed; inspect the agent host before retrying." };
  if (message.includes("promotion")) return { code: "promotion_failed", message: "Credential promotion failed and the prior Pi auth store was preserved." };
  if (message.includes("changed")) return { code: "auth_store_changed", message: "The Pi auth store changed during authentication and was preserved." };
  if (message.includes("device") && (message.includes("unavailable") || message.includes("not enabled"))) {
    return { code: "device_code_unavailable", message: "Device-code authentication is unavailable; retry with browser paste-back." };
  }
  if (message.includes("eaddrinuse") || message.includes("callback") && (message.includes("listen") || message.includes("bind"))) {
    return { code: "callback_bind_failed", message: "The provider callback listener could not start; use paste-back when available or free the callback port." };
  }
  if (message.includes("exchange")) return { code: "auth_exchange_failed", message: "The provider rejected the authentication exchange." };
  if (message.includes("authorization") && (message.includes("code") || message.includes("state"))) {
    return { code: "invalid_input", message: "The pasted authorization response was invalid or stale." };
  }
  return { code: "provider_auth_failed", message: "Provider authentication failed. Retry or use the mono-agent auth login command on the host." };
}

function bounded(value: string): string {
  const normalized = value.replace(/[\r\n]+/gu, " ");
  if (Buffer.byteLength(normalized, "utf8") <= MAX_PROVIDER_AUTH_STRING_BYTES) return normalized;
  let output = "";
  let bytes = 0;
  for (const character of normalized) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > MAX_PROVIDER_AUTH_STRING_BYTES) break;
    output += character;
    bytes += width;
  }
  return output;
}

function boundedExact(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_AUTH_STRING_BYTES;
}

function isPromptType(value: unknown): value is ProviderAuthPrompt["type"] {
  return value === "text" || value === "secret" || value === "select" || value === "manual_code";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(state: ProviderAuthSessionSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}
