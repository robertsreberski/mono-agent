import { persistentSubagentsEnabled } from "../subagent-instances.js";
import type { MonoAgentConfig } from "@mono-agent/config";
import { loadProcessJobsSettings } from "../process-jobs-config.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  failedProcessJobsRootRegistryProtection,
  loadProcessJobsRootRegistryProtection,
} from "../process-jobs-root-registry.js";
import {
  resolveProcessJobsProtectionPosture,
  type ProcessJobsProtectionPosture,
} from "../process-jobs-protection.js";
import type { ValidationSection } from "../doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "./options.js";
import { displayText } from "./format.js";
import { continuationReason } from "../diagnostics/inspection-values.js";
import { inspectProcessJobState } from "../process-jobs/state-inspection.js";

export async function processJobsSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
): Promise<ValidationSection> {
  let settings;
  try {
    settings = await loadProcessJobsSettings({ cwd: input.cwd, configPath: input.configPath, env: input.env });
  } catch (error) {
    return {
      id: "process-jobs",
      label: "Background process jobs",
      status: "error",
      details: [`Process-job configuration is invalid: ${continuationReason(error)}`],
    };
  }
  // Resolve the posture on EVERY path, not just the unsafe opt-in. It decides
  // whether retained roots are in force, and there was previously no way to see
  // it from outside the process at all — which is what let mono-agent#664 run
  // for a day without the operator being able to name the state they were in.
  let unsafeWarning: string | undefined;
  let posture: ProcessJobsProtectionPosture | undefined;
  try {
    let registry = await loadProcessJobsRootRegistryProtection(input.cwd, config.runtime.workspace);
    if (registry.kind !== "failed") {
      try {
        registry = await attestProcessJobsRootRegistrySnapshot(registry, config.runtime.workspace);
      } catch {
        registry = failedProcessJobsRootRegistryProtection(registry.agentRoot);
      }
    }
    posture = resolveProcessJobsProtectionPosture({ settings, registry, coreConfig: config });
    if (settings.unsafeAllowUnprotectedState) {
      if (posture.kind === "unavailable") {
        return {
          id: "process-jobs",
          label: "Background process jobs",
          status: "error",
          details: ["Process-job private-state protection is unavailable."],
        };
      }
      unsafeWarning = posture.warning;
    }
  } catch (error) {
    // Only the unsafe opt-in has rejectable combinations; on the safe path this
    // line is diagnostics and must never turn a healthy config into an error.
    if (settings.unsafeAllowUnprotectedState) {
      return {
        id: "process-jobs",
        label: "Background process jobs",
        status: "error",
        details: [`Process-job configuration is invalid: ${continuationReason(error)}`],
      };
    }
    posture = undefined;
  }
  const protectionDetail = [
    ...(posture === undefined ? [] : [`Private-state protection: ${posture.kind}${posture.retainedRoots ? " (roots retained)" : ""}.`]),
    persistentSubagentsEnabled(config) && settings.enabled && process.platform !== "win32"
      ? "Background subagents: configured for Pi-native, exact-conversation ProcessJobs routes; live availability also requires a healthy controller and remaining lineage."
      : "Background subagents unavailable: persistent Agent/AgentManage and supported, enabled ProcessJobs are required.",
  ];
  if (!settings.enabled) {
    return {
      id: "process-jobs",
      label: "Background process jobs",
      status: unsafeWarning === undefined ? "disabled" : "ok",
      details: [
        "Background Exec/Bash jobs are opt-in (processJobs.enabled=false).",
        ...protectionDetail,
        ...(unsafeWarning === undefined ? [] : [unsafeWarning]),
        ...(process.platform === "win32" ? ["Windows is unsupported; detached POSIX process-group ownership is required."] : []),
      ],
    };
  }
  if (process.platform === "win32") {
    return {
      id: "process-jobs",
      label: "Background process jobs",
      status: "error",
      details: ["Process jobs are enabled but Windows is unsupported; detached POSIX process-group ownership is required."],
    };
  }

  const details = [
    ...(unsafeWarning === undefined ? [] : [unsafeWarning]),
    ...protectionDetail,
    `Owner-only local state: ${settings.stateDir}.`,
    `Running slots: ${String(settings.maxConcurrent)} global, ${String(settings.maxActivePerConversation)} per conversation (nested descendants exempt); ${String(settings.maxQueued)} global waiting slots, including conversation-limited work.`,
    `Caps: runtime=${String(settings.maxRuntimeMs)}ms, queue-age=${String(settings.maxQueueAgeMs)}ms, output=${String(settings.maxOutputBytes)} bytes, chain-depth=${String(settings.maxChainDepth)}.`,
    `Runtime availability: Pi-native Exec/Bash and enabled persistent Agent/AgentManage; configured primary provider is ${displayText(config.runtime.model.provider)}.`,
  ];
  const inspection = await inspectProcessJobState(input.cwd, settings.stateDir);
  return {
    id: "process-jobs",
    label: "Background process jobs",
    status: inspection.status,
    details: [...details, ...inspection.details],
  };
}
