import type { ProviderAuthProviderStatus } from "@mono-agent/agent-contracts";
import { MAX_PROVIDER_AUTH_ITEMS } from "@mono-agent/agent-contracts";
import type { RunSummary } from "@mono-agent/observability";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

const FAILURE_TTL_MS = 24 * 60 * 60 * 1_000;

interface ProviderObservation {
  readonly verifiedAt?: string;
  readonly failure?: NonNullable<ProviderAuthProviderStatus["lastFailure"]>;
}

export interface ProviderAuthObservationTracker {
  observe(summary: RunSummary): void;
  get(providerId: string): ProviderObservation | undefined;
  /** Retain observations only for the agent's current bounded used-provider set. */
  retainProviders(providerIds: readonly string[]): void;
  /** Invalidate proof for the replaced credential while retaining only unrelated availability evidence. */
  credentialPersisted(providerId: string): void;
}

export function createProviderAuthObservationTracker(
  now: () => number = Date.now,
): ProviderAuthObservationTracker {
  const observations = new Map<string, ProviderObservation>();
  const providerOf = (model: string | undefined): string | undefined => {
    if (model === undefined) return undefined;
    try {
      return parseMonoRuntimeModelReference(model).provider as string;
    } catch {
      return undefined;
    }
  };
  const failureFor = (kind: string | undefined, model: string | undefined) => {
    const providerId = providerOf(model);
    if (providerId === undefined || (kind !== "provider_auth" && kind !== "provider_unavailable")) return;
    const observedAt = new Date(now()).toISOString();
    observations.set(providerId, {
      ...observations.get(providerId),
      failure: {
        kind,
        message: kind === "provider_auth"
          ? "Provider rejected the configured credential."
          : "Provider was unavailable.",
        model: model as string,
        observedAt,
      },
    });
    trimOldest();
  };
  const trimOldest = () => {
    while (observations.size > MAX_PROVIDER_AUTH_ITEMS) {
      const oldest = observations.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      observations.delete(oldest);
    }
  };
  return {
    observe(summary) {
      for (const attempt of summary.failoverHistory ?? []) {
        failureFor(attempt.failureKind, attempt.model);
      }
      if (summary.status === "succeeded") {
        const providerId = providerOf(summary.model);
        if (providerId !== undefined) {
          observations.delete(providerId);
          observations.set(providerId, { verifiedAt: new Date(now()).toISOString() });
          trimOldest();
        }
      } else {
        failureFor(summary.failureKind, summary.model);
      }
    },
    get(providerId) {
      const value = observations.get(providerId);
      if (value?.failure !== undefined
        && now() - Date.parse(value.failure.observedAt) >= FAILURE_TTL_MS) {
        const replacement = value.verifiedAt === undefined ? undefined : { verifiedAt: value.verifiedAt };
        if (replacement === undefined) observations.delete(providerId);
        else observations.set(providerId, replacement);
        return replacement;
      }
      return value;
    },
    retainProviders(providerIds) {
      const retained = new Set(providerIds.slice(0, MAX_PROVIDER_AUTH_ITEMS));
      for (const providerId of observations.keys()) {
        if (!retained.has(providerId)) observations.delete(providerId);
      }
    },
    credentialPersisted(providerId) {
      const value = observations.get(providerId);
      if (value?.failure?.kind === "provider_unavailable") {
        observations.set(providerId, { failure: value.failure });
      } else {
        observations.delete(providerId);
      }
    },
  };
}
