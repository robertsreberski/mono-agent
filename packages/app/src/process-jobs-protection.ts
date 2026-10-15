import { MonoAgentConfigError, type MonoAgentConfig } from "@mono-agent/config";

import type { ProcessJobsSettings } from "./process-jobs-config.js";
import type { ProcessJobsRootRegistrySnapshot } from "./process-jobs-root-registry.js";
import { configuredProcessJobsRoutesOnlyPiNative } from "./runtime-routes.js";

export const PROCESS_JOBS_UNSAFE_HOST_WARNING =
  "UNSAFE: ProcessJobs state and operator secret are model-accessible.";

export type ProcessJobsProtectionKind =
  | "inactive"
  | "srt-protected"
  | "unsafe-unprotected"
  | "unavailable";

/** App-private authority; deliberately absent from every package-root factory. */
export interface ProcessJobsProtectionPosture {
  readonly kind: ProcessJobsProtectionKind;
  readonly retainedRoots: boolean;
  readonly requiresPiNative: boolean;
  readonly suppressSyntheticSandbox: boolean;
  readonly unsafeAllowUnprotectedState: boolean;
  readonly warning?: string;
}

export interface ProcessJobsProtectionStatus {
  readonly protection: ProcessJobsProtectionKind;
  readonly retainedRoots: boolean;
  readonly unsafeAllowUnprotectedState: boolean;
  readonly warning?: string;
}

/**
 * Resolve one posture after the registry snapshot has been strictly loaded and
 * attested by its owner. Registry failure wins over every unsafe opt-in check.
 */
export function resolveProcessJobsProtectionPosture(input: {
  readonly settings: Pick<ProcessJobsSettings, "enabled" | "unsafeAllowUnprotectedState">;
  readonly registry: ProcessJobsRootRegistrySnapshot;
  readonly coreConfig: MonoAgentConfig;
}): ProcessJobsProtectionPosture {
  const retainedRoots = input.registry.kind === "ready";
  if (input.registry.kind === "failed") {
    return {
      kind: "unavailable",
      retainedRoots: false,
      requiresPiNative: true,
      suppressSyntheticSandbox: false,
      unsafeAllowUnprotectedState: false,
    };
  }
  if (!input.settings.unsafeAllowUnprotectedState) {
    return retainedRoots
      ? {
          kind: "srt-protected",
          retainedRoots: true,
          requiresPiNative: true,
          suppressSyntheticSandbox: false,
          unsafeAllowUnprotectedState: false,
        }
      : {
          kind: "inactive",
          retainedRoots: false,
          requiresPiNative: false,
          suppressSyntheticSandbox: false,
          unsafeAllowUnprotectedState: false,
        };
  }

  if (!input.settings.enabled && !retainedRoots) {
    throw unsafePostureConfigError(
      "processJobs.unsafeAllowUnprotectedState requires processJobs.enabled=true or retained ProcessJobs roots.",
    );
  }
  if (input.coreConfig.sandbox?.mode !== "off") {
    throw unsafePostureConfigError(
      "processJobs.unsafeAllowUnprotectedState requires an explicit sandbox.mode of off.",
    );
  }
  if (!configuredProcessJobsRoutesOnlyPiNative(input.coreConfig)) {
    throw unsafePostureConfigError(
      "processJobs.unsafeAllowUnprotectedState requires every configured primary, fallback, Agent child, and agent-host memory route to resolve without duplicate fallbacks.",
    );
  }
  return {
    kind: "unsafe-unprotected",
    retainedRoots,
    requiresPiNative: true,
    suppressSyntheticSandbox: true,
    unsafeAllowUnprotectedState: true,
    warning: PROCESS_JOBS_UNSAFE_HOST_WARNING,
  };
}

export function processJobsProtectionStatus(
  posture: ProcessJobsProtectionPosture,
): ProcessJobsProtectionStatus {
  return {
    protection: posture.kind,
    retainedRoots: posture.retainedRoots,
    unsafeAllowUnprotectedState: posture.unsafeAllowUnprotectedState,
    ...(posture.warning === undefined ? {} : { warning: posture.warning }),
  };
}

/** Preserve safe-default operator output byte-for-byte; project only the opt-in warning. */
export function unsafeProcessJobsProtectionStatus(
  posture: ProcessJobsProtectionPosture | undefined,
): ProcessJobsProtectionStatus | undefined {
  return posture?.kind === "unsafe-unprotected"
    ? processJobsProtectionStatus(posture)
    : undefined;
}

function unsafePostureConfigError(message: string): MonoAgentConfigError {
  return new MonoAgentConfigError("invalid_json", message, {
    path: "processJobs.unsafeAllowUnprotectedState",
    reason: message,
  });
}
