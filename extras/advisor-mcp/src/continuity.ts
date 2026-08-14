import type { AdvisorConfig } from "./config.js";
import { continuityIdForSessionKey } from "./protocol.js";

export interface AdvisorContinuityResolver {
  resolve(sessionKey: string): string;
}

export interface AdvisorContinuityMetadata {
  readonly continuityId: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly callCount: number;
}

export interface AdvisorContinuityCacheOptions {
  readonly maxSessions: number;
  readonly ttlMs: number;
  readonly namespace?: string;
  readonly now?: () => number;
}

/**
 * Bounded continuity bookkeeping only. Entries deliberately contain no session
 * key, request material, prompt, model output, token, secret, or runtime handle.
 */
export class AdvisorContinuityCache implements AdvisorContinuityResolver {
  readonly #entries = new Map<string, AdvisorContinuityMetadata>();
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #namespace: string;
  readonly #now: () => number;

  constructor(options: AdvisorContinuityCacheOptions) {
    if (!Number.isInteger(options.maxSessions) || options.maxSessions < 1) {
      throw new TypeError("Advisor continuity maxSessions must be a positive integer.");
    }
    if (!Number.isInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new TypeError("Advisor continuity ttlMs must be a positive integer.");
    }
    this.#maxSessions = options.maxSessions;
    this.#ttlMs = options.ttlMs;
    this.#namespace = options.namespace ?? "default";
    this.#now = options.now ?? Date.now;
  }

  resolve(sessionKey: string): string {
    return this.touch(sessionKey).continuityId;
  }

  touch(sessionKey: string): AdvisorContinuityMetadata {
    const continuityId = continuityIdForSessionKey(sessionKey, this.#namespace);
    const now = this.#readNow();
    this.#prune(now);
    const current = this.#entries.get(continuityId);
    const next: AdvisorContinuityMetadata = current === undefined
      ? { continuityId, createdAt: now, lastUsedAt: now, callCount: 1 }
      : { ...current, lastUsedAt: now, callCount: current.callCount + 1 };
    this.#entries.delete(continuityId);
    this.#entries.set(continuityId, next);
    while (this.#entries.size > this.#maxSessions) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return { ...next };
  }

  get(continuityId: string): AdvisorContinuityMetadata | undefined {
    const now = this.#readNow();
    this.#prune(now);
    const entry = this.#entries.get(continuityId);
    return entry === undefined ? undefined : { ...entry };
  }

  snapshot(): readonly AdvisorContinuityMetadata[] {
    const now = this.#readNow();
    this.#prune(now);
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.#entries.clear();
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#entries) {
      if (now - entry.lastUsedAt >= this.#ttlMs) {
        this.#entries.delete(id);
      }
    }
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new TypeError("Advisor continuity clock must return a finite timestamp.");
    }
    return value;
  }
}

export function createAdvisorContinuityCache(
  config: Pick<AdvisorConfig, "maxSessions" | "sessionTtlMs" | "namespace">,
  now?: () => number,
): AdvisorContinuityCache {
  return new AdvisorContinuityCache({
    maxSessions: config.maxSessions,
    ttlMs: config.sessionTtlMs,
    namespace: config.namespace,
    ...(now === undefined ? {} : { now }),
  });
}
