import type { MonoAgentConfig } from "@mono-agent/config";
import {
  describeSandboxEffectiveState,
  resolveSandboxEffectiveState,
  type SandboxEffectiveState,
  type SandboxEngine,
  type SandboxPolicy,
} from "@mono-agent/runtime-adapter";

import { loadProcessJobsSettings } from "./process-jobs-config.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  failedProcessJobsRootRegistryProtection,
  loadProcessJobsRootRegistryProtection,
  processJobsProtectionPolicyRoots,
} from "./process-jobs-root-registry.js";
import { resolveProcessJobsProtectionPosture, type ProcessJobsProtectionPosture } from "./process-jobs-protection.js";
import { processJobsSandboxPolicy } from "./process-jobs-runtime.js";

/** Ordinary policy selection is NOT authority to bypass freshly retained roots. */
export function effectiveSandboxBoundary(input: {
  readonly config: MonoAgentConfig;
  readonly posture: ProcessJobsProtectionPosture;
  readonly protectedRoots: readonly string[];
  readonly startupProtectionRequired?: boolean;
}): {
  readonly policy: SandboxPolicy | undefined;
  readonly requiresEngine: boolean;
  readonly blocked: boolean;
  readonly processJobsRequired: boolean;
  readonly startupProtectionRequired: boolean;
} {
  const blocked = input.posture.kind === "unavailable";
  const processJobsRequired = !input.posture.suppressSyntheticSandbox
    && (input.protectedRoots.length > 0 || input.startupProtectionRequired === true);
  const policy = processJobsRequired
    ? processJobsSandboxPolicy({ coreConfig: input.config, protectedRoots: input.protectedRoots })
    : input.config.sandbox;
  return {
    policy,
    requiresEngine: !input.posture.suppressSyntheticSandbox && policy?.mode === "native",
    blocked,
    processJobsRequired,
    startupProtectionRequired: input.startupProtectionRequired === true,
  };
}

/** Operator inspection only: never bootstrap a store or register a root. */
export async function inspectEffectiveSandboxBoundary(config: MonoAgentConfig, input: {
  readonly cwd: string;
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
}) {
  const settings = await loadProcessJobsSettings(input);
  let registry = await loadProcessJobsRootRegistryProtection(input.cwd, config.runtime.workspace);
  if (registry.kind !== "failed") {
    try {
      registry = await attestProcessJobsRootRegistrySnapshot(registry, config.runtime.workspace);
    } catch {
      registry = failedProcessJobsRootRegistryProtection(registry.agentRoot);
    }
  }
  const posture = resolveProcessJobsProtectionPosture({ settings, registry, coreConfig: config });
  const startupProtectionRequired = settings.enabled && posture.kind === "inactive";
  return effectiveSandboxBoundary({
    config,
    posture,
    protectedRoots: startupProtectionRequired ? [settings.stateDir] : processJobsProtectionPolicyRoots(registry),
    startupProtectionRequired,
  });
}

export async function effectiveSandboxReport(
  config: MonoAgentConfig,
  boundary: ReturnType<typeof effectiveSandboxBoundary>,
  engine?: SandboxEngine,
): Promise<{ readonly state: SandboxEffectiveState; readonly detail: string }> {
  const state: SandboxEffectiveState = boundary.blocked
    ? { configured: true, configuredMode: config.sandbox?.mode, effective: "blocked", engine: "srt",
        engineAvailable: false, fallback: "fail-closed", fallbackActive: false, unsafeAllowHostProcess: false }
    : { ...await resolveSandboxEffectiveState({
        ...(boundary.policy === undefined ? {} : { policy: boundary.policy }),
        ...(boundary.requiresEngine && engine !== undefined ? { engine } : {}),
      }), configuredMode: config.sandbox?.mode };
  const detail = boundary.blocked
    ? "ProcessJobs private-state protection is unavailable; subprocess execution is blocked (no host fallback)."
    : boundary.processJobsRequired
      ? [
          `Configured sandbox: ${config.sandbox?.mode ?? "omitted"}; effective boundary: ProcessJobs requires native SRT protection.`,
          ...(boundary.startupProtectionRequired ? ["ProcessJobs startup will require protection; state has not been initialized by this inspection."] : []),
          describeSandboxEffectiveState(state),
          `Readable roots: ${roots(boundary.policy?.readableRoots)}; writable roots: ${roots(boundary.policy?.writableRoots)}.`,
          "ProcessJobs private roots are explicitly denied; command runtime dependencies may add readable roots.",
          `Network: ${boundary.policy?.network.mode ?? "all"}; fallback: fail-closed (no host fallback).`,
        ].join(" ")
      : state.effective === "off"
        ? "Sandbox is off; subprocesses run unwrapped on the host. Private agent state (including clear-sessions control and coordination leases) is reachable by same-UID subprocesses."
        : state.effective === "unsafe-host-process"
          ? `${describeSandboxEffectiveState(state)} Private agent state (including clear-sessions control and coordination leases) is reachable by same-UID subprocesses.`
          : describeSandboxEffectiveState(state);
  return { state, detail };
}

function roots(paths: readonly string[] | undefined): string {
  return (paths ?? []).slice(0, 32).map((path) => JSON.stringify(path.slice(0, 512))).join(", ") || "none";
}
