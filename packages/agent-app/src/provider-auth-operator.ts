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
} from "@mono-agent/agent-contracts";
import { loginPiProviderAuth } from "@mono-agent/agent-runtime/ai";

import { persistPiProviderCredential } from "./provider-setup.js";
import type { ProviderAuthObservationTracker } from "./provider-auth-observations.js";
import { providerAuthStatusSnapshot, type ProviderAuthStatusOptions } from "./provider-auth-status.js";

const SESSION_TTL_MS = 20 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 10 * 60 * 1_000;

interface PendingPrompt {
  readonly id: string;
  readonly type: ProviderAuthPrompt["type"];
  readonly allowEmpty: boolean;
  readonly options?: readonly { readonly id: string }[];
  readonly resolve: (value: string) => void;
  readonly reject: (error: unknown) => void;
}

interface LiveSession {
  snapshot: ProviderAuthSessionSnapshot;
  readonly abort: AbortController;
  prompt: PendingPrompt | undefined;
  run?: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
}

export interface CreateProviderAuthOperatorOptions extends ProviderAuthStatusOptions {
  readonly platform?: NodeJS.Platform;
  readonly login?: typeof loginPiProviderAuth;
  readonly persist?: typeof persistPiProviderCredential;
  readonly now?: () => number;
}

export function createProviderAuthOperator(options: CreateProviderAuthOperatorOptions): ProviderAuthOperator {
  const sessions = new Map<string, LiveSession>();
  const now = options.now ?? Date.now;
  let stopping = false;

  const terminal = (session: LiveSession, state: "succeeded" | "failed" | "cancelled", error?: ProviderAuthSessionSnapshot["error"]) => {
    if (isTerminal(session.snapshot.state)) return;
    session.prompt = undefined;
    if (session.timeout !== undefined) clearTimeout(session.timeout);
    session.snapshot = update(session.snapshot, { state, ...(error === undefined ? {} : { error }) }, true);
    session.retention = setTimeout(() => sessions.delete(session.snapshot.id), TERMINAL_RETENTION_MS);
    session.retention.unref?.();
  };

  const startRun = (session: LiveSession) => {
    const input = session.snapshot;
    const login = options.login ?? loginPiProviderAuth;
    const persist = options.persist ?? persistPiProviderCredential;
    session.run = persist({
      authPath: options.config.providers?.piAuthPath ?? "",
      provider: input.providerId,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      abortSignal: session.abort.signal,
      resolveCredential: async () => await login(input.providerId, input.authType, {
        signal: session.abort.signal,
        prompt: async (prompt) => {
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
            if (session.abort.signal.aborted || prompt.signal?.aborted === true) {
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
          const deviceTtlMs = applyEvent(session, event, now);
          if (deviceTtlMs !== undefined && deviceTtlMs < SESSION_TTL_MS) {
            if (session.timeout !== undefined) clearTimeout(session.timeout);
            session.timeout = setTimeout(() => {
              session.abort.abort(new Error("Provider device code expired."));
              terminal(session, "failed", { code: "timed_out", message: "Provider device code expired." });
            }, deviceTtlMs);
            session.timeout.unref?.();
          }
        },
      }),
    }).then(() => {
      options.observations.clearAuthFailure(input.providerId);
      terminal(session, "succeeded");
    }).catch((error: unknown) => {
      if (session.abort.signal.aborted) {
        terminal(session, "cancelled");
      } else {
        terminal(session, "failed", safeError(error));
      }
    });
  };

  return {
    async status() {
      return await providerAuthStatusSnapshot(options);
    },
    async start(input) {
      if (stopping) throw new ProviderAuthOperationError("provider_auth_conflict", "Provider authentication is stopping.", 409);
      const status = await providerAuthStatusSnapshot(options);
      const provider = status.providers.find((candidate) => candidate.providerId === input.providerId);
      if (provider === undefined) throw new ProviderAuthOperationError("provider_auth_invalid_request", "Provider is not used by this agent.", 400);
      if (!provider.methods.some((method) => method.authType === input.authType && method.strategy === input.strategy)) {
        throw new ProviderAuthOperationError("provider_auth_conflict", "The selected authentication method is unavailable.", 409);
      }
      if (options.config.providers?.piAuthPath === undefined) {
        throw new ProviderAuthOperationError("provider_auth_unavailable", "The Pi auth store is not configured.", 503);
      }
      if ([...sessions.values()].some((candidate) => !isTerminal(candidate.snapshot.state))) {
        throw new ProviderAuthOperationError("provider_auth_conflict", "Another provider authentication is already active.", 409);
      }
      const createdAt = new Date(now()).toISOString();
      const expiresAt = new Date(now() + SESSION_TTL_MS).toISOString();
      const snapshot: ProviderAuthSessionSnapshot = {
        schema: PROVIDER_AUTH_SESSION_SCHEMA,
        id: randomUUID(),
        providerId: input.providerId,
        authType: input.authType,
        strategy: input.strategy,
        state: "pending",
        createdAt,
        updatedAt: createdAt,
        expiresAt,
      };
      const session: LiveSession = { snapshot, abort: new AbortController(), prompt: undefined };
      sessions.set(snapshot.id, session);
      session.timeout = setTimeout(() => {
        session.abort.abort(new Error("Provider authentication timed out."));
        terminal(session, "failed", { code: "timed_out", message: "Provider authentication timed out." });
      }, SESSION_TTL_MS);
      session.timeout.unref?.();
      startRun(session);
      await Promise.resolve();
      return session.snapshot;
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
        await session.run?.catch(() => undefined);
      }
    },
    async stop() {
      stopping = true;
      await Promise.all([...sessions.values()].map(async (session) => {
        if (!isTerminal(session.snapshot.state)) {
          session.abort.abort(new Error("Provider authentication service stopped."));
          terminal(session, "cancelled");
          await session.run?.catch(() => undefined);
        }
        if (session.retention !== undefined) clearTimeout(session.retention);
      }));
      sessions.clear();
    },
  };
}

function applyEvent(session: LiveSession, event: unknown, now: () => number): number | undefined {
  if (!record(event) || typeof event.type !== "string" || isTerminal(session.snapshot.state)) return undefined;
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
