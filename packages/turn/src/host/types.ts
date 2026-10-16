export type { MonoRuntimeSandboxEngine, RuntimeModelReference, MonoRuntimeBackendCapabilities, MonoRuntimeBackendDescriptor, MonoRuntimeSupportDescription, RuntimeMessage, RuntimeSubagentIdentity, RuntimeSubagentRouteAttribution, RuntimeSubagentActivityPhase, RuntimeEventLike, RuntimeToolLifecycleEvent, RuntimeToolLifecyclePersistence, RuntimeToolLifecycleSink, RuntimeSubagentActivityEvent, RuntimeDispatchProgress, RuntimeResult, RuntimeToolLimits, RuntimeCompactionPolicy, RuntimePromptOverrides, PiTransport, RuntimeSessionTurnDetachedAttempt, RuntimeRunOptions, DurableSessionSalvage, RuntimeNativeDispatchSnapshot, RuntimeNativeDispatchBinding, RuntimeNativePreparedDispatch, MonoRuntimeLike, RuntimeToolOptions, MonoRuntimeParsedPricingModel, MonoRuntimePricing, MonoRuntimeApprovalRequest, MonoRuntimeApprovalDecision, MonoRuntimeCompactionRecord, MonoRuntimeHostOptions } from "./runtime-contracts.js";
export { PI_TRANSPORTS } from "./runtime-contracts.js";
import type { RuntimeSubagentActivityEvent, RuntimeSubagentIdentity, RuntimeSubagentActivityPhase } from "./runtime-contracts.js";
export type { RuntimeToolLifecycleTerminalState } from "#turn/contracts/events";

/** Narrow an open runtime event to the exact normalized subagent contract. */
export function isRuntimeSubagentActivityEvent(value: unknown): value is RuntimeSubagentActivityEvent {
  if (!isUnknownRecord(value) || value.type !== "subagent_activity") {
    return false;
  }
  if (
    typeof value.id !== "string"
    || !isRuntimeSubagentActivityPhase(value.phase)
    || !isRuntimeSubagentIdentity(value.subagent)
  ) {
    return false;
  }
  return optionalString(value, "name")
    && optionalLiteral(value, "kind", ["text", "thinking", "status", "warning", "error"])
    && optionalLiteral(value, "role", ["assistant", "user"])
    && optionalBoolean(value, "isError")
    && optionalNumber(value, "executionMs")
    && optionalNumber(value, "totalTokens");
}

function isRuntimeSubagentIdentity(value: unknown): value is RuntimeSubagentIdentity {
  if (!isUnknownRecord(value)) {
    return false;
  }
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.callIndex === "number"
    && optionalString(value, "nativeId")
    && optionalString(value, "label")
    && optionalString(value, "agentPath")
    && optionalNumber(value, "costUsd")
    // Declared but loosely held: attribution is operator telemetry from
    // present and future producers, so the guard admits any record shape
    // rather than rejecting a payload this console does not know yet.
    && optionalRecord(value, "attribution");
}

function isRuntimeSubagentActivityPhase(value: unknown): value is RuntimeSubagentActivityPhase {
  return value === "agent_started"
    || value === "started"
    || value === "completed"
    || value === "message"
    || value === "agent_completed";
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function optionalNumber(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return !(key in value) || typeof value[key] === "number";
}

function optionalRecord(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const candidate = value[key];
  return candidate === undefined
    || (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate));
}

function optionalBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return !(key in value) || typeof value[key] === "boolean";
}

function optionalLiteral(
  value: Readonly<Record<string, unknown>>,
  key: string,
  choices: readonly string[],
): boolean {
  return !(key in value) || (typeof value[key] === "string" && choices.includes(value[key]));
}
export type { RuntimeLiveInputEvidence } from "#turn/contracts/live-input";

export type { RuntimeLiveInputUncertainty } from "#turn/contracts/live-input";
export type { RuntimeLiveInputMessage } from "#turn/contracts/live-input";
export type { RuntimeMcpAppConnection } from "#turn/contracts/mcp-apps";

export type { RuntimeMcpAppRegistration } from "#turn/contracts/mcp-apps";

export type { RuntimeMcpAppHost } from "#turn/contracts/mcp-apps";

export type { RuntimeSessionTurnDescriptor } from "#turn/contracts/session";

export type { RuntimeSessionTurnReconciliationRequest } from "#turn/contracts/session";


export type { RuntimeSessionTurnReconciliationResult } from "#turn/contracts/session";

export type { RuntimeNativeSessionAuthority } from "#turn/contracts/session";

export type { RuntimeNativeSessionProjection } from "#turn/contracts/session";
export type { RuntimeNativeJournalAuthority, RuntimeNativeJournalDeletion, RuntimeNativeJournalDescriptor, RuntimeNativeJournalRef, RuntimeNativeEpochContext, RuntimeNativeJournalStorage, RuntimeNativeEvidenceView, RuntimeHandoffBudget, RuntimePreparedHandoff, RuntimeHandoffSummary, RuntimeHandoffProducerRequest, RuntimeHandoffFit, RuntimeHandoffProducerResult, RuntimeHandoffOptions, RuntimeNativePreparationStorage } from "#turn/contracts/native-storage";

export type { CreateMonoRuntimeOptions, MonoRuntimeAttemptContext, MonoRuntimeAttemptResolution, MonoRuntimeFallbackChainEntry } from "./runtime-options.js";

export type { ProcessJobProcessHandle, ProcessJobProcessResult, ProcessJobsController, ProcessJobStartRequest, ProcessJobStartResult } from "./process-jobs.js";

export type { PreparedSandboxCommand, SandboxCommandSpec, SandboxEffectiveState, SandboxEngine, SandboxFallback, SandboxMode, SandboxNetworkMode, SandboxPolicy } from "./sandbox-contracts.js";

export type { DiscoveredLocalModel, LocalProviderDefinition, LocalProviderModelDefinition, LocalProviderRuntimeOptions, ModelEffortLevels, ProviderDefinition } from "./provider-contracts.js";

export type { DiscoveredProvider } from "./provider-contracts.js";

export type { OwnedForegroundProcessRequest, OwnedForegroundProcesses } from "./owned-foreground-processes.js";
