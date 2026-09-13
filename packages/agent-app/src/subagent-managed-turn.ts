import type { SubagentVerificationTarget } from "./subagent-verification-observer.js";
import type { OwnedForegroundProcesses } from "@mono-agent/runtime-adapter";
import type { InstanceOutcome } from "./subagent-instances.js";
import type { SubagentContinuity, SubagentFailureReason, SubagentOwnerIdentity } from "./subagent-registry-ownership.js";

/** Only bounded host outcome categories; answer prose is not recovery evidence. */
export interface SubagentDisposition {
  status: "ok" | "awaiting_reply" | "failed" | "timeout" | "cancelled" | "empty" | "interrupted" | "busy";
  continuity: SubagentContinuity;
  reason?: SubagentFailureReason;
  closeAfterSuccess?: boolean;
}
export interface ManagedSubagentAdmission {
  readonly instanceIncarnation: string;
  readonly turnToken: string;
}
export interface ManagedSubagentExecution {
  readonly ownedForegroundProcesses: OwnedForegroundProcesses;
  started(): Promise<void>;
  /** Attached to the actual provider promise BEFORE the reporting race. */
  settled(outcome?: InstanceOutcome): Promise<void>;
  report(outcome: InstanceOutcome): Promise<void>;
}
export interface SubagentRegistryPublication {
  readonly identity: SubagentOwnerIdentity;
  readonly sequence: number;
  readonly disposition: SubagentDisposition;
  readonly released: boolean;
  readonly outcome?: InstanceOutcome;
}
export interface ManagedSubagentRegistry {
  readonly root: string;
  verify(identity: SubagentOwnerIdentity): Promise<void | { readonly retained: boolean; readonly verification?: SubagentVerificationTarget }>;
  publish(phase: "intent" | "confirm" | "finalize" | "acknowledge", publication: SubagentRegistryPublication): Promise<void>;
}
