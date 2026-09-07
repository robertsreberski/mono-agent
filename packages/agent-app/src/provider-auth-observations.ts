import type { ProviderAuthProviderStatus } from "@mono-agent/agent-contracts";
import { MAX_PROVIDER_AUTH_ITEMS } from "@mono-agent/agent-contracts";
import type { RunSummary } from "@mono-agent/observability";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

const FAILURE_TTL_MS = 24 * 60 * 60 * 1_000;

interface ProviderObservation {
  readonly verifiedAt?: string;
  readonly failure?: NonNullable<ProviderAuthProviderStatus["lastFailure"]>;
}

interface InternalProviderObservation extends ProviderObservation {
  /** Internal ordering fence; never projected to the console. */
  readonly latestObservedAt: string;
}

export interface ProviderAuthObservationTracker {
  observe(summary: RunSummary): void;
  get(providerId: string): ProviderObservation | undefined;
  /** Retain observations only for the agent's current bounded used-provider set. */
  retainProviders(providerIds: readonly string[]): void;
  /** Invalidate proof for the replaced credential while retaining only unrelated availability evidence. */
  credentialPersisted(providerId: string): void;
  recordSuccess(providerId: string, model: string, observedAt?: string): void;
  recordFailure(
    providerId: string,
    model: string,
    kind: "provider_auth" | "provider_unavailable",
    observedAt?: string,
  ): void;
  invalidate(providerId: string, observedAt?: string): void;
}

export function createProviderAuthObservationTracker(
  now: () => number = Date.now,
): ProviderAuthObservationTracker {
  const observations = new Map<string, InternalProviderObservation>();
  const providerOf = (model: string | undefined): string | undefined => {
    if (model === undefined) return undefined;
    try {
      return parseMonoRuntimeModelReference(model).provider as string;
    } catch {
      return undefined;
    }
  };
  const isoNow = () => new Date(now()).toISOString();
  const orderedSet = (providerId: string, value: InternalProviderObservation) => {
    const current = observations.get(providerId);
    if (current !== undefined && Date.parse(current.latestObservedAt) > Date.parse(value.latestObservedAt)) return;
    observations.delete(providerId);
    observations.set(providerId, value);
    trimOldest();
  };
  const failureFor = (kind: string | undefined, model: string | undefined, observedAt = isoNow()) => {
    const providerId = providerOf(model);
    if (providerId === undefined || (kind !== "provider_auth" && kind !== "provider_unavailable")) return;
    orderedSet(providerId, {
      latestObservedAt: observedAt,
      failure: {
        kind,
        message: kind === "provider_auth"
          ? "Provider rejected the configured credential."
          : "Provider was unavailable.",
        model: model as string,
        observedAt,
      },
    });
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
      const observedAt = validIso(summary.endedAt) ?? validIso(summary.updatedAt) ?? isoNow();
      for (const attempt of summary.failoverHistory ?? []) {
        failureFor(attempt.failureKind, attempt.model, observedAt);
      }
      if (summary.status === "succeeded") {
        const providerId = providerOf(summary.model);
        if (providerId !== undefined) {
          orderedSet(providerId, { verifiedAt: observedAt, latestObservedAt: observedAt });
        }
      } else {
        failureFor(summary.failureKind, summary.model, observedAt);
      }
    },
    get(providerId) {
      const value = observations.get(providerId);
      if (value?.failure !== undefined
        && now() - Date.parse(value.failure.observedAt) >= FAILURE_TTL_MS) {
        const verifiedAt = value.verifiedAt;
        const replacement: InternalProviderObservation | undefined = verifiedAt === undefined
          ? undefined
          : { verifiedAt, latestObservedAt: value.latestObservedAt };
        if (replacement === undefined) observations.delete(providerId);
        else observations.set(providerId, replacement);
        return verifiedAt === undefined ? undefined : { verifiedAt };
      }
      if (value === undefined || value.verifiedAt === undefined && value.failure === undefined) return undefined;
      return {
        ...(value.verifiedAt === undefined ? {} : { verifiedAt: value.verifiedAt }),
        ...(value.failure === undefined ? {} : { failure: value.failure }),
      };
    },
    retainProviders(providerIds) {
      const retained = new Set(providerIds.slice(0, MAX_PROVIDER_AUTH_ITEMS));
      for (const providerId of observations.keys()) {
        if (!retained.has(providerId)) observations.delete(providerId);
      }
    },
    credentialPersisted(providerId) {
      observations.delete(providerId);
    },
    recordSuccess(providerId, model, observedAt = isoNow()) {
      if (providerOf(model) !== providerId) return;
      orderedSet(providerId, { verifiedAt: observedAt, latestObservedAt: observedAt });
    },
    recordFailure(providerId, model, kind, observedAt = isoNow()) {
      if (providerOf(model) !== providerId) return;
      failureFor(kind, model, observedAt);
    },
    invalidate(providerId, observedAt = isoNow()) {
      orderedSet(providerId, { latestObservedAt: observedAt });
    },
  };
}

function validIso(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : undefined;
}
